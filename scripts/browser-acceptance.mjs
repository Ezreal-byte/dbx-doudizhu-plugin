import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Real Chromium + real Go JSONL sidecars. The browser bridge below only adapts
// DBX's host API to JSONL; room state, TLS joins, rules and settlement stay in Go.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const go = process.env.DBX_GO ?? 'go';
const baseURL = process.env.DBX_BROWSER_URL ?? 'http://127.0.0.1:5192';
const outDir = path.join(root, 'test-results', 'browser');
const binary = path.join(root, 'backend', 'bin', process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const resumeMode = process.env.DBX_BROWSER_RESUME ?? '';
const resume1920 = resumeMode === '1920';
const resumeFallback = resumeMode === 'fallback';
const resumeReport = resumeMode === 'report';
const existingReport = (resume1920 || resumeFallback || resumeReport) && existsSync(path.join(root, 'test-results', 'browser', 'report.json'))
  ? JSON.parse(readFileSync(path.join(root, 'test-results', 'browser', 'report.json'), 'utf8')) : null;
const suites = existingReport?.suites?.filter(suite => suite.status === 'passed') ?? [];
const progressReport = (resume1920 || resumeFallback || resumeReport) && existsSync(path.join(root, 'test-results', 'browser', 'progress.json'))
  ? JSON.parse(readFileSync(path.join(root, 'test-results', 'browser', 'progress.json'), 'utf8')) : null;
const completedRounds = progressReport?.completedRounds ?? [];
const clients = [];
const contexts = [];
const browserDirs = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let requestNumber = 0;
let activeViewport = null;
let activeBrowserErrors = [];
let activeAssetErrors = [];
let activeUiActionAcks = [];
let activeExternalRequests = [];
let activeFallback = false;

mkdirSync(outDir, { recursive: true });
const build = spawnSync(go, ['build', '-o', binary, '.'], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Go sidecar build failed:\n${build.stdout}\n${build.stderr}`);

function sidecar(name) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'dbx-browser-acceptance-'));
  const child = spawn(binary, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = new Set();
  const eventLog = [];
  const rpcLog = [];
  const client = {
    name, child, dataDir, eventLog, rpcLog,
    call(method, params = {}) {
      const id = ++requestNumber;
      rpcLog.push({ id, at: Date.now(), method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}: ${method} timed out`)); }, 15_000);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    onEvent(fn) { events.add(fn); return () => events.delete(fn); },
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch (error) { process.stderr.write(`[${name}] invalid JSONL: ${line}\n`); return; }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      const logged = rpcLog.find(item => item.id === message.id);
      if (logged && request.method === 'game.action') logged.response = message.error ? { error: message.error.message } : { revision: message.result?.revision, historyLength: message.result?.game?.history?.length, phase: message.result?.game?.phase };
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else request.resolve(message.result);
    } else if (message.method) { eventLog.push(message); for (const fn of events) fn(message); }
  });
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', code => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`${name} sidecar exited (${code})`)); }
    pending.clear();
  });
  clients.push(client);
  return client;
}

function dataURL(file) {
  const bytes = readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };
  return { contentType: types[ext] ?? 'application/octet-stream', dataBase64: bytes.toString('base64') };
}

async function installBridge(page, host) {
  await page.exposeFunction('__dbxInvoke', (method, params) => host.call(method, params ?? {}));
  await page.addInitScript(() => {
    const listeners = new Set();
    const asset = async requested => {
      const clean = String(requested).replace(/^\/+/, '');
      if (clean.split('/').includes('..')) throw new Error('invalid asset path');
      const file = await window.__dbxReadAsset(clean);
      const binary = atob(file.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
    };
    window.dbxPlugin = {
      ready: Promise.resolve({ protocolVersion: 1 }),
      invoke: (method, params = {}) => window.__dbxInvoke(method, params),
      onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      readAsset: async requested => window.__dbxReadAsset(String(requested).replace(/^\/+/, '')),
      readAssetUrl: asset,
      workbench: { onClose: () => () => undefined },
    };
    window.__dbxEmit = event => { for (const callback of listeners) callback(event); };
  });
  await page.exposeFunction('__dbxReadAsset', requested => {
    try {
      const resolved = path.resolve(root, 'ui', requested);
      const uiRoot = path.resolve(root, 'ui') + path.sep;
      if (!resolved.startsWith(uiRoot)) throw new Error('asset escaped ui directory');
      return dataURL(resolved);
    } catch (error) {
      activeAssetErrors.push(`${requested}: ${error.message}`);
      throw error;
    }
  });
  host.onEvent(event => {
    void page.evaluate(value => window.__dbxEmit?.(value), event).catch(() => undefined);
  });
}

async function screenshot(page, viewport, name, stage) {
  const suffix = activeFallback ? '-dom-fallback' : '';
  await page.screenshot({ path: path.join(outDir, `${stage}${suffix}-${viewport.width}x${viewport.height}-dpr1.5.png`), animations: 'disabled' });
}

async function waitForHostState(host, predicate, description, timeoutMs = 10_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await host.call('room.snapshot');
    if (latest && predicate(latest)) return latest;
    await delay(60);
  }
  throw new Error(`timed out waiting for backend state: ${description}; last state=${JSON.stringify(latest?.game ?? latest)}`);
}
const historyLength = snapshot => snapshot?.game?.history?.length ?? 0;

async function waitForBrowserAction(page, host, before, viewport, id, description, rpcStartIndex) {
  const hostSeat = before.players.find(player => player.id === before.selfId)?.seat;
  const started = Date.now();
  let latest;
  while (Date.now() - started < 8_000) {
    latest = await host.call('room.snapshot');
    const finalAction = latest?.game?.history?.at(-1);
    const uiRequest = host.rpcLog.slice(rpcStartIndex).find(request => request.method === 'game.action' && request.params.type === description && request.params.expectedRevision === before.revision);
    const exactActionAck = Boolean(uiRequest) && latest?.revision > before.revision && finalAction?.seat === hostSeat &&
      ((description === 'play' && finalAction.cards.length > 0 && latest.game.hand.length < before.game.hand.length) ||
       (description === 'pass' && finalAction.cards.length === 0));
    if (exactActionAck) {
      if (latest.game?.phase === 'playing') await waitForRenderedTurn(page, latest);
      const pageState = await readRenderedState(page);
      activeUiActionAcks.push({ description, beforeRevision: before.revision, afterRevision: latest.revision, beforeTurn: before.game.turn, afterTurn: latest.game?.turn, historyAction: finalAction, rpc: uiRequest, page: pageState });
      return latest;
    }
    // innerText() on an absent locator waits for the entire Playwright timeout,
    // which can expire a real player's turn before the next state poll.
    const errorToast = page.locator('.error-toast');
    const uiError = await errorToast.count() ? await errorToast.innerText({ timeout: 500 }).catch(() => '') : '';
    if (uiError) {
      await screenshot(page, viewport, id, 'ui-action-error');
      throw new Error(`browser ${description} returned a UI error: ${uiError}`);
    }
    await delay(80);
  }
  await screenshot(page, viewport, id, 'ui-action-timeout');
  const dom = await readRenderedState(page);
  throw new Error(`browser ${description} has no matching UI RPC + host history acknowledgement; before=${JSON.stringify({ revision: before.revision, turn: before.game.turn, historyLength: historyLength(before), handLength: before.game.hand.length })}; after=${JSON.stringify({ revision: latest?.revision, turn: latest?.game?.turn, historyLength: historyLength(latest), handLength: latest?.game?.hand?.length, lastAction: latest?.game?.history?.at(-1) })}; recentHostRPC=${JSON.stringify(host.rpcLog.slice(rpcStartIndex))}; page=${JSON.stringify(dom)}`);
}

async function readRenderedState(page) {
  return page.evaluate(() => {
    const indicator = document.querySelector('.turn-indicator');
    const actionButtons = [...document.querySelectorAll('.action-row button')].map(button => ({ text: button.innerText.trim(), disabled: button.disabled, visible: Boolean(button.getClientRects().length) }));
    return {
      phaseText: document.querySelector('.round-info span')?.textContent?.trim() ?? null,
      indicatorText: indicator?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      yourTurn: indicator?.classList.contains('your-turn') ?? false,
      actionButtons,
      selected: document.querySelector('.selection-toolbar span')?.textContent?.trim() ?? '',
      error: document.querySelector('.error-toast')?.textContent?.trim() ?? '',
    };
  });
}

async function waitForRenderedTurn(page, snapshot, timeoutMs = 6_000) {
  const selfSeat = snapshot.players.find(player => player.id === snapshot.selfId)?.seat;
  const activePlayer = snapshot.players.find(player => player.seat === snapshot.game.turn);
  const localTurn = snapshot.game.turn === selfSeat;
  const expectedName = activePlayer?.nickname ?? '牌友';
  const started = Date.now();
  let rendered;
  while (Date.now() - started < timeoutMs) {
    rendered = await readRenderedState(page);
    const phaseMatches = rendered.phaseText === '对局中';
    const turnMatches = localTurn
      ? rendered.yourTurn && rendered.indicatorText?.includes('轮到你出牌')
      : !rendered.yourTurn && rendered.indicatorText?.includes(`等待 ${expectedName} 出牌`);
    if (phaseMatches && turnMatches) return rendered;
    if (rendered.error) throw new Error(`UI error while waiting for Go snapshot revision ${snapshot.revision}: ${rendered.error}; page=${JSON.stringify(rendered)}`);
    await delay(100);
  }
  throw new Error(`Vue page did not render Go snapshot revision=${snapshot.revision}, phase=${snapshot.game.phase}, turn=${snapshot.game.turn}, selfSeat=${selfSeat}; page=${JSON.stringify(rendered)}`);
}

async function runViewport(viewport, forceDOMFallback = false) {
  activeViewport = viewport;
  activeFallback = forceDOMFallback;
  activeBrowserErrors = [];
  activeAssetErrors = [];
  activeUiActionAcks = [];
  activeExternalRequests = [];
  const id = `${viewport.width}x${viewport.height}${forceDOMFallback ? '-dom-fallback' : ''}`;
  const a = sidecar(`host-${id}`), b = sidecar(`guest-b-${id}`), c = sidecar(`guest-c-${id}`);
  const players = [a, b, c];
  for (const [i, player] of players.entries()) {
    const initialized = await player.call('plugin/initialize', { host: { protocolVersions: [1] } });
    assert.equal(initialized.plugin.id, 'io.dbx.doudizhu');
    await player.call('profile.save', { nickname: ['阿禾', '小满', '福伯'][i], character: i, music: 0, sound: 0, voice: 0, lowMotion: false });
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dbx-chromium-acceptance-'));
  browserDirs.push(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath, headless: true, viewport, deviceScaleFactor: 1.5,
    args: [...(forceDOMFallback ? ['--disable-webgl'] : ['--enable-webgl', '--use-angle=swiftshader']), '--disable-background-timer-throttling'],
    ...(!forceDOMFallback && viewport.width === 1366 ? { recordVideo: { dir: outDir, size: { width: viewport.width, height: viewport.height } } } : {}),
  });
  contexts.push(context);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    activeExternalRequests.push({ url: url.href, type: route.request().resourceType() });
    return route.abort('blockedbyclient');
  });
  const page = context.pages()[0] ?? await context.newPage();
  if (forceDOMFallback) {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (['webgl', 'webgl2', 'experimental-webgl'].includes(String(type).toLowerCase())) return null;
        return original.call(this, type, ...args);
      };
    });
  }
  const browserErrors = activeBrowserErrors;
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`console: ${msg.text()} (${msg.location().url || 'unknown URL'})`); });
  page.on('response', response => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()}: ${response.url()}`); });
  await installBridge(page, a);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('heading', { name: /田园斗地主/ }).waitFor({ timeout: 15_000 });
  await page.getByRole('heading', { name: '好友牌桌' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.rooms-empty h3')?.textContent?.includes('正在打开小院'), null, { timeout: 15_000 });
  await page.locator('.app-shell.portraits-ready').waitFor({ timeout: 10_000 });
  try {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--landscape').includes('url('), null, { timeout: 10_000 });
  } catch {
    const diagnostic = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      const raw = shell?.getAttribute('style') ?? '';
      return { styleLength: raw.length, styleHasLandscape: raw.includes('--landscape'), inlineValueLength: shell?.style.getPropertyValue('--landscape').length ?? 0, computedValueLength: getComputedStyle(shell).getPropertyValue('--landscape').length, portraitReady: shell?.classList.contains('portraits-ready'), sceneBackground: getComputedStyle(document.querySelector('.scene-background')).backgroundImage.slice(0, 180) };
    });
    await screenshot(page, viewport, id, 'background-failure');
    throw new Error(`country asset did not reach app-shell --landscape; diagnostic=${JSON.stringify(diagnostic)} assets=${JSON.stringify(activeAssetErrors)}`);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    const raw = getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--landscape');
    const url = raw.match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (url) { const image = new Image(); image.src = url; await image.decode(); }
  });
  await screenshot(page, viewport, id, 'lobby');

  // Verify the host-backed profile survives closing and reopening settings.
  await page.getByRole('button', { name: '设置' }).click();
  const motionSwitch = page.getByRole('switch');
  await motionSwitch.setChecked(true);
  await page.getByRole('button', { name: '就这样，保存偏好' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  assert.equal(await motionSwitch.isChecked(), true, 'reopened settings should retain the saved reduced-motion preference');
  await motionSwitch.setChecked(false);
  await page.getByRole('button', { name: '就这样，保存偏好' }).click();

  await page.getByRole('button', { name: /创建房间/ }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '开一间自己的小院' }).waitFor();
  await page.getByRole('button', { name: /创建房间，等好友来/ }).click();
  await page.locator('.waiting-panel h2').waitFor();
  const lobbyState = await a.call('room.snapshot');
  const address = lobbyState.room.address;
  for (const guest of [b, c]) await guest.call('room.join', { address, roomId: lobbyState.room.id, password: '' });
  await page.waitForFunction(() => document.querySelectorAll('.waiting-seat').length === 3 && document.querySelectorAll('.waiting-seat strong').length === 3);
  await screenshot(page, viewport, id, 'waiting');

  await page.getByRole('button', { name: '我准备好了' }).click();
  await waitForHostState(a, state => state.players.find(player => player.id === state.selfId)?.ready === true, 'browser ready action is committed');
  await b.call('room.ready', { ready: true });
  await c.call('room.ready', { ready: true });
  await waitForHostState(a, state => state.game?.phase === 'bidding', 'all three ready actions start the first round');
  await page.locator('.turn-indicator').waitFor({ timeout: 10_000 });
  assert.equal((await a.call('room.snapshot')).game.phase, 'bidding');
  await screenshot(page, viewport, id, 'bidding');

  const seatMap = new Map();
  for (const client of players) { const s = await client.call('room.snapshot'); seatMap.set(s.players.find(p => p.id === s.selfId).seat, client); }
  let current = await a.call('room.snapshot');
  assert.equal(seatMap.get(current.game.turn), a, 'host owns the initial bid turn');
  await page.waitForFunction(() => document.querySelector('.turn-indicator')?.textContent?.includes('轮到你叫分'), null, { timeout: 10_000 });
  await page.getByRole('button', { name: '3 分' }).click();
  current = await waitForHostState(a, state => state.game?.phase === 'doubling', 'browser 3-point bid changes backend phase');
  await page.getByRole('button', { name: '不加倍' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: '不加倍' }).click();
  await waitForHostState(a, state => state.game?.phase === 'doubling' && state.game.doubles[state.players.find(player => player.id === state.selfId).seat] === 1, 'browser doubling choice is committed');
  // A completed bid phase immediately transitions to doubling; all three clients decide.
  for (const client of players) {
    const state = await client.call('room.snapshot');
    if (client !== a && state.game?.phase === 'doubling') await client.call('game.action', { actionId: `browser-double-${++requestNumber}`, expectedRevision: state.revision, type: 'double', double: false });
  }
  await page.waitForFunction(() => document.querySelector('.round-info')?.textContent?.includes('出牌') || document.querySelector('.action-row')?.textContent?.includes('提示'), null, { timeout: 10_000 }).catch(() => undefined);
  current = await a.call('room.snapshot');
  assert.equal(current.game.phase, 'playing', 'bidding and doubling should start a real round');
  await page.locator('.fallback-hand, .pixi-stage canvas').first().waitFor({ timeout: 10_000 });
  await screenshot(page, viewport, id, 'table');

  const canvas = page.locator('.pixi-stage canvas');
  let canvasMetrics = null;
  if (forceDOMFallback) {
    await page.locator('.pixi-stage.render-fallback').waitFor({ timeout: 10_000 });
    await page.locator('.fallback-hand button').first().waitFor({ timeout: 5_000 });
    await page.screenshot({ path: path.join(outDir, 'dom-fallback-table-1366x768.png') });
  } else {
    await canvas.waitFor({ timeout: 10_000 });
    canvasMetrics = await canvas.evaluate(element => ({ width: element.width, height: element.height, cssWidth: element.clientWidth, cssHeight: element.clientHeight, devicePixelRatio: window.devicePixelRatio }));
  }
  const stageBox = await page.locator('.pixi-stage').boundingBox();
  assert.ok(stageBox, 'Pixi stage should have visible bounds');
  const sceneScale = stageBox.width / 1600;
  const animatedCharacterClip = { x: stageBox.x + 45 * sceneScale, y: stageBox.y + 205 * sceneScale, width: 220 * sceneScale, height: 285 * sceneScale };
  // Drive a complete round through the three Go processes. Host turns go through
  // the visible browser controls; the other two are ordinary JSONL RPC clients.
  for (let turn = 0; turn < 450; turn++) {
    const state = await a.call('room.snapshot');
    if (state.game.phase === 'finished') break;
    assert.equal(state.game.phase, 'playing');
    const rendered = await waitForRenderedTurn(page, state);
    const actor = seatMap.get(state.game.turn);
    if (actor === a) {
      let actionBase;
      let rpcStartIndex;
      const hint = await a.call('game.hint');
      const afterHint = await a.call('room.snapshot');
      if (afterHint.game.phase !== 'playing' || afterHint.game.turn !== state.game.turn || historyLength(afterHint) !== historyLength(state)) continue;
      await waitForRenderedTurn(page, afterHint);
      if (hint.candidates?.length) {
        const hintButton = page.getByRole('button', { name: '提示' });
        assert.equal(await hintButton.isVisible(), true, `hint must be visible on host turn: ${JSON.stringify(rendered)}`);
        assert.equal(await hintButton.isEnabled(), true, `hint must be enabled on host turn: ${JSON.stringify(rendered)}`);
        await hintButton.click();
        try {
          await page.waitForFunction(() => {
            const button = document.querySelector('.play-button');
            return button && !button.disabled;
          }, null, { timeout: 3_000 });
        } catch {
          await screenshot(page, viewport, id, 'ui-play-failure');
          throw new Error(`browser hint did not enable the Play button at host turn; screenshot: ui-play-failure-${id}-dpr1.5.png`);
        }
        const beforeClick = await a.call('room.snapshot');
        if (beforeClick.game.phase !== 'playing' || beforeClick.game.turn !== state.game.turn || historyLength(beforeClick) !== historyLength(state)) continue;
        await waitForRenderedTurn(page, beforeClick);
        actionBase = beforeClick;
        rpcStartIndex = a.rpcLog.length;
        await page.getByRole('button', { name: /^出牌/ }).click();
      } else {
        const passButton = page.getByRole('button', { name: '不出' });
        await passButton.waitFor({ state: 'visible', timeout: 5_000 });
        assert.equal(await passButton.isEnabled(), true, `pass must be enabled when no candidates exist: ${JSON.stringify(rendered)}`);
        const beforeClick = await a.call('room.snapshot');
        if (beforeClick.game.phase !== 'playing' || beforeClick.game.turn !== state.game.turn || historyLength(beforeClick) !== historyLength(state)) continue;
        actionBase = beforeClick;
        rpcStartIndex = a.rpcLog.length;
        await passButton.click();
      }
      await waitForBrowserAction(page, a, actionBase, viewport, id, hint.candidates?.length ? 'play' : 'pass', rpcStartIndex);
    } else {
      const local = await actor.call('room.snapshot');
      assert.equal(local.game.phase, 'playing');
      assert.equal(local.game.turn, state.game.turn, 'guest and host snapshots must agree on the active turn');
      assert.equal(historyLength(local), historyLength(state), 'guest and host snapshots must agree on turn history');
      const hint = await actor.call('game.hint');
      const committed = await actor.call('game.action', {
        actionId: `browser-play-${++requestNumber}`, expectedRevision: local.revision,
        type: hint.candidates?.length ? 'play' : 'pass', ...(hint.candidates?.length ? { cards: hint.candidates[0] } : {}),
      });
      assert.equal(committed.game?.history?.at(-1)?.seat, local.game.turn, 'guest action must be committed for the expected seat');
      const hostAfterGuest = await waitForHostState(a, snapshot => historyLength(snapshot) > historyLength(local) || snapshot.game.phase === 'finished', `host observes guest ${hint.candidates?.length ? 'play' : 'pass'}`);
      if (hostAfterGuest.game.phase === 'playing') await waitForRenderedTurn(page, hostAfterGuest);
    }
  }
  const finished = await a.call('room.snapshot');
  assert.equal(finished.game.phase, 'finished', 'a complete game should reach settlement');
  await page.locator('.settlement-panel').waitFor({ timeout: 10_000 });
  await screenshot(page, viewport, id, 'settlement');
  assert.equal(finished.game.settlement.deltas.reduce((sum, value) => sum + value, 0), 0);
  assert.equal(finished.game.settlement.balances.reduce((sum, value) => sum + value, 0), 30_000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('.settlement-panel').waitFor({ timeout: 15_000 });
  const restored = await a.call('room.snapshot');
  assert.equal(restored.game.roundId, finished.game.roundId, 'reload should restore the same finished round');
  assert.deepEqual(restored.game.settlement, finished.game.settlement, 'reload should preserve the complete settlement ledger');
  assert.equal(restored.revision, finished.revision, 'reload should not mutate the finished room revision');
  const completedRound = { viewport, roundId: finished.game.roundId, turns: historyLength(finished), restoredSameRound: restored.game.roundId === finished.game.roundId, restoredLedger: JSON.stringify(restored.game.settlement) === JSON.stringify(finished.game.settlement), settlement: finished.game.settlement };
  completedRounds.push(completedRound);
  writeFileSync(path.join(outDir, 'progress.json'), JSON.stringify({ at: new Date().toISOString(), completedRounds }, null, 2));

  if (!forceDOMFallback) {
  // Presentation checks run in a fresh round so their 20+ seconds of animation
  // sampling and social cooldowns cannot collide with the active-turn deadline.
  await page.getByRole('button', { name: '再来一局' }).click();
  await waitForHostState(a, state => state.players.find(player => player.id === state.selfId)?.ready === true, 'browser ready for a second round');
  await b.call('room.ready', { ready: true });
  await c.call('room.ready', { ready: true });
  let secondRound = await waitForHostState(a, state => state.game?.phase === 'bidding', 'second round begins');
  for (let bidAttempt = 0; bidAttempt < 3 && secondRound.game.phase === 'bidding'; bidAttempt++) {
    const actor = seatMap.get(secondRound.game.turn);
    if (actor === a) {
      const previousBids = JSON.stringify(secondRound.game.bids);
      await page.waitForFunction(() => document.querySelector('.turn-indicator')?.textContent?.includes('轮到你叫分'), null, { timeout: 8_000 });
      await page.getByRole('button', { name: '3 分' }).click();
      secondRound = await waitForHostState(a, state => state.game.phase !== 'bidding' || JSON.stringify(state.game.bids) !== previousBids, 'host second-round bid is committed');
    } else {
      const state = await actor.call('room.snapshot');
      const committed = await actor.call('game.action', { actionId: `browser-second-bid-${++requestNumber}`, expectedRevision: state.revision, type: 'bid', score: 0 });
      assert.notEqual(committed.revision, state.revision, 'guest pass bid must commit');
      secondRound = await waitForHostState(a, latest => latest.revision > state.revision, 'host observes second-round guest bid');
    }
    if (secondRound.game.phase === 'bidding') secondRound = await a.call('room.snapshot');
  }
  if (secondRound.game.phase === 'bidding') throw new Error(`second round did not leave bidding phase: ${JSON.stringify(secondRound.game)}`);
  assert.equal(secondRound.game.phase, 'doubling');
  await waitForHostState(a, state => state.game?.phase === 'doubling', 'browser bids in the second round');
  await page.getByRole('button', { name: '不加倍' }).click();
  await waitForHostState(a, state => state.game?.phase === 'doubling' && state.game.doubles[state.players.find(player => player.id === state.selfId).seat] === 1, 'browser doubles in the second round');
  for (const client of players) {
    if (client === a) continue;
    const state = await client.call('room.snapshot');
    if (state.game?.phase === 'doubling') await client.call('game.action', { actionId: `browser-double-${++requestNumber}`, expectedRevision: state.revision, type: 'double', double: false });
  }
  current = await a.call('room.snapshot');
  await waitForHostState(a, state => state.game?.phase === 'playing', 'second round starts after all doubles');
  await page.locator('.turn-indicator').waitFor();

  const frameBefore = await page.screenshot({ clip: animatedCharacterClip });
  writeFileSync(path.join(outDir, `character-before-${id}.png`), frameBefore);
  const frameHashBefore = createHash('sha256').update(frameBefore).digest('hex');
  const raf = await page.evaluate(() => new Promise(resolve => {
    const started = performance.now(); let frames = 0;
    const next = now => { frames += 1; if (now - started >= 5_000) resolve({ frames, elapsedMs: now - started }); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  const frameAfter = await page.screenshot({ clip: animatedCharacterClip });
  writeFileSync(path.join(outDir, `character-after-${id}.png`), frameAfter);
  const frameHashAfter = createHash('sha256').update(frameAfter).digest('hex');
  assert.notEqual(frameHashAfter, frameHashBefore, 'cropped Pixi character region should change as its idle animation moves');

  await page.getByRole('button', { name: '互动' }).click();
  await page.getByRole('button', { name: '倒茶' }).click();
  await page.locator('.social-toast').waitFor({ timeout: 5_000 });
  await screenshot(page, viewport, id, 'gift');
  current = await a.call('room.snapshot');
  const hand = [...current.game.hand].sort((left, right) => {
    const rank = card => card >= 52 ? card - 36 : Math.floor(card / 4) + 3;
    return rank(right) - rank(left) || right - left;
  });
  const gap = Math.min(57, 970 / Math.max(1, hand.length - 1));
  const start = 800 - ((hand.length - 1) * gap + 94) / 2;
  const cardPoint = index => ({ x: stageBox.x + (start + index * gap + Math.max(14, gap / 2)) * sceneScale, y: stageBox.y + 817 * sceneScale });
  await page.mouse.click(cardPoint(0).x, cardPoint(0).y);
  await page.waitForFunction(() => document.querySelector('.selection-toolbar span')?.textContent?.includes('已选 1 张'), null, { timeout: 3_000 });
  await page.mouse.move(cardPoint(1).x, cardPoint(1).y);
  await page.mouse.down();
  for (const index of [2, 3]) await page.mouse.move(cardPoint(index).x, cardPoint(index).y, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.selection-toolbar span')?.textContent?.includes('已选 4 张'), null, { timeout: 3_000 });
  await screenshot(page, viewport, id, 'selection');
  await page.mouse.dblclick(stageBox.x + 800 * sceneScale, stageBox.y + 460 * sceneScale);
  await page.waitForFunction(() => !document.querySelector('.selection-toolbar span')?.textContent?.includes('已选'), null, { timeout: 3_000 });

  const socialCases = [
    { name: '送花', kind: 'flower' }, { name: '点赞', kind: 'like' }, { name: '番茄', kind: 'tomato' },
    { name: '鸡蛋', kind: 'egg' }, { kind: 'phrase', phrase: '这牌打得真漂亮！' },
  ];
  for (const item of socialCases) {
    const previousHostEvents = a.eventLog.filter(event => event.method === 'social.event').length;
    await delay(3_100);
    await page.getByRole('button', { name: '互动' }).click();
    await page.getByRole('button', { name: item.kind === 'phrase' ? item.phrase : item.name }).click();
    const hostEvent = await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const found = a.eventLog.filter(event => event.method === 'social.event');
        if (found.length > previousHostEvents) return resolve(found.at(-1));
        if (Date.now() - started > 5_000) return reject(new Error(`social event ${item.kind} was not delivered to host`));
        setTimeout(poll, 60);
      };
      poll();
    });
    if (item.kind === 'phrase') assert.equal(hostEvent.params.phrase, item.phrase);
    assert.equal(hostEvent.params.kind, item.kind);
    const deliveryStarted = Date.now();
    while (Date.now() - deliveryStarted < 5_000 && players.some(receiver => !receiver.eventLog.some(event => event.method === 'social.event' && event.params.id === hostEvent.params.id))) await delay(60);
    for (const receiver of players) {
      const received = receiver.eventLog.filter(event => event.method === 'social.event' && event.params.id === hostEvent.params.id);
      assert.equal(received.length, 1, `${item.kind} should reach each sidecar exactly once`);
      assert.deepEqual(received[0].params, hostEvent.params, `${item.kind} payload should match across sidecars`);
    }
  }

  suites.push({ viewport, deviceScaleFactor: 1.5, status: 'passed', roundId: finished.game.roundId, turns: finished.game.history.length, restoredAfterReload: { sameRound: restored.game.roundId === finished.game.roundId, sameLedger: JSON.stringify(restored.game.settlement) === JSON.stringify(finished.game.settlement), revision: restored.revision }, selection: { clickedOne: true, draggedThreeMore: true, blankDoubleClickCleared: true }, socialEvents: 6, uiFallback: await page.locator('.pixi-stage').getAttribute('class').then(v => v?.includes('render-fallback') ?? false), pixiCanvas: canvasMetrics, animation: { characterRegionHashChanged: frameHashAfter !== frameHashBefore, rafFrames: raf.frames, elapsedMs: Math.round(raf.elapsedMs), rafHz: Math.round(raf.frames * 1000 / raf.elapsedMs), rendererFPS: null, note: 'RAF callback rate under headless Chromium SwiftShader; this does not measure renderer FPS or native GPU performance.' }, browserErrors, externalRequestsBlocked: activeExternalRequests, hostActionAcknowledgements: activeUiActionAcks });
  } else {
    assert.equal(await page.locator('.pixi-stage').getAttribute('class').then(value => value?.includes('render-fallback') ?? false), true, 'disabled WebGL should render the DOM fallback');
    assert.ok(activeUiActionAcks.some(ack => ack.rpc.params.type === 'play'), 'at least one legal host play must be acknowledged through the browser UI');
    suites.push({ viewport, deviceScaleFactor: 1.5, status: 'passed', domFallback: true, roundId: finished.game.roundId, turns: historyLength(finished), firstLegalHostPlay: activeUiActionAcks.find(ack => ack.rpc.params.type === 'play'), restoredAfterReload: true, browserErrors, externalRequestsBlocked: activeExternalRequests, hostActionAcknowledgements: activeUiActionAcks });
  }
  writeFileSync(path.join(outDir, 'progress.json'), JSON.stringify({ at: new Date().toISOString(), completedRounds, suites }, null, 2));
  const videoPath = viewport.width === 1366 && !forceDOMFallback ? await page.video()?.path() : null;
  await context.close();
  if (videoPath) copyFileSync(videoPath, path.join(outDir, 'demo.webm'));
  rmSync(userDataDir, { recursive: true, force: true });
  for (const client of players) await client.call('room.leave').catch(() => undefined);
}

try {
  assert.ok(existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  const viewports = resume1920 ? [{ width: 1920, height: 1080 }] : (resumeFallback || resumeReport) ? [] : [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }];
  for (const viewport of viewports) await runViewport(viewport);
  if (!resume1920 && !resumeReport && (resumeFallback || !resumeMode)) await runViewport({ width: 1366, height: 768 }, true);
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(), status: 'passed', url: baseURL, checks: ['real Chromium', 'three Go JSONL sidecars', 'TLS room joins', 'lobby', 'waiting', 'bidding', 'Pixi table', 'DOM fallback full game', 'UI-acknowledged host plays', 'selection/drag/clear', 'six social events', 'local-only network requests', 'reload restores round and settlement ledger', 'settlement'],
    suites, environment: 'Headless browser bridge to local DBX JSONL sidecars; not the desktop DBX host and not three physical computers.',
  }, null, 2));
  console.log(`Passed ${suites.length} browser suites. Screenshots and report: ${outDir}`);
} catch (error) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), status: 'failed', viewport: activeViewport, error: error.stack ?? String(error), browserErrors: activeBrowserErrors, assetErrors: activeAssetErrors, completedRounds, suites }, null, 2));
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
  for (const client of clients) {
    try { client.child.stdin.end(); } catch {}
    if (client.child.exitCode === null) client.child.kill();
    rmSync(client.dataDir, { recursive: true, force: true });
  }
  for (const dir of browserDirs) rmSync(dir, { recursive: true, force: true });
}
