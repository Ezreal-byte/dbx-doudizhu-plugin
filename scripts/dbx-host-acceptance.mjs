import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Exercise the installed DBX Plugin CLI dev host. All browser state and peer
// sidecar data are temporary; this script never opens the user's DBX desktop.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DBX_HOST_URL ?? 'http://127.0.0.1:5190';
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const binary = path.join(root, 'backend', 'bin', process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const outDir = path.join(root, 'test-results', 'dbx-host');
const results = [];
const blockers = [];
const peerClients = [];
let browser;
let context;
let page;
let activeFrame;
let testRoomId;
let screenshotIndex = 0;

mkdirSync(outDir, { recursive: true });

function record(name, details = {}) {
  results.push({ name, status: 'passed', ...details });
  console.log(`PASS ${name}`);
}

async function capture(name) {
  screenshotIndex += 1;
  await page.screenshot({ path: path.join(outDir, `${String(screenshotIndex).padStart(2, '0')}-${name}.png`), fullPage: true });
}

function startPeer(name) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'dbx-host-acceptance-'));
  const child = spawn(binary, [], {
    env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  const pending = new Map();
  const client = {
    name, child, dataDir,
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name}: ${method} timed out`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stderr.write(`[${name}] invalid JSONL response\n`); return; }
    if (message.id === undefined) return;
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
  peerClients.push(client);
  return client;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.ok(existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  assert.ok(existsSync(binary), `Go sidecar binary not found: ${binary}`);

  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--disable-background-timer-throttling'],
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  const browserWarnings = [];
  const hostWarnings = [];
  const httpResources = new Map();
  const seenHostWarnings = new Set();
  const hostOrigin = new URL(baseURL).origin;
  const hostFaviconURL = new URL('/favicon.ico', baseURL).href;
  const recordHostWarning = (kind, url, message) => {
    const key = `${kind}:${url}`;
    if (seenHostWarnings.has(key)) return;
    seenHostWarnings.add(key);
    hostWarnings.push({ kind, url, message });
  };
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    if (!/^https?:/i.test(url)) return;
    if (!httpResources.has(url)) {
      httpResources.set(url, { url, resourceTypes: [], status: null });
    }
    const resource = httpResources.get(url);
    if (!resource.resourceTypes.includes(request.resourceType())) resource.resourceTypes.push(request.resourceType());
  });
  page.on('console', message => {
    const location = message.location().url ?? '';
    const text = message.text();
    if (text.includes('Failed to load resource') && location === hostFaviconURL) {
      recordHostWarning('host-favicon-404', hostFaviconURL, text);
      return;
    }
    const blockedIcon = text.match(/Loading the image '([^']+)' violates the following Content Security Policy/);
    if (blockedIcon) {
      const blockedUrl = new URL(blockedIcon[1], baseURL);
      if (blockedUrl.origin === hostOrigin && blockedUrl.pathname === '/favicon.svg') {
        recordHostWarning('srcdoc-favicon-blocked-by-csp', blockedUrl.href, text);
        return;
      }
      if (message.type() === 'error') browserErrors.push(`${text} (${location || 'unknown URL'})`);
      return;
    }
    if (message.text().includes('Blocked autofocusing on a <input> element in a cross-origin subframe.')) {
      browserWarnings.push(message.text());
      return;
    }
    if (message.type() === 'error' && message.text().includes('Blocked form submission')) {
      if (!blockers.includes('Plugin form submission is blocked by the official host iframe sandbox (sandbox lacks allow-forms).')) {
        blockers.push('Plugin form submission is blocked by the official host iframe sandbox (sandbox lacks allow-forms).');
      }
      return;
    }
    if (message.type() === 'error') browserErrors.push(`${message.text()} (${location || 'unknown URL'})`);
  });
  page.on('response', response => {
    const url = response.url();
    let resource = httpResources.get(url);
    if (!resource) {
      resource = { url, resourceTypes: [], status: null };
      httpResources.set(url, resource);
    }
    resource.status = response.status();
    if (response.status() >= 400 && url === hostFaviconURL) {
      recordHostWarning('host-favicon-404', hostFaviconURL, `HTTP ${response.status()}`);
    } else if (response.status() >= 400) {
      browserErrors.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assert.equal(await page.title(), '插件调试');
  await page.getByRole('button', { name: '田园斗地主', exact: true }).first().click();
  const iframe = page.locator('iframe[title="田园斗地主"]');
  await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  activeFrame = page.frameLocator('iframe[title="田园斗地主"]');
  await activeFrame.locator('.app-shell').waitFor({ timeout: 15_000 });
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await iframe.evaluate(element => element.hasAttribute('srcdoc')), true);
  const security = await activeFrame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.equal(security, "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none';");
  const frameSecurity = await activeFrame.locator('html').evaluate(element => ({
    origin: location.origin,
    href: location.href,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
    hasScriptSource: Boolean(document.querySelector('script[src]')),
  }));
  assert.equal(frameSecurity.href, 'about:srcdoc');
  assert.equal(frameSecurity.hasScriptSource, false, 'CLI should inline local scripts before applying strict CSP');
  await capture('workbench-open');
  record('left workbench launcher opens a real sandboxed srcdoc iframe', { frameSecurity });

  const assetResult = await activeFrame.locator('body').evaluate(async () => {
    const imageUrl = await window.dbxPlugin.readAssetUrl('assets/countryside.png');
    const image = new Image(); image.src = imageUrl; await image.decode();
    const fontUrl = await window.dbxPlugin.readAssetUrl('assets/garden-sans.woff2');
    const font = new FontFace('HostAcceptanceFont', `url(${fontUrl})`, { weight: '400' });
    await font.load(); document.fonts.add(font);
    const raw = await window.dbxPlugin.readAsset('assets/garden-sans.woff2');
    return {
      imageUrlKind: imageUrl.startsWith('blob:') ? 'blob' : imageUrl.slice(0, 12),
      image: { width: image.naturalWidth, height: image.naturalHeight },
      fontUrlKind: fontUrl.startsWith('blob:') ? 'blob' : fontUrl.slice(0, 12),
      fontLoaded: document.fonts.check('16px HostAcceptanceFont'),
      fontContentType: raw.contentType,
      fontBytes: atob(raw.dataBase64).length,
    };
  });
  assert.equal(assetResult.imageUrlKind, 'blob');
  assert.ok(assetResult.image.width > 0 && assetResult.image.height > 0);
  assert.equal(assetResult.fontUrlKind, 'blob');
  assert.equal(assetResult.fontLoaded, true);
  assert.equal(assetResult.fontContentType, 'font/woff2');
  assert.ok(assetResult.fontBytes > 1000);
  record('host readAsset and readAssetUrl return CSP-compatible image and font Blobs', assetResult);

  await activeFrame.getByRole('button', { name: /创建房间/ }).click();
  await activeFrame.getByRole('dialog').waitFor();
  const audioAfterGesture = await activeFrame.locator('body').evaluate(async () => {
    const context = new AudioContext();
    await context.resume();
    const state = context.state;
    await context.close();
    return { userGesture: navigator.userActivation.hasBeenActive, state };
  });
  assert.equal(audioAfterGesture.userGesture, true);
  assert.equal(audioAfterGesture.state, 'running');
  await activeFrame.getByRole('button', { name: '关闭弹窗' }).click();
  record('AudioContext resumes after an actual iframe user gesture', audioAfterGesture);

  const guestB = startPeer('guest-b');
  const guestC = startPeer('guest-c');
  for (const [index, peer] of [guestB, guestC].entries()) {
    const init = await peer.call('plugin/initialize', { host: { protocolVersions: [1] } });
    assert.equal(init.plugin.id, 'io.dbx.doudizhu');
    await peer.call('profile.save', { nickname: index === 0 ? 'host验收牌友乙' : 'host验收牌友丙', character: index + 1, music: 0, sound: 0, voice: 0, lowMotion: false });
  }

  const roomName = `DBX 宿主验收 ${Date.now().toString(36)}`;
  await activeFrame.getByRole('button', { name: /创建房间/ }).click();
  const dialog = activeFrame.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByLabel('房间名称').fill(roomName);
  await dialog.getByRole('button', { name: /创建房间，等好友来/ }).click();
  await delay(500);
  if (blockers.length && await activeFrame.getByRole('dialog').isVisible().catch(() => false)) {
    await capture('create-blocked-by-host-sandbox');
    throw new Error('The real create-room form submit was blocked by the official iframe sandbox. No bridge-RPC workaround was used.');
  }
  await activeFrame.locator('.waiting-panel h2').waitFor({ timeout: 15_000 });
  const hostSnapshot = await activeFrame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
  assert.equal(hostSnapshot.room.name, roomName, 'host backend must contain this run\'s uniquely named room');
  testRoomId = hostSnapshot.room.id;
  await guestB.call('room.join', { address: hostSnapshot.room.address, roomId: hostSnapshot.room.id, password: '' });
  await guestC.call('room.join', { address: hostSnapshot.room.address, roomId: hostSnapshot.room.id, password: '' });
  const selfId = hostSnapshot.selfId;
  await guestB.call('social.send', { actionId: `host-event-${Date.now()}`, targetId: selfId, kind: 'tea' });
  await activeFrame.locator('.social-toast').waitFor({ timeout: 8_000 });
  const eventToast = (await activeFrame.locator('.social-toast').innerText()).trim();
  assert.match(eventToast, /倒茶/);
  await capture('event-rpc');
  record('backend host.events RPC arrives in the srcdoc UI', { eventToast, roomId: hostSnapshot.room.id });

  await activeFrame.getByRole('button', { name: '我准备好了' }).click();
  await guestB.call('room.ready', { ready: true });
  await guestC.call('room.ready', { ready: true });
  await activeFrame.locator('.turn-indicator').waitFor({ timeout: 10_000 });
  await activeFrame.locator('.pixi-stage canvas').waitFor({ timeout: 10_000 });
  const pixi = await activeFrame.locator('.pixi-stage canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    return {
      width: canvas.width, height: canvas.height,
      clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight,
      webglContext: gl ? gl.getParameter(gl.VERSION) : null,
    };
  });
  assert.ok(pixi.width > 0 && pixi.height > 0);
  assert.ok(pixi.webglContext, 'Pixi renderer should have created a real WebGL context');
  const postReady = await activeFrame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
  assert.equal(postReady.game.phase, 'bidding');
  await capture('pixi-bidding');
  record('Pixi mounts and renders a real WebGL scene after Go backend events', { pixi, phase: postReady.game.phase });

  await page.getByRole('button', { name: '关闭 田园斗地主' }).click();
  await iframe.waitFor({ state: 'detached', timeout: 10_000 });
  const afterClose = await guestB.call('room.snapshot');
  assert.equal(afterClose.room.id, hostSnapshot.room.id, 'closing the UI must leave the in-memory room active');
  await page.getByRole('button', { name: '田园斗地主', exact: true }).first().click();
  await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  activeFrame = page.frameLocator('iframe[title="田园斗地主"]');
  await activeFrame.locator('.app-shell.in-room').waitFor({ timeout: 15_000 });
  await activeFrame.locator('.room-title').getByText(roomName, { exact: false }).waitFor({ timeout: 5_000 });
  const reopened = await activeFrame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
  assert.equal(reopened.room.id, hostSnapshot.room.id);
  assert.equal(reopened.room.name, roomName);
  assert.equal(reopened.game.phase, 'bidding');
  await capture('reopened-room');
  record('closing and reopening the workbench restores the same active room and game phase', {
    roomId: reopened.room.id, phase: reopened.game.phase,
  });

  // Clean up only the temporary room created by this test through its documented host RPC.
  await activeFrame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.leave'));
  await activeFrame.locator('.waiting-panel').waitFor({ state: 'detached', timeout: 8_000 });

  assert.deepEqual(browserErrors, [], `browser reported host/frame errors: ${browserErrors.join('; ')}`);
  const overallStatus = blockers.length ? 'failed' : 'passed';
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(),
    status: overallStatus,
    url: baseURL,
    checks: results,
    blockers,
    browserErrors,
    browserWarnings,
    hostWarnings,
    httpResources: [...httpResources.values()],
    environment: 'Official @dbx-app/plugin-cli development host in isolated headless Chromium; two temporary Go JSONL peers; no desktop DBX or existing browser session.',
  }, null, 2));
  if (blockers.length) process.exitCode = 1;
}

try {
  await main();
  console.log(`Passed ${results.length} official DBX host checks. Screenshots and report: ${outDir}`);
} catch (error) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(),
    status: 'failed',
    url: baseURL,
    error: error.stack ?? String(error),
    completedChecks: results,
    blockers,
  }, null, 2));
  throw error;
} finally {
  if (testRoomId && activeFrame) {
    await activeFrame.locator('body').evaluate(async (_body, roomId) => {
      const snapshot = await window.dbxPlugin.invoke('room.snapshot');
      if (snapshot?.room?.id === roomId) await window.dbxPlugin.invoke('room.leave');
    }, testRoomId).catch(() => undefined);
  }
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const peer of peerClients) {
    try { peer.child.stdin.end(); } catch {}
    if (peer.child.exitCode === null) peer.child.kill();
    rmSync(peer.dataDir, { recursive: true, force: true });
  }
}
