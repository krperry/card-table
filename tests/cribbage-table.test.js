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

function createCribbageTable(hostSocket, options) {
  const tableName = `Cribbage Table ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const promise = waitForEvent(hostSocket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.id && payload.table.name === tableName;
  }, 5000).then(function (payload) {
    return payload.table;
  });

  hostSocket.emit('createTable', Object.assign({ name: tableName, gameType: 'cribbage' }, options || {}));
  return promise;
}

function startChild(port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '20' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('a Cribbage table can be created with default match settings (target 121, muggins off)', async () => {
  const port = 3180;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `cribbage-create-${Date.now()}@example.com`, `CribbageCreate${Date.now()}`);

    const table = await createCribbageTable(host.socket);
    assert.equal(table.gameType, 'cribbage');
    assert.equal(table.gameName, 'Cribbage');
    assert.equal(table.status, 'waiting');
    assert.equal(table.matchSettings.targetScore, 121);
    assert.equal(table.matchSettings.mugginsEnabled, false);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a Cribbage table honors a 61-point short game with Muggins enabled, and clamps an out-of-range target', async () => {
  const port = 3181;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `cribbage-settings-${Date.now()}@example.com`, `CribbageSettings${Date.now()}`);

    const table = await createCribbageTable(host.socket, { cribbageTargetScore: 61, cribbageMuggins: true });
    assert.equal(table.matchSettings.targetScore, 61);
    assert.equal(table.matchSettings.mugginsEnabled, true);

    const outOfRange = await createCribbageTable(host.socket, { cribbageTargetScore: 9999 });
    assert.equal(outOfRange.matchSettings.targetScore, 121, 'an out-of-range target score should clamp back to the default');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('exactly two players can join a Cribbage table; a third is rejected', async () => {
  const port = 3182;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const host = await connectAndRegister(port, `cribbage-cap-host-${Date.now()}@example.com`, `CribbageCapHost${Date.now()}`);
    sockets.push(host.socket);

    const table = await createCribbageTable(host.socket);

    const guest = await connectAndRegister(port, `cribbage-cap-guest-${Date.now()}@example.com`, `CribbageCapGuest${Date.now()}`);
    sockets.push(guest.socket);
    const joined = waitForEvent(guest.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    guest.socket.emit('joinTable', { tableId: table.id });
    const joinedPayload = await joined;
    assert.equal(joinedPayload.table.players.length, 2, 'the second join should bring the table to exactly two players');

    const third = await connectAndRegister(port, `cribbage-cap-third-${Date.now()}@example.com`, `CribbageCapThird${Date.now()}`);
    sockets.push(third.socket);
    const rejection = waitForEvent(third.socket, 'serverMessage', (payload) => payload && payload.type === 'error', 5000);
    third.socket.emit('joinTable', { tableId: table.id });
    const message = await rejection;
    assert.match(message.message, /full/i);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('the host can start a Cribbage table solo; a computer player fills the missing seat', async () => {
  const port = 3183;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `cribbage-early-${Date.now()}@example.com`, `CribbageEarly${Date.now()}`);

    const table = await createCribbageTable(host.socket);
    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.players.length, 2, 'Cribbage always fills to exactly two seats when started');
    const bots = inGameTable.players.filter((player) => player.isBot);
    assert.equal(bots.length, 1, 'a solo host starting early should get one computer player');
    assert.ok(inGameTable.cribbage, 'tableState should carry a cribbage-specific extra payload');
    assert.equal(inGameTable.cribbage.phase, 'discard');
    assert.equal(inGameTable.cribbage.handNumber, 1);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
