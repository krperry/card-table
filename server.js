const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  // Mobile Safari can pause background tabs, delaying heartbeat responses.
  // Allow a longer window so brief focus loss does not eject active players.
  pingInterval: 25000,
  pingTimeout: 300000
});

const port = process.env.PORT || 4123;
const MAX_TABLE_PLAYERS = 6;
const MIN_TABLE_PLAYERS = 2;
const MATCH_POINTS_TO_WIN = 500;
const DEFAULT_MAX_ROUNDS = 30;
const MIN_WINNING_SCORE = 50;
const MAX_WINNING_SCORE = 100000;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 1000;
const DISCONNECT_GRACE_MS = Math.max(1000, parseInt(process.env.DISCONNECT_GRACE_MS || '45000', 10));
const MAX_COMPUTER_PLAYERS = 5;
const COMPUTER_SKILL_LEVELS = ['random', '1', '2', '3'];
const DEFAULT_COMPUTER_SKILL = 'random';
const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));
// Twenty distinct first names bots are drawn from - pickBotNames() takes a
// unique subset per table so no two computer players ever share a name.
const BOT_NAME_POOL = [
  'Ava', 'Milo', 'Nora', 'Kai', 'Luna', 'Theo', 'Zoe', 'Finn', 'Ivy', 'Owen',
  'Maya', 'Leo', 'Nina', 'Jasper', 'Ruby', 'Silas', 'Wren', 'Axel', 'Piper', 'Dash'
];
const ACCOUNT_FILE_PATH = path.join(__dirname, 'data', 'accounts.json');
const LOG_FILE_PATH = path.join(__dirname, 'logs', 'server.log');
const DEFAULT_GAME_TYPE = 'uno';
const GAME_DEFINITIONS = {
  uno: { type: 'uno', name: 'Lumo', playable: true },
  hearts: { type: 'hearts', name: 'Hearts', playable: false },
  spades: { type: 'spades', name: 'Spades', playable: false },
  cribbage: { type: 'cribbage', name: 'Cribbage', playable: false }
};

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

function normalizeComputerSkill(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return COMPUTER_SKILL_LEVELS.indexOf(normalized) !== -1 ? normalized : DEFAULT_COMPUTER_SKILL;
}

function normalizeMatchSettings(payload) {
  return {
    winningScore: clampInteger(payload && payload.winningScore, MIN_WINNING_SCORE, MAX_WINNING_SCORE, MATCH_POINTS_TO_WIN),
    maxRounds: clampInteger(payload && payload.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
    allowDrawTwoStacking: !!(payload && payload.allowDrawTwoStacking),
    allowWildDrawFourStacking: !!(payload && payload.allowWildDrawFourStacking),
    computerPlayers: clampInteger(payload && payload.computerPlayers, 0, MAX_COMPUTER_PLAYERS, 0),
    computerSkill: normalizeComputerSkill(payload && payload.computerSkill)
  };
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

function getMatchSettings(table) {
  const matchSettings = table && table.matchSettings ? table.matchSettings : {};

  return {
    winningScore: clampInteger(matchSettings.winningScore, MIN_WINNING_SCORE, MAX_WINNING_SCORE, MATCH_POINTS_TO_WIN),
    maxRounds: clampInteger(matchSettings.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
    allowDrawTwoStacking: !!matchSettings.allowDrawTwoStacking,
    allowWildDrawFourStacking: !!matchSettings.allowWildDrawFourStacking,
    computerPlayers: clampInteger(matchSettings.computerPlayers, 0, MAX_COMPUTER_PLAYERS, 0),
    computerSkill: normalizeComputerSkill(matchSettings.computerSkill)
  };
}

function normalizeIndex(index, count) {
  if (count <= 0) {
    return 0;
  }

  const normalized = index % count;
  return normalized < 0 ? normalized + count : normalized;
}

function getNextPlayerIndex(table, currentIndex, steps) {
  const direction = table.game && table.game.reverse ? -1 : 1;
  return normalizeIndex(currentIndex + steps * direction, table.players.length);
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

  if (table.status === 'in_game' && table.game && table.game.pendingRoundAcks && table.game.pendingRoundAcks[previousSocketId]) {
    table.game.pendingRoundAcks[socket.id] = true;
    delete table.game.pendingRoundAcks[previousSocketId];
  }

  emitTableState(table);
  emitLobbySnapshotAll();

  if (table.status === 'in_game' && table.game) {
    io.to(player.id).emit('haveCard', player.hand);
    emitDiscardCard(table);
    emitTurnPlayer(table);
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

// Give Plus One cards live in their own ID range (GIVE_PLUS_ONE_BASE..+3, one per
// color) so the existing color*14+value scheme used for numbered/action cards does
// not need to be renumbered. isGivePlusOneCard()/COLOR_NAMES below decode it.
const GIVE_PLUS_ONE_BASE = 1000;
const COLOR_NAMES = ['red', 'yellow', 'green', 'blue'];

function isGivePlusOneCard(card) {
  return typeof card === 'number' && card >= GIVE_PLUS_ONE_BASE && card < GIVE_PLUS_ONE_BASE + COLOR_NAMES.length;
}

function createDeck() {
  const deck = [];
  for (let color = 0; color < 4; color++) {
    deck.push(color * 14 + 0);
    for (let value = 1; value <= 12; value++) {
      deck.push(color * 14 + value);
      deck.push(color * 14 + value);
    }
  }

  // Wild cards: one per color slot (all render identically), floor(card/14) < 4
  // so cardType() classifies them as 'Wild'. Four total, matching a real Lumo deck.
  for (let color = 0; color < 4; color++) {
    deck.push(color * 14 + 13);
  }

  // Wild Draw Four: floor(card/14) >= 4 so cardType() classifies them as 'Draw4'.
  // Four total, matching a real Lumo deck.
  for (let color = 0; color < 4; color++) {
    deck.push((4 + color) * 14 + 13);
  }

  // Give Plus One: two per color, matching the Skip/Reverse/Draw Two count. Brings
  // the deck to 116 cards, matching public/lumo-rules.md.
  for (let color = 0; color < 4; color++) {
    deck.push(GIVE_PLUS_ONE_BASE + color);
    deck.push(GIVE_PLUS_ONE_BASE + color);
  }

  return deck;
}

function shuffle(deck) {
  for (let index = deck.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = deck[index];
    deck[index] = deck[swapIndex];
    deck[swapIndex] = temp;
  }
}

function cardColor(card) {
  if (isGivePlusOneCard(card)) {
    return COLOR_NAMES[card - GIVE_PLUS_ONE_BASE];
  }

  if (card % 14 === 13) {
    return 'black';
  }

  switch (Math.floor(card / 14)) {
    case 0:
    case 4:
      return 'red';
    case 1:
    case 5:
      return 'yellow';
    case 2:
    case 6:
      return 'green';
    case 3:
    case 7:
      return 'blue';
    default:
      return 'unknown';
  }
}

function getCurrentBoardColor(table) {
  if (!table || !table.game) {
    return null;
  }

  if (table.game.chosenColor) {
    return table.game.chosenColor;
  }

  return cardColor(table.game.cardOnBoard);
}

function canPlayCardOnBoard(table, card) {
  if (!table || !table.game || typeof card !== 'number') {
    return false;
  }

  const currentCard = table.game.cardOnBoard;
  const currentColor = getCurrentBoardColor(table);
  const cardColorName = cardColor(card);
  const currentCardType = cardType(currentCard);

  if (cardColorName === 'black') {
    return true;
  }

  if (cardColorName === currentColor) {
    return true;
  }

  return cardType(card) === currentCardType;
}

function hasPlayableCard(table, hand) {
  if (!Array.isArray(hand)) {
    return false;
  }

  return hand.some(function (card) {
    return canPlayCardOnBoard(table, card);
  });
}

function cardType(card) {
  if (isGivePlusOneCard(card)) {
    return 'GivePlusOne';
  }

  switch (card % 14) {
    case 10:
      return 'Skip';
    case 11:
      return 'Reverse';
    case 12:
      return 'Draw2';
    case 13:
      return Math.floor(card / 14) >= 4 ? 'Draw4' : 'Wild';
    default:
      return 'Number ' + (card % 14);
  }
}

function capitalizeWord(word) {
  if (typeof word !== 'string' || !word) {
    return '';
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function formatCardTypeForNarration(type) {
  if (type.indexOf('Number ') === 0) {
    return type.replace('Number ', '');
  }

  if (type === 'Draw2') {
    return 'Draw Two';
  }

  if (type === 'Draw4') {
    return 'Draw Four';
  }

  if (type === 'GivePlusOne') {
    return 'Give Plus One';
  }

  return type;
}

function describeCard(card, chosenColor) {
  if (typeof card !== 'number') {
    return 'No card';
  }

  const resolvedColor = cardColor(card) === 'black' ? chosenColor : cardColor(card);
  const formattedType = formatCardTypeForNarration(cardType(card));

  if (cardColor(card) === 'black') {
    return resolvedColor ? (formattedType + ' ' + resolvedColor) : formattedType;
  }

  return formattedType + ' ' + resolvedColor;
}

function describeCardForAnnouncement(card, chosenColor) {
  if (typeof card !== 'number') {
    return 'No card';
  }

  return describeCard(card, chosenColor);
}

function getTurnDirectionLabel(reverseFlag) {
  return reverseFlag ? 'counterclockwise' : 'clockwise';
}

function createInactiveStackState() {
  return {
    active: false,
    type: null,
    penalty: 0,
    activeColor: null,
    starterId: null,
    starterName: '',
    roundEndPending: false,
    lastPlayerId: null,
    lastPlayerName: '',
    respondingPlayerId: null,
    respondingPlayerName: ''
  };
}

function getStackTypeLabel(stackType) {
  return stackType === 'Draw4' ? 'Wild Draw Four' : 'Draw Two';
}

function getStackPenaltyAmount(stackType) {
  return stackType === 'Draw4' ? 4 : 2;
}

function isLegalWildDrawFourPlay(table, hand, card) {
  if (cardType(card) !== 'Draw4' || !Array.isArray(hand)) {
    return false;
  }

  const boardColor = getCurrentBoardColor(table);
  return !hand.some(function (handCard) {
    return handCard !== card && cardColor(handCard) !== 'black' && cardColor(handCard) === boardColor;
  });
}

function hasLegalStackCard(table, hand, stackType) {
  if (!Array.isArray(hand)) {
    return false;
  }

  if (stackType === 'Draw2') {
    return hand.some(function (card) {
      return cardType(card) === 'Draw2';
    });
  }

  if (stackType === 'Draw4') {
    return hand.some(function (card) {
      return cardType(card) === 'Draw4';
    });
  }

  return false;
}

function buildStackStatePayload(table, viewerId) {
  if (!table || !table.game || !table.game.stack) {
    return createInactiveStackState();
  }

  const stack = table.game.stack;
  const currentPlayer = table.players[table.game.turn] || null;
  const viewerIsCurrentPlayer = !!(currentPlayer && currentPlayer.id === viewerId);
  const canContinue = !!(stack.active && viewerIsCurrentPlayer && hasLegalStackCard(table, currentPlayer.hand, stack.type));

  return {
    active: !!stack.active,
    type: stack.type,
    penalty: stack.penalty || 0,
    activeColor: stack.activeColor || null,
    lastPlayerId: stack.lastPlayerId || null,
    lastPlayerName: stack.lastPlayerName || '',
    respondingPlayerId: currentPlayer ? currentPlayer.id : null,
    respondingPlayerName: currentPlayer ? currentPlayer.name : '',
    canContinue: canContinue,
    canAcceptPenalty: !!viewerIsCurrentPlayer,
    promptText: canContinue
      ? ('You may play a ' + getStackTypeLabel(stack.type) + ' or draw ' + (stack.penalty || 0) + ' cards.')
      : ('You must draw ' + (stack.penalty || 0) + ' cards.')
  };
}

function createInactiveGiveState() {
  return {
    active: false,
    isGiver: false,
    isReceiver: false,
    fromPlayerName: '',
    toPlayerName: ''
  };
}

function buildGivePendingStatePayload(table, viewerId) {
  if (!table || !table.game || !table.game.pendingGive) {
    return createInactiveGiveState();
  }

  const pending = table.game.pendingGive;
  return {
    active: true,
    isGiver: viewerId === pending.fromPlayerId,
    isReceiver: viewerId === pending.toPlayerId,
    fromPlayerName: pending.fromPlayerName,
    toPlayerName: pending.toPlayerName
  };
}

function clearActiveStack(table) {
  if (!table || !table.game) {
    return;
  }

  table.game.stack = createInactiveStackState();
}

function activateStack(table, currentPlayer, card, chosenColor) {
  if (!table || !table.game || !currentPlayer) {
    return;
  }

  const stackType = cardType(card);
  const nextPlayerIndex = getNextPlayerIndex(table, getPlayerIndex(table, currentPlayer.id), 1);
  const nextPlayer = table.players[nextPlayerIndex] || null;

  table.game.stack = {
    active: true,
    type: stackType,
    penalty: getStackPenaltyAmount(stackType),
    activeColor: stackType === 'Draw4' ? chosenColor : getCurrentBoardColor(table),
    starterId: currentPlayer.id,
    starterName: currentPlayer.name,
    roundEndPending: currentPlayer.hand.length === 0,
    lastPlayerId: currentPlayer.id,
    lastPlayerName: currentPlayer.name,
    respondingPlayerId: nextPlayer ? nextPlayer.id : null,
    respondingPlayerName: nextPlayer ? nextPlayer.name : ''
  };
}

function resolveStackPenalty(table) {
  if (!table || !table.game || !table.game.stack || !table.game.stack.active) {
    return false;
  }

  const playerIndex = table.game.turn;
  const player = table.players[playerIndex];
  if (!player) {
    clearActiveStack(table);
    return false;
  }

  const stack = table.game.stack;
  const stackLabel = getStackTypeLabel(stack.type);
  const activeColorText = stack.type === 'Draw4' && stack.activeColor ? (' ' + capitalizeWord(stack.activeColor) + ' remains the active color.') : '';
  const nextIndex = getNextPlayerIndex(table, playerIndex, 1);
  const nextPlayer = table.players[nextIndex] || null;
  const starterIndex = getPlayerIndex(table, stack.starterId);
  const starterPlayer = starterIndex >= 0 ? table.players[starterIndex] : null;
  const roundEndPending = !!stack.roundEndPending;

  drawCardsFromDeck(table, playerIndex, stack.penalty);
  io.to(player.id).emit('haveCard', player.hand);

  const transitionMessage = player.name + ' draws ' + stack.penalty + ' cards and loses their turn.' + activeColorText;

  if (roundEndPending && player.id !== stack.starterId && starterIndex >= 0) {
    clearActiveStack(table);
    io.to(table.id).emit('turnTransition', {
      action: 'stack_resolve',
      actorId: player.id,
      actorName: player.name,
      stackType: stack.type,
      stackPenalty: stack.penalty,
      stackLabel: stackLabel,
      stackActiveColor: stack.activeColor || null,
      nextPlayerId: starterPlayer ? starterPlayer.id : null,
      nextPlayerName: starterPlayer ? starterPlayer.name : '',
      message: transitionMessage + (starterPlayer ? ' ' + starterPlayer.name + ' wins the round.' : '')
    });

    endRound(table, starterIndex, 'stack_resolved');
    return true;
  }

  clearActiveStack(table);
  advanceTurn(table, 1);
  emitTableState(table);

  io.to(table.id).emit('turnTransition', {
    action: 'stack_resolve',
    actorId: player.id,
    actorName: player.name,
    stackType: stack.type,
    stackPenalty: stack.penalty,
    stackLabel: stackLabel,
    stackActiveColor: stack.activeColor || null,
    nextPlayerId: nextPlayer ? nextPlayer.id : null,
    nextPlayerName: nextPlayer ? nextPlayer.name : '',
    message: transitionMessage + (nextPlayer ? ' It is ' + nextPlayer.name + "'s turn." : '')
  });

  emitTurnPlayer(table);
  return true;
}

function cardScore(card) {
  if (typeof card !== 'number') {
    return 0;
  }

  if (isGivePlusOneCard(card)) {
    return 20;
  }

  if (cardColor(card) === 'black') {
    return 50;
  }

  const value = card % 14;
  if (value >= 10) {
    return 20;
  }

  return value;
}

function getHighestStarterDrawIndex(draws) {
  let highestIndex = 0;
  let highestCard = draws[0] ? draws[0].card : -1;
  draws.forEach(function (draw, index) {
    if (draw.card > highestCard) {
      highestCard = draw.card;
      highestIndex = index;
    }
  });
  return highestIndex;
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

// --- Computer player (bot) decision logic ---
// Bots act through the same performDrawCard/performPlayCard/performAcceptStackPenalty/
// performSubmitGiveCard functions real sockets use (see onConnection), so the rules a
// bot can and cannot do are identical to a human player - only card/color selection
// below is bot-specific.

function isBotActionCard(card) {
  const type = cardType(card);
  return type === 'Skip' || type === 'Reverse' || type === 'Draw2' || type === 'GivePlusOne';
}

function pickHighestScoreCard(cards) {
  return cards.reduce(function (best, candidate) {
    return cardScore(candidate) > cardScore(best) ? candidate : best;
  }, cards[0]);
}

function randomColorChoice() {
  return COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)];
}

function pickBestColorForBot(hand, excludeCard) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  hand.forEach(function (card) {
    if (card === excludeCard) {
      return;
    }
    const color = cardColor(card);
    if (counts[color] !== undefined) {
      counts[color] += 1;
    }
  });

  let bestColor = COLOR_NAMES[0];
  let bestCount = -1;
  COLOR_NAMES.forEach(function (color) {
    if (counts[color] > bestCount) {
      bestCount = counts[color];
      bestColor = color;
    }
  });
  return bestColor;
}

function getLegalBotCards(table, bot) {
  const stack = table.game.stack;
  if (stack && stack.active) {
    return bot.hand.filter(function (card) {
      return cardType(card) === stack.type;
    });
  }

  return bot.hand.filter(function (card) {
    if (!canPlayCardOnBoard(table, card)) {
      return false;
    }
    if (cardType(card) === 'Draw4') {
      return isLegalWildDrawFourPlay(table, bot.hand, card);
    }
    return true;
  });
}

// Skill 1 (easy): random legal card, random wild color.
// Skill 2 (medium): always sheds its highest point-value legal card.
// Skill 3 (hard): prefers disruptive action cards over plain numbers, saves
// Wild/Draw4 for when nothing else is legal, and picks wild colors to match
// whatever color it is holding the most of.
function chooseBotPlay(table, bot) {
  const legalCards = getLegalBotCards(table, bot);
  if (legalCards.length === 0) {
    return null;
  }

  const skill = bot.botSkill || 2;
  let card;

  if (skill <= 1) {
    card = legalCards[Math.floor(Math.random() * legalCards.length)];
  } else if (skill === 2) {
    card = pickHighestScoreCard(legalCards);
  } else {
    const actionCards = legalCards.filter(isBotActionCard);
    const numberCards = legalCards.filter(function (c) {
      return cardColor(c) !== 'black' && !isBotActionCard(c);
    });
    const draw4Cards = legalCards.filter(function (c) {
      return cardType(c) === 'Draw4';
    });

    if (actionCards.length) {
      card = pickHighestScoreCard(actionCards);
    } else if (numberCards.length) {
      card = pickHighestScoreCard(numberCards);
    } else if (draw4Cards.length) {
      card = draw4Cards[0];
    } else {
      card = legalCards[0];
    }
  }

  const isWild = cardColor(card) === 'black';
  const chosenColor = isWild ? (skill <= 1 ? randomColorChoice() : pickBestColorForBot(bot.hand, card)) : null;
  return { card: card, chosenColor: chosenColor };
}

function chooseBotGiveCard(table, bot) {
  if (!bot.hand.length) {
    return null;
  }
  if ((bot.botSkill || 2) <= 1) {
    return bot.hand[Math.floor(Math.random() * bot.hand.length)];
  }
  return pickHighestScoreCard(bot.hand);
}

function scheduleBotAction(table, botId) {
  if (!table || !table.game) {
    return;
  }
  if (table.game.botTimer) {
    clearTimeout(table.game.botTimer);
  }
  table.game.botTimer = setTimeout(function () {
    table.game.botTimer = null;
    runBotTurn(table.id, botId);
  }, BOT_MOVE_DELAY_MS);
}

// Central hook: called at the end of emitTurnPlayer() (the same signal a human
// client uses to know it must act) so a bot's move is scheduled exactly when a
// human would be prompted to draw/play - see also the direct scheduleBotAction()
// call from performPlayCard()'s Give Plus One branch, which pauses the turn
// without calling emitTurnPlayer().
function maybeScheduleBotTurn(table) {
  if (!table || !table.game || table.status !== 'in_game' || table.game.locked || table.game.pendingGive) {
    return;
  }

  const currentPlayer = table.players[table.game.turn];
  if (currentPlayer && currentPlayer.isBot) {
    scheduleBotAction(table, currentPlayer.id);
  }
}

function runBotTurn(tableId, botId) {
  const table = tables[tableId];
  if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
    return;
  }

  const pending = table.game.pendingGive;
  if (pending) {
    if (pending.fromPlayerId !== botId) {
      return;
    }
    const bot = table.players[getPlayerIndex(table, botId)];
    if (!bot || !bot.isBot) {
      return;
    }
    const card = chooseBotGiveCard(table, bot);
    if (typeof card !== 'number') {
      return;
    }
    performSubmitGiveCard(table, botId, { card: card });
    return;
  }

  const currentPlayer = table.players[table.game.turn];
  if (!currentPlayer || currentPlayer.id !== botId || !currentPlayer.isBot) {
    return;
  }

  const stack = table.game.stack;
  if (stack && stack.active) {
    const play = chooseBotPlay(table, currentPlayer);
    if (play) {
      performPlayCard(table, botId, play);
    } else {
      performAcceptStackPenalty(table, botId);
    }
    return;
  }

  if (hasPlayableCard(table, currentPlayer.hand)) {
    const play = chooseBotPlay(table, currentPlayer);
    if (play) {
      performPlayCard(table, botId, play);
      return;
    }
  }

  performDrawCard(table, botId);
}

function initializeGameState(table) {
  table.game = {
    deck: createDeck(),
    reverse: 0,
    turn: 0,
    cardOnBoard: 0,
    chosenColor: null,
    hasDrawn: false,
    locked: false,
    roundNumber: 1,
    startingPlayerIndex: 0,
    lastRoundPoints: {},
    stack: createInactiveStackState(),
    pendingGive: null
  };

  shuffle(table.game.deck);
}

function drawStarterCards(table) {
  const draws = table.players.map(function (player) {
    ensureDeckNotEmpty(table);
    const card = parseInt(table.game.deck.shift(), 10);
    return {
      id: player.id,
      name: player.name,
      card: card,
      score: cardScore(card),
      description: describeCard(card)
    };
  });

  const highestIndex = getHighestStarterDrawIndex(draws);
  const winner = draws[highestIndex];

  draws.forEach(function (draw) {
    table.game.deck.push(draw.card);
  });
  shuffle(table.game.deck);

  table.game.startingPlayerIndex = highestIndex;

  io.to(table.id).emit('starterDrawSummary', {
    draws: draws,
    winner: winner,
    winnerIndex: highestIndex,
    message: winner.name + ' starts the first round with ' + winner.description + ' worth ' + winner.score + ' points.'
  });
  io.to(table.id).emit('actionNotice', 'Each player drew one card to determine the first starter. ' + winner.name + ' goes first.');
}

function beginRound(table, options) {
  const isFirstRound = !!(options && options.isFirstRound);

  if (!isFirstRound) {
    table.game.deck = createDeck();
    shuffle(table.game.deck);
  }

  table.game.reverse = 0;
  table.game.cardOnBoard = 0;
  table.game.chosenColor = null;
  table.game.hasDrawn = false;
  table.game.locked = false;
  table.game.lastRoundPoints = {};
  table.game.stack = createInactiveStackState();
  table.game.pendingGive = null;

  table.players.forEach(function (player) {
    player.hand = [];
  });

  const dealStartIndex = normalizeIndex(table.game.startingPlayerIndex + 1, table.players.length);

  for (let i = 0; i < table.players.length * 7; i++) {
    const playerIndex = normalizeIndex(i + dealStartIndex, table.players.length);
    ensureDeckNotEmpty(table);
    const card = parseInt(table.game.deck.shift(), 10);
    table.players[playerIndex].hand.push(card);
  }

  let starterCard;
  do {
    ensureDeckNotEmpty(table);
    starterCard = parseInt(table.game.deck.shift(), 10);
    if (cardColor(starterCard) === 'black') {
      table.game.deck.push(starterCard);
      shuffle(table.game.deck);
    } else {
      break;
    }
  } while (true);

  table.game.cardOnBoard = starterCard;
  table.game.turn = table.game.startingPlayerIndex;

  if (cardType(starterCard) === 'Draw2') {
    drawCardsFromDeck(table, table.game.turn, 2);
    advanceTurn(table, 1);
  } else if (cardType(starterCard) === 'Reverse') {
    table.game.reverse = 1;
    if (table.players.length === 2) {
      advanceTurn(table, 1);
    }
  } else if (cardType(starterCard) === 'Skip') {
    advanceTurn(table, 1);
  }

  sendHands(table);
  emitDiscardCard(table);
  emitTurnPlayer(table);
  emitTableState(table);
  emitLobbySnapshotAll();

  if (isFirstRound && options && options.announceStarter) {
    const starterName = table.players[table.game.startingPlayerIndex] ? table.players[table.game.startingPlayerIndex].name : '';
    io.to(table.id).emit('actionNotice', starterName + ' starts the first round.');
  }
}

function startGameForTable(table) {
  const settings = getMatchSettings(table);
  const botSlots = Math.max(0, Math.min(settings.computerPlayers, MAX_TABLE_PLAYERS - table.players.length));

  if (table.players.length + botSlots < MIN_TABLE_PLAYERS) {
    return { success: false, message: 'At least 2 players are required to start a game' };
  }

  addComputerPlayersToTable(table, botSlots, settings.computerSkill);

  table.status = 'in_game';
  initializeGameState(table);
  drawStarterCards(table);
  beginRound(table, {
    isFirstRound: true,
    announceStarter: true
  });
  return { success: true };
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
      maxPlayers: MAX_TABLE_PLAYERS,
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

function buildTableState(table, socketId) {
  const gameDefinition = getGameDefinition(table.gameType);
  const matchSettings = getMatchSettings(table);
  return {
    table: {
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
      stackState: buildStackStatePayload(table, socketId),
      givePendingState: buildGivePendingStatePayload(table, socketId),
      players: table.players.map(function (player) {
        return {
          id: player.id,
          name: player.name,
          isBot: !!player.isBot,
          cardCount: table.status === 'in_game' ? player.hand.length : 0,
          score: getPlayerScore(table, player.name),
          roundPoints: getRoundPoints(table, player.name)
        };
      })
    },
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
// the actor) for code paths shared between real sockets and performX() bot calls.
function emitToTableExcept(table, exceptId, event, payload) {
  table.players.forEach(function (player) {
    if (player.id !== exceptId) {
      io.to(player.id).emit(event, payload);
    }
  });
}

function ensureDeckNotEmpty(table) {
  if (table.game.deck.length === 0) {
    const freshDeck = createDeck();
    shuffle(freshDeck);
    table.game.deck = freshDeck;
  }
}

function drawCardsFromDeck(table, playerIndex, count) {
  for (let i = 0; i < count; i++) {
    ensureDeckNotEmpty(table);
    const card = parseInt(table.game.deck.shift(), 10);
    table.players[playerIndex].hand.push(card);
  }
}

function sendHands(table) {
  table.players.forEach(function (player) {
    io.to(player.id).emit('haveCard', player.hand);
  });
}

function emitDiscardCard(table) {
  io.to(table.id).emit('sendCard', {
    card: table.game.cardOnBoard,
    chosenColor: table.game.chosenColor
  });
}

function emitTurnPlayer(table) {
  const currentPlayer = table.players[table.game.turn];
  if (!currentPlayer) {
    return;
  }

  // A player with no legal stack continuation must explicitly draw (acceptStackPenalty)
  // rather than being auto-resolved here - inspecting their hand to decide for them
  // would leak whether they hold a Draw Two / Wild Draw Four to anyone watching the
  // resulting transition. Each recipient also gets their own stackState so only the
  // affected player learns whether they can continue.
  const canPlay = hasPlayableCard(table, currentPlayer.hand);
  const topDiscard = describeCard(table.game.cardOnBoard, table.game.chosenColor);

  table.players.forEach(function (player) {
    io.to(player.id).emit('turnPlayer', {
      id: currentPlayer.id,
      name: currentPlayer.name,
      canPlay: canPlay,
      mustDraw: !canPlay,
      topDiscard: topDiscard,
      stackState: buildStackStatePayload(table, player.id)
    });
  });

  maybeScheduleBotTurn(table);
}

function emitTurnTransition(table, transition) {
  if (!table || !table.players || !transition) {
    return;
  }

  table.players.forEach(function (player) {
    const payload = {
      action: transition.action || 'play',
      actorId: transition.actorId || null,
      actorName: transition.actorName || '',
      playedCard: transition.playedCard || '',
      playedType: transition.playedType || '',
      actorHasUno: !!transition.actorHasUno,
      colorChangedTo: transition.colorChangedTo || null,
      skippedPlayerId: transition.skippedPlayerId || null,
      skippedPlayerName: transition.skippedPlayerName || '',
      direction: transition.direction || null,
      nextPlayerId: transition.nextPlayerId || null,
      nextPlayerName: transition.nextPlayerName || '',
      message: transition.message || '',
      stackActive: !!transition.stackActive,
      stackType: transition.stackType || null,
      stackPenalty: transition.stackPenalty || 0,
      stackActiveColor: transition.stackActiveColor || null,
      stackMessage: transition.stackMessage || ''
    };

    if (transition.draw) {
      payload.draw = {
        playerId: transition.draw.playerId || null,
        playerName: transition.draw.playerName || '',
        count: transition.draw.count || 0,
        cards: player.id === transition.draw.playerId && Array.isArray(transition.draw.cards)
          ? transition.draw.cards.slice()
          : []
      };
    }

    io.to(player.id).emit('turnTransition', payload);
  });
}

function advanceTurn(table, steps) {
  table.game.turn = getNextPlayerIndex(table, table.game.turn, steps);
  table.game.hasDrawn = false;
}

function calculateRoundPoints(table, winnerIndex) {
  let points = 0;
  for (let i = 0; i < table.players.length; i++) {
    if (i === winnerIndex) {
      continue;
    }

    table.players[i].hand.forEach(function (card) {
      points += cardScore(card);
    });
  }
  return points;
}

function buildScoreboard(table) {
  return table.players.map(function (player) {
    const totalPoints = typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0;
    const roundPoints = table.game && table.game.lastRoundPoints && typeof table.game.lastRoundPoints[player.name] === 'number'
      ? table.game.lastRoundPoints[player.name]
      : 0;

    return {
      name: player.name,
      roundPoints: roundPoints,
      totalPoints: totalPoints
    };
  }).sort(function (a, b) {
    return b.totalPoints - a.totalPoints;
  });
}

function getPlayerScore(table, playerName) {
  return typeof table.scores[playerName] === 'number' ? table.scores[playerName] : 0;
}

function getRoundPoints(table, playerName) {
  if (!table.game || !table.game.lastRoundPoints) {
    return 0;
  }

  return typeof table.game.lastRoundPoints[playerName] === 'number' ? table.game.lastRoundPoints[playerName] : 0;
}

function tryBeginNextRound(table) {
  if (!table.game || !table.game.pendingRoundAcks) {
    return;
  }

  if (Object.keys(table.game.pendingRoundAcks).length > 0 || table.status !== 'in_game') {
    return;
  }

  table.game.pendingRoundAcks = null;
  beginRound(table, {
    isFirstRound: false,
    announceStarter: false
  });
}

function endRound(table, winnerIndex, reason) {
  if (!table.players[winnerIndex]) {
    return;
  }

  clearActiveStack(table);

  const matchSettings = table.matchSettings || { winningScore: MATCH_POINTS_TO_WIN, maxRounds: DEFAULT_MAX_ROUNDS };
  const winnerName = table.players[winnerIndex].name;
  const roundPoints = calculateRoundPoints(table, winnerIndex);
  table.scores[winnerName] = (table.scores[winnerName] || 0) + roundPoints;

  table.game.lastRoundPoints = {};
  table.players.forEach(function (player) {
    table.game.lastRoundPoints[player.name] = player.hand.reduce(function (sum, card) {
      return sum + cardScore(card);
    }, 0);
  });

  const roundNumber = table.game.roundNumber || 1;
  const scoreboard = buildScoreboard(table);
  const scoreWinner = scoreboard.find(function (entry) {
    return entry.totalPoints >= matchSettings.winningScore;
  }) || null;
  const roundsExhausted = roundNumber >= matchSettings.maxRounds;
  const matchWinner = scoreWinner || (roundsExhausted ? scoreboard[0] : null);
  const matchEndReason = scoreWinner ? 'winning_score' : (roundsExhausted ? 'max_rounds' : null);

  io.to(table.id).emit('roundSummary', {
    winner: winnerName,
    roundPoints: roundPoints,
    scores: scoreboard,
    reason: reason || 'round_end',
    matchWinner: matchWinner,
    roundNumber: roundNumber,
    maxRounds: matchSettings.maxRounds
  });

  table.players.forEach(function (player) {
    player.hand = [];
  });

  emitTableState(table);
  emitLobbySnapshotAll();

  if (matchWinner) {
    io.to(table.id).emit('matchSummary', {
      winner: matchWinner.name,
      score: matchWinner.totalPoints,
      scores: scoreboard,
      reason: matchEndReason,
      roundNumber: roundNumber
    });
    table.status = 'waiting';
    table.game = null;
    emitTableState(table);
    emitLobbySnapshotAll();
    return;
  }

  table.game.locked = true;
  table.game.roundNumber = roundNumber + 1;
  table.game.startingPlayerIndex = normalizeIndex(table.game.startingPlayerIndex + 1, table.players.length);
  table.game.pendingRoundAcks = {};
  table.players.forEach(function (player) {
    // Bots have no client to send ackRoundSummary, so they must not gate the
    // next round - only wait on human players here.
    if (!player.isBot) {
      table.game.pendingRoundAcks[player.id] = true;
    }
  });
  tryBeginNextRound(table);
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

function handlePlayerRemovalFromGame(table, removedIndex, playerName) {
  if (table.status !== 'in_game' || !table.game) {
    return;
  }

  const removedPlayer = table.players[removedIndex];

  if (table.game.pendingGive && removedPlayer
    && (table.game.pendingGive.fromPlayerId === removedPlayer.id || table.game.pendingGive.toPlayerId === removedPlayer.id)) {
    table.game.pendingGive = null;
  }

  if (removedPlayer && removedPlayer.hand.length) {
    removedPlayer.hand.forEach(function (card) {
      table.game.deck.push(card);
    });
    shuffle(table.game.deck);
  }

  if (removedIndex < table.game.turn) {
    table.game.turn -= 1;
  }

  if (removedIndex < table.game.startingPlayerIndex) {
    table.game.startingPlayerIndex -= 1;
  }

  if (removedIndex === table.game.turn && table.game.turn >= table.players.length - 1) {
    table.game.turn = 0;
  }

  if (removedPlayer && table.game.pendingRoundAcks) {
    delete table.game.pendingRoundAcks[removedPlayer.id];
    tryBeginNextRound(table);
  }

  io.to(table.id).emit('actionNotice', playerName + ' left the game');
}

// Removes table.players[playerIndex] and settles everything that follows from a
// seat going away (returning cards to the deck, adjusting turn order, tearing the
// table down if no humans remain, or reassigning host/broadcasting state
// otherwise). Shared by a player leaving of their own accord and a host kicking
// someone else out - both are just "this seat is gone" from this point on.
function removePlayerFromTable(table, playerIndex) {
  const playerName = table.players[playerIndex].name;
  handlePlayerRemovalFromGame(table, playerIndex, playerName);

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

  if (table.status === 'in_game' && table.players.length === 1) {
    endRound(table, 0, 'last_player_remaining');
  } else {
    if (table.status === 'in_game') {
      table.game.turn = normalizeIndex(table.game.turn, table.players.length);
      sendHands(table);
      emitDiscardCard(table);
      emitTurnPlayer(table);
    }

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

// --- Shared gameplay actions ---
// Each function below holds the full logic for one gameplay action, addressed by
// actingId (== the acting player's table.players[].id) rather than a live socket.
// The onConnection() socket.on() handlers are thin wrappers that call these with
// socket.id; runBotTurn() calls the same functions with a bot's id, so bots are
// bound by exactly the same rules and validation as a human player. Messages meant
// for the acting player alone use io.to(actingId).emit(...) - equivalent to
// socket.emit(...) for a real socket, since every Socket.IO connection auto-joins a
// room named after its own id, and a harmless no-op when actingId is a bot.

function performDrawCard(table, actingId) {
  if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
    io.to(actingId).emit('drawResult', { success: false, message: 'Unable to draw a card right now' });
    return;
  }

  const currentPlayer = table.players[table.game.turn];
  if (!currentPlayer || currentPlayer.id !== actingId) {
    io.to(actingId).emit('drawResult', { success: false, message: 'It is not your turn' });
    return;
  }

  if (table.game.pendingGive) {
    io.to(actingId).emit('drawResult', { success: false, message: 'Choose a card to give before doing anything else' });
    return;
  }

  if (table.game.hasDrawn) {
    io.to(actingId).emit('drawResult', { success: false, message: 'You already drew this turn' });
    return;
  }

  if (hasPlayableCard(table, currentPlayer.hand)) {
    io.to(actingId).emit('drawResult', {
      success: false,
      message: 'You already have a playable card. Play it instead of drawing.'
    });
    return;
  }

  ensureDeckNotEmpty(table);
  const card = parseInt(table.game.deck.shift(), 10);
  currentPlayer.hand.push(card);
  io.to(currentPlayer.id).emit('haveCard', currentPlayer.hand);

  if (canPlayCardOnBoard(table, card)) {
    emitToTableExcept(table, actingId, 'playerDrewCard', { playerName: currentPlayer.name });
    table.game.hasDrawn = true;
    io.to(actingId).emit('drawResult', {
      success: true,
      card: card,
      message: 'You drew ' + describeCard(card) + '. It is playable. You may play it now.'
    });
    emitTableState(table);
    emitTurnPlayer(table);
    return;
  }

  io.to(actingId).emit('drawResult', {
    success: true,
    card: card,
    message: 'You drew ' + describeCard(card) + '. It is not playable. Turn passes.'
  });

  const nextIndex = getNextPlayerIndex(table, table.game.turn, 1);
  const nextPlayer = table.players[nextIndex];
  const transition = {
    action: 'draw_pass',
    actorId: currentPlayer.id,
    actorName: currentPlayer.name,
    draw: {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      count: 1,
      cards: [describeCardForAnnouncement(card)]
    },
    nextPlayerId: nextPlayer ? nextPlayer.id : null,
    nextPlayerName: nextPlayer ? nextPlayer.name : ''
  };

  advanceTurn(table, 1);
  emitTableState(table);
  emitTurnTransition(table, transition);
  emitTurnPlayer(table);
}

function performAcceptStackPenalty(table, actingId) {
  if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
    io.to(actingId).emit('playResult', { success: false, message: 'Unable to accept the penalty right now' });
    return;
  }

  const currentPlayer = table.players[table.game.turn];
  if (!currentPlayer || currentPlayer.id !== actingId) {
    io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn' });
    return;
  }

  if (!table.game.stack || !table.game.stack.active) {
    io.to(actingId).emit('playResult', { success: false, message: 'There is no active draw stack' });
    return;
  }

  if (table.game.pendingGive) {
    io.to(actingId).emit('playResult', { success: false, message: 'Choose a card to give before doing anything else' });
    return;
  }

  resolveStackPenalty(table);
}

function performPlayCard(table, actingId, payload) {
  if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
    io.to(actingId).emit('playResult', { success: false, message: 'Unable to play a card right now' });
    return;
  }

  const currentPlayerIndex = table.game.turn;
  const currentPlayer = table.players[currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== actingId) {
    io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn' });
    return;
  }

  if (table.game.pendingGive) {
    io.to(actingId).emit('playResult', { success: false, message: 'Choose a card to give before doing anything else' });
    return;
  }

  const card = payload ? parseInt(payload.card, 10) : NaN;
  const chosenColor = payload && typeof payload.chosenColor === 'string' ? payload.chosenColor.toLowerCase() : null;

  if (Number.isNaN(card) || currentPlayer.hand.indexOf(card) === -1) {
    io.to(actingId).emit('playResult', { success: false, message: 'That card is not in your hand' });
    return;
  }

  const isWild = cardColor(card) === 'black';
  if (isWild && ['red', 'yellow', 'green', 'blue'].indexOf(chosenColor) === -1) {
    io.to(actingId).emit('playResult', { success: false, message: 'Choose a valid color for your Wild card' });
    return;
  }

  const type = cardType(card);
  const drawTwoStackingEnabled = !!table.matchSettings.allowDrawTwoStacking;
  const drawFourStackingEnabled = !!table.matchSettings.allowWildDrawFourStacking;
  const activeStack = table.game.stack && table.game.stack.active ? table.game.stack : null;
  const canContinueStack = !!(activeStack
    && ((activeStack.type === 'Draw2' && drawTwoStackingEnabled && type === 'Draw2')
      || (activeStack.type === 'Draw4' && drawFourStackingEnabled && type === 'Draw4')));
  const stackWillBeActive = !!(activeStack ? canContinueStack : ((type === 'Draw2' && drawTwoStackingEnabled) || (type === 'Draw4' && drawFourStackingEnabled)));

  if (activeStack) {
    if (!canContinueStack) {
      io.to(actingId).emit('playResult', {
        success: false,
        message: 'You must play a ' + getStackTypeLabel(activeStack.type) + ' or draw the accumulated penalty.'
      });
      return;
    }
  } else if (!canPlayCardOnBoard(table, card)) {
    io.to(actingId).emit('playResult', {
      success: false,
      message: 'Cannot play ' + describeCard(card) + ' on ' + describeCard(table.game.cardOnBoard, table.game.chosenColor)
    });
    return;
  }

  if (!activeStack && cardType(card) === 'Draw4') {
    const boardColor = getCurrentBoardColor(table);
    const hasColorMatch = currentPlayer.hand.some(function (handCard) {
      return handCard !== card && cardColor(handCard) !== 'black' && cardColor(handCard) === boardColor;
    });

    if (hasColorMatch) {
      io.to(actingId).emit('playResult', {
        success: false,
        message: 'Wild Draw Four can only be played when you have no card matching the current color'
      });
      return;
    }
  }

  table.game.cardOnBoard = card;
  table.game.chosenColor = isWild ? chosenColor : null;
  table.game.hasDrawn = false;

  const cardPos = currentPlayer.hand.indexOf(card);
  currentPlayer.hand.splice(cardPos, 1);

  emitDiscardCard(table);
  io.to(currentPlayer.id).emit('haveCard', currentPlayer.hand);

  const cardDescription = describeCard(card, table.game.chosenColor);
  const nextIndexAfterPlay = getNextPlayerIndex(table, currentPlayerIndex, 1);
  const nextPlayerAfterPlay = table.players[nextIndexAfterPlay] || null;
  const willStartStack = !activeStack && ((type === 'Draw2' && drawTwoStackingEnabled) || (type === 'Draw4' && drawFourStackingEnabled));
  const willContinueStack = !!activeStack && canContinueStack;

  if (currentPlayer.hand.length === 1) {
    io.to(table.id).emit('actionNotice', currentPlayer.name + ' says Lumo');
  }

  if (currentPlayer.hand.length === 0 && !stackWillBeActive) {
    io.to(actingId).emit('playResult', { success: true, card: card, message: 'You play a ' + cardDescription + '.' });
    emitToTableExcept(table, actingId, 'cardPlayed', { description: cardDescription });
    clearActiveStack(table);
    endRound(table, currentPlayerIndex, 'all_cards_played');
    return;
  }

  // A Give Plus One that would leave exactly one card cannot give that last card
  // away (public/lumo-rules.md), so it plays like a normal card below: no transfer,
  // turn just advances. With two or more cards left, pause here for the giver to
  // choose - the turn does not advance until submitGiveCard resolves it.
  if (type === 'GivePlusOne' && currentPlayer.hand.length >= 2 && nextPlayerAfterPlay) {
    const giveColor = cardColor(card);
    table.game.pendingGive = {
      fromPlayerId: currentPlayer.id,
      fromPlayerName: currentPlayer.name,
      toPlayerId: nextPlayerAfterPlay.id,
      toPlayerName: nextPlayerAfterPlay.name,
      color: giveColor
    };

    io.to(actingId).emit('playResult', {
      success: true,
      card: card,
      message: 'You play a ' + giveColor + ' Give Plus One.'
    });
    io.to(actingId).emit('giveCardPrompt', { toPlayerName: nextPlayerAfterPlay.name, color: giveColor });
    emitToTableExcept(table, actingId, 'actionNotice', currentPlayer.name + ' plays a ' + giveColor + ' Give Plus One.');
    emitTableState(table);

    if (currentPlayer.isBot) {
      scheduleBotAction(table, currentPlayer.id);
    }
    return;
  }

  let turnSteps = 1;
  let drawEffect = null;
  let skippedPlayer = null;
  let directionLabel = null;
  let stackMessage = '';

  if (willStartStack || willContinueStack) {
    if (!activeStack) {
      activateStack(table, currentPlayer, card, chosenColor);
    } else {
      table.game.stack.penalty = (table.game.stack.penalty || 0) + getStackPenaltyAmount(type);
      table.game.stack.activeColor = type === 'Draw4' ? chosenColor : getCurrentBoardColor(table);
      table.game.stack.respondingPlayerId = nextPlayerAfterPlay ? nextPlayerAfterPlay.id : null;
      table.game.stack.respondingPlayerName = nextPlayerAfterPlay ? nextPlayerAfterPlay.name : '';
    }

    table.game.stack.roundEndPending = !!(table.game.stack && table.game.stack.roundEndPending);
    turnSteps = 1;

    stackMessage = activeStack
      ? (currentPlayer.name + ' stacks ' + getStackTypeLabel(type) + '. Draw penalty is now ' + table.game.stack.penalty + '.')
      : (currentPlayer.name + ' plays ' + getStackTypeLabel(type) + '. Draw penalty is now ' + table.game.stack.penalty + '.');

    if (type === 'Draw4') {
      stackMessage += ' ' + capitalizeWord(chosenColor) + ' is the active color.';
    }
  } else if (type === 'Draw2' || type === 'Draw4') {
    const drawCount = type === 'Draw2' ? 2 : 4;
    const targetIndex = nextIndexAfterPlay;
    const targetPlayer = table.players[targetIndex];
    drawCardsFromDeck(table, targetIndex, drawCount);
    const drawnCards = targetPlayer.hand.slice(-drawCount);
    io.to(targetPlayer.id).emit('haveCard', targetPlayer.hand);

    turnSteps = 2;
    const cardTypeName = type === 'Draw2' ? 'Draw Two' : 'Wild Draw Four';
    const drawWord = type === 'Draw2' ? 'two' : 'four';
    const drawnDescriptions = drawnCards.map(function (drawnCard) {
      return describeCardForAnnouncement(drawnCard);
    });

    drawEffect = {
      playerId: targetPlayer.id,
      playerName: targetPlayer.name,
      count: drawCount,
      cards: drawnDescriptions
    };

    io.to(actingId).emit('playResult', {
      success: true,
      card: card,
      message: 'You play a ' + cardTypeName + ' and ' + targetPlayer.name + ' draws ' + drawWord + ' cards.'
    });
  } else {
    io.to(actingId).emit('playResult', { success: true, card: card, message: 'You play a ' + cardDescription + '.' });

    if (type === 'Skip') {
      turnSteps = 2;
      const skippedIndex = getNextPlayerIndex(table, currentPlayerIndex, 1);
      skippedPlayer = table.players[skippedIndex] || null;
    } else if (type === 'Reverse') {
      table.game.reverse = (table.game.reverse + 1) % 2;
      directionLabel = getTurnDirectionLabel(table.game.reverse);
      if (table.players.length === 2) {
        turnSteps = 2;
      }
    }
  }

  const nextIndex = getNextPlayerIndex(table, currentPlayerIndex, turnSteps);
  const nextPlayer = table.players[nextIndex];
  const transition = {
    action: 'play',
    actorId: currentPlayer.id,
    actorName: currentPlayer.name,
    playedCard: describeCardForAnnouncement(card, table.game.chosenColor),
    playedType: type,
    colorChangedTo: isWild ? capitalizeWord(chosenColor) : null,
    actorHasUno: currentPlayer.hand.length === 1,
    direction: directionLabel,
    nextPlayerId: nextPlayer ? nextPlayer.id : null,
    nextPlayerName: nextPlayer ? nextPlayer.name : ''
  };

  if (stackMessage) {
    transition.stackActive = true;
    transition.stackType = type;
    transition.stackPenalty = table.game.stack.penalty;
    transition.stackActiveColor = table.game.stack.activeColor;
    transition.stackMessage = stackMessage;
  }

  if (drawEffect) {
    transition.draw = drawEffect;
  }
  if (skippedPlayer) {
    transition.skippedPlayerId = skippedPlayer.id;
    transition.skippedPlayerName = skippedPlayer.name;
  }

  advanceTurn(table, turnSteps);
  emitTableState(table);
  emitTurnTransition(table, transition);
  emitTurnPlayer(table);
}

function performSubmitGiveCard(table, actingId, payload) {
  if (!table || table.status !== 'in_game' || !table.game || !table.game.pendingGive) {
    io.to(actingId).emit('playResult', { success: false, message: 'There is no pending card to give right now' });
    return;
  }

  const pending = table.game.pendingGive;
  if (pending.fromPlayerId !== actingId) {
    io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn to choose a card to give' });
    return;
  }

  const giver = table.players[getPlayerIndex(table, pending.fromPlayerId)];
  const receiver = table.players[getPlayerIndex(table, pending.toPlayerId)];
  if (!giver || !receiver) {
    table.game.pendingGive = null;
    io.to(actingId).emit('playResult', { success: false, message: 'Unable to complete the card transfer' });
    return;
  }

  const card = payload ? parseInt(payload.card, 10) : NaN;
  const cardPos = giver.hand.indexOf(card);

  // The card just played is already on the discard pile and out of the giver's
  // hand, so this membership check alone keeps it from being given away too.
  if (Number.isNaN(card) || cardPos === -1) {
    io.to(actingId).emit('playResult', { success: false, message: 'Choose a card from your hand to give' });
    return;
  }

  giver.hand.splice(cardPos, 1);
  receiver.hand.push(card);
  table.game.pendingGive = null;

  io.to(giver.id).emit('haveCard', giver.hand);
  io.to(receiver.id).emit('haveCard', receiver.hand);

  const cardDescription = describeCardForAnnouncement(card);
  advanceTurn(table, 1);
  emitTableState(table);

  table.players.forEach(function (player) {
    let message;
    if (player.id === giver.id) {
      message = 'You pass ' + cardDescription + '. It is ' + receiver.name + "'s turn.";
    } else if (player.id === receiver.id) {
      message = giver.name + ' passes ' + cardDescription + ' to you. It is your turn.';
    } else {
      message = giver.name + ' passes ' + cardDescription + ' to ' + receiver.name + ". It is " + receiver.name + "'s turn.";
    }

    io.to(player.id).emit('turnTransition', {
      action: 'give_resolve',
      actorId: giver.id,
      actorName: giver.name,
      nextPlayerId: receiver.id,
      nextPlayerName: receiver.name,
      message: message
    });
  });

  emitTurnPlayer(table);
}

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
    socket.on('__testSetTableState', function (payload) {
      const tableId = payload && payload.tableId;
      const table = tableId ? tables[tableId] : null;
      if (!table) {
        socket.emit('serverMessage', { type: 'error', message: 'Test table not found' });
        return;
      }

      if (!table.game) {
        initializeGameState(table);
      }

      if (payload.matchSettings) {
        table.matchSettings = normalizeMatchSettings({
          ...getMatchSettings(table),
          ...payload.matchSettings
        });
      }

      if (typeof payload.status === 'string') {
        table.status = payload.status;
      }

      if (payload.game) {
        if (typeof payload.game.turn === 'number') {
          table.game.turn = payload.game.turn;
        }
        if (typeof payload.game.reverse === 'number') {
          table.game.reverse = payload.game.reverse;
        }
        if (typeof payload.game.cardOnBoard === 'number') {
          table.game.cardOnBoard = payload.game.cardOnBoard;
        }
        if (typeof payload.game.chosenColor === 'string' || payload.game.chosenColor === null) {
          table.game.chosenColor = payload.game.chosenColor;
        }
        if (Array.isArray(payload.game.deck)) {
          table.game.deck = payload.game.deck.slice();
        }
        if (payload.game.stack) {
          table.game.stack = Object.assign(createInactiveStackState(), payload.game.stack);
        }
        if (payload.game.pendingGive) {
          table.game.pendingGive = Object.assign({}, payload.game.pendingGive);
        }
        if (typeof payload.game.locked === 'boolean') {
          table.game.locked = payload.game.locked;
        }
        if (typeof payload.game.hasDrawn === 'boolean') {
          table.game.hasDrawn = payload.game.hasDrawn;
        }
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

      emitTableState(table);

      if (payload.emitDiscardCard) {
        emitDiscardCard(table);
      }

      if (payload.emitTurnPlayer) {
        emitTurnPlayer(table);
      }
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
      matchSettings: normalizeMatchSettings(payload),
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

    if (table.gameType && table.gameType !== DEFAULT_GAME_TYPE) {
      socket.emit('serverMessage', { type: 'error', message: getGameDefinition(table.gameType).name + ' is not available yet' });
      return;
    }

    if (table.status === 'in_game') {
      socket.emit('serverMessage', { type: 'error', message: 'Cannot join a game already in progress' });
      return;
    }

    if (table.players.length >= MAX_TABLE_PLAYERS) {
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
    const targetSocket = removedPlayer.isBot ? null : io.sockets.connected[targetId];

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

    const result = startGameForTable(table);
    console.log('startGame result', { success: result.success, tableId: table.id, status: table.status, game: !!table.game, players: table.players.length });
    if (!result.success) {
      socket.emit('serverMessage', { type: 'error', message: result.message });
      return;
    }

    io.to(table.id).emit('actionNotice', 'Game started');
  });

  socket.on('requestDiscardCard', function () {
    const table = findTableBySocket(socket);
    if (!table || table.status !== 'in_game' || !table.game) {
      socket.emit('discardCardInfo', { success: false, message: 'No discard card yet' });
      return;
    }

    socket.emit('discardCardInfo', {
      success: true,
      message: describeCard(table.game.cardOnBoard, table.game.chosenColor)
    });
  });

  socket.on('ackRoundSummary', function () {
    const table = findTableBySocket(socket);
    if (!table || !table.game || !table.game.pendingRoundAcks) {
      return;
    }

    delete table.game.pendingRoundAcks[socket.id];
    tryBeginNextRound(table);
  });

  socket.on('drawCard', function () {
    performDrawCard(findTableBySocket(socket), socket.id);
  });

  socket.on('acceptStackPenalty', function () {
    performAcceptStackPenalty(findTableBySocket(socket), socket.id);
  });

  socket.on('playCard', function (payload) {
    performPlayCard(findTableBySocket(socket), socket.id, payload);
  });

  socket.on('submitGiveCard', function (payload) {
    performSubmitGiveCard(findTableBySocket(socket), socket.id, payload);
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
// server as normal, this just additionally exposes a few pure helpers.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createDeck: createDeck,
    cardColor: cardColor,
    cardType: cardType,
    cardScore: cardScore,
    describeCard: describeCard,
    isGivePlusOneCard: isGivePlusOneCard
  };
}
