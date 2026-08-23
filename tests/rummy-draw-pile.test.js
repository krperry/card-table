// Integration tests for Rummy's optional "draw the entire discard pile"
// table rule (matchSettings.allowDrawEntirePile - see
// games/rummy/index.js's normalizeMatchSettings and performDrawEntirePile).
// These spawn a real server.js child process, same pattern as
// tests/rummy-game.test.js - see that file's helpers, duplicated here so
// this file has no cross-file dependency, matching this repo's existing
// per-test-file self-containment convention.

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

function createRummyTable(hostSocket, options) {
  const tableName = `Rummy Pile ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const promise = waitForEvent(hostSocket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.id && payload.table.name === tableName;
  }, 5000).then(function (payload) {
    return payload.table;
  });

  hostSocket.emit('createTable', Object.assign({ name: tableName, gameType: 'rummy' }, options || {}));
  return promise;
}

function startChild(port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '10' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('with allowDrawEntirePile off, rummyDrawDiscardPile is rejected and ordinary top-discard drawing is unaffected', async () => {
  const port = 3209;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-pile-off-p1-${Date.now()}@example.com`, `RummyPileOffP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-pile-off-p2-${Date.now()}@example.com`, `RummyPileOffP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;
    assert.equal(inGameTable.matchSettings.allowDrawEntirePile, false);

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['7C', '7D', '7H'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'draw',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['2C', '3D', '4H'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const rejectedPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawDiscardPile');
    const rejected = await rejectedPromise;
    assert.equal(rejected.success, false);
    assert.match(rejected.message, /not allowed/i);

    // Ordinary top-discard drawing still works exactly as before - only the
    // TOP card (4H) is taken, not the whole pile.
    const drawPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawDiscard');
    const draw = await drawPromise;
    assert.equal(draw.success, true);
    assert.equal(draw.source, 'discard');
    assert.equal(draw.card, '4H');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('with allowDrawEntirePile on, a player can take the whole pile into their hand, it counts as the draw for the turn, and no second draw is allowed', async () => {
  const port = 3210;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-pile-on-p1-${Date.now()}@example.com`, `RummyPileOnP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-pile-on-p2-${Date.now()}@example.com`, `RummyPileOnP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyAllowDrawEntirePile: true, rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;
    assert.equal(inGameTable.matchSettings.allowDrawEntirePile, true);

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['9S', 'TS', 'JS'];
    hands[p2Index] = ['2D', '3D', '4D'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'draw',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5H', '6H'],
        discardPile: ['2C', '3C', '4C'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const handUpdatePromise = waitForEvent(p1.socket, 'rummyHand', () => true, 5000);
    const drawPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawDiscardPile');
    const draw = await drawPromise;
    assert.equal(draw.success, true);
    assert.equal(draw.source, 'pile');
    assert.deepEqual(draw.cards, ['2C', '3C', '4C']);

    const handUpdate = await handUpdatePromise;
    assert.deepEqual(handUpdate.hand.slice().sort(), ['2C', '3C', '4C', '9S', 'TS', 'JS'].sort());

    // Taking the pile counts as this turn's draw - a second draw attempt is rejected.
    const secondDrawPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawStock');
    const secondDraw = await secondDrawPromise;
    assert.equal(secondDraw.success, false);
    assert.match(secondDraw.message, /already drawn/i);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('rummyDrawDiscardPile is rejected off-turn and outside the draw phase, even when the table option is on', async () => {
  const port = 3211;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-pile-phase-p1-${Date.now()}@example.com`, `RummyPilePhaseP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-pile-phase-p2-${Date.now()}@example.com`, `RummyPilePhaseP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyAllowDrawEntirePile: true, rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['9S', 'TS', 'JS'];
    hands[p2Index] = ['2D', '3D', '4D'];

    // p1 is mid-turn (already drew - turnPhase 'action'), so taking the
    // pile now should be rejected as "already drawn", and p2 acting when it
    // isn't their turn should be rejected as "not your turn".
    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'action',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5H', '6H'],
        discardPile: ['2C', '3C', '4C'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const wrongPhasePromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawDiscardPile');
    const wrongPhase = await wrongPhasePromise;
    assert.equal(wrongPhase.success, false);
    assert.match(wrongPhase.message, /already drawn/i);

    const offTurnPromise = waitForEvent(p2.socket, 'rummyDrawResult', () => true, 5000);
    p2.socket.emit('rummyDrawDiscardPile');
    const offTurn = await offTurnPromise;
    assert.equal(offTurn.success, false);
    assert.match(offTurn.message, /not your turn/i);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});
