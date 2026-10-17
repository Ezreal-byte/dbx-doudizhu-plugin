import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DBX_HOST_URL ?? 'http://127.0.0.1:5190';
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const installedBinary = path.join(root, 'backend', 'bin', process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const testResults = path.join(root, 'test-results');
const metadataDir = path.join(testResults, 'native-demo');
const outputVideo = path.join(testResults, 'native-demo.webm');
const metadataPath = path.join(metadataDir, 'metadata.json');
const temporaryVideoDir = mkdtempSync(path.join(tmpdir(), 'dbx-demo-video-'));
const peers = [];
const interactions = [];
const browserErrors = [];
const resourceFailures = [];
const hostWarnings = [];
let binaryDir;
let profileDir;
let context;
let browserVersion;
let page;
let frame;
let roomId;
let roomName;
let recordingEpoch;
let demoStartedAt;
let demoEndedAt;
let ffmpegPath;
let originalProfile;

mkdirSync(testResults, { recursive: true });
mkdirSync(metadataDir, { recursive: true });

function tempBinary() {
  assert.ok(existsSync(installedBinary), `Go sidecar binary not found: ${installedBinary}`);
  binaryDir = mkdtempSync(path.join(tmpdir(), 'dbx-demo-binary-'));
  const binary = path.join(binaryDir, path.basename(installedBinary));
  copyFileSync(installedBinary, binary);
  return binary;
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  if (process.env.LOCALAPPDATA) {
    const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    if (existsSync(cache)) {
      const candidates = readdirSync(cache)
        .filter(name => /^ffmpeg-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))
        .map(name => path.join(cache, name, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux'));
      const candidate = candidates.find(existsSync);
      if (candidate) return candidate;
    }
  }
  return null;
}

function startPeer(name, binary) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `dbx-demo-${name}-`));
  const child = spawn(binary, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const rpcLog = [];
  let sequence = 0;
  const peer = {
    name, child, dataDir, rpcLog,
    call(method, params = {}) {
      const id = ++sequence;
      rpcLog.push({ method, params, at: new Date().toISOString() });
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
  peers.push(peer);
  return peer;
}

async function setupPeer(peer, nickname, character) {
  const init = await peer.call('plugin/initialize', { host: { protocolVersions: [1] } });
  assert.equal(init.plugin.id, 'io.dbx.doudizhu');
  await peer.call('profile.save', { nickname, character, music: 0, sound: 0, voice: 0, lowMotion: false });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getHostSnapshot() {
  return frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.snapshot'));
}

async function waitForHostSnapshot(predicate, description, timeoutMs = 15_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await getHostSnapshot();
    if (predicate(latest)) return latest;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest?.game ?? latest)}`);
}

function cardPoint(stageBox, index, handSize) {
  const scale = stageBox.width / 1600;
  const gap = Math.min(57, 970 / Math.max(1, handSize - 1));
  const start = 800 - ((handSize - 1) * gap + 94) / 2;
  return {
    x: stageBox.x + (start + index * gap + Math.max(14, gap / 2)) * scale,
    y: stageBox.y + 817 * scale,
  };
}

async function captureCardGestures() {
  const before = await getHostSnapshot();
  const stageBox = await frame.locator('.pixi-stage').boundingBox();
  assert.ok(stageBox, 'Pixi table must have a visible stage for pointer recording');
  assert.ok(before.game.hand.length >= 4);
  const points = [0, 1, 2, 3].map(index => cardPoint(stageBox, index, before.game.hand.length));
  await page.mouse.click(points[0].x, points[0].y);
  await frame.locator('.selection-toolbar span').getByText(/已选 1 张/).waitFor({ timeout: 5_000 });
  await page.mouse.move(points[1].x, points[1].y);
  await page.mouse.down();
  for (const point of points.slice(2)) await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.up();
  await frame.locator('.selection-toolbar span').getByText(/已选 4 张/).waitFor({ timeout: 5_000 });
  interactions.push({ action: 'click one card then drag across three more', selectedCount: 4, source: 'Playwright mouse events in the recorded browser page' });
  await wait(900);
  await frame.getByRole('button', { name: '取消选牌' }).click();
}

async function clickGift(label) {
  const eventStart = Date.now();
  await frame.getByRole('button', { name: '互动' }).click();
  // Gift buttons include an emoji in their accessible name, so match by the
  // visible Chinese label while still clicking the actual host UI element.
  await frame.getByRole('button', { name: label }).click();
  await frame.locator('.social-toast').waitFor({ timeout: 5_000 });
  const message = (await frame.locator('.social-toast').innerText()).trim();
  interactions.push({ action: 'gift', label, toast: message, at: new Date().toISOString() });
  const elapsed = Date.now() - eventStart;
  if (elapsed < 3100) await wait(3100 - elapsed);
}

function processWorkingSet() {
  if (process.platform !== 'win32' || !profileDir) return { available: false, reason: 'Chromium working-set collection is Windows-only in this script.' };
  const needle = profileDir.replaceAll("'", "''");
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ pid = $p.Id; workingSetBytes = $p.WorkingSet64; type = if ($_.CommandLine -match '--type=([^ ]+)') { $matches[1] } else { 'browser' } } } } | ConvertTo-Json -Compress`;
  try {
    const raw = execFileSync(process.env.CODEX_PWSH_PATH ?? 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 7_000 }).trim();
    if (!raw) return { available: true, processes: [], totalWorkingSetBytes: 0 };
    const parsed = JSON.parse(raw);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return { available: true, processes, totalWorkingSetBytes: processes.reduce((sum, proc) => sum + Number(proc.workingSetBytes || 0), 0) };
  } catch (error) { return { available: false, reason: error.message }; }
}

async function main(binary) {
  assert.ok(existsSync(chromePath), `Chrome executable not found: ${chromePath}`);
  ffmpegPath = findFfmpeg();
  assert.ok(ffmpegPath, 'Could not find Playwright bundled ffmpeg; set FFMPEG_PATH to ffmpeg executable');

  const guestB = startPeer('guest-b', binary);
  const guestC = startPeer('guest-c', binary);
  await setupPeer(guestB, '青竹', 3);
  await setupPeer(guestC, '长安', 4);

  profileDir = mkdtempSync(path.join(tmpdir(), 'dbx-native-demo-chrome-'));
  // Default native GPU selection: no SwiftShader or GPU-disable flags.
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    recordVideo: { dir: temporaryVideoDir, size: { width: 1366, height: 768 } },
    args: ['--disable-background-timer-throttling'],
  });
  browserVersion = context.browser()?.version() ?? null;
  recordingEpoch = Date.now();
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => browserErrors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const item = { kind: 'console', message: message.text(), url: message.location().url };
    if (item.url === new URL('/favicon.ico', baseURL).href) hostWarnings.push({ kind: 'console', ...item, status: 404 });
    else browserErrors.push(item);
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const item = { status: response.status(), url: response.url() };
    if (response.url() === new URL('/favicon.ico', baseURL).href) hostWarnings.push({ kind: 'response', ...item });
    else resourceFailures.push(item);
  });
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('button', { name: '田园斗地主', exact: true }).first().click();
  const iframe = page.locator('iframe[title="田园斗地主"]');
  await iframe.waitFor({ state: 'attached', timeout: 10_000 });
  frame = page.frameLocator('iframe[title="田园斗地主"]');
  await frame.locator('.app-shell.portraits-ready').waitFor({ timeout: 20_000 });

  const initialClasses = await frame.locator('.app-shell').getAttribute('class');
  if (initialClasses?.split(/\s+/).includes('in-room')) {
    const previous = await getHostSnapshot();
    if (!String(previous?.room?.name ?? '').startsWith('原生GPU演示-')) {
      throw new Error(`Refusing to alter an unrelated active host room: ${JSON.stringify(previous?.room ?? null)}`);
    }
    roomId = previous.room.id;
    await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.leave'));
    await frame.locator('.app-shell:not(.in-room)').waitFor({ timeout: 15_000 });
    roomId = null;
  }

  await frame.locator('.preview-ribbon').waitFor({ state: 'detached', timeout: 15_000 });
  originalProfile = await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('profile.get'));
  const settingsLauncher = frame.locator('button.icon-button[aria-label="设置"]');
  if (await settingsLauncher.count()) {
    await settingsLauncher.first().click();
    const settings = frame.getByRole('dialog');
    await settings.getByRole('switch').setChecked(false);
    await settings.getByRole('button', { name: '就这样，保存偏好' }).click();
  }

  roomName = `原生GPU演示-${Date.now().toString(36)}`;
  await frame.getByRole('button', { name: /创建房间/ }).click();
  const create = frame.getByRole('dialog');
  await create.getByLabel('房间名称').fill(roomName);
  await create.getByRole('button', { name: /创建房间，等好友来/ }).click();
  await frame.locator('.waiting-panel').waitFor({ timeout: 15_000 });
  const lobby = await getHostSnapshot();
  assert.ok(lobby?.room?.id, 'room must be created by the official host UI');
  roomId = lobby.room.id;
  await guestB.call('room.join', { address: lobby.room.address, roomId: lobby.room.id, password: '' });
  await guestC.call('room.join', { address: lobby.room.address, roomId: lobby.room.id, password: '' });
  await frame.getByRole('button', { name: '我准备好了' }).click();
  await guestB.call('room.ready', { ready: true });
  await guestC.call('room.ready', { ready: true });
  const bidding = await waitForHostSnapshot(state => state?.game?.phase === 'bidding', 'host bidding phase');
  const hostSeat = bidding.players.find(player => player.id === bidding.selfId)?.seat;
  assert.equal(bidding.game.turn, hostSeat, 'host must own first bid to demonstrate the UI bid sequence');
  await frame.getByRole('button', { name: '3 分', exact: true }).click();
  await waitForHostSnapshot(state => state?.game?.phase === 'doubling', 'doubling phase');
  await frame.getByRole('button', { name: '不加倍', exact: true }).click();
  interactions.push({ action: 'host UI bids 3 points and chooses no double' });
  for (const guest of [guestB, guestC]) {
    const state = await guest.call('room.snapshot');
    if (state?.game?.phase === 'doubling') {
      await guest.call('game.action', { actionId: `native-demo-double-${Date.now()}-${guest.name}`, expectedRevision: state.revision, expectedRoundId: state.game.roundId, type: 'double', double: false });
    }
  }
  const playing = await waitForHostSnapshot(state => state?.game?.phase === 'playing', 'playing phase');
  assert.equal(playing.game.turn, hostSeat, '3-point host should lead after the auction');
  await frame.locator('.turn-indicator').waitFor({ timeout: 10_000 });
  await frame.locator('.pixi-stage canvas').waitFor({ timeout: 15_000 });
  await frame.locator('.app-shell:not(.low-motion)').waitFor();
  const canvasDetails = await frame.locator('.pixi-stage canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      width: canvas.width, height: canvas.height,
      vendor: gl?.getParameter(gl.VENDOR) ?? null,
      renderer: gl?.getParameter(gl.RENDERER) ?? null,
      unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      version: gl?.getParameter(gl.VERSION) ?? null,
    };
  });

  // Demonstration starts after setup; ffmpeg will crop this continuous 30s slice
  // from the Playwright context recording so loading/build screens are excluded.
  await frame.locator('body').evaluate(() => {
    const sample = window.__demoFrameSample = { running: true, times: [] };
    const tick = time => { if (!sample.running) return; sample.times.push(time); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  demoStartedAt = Date.now();
  await captureCardGestures();
  interactions.push({ action: 'cancel card selection' });
  // Leave the host's turn untouched: the UI selection and social gestures are
  // the only game-facing actions in this presentation clip.
  await clickGift('倒茶');
  await clickGift('送花');
  await clickGift('点赞');
  const remaining = 30_000 - (Date.now() - demoStartedAt);
  if (remaining > 0) await wait(remaining);
  demoEndedAt = Date.now();
  const animationFrameTiming = await frame.locator('body').evaluate(() => {
    const sample = window.__demoFrameSample;
    sample.running = false;
    const intervals = sample.times.slice(1).map((time, index) => time - sample.times[index]);
    const sorted = [...intervals].sort((a, b) => a - b);
    const durationMs = sample.times.at(-1) - sample.times[0];
    return {
      source: 'Observed requestAnimationFrame callback intervals in the actual plugin iframe during the same recorded interactions; includes video recorder overhead. This does not measure Pixi render/draw throughput.',
      callbacks: sample.times.length, durationMs, rafHz: intervals.length * 1000 / durationMs,
      medianIntervalMs: sorted[Math.floor(sorted.length * .5)], p95IntervalMs: sorted[Math.floor(sorted.length * .95)],
      maxIntervalMs: sorted.at(-1), intervalsOver33ms: intervals.filter(value => value > 33.4).length,
    };
  });

  assert.deepEqual(browserErrors, [], `browser errors: ${JSON.stringify(browserErrors)}`);
  assert.deepEqual(resourceFailures, [], `resource failures: ${JSON.stringify(resourceFailures)}`);
  const rendererMemory = processWorkingSet();
  const video = page.video();
  assert.ok(video, 'Playwright video recorder should be enabled');
  const rawVideoPathPromise = video.path();

  // Cleanup the room through the official host's public API while the recording
  // is still running; the final clip is trimmed to the already-finished demo span.
  const currentRoom = await getHostSnapshot().catch(() => null);
  if (currentRoom?.room?.id === roomId) await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.leave'));
  await frame.locator('body').evaluate((_body, profile) => window.dbxPlugin.invoke('profile.save', profile), originalProfile);
  originalProfile = null;
  await context.close();
  const rawVideoPath = await rawVideoPathPromise;
  const rawCopy = path.join(temporaryVideoDir, 'recording-closed.webm');
  copyFileSync(rawVideoPath, rawCopy);

  const startSeconds = Math.max(0, (demoStartedAt - recordingEpoch) / 1000);
  const clipDuration = (demoEndedAt - demoStartedAt) / 1000;
  const ffmpeg = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', rawCopy, '-ss', startSeconds.toFixed(3),
    '-t', clipDuration.toFixed(3), '-an', '-c:v', 'libvpx-vp9',
    '-deadline', 'realtime', '-cpu-used', '8', '-crf', '30', '-b:v', '0', outputVideo,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const ffmpegInfo = spawnSync(ffmpegPath, ['-hide_banner', '-i', outputVideo, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const ffmpegDiagnostic = `${ffmpegInfo.stdout ?? ''}\n${ffmpegInfo.stderr ?? ''}`;
  const durationMatch = ffmpegDiagnostic.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const clipSeconds = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
  assert.ok(existsSync(outputVideo) && statSync(outputVideo).size > 100_000, 'trimmed native demo video must be present and non-empty');
  assert.ok(clipSeconds !== null && Math.abs(clipSeconds - 30) < 0.1, `expected a 30-second demonstration clip, got ${clipSeconds}s`);

  const metadata = {
    at: new Date().toISOString(),
    status: 'recorded',
    output: outputVideo,
    outputBytes: statSync(outputVideo).size,
    videoDurationSeconds: clipSeconds,
    audioTrack: false,
    targetDurationSeconds: 30,
    sourceRecordingPath: rawVideoPath,
    sourceRecordingCopiedBeforeContextClose: false,
    sourceClipStartSeconds: Number(startSeconds.toFixed(3)),
    sourceClipDurationSeconds: Number(clipDuration.toFixed(3)),
    viewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
    browser: { executable: chromePath, version: browserVersion, headless: true, gpuFlags: ['--disable-background-timer-throttling'], forcedSwiftShader: false, forcedGpuDisable: false },
    webgl: canvasDetails,
    animationFrameTiming,
    chromiumWorkingSetBeforeCleanup: rendererMemory,
    room: { name: roomName, id: roomId, phase: playing.game.phase, characters: playing.players.map(player => ({ nickname: player.nickname, character: player.character })) },
    interactions,
    browserErrors,
    resourceFailures,
    hostWarnings,
    ffmpeg: { executable: ffmpegPath, output: ffmpeg.trim() },
    environment: `Official DBX Plugin CLI development host at ${baseURL}; isolated headless Chrome video context, default GPU selection; one local UI host and two temporary real Go JSONL peers. No production files or desktop DBX settings were changed.`,
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`Demo video: ${outputVideo} (${metadata.videoDurationSeconds ?? 'duration unavailable'}s, ${metadata.outputBytes} bytes)`);
}

let sidecarBinary;
try {
  sidecarBinary = tempBinary();
  await main(sidecarBinary);
} catch (error) {
  writeFileSync(metadataPath, JSON.stringify({
    at: new Date().toISOString(), status: 'failed', error: error.stack ?? String(error),
    output: outputVideo, sourceClipStartSeconds: demoStartedAt ? (demoStartedAt - recordingEpoch) / 1000 : null,
    sourceClipDurationSeconds: demoStartedAt && demoEndedAt ? (demoEndedAt - demoStartedAt) / 1000 : null,
    room: { name: roomName, id: roomId }, interactions, browserErrors, resourceFailures, hostWarnings,
  }, null, 2));
  throw error;
} finally {
  if (roomId && frame && context) {
    const currentRoom = await getHostSnapshot().catch(() => null);
    if (currentRoom?.room?.id === roomId) await frame.locator('body').evaluate(() => window.dbxPlugin.invoke('room.leave')).catch(() => undefined);
  }
  if (originalProfile && frame && context) {
    await frame.locator('body').evaluate((_body, profile) => window.dbxPlugin.invoke('profile.save', profile), originalProfile).catch(() => undefined);
  }
  await context?.close().catch(() => undefined);
  for (const peer of peers) {
    await peer.call('room.leave').catch(() => undefined);
    try { peer.child.stdin.end(); } catch {}
    if (peer.child.exitCode === null) peer.child.kill();
    rmSync(peer.dataDir, { recursive: true, force: true });
  }
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  if (binaryDir) rmSync(binaryDir, { recursive: true, force: true });
  rmSync(temporaryVideoDir, { recursive: true, force: true });
}
