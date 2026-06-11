/**
 * Regression tests for connection-slot leak on rejected connections
 * and for LOG_LEVEL=debug being honored.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

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

function ipv6LoopbackAvailable() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(0, '::1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function connect(port, host) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host }, () => resolve(sock));
    sock.once('error', reject);
  });
}

// Waits for data (resolves) or close-without-data (resolves with null)
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

test('a rejected connection does not leak the active-connection slot', async (t) => {
  // The "allowed" client connects via IPv6 loopback so the IPv4 loopback can
  // be blocklisted (127.0.0.x aliases are not bindable by default on macOS)
  if (!(await ipv6LoopbackAvailable())) {
    t.skip('IPv6 loopback (::1) not available');
    return;
  }

  // Fake backend so the test never touches a real BBS
  const backend = net.createServer((sock) => {
    sock.write('HELLO-BACKEND');
  });
  const backendPort = await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', () => resolve(backend.address().port));
  });

  // Blocklist IPv4 loopback; the "allowed" client will come in via ::1
  const blocklistPath = path.join(os.tmpdir(), `bbsfw-test-blocklist-${process.pid}.txt`);
  fs.writeFileSync(blocklistPath, '127.0.0.1\n');

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
      BLOCKLIST_PATH: blocklistPath,
      SSH_ENABLED: 'false',
      LOG_LEVEL: 'info',
    },
  });

  t.after(async () => {
    // SIGKILL on purpose: the graceful-shutdown handler can wait up to 10s
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    backend.close();
    fs.rmSync(blocklistPath, { force: true });
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

  // Blocked client: connects from the blocklisted IP, immediately sends bytes
  // (like a telnet client's IAC negotiation) and stays connected, leaving
  // unread data pending when the proxy rejects it.
  const blocked = await connect(listenPort, '127.0.0.1');
  blocked.on('error', () => {});
  blocked.write('\xff\xfd\x18');
  t.after(() => blocked.destroy());

  // The observable effect of the rejection is the server closing the blocked
  // socket; wait for that rather than a fixed sleep
  await new Promise((resolve) => blocked.once('close', resolve));
  // Small settle so the server-side 'close' handler (slot release) runs
  await new Promise((r) => setTimeout(r, 100));

  // Allowed client: must get the only connection slot and reach the backend
  const allowed = await connect(listenPort, '::1');
  t.after(() => allowed.destroy());
  const data = await firstData(allowed, 2000);

  assert.ok(
    data && data.toString().includes('HELLO-BACKEND'),
    'allowed connection should reach the backend; got no data — the rejected connection leaked the slot'
  );
});

test('LOG_LEVEL=debug enables debug logging', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./logger').debug('dbg-probe-message')"],
    { cwd: REPO_ROOT, env: { ...process.env, LOG_LEVEL: 'debug' }, encoding: 'utf8' }
  );
  assert.match(result.stdout, /dbg-probe-message/, 'debug message should be printed when LOG_LEVEL=debug');
});
