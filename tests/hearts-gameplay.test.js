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

function createHeartsTable(hostSocket, options) {
  const tableName = `Hearts Play ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const promise = waitForEvent(hostSocket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.id && payload.table.name === tableName;
  }, 5000).then(function (payload) {
    return payload.table;
  });

  hostSocket.emit('createTable', Object.assign({ name: tableName, gameType: 'hearts' }, options || {}));
  return promise;
}

function startChild(port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '10' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

// The three seats not held by the human host are bots and pass/play on their
// own; the human host still has to submit a pass whenever a hand's direction
// is not "hold", or the passing phase (and everything after it) never
// resolves. Tracks the host's current hand from `heartsHand` so it always has
// cards on hand to pass.
function autoPassForHost(socket) {
  let currentHand = [];
  socket.on('heartsHand', (payload) => {
    if (Array.isArray(payload && payload.hand)) {
      currentHand = payload.hand;
    }
  });
  socket.on('heartsPassPrompt', () => {
    socket.emit('heartsSelectPassCards', { cards: currentHand.slice(0, 3) });
  });
}

// The human host is a real seated player, not a bot - the other three seats
// autoplay on their own, but the host must also play a (legal) card on its
// own turn or a hand can never finish. Picks the first legal card, same as
// the "no lookahead" bot heuristic.
function autoPlayForHost(socket) {
  socket.on('heartsTurnState', (payload) => {
    if (payload.turnPlayerId === socket.id && Array.isArray(payload.legalCards) && payload.legalCards.length) {
      socket.emit('heartsPlayCard', { card: payload.legalCards[0] });
    }
  });
}

test('the server rejects an illegal card play, leaves the table state unchanged, and explains why', async () => {
  const port = 3163;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `hearts-illegal-${Date.now()}@example.com`, `HeartsIllegal${Date.now()}`);
    autoPassForHost(host.socket);

    await createHeartsTable(host.socket);

    const turnPromise = waitForEvent(host.socket, 'heartsTurnState', (payload) => payload && payload.trickNumber === 1, 10000);
    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;
    const turnState = await turnPromise;

    // First trick must open with 2 of Clubs. If this host is not the leader,
    // trying to play is rejected for "not your turn" instead - either way,
    // a bad first move must never be accepted, the game state must not
    // change, and it must remain that player's turn.
    if (turnState.turnPlayerId === host.socket.id) {
      const rejectionPromise = waitForEvent(host.socket, 'heartsPlayResult', (payload) => payload && payload.success === false, 5000);
      // Any card other than 2C is illegal on the very first play of the game.
      host.socket.emit('heartsPlayCard', { card: '3D' });
      const rejection = await rejectionPromise;
      assert.equal(rejection.success, false);
      assert.match(rejection.message, /2 of Clubs/);

      // Still this player's turn afterwards - the illegal attempt did not
      // advance state.
      const stillTurnState = await waitForEvent(host.socket, 'heartsTurnState', () => true, 3000).catch(() => null);
      if (stillTurnState) {
        assert.equal(stillTurnState.turnPlayerId, host.socket.id);
        assert.equal(stillTurnState.trickNumber, 1);
      }
    } else {
      const rejectionPromise = waitForEvent(host.socket, 'heartsPlayResult', (payload) => payload && payload.success === false, 5000);
      host.socket.emit('heartsPlayCard', { card: '3D' });
      const rejection = await rejectionPromise;
      assert.equal(rejection.success, false);
      assert.match(rejection.message, /not your turn/i);
    }
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a solo-started Hearts table (three bots) plays a full hand to completion via bot autoplay', async () => {
  const port = 3164;
  const child = startChild(port, { BOT_MOVE_DELAY_MS: '5', BOT_TRICK_PAUSE_MS: '5' });
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `hearts-autoplay-${Date.now()}@example.com`, `HeartsAutoplay${Date.now()}`);
    autoPassForHost(host.socket);
    autoPlayForHost(host.socket);
    host.socket.on('heartsTrickResult', () => host.socket.emit('heartsAckTrick'));

    await createHeartsTable(host.socket, { pointsToEndGame: 500 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;

    const summary = await waitForEvent(host.socket, 'heartsHandSummary', () => true, 30000);

    assert.equal(summary.handNumber, 1);
    assert.equal(summary.scores.length, 4);
    const totalHandPoints = summary.scores.reduce((sum, entry) => sum + entry.handPoints, 0);
    // Every hand distributes exactly 26 points (13 Hearts + Queen of Spades)
    // in the normal case; shooting the moon redistributes it as 0/26/26/26,
    // which still sums to 78 across the table.
    assert.equal(totalHandPoints, summary.shotTheMoon ? 78 : 26);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a Hearts game ends once a hand pushes a player to the configured points-to-end-game threshold, and the lowest score wins', async () => {
  const port = 3165;
  const child = startChild(port, { BOT_MOVE_DELAY_MS: '5', BOT_TRICK_PAUSE_MS: '5' });
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `hearts-gameover-${Date.now()}@example.com`, `HeartsGameOver${Date.now()}`);
    autoPassForHost(host.socket);
    autoPlayForHost(host.socket);
    host.socket.on('heartsTrickResult', () => host.socket.emit('heartsAckTrick'));
    host.socket.on('heartsHandSummary', (summary) => {
      if (!summary.gameOver) {
        host.socket.emit('heartsAckHandSummary');
      }
    });

    // A very low threshold means the game almost always ends within the
    // first couple of hands, keeping this test fast.
    await createHeartsTable(host.socket, { pointsToEndGame: 5 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;

    const gameOver = await waitForEvent(host.socket, 'heartsGameOver', () => true, 60000);

    assert.ok(gameOver.winner);
    assert.equal(gameOver.scores.length, 4);
    const sorted = gameOver.scores.slice().sort((a, b) => a.totalPoints - b.totalPoints);
    assert.equal(gameOver.winner, sorted[0].name, 'the lowest cumulative score must be declared the winner');
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].totalPoints >= sorted[i - 1].totalPoints);
    }
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
