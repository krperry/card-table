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
      if (chunk.toString().includes(`listening on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes('Unable to start server') || output.includes('EADDRINUSE') || output.includes('ReferenceError')) {
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

function connectAndRegister(port, email, displayName) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out waiting for loginResult'));
    }, 10000);

    socket.on('connect', () => {
      socket.emit('registerAccount', {
        email: email,
        password: 'secret123',
        displayName: displayName,
        rememberMe: true
      });
    });

    socket.on('loginResult', (payload) => {
      if (!payload.success) {
        clearTimeout(timeout);
        socket.disconnect();
        reject(new Error(payload.message || 'Login failed'));
        return;
      }

      clearTimeout(timeout);
      resolve({ socket, payload });
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });
  });
}

test('player reconnects within grace period and keeps table seat', async () => {
  const port = 3103;
  const email = `grace-${Date.now()}@example.com`;
  const displayName = `Grace${Date.now()}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DISCONNECT_GRACE_MS: '800', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let firstSocket;
  let secondSocket;

  try {
    await waitForServer(child, port);

    const auth = await connectAndRegister(port, email, displayName);
    firstSocket = auth.socket;
    const rememberToken = auth.payload.rememberToken;
    assert.equal(typeof rememberToken, 'string');
    assert.ok(rememberToken.length > 0);

    const createdTable = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        firstSocket.disconnect();
        reject(new Error('Timed out waiting for created table state'));
      }, 5000);

      const onTableState = (payload) => {
        if (payload && payload.table && payload.table.id) {
          clearTimeout(timeout);
          firstSocket.off('tableState', onTableState);
          resolve(payload.table);
        }
      };

      firstSocket.on('tableState', onTableState);
      firstSocket.emit('createTable', { name: `Grace Table ${Date.now()}`, gameType: 'uno' });
    });

    firstSocket.disconnect();

    secondSocket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const reconnectedState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        secondSocket.disconnect();
        reject(new Error('Timed out waiting for reconnect table state'));
      }, 5000);

      let loginSucceeded = false;
      let pendingTableState = null;

      function tryResolve() {
        if (!loginSucceeded || !pendingTableState || !pendingTableState.table) {
          return;
        }

        if (pendingTableState.table.id === createdTable.id) {
          clearTimeout(timeout);
          resolve(pendingTableState.table);
        }
      }

      secondSocket.on('connect', () => {
        secondSocket.emit('resumeLogin', { token: rememberToken });
      });

      secondSocket.on('loginResult', (payload) => {
        if (!payload || !payload.success) {
          clearTimeout(timeout);
          secondSocket.disconnect();
          reject(new Error((payload && payload.message) || 'Resume login failed'));
          return;
        }

        loginSucceeded = true;
        tryResolve();
      });

      secondSocket.on('tableState', (payload) => {
        pendingTableState = payload;
        tryResolve();
      });

      secondSocket.on('connect_error', (err) => {
        clearTimeout(timeout);
        secondSocket.disconnect();
        reject(err);
      });
    });

    assert.equal(reconnectedState.id, createdTable.id);
    assert.equal(reconnectedState.players.length, 1);
    assert.equal(reconnectedState.players[0].name, displayName);
  } finally {
    if (firstSocket && firstSocket.connected) {
      firstSocket.disconnect();
    }
    if (secondSocket && secondSocket.connected) {
      secondSocket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
