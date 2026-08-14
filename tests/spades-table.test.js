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
      resolve({ socket: socket, payload: payload });
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
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs || 10000);

    function handler(payload) {
      if (predicate && !predicate(payload)) {
        return;
      }

      clearTimeout(timeout);
      socket.off(eventName, handler);
      resolve(payload);
    }

    socket.on(eventName, handler);
  });
}

function createSpadesTable(hostSocket, options) {
  const tableName = `Spades Table ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const promise = waitForEvent(hostSocket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.id && payload.table.name === tableName;
  }, 5000).then(function (payload) {
    return payload.table;
  });

  hostSocket.emit('createTable', Object.assign({ name: tableName, gameType: 'spades' }, options || {}));
  return promise;
}

function startChild(port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '20' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('a Spades table can be created and is playable (not blocked as unavailable)', async () => {
  const port = 3170;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `spades-create-${Date.now()}@example.com`, `SpadesCreate${Date.now()}`);

    const table = await createSpadesTable(host.socket);
    assert.equal(table.gameType, 'spades');
    assert.equal(table.gameName, 'Spades');
    assert.equal(table.status, 'waiting');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('exactly four players can join a Spades table; a fifth is rejected', async () => {
  const port = 3171;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const host = await connectAndRegister(port, `spades-cap-host-${Date.now()}@example.com`, `SpadesCapHost${Date.now()}`);
    sockets.push(host.socket);

    const table = await createSpadesTable(host.socket);

    let lastPlayerCount = 1;
    for (let i = 0; i < 3; i++) {
      const guest = await connectAndRegister(port, `spades-cap-guest-${i}-${Date.now()}@example.com`, `SpadesCapGuest${i}${Date.now()}`);
      sockets.push(guest.socket);
      const joined = waitForEvent(guest.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
      guest.socket.emit('joinTable', { tableId: table.id });
      const joinedPayload = await joined;
      lastPlayerCount = joinedPayload.table.players.length;
    }

    assert.equal(lastPlayerCount, 4, 'the fourth join should bring the table to exactly four players');

    const fifth = await connectAndRegister(port, `spades-cap-fifth-${Date.now()}@example.com`, `SpadesCapFifth${Date.now()}`);
    sockets.push(fifth.socket);
    const rejection = waitForEvent(fifth.socket, 'serverMessage', (payload) => payload && payload.type === 'error', 5000);
    fifth.socket.emit('joinTable', { tableId: table.id });
    const message = await rejection;
    assert.match(message.message, /full/i);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('the host can start a Spades table early; computer players fill the missing seats in fixed partnerships', async () => {
  const port = 3172;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `spades-early-${Date.now()}@example.com`, `SpadesEarly${Date.now()}`);

    const table = await createSpadesTable(host.socket);
    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.players.length, 4, 'Spades always fills to exactly four seats when started');
    const bots = inGameTable.players.filter((player) => player.isBot);
    assert.equal(bots.length, 3, 'a solo host starting early should get three computer players');
    assert.ok(inGameTable.spades, 'tableState should carry a spades-specific extra payload');
    assert.deepEqual(
      inGameTable.spades.teams.map((seats) => seats.map((seat) => seat.seatIndex)),
      [[0, 2], [1, 3]],
      'teams should be the fixed 0&2 / 1&3 partnership'
    );
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
