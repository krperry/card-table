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

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
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

test('a Joker melds as a wild card and, left in hand, scores as 15 deadwood', async () => {
  const port = 3204;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `rummy-joker-${Date.now()}@example.com`, `RummyJoker${Date.now()}`);

    await createRummyTable(host.socket);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const hostIndex = inGameTable.players.findIndex((player) => player.id === host.socket.id);
    const botIndex = 1 - hostIndex;

    const hands = [[], []];
    hands[hostIndex] = ['7C', '7D', '1J', '8S'];
    hands[botIndex] = ['KC', '1J'];

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

    // 7C + 7D + a Joker is a valid set - the Joker wildcards the missing suit.
    const meldPromise = waitForEvent(host.socket, 'rummyMeldResult', () => true, 5000);
    host.socket.emit('rummyMeldCards', { cards: ['7C', '7D', '1J'] });
    const meldResult = await meldPromise;
    assert.equal(meldResult.success, true);

    // Discarding the last card (8S) empties the host's hand and goes out,
    // ending the hand immediately - the bot is left holding KC + a lone
    // Joker, which should score as 10 + 15 = 25 deadwood.
    const summaryPromise = waitForEvent(host.socket, 'rummyHandSummary', () => true, 5000);
    host.socket.emit('rummyDiscardCard', { card: '8S' });
    const summary = await summaryPromise;

    const botRow = summary.rows.find((row) => row.name !== host.payload.name);
    assert.equal(botRow.deadwood, 25, 'KC (10) + Joker (15) deadwood');
    const hostRow = summary.rows.find((row) => row.name === host.payload.name);
    assert.equal(hostRow.pointsAwarded, 25);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
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

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
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

test('rummyTurnState messages tell a blind player where a draw came from (without revealing a hidden stock card), name a visible discard-pile take, and announce whose turn is next without duplicating it mid-turn', async () => {
  const port = 3205;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-announce-p1-${Date.now()}@example.com`, `RummyAnnounceP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-announce-p2-${Date.now()}@example.com`, `RummyAnnounceP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
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

    const p1ReadyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    const p2ReadyPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'draw',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['9S'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    const p1ReadyMessage = (await p1ReadyPromise).message;
    const p2ReadyMessage = (await p2ReadyPromise).message;
    assert.equal(p1ReadyMessage, 'It is your turn.');
    assert.equal(p2ReadyMessage, "It is " + p1.payload.name + "'s turn.");

    // p1 draws from the face-down stock: p2 should hear where it came from,
    // but never the identity of a card only p1 can see.
    const p2SeesStockDrawPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action', 5000);
    const p1DrawResultPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawStock');
    const p1DrawResult = await p1DrawResultPromise;
    assert.equal(p1DrawResult.card, '6D');
    const p2SeesStockDraw = await p2SeesStockDrawPromise;
    assert.equal(p2SeesStockDraw.message, p1.payload.name + ' draws from the stack.');
    assert.ok(!p2SeesStockDraw.message.includes('6D'));
    assert.ok(!/Six of Diamonds/i.test(p2SeesStockDraw.message));

    // p1 discards - this both ends p1's turn (should NOT re-announce "Your
    // turn" to p1 for their own earlier draw) and hands play to p2, so both
    // players should be told whose turn is next.
    const p1SeesOwnDiscardTurnPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p2.socket.id, 5000);
    const p2SeesDiscardAndOwnTurnPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p2.socket.id, 5000);
    const discardResultPromise = waitForEvent(p1.socket, 'rummyDiscardResult', () => true, 5000);
    p1.socket.emit('rummyDiscardCard', { card: '9S' });
    await discardResultPromise;
    const p1SeesOwnDiscardTurn = await p1SeesOwnDiscardTurnPromise;
    const p2SeesDiscardAndOwnTurn = await p2SeesDiscardAndOwnTurnPromise;
    assert.equal(p1SeesOwnDiscardTurn.message, 'It is ' + p2.payload.name + "'s turn.");
    assert.equal(p2SeesDiscardAndOwnTurn.message, p1.payload.name + ' discards Nine of Spades. It is your turn.');

    // p2 takes the visible discard: p1 should hear which card, since the
    // discard pile is public information.
    const p1SeesDiscardTakePromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action', 5000);
    const p2DrawResultPromise = waitForEvent(p2.socket, 'rummyDrawResult', () => true, 5000);
    p2.socket.emit('rummyDrawDiscard');
    const p2DrawResult = await p2DrawResultPromise;
    assert.equal(p2DrawResult.card, '9S');
    const p1SeesDiscardTake = await p1SeesDiscardTakePromise;
    assert.equal(p1SeesDiscardTake.message, p2.payload.name + ' takes the Nine of Spades from the discard pile.');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test("a bot's draw and discard - which run synchronously back-to-back within a single turn - are combined into one rummyTurnState message instead of the draw announcement being overwritten", async () => {
  const port = 3206;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-bot-announce-${Date.now()}@example.com`, `RummyBotAnnounce${Date.now()}`);
    sockets.push(p1.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const botIndex = 1 - p1Index;
    const botName = inGameTable.players[botIndex].name;

    // No pairs and no runs in either hand, and the discard top doesn't
    // complete a visible meld for the bot - so the bot draws from the stock,
    // finds nothing to meld or lay off, and immediately discards. Those two
    // perform*() calls (and their queueRummyTurnEvent() calls) happen back
    // to back inside the same synchronous runBotTurn() invocation.
    const hands = [[], []];
    hands[botIndex] = ['2C', '5D', '9H'];
    hands[p1Index] = ['3C', '4C', '5H'];

    const botTurnDonePromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: botIndex,
        turnPhase: 'draw',
        dealerIndex: p1Index,
        hands: hands,
        stock: ['KH', 'QS'],
        discardPile: ['2H'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });

    const botTurnDone = await botTurnDonePromise;
    // Both sub-actions must survive in the one message the client actually
    // renders/speaks - if the draw announcement got clobbered by the
    // discard announcement (the bug this test guards against), the message
    // would start with "<bot> discards" instead of "<bot> draws".
    assert.equal(botTurnDone.message, botName + ' draws from the stack. ' + botName + ' discards Queen of Spades. It is your turn.');
    assert.ok(!botTurnDone.message.includes('KH'));
    assert.ok(!/King of Hearts/i.test(botTurnDone.message));
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('laying off a real card onto a slot a Joker is filling swaps the Joker back into the layer-off’s hand, in both a run and a set', async () => {
  const port = 3207;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-jokerswap-p1-${Date.now()}@example.com`, `RummyJokerSwapP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-jokerswap-p2-${Date.now()}@example.com`, `RummyJokerSwapP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    // p1's existing melds: a run of A-H 2-H Joker-H (the Joker standing in
    // for 3H), and a set of 5H 5C Joker-S (the Joker standing in for either
    // missing suit). p2 holds the exact cards that complete each Joker's
    // slot.
    const melds = [[], []];
    melds[p1Index] = [
      { type: 'run', cards: ['AH', '2H', '1J'] },
      { type: 'set', cards: ['5H', '5C', '2J'] }
    ];

    const hands = [[], []];
    hands[p2Index] = ['3H', '5D', '9S'];
    hands[p1Index] = ['KC', 'QD'];

    // Match on stockCount (2, distinct from the real deal's much larger
    // stock) rather than just turnPlayerId - with 2 real players, the real
    // deal's own opening rummyTurnState (queued from beginRound(), before
    // this __testSetTableState override is even applied) can coincidentally
    // also have p2 as turnPlayerId, which would resolve this promise on the
    // wrong (stale, pre-override) event.
    const readyPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p2.socket.id && payload.stockCount === 2, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p2Index,
        turnPhase: 'action',
        dealerIndex: p1Index,
        hands: hands,
        stock: ['8C', '9C'],
        discardPile: ['TD'],
        melds: melds
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    // Swap #1: lay off 3H onto p1's run - takes back the Joker standing in for 3H.
    // Drain its own rummyTurnState flush before starting swap #2, so that
    // event can't be the one a later waitForEvent(..., 'rummyTurnState', ...)
    // ends up catching instead of swap #2's.
    const runSwapPromise = waitForEvent(p2.socket, 'rummyLayOffResult', () => true, 5000);
    const runSwapTurnStatePromise = waitForEvent(p2.socket, 'rummyTurnState', () => true, 5000);
    p2.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['3H'] });
    const runSwap = await runSwapPromise;
    assert.equal(runSwap.success, true);
    assert.deepEqual(runSwap.returnedJokers, ['1J']);
    await runSwapTurnStatePromise;

    // Swap #2: lay off 5D onto p1's set - takes back the other Joker. The
    // rummyTurnState the server sends right after this also carries the
    // updated melds, confirming both Jokers are off the table and the real
    // cards took their place.
    const setSwapPromise = waitForEvent(p2.socket, 'rummyLayOffResult', () => true, 5000);
    const turnStateAfterSwapsPromise = waitForEvent(p2.socket, 'rummyTurnState', () => true, 5000);
    p2.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['5D'] });
    const setSwap = await setSwapPromise;
    assert.equal(setSwap.success, true);
    assert.deepEqual(setSwap.returnedJokers, ['2J']);

    const turnStateAfterSwaps = await turnStateAfterSwapsPromise;
    const p1Melds = turnStateAfterSwaps.melds[p1Index];
    assert.deepEqual(p1Melds[0].cards.slice().sort(), ['2H', '3H', 'AH']);
    assert.deepEqual(p1Melds[1].cards.slice().sort(), ['5C', '5D', '5H']);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('selecting a Joker plus a card past the gap it fills lays off both together, resolving the Joker to the card that makes that possible', async () => {
  const port = 3208;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-jokerbatch-p1-${Date.now()}@example.com`, `RummyJokerBatchP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-jokerbatch-p2-${Date.now()}@example.com`, `RummyJokerBatchP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    // p1's existing meld: the run 5S 6S 7S. p2 selects a Joker plus 9S in
    // one batch - a card-by-card resolution would place the Joker as 4S
    // (the first legal position, extending the low end) and then reject 9S
    // outright since 8S would still be missing. The whole selection must be
    // evaluated together so the Joker resolves to 8S instead.
    const melds = [[], []];
    melds[p1Index] = [{ type: 'run', cards: ['5S', '6S', '7S'] }];

    const hands = [[], []];
    hands[p2Index] = ['1J', '9S', 'KC'];
    hands[p1Index] = ['2D', '3D'];

    const readyPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPlayerId === p2.socket.id && payload.stockCount === 2, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p2Index,
        turnPhase: 'action',
        dealerIndex: p1Index,
        hands: hands,
        stock: ['8C', '9C'],
        discardPile: ['TD'],
        melds: melds
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const layoffPromise = waitForEvent(p2.socket, 'rummyLayOffResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p2.socket, 'rummyTurnState', () => true, 5000);
    p2.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['1J', '9S'] });
    const layoffResult = await layoffPromise;
    assert.equal(layoffResult.success, true);

    const turnState = await turnStatePromise;
    const p1Melds = turnState.melds[p1Index];
    assert.equal(p1Melds.length, 1);
    assert.deepEqual(p1Melds[0].cards.slice().sort(), ['1J', '5S', '6S', '7S', '9S'].sort());
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('a genuinely ambiguous meld selection (8S, Joker, Joker) asks the player to choose Run or Set over the socket API, and resolving as a run stores the meld in logical order with a stable Joker assignment', async () => {
  const port = 3209;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-meldchoice-p1-${Date.now()}@example.com`, `RummyMeldChoiceP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-meldchoice-p2-${Date.now()}@example.com`, `RummyMeldChoiceP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['8S', '1J', '2J', 'KC'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'action',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['QH'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    // Selecting 8S, Joker, Joker (in that order) is legally either a set or
    // a run - the server must not guess, it must ask.
    const needsChoicePromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['8S', '1J', '2J'] });
    const needsChoice = await needsChoicePromise;
    assert.equal(needsChoice.success, false);
    assert.equal(needsChoice.needsChoice, true);
    assert.deepEqual(needsChoice.options.slice().sort(), ['run', 'set']);

    // The hand is untouched while the choice is pending - nothing was
    // removed, and p1 is still mid-turn (not a rejection, just a question).
    const turnStateBeforeChoice = await waitForEvent(p1.socket, 'rummyTurnState', () => true, 1500).catch(() => null);
    if (turnStateBeforeChoice) {
      // If a turnState happened to arrive (harmless - the server doesn't
      // emit one on a needsChoice reply, so this only fires if something
      // else did), it must still show p1 mid-action, never advanced.
      assert.equal(turnStateBeforeChoice.turnPlayerId, p1.socket.id);
    }

    // Resubmitting the SAME cards with meldTypeChoice: 'run' resolves it -
    // both Jokers were selected after the 8, so they extend the high end
    // (8S-9S-TS), matching rules.resolveMeld()'s documented behavior.
    const meldResultPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['8S', '1J', '2J'], meldTypeChoice: 'run' });
    const meldResult = await meldResultPromise;
    assert.equal(meldResult.success, true);

    const turnState = await turnStatePromise;
    const p1Melds = turnState.melds[p1Index];
    assert.equal(p1Melds.length, 1);
    assert.equal(p1Melds[0].type, 'run');
    // Stored/displayed in logical order, not raw selection order.
    assert.deepEqual(p1Melds[0].cards, ['8S', '1J', '2J']);
    assert.deepEqual(p1Melds[0].jokers, { '1J': '9S', '2J': 'TS' });
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('an unambiguous meld with a Joker in the middle of the selection resolves automatically (no prompt) and is stored in the Joker\'s logical position, not at the end of the selection', async () => {
  const port = 3210;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-meldorder-p1-${Date.now()}@example.com`, `RummyMeldOrderP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-meldorder-p2-${Date.now()}@example.com`, `RummyMeldOrderP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyAceHighOrLow: true, rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    // Selected in this order - Ace, King, Joker - not the run's own logical
    // order, to prove the stored meld is re-sorted rather than mirroring
    // selection order once the interpretation is unambiguous.
    hands[p1Index] = ['AS', 'KS', '1J', '4C'];
    hands[p2Index] = ['2C', '3C', '4D'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'action',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['QC'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const meldResultPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['AS', 'KS', '1J'] });
    const meldResult = await meldResultPromise;
    assert.equal(meldResult.success, true);
    assert.ok(!meldResult.needsChoice);

    const turnState = await turnStatePromise;
    const p1Melds = turnState.melds[p1Index];
    assert.equal(p1Melds[0].type, 'run');
    assert.deepEqual(p1Melds[0].cards, ['1J', 'KS', 'AS']);
    assert.equal(p1Melds[0].jokers['1J'], 'QS');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('a set Joker is generic by suit end-to-end: melding "8H, 8D, Joker" then laying off 8S (not the suit a legacy fake assignment would have picked) replaces the Joker, which is immediately back in hand the same turn', async () => {
  const port = 3211;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-setjoker-p1-${Date.now()}@example.com`, `RummySetJokerP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-setjoker-p2-${Date.now()}@example.com`, `RummySetJokerP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    // Missing suits after 8H/8D are Clubs and Spades - a legacy "assign the
    // next unused canonical suit (C, D, H, S)" bug would have pinned the
    // Joker to 8C specifically, leaving 8S unable to swap it out.
    hands[p1Index] = ['8H', '8D', '1J', '8S', 'TC'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'action',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['5D', '6D'],
        discardPile: ['QH'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const meldResultPromise = waitForEvent(p1.socket, 'rummyMeldResult', () => true, 5000);
    // Also wait out the meld's own deferred rummyTurnState flush (see
    // queueRummyTurnEvent()'s header in games/rummy/index.js) before moving
    // on, so it can't be the one a later waitForEvent(..., 'rummyTurnState',
    // ...) below ends up catching instead of the layoff's own flush.
    const meldTurnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyMeldCards', { cards: ['8H', '8D', '1J'] });
    const meldResult = await meldResultPromise;
    assert.equal(meldResult.success, true);
    await meldTurnStatePromise;

    // Same turn, no re-draw - lay 8S off onto the set the Joker is generic
    // wildcard for.
    const layoffPromise = waitForEvent(p1.socket, 'rummyLayOffResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['8S'] });
    const layoffResult = await layoffPromise;
    assert.equal(layoffResult.success, true);
    assert.deepEqual(layoffResult.returnedJokers, ['1J']);

    const turnState = await turnStatePromise;
    assert.equal(turnState.turnPlayerId, p1.socket.id, 'the turn has not advanced - laying off does not end a turn');
    const p1Melds = turnState.melds[p1Index];
    assert.equal(p1Melds.length, 1);
    assert.deepEqual(p1Melds[0].cards.slice().sort(), ['8D', '8H', '8S']);
    assert.deepEqual(p1Melds[0].jokers, {});

    // Prove the returned Joker is immediately usable THIS same turn, not
    // locked until the next one - discarding it only succeeds if it's
    // actually back in hand right now.
    const discardPromise = waitForEvent(p1.socket, 'rummyDiscardResult', () => true, 5000);
    p1.socket.emit('rummyDiscardCard', { card: '1J' });
    const discardResult = await discardPromise;
    assert.equal(discardResult.success, true);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('laying off a card that legally fits more than one existing meld asks the player which meld to use, instead of picking one automatically', async () => {
  const port = 3212;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-layoffchoice-p1-${Date.now()}@example.com`, `RummyLayoffChoiceP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-layoffchoice-p2-${Date.now()}@example.com`, `RummyLayoffChoiceP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyAceHighOrLow: true, rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    // p1's board: an Ace set (missing AH) and a Hearts run J-Q-K (ace-high
    // table, so it can also accept a trailing Ace). AH legally completes
    // either one - the server must ask which, not silently pick.
    const melds = [[], []];
    melds[p1Index] = [
      { type: 'set', cards: ['AC', 'AD', 'AS'] },
      { type: 'run', cards: ['JH', 'QH', 'KH'] }
    ];

    const hands = [[], []];
    hands[p1Index] = ['AH', 'TC'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action' && payload.turnPlayerId === p1.socket.id, 5000);
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
        melds: melds
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    const needsChoicePromise = waitForEvent(p1.socket, 'rummyLayOffResult', () => true, 5000);
    p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['AH'] });
    const needsChoice = await needsChoicePromise;
    assert.equal(needsChoice.success, false);
    assert.equal(needsChoice.needsChoice, true);
    assert.deepEqual(needsChoice.groupIndices.slice().sort(), [0, 1]);
    assert.equal(needsChoice.targetPlayerIndex, p1Index);

    // Nothing was applied yet - both melds remain exactly as they were.
    const stillIntact = await waitForEvent(p1.socket, 'rummyTurnState', () => true, 1500).catch(() => null);
    if (stillIntact) {
      assert.deepEqual(stillIntact.melds[p1Index][0].cards.slice().sort(), ['AC', 'AD', 'AS']);
      assert.deepEqual(stillIntact.melds[p1Index][1].cards.slice().sort(), ['JH', 'KH', 'QH']);
    }

    // Answering with meldChoiceIndex: 1 sends AH onto the run, not the set.
    const layoffPromise = waitForEvent(p1.socket, 'rummyLayOffResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['AH'], meldChoiceIndex: 1 });
    const layoffResult = await layoffPromise;
    assert.equal(layoffResult.success, true);

    const turnState = await turnStatePromise;
    const p1Melds = turnState.melds[p1Index];
    assert.deepEqual(p1Melds[0].cards.slice().sort(), ['AC', 'AD', 'AS'], 'the set is untouched');
    assert.deepEqual(p1Melds[1].cards, ['JH', 'QH', 'KH', 'AH'], 'the run received the Ace, in logical (ace-high) order');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('choosing the other meldChoiceIndex for the same ambiguous layoff sends the card to that meld instead', async () => {
  const port = 3213;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-layoffchoice2-p1-${Date.now()}@example.com`, `RummyLOChoice2P1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-layoffchoice2-p2-${Date.now()}@example.com`, `RummyLOChoice2P2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyAceHighOrLow: true, rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const melds = [[], []];
    melds[p1Index] = [
      { type: 'set', cards: ['AC', 'AD', 'AS'] },
      { type: 'run', cards: ['JH', 'QH', 'KH'] }
    ];

    const hands = [[], []];
    hands[p1Index] = ['AH', 'TC'];
    hands[p2Index] = ['2C', '3C', '4C'];

    const readyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action' && payload.turnPlayerId === p1.socket.id, 5000);
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
        melds: melds
      },
      emitRummyTurnState: true
    });
    await readyPromise;

    await new Promise(function (resolve) { p1.socket.once('rummyLayOffResult', resolve); p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['AH'] }); });

    const layoffPromise = waitForEvent(p1.socket, 'rummyLayOffResult', () => true, 5000);
    const turnStatePromise = waitForEvent(p1.socket, 'rummyTurnState', () => true, 5000);
    p1.socket.emit('rummyLayOffCards', { targetPlayerIndex: p1Index, cards: ['AH'], meldChoiceIndex: 0 });
    const layoffResult = await layoffPromise;
    assert.equal(layoffResult.success, true);

    const turnState = await turnStatePromise;
    const p1Melds = turnState.melds[p1Index];
    assert.deepEqual(p1Melds[0].cards.slice().sort(), ['AC', 'AD', 'AH', 'AS'], 'the set received the Ace this time');
    assert.deepEqual(p1Melds[1].cards.slice().sort(), ['JH', 'KH', 'QH'], 'the run is untouched');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

// Regression coverage for the "You draw/discard <card>." screen-reader fix:
// public/games/rummy/rummy-client.js builds that one sentence entirely from
// rummyDrawResult/rummyDiscardResult's own `card` field, and no longer moves
// focus into the hand grid afterward (see rummySkipNextHandRefocus there) -
// so the fix regresses if either (a) the acting player's own result payload
// stops carrying the exact card, or (b) their own correlated rummyTurnState
// message starts also naming that card, which would hand the client a second
// source to (re)announce from. This test can't drive a real screen reader,
// but it locks down the server-side data contract the client's single
// announcement depends on, for both draw sources ('w'/'d' shortcuts) and
// discard, all using the King of Spades from the issue's own examples.
test('the acting player\'s own rummyDrawResult/rummyDiscardResult carry the exact card (King of Spades) with no duplicate mention in their own rummyTurnState message', async () => {
  const port = 3214;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `rummy-single-announce-p1-${Date.now()}@example.com`, `RmyAnnP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `rummy-single-announce-p2-${Date.now()}@example.com`, `RmyAnnP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createRummyTable(p1.socket, { rummyComputerPlayers: 0 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['2H', '2D'];
    hands[p2Index] = ['3C', '4C'];

    const p1ReadyPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw' && payload.turnPlayerId === p1.socket.id, 5000);
    p1.socket.emit('__testSetTableState', {
      tableId: table.id,
      game: {
        phase: 'playing',
        turnIndex: p1Index,
        turnPhase: 'draw',
        dealerIndex: p2Index,
        hands: hands,
        stock: ['KS'],
        discardPile: ['9S'],
        melds: [[], []]
      },
      emitRummyTurnState: true
    });
    await p1ReadyPromise;

    // Draw from the stock (the "d" shortcut) - the result payload alone must
    // carry the King of Spades; the acting player's own follow-up turnState
    // must not repeat it (there's nothing left to say once turnPhase is
    // 'action' and it was their own draw - see buildTurnMessage()).
    const p1OwnTurnStateAfterDrawPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action', 5000);
    const p1DrawResultPromise = waitForEvent(p1.socket, 'rummyDrawResult', () => true, 5000);
    p1.socket.emit('rummyDrawStock');
    const p1DrawResult = await p1DrawResultPromise;
    assert.equal(p1DrawResult.success, true);
    assert.equal(p1DrawResult.card, 'KS');
    assert.equal(p1DrawResult.source, 'stock');
    const p1OwnTurnStateAfterDraw = await p1OwnTurnStateAfterDrawPromise;
    assert.equal(p1OwnTurnStateAfterDraw.message, null);

    // Discard that same King of Spades (the "Enter" discard) - again, the
    // result payload alone carries it, and the acting player's own next
    // turnState (now announcing whose turn is next) must not name it either.
    const p1OwnTurnStateAfterDiscardPromise = waitForEvent(p1.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'draw', 5000);
    const p1DiscardResultPromise = waitForEvent(p1.socket, 'rummyDiscardResult', () => true, 5000);
    p1.socket.emit('rummyDiscardCard', { card: 'KS' });
    const p1DiscardResult = await p1DiscardResultPromise;
    assert.equal(p1DiscardResult.success, true);
    assert.equal(p1DiscardResult.card, 'KS');
    const p1OwnTurnStateAfterDiscard = await p1OwnTurnStateAfterDiscardPromise;
    assert.equal(p1OwnTurnStateAfterDiscard.message, "It is " + p2.payload.name + "'s turn.");
    assert.ok(!p1OwnTurnStateAfterDiscard.message.includes('KS'));
    assert.ok(!/King of Spades/i.test(p1OwnTurnStateAfterDiscard.message));

    // p2 takes that same King of Spades off the discard pile (the "w"
    // shortcut) - same contract: the draw result alone carries it, and p2's
    // own next turnState (now mid-turn, 'action') says nothing at all.
    const p2OwnTurnStateAfterDrawPromise = waitForEvent(p2.socket, 'rummyTurnState', (payload) => payload.turnPhase === 'action', 5000);
    const p2DrawResultPromise = waitForEvent(p2.socket, 'rummyDrawResult', () => true, 5000);
    p2.socket.emit('rummyDrawDiscard');
    const p2DrawResult = await p2DrawResultPromise;
    assert.equal(p2DrawResult.success, true);
    assert.equal(p2DrawResult.card, 'KS');
    assert.equal(p2DrawResult.source, 'discard');
    const p2OwnTurnStateAfterDraw = await p2OwnTurnStateAfterDrawPromise;
    assert.equal(p2OwnTurnStateAfterDraw.message, null);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

// Coverage for the "Add Configurable Computer Players to Rummy Table
// Creation" issue: matchSettings.computerPlayers (the new
// new-table-rummy-computer-players select, mirroring games/lumo/index.js's
// own computerPlayers setting) is read fresh at startGame() time, not
// reserved at table-creation time - see games/rummy/index.js's startGame()
// header comment. Every example from that issue is exercised here, using a
// single pool of 6 already-connected human sockets across all 8 scenarios
// (each scenario creates its own table, joins however many of the pool it
// needs, starts, asserts, then every joined human leaves so the next
// scenario starts against a clean lobby).
test('Rummy startGame adds up to the configured number of computer players, capped at six total players and floored at two', async () => {
  const port = 3215;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    for (let i = 0; i < 6; i++) {
      const conn = await connectAndRegister(port, `rummy-cap-h${i}-${Date.now()}@example.com`, `RmyCapH${i}${Date.now()}`);
      sockets.push(conn.socket);
    }

    const scenarios = [
      { humans: 1, selected: 1, expectedBots: 1, expectedTotal: 2 },
      { humans: 1, selected: 5, expectedBots: 5, expectedTotal: 6 },
      { humans: 2, selected: 2, expectedBots: 2, expectedTotal: 4 },
      { humans: 2, selected: 5, expectedBots: 4, expectedTotal: 6 },
      { humans: 3, selected: 5, expectedBots: 3, expectedTotal: 6 },
      { humans: 4, selected: 2, expectedBots: 2, expectedTotal: 6 },
      { humans: 5, selected: 5, expectedBots: 1, expectedTotal: 6 },
      { humans: 6, selected: 5, expectedBots: 0, expectedTotal: 6 }
    ];

    for (let s = 0; s < scenarios.length; s++) {
      const scenario = scenarios[s];
      const tableName = `Rummy Cap ${s}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const host = sockets[0];

      const createdPromise = waitForEvent(host, 'tableState', (payload) => payload && payload.table && payload.table.name === tableName, 5000)
        .then((payload) => payload.table);
      host.emit('createTable', { name: tableName, gameType: 'rummy', rummyComputerPlayers: scenario.selected });
      const table = await createdPromise;

      for (let i = 1; i < scenario.humans; i++) {
        const joinedPromise = waitForEvent(sockets[i], 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
        sockets[i].emit('joinTable', { tableId: table.id });
        await joinedPromise;
      }

      const inGamePromise = waitForEvent(host, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
      host.emit('startGame');
      const inGameTable = (await inGamePromise).table;

      const bots = inGameTable.players.filter((player) => player.isBot);
      const humans = inGameTable.players.filter((player) => !player.isBot);
      assert.equal(inGameTable.players.length, scenario.expectedTotal, `scenario ${s} (${scenario.humans} humans, selected ${scenario.selected}): total players`);
      assert.equal(bots.length, scenario.expectedBots, `scenario ${s}: bot count`);
      assert.equal(humans.length, scenario.humans, `scenario ${s}: human count`);
      // Every bot gets a unique name from the existing Rummy bot-naming
      // convention (games/rummy uses server.js's shared pickBotNames()/
      // addComputerPlayersToTable() - same as Lumo, not a bespoke bot type).
      assert.equal(new Set(bots.map((bot) => bot.name)).size, bots.length, `scenario ${s}: bot names are unique`);

      // Leave the table so the next scenario starts clean - the last human
      // to leave an in-game table with no humans left deletes it entirely
      // (see server.js's removePlayerFromTable()).
      for (let i = 0; i < scenario.humans; i++) {
        const leftPromise = waitForEvent(sockets[i], 'tableState', (payload) => payload === null, 5000);
        sockets[i].emit('leaveTable');
        await leftPromise;
      }
    }
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

// "Do not stall between computer players" regression: one human seated with
// five bots (the maximum a single human can be dealt alongside) must see
// turn order cycle Human -> Computer 1 -> ... -> Computer 5 -> Human without
// ever needing a human action to nudge a bot-to-bot handoff along -
// maybeScheduleBotTurn()/queueRummyTurnEvent() in games/rummy/index.js must
// re-arm themselves after every single bot turn, not just the first.
test('several consecutive computer turns do not stall the game', async () => {
  const port = 3216;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `rummy-chain-${Date.now()}@example.com`, `RummyChain${Date.now()}`);

    await createRummyTable(host.socket, { rummyComputerPlayers: 5 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;
    assert.equal(inGameTable.players.length, 6, 'one human plus five bots fill the table');
    assert.equal(inGameTable.players.filter((player) => player.isBot).length, 5);

    let sawABotsTurn = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Turn order stalled among the computer players')), 20000);
      host.socket.on('rummyTurnState', (payload) => {
        if (payload.turnPhase !== 'draw') {
          return;
        }
        if (payload.turnPlayerId !== host.socket.id) {
          sawABotsTurn = true;
          return;
        }
        if (sawABotsTurn) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
