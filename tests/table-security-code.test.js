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

test('a table code must be exactly 4 digits', async () => {
  const port = 3150;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, 'code-format-' + Date.now() + '@example.com', 'CodeFormat' + Date.now());

    host.emit('createTable', { name: 'Bad Code Table', gameType: 'uno', securityCode: '12' });
    const rejection = await waitForEvent(host, 'serverMessage', (payload) => payload && payload.type === 'error');
    assert.match(rejection.message, /4 digits/i);

    const created = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out creating table')), 5000);
      host.once('tableState', (payload) => {
        clearTimeout(timeout);
        resolve(payload.table);
      });
      host.emit('createTable', { name: 'Good Code Table', gameType: 'uno', securityCode: '1234' });
    });

    assert.equal(created.hasCode, true);
  } finally {
    if (host && host.connected) {
      host.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('joining a code-protected table requires the correct code', async () => {
  const port = 3151;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guest;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, 'code-host-' + Date.now() + '@example.com', 'CodeHost' + Date.now());
    guest = await connectAndRegister(port, 'code-guest-' + Date.now() + '@example.com', 'CodeGuest' + Date.now());

    const table = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out creating table')), 5000);
      host.once('tableState', (payload) => {
        clearTimeout(timeout);
        resolve(payload.table);
      });
      host.emit('createTable', { name: 'Locked Table', gameType: 'uno', securityCode: '4321' });
    });

    guest.emit('joinTable', { tableId: table.id });
    const noCodeRejection = await waitForEvent(guest, 'serverMessage', (payload) => payload && payload.type === 'error');
    assert.match(noCodeRejection.message, /incorrect table code/i);

    guest.emit('joinTable', { tableId: table.id, code: '0000' });
    const wrongCodeRejection = await waitForEvent(guest, 'serverMessage', (payload) => payload && payload.type === 'error');
    assert.match(wrongCodeRejection.message, /incorrect table code/i);

    guest.emit('joinTable', { tableId: table.id, code: '4321' });
    const joined = await waitForEvent(guest, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 2);
    assert.equal(joined.table.id, table.id);
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

test('the host can kick a player, who is notified and returned to the lobby; non-hosts cannot kick', async () => {
  const port = 3153;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guest;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, 'kick-host-' + Date.now() + '@example.com', 'KickHost' + Date.now());
    guest = await connectAndRegister(port, 'kick-guest-' + Date.now() + '@example.com', 'KickGuest' + Date.now());

    const table = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out creating table')), 5000);
      host.once('tableState', (payload) => {
        clearTimeout(timeout);
        resolve(payload.table);
      });
      host.emit('createTable', { name: 'Kick Table', gameType: 'uno' });
    });

    guest.emit('joinTable', { tableId: table.id });
    await waitForEvent(guest, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 2);

    guest.emit('kickPlayer', { playerId: host.id });
    const guestRejection = await waitForEvent(guest, 'serverMessage', (payload) => payload && payload.type === 'error');
    assert.match(guestRejection.message, /only the host/i);

    const guestTableStatePromise = waitForEvent(guest, 'tableState', (payload) => payload === null);
    const guestKickedPromise = waitForEvent(guest, 'kicked', () => true);
    const hostConfirmationPromise = waitForEvent(host, 'serverMessage', (payload) => payload && payload.type === 'info');

    host.emit('kickPlayer', { playerId: guest.id });

    const [guestTableState, guestKicked, hostConfirmation] = await Promise.all([
      guestTableStatePromise,
      guestKickedPromise,
      hostConfirmationPromise
    ]);

    assert.equal(guestTableState, null);
    assert.match(guestKicked.message, /removed from the table/i);
    assert.match(hostConfirmation.message, /removed from the table/i);
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
