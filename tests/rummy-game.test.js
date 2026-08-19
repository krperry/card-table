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
  const tableName = `Rummy Play ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
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

test('starting a Rummy table with a single human seats exactly one computer player', async () => {
  const port = 3200;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `rummy-solo-${Date.now()}@example.com`, `RummySolo${Date.now()}`);

    await createRummyTable(host.socket);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.players.length, 2, 'a solo start should top up to exactly two players');
    const bots = inGameTable.players.filter((player) => player.isBot);
    assert.equal(bots.length, 1, 'exactly one computer player should be added');
    assert.equal(inGameTable.players.filter((player) => !player.isBot).length, 1);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a full draw -> meld -> lay-off -> discard turn cycle works over the socket API, and illegal actions are rejected with a clear reason', async () => {
  const port = 3201;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-cycle-p1-${Date.now()}@example.com`, `RummyCycleP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-cycle-p2-${Date.now()}@example.com`, `RummyCycleP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket);
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['7C', '7D', '7H', '8S', '9S'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'draw',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['KH'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await turnStatePromise;

    // Melding before drawing is rejected.
    const meldBeforeDrawPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['7C', '7D', '7H'] });
    const meldBeforeDraw = await meldBeforeDrawPromise;
    assert.equal(meldBeforeDraw.success, false);
    assert.match(meldBeforeDraw.message, /draw/i);

    // p1 draws from the stock.
    const drawResultPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawStock');
    const drawResult = await drawResultPromise;
    assert.equal(drawResult.success, true);
    assert.equal(drawResult.source, 'stock');
    assert.equal(drawResult.card, '6D');

    // p2 acting out of turn is rejected.
    const outOfTurnPromise = waitForEvent(p2.socket, 'rummyMeldResult', () => true, 5000);
    p2.socket.emit('rummyMeldCards', { cards: ['2C', '3C', '4C'] });
    const outOfTurn = await outOfTurnPromise;
    assert.equal(outOfTurn.success, false);
    assert.match(outOfTurn.message, /not your turn/i);

    // p1 melds the set of sevens.
    const meldResultPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['7C', '7D', '7H'] });
    const meldResult = await meldResultPromise;
    assert.equal(meldResult.success, true);

    // Laying off onto a player with no melds is rejected with a clear reason.
    const badLayoffPromise = waitForEvent(p1.socket, 'rummyLayOffResult', () => true, 5000);
    p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p2Index, cards: ['8S'] });
    const badLayoff = await badLayoffPromise;
    assert.equal(badLayoff.success, false);
    assert.match(badLayoff.message, /cannot be laid off/i);

    // p1 discards to end the turn.
    const discardResultPromise = waitForEvent(p1.socket, 'rummyDiscardResult', () => true, 5000);
    const p2TurnPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p2.socket.id && payload.turnPhase === 'draw', 5000);
    p1.socket.emit('rummyDiscardCard', { card: '8S' });
    const discardResult = await discardResultPromise;
    assert.equal(discardResult.success, true);
    await p2TurnPromise;

    // p2 draws the card p1 just discarded off the top of the discard pile.
    const p2DrawPromise = waitForEvent(p2.socket, 'rummyDrawResult', () => true, 5000);
    p2.socket.emit('rummyDrawDiscard');
    const p2Draw = await p2DrawPromise;
    assert.equal(p2Draw.success, true);
    assert.equal(p2Draw.source, 'discard');
    assert.equal(p2Draw.card, '8S');

    // Drawing again this turn is rejected.
    const secondDrawPromise = waitForEvent(p2.socket, 'rummyDrawResult', () => true, 5000);
    p2.socket.emit('rummyDrawStock');
    const secondDraw = await secondDrawPromise;
    assert.equal(secondDraw.success, false);
    assert.match(secondDraw.message, /already drawn/i);

    // p2 discards to end their turn, handing it back to p1.
    const p2DiscardPromise = waitForEvent(p2.socket, 'rummyDiscardResult', () => true, 5000);
    const backToP1Promise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p1.socket.id && payload.turnPhase === 'draw', 5000);
    p2.socket.emit('rummyDiscardCard', { card: '2C' });
    const p2Discard = await p2DiscardPromise;
    assert.equal(p2Discard.success, true);
    await backToP1Promise;
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('going out scores the hand and gates the next hand on pendingHandAcks, which a bot never blocks', async () => {
  const port = 3202;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `rummy-goout-${Date.now()}@example.com`, `RummyGoOut${Date.now()}`);

    await createRummyTable(host.socket);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const hostIndex = inGameTable.players.findIndex((player) => player.id === host.socket.id);
    const botIndex = 1 - hostIndex;

    const hands = [[], []];
    hands[hostIndex] = ['7C', '7D', '7H', '8S'];
    hands[botIndex] = ['KC', 'QD', '2H'];

    const readyPromise = waitForEvent(host.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === host.socket.id, 5000);
    host.socket.emit('__testSetTableState', {
      tableId: inGameTable.id,
      game: {
        phase: 'playing',
        turnIndex: hostIndex,
        turnPhase: 'action',
        dealerIndex: botIndex,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['9H'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const meldPromise = waitForEvent(host.socket, 'rummyMeldResult', () => true, 5000);
    host.socket.emit('rummyMeldCards', { cards: ['7C', '7D', '7H'] });
    assert.equal((await meldPromise).success, true);

    const summaryPromise = waitForEvent(host.socket, 'rummyHandSummary', () => true, 5000);
    host.socket.emit('rummyDiscardCard', { card: '8S' });
    const summary = await summaryPromise;

    assert.equal(summary.handNumber, 1);
    assert.equal(summary.wentOutPlayerName, host.payload.name);
    const botRow = summary.rows.find((row) => row.name !== host.payload.name);
    assert.equal(botRow.deadwood, 10 + 10 + 2, 'KC + QD + 2H deadwood');
    assert.equal(botRow.pointsAwarded, 0);
    const hostRow = summary.rows.find((row) => row.name === host.payload.name);
    assert.equal(hostRow.pointsAwarded, 10 + 10 + 2);

    // Only the human needs to ack - the bot is never part of pendingHandAcks,
    // so a single ack from the host should be enough to deal hand 2.
    const nextHandPromise = waitForEvent(host.socket, 'rummyTurnState', (payload) => payload.handNumber === 2, 8000);
    host.socket.emit('rummyAckHandSummary');
    const nextHand = await nextHandPromise;
    assert.equal(nextHand.handNumber, 2);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('reconnecting mid-hand-summary migrates the pending ack off the old socket id, instead of stalling the next hand forever', async () => {
  const port = 3203;
  const child = startChild(port);
  const sockets = [];
  let secondSocket;

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-reconnect-p1-${Date.now()}@example.com`, `RummyReconnectP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-reconnect-p2-${Date.now()}@example.com`, `RummyReconnectP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);
    const rememberToken = p1.payload.rememberToken;

    const table = await createRummyTable(p1.socket);
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['7C', '7D', '7H', '8S'];
    hands[p2Index] = ['KC', 'QD', '2H'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'action',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['9H'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const meldPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['7C', '7D', '7H'] });
    await meldPromise;

    const summaryPromise = waitForEvent(p1.socket, 'rummyHandSummary', () => true, 5000);
    p1.socket.emit('rummyDiscardCard', { card: '8S' });
    await summaryPromise;

    // p1 disconnects WITHOUT acking the hand summary, then reconnects as the
    // same account on a new socket - this is the scenario that would leave
    // pendingHandAcks permanently keyed on a dead socket id if onReconnect()
    // did not migrate it (see games/spades/index.js:696-732 for the pattern
    // this mirrors).
    p1.socket.disconnect();

    secondSocket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    const reconnectedTableState = waitForEvent(secondSocket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    secondSocket.on('connect', () => {
      secondSocket.emit('resumeLogin', { token: rememberToken });
    });
    await reconnectedTableState;

    const nextHandPromise = waitForEvent(secondSocket, 'rummyTurnState', (payload) => payload.handNumber === 2, 8000);
    secondSocket.emit('rummyAckHandSummary');
    p2.socket.emit('rummyAckHandSummary');
    const nextHand = await nextHandPromise;
    assert.equal(nextHand.handNumber, 2, 'the new socket’s ack must count toward the same pending-ack gate the old socket held');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    if (secondSocket && secondSocket.connected) {
      secondSocket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
