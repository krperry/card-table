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

function createTable(hostSocket, options) {
  // Use a name-matching predicate (rather than socket.once) because a host socket
  // that already owns a table emits a transient `tableState: null` (from
  // leaveCurrentTable's switch-table cleanup) before the real one for the new
  // table arrives - a `.once` listener would consume that null event and never
  // see the real one.
  const tableName = `Bot Table ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const promise = waitForEvent(hostSocket, 'tableState', function (payload) {
    return payload && payload.table && payload.table.id && payload.table.name === tableName;
  }, 5000).then(function (payload) {
    return payload.table;
  });

  hostSocket.emit('createTable', Object.assign({
    name: tableName,
    gameType: 'uno'
  }, options || {}));

  return promise;
}

function startChild(port, extraEnv) {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'test', BOT_MOVE_DELAY_MS: '40' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('createTable clamps and stores computer player settings', async () => {
  const port = 3140;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-settings-${Date.now()}@example.com`, `BotSettings${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 9, computerSkill: 'not-a-level' });
    assert.equal(table.matchSettings.computerPlayers, 5, 'computerPlayers should clamp to the max of 5');
    assert.equal(table.matchSettings.computerSkill, 'random', 'invalid skill should fall back to random');

    const tableTwo = await createTable(host.socket, { computerPlayers: 2, computerSkill: '3' });
    assert.equal(tableTwo.matchSettings.computerPlayers, 2);
    assert.equal(tableTwo.matchSettings.computerSkill, '3');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('starting a game with 2 humans and 3 requested computer players seats exactly 5 players', async () => {
  const port = 3141;
  const child = startChild(port);
  let host;
  let guest;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-count-host-${Date.now()}@example.com`, `BotCountHost${Date.now()}`);
    guest = await connectAndRegister(port, `bot-count-guest-${Date.now()}@example.com`, `BotCountGuest${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 3, computerSkill: '2' });
    guest.socket.emit('joinTable', { tableId: table.id });
    await waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 2, 5000);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.players.length, 5, 'issue example: 2 humans + 3 computer players requested = 5 total');

    const bots = inGameTable.players.filter((player) => player.isBot);
    assert.equal(bots.length, 3);

    const names = inGameTable.players.map((player) => player.name);
    const uniqueNames = new Set(names);
    assert.equal(uniqueNames.size, names.length, 'no two players (bot or human) should share a name');

    const botNames = bots.map((bot) => bot.name);
    assert.equal(new Set(botNames).size, 3, 'the 3 computer players must not share a name with each other');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    if (guest && guest.socket.connected) {
      guest.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('computer player count is capped so the table never exceeds 6 total players', async () => {
  const port = 3142;
  const child = startChild(port);
  let host;
  let guestOne;
  let guestTwo;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-cap-host-${Date.now()}@example.com`, `BotCapHost${Date.now()}`);
    guestOne = await connectAndRegister(port, `bot-cap-g1-${Date.now()}@example.com`, `BotCapGuest1${Date.now()}`);
    guestTwo = await connectAndRegister(port, `bot-cap-g2-${Date.now()}@example.com`, `BotCapGuest2${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 5, computerSkill: '1' });
    guestOne.socket.emit('joinTable', { tableId: table.id });
    guestTwo.socket.emit('joinTable', { tableId: table.id });
    await waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 3, 5000);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.players.length, 6, '3 humans + 5 requested bots must cap at the 6-player table max');
    assert.equal(inGameTable.players.filter((player) => player.isBot).length, 3);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    if (guestOne && guestOne.socket.connected) {
      guestOne.socket.disconnect();
    }
    if (guestTwo && guestTwo.socket.connected) {
      guestTwo.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a solo host can start a game against computer players', async () => {
  const port = 3143;
  const child = startChild(port);
  let host;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-solo-${Date.now()}@example.com`, `BotSolo${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 1, computerSkill: '2' });
    assert.equal(table.players.length, 1);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    assert.equal(inGameTable.status, 'in_game');
    assert.equal(inGameTable.players.length, 2, 'a lone host plus 1 requested computer player should be enough to start');
    assert.equal(inGameTable.players.filter((player) => player.isBot).length, 1);
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a computer player automatically plays a legal card without any client input', async () => {
  const port = 3144;
  const child = startChild(port);
  let host;
  let guest;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-play-host-${Date.now()}@example.com`, `BotPlayHost${Date.now()}`);
    guest = await connectAndRegister(port, `bot-play-guest-${Date.now()}@example.com`, `BotPlayGuest${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 1, computerSkill: '2' });
    guest.socket.emit('joinTable', { tableId: table.id });
    await waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 2, 5000);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const bot = inGameTable.players.find((player) => player.isBot);
    assert.ok(bot, 'expected a computer player to have been seated');
    const botIndex = inGameTable.players.findIndex((player) => player.id === bot.id);

    // Red 1 (card 1) and Red 5 (card 5): both legal against a Red 0 board card.
    // Skill 2 always sheds its highest point-value legal card, so this is
    // deterministic - the bot must play card 5 and keep card 1.
    const sendCardPromise = waitForEvent(host.socket, 'sendCard', (payload) => payload && payload.card === 5, 5000);

    host.socket.emit('__testSetTableState', {
      tableId: table.id,
      status: 'in_game',
      game: {
        turn: botIndex,
        reverse: 0,
        cardOnBoard: 0,
        chosenColor: null,
        deck: [20, 21, 22, 23, 24, 25],
        stack: {
          active: false,
          type: null,
          penalty: 0,
          activeColor: null,
          lastPlayerId: null,
          lastPlayerName: '',
          respondingPlayerId: null,
          respondingPlayerName: ''
        },
        locked: false,
        hasDrawn: false
      },
      players: [
        { id: bot.id, hand: [1, 5] }
      ],
      emitDiscardCard: true,
      emitTurnPlayer: true
    });

    await sendCardPromise;

    const afterPlayState = await waitForEvent(host.socket, 'tableState', (payload) => {
      const botEntry = payload && payload.table && payload.table.players.find((player) => player.id === bot.id);
      return !!botEntry && botEntry.cardCount === 1;
    }, 5000);

    const botEntry = afterPlayState.table.players.find((player) => player.id === bot.id);
    assert.equal(botEntry.cardCount, 1, 'the bot should have played exactly one card on its own');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    if (guest && guest.socket.connected) {
      guest.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});

test('a computer player automatically draws and passes when it has no legal card', async () => {
  const port = 3145;
  const child = startChild(port);
  let host;
  let guest;

  try {
    await waitForServer(child, port);
    host = await connectAndRegister(port, `bot-draw-host-${Date.now()}@example.com`, `BotDrawHost${Date.now()}`);
    guest = await connectAndRegister(port, `bot-draw-guest-${Date.now()}@example.com`, `BotDrawGuest${Date.now()}`);

    const table = await createTable(host.socket, { computerPlayers: 1, computerSkill: '2' });
    guest.socket.emit('joinTable', { tableId: table.id });
    await waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.players.length === 2, 5000);

    const inGamePromise = waitForEvent(host.socket, 'tableState', (payload) => payload && payload.table && payload.table.status === 'in_game', 5000);
    host.socket.emit('startGame');
    const inGameTable = (await inGamePromise).table;

    const bot = inGameTable.players.find((player) => player.isBot);
    const botIndex = inGameTable.players.findIndex((player) => player.id === bot.id);

    // Board is Red 0. Bot holds only Yellow 1 / Yellow 2 (cards 15, 16) - neither
    // matches color or type, so it must draw. The deck's next card, Yellow 3
    // (card 17), is also unplayable, so the draw must pass the turn deterministically.
    const turnTransitionPromise = waitForEvent(host.socket, 'turnTransition', (payload) => payload && payload.action === 'draw_pass' && payload.actorId === bot.id, 5000);
    // Registered before the rig fires, alongside turnTransitionPromise - the server
    // emits tableState (with the drawn card already counted) before turnTransition,
    // so waiting to attach this listener until after turnTransitionPromise resolves
    // would miss it.
    const afterDrawStatePromise = waitForEvent(host.socket, 'tableState', (payload) => {
      const botEntry = payload && payload.table && payload.table.players.find((player) => player.id === bot.id);
      return !!botEntry && botEntry.cardCount === 3;
    }, 5000);

    host.socket.emit('__testSetTableState', {
      tableId: table.id,
      status: 'in_game',
      game: {
        turn: botIndex,
        reverse: 0,
        cardOnBoard: 0,
        chosenColor: null,
        deck: [17, 20, 21, 22, 23, 24],
        stack: {
          active: false,
          type: null,
          penalty: 0,
          activeColor: null,
          lastPlayerId: null,
          lastPlayerName: '',
          respondingPlayerId: null,
          respondingPlayerName: ''
        },
        locked: false,
        hasDrawn: false
      },
      players: [
        { id: bot.id, hand: [15, 16] }
      ],
      emitDiscardCard: true,
      emitTurnPlayer: true
    });

    await turnTransitionPromise;

    const afterDrawState = await afterDrawStatePromise;

    const botEntry = afterDrawState.table.players.find((player) => player.id === bot.id);
    assert.equal(botEntry.cardCount, 3, 'the bot should have drawn one card on its own (2 -> 3)');
  } finally {
    if (host && host.socket.connected) {
      host.socket.disconnect();
    }
    if (guest && guest.socket.connected) {
      guest.socket.disconnect();
    }
    child.kill('SIGTERM');
  }
});
