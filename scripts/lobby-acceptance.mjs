import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Lobby-only DOM acceptance against isolated real Go sidecars. All create/join
// operations are initiated by the rendered buttons and forms in Chromium.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DBX_LOBBY_URL ?? 'http://127.0.0.1:5192';
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = path.join(root, 'test-results', 'lobby');
const installedBinary = path.join(root, 'backend', 'bin', process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const go = process.env.DBX_GO ?? 'go';
const clients = [];
const contexts = [];
const checks = [];
const browserErrors = [];
const externalRequests = [];
const knownHostWarnings = [];
let browser;
let createdRoomId;
let hostPage;

mkdirSync(outDir, { recursive: true });

function ensureIsolatedBinary() {
  const buildDir = mkdtempSync(path.join(tmpdir(), 'dbx-lobby-binary-'));
  const binary = path.join(buildDir, path.basename(installedBinary));
  if (existsSync(installedBinary)) copyFileSync(installedBinary, binary);
  else {
    const result = spawnSync(go, ['build', '-o', binary, '.'], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (result.status !== 0) {
      rmSync(buildDir, { recursive: true, force: true });
      throw new Error(`Go sidecar build failed: ${result.stdout}\n${result.stderr}`);
    }
  }
  return { binary, buildDir };
}

function startSidecar(name, binary) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `dbx-lobby-${name}-`));
  const child = spawn(binary, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const rpcLog = [];
  let nextId = 0;
  const client = {
    name, child, dataDir, rpcLog,
    call(method, params = {}) {
      const id = ++nextId;
      rpcLog.push({ method, params, at: new Date().toISOString() });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}: ${method} timed out`)); }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    onEvent(callback) { this.eventListener = callback; },
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stderr.write(`[${name}] invalid JSONL response\n`); return; }
    if (message.id === undefined) {
      if (message.method) client.eventListener?.(message);
      return;
    }
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
  clients.push(client);
  return client;
}

function assetData(requested) {
  const clean = String(requested).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error('invalid asset path');
  const uiRoot = path.resolve(root, 'ui');
  const resolved = path.resolve(uiRoot, clean);
  if (!resolved.startsWith(`${uiRoot}${path.sep}`)) throw new Error('asset escaped ui directory');
  const bytes = readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  return { contentType: types[ext] ?? 'application/octet-stream', dataBase64: bytes.toString('base64') };
}

async function attachHost(page, client) {
  await page.exposeFunction('__dbxInvoke', (method, params) => client.call(method, params ?? {}));
  await page.exposeFunction('__dbxReadAsset', requested => assetData(requested));
  await page.addInitScript(() => {
    const listeners = new Set();
    const assetUrl = async requested => {
      const file = await window.__dbxReadAsset(requested);
      const binary = atob(file.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
    };
    window.dbxPlugin = {
      ready: Promise.resolve({ protocolVersion: 1 }),
      invoke: (method, params = {}) => window.__dbxInvoke(method, params),
      onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      readAsset: async requested => window.__dbxReadAsset(requested),
      readAssetUrl: assetUrl,
      workbench: { onClose: () => () => undefined },
    };
    window.__dbxEmit = event => { for (const callback of listeners) callback(event); };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (/^(webgl|webgl2|experimental-webgl)$/i.test(String(type))) return null;
      return originalGetContext.call(this, type, ...args);
    };
  });
  client.onEvent(event => {
    void page.evaluate(value => window.__dbxEmit?.(value), event).catch(() => undefined);
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    externalRequests.push({ client: client.name, url: url.href, type: route.request().resourceType() });
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => browserErrors.push({ client: client.name, kind: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const location = message.location().url ?? '';
    if (text.includes('Failed to load resource') && location === new URL('/favicon.ico', baseURL).href) {
      knownHostWarnings.push({ client: client.name, url: location, message: text });
      return;
    }
    browserErrors.push({ client: client.name, kind: 'console', message: text, url: location });
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = response.url();
    if (url === new URL('/favicon.ico', baseURL).href) {
      knownHostWarnings.push({ client: client.name, url, message: `HTTP ${response.status()}` });
      return;
    }
    browserErrors.push({ client: client.name, kind: 'http', message: `HTTP ${response.status()}`, url });
  });
}

async function createUIClient(name, sidecar, binary) {
  const initialized = await sidecar.call('plugin/initialize', { host: { protocolVersions: [1] } });
  assert.equal(initialized.plugin.id, 'io.dbx.doudizhu');
  await sidecar.call('profile.save', { nickname: name, character: 0, music: 0, sound: 0, voice: 0, lowMotion: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await attachHost(page, sidecar);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('.app-shell.portraits-ready').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('.rooms-empty h3')?.textContent?.includes('正在打开小院'), null, { timeout: 20_000 });
  const preview = await page.locator('.preview-ribbon').count();
  assert.equal(preview, 0, `${name} must use the connected lobby, not preview mode`);
  return page;
}

function record(name, evidence = {}) {
  checks.push({ name, status: 'passed', ...evidence });
  console.log(`PASS ${name}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${String(checks.length + 1).padStart(2, '0')}-${name}.png`), fullPage: true, animations: 'disabled' });
}

async function snapshot(client) { return client.call('room.snapshot'); }

async function main(binary) {
  assert.ok(existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-webgl', '--disable-gpu', '--disable-background-timer-throttling'],
  });

  const host = startSidecar('host', binary);
  const guestB = startSidecar('mdns-guest', binary);
  const guestC = startSidecar('direct-guest', binary);
  const observer = startSidecar('full-room-observer', binary);
  hostPage = await createUIClient('田园房主', host, binary);
  const guestBPage = await createUIClient('mDNS牌友', guestB, binary);
  const guestCPage = await createUIClient('直连牌友', guestC, binary);
  const observerPage = await createUIClient('旁观牌友', observer, binary);

  const roomName = `大厅验收私密房-${Date.now().toString(36)}`;
  const password = 'lobby-test-42';
  await hostPage.getByRole('button', { name: /创建房间/ }).click();
  const createDialog = hostPage.getByRole('dialog');
  await createDialog.waitFor();
  await createDialog.getByLabel('房间名称').fill(roomName);
  await createDialog.getByRole('button', { name: /私密小院/ }).click();
  await createDialog.getByLabel('入座密码').fill(password);
  await createDialog.getByRole('button', { name: '100,000' }).click();
  await createDialog.getByRole('button', { name: /创建房间，等好友来/ }).click();
  await hostPage.locator('.waiting-panel').waitFor();
  const created = await snapshot(host);
  createdRoomId = created?.room?.id;
  assert.equal(created.room.name, roomName);
  assert.equal(created.room.initialBeans, 100000);
  assert.equal(created.room.locked, true);
  assert.equal(created.players.length, 1);
  await screenshot(hostPage, 'host-created-private-room');
  record('host creates a password room with 100,000 beans through the rendered form', {
    roomName, roomId: created.room.id, initialBeans: created.room.initialBeans, locked: created.room.locked,
  });

  await guestBPage.getByLabel('搜索房间').fill(roomName);
  await guestBPage.getByRole('button', { name: '搜索' }).click();
  const discoveredCard = guestBPage.locator('.room-card').filter({ hasText: roomName });
  await discoveredCard.waitFor({ timeout: 30_000 });
  await discoveredCard.getByRole('button', { name: /入座/ }).click();
  const joinDialog = guestBPage.getByRole('dialog');
  await joinDialog.waitFor();
  assert.match(await joinDialog.innerText(), new RegExp(roomName));
  await joinDialog.getByLabel('入座密码').fill('wrong-password');
  await joinDialog.getByRole('button', { name: /加入这张牌桌/ }).click();
  const wrongPasswordError = joinDialog.locator('.form-error');
  await wrongPasswordError.waitFor({ timeout: 15_000 });
  assert.match(await wrongPasswordError.innerText(), /密码/);
  const afterWrongPassword = await snapshot(guestB);
  const afterWrongHost = await snapshot(host);
  assert.equal(afterWrongPassword, null, 'failed password must not place the guest in a room');
  assert.equal(afterWrongHost.players.length, 1, 'failed password must not occupy the host room');
  await screenshot(guestBPage, 'mdns-wrong-password');
  record('second client discovers the named room over mDNS; wrong password is visible and leaves seat free', {
    displayedError: (await wrongPasswordError.innerText()).trim(),
    hostOccupancyAfterFailure: afterWrongHost.players.length,
    guestRoomAfterFailure: afterWrongPassword,
  });

  await joinDialog.getByLabel('入座密码').fill(password);
  await joinDialog.getByRole('button', { name: /加入这张牌桌/ }).click();
  await guestBPage.locator('.waiting-panel').waitFor({ timeout: 20_000 });
  const guestBJoined = await snapshot(guestB);
  assert.equal(guestBJoined.room.id, created.room.id);
  assert.equal(guestBJoined.players.length, 2);
  await hostPage.waitForFunction(() => [...document.querySelectorAll('.waiting-seats .waiting-seat')].filter(seat => seat.querySelector('strong')?.textContent?.trim() !== '留个好位置').length === 2, null, { timeout: 15_000 });
  await screenshot(guestBPage, 'mdns-correct-password-joined');
  record('second client enters the discovered password room through the join form', {
    roomId: guestBJoined.room.id, occupancy: guestBJoined.players.length,
  });

  await guestCPage.getByRole('button', { name: /直连好友/ }).first().click();
  const directDialog = guestCPage.getByRole('dialog');
  await directDialog.waitFor();
  await directDialog.getByLabel('房主地址').fill(created.room.address);
  await directDialog.getByLabel(/房间号/).fill(created.room.id);
  await directDialog.getByLabel(/房间密码/).fill(password);
  await directDialog.getByRole('button', { name: /找到好友，入座/ }).click();
  await guestCPage.locator('.waiting-panel').waitFor({ timeout: 20_000 });
  const guestCJoined = await snapshot(guestC);
  assert.equal(guestCJoined.room.id, created.room.id);
  assert.equal(guestCJoined.players.length, 3);
  await hostPage.getByRole('heading', { name: '牌友已到齐，准备开局' }).waitFor({ timeout: 15_000 });
  const occupiedSeats = await hostPage.locator('.waiting-seats .waiting-seat').evaluateAll(seats => seats.map(seat => ({ name: seat.querySelector('strong')?.textContent?.trim(), detail: seat.querySelector('small')?.textContent?.trim() })));
  assert.equal(occupiedSeats.filter(seat => seat.name !== '留个好位置').length, 3);
  await screenshot(hostPage, 'all-seats-full');
  record('third client joins by IP:port through the direct-connect form and host shows all seats occupied', {
    roomId: guestCJoined.room.id, occupancy: guestCJoined.players.length, occupiedSeats,
  });

  await observerPage.getByLabel('搜索房间').fill(roomName);
  await observerPage.getByRole('button', { name: '搜索' }).click();
  const fullCard = observerPage.locator('.room-card').filter({ hasText: roomName });
  await fullCard.waitFor({ timeout: 30_000 });
  await fullCard.getByText('3/3 人').waitFor();
  const fullButton = fullCard.getByRole('button', { name: '已满' });
  await fullButton.waitFor();
  assert.equal(await fullButton.isDisabled(), true);
  await screenshot(observerPage, 'full-room-card');
  record('a separate lobby client sees 3/3 occupancy and disabled full-room action', {
    cardText: (await fullCard.innerText()).replace(/\s+/g, ' ').trim(),
    joinDisabled: await fullButton.isDisabled(),
  });

  await hostPage.locator('button.room-copy').click();
  const inviteDialog = hostPage.getByRole('dialog');
  await inviteDialog.waitFor();
  const addressInputs = inviteDialog.getByRole('textbox', { name: /^房间地址 / });
  const addressCount = await addressInputs.count();
  assert.ok(addressCount > 0, 'invite dialog should list at least one reachable room address');
  const selectedAddress = addressInputs.first();
  const addressValue = await selectedAddress.inputValue();
  await selectedAddress.click();
  await selectedAddress.press('Control+A');
  const selection = await selectedAddress.evaluate(input => ({ focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, length: input.value.length }));
  assert.equal(selection.focused, true);
  assert.equal(selection.start, 0);
  assert.equal(selection.end, selection.length, 'focusing the readonly address should select it for copying');
  await screenshot(hostPage, 'invite-address-selected');
  record('host invitation dialog exposes selectable LAN addresses', { addressCount, selectedAddress: addressValue, selectionMethod: 'click then Control+A', selection });

  assert.deepEqual(externalRequests, [], `unexpected external browser requests: ${JSON.stringify(externalRequests)}`);
  assert.deepEqual(browserErrors, [], `browser errors: ${JSON.stringify(browserErrors)}`);
}

const binaryBundle = ensureIsolatedBinary();
try {
  await main(binaryBundle.binary);
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(), status: 'passed', url: baseURL, checks,
    browserErrors, externalRequests, hostWarnings: knownHostWarnings,
    sidecars: clients.map(client => ({ name: client.name, rpcMethods: client.rpcLog.map(call => call.method) })),
    environment: 'Isolated headless Chrome with WebGL disabled; four isolated Go JSONL sidecars and separate temporary data directories. Create/join interactions were browser DOM actions; RPC snapshots were read-only assertions.',
  }, null, 2));
  console.log(`Passed ${checks.length} lobby acceptance checks. Screenshots and report: ${outDir}`);
} catch (error) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(), status: 'failed', url: baseURL,
    error: error.stack ?? String(error), checks, browserErrors, externalRequests, hostWarnings: knownHostWarnings,
    sidecars: clients.map(client => ({ name: client.name, rpcMethods: client.rpcLog.map(call => call.method) })),
    environment: 'Isolated headless Chrome with WebGL disabled; real Go JSONL sidecars. Failed stages are not reported as passed.',
  }, null, 2));
  throw error;
} finally {
  if (createdRoomId) {
    const host = clients.find(client => client.name === 'host');
    await host?.call('room.leave').catch(() => undefined);
    for (const client of clients.filter(item => item.name !== 'host')) await client.call('room.leave').catch(() => undefined);
  }
  await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
  await browser?.close().catch(() => undefined);
  for (const client of clients) {
    try { client.child.stdin.end(); } catch {}
    if (client.child.exitCode === null) client.child.kill();
    rmSync(client.dataDir, { recursive: true, force: true });
  }
  rmSync(binaryBundle.buildDir, { recursive: true, force: true });
}
