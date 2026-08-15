const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const app = express();
const http = require('http').Server(app);
// Restricts which web pages are allowed to open a live connection to this
// server. Set ORIGIN_ALLOWLIST to a comma-separated list of the site(s)
// players actually load the page from, written exactly as a browser's
// Origin header would show it - "https://cardtable.example.com" with no
// port (browsers omit the default 80/443), or "http://203.0.113.5:4123"
// when the port isn't the protocol's default - before deploying anywhere
// public. Left unset, every origin is allowed (today's behavior), since the
// deployment address isn't known yet.
//
// This uses engine.io's `allowRequest` hook rather than Socket.IO's `cors`
// option on purpose: `cors` only controls which Access-Control-Allow-Origin
// header gets sent back, which is a promise the *browser* enforces on the
// caller's behalf - it does nothing against a client that simply ignores
// CORS. allowRequest actually rejects the handshake on the server before a
// connection is ever established, regardless of what kind of client is
// asking.
const ORIGIN_ALLOWLIST = process.env.ORIGIN_ALLOWLIST
  ? process.env.ORIGIN_ALLOWLIST.split(',').map(function (origin) { return origin.trim(); }).filter(Boolean)
  : null;
const io = require('socket.io')(http, Object.assign(
  {
    // Mobile Safari can pause background tabs, delaying heartbeat responses.
    // Allow a longer window so brief focus loss does not eject active players.
    pingInterval: 25000,
    pingTimeout: 300000
  },
  ORIGIN_ALLOWLIST ? {
    allowRequest: function (req, callback) {
      const origin = req.headers.origin;
      callback(null, !!origin && ORIGIN_ALLOWLIST.indexOf(origin) !== -1);
    }
  } : {}
));

const port = process.env.PORT || 4123;
const DISCONNECT_GRACE_MS = Math.max(1000, parseInt(process.env.DISCONNECT_GRACE_MS || '45000', 10));
// Twenty distinct first names bots are drawn from - pickBotNames() takes a
// unique subset per table so no two computer players ever share a name.
const BOT_NAME_POOL = [
  'Ava', 'Milo', 'Nora', 'Kai', 'Luna', 'Theo', 'Zoe', 'Finn', 'Ivy', 'Owen',
  'Maya', 'Leo', 'Nina', 'Jasper', 'Ruby', 'Silas', 'Wren', 'Axel', 'Piper', 'Dash'
];
// Real account data (emails, password hashes) must never land in the repo's
// data/ directory during a test run. ACCOUNT_FILE_PATH can be overridden
// directly, and NODE_ENV=test (set by every integration test that spawns
// this server) falls back to a per-process file in the OS temp directory
// instead of the real accounts.json.
const ACCOUNT_FILE_PATH = process.env.ACCOUNT_FILE_PATH
  ? path.resolve(process.env.ACCOUNT_FILE_PATH)
  : process.env.NODE_ENV === 'test'
    ? path.join(os.tmpdir(), 'card-table-test-accounts-' + process.pid + '.json')
    : path.join(__dirname, 'data', 'accounts.json');
const LOG_FILE_PATH = path.join(__dirname, 'logs', 'server.log');
const DEFAULT_GAME_TYPE = 'uno';
// GAME_DEFINITIONS/GAME_MODULES are assembled further down (see "Game module
// registry" below) once the shared primitives they depend on (shuffle,
// emitTableState, etc.) are defined. normalizeGameType()/getGameDefinition()
// below don't run until a real request comes in, by which point the module
// has finished its synchronous top-to-bottom load, so referencing
// GAME_DEFINITIONS here ahead of its assignment is safe.
let GAME_DEFINITIONS = {};

function ensureLogDir() {
  const dirPath = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Sync append so a crash's log line is guaranteed to hit disk before the
// process exits (an async write could otherwise be lost).
function writeLogLine(level, message, details) {
  ensureLogDir();
  const entry = { time: new Date().toISOString(), level: level, message: message };
  if (details !== undefined) {
    entry.details = details;
  }

  try {
    fs.appendFileSync(LOG_FILE_PATH, JSON.stringify(entry) + '\n');
  } catch (writeError) {
    console.error('Failed to write to log file:', writeError);
  }

  const consoleFn = level === 'error' ? console.error : console.warn;
  consoleFn('[' + entry.time + '] ' + level.toUpperCase() + ': ' + message, details !== undefined ? details : '');
}

function logServerError(message, error, details) {
  writeLogLine('error', message, Object.assign({}, details, {
    error: error ? (error.stack || String(error)) : undefined
  }));
}

function logSocketWarning(message, details) {
  writeLogLine('warn', message, details);
}

// Last-resort net: without this, any exception thrown outside a wrapped
// socket handler (e.g. in a setTimeout callback) kills the whole process for
// every connected table with no record of why. Log full details, then exit -
// per-handler state may be corrupted so continuing is not safe.
process.on('uncaughtException', function (error) {
  logServerError('uncaughtException - server is exiting', error);
  process.exit(1);
});

process.on('unhandledRejection', function (reason) {
  logServerError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// Every script/style/image the page loads comes from this same server (no
// inline <script>/<style>, no third-party CDNs - see index.html/style.css),
// so the Content-Security-Policy can stay tight instead of allowing
// 'unsafe-inline' or external sources. upgradeInsecureRequests is turned off
// because this app is normally run behind a reverse proxy that terminates
// TLS (see README) - forcing it on would break plain-http local dev.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.static(__dirname + '/public'));
io.on('connection', onConnection);

io.engine.on('connection_error', function (error) {
  logSocketWarning('Socket.IO connection_error', {
    code: error && error.code,
    message: error && error.message,
    context: error && error.context
  });
});

const server = http.listen(port, function () {
  console.log('listening on port ' + port);
});

server.on('error', function (error) {
  if (error && error.code === 'EADDRINUSE') {
    console.error('Port ' + port + ' is already in use. Stop the other server instance and try again.');
  } else {
    console.error('Unable to start server:', error);
  }
  logServerError('HTTP server failed to start', error);
  process.exit(1);
});

let tableSequence = 1;
const tables = {};
const accounts = loadAccounts();
const disconnectGraceByAccountId = {};

function loadAccounts() {
  const dirPath = path.dirname(ACCOUNT_FILE_PATH);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  if (!fs.existsSync(ACCOUNT_FILE_PATH)) {
    const initial = { accounts: [] };
    fs.writeFileSync(ACCOUNT_FILE_PATH, JSON.stringify(initial, null, 2));
    return initial.accounts;
  }

  try {
    const raw = fs.readFileSync(ACCOUNT_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.accounts)) {
      return [];
    }
    return parsed.accounts;
  } catch (error) {
    console.error('Unable to read account database:', error);
    return [];
  }
}

function saveAccounts() {
  fs.writeFileSync(ACCOUNT_FILE_PATH, JSON.stringify({ accounts: accounts }, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt: salt, hash: hash };
}

function verifyPassword(password, salt, hash) {
  const derivedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return derivedHash === hash;
}

// Guards login/registerAccount/deleteAccount against automated password
// guessing: at most AUTH_RATE_LIMIT_MAX_ATTEMPTS calls per action+IP within
// AUTH_RATE_LIMIT_WINDOW_MS, then further attempts are rejected until the
// window rolls over. Both are overridable so tests can use a tight window
// instead of waiting a full minute.
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS || '10', 10));
const AUTH_RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '60000', 10));
const authAttemptsByKey = new Map();

function isAuthRateLimited(action, socket) {
  const key = action + ':' + (socket.handshake && socket.handshake.address ? socket.handshake.address : socket.id);
  const now = Date.now();
  const record = authAttemptsByKey.get(key);
  if (!record || now - record.windowStart >= AUTH_RATE_LIMIT_WINDOW_MS) {
    authAttemptsByKey.set(key, { windowStart: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > AUTH_RATE_LIMIT_MAX_ATTEMPTS;
}

// Sweeps expired entries periodically so long-running processes don't
// accumulate one Map entry per distinct IP forever. unref() so this timer
// never keeps the process (or a test's server) alive on its own.
setInterval(function () {
  const now = Date.now();
  authAttemptsByKey.forEach(function (record, key) {
    if (now - record.windowStart >= AUTH_RATE_LIMIT_WINDOW_MS) {
      authAttemptsByKey.delete(key);
    }
  });
}, AUTH_RATE_LIMIT_WINDOW_MS).unref();

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeDisplayName(displayName) {
  return typeof displayName === 'string' ? displayName.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findAccountByEmail(email) {
  const normalized = normalizeEmail(email);
  return accounts.find(function (account) {
    return account.emailLower === normalized;
  }) || null;
}

function findAccountByDisplayName(displayName) {
  const normalized = normalizeDisplayName(displayName);
  return accounts.find(function (account) {
    return account.displayNameLower === normalized;
  }) || null;
}

function attachSocketToAccount(socket, account) {
  socket.accountId = account.id;
  socket.accountEmail = account.email;
  socket.playerName = account.displayName;
  socket.displayNameLower = account.displayNameLower;
}

function clearSocketAuth(socket) {
  socket.accountId = null;
  socket.accountEmail = '';
  socket.playerName = '';
  socket.displayNameLower = '';
}

function normalizeGameType(gameType) {
  if (typeof gameType !== 'string') {
    return DEFAULT_GAME_TYPE;
  }

  const normalized = gameType.trim().toLowerCase();
  return GAME_DEFINITIONS[normalized] ? normalized : DEFAULT_GAME_TYPE;
}

function getGameDefinition(gameType) {
  return GAME_DEFINITIONS[normalizeGameType(gameType)] || GAME_DEFINITIONS[DEFAULT_GAME_TYPE];
}

function clampInteger(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

// Table access codes are always exactly 4 digits, or absent (open table). Returns
// { valid: false } for anything else so callers can reject the request outright.
function normalizeTableCode(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, code: null };
  }

  const str = String(raw).trim();
  if (str === '') {
    return { valid: true, code: null };
  }

  if (!/^\d{4}$/.test(str)) {
    return { valid: false, code: null };
  }

  return { valid: true, code: str };
}

function normalizeIndex(index, count) {
  if (count <= 0) {
    return 0;
  }

  const normalized = index % count;
  return normalized < 0 ? normalized + count : normalized;
}

function getPlayerIndex(table, socketId) {
  return table.players.findIndex(function (player) {
    return player.id === socketId;
  });
}

function findTableBySocket(socket) {
  if (!socket || !socket.tableId) {
    return null;
  }

  return tables[socket.tableId] || null;
}

function findPlayerSeatByAccountId(accountId) {
  if (!accountId) {
    return null;
  }

  const tableIds = Object.keys(tables);
  for (let i = 0; i < tableIds.length; i++) {
    const table = tables[tableIds[i]];
    const playerIndex = table.players.findIndex(function (player) {
      return player.accountId === accountId;
    });

    if (playerIndex >= 0) {
      return { table: table, playerIndex: playerIndex };
    }
  }

  return null;
}

function clearDisconnectGraceForAccount(accountId) {
  if (!accountId || !disconnectGraceByAccountId[accountId]) {
    return;
  }

  clearTimeout(disconnectGraceByAccountId[accountId].timeoutId);
  delete disconnectGraceByAccountId[accountId];
}

function shouldUseDisconnectGrace(reason) {
  return reason === 'ping timeout'
    || reason === 'transport close'
    || reason === 'transport error'
    || reason === 'io client disconnect'
    || reason === 'client namespace disconnect';
}

function scheduleDisconnectGrace(socket, reason) {
  if (!socket || !socket.accountId || !socket.tableId) {
    leaveCurrentTable(socket, 'disconnect');
    return;
  }

  const seat = findPlayerSeatByAccountId(socket.accountId);
  if (!seat) {
    leaveCurrentTable(socket, 'disconnect');
    return;
  }

  clearDisconnectGraceForAccount(socket.accountId);

  const graceSeconds = Math.round(DISCONNECT_GRACE_MS / 1000);
  io.to(seat.table.id).emit('actionNotice', socket.playerName + ' disconnected. Waiting up to ' + graceSeconds + ' seconds for reconnect.');

  const timeoutId = setTimeout(function () {
    delete disconnectGraceByAccountId[socket.accountId];
    leaveCurrentTable(socket, 'disconnect');
  }, DISCONNECT_GRACE_MS);

  disconnectGraceByAccountId[socket.accountId] = {
    timeoutId: timeoutId,
    tableId: socket.tableId,
    socketId: socket.id
  };
}

function reclaimSeatAfterReconnect(socket) {
  if (!socket || !socket.accountId) {
    return;
  }

  const graceEntry = disconnectGraceByAccountId[socket.accountId];
  const seat = findPlayerSeatByAccountId(socket.accountId);
  if (!seat) {
    clearDisconnectGraceForAccount(socket.accountId);
    return;
  }

  const table = seat.table;
  const player = table.players[seat.playerIndex];
  const previousSocketId = player.id;
  const hasPendingGrace = !!graceEntry;

  if (hasPendingGrace) {
    clearDisconnectGraceForAccount(socket.accountId);
  }

  if (previousSocketId === socket.id) {
    socket.tableId = table.id;
    socket.join(table.id);
    return;
  }

  player.id = socket.id;
  socket.tableId = table.id;
  socket.join(table.id);

  if (table.hostId === previousSocketId) {
    table.hostId = socket.id;
  }

  // emitTableState must go out before onReconnect's game-specific resync
  // events (haveCard, turnPlayer, etc.): those events assume the client has
  // already processed a 'tableState' and populated its local table object,
  // and several game clients write straight into fields on that object
  // (e.g. Lumo's turnPlayer handler sets appState.currentTable.stackState)
  // with no null check. Reversing this order let a reconnecting client
  // crash on whichever resync event arrived first.
  emitTableState(table);
  emitLobbySnapshotAll();

  const reconnectModule = GAME_MODULES[table.gameType];
  if (reconnectModule && reconnectModule.onReconnect) {
    reconnectModule.onReconnect(table, player, previousSocketId);
  }

  if (hasPendingGrace) {
    io.to(table.id).emit('actionNotice', player.name + ' reconnected');
  }
}

function createTableId() {
  const prefix = 'table';
  const suffix = tableSequence.toString().padStart(4, '0');
  tableSequence += 1;
  return prefix + suffix;
}

function shuffle(deck) {
  // crypto.randomInt(), not Math.random(): players trust the shuffle can't
  // be predicted or manipulated, and Math.random()'s internal state is not
  // cryptographically secure.
  for (let index = deck.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    const temp = deck[index];
    deck[index] = deck[swapIndex];
    deck[swapIndex] = temp;
  }
}

function hashRememberToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueRememberToken(account) {
  const rememberToken = crypto.randomBytes(32).toString('hex');
  account.rememberTokenHash = hashRememberToken(rememberToken);
  account.rememberTokenIssuedAt = new Date().toISOString();
  saveAccounts();
  return rememberToken;
}

function clearRememberToken(account) {
  if (!account) {
    return;
  }

  delete account.rememberTokenHash;
  delete account.rememberTokenIssuedAt;
  saveAccounts();
}

function findAccountByRememberToken(token) {
  if (!token) {
    return null;
  }

  const tokenHash = hashRememberToken(token);
  return accounts.find(function (account) {
    return account.rememberTokenHash === tokenHash;
  }) || null;
}

function pickBotNames(count, excludeNamesLower) {
  const available = BOT_NAME_POOL.filter(function (name) {
    return excludeNamesLower.indexOf(name.toLowerCase()) === -1;
  });
  const shuffled = available.slice();
  shuffle(shuffled);

  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(i < shuffled.length ? shuffled[i] : ('Bot' + (i + 1)));
  }
  return names;
}

function resolveBotSkillLevel(computerSkill) {
  if (computerSkill === 'random') {
    return 1 + Math.floor(Math.random() * 3);
  }
  const parsed = parseInt(computerSkill, 10);
  return [1, 2, 3].indexOf(parsed) !== -1 ? parsed : 2;
}

function addComputerPlayersToTable(table, botCount, computerSkill) {
  if (botCount <= 0) {
    return [];
  }

  const existingNamesLower = table.players.map(function (player) {
    return player.name.toLowerCase();
  });
  const botNames = pickBotNames(botCount, existingNamesLower);

  const bots = [];
  for (let i = 0; i < botCount; i++) {
    const bot = {
      id: 'bot_' + crypto.randomBytes(6).toString('hex'),
      accountId: null,
      name: botNames[i],
      hand: [],
      isBot: true,
      botSkill: resolveBotSkillLevel(computerSkill)
    };
    table.players.push(bot);
    table.scores[bot.name] = 0;
    bots.push(bot);
  }

  return bots;
}

function buildLobbySnapshot() {
  const list = Object.keys(tables).map(function (tableId) {
    const table = tables[tableId];
    const gameDefinition = getGameDefinition(table.gameType);
    return {
      id: table.id,
      name: table.name,
      hostName: table.hostName,
      status: table.status,
      gameType: table.gameType,
      gameName: gameDefinition.name,
      playerCount: table.players.length,
      maxPlayers: gameDefinition.maxPlayers,
      hasCode: !!table.securityCode
    };
  });

  list.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  return { tables: list };
}

function emitLobbySnapshotAll() {
  const snapshot = buildLobbySnapshot();
  io.emit('lobbySnapshot', snapshot);
}

function sendLobbySnapshot(socket) {
  socket.emit('lobbySnapshot', buildLobbySnapshot());
}

// Per-game state (matchSettings shape, stackState/givePendingState-equivalent
// extras, and per-player summary fields like cardCount/score) is supplied by
// GAME_MODULES[table.gameType] - see games/lumo and games/hearts. This keeps
// buildTableState() itself game-agnostic; it only knows the generic table
// shape (id/name/host/status/players) plus whatever the module contributes.
function buildTableState(table, socketId) {
  const gameDefinition = getGameDefinition(table.gameType);
  const gameModule = GAME_MODULES[table.gameType];
  const matchSettings = gameModule ? gameModule.getMatchSettings(table) : {};
  const extra = gameModule ? gameModule.buildTableStateExtra(table, socketId) : {};

  return {
    table: Object.assign({
      id: table.id,
      name: table.name,
      gameType: table.gameType,
      gameName: gameDefinition.name,
      hostId: table.hostId,
      hostName: table.hostName,
      status: table.status,
      roundNumber: table.status === 'in_game' && table.game ? (table.game.roundNumber || 1) : null,
      matchSettings: matchSettings,
      hasCode: !!table.securityCode,
      players: table.players.map(function (player) {
        const summary = gameModule ? gameModule.getPlayerSummaryFields(table, player) : {};
        return Object.assign({
          id: player.id,
          name: player.name,
          isBot: !!player.isBot
        }, summary);
      })
    }, extra),
    youAreHost: table.hostId === socketId
  };
}

function emitTableState(table) {
  table.players.forEach(function (player) {
    io.to(player.id).emit('tableState', buildTableState(table, player.id));
  });
}

// Bots have no real socket connection, so io.to(botId) below is always a no-op -
// this just mirrors socket.to(table.id).emit(...) (broadcast to the table except
// the actor) for code paths shared between real sockets and game-module bot calls.
function emitToTableExcept(table, exceptId, event, payload) {
  table.players.forEach(function (player) {
    if (player.id !== exceptId) {
      io.to(player.id).emit(event, payload);
    }
  });
}

function assignNewHostIfNeeded(table) {
  if (table.players.length === 0) {
    return;
  }

  const hostStillPresent = table.players.some(function (player) {
    return player.id === table.hostId;
  });

  if (!hostStillPresent) {
    const newHost = table.players.find(function (player) {
      return !player.isBot;
    }) || table.players[0];
    table.hostId = newHost.id;
    table.hostName = newHost.name;
    io.to(table.id).emit('actionNotice', table.hostName + ' is now table host');
  }
}

// Removes table.players[playerIndex] and settles everything that follows from a
// seat going away (returning cards to the deck, adjusting turn order, tearing the
// table down if no humans remain, or reassigning host/broadcasting state
// otherwise). Shared by a player leaving of their own accord and a host kicking
// someone else out - both are just "this seat is gone" from this point on. The
// game-specific parts of "what does removal mean for the current hand/round" are
// delegated to GAME_MODULES[table.gameType] (see onPlayerRemoved/onPlayerCountSettled
// in games/lumo and games/hearts).
function removePlayerFromTable(table, playerIndex) {
  const playerName = table.players[playerIndex].name;
  const gameModule = GAME_MODULES[table.gameType];
  if (gameModule && gameModule.onPlayerRemoved) {
    gameModule.onPlayerRemoved(table, playerIndex, playerName);
  }

  table.players.splice(playerIndex, 1);

  // A table left with only computer players (every human departed) has no one
  // left who can ever start a round or leave it, so tear it down rather than
  // leaving bots running against each other forever.
  const hasHumanPlayers = table.players.some(function (player) {
    return !player.isBot;
  });

  if (table.players.length === 0 || !hasHumanPlayers) {
    if (table.game && table.game.botTimer) {
      clearTimeout(table.game.botTimer);
    }
    delete tables[table.id];
    emitLobbySnapshotAll();
    return { playerName: playerName, tableDeleted: true };
  }

  assignNewHostIfNeeded(table);

  if (table.status === 'in_game' && gameModule && gameModule.onPlayerCountSettled) {
    const handledEmits = gameModule.onPlayerCountSettled(table);
    if (!handledEmits) {
      emitTableState(table);
      emitLobbySnapshotAll();
    }
  } else {
    emitTableState(table);
    emitLobbySnapshotAll();
  }

  return { playerName: playerName, tableDeleted: false };
}

function leaveCurrentTable(socket, reason) {
  const table = findTableBySocket(socket);
  if (!table) {
    return;
  }

  const playerIndex = getPlayerIndex(table, socket.id);
  if (playerIndex < 0) {
    socket.tableId = null;
    socket.leave(table.id);
    return;
  }

  const tableId = table.id;
  removePlayerFromTable(table, playerIndex);
  socket.leave(tableId);
  socket.tableId = null;

  if (reason !== 'disconnect') {
    socket.emit('tableState', null);
  }
}

function validatePlayerReady(socket) {
  if (!socket.playerName) {
    socket.emit('serverMessage', { type: 'error', message: 'Log in first' });
    return false;
  }
  return true;
}

// --- Game module registry ---
// Each playable game is a factory (games/lumo, games/hearts) that receives
// this small set of shared table/networking primitives and returns the
// game-module interface consumed above (buildTableState, removePlayerFromTable,
// reclaimSeatAfterReconnect) and below (onConnection's socket handler wiring).
const gameRegistry = require('./games/registry')({
  io: io,
  tables: tables,
  shuffle: shuffle,
  normalizeIndex: normalizeIndex,
  getPlayerIndex: getPlayerIndex,
  clampInteger: clampInteger,
  emitTableState: emitTableState,
  emitLobbySnapshotAll: emitLobbySnapshotAll,
  addComputerPlayersToTable: addComputerPlayersToTable,
  findTableBySocket: findTableBySocket
});
const GAME_MODULES = gameRegistry.modules;
GAME_DEFINITIONS = gameRegistry.definitions;


function onConnection(socket) {
  // Wrap every socket.on() registered below so a thrown exception in one
  // handler only fails that one action instead of crashing the entire
  // process (and every other table's game along with it).
  const rawSocketOn = socket.on.bind(socket);
  socket.on = function (event, handler) {
    return rawSocketOn(event, function () {
      try {
        return handler.apply(socket, arguments);
      } catch (error) {
        logServerError('Unhandled error in socket handler for "' + event + '"', error, {
          socketId: socket.id,
          playerName: socket.playerName || null,
          tableId: socket.tableId || null
        });
        socket.emit('serverMessage', { type: 'error', message: 'Something went wrong processing that action. Please try again.' });
      }
    });
  };

  socket.on('error', function (error) {
    logServerError('Socket-level error', error, { socketId: socket.id, playerName: socket.playerName || null });
  });

  clearSocketAuth(socket);
  socket.tableId = null;

  if (process.env.NODE_ENV === 'test') {
    // Test-only hook that lets integration tests set up a specific table/game
    // state without playing through it via real socket actions. The
    // game-shaped part of the payload (payload.game.*, plus any extra emits
    // the module wants to fire) is delegated to GAME_MODULES[gameType]'s
    // applyTestState() - see games/lumo/index.js and games/hearts/index.js.
    socket.on('__testSetTableState', function (payload) {
      const tableId = payload && payload.tableId;
      const table = tableId ? tables[tableId] : null;
      if (!table) {
        socket.emit('serverMessage', { type: 'error', message: 'Test table not found' });
        return;
      }

      const gameModule = GAME_MODULES[table.gameType];
      if (!gameModule) {
        socket.emit('serverMessage', { type: 'error', message: 'No game module for this table' });
        return;
      }

      if (!table.game && gameModule.initializeGameState) {
        gameModule.initializeGameState(table);
      }

      if (payload.matchSettings) {
        table.matchSettings = gameModule.normalizeMatchSettings({
          ...gameModule.getMatchSettings(table),
          ...payload.matchSettings
        });
      }

      if (typeof payload.status === 'string') {
        table.status = payload.status;
      }

      if (Array.isArray(payload.players)) {
        payload.players.forEach(function (entry) {
          const player = table.players.find(function (tablePlayer) {
            return tablePlayer.id === entry.id;
          });

          if (!player) {
            return;
          }

          if (Array.isArray(entry.hand)) {
            player.hand = entry.hand.slice();
          }
          if (typeof entry.name === 'string') {
            player.name = entry.name;
          }
        });
      }

      if (payload.scores && typeof payload.scores === 'object') {
        Object.keys(payload.scores).forEach(function (playerName) {
          table.scores[playerName] = payload.scores[playerName];
        });
      }

      if (gameModule.applyTestState) {
        gameModule.applyTestState(table, payload);
      }

      emitTableState(table);
    });
  }

  socket.on('resumeLogin', function (payload) {
    if (socket.accountId) {
      socket.emit('loginResult', { success: false, message: 'Already logged in' });
      return;
    }

    const rememberToken = payload && typeof payload.token === 'string' ? payload.token.trim() : '';
    const account = findAccountByRememberToken(rememberToken);

    if (!account) {
      socket.emit('loginResult', { success: false, message: 'Saved sign-in expired. Log in again.' });
      return;
    }

    attachSocketToAccount(socket, account);
    reclaimSeatAfterReconnect(socket);
    socket.emit('loginResult', {
      success: true,
      name: socket.playerName,
      email: socket.accountEmail,
      remembered: true
    });
    sendLobbySnapshot(socket);
  });

  socket.on('registerAccount', function (payload) {
    if (socket.accountId) {
      socket.emit('loginResult', { success: false, message: 'Already logged in' });
      return;
    }

    if (isAuthRateLimited('registerAccount', socket)) {
      socket.emit('loginResult', { success: false, message: 'Too many attempts. Please wait a minute and try again.' });
      return;
    }

    const email = payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    const displayName = payload && typeof payload.displayName === 'string' ? payload.displayName.trim() : '';
    const rememberMe = !!(payload && payload.rememberMe);

    if (!email || !password || !displayName) {
      socket.emit('loginResult', { success: false, message: 'Email, password, and display name are required' });
      return;
    }

    if (!isValidEmail(email)) {
      socket.emit('loginResult', { success: false, message: 'Enter a valid email address' });
      return;
    }

    if (password.length < 6) {
      socket.emit('loginResult', { success: false, message: 'Password must be at least 6 characters' });
      return;
    }

    if (displayName.length > 32) {
      socket.emit('loginResult', { success: false, message: 'Display name must be 32 characters or fewer' });
      return;
    }

    const emailLower = normalizeEmail(email);
    const displayNameLower = normalizeDisplayName(displayName);

    if (findAccountByEmail(emailLower)) {
      socket.emit('loginResult', { success: false, message: 'That email is already registered' });
      return;
    }

    if (findAccountByDisplayName(displayNameLower)) {
      socket.emit('loginResult', { success: false, message: 'That display name is already in use' });
      return;
    }

    const secret = hashPassword(password);
    const account = {
      id: crypto.randomBytes(16).toString('hex'),
      email: email,
      emailLower: emailLower,
      displayName: displayName,
      displayNameLower: displayNameLower,
      passwordHash: secret.hash,
      passwordSalt: secret.salt,
      createdAt: new Date().toISOString()
    };

    accounts.push(account);
    saveAccounts();
    attachSocketToAccount(socket, account);
    reclaimSeatAfterReconnect(socket);
    const rememberToken = rememberMe ? issueRememberToken(account) : null;
    socket.emit('loginResult', {
      success: true,
      name: socket.playerName,
      email: socket.accountEmail,
      rememberToken: rememberToken
    });
    sendLobbySnapshot(socket);
  });

  socket.on('login', function (payload) {
    if (socket.accountId) {
      socket.emit('loginResult', { success: false, message: 'Already logged in' });
      return;
    }

    if (isAuthRateLimited('login', socket)) {
      socket.emit('loginResult', { success: false, message: 'Too many attempts. Please wait a minute and try again.' });
      return;
    }

    const email = payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    const rememberMe = !!(payload && payload.rememberMe);

    if (!email || !password) {
      socket.emit('loginResult', { success: false, message: 'Email and password are required' });
      return;
    }

    const emailLower = normalizeEmail(email);
    const account = findAccountByEmail(emailLower);
    if (!account) {
      socket.emit('loginResult', { success: false, message: 'Invalid email or password' });
      return;
    }

    if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) {
      socket.emit('loginResult', { success: false, message: 'Invalid email or password' });
      return;
    }

    attachSocketToAccount(socket, account);
    reclaimSeatAfterReconnect(socket);
    const rememberToken = rememberMe ? issueRememberToken(account) : null;
    socket.emit('loginResult', {
      success: true,
      name: socket.playerName,
      email: socket.accountEmail,
      rememberToken: rememberToken
    });
    sendLobbySnapshot(socket);
  });

  socket.on('logout', function () {
    if (!validatePlayerReady(socket)) {
      socket.emit('logoutResult', { success: false, message: 'Not logged in' });
      return;
    }

    const accountIndex = accounts.findIndex(function (account) {
      return account.id === socket.accountId;
    });
    if (accountIndex >= 0) {
      clearRememberToken(accounts[accountIndex]);
    }

    clearDisconnectGraceForAccount(socket.accountId);
    leaveCurrentTable(socket, 'logout');
    clearSocketAuth(socket);
    socket.emit('logoutResult', { success: true, message: 'Logged out' });
  });

  socket.on('deleteAccount', function (payload) {
    if (isAuthRateLimited('deleteAccount', socket)) {
      socket.emit('deleteAccountResult', { success: false, message: 'Too many attempts. Please wait a minute and try again.' });
      return;
    }

    if (socket.accountId) {
      const password = payload && typeof payload.password === 'string' ? payload.password : '';
      if (!password) {
        socket.emit('deleteAccountResult', { success: false, message: 'Password is required to delete your account' });
        return;
      }

      const accountIndex = accounts.findIndex(function (account) {
        return account.id === socket.accountId;
      });

      if (accountIndex < 0) {
        clearSocketAuth(socket);
        socket.emit('deleteAccountResult', { success: false, message: 'Account not found' });
        return;
      }

      const account = accounts[accountIndex];
      if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) {
        socket.emit('deleteAccountResult', { success: false, message: 'Password is incorrect' });
        return;
      }

      clearDisconnectGraceForAccount(socket.accountId);
      leaveCurrentTable(socket, 'account_delete');
      clearRememberToken(account);
      accounts.splice(accountIndex, 1);
      saveAccounts();
      clearSocketAuth(socket);
      socket.emit('deleteAccountResult', {
        success: true,
        message: 'Account deleted. Display name "' + account.displayName + '" is now available.'
      });
      return;
    }

    const email = payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    const password = payload && typeof payload.password === 'string' ? payload.password : '';

    if (!email || !password) {
      socket.emit('deleteAccountResult', { success: false, message: 'Email and password are required' });
      return;
    }

    const accountIndex = accounts.findIndex(function (account) {
      return account.emailLower === normalizeEmail(email);
    });

    if (accountIndex < 0) {
      socket.emit('deleteAccountResult', { success: false, message: 'Invalid email or password' });
      return;
    }

    const account = accounts[accountIndex];
    if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) {
      socket.emit('deleteAccountResult', { success: false, message: 'Invalid email or password' });
      return;
    }

    clearRememberToken(account);
    accounts.splice(accountIndex, 1);
    saveAccounts();
    socket.emit('deleteAccountResult', {
      success: true,
      message: 'Account deleted. Display name "' + account.displayName + '" is now available.'
    });
  });

  socket.on('requestLobbySnapshot', function () {
    if (!validatePlayerReady(socket)) {
      return;
    }
    sendLobbySnapshot(socket);
  });

  socket.on('createTable', function (payload) {
    if (!validatePlayerReady(socket)) {
      return;
    }

    const tableName = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
    const gameType = normalizeGameType(payload && payload.gameType);
    if (!tableName) {
      socket.emit('serverMessage', { type: 'error', message: 'Table name is required' });
      return;
    }

    const codeResult = normalizeTableCode(payload && payload.securityCode);
    if (!codeResult.valid) {
      socket.emit('serverMessage', { type: 'error', message: 'Table code must be exactly 4 digits' });
      return;
    }

    const gameDefinition = getGameDefinition(gameType);
    if (!gameDefinition.playable) {
      socket.emit('serverMessage', { type: 'error', message: gameDefinition.name + ' is not available yet' });
      return;
    }

    const exists = Object.keys(tables).some(function (tableId) {
      return tables[tableId].name.toLowerCase() === tableName.toLowerCase();
    });

    if (exists) {
      socket.emit('serverMessage', { type: 'error', message: 'A table with that name already exists' });
      return;
    }

    console.log('createTable request', { socketId: socket.id, playerName: socket.playerName, tableName: tableName, gameType: gameType });

    leaveCurrentTable(socket, 'switch_table');

    const id = createTableId();
    const table = {
      id: id,
      name: tableName,
      gameType: gameDefinition.type,
      hostId: socket.id,
      hostName: socket.playerName,
      status: 'waiting',
      players: [{ id: socket.id, accountId: socket.accountId, name: socket.playerName, hand: [] }],
      game: null,
      scores: {},
      dealerIndex: -1,
      matchSettings: GAME_MODULES[gameDefinition.type].normalizeMatchSettings(payload),
      securityCode: codeResult.code
    };

    table.scores[socket.playerName] = 0;
    tables[id] = table;
    socket.join(id);
    socket.tableId = id;
    console.log('createTable success', { socketId: socket.id, tableId: id, tableIdStored: socket.tableId, playerName: socket.playerName });

    emitTableState(table);
    emitLobbySnapshotAll();
    socket.emit('serverMessage', { type: 'info', message: 'Created table ' + tableName });
  });

  socket.on('joinTable', function (payload) {
    if (!validatePlayerReady(socket)) {
      return;
    }

    const tableId = payload && payload.tableId;
    if (!tableId || !tables[tableId]) {
      socket.emit('serverMessage', { type: 'error', message: 'Table not found' });
      return;
    }

    const table = tables[tableId];
    const gameDefinition = getGameDefinition(table.gameType);

    if (table.gameType && !gameDefinition.playable) {
      socket.emit('serverMessage', { type: 'error', message: gameDefinition.name + ' is not available yet' });
      return;
    }

    if (table.status === 'in_game') {
      socket.emit('serverMessage', { type: 'error', message: 'Cannot join a game already in progress' });
      return;
    }

    if (table.players.length >= gameDefinition.maxPlayers) {
      socket.emit('serverMessage', { type: 'error', message: 'Table is full' });
      return;
    }

    if (table.securityCode) {
      const providedCode = payload && typeof payload.code === 'string' ? payload.code.trim() : '';
      if (providedCode !== table.securityCode) {
        socket.emit('serverMessage', { type: 'error', message: 'Incorrect table code' });
        return;
      }
    }

    console.log('joinTable request', { socketId: socket.id, playerName: socket.playerName, tableId: tableId });

    leaveCurrentTable(socket, 'switch_table');

    table.players.push({ id: socket.id, accountId: socket.accountId, name: socket.playerName, hand: [] });
    if (typeof table.scores[socket.playerName] !== 'number') {
      table.scores[socket.playerName] = 0;
    }

    socket.join(table.id);
    socket.tableId = table.id;
    console.log('joinTable success', { socketId: socket.id, tableId: table.id, tableIdStored: socket.tableId, playerName: socket.playerName });

    emitTableState(table);
    emitLobbySnapshotAll();
    io.to(table.id).emit('actionNotice', socket.playerName + ' joined the table');
  });

  socket.on('leaveTable', function () {
    if (!validatePlayerReady(socket)) {
      return;
    }

    leaveCurrentTable(socket, 'leave_table');
    sendLobbySnapshot(socket);
  });

  socket.on('kickPlayer', function (payload) {
    if (!validatePlayerReady(socket)) {
      return;
    }

    const table = findTableBySocket(socket);
    if (!table) {
      socket.emit('serverMessage', { type: 'error', message: 'Join a table first' });
      return;
    }

    if (table.hostId !== socket.id) {
      socket.emit('serverMessage', { type: 'error', message: 'Only the host can remove players' });
      return;
    }

    const targetId = payload && payload.playerId;
    if (!targetId || targetId === socket.id) {
      socket.emit('serverMessage', { type: 'error', message: 'Select another player to remove' });
      return;
    }

    const playerIndex = getPlayerIndex(table, targetId);
    if (playerIndex < 0) {
      socket.emit('serverMessage', { type: 'error', message: 'Player not found' });
      return;
    }

    const removedPlayer = table.players[playerIndex];
    const tableId = table.id;
    const targetSocket = removedPlayer.isBot ? null : io.sockets.sockets.get(targetId);

    const result = removePlayerFromTable(table, playerIndex);

    if (targetSocket) {
      targetSocket.leave(tableId);
      targetSocket.tableId = null;
      // Order matters: tableState:null first so the client resets/returns to the
      // lobby, then 'kicked' so the notice overlay opens on top of that screen
      // instead of being immediately closed by the tableState:null reset.
      targetSocket.emit('tableState', null);
      targetSocket.emit('kicked', { message: 'You have been removed from the table by the host' });
    }

    if (!result.tableDeleted) {
      io.to(tableId).emit('actionNotice', result.playerName + ' was removed from the table by the host');
    }
    socket.emit('serverMessage', { type: 'info', message: result.playerName + ' has been removed from the table' });
  });

  socket.on('startGame', function () {
    if (!validatePlayerReady(socket)) {
      return;
    }

    const table = findTableBySocket(socket);
    if (!table) {
      socket.emit('serverMessage', { type: 'error', message: 'Join a table first' });
      return;
    }

    console.log('startGame request', { socketId: socket.id, tableId: table.id, hostId: table.hostId, status: table.status, players: table.players.length });

    if (table.hostId !== socket.id) {
      socket.emit('serverMessage', { type: 'error', message: 'Only the host can start the game' });
      return;
    }

    if (table.status === 'in_game') {
      socket.emit('serverMessage', { type: 'error', message: 'Game is already running' });
      return;
    }

    const gameModule = GAME_MODULES[table.gameType];
    const result = gameModule ? gameModule.startGame(table) : { success: false, message: 'Unknown game type' };
    console.log('startGame result', { success: result.success, tableId: table.id, status: table.status, game: !!table.game, players: table.players.length });
    if (!result.success) {
      socket.emit('serverMessage', { type: 'error', message: result.message });
      return;
    }

    io.to(table.id).emit('actionNotice', 'Game started');
  });

  // Each game module registers its own uniquely-named gameplay events (Lumo:
  // playCard/drawCard/... ; Hearts: heartsPlayCard/heartsSelectPassCards/...),
  // so a socket only ever receives handlers for events that can't collide
  // with another game's, and every handler still resolves its own table via
  // findTableBySocket() so it only ever acts on the table this socket is
  // actually seated at.
  Object.keys(GAME_MODULES).forEach(function (gameType) {
    GAME_MODULES[gameType].registerSocketHandlers(socket);
  });

  socket.on('disconnecting', function () {
    // Handled in `disconnect` where a reason is available.
  });

  socket.on('disconnect', function (reason) {
    if (shouldUseDisconnectGrace(reason)) {
      scheduleDisconnectGrace(socket, reason);
    } else {
      clearDisconnectGraceForAccount(socket.accountId);
      leaveCurrentTable(socket, 'disconnect');
    }

    logSocketWarning('Player disconnected', {
      socketId: socket.id,
      playerName: socket.playerName || 'unknown',
      reason: reason || 'unknown reason'
    });
  });
}

// Exposed only for direct in-process testing of card-model logic (deck
// composition, scoring, etc.) - requiring this file still starts the HTTP/Socket.IO
// server as normal, this just additionally exposes a few pure helpers,
// re-exported from the Lumo game module (games/lumo/index.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createDeck: GAME_MODULES.uno.createDeck,
    cardColor: GAME_MODULES.uno.cardColor,
    cardType: GAME_MODULES.uno.cardType,
    cardScore: GAME_MODULES.uno.cardScore,
    describeCard: GAME_MODULES.uno.describeCard,
    isGivePlusOneCard: GAME_MODULES.uno.isGivePlusOneCard,
    shuffle: shuffle
  };
}
