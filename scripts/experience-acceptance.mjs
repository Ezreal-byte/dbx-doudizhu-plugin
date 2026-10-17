import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

// Production plugin in the official CLI's opaque srcdoc sandbox. Instrumentation
// observes browser APIs before startup and forwards every call without changing
// application state, decoded samples, sound routing, or the production bundle.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DBX_HOST_URL ?? 'http://127.0.0.1:5196';
const chromePath = process.env.DBX_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const binary = path.join(root, 'backend/bin/dbx-doudizhu.exe');
const out = path.join(root, 'test-results/v02-experience');
mkdirSync(out, {recursive: true});
const checks = [], peers = [], traces = [], browserErrors = [], externalRequests = [], hostWarnings = [], httpFailures = [];
let browser, context, page, frame, testRoomId, originalProfile, originalMusic, preferencesCaptured = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, details = {}) => {checks.push({name, status: 'passed', ...details}); console.log(`PASS ${name}`);};
const report = (status, error) => writeFileSync(path.join(out, 'report.json'), JSON.stringify({
  at: new Date().toISOString(), status, error: error?.stack, url: baseURL, checks,
  browserErrors, externalRequests, hostWarnings, httpFailures, traces,
  environment: 'Official DBX Plugin CLI srcdoc sandbox; fresh headless Chrome profile with physical speaker output muted; real decoded WebAudio buffers and starts; two independent Go JSONL peers; production assets and audio. No installed DBX or user browser interaction.',
}, null, 2));

function instrumentAudio() {
  if (window.__experience) return;
  const existingBridge = window.dbxPlugin;
  const trace = window.__experience = {startedAt: Date.now(), assets: [], decodes: [], starts: [], gains: [], fallbackSpeech: [], rpc: []};
  const fingerprints = new Map(), buffers = new WeakMap(), gains = new WeakMap(), destinations = new WeakMap();
  let gainId = 0;
  function fingerprint(bytes) {
    const data = new Uint8Array(bytes);
    return `${data.length}:${Array.from(data.slice(0, 24))}:${Array.from(data.slice(-24))}`;
  }
  function describe(buffer) {
    if (!buffer) return null;
    const data = buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length / 50000));
    let squared = 0, peak = 0, samples = 0;
    for (let i = 0; i < data.length; i += step) {squared += data[i] ** 2; peak = Math.max(peak, Math.abs(data[i])); samples++;}
    return {duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, rms: Math.sqrt(squared / Math.max(1, samples)), peak};
  }
  const originalCreateGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function(...args) {
    const node = originalCreateGain.apply(this, args);
    const id = ++gainId;
    gains.set(node, id); gains.set(node.gain, id);
    return node;
  };
  const originalConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...args) {destinations.set(this, destination); return originalConnect.call(this, destination, ...args);};
  const originalTarget = AudioParam.prototype.setTargetAtTime;
  AudioParam.prototype.setTargetAtTime = function(value, time, constant) {
    if (gains.has(this)) trace.gains.push({at: Date.now(), gainId: gains.get(this), value, time, constant});
    return originalTarget.call(this, value, time, constant);
  };
  const originalDecode = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function(bytes, ...args) {
    const key = fingerprint(bytes), asset = fingerprints.get(key) ?? null;
    const result = originalDecode.call(this, bytes, ...args);
    if (result?.then) result.then(buffer => {
      const detail = {at: Date.now(), asset, fingerprint: key, ...describe(buffer)};
      buffers.set(buffer, detail); trace.decodes.push(detail);
    }).catch(() => undefined);
    return result;
  };
  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) {
    trace.starts.push({at: Date.now(), asset: buffers.get(this.buffer)?.asset ?? null, loop: this.loop, gainId: gains.get(destinations.get(this)) ?? null, ...describe(this.buffer)});
    return originalStart.apply(this, args);
  };
  if (window.speechSynthesis) {
    const originalSpeak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = utterance => {trace.fallbackSpeech.push({at: Date.now(), text: utterance.text}); return originalSpeak(utterance);};
  }
  let bridge;
  Object.defineProperty(window, 'dbxPlugin', {configurable: true, get: () => bridge, set(value) {
    bridge = value;
    if (!value || value.__experienceWrapped) return;
    const originalRead = value.readAsset.bind(value), originalInvoke = value.invoke.bind(value);
    const readAsset = async path => {
      const result = await originalRead(path);
      if (/\.(ogg|wav|mp3|m4a)$/i.test(path)) {
        const decoded = atob(result.dataBase64), bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        fingerprints.set(fingerprint(bytes.buffer), path);
        trace.assets.push({at: Date.now(), path, bytes: bytes.length, contentType: result.contentType});
      }
      return result;
    };
    const invoke = async (method, params, ...args) => {
      const item = {at: Date.now(), method, action: params?.type, keys: Object.keys(params ?? {}), success: false};
      trace.rpc.push(item);
      try {const result = await originalInvoke(method, params, ...args); item.success = true; return result;}
      catch (error) {item.error = error?.message ?? String(error); throw error;}
    };
    // The official host deliberately freezes its SDK object. Keep it frozen and
    // put observation wrappers on a separate object inheriting the original API.
    bridge = Object.create(value);
    Object.defineProperties(bridge, {__experienceWrapped: {value: true}, readAsset: {value: readAsset}, invoke: {value: invoke}});
  }});
  // Chromium can execute a srcdoc host bootstrap before an init script. Do not
  // erase a bridge that the host has already installed in that document.
  if (existingBridge) window.dbxPlugin = existingBridge;
}

function peer(name, character) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'dbx-v02-experience-'));
  const child = spawn(binary, [], {env: {...process.env, DBX_PLUGIN_DATA_DIR: dataDir}, stdio: ['pipe', 'pipe', 'pipe']});
  const pending = new Map(), events = [];
  let seq = 0;
  const client = {name, character, child, dataDir, events, call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {pending.delete(id); reject(Error(`${name}: ${method} timeout`));}, 15000);
      pending.set(id, {resolve, reject, timeout});
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
    });
  }};
  readline.createInterface({input: child.stdout}).on('line', line => {
    let message; try {message = JSON.parse(line);} catch {return;}
    if (message.id === undefined) {events.push(message); return;}
    const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timeout); pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  });
  child.on('exit', code => {for (const request of pending.values()) {clearTimeout(request.timeout); request.reject(Error(`${name} exited ${code}`));} pending.clear();});
  peers.push(client);
  return client;
}

async function invoke(method, params = {}) {return frame.locator('body').evaluate((_body, {method, params}) => window.dbxPlugin.invoke(method, params), {method, params});}
async function trace() {return frame.locator('body').evaluate(() => window.__experience);}
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {const value = await predicate(); if (value) return value; await wait(100);}
  throw Error(`Timed out: ${message}`);
}
async function capture(name) {await page.screenshot({path: path.join(out, `${name}.png`), fullPage: true});}
async function openWorkbench() {
  await page.getByRole('button', {name: '田园斗地主', exact: true}).first().click();
  frame = page.frameLocator('iframe[title="田园斗地主"]');
  await frame.locator('.app-shell').waitFor({timeout: 20000});
  await until(async () => frame.locator('body').evaluate(() => Boolean(window.__experience && window.dbxPlugin?.__experienceWrapped)), 'test instrumentation installed');
}
async function reopenWorkbench(label) {
  traces.push({label, ...(await trace())});
  await page.getByRole('button', {name: '关闭 田园斗地主'}).click();
  await page.locator('iframe[title="田园斗地主"]').waitFor({state: 'detached'});
  await openWorkbench();
}
async function settings() {
  const inRoom = await frame.locator('.app-shell.in-room').count();
  await frame.getByRole('button', {name: inRoom ? '牌桌设置' : '设置', exact: true}).click();
  await frame.locator('.character-picker').waitFor();
}
async function audible(paths, since) {
  return until(async () => (await trace()).starts.find(source => source.at >= since && paths.includes(source.asset) && !source.loop && source.duration > .15 && source.rms > .002), `audible buffer from ${paths.join(', ')}`);
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'src/game/voice-manifest.json'), 'utf8'));
  assert.equal(Object.keys(manifest.cues).length, 5, 'Neural voice generation must finish before this acceptance run');
  for (let role = 0; role < 5; role++) assert.ok(manifest.cues[role]?.preview?.length, `Missing role ${role} preview`);
  const voicePaths = (role, kind) => manifest.cues[role][kind].map(clip => clip.file);
  assert.ok(existsSync(binary));
  browser = await chromium.launch({executablePath: chromePath, headless: true, args: ['--disable-background-timer-throttling', '--mute-audio']});
  context = await browser.newContext({viewport: {width: 1920, height: 1200}, deviceScaleFactor: 1});
  await context.addInitScript(instrumentAudio);
  const allowed = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== allowed) {externalRequests.push(url); return route.abort();}
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.location().url === new URL('/favicon.ico', baseURL).href) hostWarnings.push(message.text());
    else browserErrors.push(`${message.text()} [${message.location().url || 'unknown URL'}]`);
  });
  page.on('response', async response => {
    if (response.status() < 400) return;
    const item = {at: Date.now(), status: response.status(), url: response.url(), method: response.request().method(), body: ''};
    httpFailures.push(item);
    try {item.body = (await response.text()).slice(0, 2000);} catch {}
  });
  await page.goto(baseURL, {waitUntil: 'domcontentloaded', timeout: 20000});
  await openWorkbench();
  const iframe = page.locator('iframe[title="田园斗地主"]');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  const security = await frame.locator('body').evaluate(() => ({url: location.href, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content}));
  assert.equal(security.url, 'about:srcdoc'); assert.ok(security.csp.includes("connect-src 'none'"));
  assert.equal(await invoke('room.snapshot'), null, 'Do not modify another run\'s existing room');
  originalProfile = await invoke('profile.get');
  originalMusic = await invoke('music.get');
  preferencesCaptured = true;
  record('official opaque srcdoc sandbox and strict CSP', security);

  const roleNames = ['阿禾', '小满', '福伯', '青竹', '长安'];
  for (let character = 0; character < 5; character++) {
    await settings();
    assert.equal(await frame.locator('.character-picker button').count(), 5);
    await frame.locator('.sound-settings input').nth(0).focus(); await page.keyboard.press('End');
    await frame.locator('.sound-settings input').nth(2).focus(); await page.keyboard.press('End');
    const since = Date.now();
    await frame.locator('.character-picker button').nth(character).click();
    const sound = await audible(voicePaths(character, 'preview'), since);
    const music = await until(async () => (await trace()).starts.find(source => source.asset === 'assets/audio/garden-table.ogg' && source.loop), 'default music loop starts');
    const currentTrace = await trace();
    assert.ok(currentTrace.assets.some(asset => voicePaths(character, 'preview').includes(asset.path)), 'Preview must read packaged voice asset through host API');
    assert.deepEqual(currentTrace.fallbackSpeech, [], 'Neural preview must not fall back to the system voice');
    assert.ok(music?.duration >= 1 && music?.rms > .002, 'Default music must start a non-silent loop');
    const musicValues = currentTrace.gains.filter(gain => gain.gainId === music.gainId).map(gain => gain.value);
    const duringVoice = currentTrace.gains.filter(gain => gain.gainId === music.gainId && gain.at >= since);
    assert.ok(musicValues.some(value => value > .6) && duringVoice.some(gain => Math.abs(gain.value - .65 * .23) < .001), 'Voice must duck the configured music gain to 23%');
    await wait(Math.min(6000, sound.duration * 1000 + 100));
    if (character === 4) await capture('01-five-roles-settings');
    await frame.getByRole('button', {name: '就这样，保存偏好', exact: true}).click();
    await frame.getByRole('dialog').waitFor({state: 'detached'});
    assert.equal((await invoke('profile.get')).character, character);
    await reopenWorkbench(`role-${character}`);
    assert.equal((await invoke('profile.get')).character, character);
    await settings();
    assert.equal(await frame.locator('.character-picker button').nth(character).getAttribute('aria-pressed'), 'true');
    await frame.getByRole('button', {name: '关闭弹窗'}).click();
    record(`role ${character} ${roleNames[character]} packaged voice, ducking, save and reopen`, {character, sound, music});
  }

  await settings();
  const musicBytes = readFileSync(path.join(root, 'public/assets/audio/garden-table.ogg'));
  const musicName = '体验验收-本地音乐.ogg';
  await frame.locator('.music-import input').setInputFiles({name: musicName, mimeType: 'audio/ogg', buffer: musicBytes});
  await until(async () => (await frame.locator('.music-library small').innerText()) === musicName, 'music import visible');
  const savedMusic = await invoke('music.get');
  assert.equal(savedMusic.name, musicName); assert.equal(savedMusic.dataBase64, musicBytes.toString('base64'));
  await capture('02-imported-music');
  await reopenWorkbench('imported-music');
  await settings();
  await until(async () => (await frame.locator('.music-library small').innerText()) === musicName, 'music preference restored after workbench recreation');
  const restored = await invoke('music.get'); assert.equal(restored.name, musicName);
  const restoredLoop = await until(async () => (await trace()).starts.find(source => source.loop && source.duration >= 1 && source.rms > .002), 'restored music starts playback');
  assert.equal(restoredLoop.asset, null, 'A restored custom track should decode from saved music data, not the bundled asset');
  await frame.getByRole('button', {name: '恢复原声', exact: true}).click();
  await until(async () => (await invoke('music.get')) === null, 'persistent custom music cleared');
  await until(async () => (await frame.locator('.music-library small').innerText()).includes('田园牌局'), 'original soundtrack restored');
  await frame.getByRole('button', {name: '关闭弹窗'}).click();
  record('actual file input imports OGG, persists across workbench recreation, plays and restores default', {musicName, bytes: musicBytes.length, restoredLoop});

  const guests = [peer('青竹验收', 3), peer('小满验收', 1)];
  for (const guest of guests) {
    await guest.call('plugin/initialize', {host: {protocolVersions: [1]}});
    guest.profile = await guest.call('profile.save', {nickname: guest.name, character: guest.character, music: 0, sound: 0, voice: 0, lowMotion: false});
  }
  const roomName = `体验验收 ${Date.now().toString(36)}`;
  await frame.getByRole('button', {name: /创建房间/}).click();
  await frame.getByLabel('房间名称').fill(roomName);
  await frame.getByRole('button', {name: /创建房间，等好友来/}).click();
  await frame.locator('.waiting-panel').waitFor();
  const room = await invoke('room.snapshot'); testRoomId = room.room.id;
  for (const guest of guests) await guest.call('room.join', {address: room.room.address, roomId: room.room.id, password: ''});
  await until(async () => (await invoke('room.snapshot')).players.length === 3, 'three independent Go processes joined');
  for (const client of [null, ...guests]) {
    const state = client ? await client.call('room.snapshot') : await invoke('room.snapshot');
    assert.deepEqual(state.players.map(player => player.character).sort(), [1, 3, 4]);
    assert.equal(state.room.protocol, 2);
  }
  await frame.locator('.opponent-nameplate.right button').click();
  const hostGiftAt = Date.now();
  await frame.getByRole('button', {name: /送花/}).click();
  await audible(voicePaths(4, 'flower'), hostGiftAt);
  await frame.locator('.player-speech.self').filter({hasText: '送花送给你'}).waitFor();
  await until(() => guests.every(guest => guest.events.some(event => event.method === 'social.event' && event.params.fromId === room.selfId)), 'social event delivered to both real peers');
  const giftA = guests[0].events.find(event => event.method === 'social.event' && event.params.fromId === room.selfId).params;
  const giftB = guests[1].events.find(event => event.method === 'social.event' && event.params.fromId === room.selfId).params;
  assert.equal(giftA.id, giftB.id); assert.equal(giftA.targetId, giftB.targetId);
  const teaId = `experience-tea-${Date.now()}`, teaAt = Date.now();
  await guests[0].call('social.send', {actionId: teaId, targetId: room.selfId, kind: 'tea'});
  await frame.locator('.player-speech.right').filter({hasText: '倒茶送给你'}).waitFor();
  const teaVoice = await audible(voicePaths(3, 'tea'), teaAt);
  await capture('03-new-characters-social');
  await wait(teaVoice.duration * 1000 + 100);
  const beforeDuplicate = (await trace()).starts.filter(source => voicePaths(3, 'tea').includes(source.asset)).length;
  await guests[0].call('social.send', {actionId: teaId, targetId: room.selfId, kind: 'tea'});
  await wait(500);
  assert.equal((await trace()).starts.filter(source => voicePaths(3, 'tea').includes(source.asset)).length, beforeDuplicate);
  record('new characters join real LAN room; UI gift target/id agree at both peers; character tea voice and bubble play once', {roomId: testRoomId, characters: [4, 3, 1], gift: giftA, teaVoice});

  await frame.getByRole('button', {name: '我准备好了', exact: true}).click();
  for (const guest of guests) await guest.call('room.ready', {ready: true});
  await frame.locator('.turn-indicator').waitFor();
  let state = await invoke('room.snapshot');
  while (state.game.phase === 'bidding' && state.game.turn !== 0) {
    const actor = guests.find(guest => state.players.find(player => player.id === guest.profile.id)?.seat === state.game.turn);
    assert.ok(actor); await actor.call('game.action', {actionId: `bid-${Date.now()}`, type: 'bid', score: 0}); state = await invoke('room.snapshot');
  }
  const bidAt = Date.now();
  await frame.getByRole('button', {name: '3 分', exact: true}).click();
  const bidVoice = await audible(voicePaths(4, 'bid-3'), bidAt);
  // Deliberately overlap three independent decisions. Serializing them would
  // conceal stale-global-revision rejection of a legitimate parallel choice.
  await frame.getByRole('button', {name: /^加倍/}).click();
  for (const guest of guests) await guest.call('game.action', {actionId: `double-${guest.character}-${Date.now()}`, type: 'double', double: false});
  await until(async () => (await invoke('room.snapshot')).game.phase === 'playing', 'real playing phase');
  assert.equal((await invoke('room.snapshot')).game.doubles[0], 2, 'The host\'s actual UI 加倍 choice must survive simultaneous decisions, not become an automatic no-double after timeout');
  record('three concurrent doubling decisions preserve the actual UI choice', {selfDouble: 2});
  await frame.getByRole('button', {name: '提示', exact: true}).click();
  await until(async () => (await frame.locator('.selection-toolbar').innerText()).includes('已选'), 'hint selects cards');
  await frame.getByRole('button', {name: /^出牌/}).click();
  for (let turn = 0; turn < 2; turn++) {
    state = await invoke('room.snapshot');
    assert.equal(state.game.phase, 'playing');
    const actor = guests.find(guest => state.players.find(player => player.id === guest.profile.id)?.seat === state.game.turn);
    assert.ok(actor, 'opponent follows host lead');
    const passAt = Date.now();
    await actor.call('game.action', {actionId: `pass-${turn}-${Date.now()}`, type: 'pass'});
    const passVoice = await audible(voicePaths(actor.character, 'pass'), passAt);
    record(`real pass ${turn + 1} produces packaged character speech`, {character: actor.character, passVoice});
  }
  state = await invoke('room.snapshot'); assert.equal(state.game.passes, 0);
  assert.equal(state.game.history.filter(play => play.kind === 'pass').length, 2);
  await capture('04-playing-after-two-passes');
  record('actual three-point bidding and second pass after trick reset have voiced UI feedback', {bidVoice, history: state.game.history});
  traces.push({label: 'final-game', ...(await trace())});
  assert.deepEqual(traces.flatMap(item => item.fallbackSpeech), [], 'All tested voice cues must use packaged neural recordings');
  assert.deepEqual(externalRequests, [], 'Runtime must not attempt external network requests');
  assert.deepEqual(browserErrors, [], 'Strict CSP and production UI must stay free of browser errors');
  record('offline runtime and zero system-voice fallbacks', {externalRequests: 0, fallbackSpeech: 0});
  report('passed');
}

try {await main(); console.log(`Passed ${checks.length} official host experience checks.`);}
catch (error) {if (frame) {try {traces.push({label: 'failure', ...(await trace())});} catch {}} report('failed', error); await capture('failure').catch(() => undefined); throw error;}
finally {
  if (frame) {
    if (testRoomId) await frame.locator('body').evaluate(async (_body, id) => {const snapshot = await window.dbxPlugin.invoke('room.snapshot'); if (snapshot?.room?.id === id) await window.dbxPlugin.invoke('room.leave');}, testRoomId).catch(() => undefined);
    if (preferencesCaptured) {
      await invoke('music.set', originalMusic ?? {clear: true}).catch(() => undefined);
      await invoke('profile.save', originalProfile).catch(() => undefined);
    }
  }
  await context?.close().catch(() => undefined); await browser?.close().catch(() => undefined);
  for (const client of peers) {try {client.child.stdin.end();} catch {} if (client.child.exitCode === null) client.child.kill(); rmSync(client.dataDir, {recursive: true, force: true});}
}
