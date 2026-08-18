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

function connectAndRegister(port, email, displayName, rememberMe) {
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
        rememberMe: !!rememberMe
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
  const tableName = `Cribbage Play ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
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
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '10' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

// The bot opponent discards/pegs/shows on its own; the human host must also
// act on its own turns or a hand can never finish. All three autoplay
// helpers are deliberately dumb (first legal option), same "no lookahead"
// spirit as the server's own bot heuristics.
function autoDiscardForHost(socket) {
  socket.on('cribbageHand', (payload) => {
    if (payload.phase === 'discard' && Array.isArray(payload.hand) && payload.hand.length === 6) {
      socket.emit('cribbageSubmitDiscard', { cards: payload.hand.slice(0, 2) });
    }
  });
}

function autoPegForHost(socket) {
  socket.on('cribbagePegState', (payload) => {
    if (payload.turnPlayerId !== socket.id) {
      return;
    }
    if (Array.isArray(payload.legalCards) && payload.legalCards.length) {
      socket.emit('cribbagePlayCard', { card: payload.legalCards[0] });
    } else {
      socket.emit('cribbagePegGo');
    }
  });
}

function autoAckShowForHost(socket) {
  socket.on('cribbageShowStep', () => socket.emit('cribbageAckShow'));
}

function autoAckHandSummaryForHost(socket) {
  socket.on('cribbageHandSummary', () => socket.emit('cribbageAckHandSummary'));
}

test('the server rejects an illegal discard and an illegal peg play, explaining why', async () => {
  const port = 3184;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `cribbage-illegal-${Date.now()}@example.com`, `CribbageIllegal${Date.now()}`);

    await createCribbageTable(host.socket);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    const handPromise = waitForEvent(host.socket, 'cribbageHand', (payload) => payload.phase === 'discard', 5000);
    host.socket.emit('startGame');
    await inGamePromise;
    const hand = await handPromise;

    const badDiscardPromise = waitForEvent(host.socket, 'cribbageDiscardResult', (payload) => payload && payload.success === false, 5000);
    host.socket.emit('cribbageSubmitDiscard', { cards: [hand.hand[0]] });
    const badDiscard = await badDiscardPromise;
    assert.match(badDiscard.message, /exactly two/i);

    const badPegPromise = waitForEvent(host.socket, 'cribbagePegPlayResult', (payload) => payload && payload.success === false, 5000);
    host.socket.emit('cribbagePlayCard', { card: hand.hand[0] });
    const badPeg = await badPegPromise;
    assert.match(badPeg.message, /not your turn|unable to play/i);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a solo-started Cribbage table (host vs one bot) plays two full hands via autoplay, with the dealer alternating', async () => {
  const port = 3185;
  const child = startChild(port, { BOT_MOVE_DELAY_MS: '5' });
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `cribbage-autoplay-${Date.now()}@example.com`, `CribbageAutoplay${Date.now()}`);
    autoDiscardForHost(host.socket);
    autoPegForHost(host.socket);
    autoAckShowForHost(host.socket);
    autoAckHandSummaryForHost(host.socket);

    await createCribbageTable(host.socket, { cribbageTargetScore: 121 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;

    const firstSummary = await waitForEvent(host.socket, 'cribbageHandSummary', () => true, 30000);
    assert.equal(firstSummary.handNumber, 1);
    assert.equal(firstSummary.scores.length, 2);
    const firstDealer = firstSummary.dealerIndex;

    const secondSummary = await waitForEvent(host.socket, 'cribbageHandSummary', () => true, 30000);
    assert.equal(secondSummary.handNumber, 2);
    assert.notEqual(secondSummary.dealerIndex, firstDealer, 'the dealer should alternate every hand');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('an exact thirty-one during pegging scores 2 and resets the count, handing the lead to the other player', async () => {
  const port = 3186;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-31-p1-${Date.now()}@example.com`, `Cribbage31P1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-31-p2-${Date.now()}@example.com`, `Cribbage31P2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 121 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    const hands = [[], []];
    hands[p1Index] = ['5H'];
    hands[p2Index] = ['4D'];

    const testStatePayload = {
      tableId: table.id,
      game: {
        phase: 'peg',
        dealerIndex: p1Index,
        discardSubmitted: [true, true],
        starter: '9S',
        hands: hands,
        peg: {
          segment: [
            { playerIndex: p1Index, card: 'TC' },
            { playerIndex: p2Index, card: 'TD' },
            { playerIndex: p1Index, card: '7H' }
          ],
          count: 27,
          turnIndex: p2Index,
          stuckIndex: null,
          lastPlayerIndex: p1Index,
          cardsPlayedThisHand: 3
        }
      }
    };

    const roundResultPromise = waitForEvent(p1.socket, 'cribbagePegRoundResult', () => true, 5000);
    const nextStatePromise = waitForEvent(p1.socket, 'cribbagePegState', (payload) => payload.count === 0, 5000);

    p1.socket.emit('__testSetTableState', testStatePayload);
    p2.socket.emit('cribbagePlayCard', { card: '4D' });

    const roundResult = await roundResultPromise;
    assert.equal(roundResult.reason, 'thirtyOne');
    assert.equal(roundResult.points, 2);
    assert.equal(roundResult.scorerName, p2.payload.name);

    const nextState = await nextStatePromise;
    assert.equal(nextState.count, 0);
    assert.deepEqual(nextState.segment, []);
    assert.equal(nextState.turnPlayerId, p1.socket.id, 'the count reset hands the lead to the other player');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('a mutual Go (both players stuck in a row) awards 1 point to whoever played last and resets the count', async () => {
  const port = 3187;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-go-p1-${Date.now()}@example.com`, `CribbageGoP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-go-p2-${Date.now()}@example.com`, `CribbageGoP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 121 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;

    // p1 is up next but is out of legal plays (their only remaining card would
    // push the count past 31); p2 was already marked stuck from an earlier
    // play this same segment - so p1's Go completes a mutual Go, and the 1
    // point goes to whoever played last (p1, per peg.lastPlayerIndex).
    const hands = [[], []];
    hands[p1Index] = ['TC'];
    hands[p2Index] = ['TD'];

    const testStatePayload = {
      tableId: table.id,
      game: {
        phase: 'peg',
        dealerIndex: p2Index,
        discardSubmitted: [true, true],
        starter: '2H',
        hands: hands,
        peg: {
          segment: [{ playerIndex: p1Index, card: '8C' }],
          count: 28,
          turnIndex: p1Index,
          stuckIndex: p2Index,
          lastPlayerIndex: p1Index,
          cardsPlayedThisHand: 6
        }
      }
    };

    const roundResultPromise = waitForEvent(p1.socket, 'cribbagePegRoundResult', () => true, 5000);
    const nextStatePromise = waitForEvent(p1.socket, 'cribbagePegState', (payload) => payload.count === 0, 5000);

    p1.socket.emit('__testSetTableState', testStatePayload);
    p1.socket.emit('cribbagePegGo');

    const roundResult = await roundResultPromise;
    assert.equal(roundResult.reason, 'go');
    assert.equal(roundResult.points, 1);
    assert.equal(roundResult.scorerName, p1.payload.name);

    const nextState = await nextStatePromise;
    assert.equal(nextState.count, 0);
    assert.equal(nextState.turnPlayerId, p2.socket.id, 'the Go leads to the non-scorer');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('a Cribbage game ends immediately once a peg play pushes a score to the target - no further peg events follow', async () => {
  const port = 3188;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-over-p1-${Date.now()}@example.com`, `CribbageOverP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-over-p2-${Date.now()}@example.com`, `CribbageOverP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 121 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;
    const p1Name = inGameTable.players[p1Index].name;
    const p2Name = inGameTable.players[p2Index].name;

    const hands = [[], []];
    hands[p1Index] = ['5C', '2D', '3D', '4D'];
    hands[p2Index] = ['9D', '8D', '7D', '6D'];

    const scores = {};
    scores[p1Name] = 119;
    scores[p2Name] = 50;

    let sawFurtherPeg = false;
    p1.socket.on('cribbagePegState', () => { sawFurtherPeg = true; });

    const testStatePayload = {
      tableId: table.id,
      scores: scores,
      game: {
        phase: 'peg',
        dealerIndex: p2Index,
        discardSubmitted: [true, true],
        starter: 'KH',
        hands: hands,
        peg: {
          segment: [{ playerIndex: p2Index, card: 'TD' }],
          count: 10,
          turnIndex: p1Index,
          stuckIndex: null,
          lastPlayerIndex: p2Index,
          cardsPlayedThisHand: 1
        }
      }
    };

    const gameOverPromise = waitForEvent(p1.socket, 'cribbageGameOver', () => true, 5000);
    p1.socket.emit('__testSetTableState', testStatePayload);
    p1.socket.emit('cribbagePlayCard', { card: '5C' });

    const gameOver = await gameOverPromise;
    assert.equal(gameOver.winner, p1Name);
    const p1Final = gameOver.scores.find((entry) => entry.name === p1Name);
    assert.equal(p1Final.totalPoints, 121);
    assert.equal(sawFurtherPeg, false, 'no further cribbagePegState broadcast should follow the game-ending play');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('his heels (a Jack starter) scores the dealer 2 immediately at the cut, which can itself end the game', async () => {
  const port = 3189;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-heels-p1-${Date.now()}@example.com`, `CribbageHeelsP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-heels-p2-${Date.now()}@example.com`, `CribbageHeelsP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 121 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;
    const p1Name = inGameTable.players[p1Index].name;
    const p2Name = inGameTable.players[p2Index].name;

    const hands = [[], []];
    hands[p1Index] = ['2C', '3C', '4C', '5C', '6C', '7C'];
    hands[p2Index] = ['2D', '3D', '4D', '5D', '6D', '7D'];

    const scores = {};
    scores[p1Name] = 119; // p1 is the dealer for this hand - see dealerIndex below
    scores[p2Name] = 50;

    const testStatePayload = {
      tableId: table.id,
      scores: scores,
      game: {
        phase: 'discard',
        dealerIndex: p1Index,
        discardSubmitted: [false, false],
        starter: null,
        hisHeelsAwarded: false,
        hands: hands,
        stub: ['JH']
      }
    };

    let sawPegState = false;
    p1.socket.on('cribbagePegState', () => { sawPegState = true; });

    const gameOverPromise = waitForEvent(p1.socket, 'cribbageGameOver', () => true, 5000);
    const cutResultPromise = waitForEvent(p1.socket, 'cribbageCutResult', () => true, 5000);

    p1.socket.emit('__testSetTableState', testStatePayload);
    p1.socket.emit('cribbageSubmitDiscard', { cards: ['2C', '3C'] });
    p2.socket.emit('cribbageSubmitDiscard', { cards: ['2D', '3D'] });

    const cutResult = await cutResultPromise;
    assert.equal(cutResult.starter, 'JH');
    assert.equal(cutResult.hisHeels, true);

    const gameOver = await gameOverPromise;
    assert.equal(gameOver.winner, p1Name);
    const p1Final = gameOver.scores.find((entry) => entry.name === p1Name);
    assert.equal(p1Final.totalPoints, 121, 'his heels (2 points) should have pushed the dealer from 119 to 121');
    assert.equal(sawPegState, false, 'the game should have ended at the cut, before pegging ever begins');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('reconnecting mid-show resends the cached show step verbatim, without double-scoring it', async () => {
  const port = 3190;
  const child = startChild(port, { DISCONNECT_GRACE_MS: '5000' });
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-reco-p1-${Date.now()}@example.com`, `CribbageRecoP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-reco-p2-${Date.now()}@example.com`, `CribbageRecoP2${Date.now()}`, true);
    sockets.push(p1.socket, p2.socket);
    const p2RememberToken = p2.payload.rememberToken;

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 121 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;
    const p1Name = inGameTable.players[p1Index].name;
    const p2Name = inGameTable.players[p2Index].name;

    const showHands = [[], []];
    showHands[p1Index] = ['2C', '7D', '9H', 'KS']; // dealer hand - scores 2 for real once counted
    showHands[p2Index] = ['2H', '7S', '9D', 'KC']; // pretend "already counted" nonDealer hand

    const scores = {};
    scores[p1Name] = 0;
    scores[p2Name] = 5; // pretend the nonDealer step already awarded 5

    const testStatePayload = {
      tableId: table.id,
      scores: scores,
      game: {
        phase: 'show',
        dealerIndex: p1Index,
        discardSubmitted: [true, true],
        starter: '4C',
        showHands: showHands,
        crib: ['2H', '7S', '9D', 'KC'], // scores 2 for real once counted (crib flush needs all 5)
        handPointsThisHand: [0, 5],
        show: {
          step: 'nonDealer',
          pendingAcks: (() => {
            const acks = {};
            acks[p1.socket.id] = true;
            acks[p2.socket.id] = true;
            return acks;
          })(),
          lastPayload: {
            step: 'nonDealer',
            ownerId: p2.socket.id,
            ownerName: p2Name,
            cards: showHands[p2Index],
            starter: '4C',
            label: 'hand',
            points: 5,
            ownerTotal: 5
          }
        }
      }
    };

    p1.socket.emit('__testSetTableState', testStatePayload);
    await waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.cribbage && payload.table.cribbage.phase === 'show', 5000);

    p2.socket.disconnect();

    const p2New = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    const resentShowStepPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for resent cribbageShowStep')), 8000);
      p2New.on('cribbageShowStep', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    p2New.on('connect', () => p2New.emit('resumeLogin', { token: p2RememberToken }));
    sockets.push(p2New);

    const resentPayload = await resentShowStepPromise;
    assert.equal(resentPayload.step, 'nonDealer');
    assert.equal(resentPayload.points, 5);
    assert.equal(resentPayload.ownerTotal, 5);

    // Three show steps remain to be acked (nonDealer, dealer, crib) before
    // finishHand() fires - keep acking every step as it arrives, same as
    // autoAckShowForHost() does for the solo-autoplay test above.
    p1.socket.on('cribbageShowStep', () => p1.socket.emit('cribbageAckShow'));
    p2New.on('cribbageShowStep', () => p2New.emit('cribbageAckShow'));
    p2New.emit('cribbageAckShow');
    p1.socket.emit('cribbageAckShow');

    const handSummary = await waitForEvent(p1.socket, 'cribbageHandSummary', () => true, 10000);
    const p1Row = handSummary.scores.find((entry) => entry.name === p1Name);
    const p2Row = handSummary.scores.find((entry) => entry.name === p2Name);

    assert.equal(p2Row.handPoints, 5, 'the nonDealer step must not have been re-scored on reconnect');
    assert.equal(p2Row.totalPoints, 5);
    assert.equal(p1Row.handPoints, 4, 'dealer hand (2) + crib (2), both scored for real exactly once');
    assert.equal(p1Row.totalPoints, 4);
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});

test('restarting a table after a game ends resets scores to 0 for a rematch, even with the same players', async () => {
  const port = 3191;
  const child = startChild(port);
  const sockets = [];

  try {
    await waitForServer(child, port);
    const p1 = await connectAndRegister(port, `cribbage-restart-p1-${Date.now()}@example.com`, `CribbageRestartP1${Date.now()}`);
    const p2 = await connectAndRegister(port, `cribbage-restart-p2-${Date.now()}@example.com`, `CribbageRestartP2${Date.now()}`);
    sockets.push(p1.socket, p2.socket);

    const table = await createCribbageTable(p1.socket, { cribbageTargetScore: 61 });
    const joined = waitForEvent(p2.socket, 'tableState', (payload) => payload && payload.table && payload.table.id === table.id, 5000);
    p2.socket.emit('joinTable', { tableId: table.id });
    await joined;

    const inGamePromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const p1Index = inGameTable.players.findIndex((player) => player.id === p1.socket.id);
    const p2Index = 1 - p1Index;
    const p1Name = inGameTable.players[p1Index].name;
    const p2Name = inGameTable.players[p2Index].name;

    const hands = [[], []];
    hands[p1Index] = ['5C', '2D', '3D', '4D'];
    hands[p2Index] = ['9D', '8D', '7D', '6D'];

    const scores = {};
    scores[p1Name] = 59;
    scores[p2Name] = 50;

    const testStatePayload = {
      tableId: table.id,
      scores: scores,
      game: {
        phase: 'peg',
        dealerIndex: p2Index,
        discardSubmitted: [true, true],
        starter: 'KH',
        hands: hands,
        peg: {
          segment: [{ playerIndex: p2Index, card: 'TD' }],
          count: 10,
          turnIndex: p1Index,
          stuckIndex: null,
          lastPlayerIndex: p2Index,
          cardsPlayedThisHand: 1
        }
      }
    };

    const gameOverPromise = waitForEvent(p1.socket, 'cribbageGameOver', () => true, 5000);
    // Table returns to the lobby (status: waiting) via a tableState broadcast
    // sent in the same synchronous handler as cribbageGameOver, so this must
    // be armed before the game-ending play fires, not after awaiting gameOver.
    const waitingPromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'waiting', 5000);
    p1.socket.emit('__testSetTableState', testStatePayload);
    p1.socket.emit('cribbagePlayCard', { card: '5C' }); // fifteen for 2 -> pushes p1 from 59 to 61

    const gameOver = await gameOverPromise;
    assert.equal(gameOver.winner, p1Name);
    const p1Final = gameOver.scores.find((entry) => entry.name === p1Name);
    assert.equal(p1Final.totalPoints, 61, 'won with a score above the old bug threshold of 61');

    // Starting again with the same two players seated is the "rematch" flow
    // that used to carry stale scores forward (the bug this test guards).
    await waitingPromise;

    const restartedPromise = waitForEvent(p1.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    p1.socket.emit('startGame');
    const restartedTable = (await restartedPromise).table;

    const restartedP1 = restartedTable.players.find((player) => player.name === p1Name);
    const restartedP2 = restartedTable.players.find((player) => player.name === p2Name);
    assert.equal(restartedP1.score, 0, 'the previous winner should start the rematch at 0, not 61+');
    assert.equal(restartedP2.score, 0, 'the previous loser should also start the rematch at 0');
  } finally {
    sockets.forEach((socket) => { if (socket.connected) socket.disconnect(); });
    child.kill('SIGTERM');
  }
});
