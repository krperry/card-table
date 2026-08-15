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
    const socket = io('http://127.0.0.1:' + port, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out waiting for loginResult'));
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
      if (!payload || !payload.success) {
        clearTimeout(timeout);
        socket.disconnect();
        reject(new Error((payload && payload.message) || 'Login failed'));
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

function waitForEvent(socket, eventName, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error('Timed out waiting for ' + eventName));
    }, timeoutMs || 5000);

    function onEvent(payload) {
      if (predicate && !predicate(payload)) {
        return;
      }

      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      resolve(payload);
    }

    socket.on(eventName, onEvent);
  });
}

test('creating a table works through the socket API', async () => {
  const email = `table-test+${Date.now()}@example.com`;
  const displayName = `TableTest${Date.now()}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3101', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child, 3101);

    const socket = io('http://127.0.0.1:3101', {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.disconnect();
        reject(new Error('Timed out waiting for table creation response'));
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
        if (!payload.success) {
          clearTimeout(timeout);
          socket.disconnect();
          reject(new Error(payload.message || 'Login failed'));
          return;
        }

        socket.emit('createTable', { name: 'Regression Table', gameType: 'uno' });
      });

      socket.on('serverMessage', (payload) => {
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

    assert.equal(result.type, 'info');
    assert.match(result.message, /Created table/i);
  } finally {
    child.kill('SIGTERM');
  }
});

test('the last player leaving a table receives tableState null even after the original host already left', async () => {
  const port = 3113;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guest;

  try {
    await waitForServer(child, port);

    host = await connectAndRegister(port, 'host-leave-' + Date.now() + '@example.com', 'HostLeave' + Date.now());
    guest = await connectAndRegister(port, 'guest-leave-' + Date.now() + '@example.com', 'GuestLeave' + Date.now());

    const createdTable = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out creating table')), 5000);

      host.once('tableState', (payload) => {
        clearTimeout(timeout);
        resolve(payload.table);
      });

      host.emit('createTable', { name: 'Leave Table Regression', gameType: 'uno' });
    });

    guest.emit('joinTable', { tableId: createdTable.id });
    await waitForEvent(guest, 'tableState', function (payload) {
      return payload && payload.table && payload.table.id === createdTable.id && payload.table.players.length === 2;
    }, 5000);

    host.emit('leaveTable');
    await waitForEvent(guest, 'tableState', function (payload) {
      return payload && payload.table && payload.table.players.length === 1;
    }, 5000);

    const guestLeavePromise = waitForEvent(guest, 'tableState', function (payload) {
      return payload === null;
    }, 5000);

    guest.emit('leaveTable');
    const finalState = await guestLeavePromise;
    assert.equal(finalState, null);
  } finally {
    if (host && host.connected) {
      host.disconnect();
    }
    if (guest && guest.connected) {
      guest.disconnect();
    }
    child.kill('SIGTERM');
  }
});
