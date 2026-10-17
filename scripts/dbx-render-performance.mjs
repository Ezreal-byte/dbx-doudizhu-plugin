import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DBX_HOST_URL ?? 'http://127.0.0.1:5190';
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const installedBinary = path.join(root, 'backend', 'bin', process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const outDir = path.join(root, 'test-results', 'dbx-host');
const peers = [];
const errors = [];
const warnings = [];
const resourceFailures = [];
let context;
let page;
let frame;
let roomId;
let profileDir;
let originalProfile;

mkdirSync(outDir, { recursive: true });

function copyBinaryToTemp() {
  assert.ok(existsSync(installedBinary), `Go sidecar binary not found: ${installedBinary}`);
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-render-perf-binary-'));
  const binary = path.join(dir, path.basename(installedBinary));
  copyFileSync(installedBinary, binary);
  return { dir, binary };
}

function startPeer(name, binary) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `dbx-render-perf-${name}-`));
  const child = spawn(binary, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const rpcLog = [];
  let sequence = 0;
  const peer = {
    name, child, dataDir, rpcLog,
    call(method, params = {}) {
      const id = ++sequence;
      rpcLog.push({ method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}: ${method} timed out`)); }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) { if (message.method) peer.onEvent?.(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else request.resolve(message.result);
  });
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', code => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${name} sidecar exited (${code})`));
    }
    pending.clear();
  });
  peers.push(peer);
  return peer;
}

function localAsset(requested) {
  const clean = String(requested).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error('invalid asset path');
  const uiRoot = path.resolve(root, 'ui');
  const resolved = path.resolve(uiRoot, clean);
  if (!resolved.startsWith(`${uiRoot}${path.sep}`)) throw new Error('asset escaped ui directory');
  const bytes = readFileSync(resolved);
  const extension = path.extname(resolved).toLowerCase();
  const type = { '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[extension] ?? 'application/octet-stream';
  return { contentType: type, dataBase64: bytes.toString('base64') };
}

async function setupPeer(peer, nickname, character) {
  const init = await peer.call('plugin/initialize', { host: { protocolVersions: [1] } });
  assert.equal(init.plugin.id, 'io.dbx.doudizhu');
  await peer.call('profile.save', { nickname, character, music: 0, sound: 0, voice: 0, lowMotion: false });
}

async function chromiumMemory() {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows working-set query is unavailable on this platform.' };
  const profileNeedle = profileDir.replaceAll("'", "''");
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${profileNeedle}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ pid = $p.Id; workingSetBytes = $p.WorkingSet64; type = if ($_.CommandLine -match '--type=([^ ]+)') { $matches[1] } else { 'browser' } } } } | ConvertTo-Json -Compress`;
  try {
    const text = execFileSync(process.env.CODEX_PWSH_PATH ?? 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 7_000 }).trim();
    if (!text) return { available: true, processes: [], totalWorkingSetBytes: 0 };
    const processes = (Array.isArray(JSON.parse(text)) ? JSON.parse(text) : [JSON.parse(text)]);
    return { available: true, processes, totalWorkingSetBytes: processes.reduce((sum, item) => sum + Number(item.workingSetBytes || 0), 0) };
  } catch (error) { return { available: false, reason: error.message }; }
}

async function sampleScenario(name, lowMotion) {
  if (lowMotion) {
    await frame.getByRole('button', { name: '牌桌设置' }).click();
    const settings = frame.getByRole('dialog');
    await settings.getByRole('switch').setChecked(true);
    await settings.getByRole('button', { name: '就这样，保存偏好' }).click();
    await frame.locator('.app-shell.low-motion').waitFor({ timeout: 10_000 });
  } else {
    await frame.locator('.app-shell:not(.low-motion)').waitFor({ timeout: 10_000 });
  }
  await new Promise(resolve => setTimeout(resolve, 1500)); // settle after mode change
  const screenshotPath = path.join(outDir, `performance-${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  const memoryBefore = await chromiumMemory();
  const inPage = await frame.locator('body').evaluate(async () => {
    const canvas = document.querySelector('.pixi-stage canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl ? {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    } : null;
    const root = document.querySelector('#app');
    const app = root?.__vue_app__;
    const instance = app?._instance ?? root?.__vueParentComponent;
    const setupState = instance?.setupState;
    const candidate = setupState?.table;
    const scene = candidate?.value ?? candidate;
    const statsAvailable = typeof scene?.stats === 'function';
    await new Promise(resolve => setTimeout(resolve, 1000));
    const metrics = window.__dbxRenderMetrics;
    const clearsBefore = metrics?.screenFramebufferColorClearCount ?? null;
    const rafSamples = [];
    let rafCount = 0;
    let recording = true;
    const tick = () => { if (recording) { rafCount += 1; requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
    const started = performance.now();
    while (performance.now() - started < 5000) {
      const elapsedMs = Math.round(performance.now() - started);
      let pixiFPS = null;
      try { if (statsAvailable) pixiFPS = scene.stats()?.fps ?? null; } catch {}
      const heap = performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      } : null;
      rafSamples.push({ elapsedMs, pixiFPS, heap });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    recording = false;
    const ended = performance.now();
    const clearsAfter = metrics?.screenFramebufferColorClearCount ?? null;
    const clearDelta = clearsBefore === null || clearsAfter === null ? null : clearsAfter - clearsBefore;
    return {
      durationMs: Math.round(ended - started),
      rafCount,
      rafHz: rafCount * 1000 / (ended - started),
      renderer,
      pixiStatsAvailable: statsAvailable,
      vueSetupStateKeys: Object.keys(setupState ?? {}),
      pixiFPS: rafSamples.map(sample => sample.pixiFPS).filter(value => Number.isFinite(value)),
      heapSamples: rafSamples.map(sample => sample.heap).filter(Boolean),
      screenFramebufferClearProbe: {
        installed: Boolean(metrics),
        wrappedContexts: metrics?.installedOn ?? [],
        clearsBefore,
        clearsAfter,
        clearDelta,
        durationMs: Math.round(ended - started),
        screenFramebufferClearsPerSecond: clearDelta === null ? null : clearDelta * 1000 / (ended - started),
      },
    };
  });
  const memoryAfter = await chromiumMemory();
  const stats = inPage.pixiFPS;
  const heap = inPage.heapSamples;
  const result = {
    mode: name,
    lowMotion,
    screenshot: screenshotPath,
    renderer: inPage.renderer,
    screenFramebufferClearsPerSecond: inPage.screenFramebufferClearProbe.screenFramebufferClearsPerSecond,
    renderFPSProxy: inPage.screenFramebufferClearProbe.screenFramebufferClearsPerSecond,
    renderFPSProxyDefinition: 'Default framebuffer color-clear calls per second. This is a render cadence proxy, not a compositor presentation counter; it does not prove every cleared frame was presented.',
    screenFramebufferClearProbe: inPage.screenFramebufferClearProbe,
    pixiTickerFPS: stats.length ? {
      min: Math.min(...stats), max: Math.max(...stats), mean: stats.reduce((a, b) => a + b, 0) / stats.length,
      samples: stats.length,
    } : null,
    raf: { count: inPage.rafCount, hz: inPage.rafHz, durationMs: inPage.durationMs, explicitlyNotRendererFPS: true },
    jsHeapBytes: heap.length ? {
      start: heap[0].usedJSHeapSize,
      end: heap.at(-1).usedJSHeapSize,
      peak: Math.max(...heap.map(sample => sample.usedJSHeapSize)),
      samples: heap.length,
    } : null,
    chromiumWorkingSet: { before: memoryBefore, after: memoryAfter },
    pixiStatsReadability: inPage.pixiStatsAvailable
      ? 'Read via Vue app instance setupState.table.stats() without mutating application state.'
      : `Pixi table.stats() was not exposed through the Vue instance. rAF is only browser callback rate, not renderer FPS. setupState keys: ${inPage.vueSetupStateKeys.join(', ') || '(none)'}`,
  };
  console.log(`${name}: renderer=${JSON.stringify(result.renderer)} screenClearRate=${result.screenFramebufferClearsPerSecond} PixiFPS=${JSON.stringify(result.pixiTickerFPS)} rAF=${result.raf.hz.toFixed(1)} heap=${JSON.stringify(result.jsHeapBytes)}`);
  return result;
}

async function run(binary) {
  assert.ok(existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  const guestB = startPeer('guest-b', binary);
  const guestC = startPeer('guest-c', binary);
  await setupPeer(guestB, '青竹', 3);
  await setupPeer(guestC, '长安', 4);

  profileDir = mkdtempSync(path.join(tmpdir(), 'dbx-render-performance-chrome-'));
  // Native/default Chrome GPU selection: do not pass --use-angle=swiftshader or --disable-gpu.
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    args: ['--disable-background-timer-throttling'],
  });
  await context.addInitScript(() => {
    const metrics = { screenFramebufferColorClearCount: 0, installedOn: [] };
    Object.defineProperty(window, '__dbxRenderMetrics', { value: metrics, configurable: false, enumerable: false });
    const wrapClear = (constructorName, prototype) => {
      if (!prototype || typeof prototype.clear !== 'function' || prototype.clear.__dbxRenderMetricWrapped) return;
      const original = prototype.clear;
      function countedClear(mask) {
        let targetsScreenColor = false;
        try {
          targetsScreenColor = this.getParameter(this.FRAMEBUFFER_BINDING) === null && (Number(mask) & this.COLOR_BUFFER_BIT) !== 0;
        } catch {}
        const result = original.apply(this, arguments);
        if (targetsScreenColor) metrics.screenFramebufferColorClearCount += 1;
        return result;
      }
      Object.defineProperty(countedClear, '__dbxRenderMetricWrapped', { value: true });
      prototype.clear = countedClear;
      metrics.installedOn.push(constructorName);
    };
    wrapClear('WebGLRenderingContext', globalThis.WebGLRenderingContext?.prototype);
    wrapClear('WebGL2RenderingContext', globalThis.WebGL2RenderingContext?.prototype);
  });
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(15_000);
  const faviconURL = new URL('/favicon.ico', baseURL).href;
  page.on('pageerror', error => errors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const url = message.location().url ?? '';
    if (message.text().includes('Failed to load resource') && url === faviconURL) warnings.push({ kind: 'host-favicon-404', url, message: message.text() });
    else errors.push({ kind: 'console', message: message.text(), url });
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = response.url();
    if (url === faviconURL) warnings.push({ kind: 'host-favicon-404', url, status: response.status() });
    else resourceFailures.push({ status: response.status(), url });
  });
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('button', { name: '田园斗地主', exact: true }).first().click();
  const iframe = page.locator('iframe[title="田园斗地主"]');
  await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  frame = page.frameLocator('iframe[title="田园斗地主"]');
  await frame.locator('.app-shell.portraits-ready').waitFor({ timeout: 20_000 });
  const startingClasses = await frame.locator('.app-shell').getAttribute('class');
  if (startingClasses?.split(/\s+/).includes('in-room')) {
    const prior = await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
    if (!String(prior?.room?.name ?? '').startsWith('GPU采样-')) {
      throw new Error(`Dev host opened an unrelated existing room; refusing to alter it: ${JSON.stringify(prior?.room ?? null)}`);
    }
    roomId = prior.room.id;
    await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.leave'));
    await frame.locator('.app-shell:not(.in-room)').waitFor({ timeout: 15_000 });
    roomId = null;
  }
  const initialUI = await frame.locator('body').evaluate(body => ({
    text: body.innerText.slice(0, 1200),
    appClasses: document.querySelector('.app-shell')?.className ?? null,
    heroButtons: [...document.querySelectorAll('button.hero-cta')].map(button => ({ text: button.innerText, disabled: button.disabled, visible: Boolean(button.getClientRects().length) })),
    preview: Boolean(document.querySelector('.preview-ribbon')),
    hasWaitingPanel: Boolean(document.querySelector('.waiting-panel')),
  }));
  await page.screenshot({ path: path.join(outDir, 'performance-lobby-start.png'), fullPage: true });
  if (!initialUI.heroButtons.length) throw new Error(`Lobby create button missing in official host: ${JSON.stringify(initialUI)}`);
  await frame.locator('button.hero-cta').waitFor({ state: 'visible', timeout: 15_000 });
  await frame.locator('button.hero-cta').waitFor({ state: 'attached' });
  await frame.locator('.preview-ribbon').waitFor({ state: 'detached', timeout: 15_000 });
  originalProfile = await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('profile.get'));
  const settingsLauncher = frame.locator('button.icon-button[aria-label="设置"]');
  if (await settingsLauncher.count()) {
    await settingsLauncher.first().click();
    const settingsDialog = frame.getByRole('dialog');
    await settingsDialog.getByRole('switch').setChecked(false);
    await settingsDialog.getByRole('button', { name: '就这样，保存偏好' }).click();
  }
  await frame.locator('.app-shell:not(.low-motion)').waitFor({ timeout: 10_000 });
  await frame.getByRole('button', { name: /创建房间/ }).click();
  const create = frame.getByRole('dialog');
  await create.getByLabel('房间名称').fill(`GPU采样-${Date.now().toString(36)}`);
  await create.getByRole('button', { name: /创建房间，等好友来/ }).click();
  await frame.locator('.waiting-panel').waitFor({ timeout: 15_000 });
  const lobby = await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
  assert.ok(lobby?.room?.id, 'official dev host should return the room created through its UI');
  roomId = lobby.room.id;
  await guestB.call('room.join', { address: lobby.room.address, roomId: lobby.room.id, password: '' });
  await guestC.call('room.join', { address: lobby.room.address, roomId: lobby.room.id, password: '' });
  await frame.getByRole('button', { name: '我准备好了' }).click();
  await guestB.call('room.ready', { ready: true });
  await guestC.call('room.ready', { ready: true });
  const started = Date.now();
  let state;
  do {
    state = await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
    if (state?.game?.phase === 'bidding') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() - started < 15_000);
  assert.equal(state?.game?.phase, 'bidding', 'could not prepare a live table for sampling');
  await frame.locator('.pixi-stage canvas').waitFor({ timeout: 15_000 });

  const normal = await sampleScenario('normal', false);
  const lowMotion = await sampleScenario('low-motion', true);
  const report = {
    at: new Date().toISOString(),
    status: 'completed',
    url: baseURL,
    browser: { executable: chromePath, version: context.browser()?.version() ?? null, headless: true, gpuFlags: ['--disable-background-timer-throttling'], forcedSwiftShader: false, forcedGpuDisable: false },
    webglRenderer: normal.renderer,
    characters: state.players.map(player => ({ nickname: player.nickname, character: player.character })),
    scenarios: [normal, lowMotion],
    browserErrors: errors,
    resourceFailures,
    hostWarnings: warnings,
    sidecarRPCs: peers.map(peer => ({ name: peer.name, calls: peer.rpcLog })),
    limitations: [
      'Headless Chrome was launched without forced SwiftShader or --disable-gpu; actual renderer/vendor strings are recorded above to show whether native hardware acceleration was available.',
      'requestAnimationFrame rate is callback cadence and is not reported as Pixi render FPS.',
      'screenFramebufferClearsPerSecond and renderFPSProxy count default-framebuffer color-clear calls after a 1-second warmup for a 5-second sample. The clear rate is a render cadence proxy, not a compositor presentation counter.',
      'The render FPS proxy cannot observe compositor presentation or dropped frames.',
      'JS heap and Chromium process working set are sampled only when the browser/platform exposes them.',
    ],
    environment: 'Official DBX Plugin CLI development host and its actual srcdoc API; isolated headless Chrome profile and two temporary Go JSONL guest sidecars. Host room creation used DOM UI; peer joins/readiness used local JSONL sidecars to hold a stable bidding scene.',
  };
  writeFileSync(path.join(outDir, 'performance-report.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(resourceFailures, [], `resource failures: ${JSON.stringify(resourceFailures)}`);
  assert.deepEqual(errors, [], `browser errors: ${JSON.stringify(errors)}`);
  return report;
}

let binaryBundle;
try {
  binaryBundle = copyBinaryToTemp();
  const report = await run(binaryBundle.binary);
  console.log(`Performance measurements saved to ${path.join(outDir, 'performance-report.json')}`);
  console.log(JSON.stringify(report.scenarios.map(s => ({ mode: s.mode, screenFramebufferClearsPerSecond: s.screenFramebufferClearsPerSecond, durationMs: s.screenFramebufferClearProbe.durationMs, pixiTickerFPS: s.pixiTickerFPS, raf: s.raf, peakHeapBytes: s.jsHeapBytes?.peak, chromiumWorkingSetBytes: s.chromiumWorkingSet.after.totalWorkingSetBytes })), null, 2));
} catch (error) {
  writeFileSync(path.join(outDir, 'performance-report.json'), JSON.stringify({
    at: new Date().toISOString(), status: 'failed', error: error.stack ?? String(error),
    browserErrors: errors, resourceFailures, hostWarnings: warnings,
    sidecarRPCs: peers.map(peer => ({ name: peer.name, calls: peer.rpcLog })),
  }, null, 2));
  throw error;
} finally {
  if (roomId) await frame?.locator('body').evaluate(async (_body, id) => {
    const state = await window.dbxPlugin.invoke('room.snapshot');
    if (state?.room?.id === id) await window.dbxPlugin.invoke('room.leave');
  }, roomId).catch(() => undefined);
  if (originalProfile && frame) await frame.locator('body').evaluate((_body, profile) => window.dbxPlugin.invoke('profile.save', profile), originalProfile).catch(() => undefined);
  for (const peer of peers.filter(item => item.name !== 'host')) await peer.call('room.leave').catch(() => undefined);
  await context?.close().catch(() => undefined);
  for (const peer of peers) {
    try { peer.child.stdin.end(); } catch {}
    if (peer.child.exitCode === null) peer.child.kill();
    rmSync(peer.dataDir, { recursive: true, force: true });
  }
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  if (binaryBundle) rmSync(binaryBundle.dir, { recursive: true, force: true });
}
