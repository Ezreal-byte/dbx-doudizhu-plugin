import assert from 'node:assert/strict';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

// Run: node scripts/character-acceptance.mjs
// Starts and closes an isolated Vite server. No DBX bridge, backend, or room is
// opened. DBX_CHROME may select a Chrome executable; otherwise Windows Chrome
// or the installed Playwright Chromium is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test-results', 'character-acceptance');
const chrome = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const motions = ['idle', 'thinking', 'bid', 'double', 'play', 'pass', 'win', 'lose', 'tea', 'flower', 'egg', 'tomato', 'like', 'send', 'spring'];
const errors = [];
const externalRequests = [];
let server, browser;
mkdirSync(outDir, {recursive: true});

try {
  if (process.env.DBX_CHROME) assert.ok(existsSync(chrome), `Chrome does not exist: ${chrome}`);
  server = await createServer({
    root, configFile: path.join(root, 'vite.config.ts'),
    cacheDir: path.join(root, '.cache', 'character-acceptance-vite'),
    server: {host: '127.0.0.1', port: 0, strictPort: false, open: false},
    clearScreen: false, logLevel: 'error',
  });
  await server.listen();
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless: true, ...(existsSync(chrome) ? {executablePath: chrome} : {})});
  const page = await browser.newPage({viewport: {width: 1800, height: 480}, deviceScaleFactor: 1});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === `${baseURL}/__character_acceptance__`) return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body></body></html>',
    });
    if (url.startsWith(`${baseURL}/`) || /^(blob:|data:)/.test(url)) return route.continue();
    externalRequests.push(url);
    return route.abort('blockedbyclient');
  });
  await page.goto(`${baseURL}/__character_acceptance__`);
  const renderer = await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#e4e2d0';
    // Use the same optimized Pixi module URL as the production character module
    // to avoid registering two copies of Pixi's extension handlers.
    const source = await (await fetch('/src/game/characters.ts')).text();
    const pixiPath = source.match(/from ["']([^"']*pixi__js[^"']*)["']/)?.[1];
    if (!pixiPath) throw new Error('Cannot locate the production Pixi import in Vite output');
    const {Application, Text} = await import(pixiPath);
    const {Character, loadCharacterParts} = await import('/src/game/characters.ts');
    const app = new Application();
    await app.init({preference: ['webgl'], width: 1800, height: 480, backgroundAlpha: 0, antialias: true, preserveDrawingBuffer: true});
    document.body.appendChild(app.canvas);
    app.ticker.stop();
    const characters = (await loadCharacterParts()).map((parts, index) => {
      const character = new Character(parts, `preview-${index}`, () => {});
      character.root.x = 180 + index * 360;
      character.baseline = 440;
      app.stage.addChild(character.root);
      const name = new Text({text: ['阿禾', '小满', '福伯', '青竹', '长安'][index], style: {fill: 0x284e3c, fontSize: 24, fontFamily: 'Microsoft YaHei, sans-serif'}});
      name.anchor.set(.5); name.position.set(character.root.x, 462);
      app.stage.addChild(name);
      return character;
    });
    // This object only exists in this isolated test document, never in App.vue.
    window.characterAcceptance = {app, characters};
    const gl = app.renderer.gl;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {webgl2: gl instanceof WebGL2RenderingContext, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)};
  });

  for (const motion of motions) {
    await page.evaluate(motion => {
      const {app, characters} = window.characterAcceptance;
      characters.forEach(character => { character.act(motion, 100000); character.tick(101000, false, motion === 'thinking'); });
      app.render();
    }, motion);
    await page.screenshot({path: path.join(outDir, `${motion}.png`)});
  }
  await page.evaluate(() => {
    const {app, characters} = window.characterAcceptance;
    characters.forEach(character => { character.act('win', 100000); character.tick(101000, true, false); });
    app.render();
  });
  await page.screenshot({path: path.join(outDir, 'win-low-motion.png')});

  const continuity = await page.evaluate(motions => {
    const {app, characters} = window.characterAcceptance;
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 480;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    const anomalies = [], clipping = [];
    let largestSatellite = 0, poses = 0;
    function components(pixels, width, height) {
      const used = new Uint8Array(width * height), queue = new Uint32Array(width * height), sizes = [];
      for (let index = 0; index < width * height; index++) {
        if (used[index] || pixels[index * 4 + 3] < 120) continue;
        let size = 0, tail = 1, head = 0;
        queue[0] = index; used[index] = 1;
        while (head < tail) {
          const at = queue[head++], x = at % width, y = Math.floor(at / width);
          size++;
          for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1]) {
            if (next >= 0 && !used[next] && pixels[next * 4 + 3] >= 120) { used[next] = 1; queue[tail++] = next; }
          }
        }
        if (size > 4) sizes.push(size);
      }
      return sizes.sort((left, right) => right - left);
    }
    for (const low of [false, true]) for (const motion of motions) for (const elapsed of [0, 250, 500, 900, 1300, 1700, 2300, 2990]) {
      characters.forEach(character => { character.act(motion, 100000); character.tick(100000 + elapsed, low, motion === 'thinking'); });
      app.render();
      context.clearRect(0, 0, 1800, 480); context.drawImage(app.canvas, 0, 0);
      characters.forEach((character, index) => {
        const bounds = character.root.getBounds();
        if (bounds.minX < index * 360 || bounds.maxX > (index + 1) * 360 || bounds.minY < 20 || bounds.maxY > 450) clipping.push({index, motion, elapsed, low});
        const sizes = components(context.getImageData(index * 360, 20, 360, 430).data, 360, 430);
        largestSatellite = Math.max(largestSatellite, sizes[1] ?? 0);
        if ((sizes[1] ?? 0) > 120) anomalies.push({index, motion, elapsed, low, components: sizes.slice(0, 5)});
        if (character.lids.parent !== character.headJoint) throw new Error('Eyelids must follow the head joint');
      });
      poses++;
    }
    return {
      poses, characters: characters.length, renderedCharacterPoses: poses * characters.length,
      alphaThreshold: 120, largestSatellite, anomalies, clipping,
      bindings: characters.map((character, index) => ({index, screenLeftAtlasRow: character.rig.screenLeftArmRow, screenRightAtlasRow: character.rig.screenLeftArmRow === 2 ? 3 : 2})),
    };
  }, motions);
  assert.deepEqual(errors, [], 'No browser errors');
  assert.deepEqual(externalRequests, [], 'All assets must be local');
  assert.deepEqual(continuity.anomalies, [], 'No detached hand, arm, or head silhouette');
  assert.deepEqual(continuity.clipping, [], 'All character parts remain inside the inspected region');
  const report = {
    at: new Date().toISOString(), status: 'passed', renderer, motions, errors, externalRequests, ...continuity,
    note: 'The numeric check only detects detached parts and clipping. It does not prove anatomical handedness. Review idle.png, win.png, thinking.png and tea.png: with the backs of the hands facing the viewer at rest, thumbs must face the body. The production binding was separately visually reviewed for all five characters.',
    environment: 'Isolated real Pixi rendering of production character code and assets; no backend, DBX bridge, or real room is opened.',
  };
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Passed ${continuity.renderedCharacterPoses} character poses. Review images and report: ${outDir}`);
} catch (error) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({at: new Date().toISOString(), status: 'failed', error: error.stack ?? String(error), errors, externalRequests}, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
