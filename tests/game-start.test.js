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
      if (output.includes('Unable to start server') || output.includes('EADDRINUSE')) {
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
      reject(new Error('Timed out waiting for auth connect'));
    }, 10000);

    socket.on('connect', () => {
      socket.emit('registerAccount', {
        email: email,
        password: 'secret123',
        displayName: displayName,
        rememberMe: false
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
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });
  });
}

test('starting a game changes the table state to in_game', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3102', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 3102);

    const hostSocket = await connectAndRegister(3102, `host-${Date.now()}@example.com`, `Host${Date.now()}`);
    const guestSocket = await connectAndRegister(3102, `guest-${Date.now()}@example.com`, `Guest${Date.now()}`);

    const tableIdPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        hostSocket.disconnect();
        guestSocket.disconnect();
        reject(new Error('Timed out waiting for table creation state'));
      }, 5000);

      const onTableState = (payload) => {
        if (payload && payload.table && payload.table.id) {
          clearTimeout(timeout);
          hostSocket.off('tableState', onTableState);
          resolve(payload.table.id);
        }
      };

      hostSocket.on('tableState', onTableState);
      hostSocket.emit('createTable', { name: 'Starter Table', gameType: 'uno' });
    });

    const tableId = await tableIdPromise;
    guestSocket.emit('joinTable', { tableId: tableId });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const startedState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        hostSocket.disconnect();
        guestSocket.disconnect();
        reject(new Error('Timed out waiting for game to start'));
      }, 5000);

      const onTableState = (payload) => {
        if (payload && payload.table && payload.table.status === 'in_game') {
          clearTimeout(timeout);
          hostSocket.off('tableState', onTableState);
          guestSocket.off('tableState', onTableState);
          resolve(payload.table);
        }
      };

      hostSocket.on('tableState', onTableState);
      guestSocket.on('tableState', onTableState);
      hostSocket.emit('startGame');
    });

    assert.equal(startedState.status, 'in_game');
  } finally {
    child.kill('SIGTERM');
  }
});
