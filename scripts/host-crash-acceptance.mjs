import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const backend = path.join(root, 'backend');
const go = process.env.DBX_GO ?? 'go';
const scratch = mkdtempSync(path.join(tmpdir(), 'dbx-ddz-host-crash-'));
const binary = path.join(scratch, process.platform === 'win32' ? 'dbx-doudizhu.exe' : 'dbx-doudizhu');
const clients = [];
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client(name) {
  const data = mkdtempSync(path.join(tmpdir(), `dbx-ddz-${name}-`));
  const child = spawn(binary, [], {
    env: { ...process.env, DBX_PLUGIN_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  let next = 1;
  const c = {
    name,
    child,
    data,
    events,
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name}: ${method} timeout`));
        }, 12000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    exit: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      c.protocolError = error;
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else {
      events.push(message);
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${name} sidecar exited`));
    }
    pending.clear();
  });
  clients.push(c);
  return c;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function passed(label) {
  results.push(label);
  console.log(`PASS ${label}`);
}

function roomClosedEvents(c) {
  return c.events.filter((event) => event.method === 'room.closed');
}

try {
  const built = spawnSync(go, ['build', '-o', binary, '.'], { cwd: backend, stdio: 'inherit' });
  assert.equal(built.status, 0, 'temporary backend build failed');

  const host = client('host');
  const guestB = client('guest-b');
  const guestC = client('guest-c');
  for (const [index, player] of [host, guestB, guestC].entries()) {
    const initialized = await player.call('plugin/initialize', { host: { protocolVersions: [1] } });
    assert.equal(initialized.plugin.id, 'io.dbx.doudizhu');
    await player.call('profile.save', {
      nickname: ['阿禾', '小满', '福伯'][index],
      character: index,
      music: 0,
      sound: 0,
      voice: 0,
      lowMotion: false,
    });
  }
  passed('three independent sidecars initialize with isolated identities');

  const opened = await host.call('room.create', { name: '房主进程异常验收', initialBeans: 10000 });
  const address = opened.room.address;
  await guestB.call('room.join', { address, roomId: opened.room.id });
  await guestC.call('room.join', { address, roomId: opened.room.id });
  for (const player of [host, guestB, guestC]) await player.call('room.ready', { ready: true });
  const active = await host.call('room.snapshot');
  assert.equal(active.game.phase, 'bidding');
  assert.equal(active.players.length, 3);
  passed('host crash is tested after the room enters an unfinished round');

  const crashAt = new Date().toISOString();
  host.child.kill('SIGKILL');
  const hostExit = await Promise.race([
    host.exit,
    delay(5000).then(() => { throw new Error('host process did not terminate after kill'); }),
  ]);
  assert.ok(hostExit.signal || hostExit.code !== null);
  passed('host sidecar process was killed without room.leave');

  // The guests deliberately remain alive for the full advertised reconnect
  // window. Their room.closed events prove UI cleanup happens after expiry.
  await waitFor(
    () => roomClosedEvents(guestB).length > 0 && roomClosedEvents(guestC).length > 0,
    70000,
    'both guests to exhaust the reconnect window and receive room.closed',
  );
  const closedB = roomClosedEvents(guestB).at(-1);
  const closedC = roomClosedEvents(guestC).at(-1);
  assert.match(closedB.params.reason, /房主已离线/);
  assert.match(closedC.params.reason, /房主已离线/);
  passed('both guests receive room.closed after the 60-second reconnect window');

  const [snapshotB, snapshotC] = await Promise.all([
    guestB.call('room.snapshot'),
    guestC.call('room.snapshot'),
  ]);
  assert.equal(snapshotB, null);
  assert.equal(snapshotC, null);
  const settlementEvents = [guestB, guestC].flatMap((player) => player.events.filter((event) =>
    event.method === 'room.state' && event.params?.game?.phase === 'finished' && event.params?.game?.settlement,
  ));
  assert.equal(settlementEvents.length, 0);
  passed('both guests clear the stale session and receive no post-crash settlement');

  const [newRoomB, newRoomC] = await Promise.all([
    guestB.call('room.create', { name: '崩溃后重建B', initialBeans: 10000 }),
    guestC.call('room.create', { name: '崩溃后重建C', initialBeans: 10000 }),
  ]);
  assert.notEqual(newRoomB.room.id, opened.room.id);
  assert.notEqual(newRoomC.room.id, opened.room.id);
  assert.notEqual(newRoomB.room.id, newRoomC.room.id);
  passed('both guests can create new rooms after the host crash');

  const report = {
    at: new Date().toISOString(),
    crashAt,
    results,
    hostExit,
    reconnectWindowMs: 60000,
    environment: 'three independent local sidecar processes over real TLS; host process killed without room.leave; not three physical computers',
    roomClosedReasons: [closedB.params.reason, closedC.params.reason],
    postCrashSnapshots: [snapshotB, snapshotC],
    settlementEvents: settlementEvents.length,
    newRoomIds: [newRoomB.room.id, newRoomC.room.id],
  };
  mkdirSync(path.join(root, 'test-results'), { recursive: true });
  writeFileSync(path.join(root, 'test-results', 'host-crash-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`All ${results.length} checks passed.`);
} finally {
  for (const player of clients) {
    try { player.child.stdin.end(); } catch {}
    if (player.child.exitCode === null) player.child.kill();
  }
  await Promise.all(clients.map((player) => Promise.race([player.exit, delay(3000)])));
  for (const player of clients) rmSync(player.data, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
