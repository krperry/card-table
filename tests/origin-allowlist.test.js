const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const io = require('socket.io-client');

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for server on port ${port}`));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes(`listening on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes('ReferenceError')) {
        clearTimeout(timeout);
        reject(new Error(output));
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

// Custom headers (including Origin) are only reliably delivered by
// socket.io-client 2.x over its polling transport, not the websocket
// transport - so these probes use polling, matching how the server's origin
// check (engine.io's allowRequest hook) is applied on the initial HTTP
// handshake either way.
function attemptConnect(port, originHeader) {
  return new Promise((resolve) => {
    const socket = io('http://127.0.0.1:' + port, {
      transports: ['polling'],
      forceNew: true,
      reconnection: false,
      timeout: 3000,
      extraHeaders: originHeader ? { Origin: originHeader } : undefined
    });

    const finish = (outcome) => {
      socket.disconnect();
      resolve(outcome);
    };

    socket.on('connect', () => finish('connected'));
    socket.on('connect_error', () => finish('rejected'));
    setTimeout(() => finish('timeout'), 4000);
  });
}

test('ORIGIN_ALLOWLIST restricts which pages may open a socket connection', async () => {
  const port = 3192;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ORIGIN_ALLOWLIST: 'http://allowed.example.com:80'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, port);

    const matching = await attemptConnect(port, 'http://allowed.example.com');
    const mismatched = await attemptConnect(port, 'http://evil.example.com');

    assert.equal(matching, 'connected');
    assert.equal(mismatched, 'rejected');
  } finally {
    child.kill('SIGTERM');
  }
});

test('without ORIGIN_ALLOWLIST set, any origin can still connect (default unchanged)', async () => {
  const port = 3193;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, port);

    const result = await attemptConnect(port, 'http://anything.example.com');
    assert.equal(result, 'connected');
  } finally {
    child.kill('SIGTERM');
  }
});
