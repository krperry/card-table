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

test('registering and logging in works through socket auth', async () => {
  const email = `auth-test+${Date.now()}@example.com`;
  const displayName = `AuthTestUser${Date.now()}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3100', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 3100);

    const socket = io('http://127.0.0.1:3100', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const loginResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.disconnect();
        reject(new Error('Timed out waiting for login response'));
      }, 5000);

      socket.on('connect', () => {
        socket.emit('registerAccount', {
          email: email,
          password: 'secret123',
          displayName: displayName,
          rememberMe: false
        });
      });

      socket.on('loginResult', (payload) => {
        clearTimeout(timeout);
        socket.disconnect();
        resolve(payload);
      });

      socket.on('connect_error', (err) => {
        clearTimeout(timeout);
        socket.disconnect();
        reject(err);
      });
    });

    assert.equal(loginResult.success, true);
    assert.equal(loginResult.email, email);
    assert.equal(loginResult.name, displayName);
  } finally {
    child.kill('SIGTERM');
  }
});
