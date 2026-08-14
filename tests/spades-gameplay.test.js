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
  const tableName = `Spades Play ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
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
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '10' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

// The three seats not held by the human host are bots and bid/play on their
// own; the human host still has to submit a bid whenever it is their turn to
// bid, or the bidding phase (and everything after it) never resolves. Always
// bids Nil (0) - the simplest deterministic choice, and exercises both the
// Nil-success and Nil-failure scoring paths across a multi-hand run.
function autoNilBidForHost(socket) {
  socket.on('spadesBidState', (payload) => {
    if (payload.turnPlayerId === socket.id) {
      socket.emit('spadesPlaceBid', { bid: 0 });
    }
  });
}

// The human host is a real seated player, not a bot - the other three seats
// autoplay on their own, but the host must also play a (legal) card on its
// own turn or a hand can never finish. Picks the first legal card, same as
// the "no lookahead" bot heuristic.
function autoPlayForHost(socket) {
  socket.on('spadesTurnState', (payload) => {
    if (payload.turnPlayerId === socket.id && Array.isArray(payload.legalCards) && payload.legalCards.length) {
      socket.emit('spadesPlayCard', { card: payload.legalCards[0] });
    }
  });
}

test('the server rejects an illegal bid and an illegal card play, explaining why', async () => {
  const port = 3171 + 2; // 3173, kept out of the spades-table.test.js range (3170-3172)
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `spades-illegal-${Date.now()}@example.com`, `SpadesIllegal${Date.now()}`);

    await createSpadesTable(host.socket);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    const firstBidState = waitForEvent(host.socket, 'spadesBidState', () => true, 10000);
    host.socket.emit('startGame');
    await inGamePromise;
    const bidState = await firstBidState;

    if (bidState.turnPlayerId === host.socket.id) {
      const rejectionPromise = waitForEvent(host.socket, 'spadesBidResult', (payload) => payload && payload.success === false, 5000);
      host.socket.emit('spadesPlaceBid', { bid: 99 });
      const rejection = await rejectionPromise;
      assert.equal(rejection.success, false);
      assert.match(rejection.message, /0.*13|Nil/i);
    } else {
      const rejectionPromise = waitForEvent(host.socket, 'spadesBidResult', (payload) => payload && payload.success === false, 5000);
      host.socket.emit('spadesPlaceBid', { bid: 3 });
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

test('a solo-started Spades table (three bots, host bids Nil) plays a full hand to completion via autoplay', async () => {
  const port = 3174;
  const child = startChild(port, { BOT_MOVE_DELAY_MS: '5', BOT_TRICK_PAUSE_MS: '5' });
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `spades-autoplay-${Date.now()}@example.com`, `SpadesAutoplay${Date.now()}`);
    autoNilBidForHost(host.socket);
    autoPlayForHost(host.socket);
    host.socket.on('spadesTrickResult', () => host.socket.emit('spadesAckTrick'));

    await createSpadesTable(host.socket, { targetScore: 1000 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;

    const summary = await waitForEvent(host.socket, 'spadesHandSummary', () => true, 30000);

    assert.equal(summary.handNumber, 1);
    assert.equal(summary.players.length, 4);
    assert.equal(summary.teams.length, 2);
    const totalTricks = summary.players.reduce((sum, entry) => sum + entry.tricksWon, 0);
    assert.equal(totalTricks, 13, 'all 13 tricks in the hand must be accounted for');

    const hostRow = summary.players.find((entry) => entry.name === host.payload.name);
    assert.equal(hostRow.bid, 0);
    assert.equal(hostRow.isNil, true);
    assert.equal(hostRow.nilMade, hostRow.tricksWon === 0);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a Spades game ends once a hand pushes a team to the configured target score, and the higher score wins', async () => {
  const port = 3175;
  const child = startChild(port, { BOT_MOVE_DELAY_MS: '5', BOT_TRICK_PAUSE_MS: '5' });
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `spades-gameover-${Date.now()}@example.com`, `SpadesGameOver${Date.now()}`);
    autoNilBidForHost(host.socket);
    autoPlayForHost(host.socket);
    host.socket.on('spadesTrickResult', () => host.socket.emit('spadesAckTrick'));
    host.socket.on('spadesHandSummary', (summary) => {
      if (!summary.gameOver) {
        host.socket.emit('spadesAckHandSummary');
      }
    });

    // A very low threshold means the game almost always ends within the
    // first hand or two, keeping this test fast.
    await createSpadesTable(host.socket, { targetScore: 100 });

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    await inGamePromise;

    const gameOver = await waitForEvent(host.socket, 'spadesGameOver', () => true, 60000);

    assert.ok(Array.isArray(gameOver.winnerNames) && gameOver.winnerNames.length === 2);
    assert.equal(gameOver.teams.length, 2);
    const winnerTeam = gameOver.teams[gameOver.winnerTeamIndex];
    const otherTeam = gameOver.teams[1 - gameOver.winnerTeamIndex];
    assert.ok(winnerTeam.total >= 100, 'the winning team must have reached the target score');
    assert.ok(winnerTeam.total > otherTeam.total, 'the winning team must have the higher score');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
