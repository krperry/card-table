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

test('repeated failed logins from the same connection get rate-limited', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '3191',
      NODE_ENV: 'test',
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: '2',
      AUTH_RATE_LIMIT_WINDOW_MS: '3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 3191);

    const socket = io('http://127.0.0.1:3191', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting to connect')), 5000);
      socket.on('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    function attemptLogin() {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for loginResult')), 5000);
        socket.once('loginResult', (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        });
        socket.emit('login', { email: 'nobody@example.com', password: 'wrong-password' });
      });
    }

    // AUTH_RATE_LIMIT_MAX_ATTEMPTS is 2, so the first two attempts should be
    // evaluated normally (and fail because the account doesn't exist) while
    // the third should be rejected by the limiter itself before any account
    // lookup happens.
    const first = await attemptLogin();
    const second = await attemptLogin();
    const third = await attemptLogin();

    assert.equal(first.success, false);
    assert.equal(first.message, 'Invalid email or password');
    assert.equal(second.success, false);
    assert.equal(second.message, 'Invalid email or password');
    assert.equal(third.success, false);
    assert.match(third.message, /too many attempts/i);

    socket.disconnect();
  } finally {
    child.kill('SIGTERM');
  }
});
