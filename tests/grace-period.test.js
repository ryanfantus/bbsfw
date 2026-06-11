/**
 * Post-session grace period: after a session ends, a quick reconnect is held
 * until POST_SESSION_GRACE_MS has elapsed, with client bytes sent during the
 * hold buffered and flushed to the backend in order.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

const GRACE_MS = 1500;

// Reserve an ephemeral port by binding to 0 and releasing it
// (the config validator does not accept LISTEN_PORT=0 directly)
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function connect(port, host) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host }, () => resolve(sock));
    sock.once('error', reject);
  });
}

function firstData(sock, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    sock.once('data', (d) => {
      clearTimeout(timer);
      resolve(d);
    });
    sock.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('reconnect after a session is held for the grace period, with client bytes buffered', async (t) => {
  // Fake backend: greets each caller and records what it receives
  const backendReceived = [];
  const backend = net.createServer((sock) => {
    const chunks = [];
    backendReceived.push(chunks);
    sock.on('data', (d) => chunks.push(d));
    sock.write('HELLO-BACKEND');
  });
  const backendPort = await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', () => resolve(backend.address().port));
  });

  const listenPort = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LISTEN_PORT: String(listenPort),
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: String(backendPort),
      MAX_CONNECTIONS: '1',
      BLOCKED_COUNTRIES: '',
      RATE_LIMIT_ENABLED: 'false',
      BLOCKLIST_PATH: '',
      SSH_ENABLED: 'false',
      LOG_LEVEL: 'info',
      POST_SESSION_GRACE_MS: String(GRACE_MS),
    },
  });

  t.after(async () => {
    // SIGKILL on purpose: the graceful-shutdown handler can wait up to 10s
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    backend.close();
  });

  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server never started:\n${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('exit', (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });

  // Caller A: full session — must NOT be delayed (no prior session)
  const a = await connect(listenPort, '127.0.0.1');
  const aStart = Date.now();
  const aData = await firstData(a, 3000);
  assert.ok(aData && aData.toString().includes('HELLO-BACKEND'), 'caller A should reach the backend');
  assert.ok(Date.now() - aStart < 1000, 'caller A (no prior session) should connect without delay');
  a.destroy();

  // Give the server a moment to process A's disconnect (arms the grace period)
  await delay(150);

  // Caller B: reconnects within the grace window, sends bytes while held
  const b = await connect(listenPort, '127.0.0.1');
  const bStart = Date.now();
  b.write('AB');
  b.write('CD');
  const bData = await firstData(b, GRACE_MS + 3000);
  const bElapsed = Date.now() - bStart;
  t.after(() => b.destroy());

  assert.ok(bData && bData.toString().includes('HELLO-BACKEND'), 'caller B should eventually reach the backend');
  assert.ok(
    bElapsed >= GRACE_MS - 400,
    `caller B should be held for the remaining grace period (got backend data after ${bElapsed}ms)`
  );

  // Bytes sent during the hold must arrive at the backend, in order
  await delay(200);
  assert.strictEqual(backendReceived.length, 2, 'backend should have seen exactly two sessions');
  const bToBackend = Buffer.concat(backendReceived[1]).toString();
  assert.ok(bToBackend.startsWith('ABCD'), `bytes sent during hold should reach backend in order (got: ${JSON.stringify(bToBackend)})`);
});
