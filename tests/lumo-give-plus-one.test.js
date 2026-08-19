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

async function setupThreePlayerGame(port, tableName) {
  const host = await connectAndRegister(port, `give-host-${Date.now()}@example.com`, `GiveHost${Date.now()}`);
  const guestOne = await connectAndRegister(port, `give-g1-${Date.now()}@example.com`, `GiveGuest1${Date.now()}`);
  const guestTwo = await connectAndRegister(port, `give-g2-${Date.now()}@example.com`, `GiveGuest2${Date.now()}`);

  const createdTable = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out creating table')), 5000);
    host.socket.once('tableState', (payload) => {
      if (!payload || !payload.table || !payload.table.id) {
        return;
      }
      clearTimeout(timeout);
      resolve(payload.table);
    });
    host.socket.emit('createTable', { name: tableName, gameType: 'uno' });
  });

  guestOne.socket.emit('joinTable', { tableId: createdTable.id });
  guestTwo.socket.emit('joinTable', { tableId: createdTable.id });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const inGameStatePromise = waitForEvent(host.socket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.status === 'in_game';
  }, 5000);
  host.socket.emit('startGame');
  await inGameStatePromise;

  return { host, guestOne, guestTwo, tableId: createdTable.id };
}

function setTableState(socket, payload) {
  return new Promise((resolve) => {
    socket.emit('__testSetTableState', payload);
    setTimeout(resolve, 250);
  });
}

test('a Give Plus One card can be legally played and transfers the chosen card to the next player', async () => {
  const port = 3120;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guestOne;
  let guestTwo;

  try {
    await waitForServer(child, port);
    const setup = await setupThreePlayerGame(port, `Give Plus One ${Date.now()}`);
    host = setup.host;
    guestOne = setup.guestOne;
    guestTwo = setup.guestTwo;

    await setTableState(host.socket, {
      tableId: setup.tableId,
      status: 'in_game',
      game: {
        turn: 0,
        reverse: 0,
        cardOnBoard: 3, // red 3
        chosenColor: null,
        deck: [4, 5, 6, 7, 8, 9, 10, 11],
        pendingGive: null,
        locked: false,
        hasDrawn: false
      },
      players: [
        { id: host.socket.id, hand: [1000, 5, 9] }, // red Give Plus One, red 5, red 9
        { id: guestOne.socket.id, hand: [21, 22] },
        { id: guestTwo.socket.id, hand: [35, 36] }
      ],
      emitDiscardCard: true,
      emitTurnPlayer: true
    });

    const promptPromise = waitForEvent(host.socket, 'giveCardPrompt', () => true, 5000);
    const bystanderNoticePromise = waitForEvent(guestTwo.socket, 'actionNotice', function (message) {
      return typeof message === 'string' && /Give Plus One/i.test(message);
    }, 5000);

    host.socket.emit('playCard', { card: 1000 });

    const prompt = await promptPromise;
    assert.match(prompt.toPlayerName, new RegExp(guestOne.payload.name));

    const bystanderNotice = await bystanderNoticePromise;
    assert.doesNotMatch(bystanderNotice, /\b5\b/); // must not reveal which card will be given

    // Turn must not have advanced yet - the giver still cannot draw or play again.
    const rejectedDraw = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for drawResult')), 5000);
      host.socket.once('drawResult', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      host.socket.emit('drawCard');
    });
    assert.equal(rejectedDraw.success, false);

    // Giving away the card that was just played (now on the discard pile) must be rejected.
    const rejectedGive = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for playResult')), 5000);
      host.socket.once('playResult', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      host.socket.emit('submitGiveCard', { card: 1000 });
    });
    assert.equal(rejectedGive.success, false);

    const giverMessagePromise = waitForEvent(host.socket, 'turnTransition', function (payload) {
      return payload && payload.action === 'give_resolve';
    }, 5000);
    const receiverMessagePromise = waitForEvent(guestOne.socket, 'turnTransition', function (payload) {
      return payload && payload.action === 'give_resolve';
    }, 5000);
    const bystanderMessagePromise = waitForEvent(guestTwo.socket, 'turnTransition', function (payload) {
      return payload && payload.action === 'give_resolve';
    }, 5000);
    const receiverHandPromise = waitForEvent(guestOne.socket, 'haveCard', function (hand) {
      return Array.isArray(hand) && hand.indexOf(5) !== -1;
    }, 5000);
    const nextTurnPromise = waitForEvent(guestOne.socket, 'turnPlayer', function (payload) {
      return payload && payload.id === guestOne.socket.id;
    }, 5000);
    // The giver started with 3 cards (1000, 5, 9): playing the Give Plus One left 2,
    // and giving away card 5 leaves exactly 1 - this must be announced as Lumo.
    const lumoNoticePromise = waitForEvent(guestTwo.socket, 'actionNotice', function (message) {
      return typeof message === 'string' && /says Lumo/i.test(message);
    }, 5000);

    host.socket.emit('submitGiveCard', { card: 5 });

    const [giverMessage, receiverMessage, bystanderMessage, receiverHand, nextTurn, lumoNotice] = await Promise.all([
      giverMessagePromise, receiverMessagePromise, bystanderMessagePromise, receiverHandPromise, nextTurnPromise, lumoNoticePromise
    ]);

    assert.match(giverMessage.message, /You pass .*5 red/i);
    assert.match(receiverMessage.message, /passes .*5 red.* to you/i);
    // A bystander (neither the giver nor the receiver) must not learn the
    // identity of the privately-given card.
    assert.match(bystanderMessage.message, /passes a card to/i);
    assert.doesNotMatch(bystanderMessage.message, /5 red/i);
    assert.ok(receiverHand.indexOf(5) !== -1);
    assert.equal(nextTurn.id, guestOne.socket.id);
    assert.equal(giverMessage.actorHasUno, true, 'giver ending with one card must be flagged as having Lumo');
    assert.match(lumoNotice, new RegExp(host.payload.name + ' says Lumo', 'i'));
  } finally {
    if (host && host.socket.connected) host.socket.disconnect();
    if (guestOne && guestOne.socket.connected) guestOne.socket.disconnect();
    if (guestTwo && guestTwo.socket.connected) guestTwo.socket.disconnect();
    child.kill('SIGTERM');
  }
});

test('playing the last card as a Give Plus One wins the round without prompting for a transfer', async () => {
  const port = 3121;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guestOne;
  let guestTwo;

  try {
    await waitForServer(child, port);
    const setup = await setupThreePlayerGame(port, `Give Plus One Win ${Date.now()}`);
    host = setup.host;
    guestOne = setup.guestOne;
    guestTwo = setup.guestTwo;

    await setTableState(host.socket, {
      tableId: setup.tableId,
      status: 'in_game',
      game: {
        turn: 0,
        reverse: 0,
        cardOnBoard: 3,
        chosenColor: null,
        deck: [4, 5, 6, 7],
        pendingGive: null,
        locked: false,
        hasDrawn: false
      },
      players: [
        { id: host.socket.id, hand: [1000] }, // only the Give Plus One left
        { id: guestOne.socket.id, hand: [21, 22] },
        { id: guestTwo.socket.id, hand: [35, 36] }
      ],
      emitDiscardCard: true,
      emitTurnPlayer: true
    });

    let promptFired = false;
    host.socket.once('giveCardPrompt', function () {
      promptFired = true;
    });

    const roundSummaryPromise = waitForEvent(host.socket, 'roundSummary', () => true, 5000);
    host.socket.emit('playCard', { card: 1000 });
    const roundSummary = await roundSummaryPromise;

    assert.equal(roundSummary.winner, host.payload.name);
    assert.equal(roundSummary.reason, 'all_cards_played');
    assert.equal(promptFired, false, 'must not prompt for a transfer when there are no cards left to give');
  } finally {
    if (host && host.socket.connected) host.socket.disconnect();
    if (guestOne && guestOne.socket.connected) guestOne.socket.disconnect();
    if (guestTwo && guestTwo.socket.connected) guestTwo.socket.disconnect();
    child.kill('SIGTERM');
  }
});

test('a Give Plus One that would leave exactly one card keeps that card instead of giving it away', async () => {
  const port = 3122;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let host;
  let guestOne;
  let guestTwo;

  try {
    await waitForServer(child, port);
    const setup = await setupThreePlayerGame(port, `Give Plus One Keep ${Date.now()}`);
    host = setup.host;
    guestOne = setup.guestOne;
    guestTwo = setup.guestTwo;

    await setTableState(host.socket, {
      tableId: setup.tableId,
      status: 'in_game',
      game: {
        turn: 0,
        reverse: 0,
        cardOnBoard: 3,
        chosenColor: null,
        deck: [4, 5, 6, 7],
        pendingGive: null,
        locked: false,
        hasDrawn: false
      },
      players: [
        { id: host.socket.id, hand: [1000, 5] }, // Give Plus One + one other card
        { id: guestOne.socket.id, hand: [21, 22] },
        { id: guestTwo.socket.id, hand: [35, 36] }
      ],
      emitDiscardCard: true,
      emitTurnPlayer: true
    });

    let promptFired = false;
    host.socket.once('giveCardPrompt', function () {
      promptFired = true;
    });

    const lumoNoticePromise = waitForEvent(host.socket, 'actionNotice', function (message) {
      return typeof message === 'string' && /says Lumo/i.test(message);
    }, 5000);
    const nextTurnPromise = waitForEvent(guestOne.socket, 'turnPlayer', function (payload) {
      return payload && payload.id === guestOne.socket.id;
    }, 5000);

    host.socket.emit('playCard', { card: 1000 });

    const [lumoNotice, nextTurn] = await Promise.all([lumoNoticePromise, nextTurnPromise]);
    assert.match(lumoNotice, /says Lumo/i);
    assert.doesNotMatch(lumoNotice, /UNO/i);
    assert.equal(nextTurn.id, guestOne.socket.id);
    assert.equal(promptFired, false, 'a Give Plus One that would empty the hand to one card must not prompt for a transfer');
  } finally {
    if (host && host.socket.connected) host.socket.disconnect();
    if (guestOne && guestOne.socket.connected) guestOne.socket.disconnect();
    if (guestTwo && guestTwo.socket.connected) guestTwo.socket.disconnect();
    child.kill('SIGTERM');
  }
});
