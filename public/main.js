// Socket.IO's default path ("/socket.io") is absolute, so it breaks when this
// app is reverse-proxied under a sub-path (e.g. valhalla.com/games/). Derive
// the Socket.IO path from the current page location so it works whether the
// app is served from the domain root or from a proxied sub-path.
const socketIoPath = window.location.pathname.replace(/[^/]*$/, '') + 'socket.io';
const socket = io({ path: socketIoPath, autoConnect: true });

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const cdWidth = 240;
const cdHeight = 360;
const playerEmailStorageKey = 'unoPlayerEmail';
const displayNameStorageKey = 'unoDisplayName';
const rememberTokenStorageKey = 'unoRememberToken';

const GAME_CATALOG = {
  uno: { type: 'uno', name: 'Lumo', playable: true, description: 'Join a live Lumo table.' },
  hearts: { type: 'hearts', name: 'Hearts', playable: false, description: 'Hearts is not implemented yet.' },
  spades: { type: 'spades', name: 'Spades', playable: false, description: 'Spades is not implemented yet.' },
  cribbage: { type: 'cribbage', name: 'Cribbage', playable: false, description: 'Cribbage is not implemented yet.' }
};

const PLAY_HISTORY_MAX_LINES = 5;

const WILD_PICKER_COLORS = ['red', 'yellow', 'green', 'blue'];

// Lumo card artwork: one SVG file per card in public/images/lumo/cards (see
// FILE_LIST.txt there). Images are loaded lazily and cached by filename since,
// unlike the old UNO sprite sheet, each card is now its own file.
const CARD_IMAGE_BASE = 'images/lumo/cards/';
const cardImageCache = {};

function getCardImageFileName(card) {
  if (card === 'back') {
    return 'card_back.svg';
  }

  const type = cardType(card);
  if (type === 'Wild') {
    return 'wild.svg';
  }
  if (type === 'Draw4') {
    return 'wild_draw_plus_4.svg';
  }

  const color = cardColor(card);
  if (type === 'Skip') {
    return color + '_skip.svg';
  }
  if (type === 'Reverse') {
    return color + '_reverse.svg';
  }
  if (type === 'Draw2') {
    return color + '_draw_plus_2.svg';
  }
  if (type === 'GivePlusOne') {
    return color + '_give_plus_1.svg';
  }

  return color + '_' + (card % 14) + '.svg';
}

function redrawBoard() {
  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    return;
  }

  drawHand();
  if (typeof appState.discard === 'number') {
    drawDiscard(appState.discard);
  }
  drawDeckBack();
  drawTurnIndicator(appState.turnIndicatorText);
}

function getCardImage(card) {
  const filename = getCardImageFileName(card);
  let image = cardImageCache[filename];
  if (!image) {
    image = new Image();
    image.addEventListener('load', redrawBoard);
    image.src = CARD_IMAGE_BASE + filename;
    cardImageCache[filename] = image;
  }
  return image;
}

const appState = {
  loggedIn: false,
  accountEmail: '',
  playerName: '',
  currentScreen: 'auth',
  selectedGameType: null,
  selectedGameName: '',
  resumeLoginPending: false,
  currentTable: null,
  hand: [],
  handIndex: 0,
  turn: false,
  discard: null,
  discardChosenColor: null,
  selectedLobbyIndex: 0,
  lobbyTables: [],
  gameStatus: 'waiting',
  isHost: false,
  helpOpen: false,
  pendingDrawCard: null,
  handBeforeDraw: null,
  tableStatusMessage: 'Join a table to start playing.',
  tableStatusTone: 'info',
  currentTurnPlayerId: null,
  currentTurnPlayerName: '',
  nextPlayerId: null,
  nextPlayerName: '',
  playDirection: 'clockwise',
  currentTurnTopDiscard: '',
  turnIndicatorText: '',
  suppressTurnAnnouncementForPlayerId: null,
  lastAnnouncedTurnPlayerId: null,
  announcementTimer: null,
  announcementOpen: false,
  announcementKind: null,
  pendingWildCard: null,
  pendingWildColor: 'red',
  rulesOpen: false,
  rulesReturnFocusEl: null,
  kickOpen: false,
  kickReturnFocusEl: null,
  pendingRoundDealAnnouncement: false,
  playHistory: [],
  roundResultMessage: '',
  speechLockUntil: 0,
  lastBoardFocusAt: 0,
  lastBoardFocusMessage: ''
};

let audioContext = null;

let speechRenderTimer = null;
const touchBridgeSuppressMs = 450;

const el = {
  authView: document.getElementById('auth-view'),
  gamePickerView: document.getElementById('game-picker-view'),
  placeholderView: document.getElementById('placeholder-view'),
  accountBar: document.getElementById('account-bar'),
  accountLabel: document.getElementById('account-label'),
  lobbyView: document.getElementById('lobby-view'),
  tableView: document.getElementById('table-view'),
  gamePanel: document.getElementById('game-panel'),
  authStatus: document.getElementById('auth-status'),
  emailInput: document.getElementById('email-input'),
  passwordInput: document.getElementById('password-input'),
  displayNameInput: document.getElementById('display-name-input'),
  rememberMeInput: document.getElementById('remember-me-input'),
  loginBtn: document.getElementById('login-btn'),
  createAccountBtn: document.getElementById('create-account-btn'),
  deleteAccountBtn: document.getElementById('delete-account-btn'),
  clearSavedBtn: document.getElementById('clear-saved-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  deleteAccountAuthBtn: document.getElementById('delete-account-auth-btn'),
  lobbySummary: document.getElementById('lobby-summary'),
  tableList: document.getElementById('table-list'),
  joinTableBtn: document.getElementById('join-table-btn'),
  refreshLobbyBtn: document.getElementById('refresh-lobby-btn'),
  newTableName: document.getElementById('new-table-name'),
  newTableCode: document.getElementById('new-table-code'),
  createTableBtn: document.getElementById('create-table-btn'),
  tableMeta: document.getElementById('table-meta'),
  tableHost: document.getElementById('table-host'),
  tableMatchSettings: document.getElementById('table-match-settings'),
  tableStatus: document.getElementById('table-status'),
  playDirection: document.getElementById('play-direction'),
  roundResult: document.getElementById('round-result'),
  playerSummary: document.getElementById('player-summary'),
  startGameBtn: document.getElementById('start-game-btn'),
  leaveTableBtn: document.getElementById('leave-table-btn'),
  kickPlayerBtn: document.getElementById('kick-player-btn'),
  kickPlayerOverlay: document.getElementById('kick-player-overlay'),
  kickPlayerTitle: document.getElementById('kick-player-title'),
  kickPlayerList: document.getElementById('kick-player-list'),
  kickPlayerCancelBtn: document.getElementById('kick-player-cancel-btn'),
  gamePickerSummary: document.getElementById('game-picker-summary'),
  placeholderTitle: document.getElementById('placeholder-title'),
  placeholderMessage: document.getElementById('placeholder-message'),
  placeholderBackBtn: document.getElementById('placeholder-back-btn'),
  placeholderUnoBtn: document.getElementById('placeholder-uno-btn'),
  selectUnoBtn: document.getElementById('select-uno-btn'),
  selectHeartsBtn: document.getElementById('select-hearts-btn'),
  selectSpadesBtn: document.getElementById('select-spades-btn'),
  selectCribbageBtn: document.getElementById('select-cribbage-btn'),
  helpOverlay: document.getElementById('help-overlay'),
  closeHelpBtn: document.getElementById('close-help-btn'),
  announcementOverlay: document.getElementById('announcement-overlay'),
  announcementEyebrow: document.getElementById('announcement-eyebrow'),
  announcementTitle: document.getElementById('announcement-title'),
  announcementMessage: document.getElementById('announcement-message'),
  closeAnnouncementBtn: document.getElementById('close-announcement-btn'),
  colorPickerOverlay: document.getElementById('color-picker-overlay'),
  colorPickerOptions: document.getElementById('color-picker-options'),
  colorPickerSelection: document.getElementById('color-picker-selection'),
  colorPickerConfirmBtn: document.getElementById('color-picker-confirm-btn'),
  colorPickerCancelBtn: document.getElementById('color-picker-cancel-btn'),
  openRulesBtn: document.getElementById('open-rules-btn'),
  rulesOverlay: document.getElementById('rules-overlay'),
  rulesTitle: document.getElementById('rules-title'),
  rulesContent: document.getElementById('rules-content'),
  closeRulesBtn: document.getElementById('close-rules-btn'),
  newTableWinningScore: document.getElementById('new-table-winning-score'),
  newTableMaxRounds: document.getElementById('new-table-max-rounds'),
  allowDrawTwoStacking: document.getElementById('allow-draw-two-stacking'),
  allowWildDrawFourStacking: document.getElementById('allow-wild-draw-four-stacking'),
  newTableComputerPlayers: document.getElementById('new-table-computer-players'),
  newTableComputerSkill: document.getElementById('new-table-computer-skill'),
  stackControls: document.getElementById('stack-controls'),
  stackStatus: document.getElementById('stack-status'),
  acceptStackBtn: document.getElementById('accept-stack-btn'),
  playHistoryList: document.getElementById('play-history-list')
};

function setAuthStatus(message, tone) {
  if (!el.authStatus) {
    return;
  }

  el.authStatus.textContent = message || '';
  el.authStatus.className = 'table-status' + (message ? ' ' + (tone || 'info') : '');
}

function setTableStatus(message, tone) {
  appState.tableStatusMessage = message || '';
  appState.tableStatusTone = tone || 'info';

  if (!el.tableStatus) {
    return;
  }

  el.tableStatus.textContent = appState.tableStatusMessage;
  el.tableStatus.className = 'table-status ' + appState.tableStatusTone;
}

function setRoundResult(message) {
  appState.roundResultMessage = message || '';

  if (!el.roundResult) {
    return;
  }

  el.roundResult.textContent = appState.roundResultMessage;
}

function renderPlayHistory() {
  if (!el.playHistoryList) {
    return;
  }

  el.playHistoryList.innerHTML = '';
  const start = Math.max(0, appState.playHistory.length - PLAY_HISTORY_MAX_LINES);
  const visible = appState.playHistory.slice(start);
  for (let i = 0; i < PLAY_HISTORY_MAX_LINES; i++) {
    const li = document.createElement('li');
    li.textContent = visible[i] || '';
    el.playHistoryList.appendChild(li);
  }
}

function clearPlayHistory() {
  appState.playHistory = [];
  renderPlayHistory();
}

function pushPlayHistory(line) {
  if (!line || typeof line !== 'string') {
    return;
  }

  appState.playHistory.push(line.trim());
  while (appState.playHistory.length > PLAY_HISTORY_MAX_LINES) {
    appState.playHistory.shift();
  }
  renderPlayHistory();
}

function drawCountText(count) {
  if (count === 1) {
    return 'a card';
  }
  if (count === 2) {
    return 'two cards';
  }
  if (count === 4) {
    return 'four cards';
  }
  return count + ' cards';
}

function buildPlayHistoryLine(payload) {
  if (!payload || !payload.actorId) {
    return '';
  }

  const actorName = payload.actorName || 'A player';
  const playedCard = payload.playedCard || '';
  const draw = payload.draw && payload.draw.count > 0 ? payload.draw : null;

  if (payload.action === 'play' && playedCard) {
    let line = actorName + ' played ' + playedCard;

    if (draw && draw.playerId && draw.playerId !== payload.actorId) {
      line += ' and ' + (draw.playerName || 'another player') + ' drew ' + drawCountText(draw.count);
    }

    return line;
  }

  if (payload.action === 'give_resolve') {
    return actorName + ' gave a card to ' + (payload.nextPlayerName || 'the next player');
  }

  if (payload.action === 'draw_pass' && draw) {
    return actorName + ' drew a card and turn passed to ' + (payload.nextPlayerName || 'the next player');
  }

  if (payload.action === 'stack_resolve' || payload.action === 'give_resolve') {
    const message = payload.message || payload.stackMessage || '';
    if (!message) {
      return '';
    }

    // Hide private card identities if present in per-player messages.
    return message
      .replace(/\bpass(?:es|ed)?\s+[^.]+?\s+to\s+/i, 'gave a card to ')
      .replace(/\bYou\s+pass\s+[^.]+\./i, actorName + ' gave a card.');
  }

  return '';
}

function normalizeDirection(direction) {
  if (typeof direction !== 'string') {
    return 'clockwise';
  }

  return direction.toLowerCase() === 'counterclockwise'
    ? 'counterclockwise'
    : 'clockwise';
}

function getDirectionLabel(direction) {
  return normalizeDirection(direction) === 'counterclockwise'
    ? 'Counterclockwise'
    : 'Clockwise';
}

function getUpcomingPlayerFromDirection() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players) || !appState.currentTable.players.length) {
    return null;
  }

  if (!appState.currentTurnPlayerId) {
    return null;
  }

  const players = appState.currentTable.players;
  const currentIndex = players.findIndex(function (player) {
    return player.id === appState.currentTurnPlayerId;
  });

  if (currentIndex === -1) {
    return null;
  }

  const step = normalizeDirection(appState.playDirection) === 'counterclockwise' ? -1 : 1;
  const nextIndex = (currentIndex + step + players.length) % players.length;
  return players[nextIndex] || null;
}

function setPlayDirectionIndicator() {
  if (!el.playDirection) {
    return;
  }

  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    el.playDirection.textContent = '';
    return;
  }

  const directionText = 'Direction: ' + getDirectionLabel(appState.playDirection);
  let nextText = 'Waiting for next turn';
  const upcomingPlayer = getUpcomingPlayerFromDirection();

  if (upcomingPlayer) {
    nextText = upcomingPlayer.id === socket.id
      ? 'Next: You'
      : ('Next: ' + (upcomingPlayer.name || 'Another player'));
  } else if (appState.nextPlayerId || appState.nextPlayerName) {
    nextText = appState.nextPlayerId === socket.id
      ? 'Next: You'
      : ('Next: ' + (appState.nextPlayerName || 'Another player'));
  }

  el.playDirection.textContent = directionText + ' | ' + nextText;
}

function speakDirectionAndNextPlayer() {
  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    srSpeak('Game has not started yet', 'assertive', { canInterruptLock: true });
    return;
  }

  const directionText = 'Play direction is ' + getDirectionLabel(appState.playDirection).toLowerCase() + '.';
  let nextText = 'Next player is not known yet.';
  const upcomingPlayer = getUpcomingPlayerFromDirection();

  if (upcomingPlayer) {
    nextText = upcomingPlayer.id === socket.id
      ? 'You play next.'
      : ((upcomingPlayer.name || 'Another player') + ' plays next.');
  } else if (appState.nextPlayerId || appState.nextPlayerName) {
    nextText = appState.nextPlayerId === socket.id
      ? 'You play next.'
      : ((appState.nextPlayerName || 'Another player') + ' plays next.');
  }

  srSpeak(directionText + ' ' + nextText, 'assertive', { canInterruptLock: true });
}

function maybeAnnounceNewRoundHand() {
  if (!appState.pendingRoundDealAnnouncement) {
    return;
  }

  if (!Array.isArray(appState.hand) || !appState.hand.length) {
    return;
  }

  if (!appState.currentTurnPlayerId) {
    return;
  }

  const handText = appState.hand.map(function (card) {
    return describeCardForSpeech(card);
  }).join(' ');

  const turnText = appState.turn
    ? 'Your turn.'
    : ((appState.currentTurnPlayerName || 'Another player') + "'s turn.");

  appState.pendingRoundDealAnnouncement = false;
  focusBoardForA11y({
    announceOnFocus: false
  });
  srSpeak(handText + '. ' + turnText, appState.turn ? 'assertive' : 'polite', { canInterruptLock: true });
}

function getBoardFocusMessage() {
  const handText = appState.hand.length
    ? ('Your hand: ' + appState.hand.map(function (card) {
      return describeCardForSpeech(card);
    }).join(', ') + '.')
    : 'Your hand is empty.';

  const turnText = appState.currentTurnPlayerId
    ? (appState.turn ? 'It is your turn.' : ((appState.currentTurnPlayerName || 'Another player') + " has the turn."))
    : 'Waiting for the next turn.';

  const discardText = appState.currentTurnTopDiscard
    ? ('Top discard is ' + appState.currentTurnTopDiscard + '.')
    : '';

  return (handText + ' ' + turnText + (discardText ? (' ' + discardText) : '')).trim();
}

function maybeAnnounceBoardFocus(priority) {
  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    return;
  }

  const message = getBoardFocusMessage();
  const now = Date.now();
  const isDuplicate = message === appState.lastBoardFocusMessage && (now - appState.lastBoardFocusAt) < 1200;
  if (isDuplicate) {
    return;
  }

  appState.lastBoardFocusMessage = message;
  appState.lastBoardFocusAt = now;
  srSpeak(message, priority || 'polite', { canInterruptLock: true });
}

function focusBoardForA11y(options) {
  const announceOnFocus = !!(options && options.announceOnFocus);

  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    return;
  }

  if (appState.helpOpen || appState.announcementOpen || appState.rulesOpen
    || appState.kickOpen
    || (el.colorPickerOverlay && !el.colorPickerOverlay.classList.contains('hidden'))) {
    return;
  }

  window.requestAnimationFrame(function () {
    if (document.activeElement !== canvas) {
      canvas.focus();
    }

    if (announceOnFocus) {
      maybeAnnounceBoardFocus(appState.turn ? 'assertive' : 'polite');
    }
  });
}

function handleCanvasFocus() {
  maybeAnnounceBoardFocus('polite');
}

function getGameDefinition(gameType) {
  return GAME_CATALOG[gameType] || null;
}

function randomFourDigitCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function setScreen(screen) {
  appState.currentScreen = screen;
  if (screen === 'lobby' && el.newTableCode) {
    el.newTableCode.value = randomFourDigitCode();
  }
  render();
}

function speakCurrentTurnBrief() {
  if (!appState.currentTurnPlayerName) {
    srSpeak('No active turn', 'assertive', { canInterruptLock: true });
    return;
  }

  const discardText = appState.currentTurnTopDiscard || 'no discard yet';
  const turnOwner = appState.turn ? 'Your turn' : ((appState.currentTurnPlayerName || 'Another player') + "'s turn");
  srSpeak(turnOwner + '. ' + discardText + ' shown', 'assertive', { canInterruptLock: true });
}

function capitalizeWord(word) {
  if (typeof word !== 'string' || !word) {
    return '';
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function playTone(frequency, durationMs) {
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }
      audioContext = new AudioContextClass();
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + durationMs / 1000);
  } catch (error) {
    console.warn('Unable to play tone', error);
  }
}

function playErrorTone() {
  playTone(430, 250);
}

function clearRememberedLogin() {
  try {
    window.localStorage.removeItem(rememberTokenStorageKey);
  } catch (error) {
    console.warn('Unable to clear remembered login', error);
  }
}

function storeRememberedLogin(token) {
  try {
    if (token) {
      window.localStorage.setItem(rememberTokenStorageKey, token);
    } else {
      window.localStorage.removeItem(rememberTokenStorageKey);
    }
  } catch (error) {
    console.warn('Unable to store remembered login', error);
  }
}

function attemptResumeLogin() {
  if (appState.loggedIn || appState.resumeLoginPending) {
    return;
  }

  let token = '';
  try {
    token = window.localStorage.getItem(rememberTokenStorageKey) || '';
  } catch (error) {
    console.warn('Unable to read remembered login', error);
    return;
  }

  if (!token) {
    return;
  }

  appState.resumeLoginPending = true;
  socket.emit('resumeLogin', { token: token });
}

function resetLoggedInState() {
  appState.loggedIn = false;
  appState.accountEmail = '';
  appState.playerName = '';
  appState.currentTable = null;
  appState.turn = false;
  appState.hand = [];
  appState.handIndex = 0;
  appState.handBeforeDraw = null;
  appState.discard = null;
  appState.discardChosenColor = null;
  appState.pendingDrawCard = null;
  appState.gameStatus = 'waiting';
  appState.isHost = false;
  appState.currentTurnPlayerId = null;
  appState.nextPlayerId = null;
  appState.nextPlayerName = '';
  appState.playDirection = 'clockwise';
  appState.turnIndicatorText = '';
  appState.suppressTurnAnnouncementForPlayerId = null;
  appState.pendingRoundDealAnnouncement = false;
  appState.playHistory = [];
  appState.roundResultMessage = '';
}

function showGamePicker() {
  appState.selectedGameType = null;
  appState.selectedGameName = '';
  appState.currentTable = null;
  setScreen('game-picker');
  window.setTimeout(function () {
    if (el.selectUnoBtn) {
      el.selectUnoBtn.focus();
    }
  }, 0);
}

function openGamePlaceholder(gameType) {
  const gameDefinition = getGameDefinition(gameType);
  if (!gameDefinition) {
    return;
  }

  appState.selectedGameType = gameDefinition.type;
  appState.selectedGameName = gameDefinition.name;
  appState.currentTable = null;
  setScreen('placeholder');
  if (el.placeholderTitle) {
    el.placeholderTitle.textContent = gameDefinition.name;
  }
  if (el.placeholderMessage) {
    el.placeholderMessage.textContent = gameDefinition.description + ' Lumo is the only playable game right now.';
  }
  window.setTimeout(function () {
    if (el.placeholderBackBtn) {
      el.placeholderBackBtn.focus();
    }
  }, 0);
}

function selectGame(gameType) {
  const gameDefinition = getGameDefinition(gameType);
  if (!gameDefinition) {
    srSpeak('That game is not available', 'assertive');
    return;
  }

  if (!gameDefinition.playable) {
    openGamePlaceholder(gameDefinition.type);
    srSpeak(gameDefinition.name + ' is not implemented yet', 'assertive');
    return;
  }

  appState.selectedGameType = gameDefinition.type;
  appState.selectedGameName = gameDefinition.name;
  appState.currentTable = null;
  setScreen('lobby');
  socket.emit('requestLobbySnapshot');
  srSpeak('Selected ' + gameDefinition.name, 'polite');
}

function init() {
  getCardImage('back');
  canvas.style.backgroundColor = '#10ac84';

  try {
    el.emailInput.value = window.localStorage.getItem(playerEmailStorageKey) || '';
    el.displayNameInput.value = window.localStorage.getItem(displayNameStorageKey) || '';
  } catch (error) {
    console.warn('Unable to read saved auth fields', error);
  }

  bindUi();
  if (socket.connected) {
    attemptResumeLogin();
  }
  render();
}

function bindUi() {
  bindPress(el.loginBtn, login);
  bindPress(el.createAccountBtn, createAccount);
  bindPress(el.deleteAccountBtn, deleteAccountFromAuthForm);
  bindPress(el.clearSavedBtn, clearSavedEmail);
  bindPress(el.logoutBtn, logout);
  bindPress(el.deleteAccountAuthBtn, deleteLoggedInAccount);
  bindPress(el.refreshLobbyBtn, function () {
    socket.emit('requestLobbySnapshot');
  });
  bindPress(el.createTableBtn, createTable);
  bindPress(el.joinTableBtn, joinSelectedTable);
  bindPress(el.startGameBtn, startGame);
  bindPress(el.leaveTableBtn, leaveTable);
  bindPress(el.kickPlayerBtn, openKickPlayerOverlay);
  bindPress(el.kickPlayerCancelBtn, closeKickPlayerOverlay);
  bindPress(el.placeholderBackBtn, function () {
    showGamePicker();
  });
  bindPress(el.placeholderUnoBtn, function () {
    selectGame('uno');
  });
  bindPress(el.selectUnoBtn, function () {
    selectGame('uno');
  });
  bindPress(el.selectHeartsBtn, function () {
    selectGame('hearts');
  });
  bindPress(el.selectSpadesBtn, function () {
    selectGame('spades');
  });
  bindPress(el.selectCribbageBtn, function () {
    selectGame('cribbage');
  });
  bindPress(el.closeHelpBtn, closeHelpOverlay);
  bindPress(el.closeAnnouncementBtn, function () {
    closeAnnouncementOverlay();
  });
  el.announcementOverlay.addEventListener('click', function (event) {
    // The overlay backdrop covers the full viewport (see .overlay in style.css),
    // so a click meant for a control behind it (e.g. Leave Table) lands here
    // instead and would otherwise be silently swallowed until the auto-dismiss
    // timer fires. Treat a direct backdrop click as "dismiss" so it isn't a dead
    // click - the user just has to click their intended control a second time.
    if (event.target === el.announcementOverlay) {
      closeAnnouncementOverlay();
    }
  });
  bindPressNoFocus(el.colorPickerConfirmBtn, confirmColorPicker);
  bindPressNoFocus(el.colorPickerCancelBtn, cancelColorPicker);
  if (el.colorPickerOptions) {
    const colorButtons = el.colorPickerOptions.querySelectorAll('[data-wild-color]');
    colorButtons.forEach(function (button) {
      bindPressNoFocus(button, function () {
        const color = button.getAttribute('data-wild-color');
        setPendingWildColor(color, { announce: true });
      });
    });
  }
  bindPress(el.acceptStackBtn, acceptStackPenalty);
  bindPress(el.openRulesBtn, openRulesOverlay);
  bindPress(el.closeRulesBtn, closeRulesOverlay);
  el.rulesOverlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeRulesOverlay();
      event.preventDefault();
    }
  });
  el.colorPickerOverlay.addEventListener('keydown', function (event) {
    const handled = handleColorPickerKey((event.key || '').toLowerCase());
    if (handled) {
      event.preventDefault();
    }
  });

  el.helpOverlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeHelpOverlay();
      event.preventDefault();
    }
  });

  el.kickPlayerOverlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeKickPlayerOverlay();
      event.preventDefault();
    }
  });

  el.emailInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      login();
    }
  });

  el.passwordInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      login();
    }
  });

  el.displayNameInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      createAccount();
    }
  });

  el.newTableName.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      createTable();
    }
  });

  el.tableList.addEventListener('keydown', handleLobbyListKeys);

  if (window.CardTableTouch && typeof window.CardTableTouch.installTouchClickBridge === 'function') {
    window.CardTableTouch.installTouchClickBridge(canvas, onMouseClick, {
      suppressMs: touchBridgeSuppressMs,
      preventDefaultOnTouch: true
    });
  } else {
    canvas.addEventListener('click', onMouseClick, false);
    canvas.addEventListener('touchstart', onMouseClick, { passive: false });
  }
  canvas.addEventListener('keydown', handleGameKeys);
  canvas.addEventListener('focus', handleCanvasFocus);
}

function bindPress(element, handler) {
  if (!element || typeof handler !== 'function') {
    return;
  }

  if (window.CardTableTouch && typeof window.CardTableTouch.installTouchClickBridge === 'function') {
    window.CardTableTouch.installTouchClickBridge(element, function (event) {
      if (element && typeof element.focus === 'function' && document.activeElement !== element) {
        element.focus();
      }
      handler(event);
    }, {
      suppressMs: touchBridgeSuppressMs,
      preventDefaultOnTouch: true
    });
    return;
  }

  element.addEventListener('click', function (event) {
    handler(event);
  });

  element.addEventListener('touchend', function (event) {
    if (!event.changedTouches || !event.changedTouches.length) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    if (element && typeof element.focus === 'function') {
      element.focus();
    }
    handler(event);
  }, { passive: false });
}

function bindPressNoFocus(element, handler) {
  if (!element || typeof handler !== 'function') {
    return;
  }

  if (window.CardTableTouch && typeof window.CardTableTouch.installTouchClickBridge === 'function') {
    window.CardTableTouch.installTouchClickBridge(element, function (event) {
      handler(event);
    }, {
      suppressMs: touchBridgeSuppressMs,
      preventDefaultOnTouch: true
    });
    return;
  }

  element.addEventListener('click', function (event) {
    handler(event);
  });

  element.addEventListener('touchend', function (event) {
    if (!event.changedTouches || !event.changedTouches.length) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    handler(event);
  }, { passive: false });
}

function login() {
  const email = (el.emailInput.value || '').trim();
  const password = el.passwordInput.value || '';

  if (!email || !password) {
    srSpeak('Enter email and password before logging in', 'assertive');
    return;
  }

  socket.emit('login', {
    email: email,
    password: password,
    rememberMe: !!(el.rememberMeInput && el.rememberMeInput.checked)
  });
}

function createAccount() {
  const email = (el.emailInput.value || '').trim();
  const password = el.passwordInput.value || '';
  const displayName = (el.displayNameInput.value || '').trim();

  if (!email || !password || !displayName) {
    srSpeak('Email, password, and display name are required to create an account', 'assertive');
    return;
  }

  socket.emit('registerAccount', {
    email: email,
    password: password,
    displayName: displayName,
    rememberMe: !!(el.rememberMeInput && el.rememberMeInput.checked)
  });
}

function clearSavedEmail() {
  try {
    window.localStorage.removeItem(playerEmailStorageKey);
  } catch (error) {
    console.warn('Unable to clear saved email', error);
  }
  el.emailInput.value = '';
  el.emailInput.focus();
  srSpeak('Saved email cleared', 'polite');
}

function logout() {
  socket.emit('logout');
}

function deleteAccountFromAuthForm() {
  const email = (el.emailInput.value || '').trim();
  const password = el.passwordInput.value || '';

  if (!email || !password) {
    srSpeak('Enter email and password to delete the account', 'assertive');
    return;
  }

  if (!window.confirm('Delete this account permanently? This frees the display name.')) {
    return;
  }

  socket.emit('deleteAccount', {
    email: email,
    password: password
  });
}

function deleteLoggedInAccount() {
  if (!window.confirm('Delete your account permanently? This frees your display name.')) {
    return;
  }

  const password = window.prompt('Enter your password to confirm account deletion', '');
  if (password === null) {
    return;
  }

  socket.emit('deleteAccount', { password: password });
}

function isValidFourDigitCode(rawValue) {
  return /^\d{4}$/.test(rawValue);
}

function createTable() {
  const tableName = (el.newTableName.value || '').trim();
  if (!tableName) {
    srSpeak('Enter a table name first', 'assertive');
    return;
  }

  const selectedGameType = appState.selectedGameType || 'uno';
  const selectedGame = getGameDefinition(selectedGameType);
  if (!selectedGame || !selectedGame.playable) {
    srSpeak('Select Lumo to create a playable table', 'assertive');
    return;
  }

  const rawCode = ((el.newTableCode && el.newTableCode.value) || '').trim();
  if (rawCode && !isValidFourDigitCode(rawCode)) {
    srSpeak('Table code must be exactly 4 digits, or left blank for an open table', 'assertive');
    return;
  }

  const winningScore = parseInt(el.newTableWinningScore && el.newTableWinningScore.value, 10);
  const maxRounds = parseInt(el.newTableMaxRounds && el.newTableMaxRounds.value, 10);
  const computerPlayers = parseInt(el.newTableComputerPlayers && el.newTableComputerPlayers.value, 10);

  socket.emit('createTable', {
    name: tableName,
    gameType: selectedGame.type,
    securityCode: rawCode || undefined,
    winningScore: Number.isFinite(winningScore) ? winningScore : undefined,
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined,
    allowDrawTwoStacking: !!(el.allowDrawTwoStacking && el.allowDrawTwoStacking.checked),
    allowWildDrawFourStacking: !!(el.allowWildDrawFourStacking && el.allowWildDrawFourStacking.checked),
    computerPlayers: Number.isFinite(computerPlayers) ? computerPlayers : undefined,
    computerSkill: el.newTableComputerSkill ? el.newTableComputerSkill.value : undefined
  });
}

// Shared by the "Join Selected Table" button and clicking a table in the list -
// both just need a table id, prompting first for a code if the table requires one.
function attemptJoinTable(table) {
  let code;
  if (table.hasCode) {
    code = window.prompt('This table requires a 4-digit code to join', '');
    if (code === null) {
      return;
    }
  }

  socket.emit('joinTable', { tableId: table.id, code: code });
}

function joinSelectedTable() {
  const tables = appState.lobbyTables.filter(function (table) {
    return !appState.selectedGameType || table.gameType === appState.selectedGameType;
  });
  const selected = tables[appState.selectedLobbyIndex];
  if (!selected) {
    srSpeak('No table selected', 'assertive');
    return;
  }

  attemptJoinTable(selected);
}

function leaveTable() {
  socket.emit('leaveTable');
}

function startGame() {
  socket.emit('startGame');
}

function acceptStackPenalty() {
  if (!appState.currentTable || appState.gameStatus !== 'in_game' || !appState.currentTable.stackState || !appState.currentTable.stackState.active) {
    srSpeak('No active draw stack', 'assertive');
    return;
  }

  socket.emit('acceptStackPenalty');
}

function handleLobbyListKeys(event) {
  if (appState.currentTable) {
    return;
  }

  const tables = appState.lobbyTables.filter(function (table) {
    return !appState.selectedGameType || table.gameType === appState.selectedGameType;
  });

  if (!tables.length) {
    return;
  }

  if (event.key === 'ArrowDown') {
    appState.selectedLobbyIndex = Math.min(appState.selectedLobbyIndex + 1, tables.length - 1);
    renderLobbyTables();
    event.preventDefault();
  } else if (event.key === 'ArrowUp') {
    appState.selectedLobbyIndex = Math.max(appState.selectedLobbyIndex - 1, 0);
    renderLobbyTables();
    event.preventDefault();
  } else if (event.key === 'Enter') {
    joinSelectedTable();
    event.preventDefault();
  }
}

function onMouseClick(event) {
  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    return;
  }

  if (appState.helpOpen || appState.rulesOpen || appState.kickOpen) {
    return;
  }

  if (event.target !== canvas) {
    return;
  }

  if (event.cancelable) {
    event.preventDefault();
  }

  canvas.focus();

  const pointer = event.changedTouches && event.changedTouches.length
    ? event.changedTouches[0]
    : event;
  const rect = canvas.getBoundingClientRect();
  const x = pointer.clientX - rect.left;
  const y = pointer.clientY - rect.top;

  const hand = appState.hand;
  const handTop = getHandTopY();
  const handBottom = getHandBottomY();
  const spacing = canvas.width / (2 + Math.max(0, hand.length - 1));
  const lastCard = (hand.length / 112) * (cdWidth / 3) + spacing * hand.length - (cdWidth / 4) + (cdWidth / 2);
  const firstCard = 2 + (hand.length / 112) * (cdWidth / 3) + spacing - (cdWidth / 4);

  if (y >= handTop && y <= handBottom && x >= firstCard && x <= lastCard) {
    for (let i = 0, pos = firstCard; i < hand.length; i++, pos += spacing) {
      if (x >= pos && x <= pos + spacing) {
        appState.handIndex = i;
        selectHandCard(hand[i]);
        return;
      }
    }
  } else if (
    x >= canvas.width - cdWidth / 2 - 60 &&
    x <= canvas.width - 60 &&
    y >= canvas.height / 2 - cdHeight / 4 &&
    y <= canvas.height / 2 + cdHeight / 4
  ) {
    emitDrawCard();
  }
}

function handleGameKeys(event) {
  if (!appState.currentTable || appState.gameStatus !== 'in_game') {
    if (event.key === '?') {
      openHelpOverlay();
      event.preventDefault();
    }
    return;
  }

  const key = (event.key || '').toLowerCase();
  const shift = !!event.shiftKey;
  let handled = false;
  let message = '';

  if (key === '?') {
    openHelpOverlay();
    handled = true;
  } else if (key === 'escape' && appState.announcementOpen) {
    closeAnnouncementOverlay();
    handled = true;
  } else if (appState.announcementOpen && (appState.announcementKind === 'roundSummary' || appState.announcementKind === 'matchSummary')) {
    handled = true;
  } else if (key === 'escape' && appState.helpOpen) {
    closeHelpOverlay();
    handled = true;
  } else if (appState.helpOpen) {
    handled = true;
  } else if (key === 'escape' && appState.kickOpen) {
    closeKickPlayerOverlay();
    handled = true;
  } else if (appState.kickOpen) {
    handled = true;
  } else if (isColorPickerOpen()) {
    handled = handleColorPickerKey(key);
  } else if (key === 'arrowleft') {
    if (appState.hand.length) {
      appState.handIndex = Math.max(0, appState.handIndex - 1);
      drawHand();
      message = getSelectedCardDescription() + ' selected';
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'arrowright') {
    if (appState.hand.length) {
      appState.handIndex = Math.min(appState.hand.length - 1, appState.handIndex + 1);
      drawHand();
      message = getSelectedCardDescription() + ' selected';
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'home') {
    if (appState.hand.length) {
      appState.handIndex = 0;
      drawHand();
      message = getSelectedCardDescription() + ' selected';
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'end') {
    if (appState.hand.length) {
      appState.handIndex = appState.hand.length - 1;
      drawHand();
      message = getSelectedCardDescription() + ' selected';
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'enter' || key === ' ') {
    if (appState.hand.length) {
      selectHandCard(appState.hand[appState.handIndex]);
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'd') {
    emitDrawCard();
    handled = true;
  } else if (key === 't') {
    speakCurrentTurnBrief();
    handled = true;
  } else if (key === 'p') {
    socket.emit('requestDiscardCard');
    handled = true;
  } else if (key === 'c') {
    message = appState.hand.length === 1
      ? 'You have 1 card'
      : 'You have ' + appState.hand.length + ' cards';
    handled = true;
  } else if (key === 'h') {
    message = appState.hand.length
      ? appState.hand.map(function (card) { return describeCardForSpeech(card); }).join(', ')
      : 'No cards in hand';
    handled = true;
  } else if (key === 'n') {
    speakDirectionAndNextPlayer();
    handled = true;
  } else if (key === 'q' && !shift) {
    announcePlayableCardsAndSelectByScore(true);
    handled = true;
  } else if (key === 'q' && shift) {
    announcePlayableCardsAndSelectByScore(false);
    handled = true;
  } else if (key === 's' && !shift) {
    speakOwnScore();
    handled = true;
  } else if (key === 's' && shift) {
    speakAllScores();
    handled = true;
  } else if (key === 'r' || key === 'y' || key === 'b' || key === 'g') {
    const colorByKey = { r: 'red', y: 'yellow', b: 'blue', g: 'green' };
    navigateToColorExtreme(colorByKey[key], !shift);
    handled = true;
  }

  if (handled) {
    event.preventDefault();
    if (message) {
      srSpeak(message, 'assertive', { canInterruptLock: true });
    }
  }
}

function isColorPickerOpen() {
  return !!(el.colorPickerOverlay && !el.colorPickerOverlay.classList.contains('hidden'));
}

function normalizeWildColor(color) {
  return WILD_PICKER_COLORS.indexOf(color) !== -1 ? color : 'red';
}

function updateColorPickerUi() {
  const activeColor = normalizeWildColor(appState.pendingWildColor);
  appState.pendingWildColor = activeColor;

  if (el.colorPickerSelection) {
    el.colorPickerSelection.textContent = 'Selected color: ' + capitalizeWord(activeColor);
  }

  if (!el.colorPickerOptions) {
    return;
  }

  const colorButtons = el.colorPickerOptions.querySelectorAll('[data-wild-color]');
  colorButtons.forEach(function (button) {
    const color = button.getAttribute('data-wild-color');
    const selected = color === activeColor;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    button.classList.toggle('selected', selected);
  });
}

function setPendingWildColor(color, options) {
  if (!isColorPickerOpen()) {
    return false;
  }

  const nextColor = normalizeWildColor(color);
  if (nextColor === appState.pendingWildColor) {
    return true;
  }

  appState.pendingWildColor = nextColor;
  updateColorPickerUi();
  if (options && options.announce) {
    srSpeak(capitalizeWord(nextColor) + ' selected', 'assertive', { canInterruptLock: true });
  }
  return true;
}

function cyclePendingWildColor(step) {
  const currentIndex = WILD_PICKER_COLORS.indexOf(normalizeWildColor(appState.pendingWildColor));
  const nextIndex = (currentIndex + step + WILD_PICKER_COLORS.length) % WILD_PICKER_COLORS.length;
  setPendingWildColor(WILD_PICKER_COLORS[nextIndex], { announce: true });
}

function handleColorPickerKey(key) {
  if (!isColorPickerOpen()) {
    return false;
  }

  if (key === 'escape') {
    cancelColorPicker();
    return true;
  }

  if (key === 'enter' || key === ' ') {
    confirmColorPicker();
    return true;
  }

  if (key === 'arrowleft' || key === 'arrowup') {
    cyclePendingWildColor(-1);
    return true;
  }

  if (key === 'arrowright' || key === 'arrowdown') {
    cyclePendingWildColor(1);
    return true;
  }

  if (key === 'r') {
    setPendingWildColor('red', { announce: true });
    return true;
  }

  if (key === 'y') {
    setPendingWildColor('yellow', { announce: true });
    return true;
  }

  if (key === 'g') {
    setPendingWildColor('green', { announce: true });
    return true;
  }

  if (key === 'b') {
    setPendingWildColor('blue', { announce: true });
    return true;
  }

  return false;
}

function emitDrawCard() {
  if (appState.gameStatus !== 'in_game') {
    srSpeak('Game has not started yet', 'assertive');
    return;
  }

  if (appState.currentTable && appState.currentTable.stackState && appState.currentTable.stackState.active) {
    acceptStackPenalty();
    return;
  }

  if (!appState.turn) {
    srSpeak('It is not your turn', 'assertive');
    return;
  }

  appState.handBeforeDraw = appState.hand.slice();
  socket.emit('drawCard');
}

function focusDrawnCard(card) {
  if (typeof card !== 'number' || !appState.hand.length) {
    return false;
  }

  const previousHand = Array.isArray(appState.handBeforeDraw) ? appState.handBeforeDraw : [];
  const oldCount = previousHand.filter(function (handCard) {
    return handCard === card;
  }).length;

  let seen = 0;
  for (let i = 0; i < appState.hand.length; i++) {
    if (appState.hand[i] !== card) {
      continue;
    }

    if (seen === oldCount) {
      appState.handIndex = i;
      return true;
    }

    seen += 1;
  }

  const fallbackIndex = appState.hand.indexOf(card);
  if (fallbackIndex !== -1) {
    appState.handIndex = fallbackIndex;
    return true;
  }

  return false;
}

function getClientBoardColor() {
  if (appState.discardChosenColor) {
    return appState.discardChosenColor;
  }
  return typeof appState.discard === 'number' ? cardColor(appState.discard) : null;
}

function isWildDrawFourBlocked(card) {
  if (cardType(card) !== 'Draw4') {
    return false;
  }

  const boardColor = getClientBoardColor();
  return appState.hand.some(function (handCard) {
    return handCard !== card && cardColor(handCard) !== 'black' && cardColor(handCard) === boardColor;
  });
}

function getCardScoreValue(card) {
  const type = cardType(card);
  if (type.indexOf('Number ') === 0) {
    return card % 14;
  }

  if (type === 'GivePlusOne') {
    return 20;
  }

  if (type === 'Skip' || type === 'Reverse' || type === 'Draw2') {
    return 20;
  }

  if (type === 'Wild' || type === 'Draw4') {
    return 50;
  }

  return 0;
}

function isCardPlayableForCurrentBoard(card) {
  if (typeof card !== 'number') {
    return false;
  }

  if (cardColor(card) === 'black') {
    return cardType(card) === 'Draw4' ? !isWildDrawFourBlocked(card) : true;
  }

  const boardColor = getClientBoardColor();
  if (boardColor && cardColor(card) === boardColor) {
    return true;
  }

  if (typeof appState.discard === 'number' && cardType(card) === cardType(appState.discard)) {
    return true;
  }

  return false;
}

function announcePlayableCardsAndSelectByScore(wantHighest) {
  if (!Array.isArray(appState.hand) || !appState.hand.length) {
    srSpeak('No cards in hand', 'assertive', { canInterruptLock: true });
    return;
  }

  const playable = [];
  for (let i = 0; i < appState.hand.length; i++) {
    const card = appState.hand[i];
    if (isCardPlayableForCurrentBoard(card)) {
      playable.push({
        card: card,
        index: i,
        score: getCardScoreValue(card)
      });
    }
  }

  if (!playable.length) {
    playErrorTone();
    srSpeak('No playable cards available', 'assertive', { canInterruptLock: true });
    return;
  }

  playable.sort(function (a, b) {
    if (a.score !== b.score) {
      return wantHighest ? (b.score - a.score) : (a.score - b.score);
    }
    return a.index - b.index;
  });

  const selected = playable[0];
  appState.handIndex = selected.index;
  drawHand();

  const listText = playable.map(function (entry) {
    return describeCardForSpeech(entry.card);
  }).join(', ');
  const selectedText = describeCardForSpeech(selected.card) + ' selected.';
  const intro = wantHighest
    ? 'Playable cards, highest score first:'
    : 'Playable cards, lowest score first:';

  srSpeak(intro + ' ' + listText + '. ' + selectedText, 'assertive', { canInterruptLock: true });
}

function submitPlayCard(card, chosenColor) {
  socket.emit('playCard', {
    card: card,
    chosenColor: chosenColor
  });
}

function emitPlayCard(card) {
  if (appState.gameStatus !== 'in_game') {
    srSpeak('Game has not started yet', 'assertive');
    return;
  }

  if (!appState.turn) {
    srSpeak('It is not your turn', 'assertive');
    return;
  }

  if (!appState.hand.length) {
    srSpeak('No card selected', 'assertive');
    return;
  }

  if (cardColor(card) !== 'black') {
    submitPlayCard(card, null);
    return;
  }

  if (isWildDrawFourBlocked(card)) {
    playErrorTone();
    srSpeak('Wild Draw Four cannot be played while you hold a matching color card', 'assertive', { canInterruptLock: true });
    return;
  }

  openColorPicker(card);
}

function openColorPicker(card) {
  appState.pendingWildCard = card;
  appState.pendingWildColor = 'red';
  updateColorPickerUi();
  el.colorPickerOverlay.classList.remove('hidden');
  srSpeak('Choose a color for your Wild card. Use left and right arrows or R, Y, G, B. Press Enter to confirm.', 'assertive', { canInterruptLock: true });
}

function closeColorPicker() {
  appState.pendingWildCard = null;
  appState.pendingWildColor = 'red';
  el.colorPickerOverlay.classList.add('hidden');
}

function confirmColorPicker() {
  const card = appState.pendingWildCard;
  if (typeof card !== 'number') {
    closeColorPicker();
    return;
  }

  const color = normalizeWildColor(appState.pendingWildColor);
  const cardDescription = describeCardForSpeech(card, color);
  closeColorPicker();

  srSpeak('You play ' + cardDescription + '.', 'assertive', { canInterruptLock: true });
  submitPlayCard(card, color);
}

function cancelColorPicker() {
  closeColorPicker();
  srSpeak('Wild color selection canceled', 'assertive');
}

function isAwaitingGiveSelection() {
  const give = appState.currentTable && appState.currentTable.givePendingState;
  return !!(give && give.active && give.isGiver);
}

function selectHandCard(card) {
  if (typeof card !== 'number') {
    return;
  }

  if (isAwaitingGiveSelection()) {
    submitGiveCard(card);
    return;
  }

  emitPlayCard(card);
}

function submitGiveCard(card) {
  if (appState.gameStatus !== 'in_game' || !appState.turn) {
    return;
  }

  socket.emit('submitGiveCard', { card: card });
}

let lumoRulesHtmlCache = null;

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdownFormat(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Small dependency-free renderer for the fixed structure of lumo-rules.md
// (#/##/### headings, "- " bullet lists, **bold**, plain paragraphs). The
// document's own top-level "# Lumo Rules" heading is dropped since the dialog
// already provides that heading for focus purposes.
function renderLumoRulesMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let listOpen = false;
  let paragraphBuffer = [];
  let skippedTopHeading = false;

  function flushParagraph() {
    if (paragraphBuffer.length) {
      htmlParts.push('<p>' + paragraphBuffer.join(' ') + '</p>');
      paragraphBuffer = [];
    }
  }

  function closeListIfOpen() {
    if (listOpen) {
      htmlParts.push('</ul>');
      listOpen = false;
    }
  }

  lines.forEach(function (rawLine) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      closeListIfOpen();
      return;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeListIfOpen();

      if (!skippedTopHeading && headingMatch[1].length === 1) {
        skippedTopHeading = true;
        return;
      }

      const level = Math.min(6, headingMatch[1].length + 2);
      htmlParts.push('<h' + level + '>' + inlineMarkdownFormat(headingMatch[2]) + '</h' + level + '>');
      return;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      if (!listOpen) {
        htmlParts.push('<ul>');
        listOpen = true;
      }
      htmlParts.push('<li>' + inlineMarkdownFormat(bulletMatch[1]) + '</li>');
      return;
    }

    if (/^-{3,}$/.test(line)) {
      return;
    }

    closeListIfOpen();
    paragraphBuffer.push(inlineMarkdownFormat(line));
  });

  flushParagraph();
  closeListIfOpen();
  return htmlParts.join('\n');
}

function openRulesOverlay() {
  appState.rulesOpen = true;
  appState.rulesReturnFocusEl = document.activeElement && typeof document.activeElement.focus === 'function'
    ? document.activeElement
    : null;

  el.rulesOverlay.classList.remove('hidden');
  el.rulesTitle.focus();
  srSpeak('Lumo rules opened', 'assertive', { canInterruptLock: true });

  if (lumoRulesHtmlCache) {
    el.rulesContent.innerHTML = lumoRulesHtmlCache;
    return;
  }

  el.rulesContent.innerHTML = '<p>Loading rules...</p>';

  fetch('lumo-rules.md')
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Unable to load rules');
      }
      return response.text();
    })
    .then(function (markdown) {
      lumoRulesHtmlCache = renderLumoRulesMarkdown(markdown);
      el.rulesContent.innerHTML = lumoRulesHtmlCache;
    })
    .catch(function () {
      el.rulesContent.innerHTML = '<p>Unable to load the Lumo rules right now. Please try again later.</p>';
    });
}

function closeRulesOverlay() {
  appState.rulesOpen = false;
  el.rulesOverlay.classList.add('hidden');

  const target = appState.rulesReturnFocusEl;
  appState.rulesReturnFocusEl = null;

  if (target && typeof target.focus === 'function' && document.contains(target)) {
    target.focus();
  } else if (el.openRulesBtn) {
    el.openRulesBtn.focus();
  }
}

function openKickPlayerOverlay() {
  if (!el.kickPlayerOverlay || !appState.isHost || !appState.currentTable) {
    return;
  }

  const others = appState.currentTable.players.filter(function (player) {
    return player.id !== socket.id && !player.isBot;
  });

  if (!others.length) {
    srSpeak('No other players to remove', 'assertive');
    return;
  }

  appState.kickOpen = true;
  appState.kickReturnFocusEl = document.activeElement && typeof document.activeElement.focus === 'function'
    ? document.activeElement
    : null;

  el.kickPlayerList.innerHTML = '';
  others.forEach(function (player) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = player.name;
    bindPress(button, function () {
      socket.emit('kickPlayer', { playerId: player.id });
      closeKickPlayerOverlay();
    });
    li.appendChild(button);
    el.kickPlayerList.appendChild(li);
  });

  el.kickPlayerOverlay.classList.remove('hidden');
  el.kickPlayerTitle.focus();
  srSpeak('Remove a player dialog opened', 'assertive', { canInterruptLock: true });
}

function closeKickPlayerOverlay() {
  if (!el.kickPlayerOverlay) {
    return;
  }

  appState.kickOpen = false;
  el.kickPlayerOverlay.classList.add('hidden');

  const target = appState.kickReturnFocusEl;
  appState.kickReturnFocusEl = null;

  if (target && typeof target.focus === 'function' && document.contains(target)) {
    target.focus();
  } else if (el.kickPlayerBtn) {
    el.kickPlayerBtn.focus();
  }
}

function openHelpOverlay() {
  appState.helpOpen = true;
  el.helpOverlay.classList.remove('hidden');
  el.closeHelpBtn.focus();
}

function closeHelpOverlay() {
  appState.helpOpen = false;
  el.helpOverlay.classList.add('hidden');
  if (appState.currentTable && appState.gameStatus === 'in_game') {
    focusBoardForA11y({
      announceOnFocus: true
    });
  } else {
    el.tableList.focus();
  }
}

function showAnnouncementOverlay(options) {
  const title = options && options.title ? options.title : 'Announcement';
  const message = options && options.message ? options.message : '';
  const eyebrow = options && options.eyebrow ? options.eyebrow : '';
  const tone = options && options.tone ? options.tone : 'info';
  const sticky = !!(options && options.sticky);
  const duration = options && typeof options.duration === 'number' ? options.duration : 3200;
  const kind = (options && options.kind) || null;

  if (!el.announcementOverlay) {
    return;
  }

  if (appState.announcementTimer) {
    window.clearTimeout(appState.announcementTimer);
    appState.announcementTimer = null;
  }

  appState.announcementOpen = true;
  appState.announcementKind = kind;
  el.announcementEyebrow.textContent = eyebrow;
  el.announcementTitle.textContent = title;
  el.announcementMessage.textContent = message;
  el.announcementOverlay.classList.remove('hidden');
  el.announcementTitle.parentElement.className = 'overlay-card announcement-card ' + tone;

  const isRoundOrMatchDialog = kind === 'roundSummary' || kind === 'matchSummary';
  if (isRoundOrMatchDialog) {
    el.closeAnnouncementBtn.focus();
  }

  if (sticky) {
    el.closeAnnouncementBtn.focus();
    return;
  }

  appState.announcementTimer = window.setTimeout(function () {
    closeAnnouncementOverlay();
  }, duration);
}

function closeAnnouncementOverlay(restoreFocus) {
  if (!el.announcementOverlay) {
    return;
  }

  if (appState.announcementTimer) {
    window.clearTimeout(appState.announcementTimer);
    appState.announcementTimer = null;
  }

  const wasOpen = appState.announcementOpen;
  const kind = appState.announcementKind;

  appState.announcementOpen = false;
  appState.announcementKind = null;
  el.announcementOverlay.classList.add('hidden');

  if (wasOpen && kind === 'roundSummary') {
    socket.emit('ackRoundSummary');
    setTableStatus('Waiting for other players to continue...', 'info');
  }

  if (restoreFocus === false) {
    return;
  }

  if (appState.currentTable && appState.gameStatus === 'in_game') {
    focusBoardForA11y({
      announceOnFocus: true
    });
  } else if (appState.currentTable && el.leaveTableBtn && typeof el.leaveTableBtn.focus === 'function') {
    el.leaveTableBtn.focus();
  }
}

function render() {
  el.authView.classList.toggle('hidden', appState.loggedIn);
  el.gamePickerView.classList.toggle('hidden', !appState.loggedIn || appState.currentScreen !== 'game-picker');
  el.placeholderView.classList.toggle('hidden', !appState.loggedIn || appState.currentScreen !== 'placeholder');
  el.accountBar.classList.toggle('hidden', !appState.loggedIn);
  el.lobbyView.classList.toggle('hidden', !appState.loggedIn || appState.currentScreen !== 'lobby' || !!appState.currentTable);
  el.tableView.classList.toggle('hidden', !appState.currentTable);

  if (appState.loggedIn) {
    el.accountLabel.textContent = 'Logged in as ' + appState.playerName + ' (' + appState.accountEmail + ')';
  }

  if (el.gamePickerSummary) {
    el.gamePickerSummary.textContent = appState.selectedGameType
      ? 'Selected game: ' + (getGameDefinition(appState.selectedGameType) || { name: 'Lumo' }).name
      : 'Pick a card game to continue. Lumo is available now; the others are accessible previews for later work.';
  }

  if (appState.currentTable) {
    el.gamePanel.classList.toggle('hidden', appState.gameStatus !== 'in_game');
    el.tableMeta.textContent = (appState.currentTable.gameName || 'Lumo') + ': ' + appState.currentTable.name + ' - ' + (appState.gameStatus === 'in_game' ? 'In game' : 'Waiting for players');
    el.tableHost.textContent = 'Host: ' + appState.currentTable.hostName;
    if (el.tableMatchSettings) {
      const matchSettings = appState.currentTable.matchSettings || { winningScore: 500, maxRounds: 30 };
      const roundText = appState.gameStatus === 'in_game' && typeof appState.currentTable.roundNumber === 'number'
        ? ' | This is round ' + appState.currentTable.roundNumber + ' of ' + matchSettings.maxRounds
        : '';
      const stackRules = [];
      if (matchSettings.allowDrawTwoStacking) {
        stackRules.push('Draw Two stacking on');
      }
      if (matchSettings.allowWildDrawFourStacking) {
        stackRules.push('Wild Draw Four stacking on');
      }

      el.tableMatchSettings.textContent = 'Winning score: ' + matchSettings.winningScore + ' | Max rounds: ' + matchSettings.maxRounds + roundText + (stackRules.length ? ' | ' + stackRules.join(', ') : '');
    }
    const computerPlayerCount = (appState.currentTable.matchSettings && appState.currentTable.matchSettings.computerPlayers) || 0;
    const effectivePlayerCount = appState.currentTable.players.length + computerPlayerCount;
    el.startGameBtn.disabled = !appState.isHost || effectivePlayerCount < 2 || appState.gameStatus === 'in_game';
    if (el.kickPlayerBtn) {
      const hasOtherPlayers = appState.currentTable.players.some(function (player) {
        return player.id !== socket.id && !player.isBot;
      });
      el.kickPlayerBtn.classList.toggle('hidden', !appState.isHost);
      el.kickPlayerBtn.disabled = !hasOtherPlayers;
    }
    setTableStatus(appState.tableStatusMessage, appState.tableStatusTone);
    setPlayDirectionIndicator();
    setRoundResult(appState.roundResultMessage);
  } else {
    setTableStatus('Join a table to start playing.', 'info');
    setPlayDirectionIndicator();
    setRoundResult('');
  }

  renderLobbyTables();
  renderPlayerSummary();
  renderStackControls();
  renderPlayHistory();
}

function renderLobbyTables() {
  const tables = appState.lobbyTables.filter(function (table) {
    return !appState.selectedGameType || table.gameType === appState.selectedGameType;
  });
  el.tableList.innerHTML = '';

  if (appState.selectedLobbyIndex >= tables.length) {
    appState.selectedLobbyIndex = Math.max(0, tables.length - 1);
  }

  if (!tables.length) {
    const selectedGame = getGameDefinition(appState.selectedGameType || 'uno') || GAME_CATALOG.uno;
    el.lobbySummary.textContent = 'No ' + selectedGame.name + ' tables yet. Create one to get started.';
    return;
  }

  const selectedGame = getGameDefinition(appState.selectedGameType || 'uno') || GAME_CATALOG.uno;
  el.lobbySummary.textContent = 'Use arrow keys and Enter to join a ' + selectedGame.name + ' table, or click with the mouse.';

  tables.forEach(function (table, index) {
    const li = document.createElement('li');
    li.className = 'table-item' + (index === appState.selectedLobbyIndex ? ' selected' : '');
    li.tabIndex = -1;
    li.textContent = (table.gameName || 'Lumo') + ' | ' + table.name + (table.hasCode ? ' | Locked' : '') + ' | ' + table.status + ' | ' + table.playerCount + '/' + table.maxPlayers + ' | Host: ' + table.hostName;
    bindPress(li, function () {
      appState.selectedLobbyIndex = index;
      renderLobbyTables();
      attemptJoinTable(table);
    });
    el.tableList.appendChild(li);
  });
}

function renderPlayerSummary() {
  el.playerSummary.innerHTML = '';

  if (!appState.currentTable) {
    return;
  }

  appState.currentTable.players.forEach(function (player) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const unoBadge = document.createElement('span');
    const details = document.createElement('span');
    const isCurrentTurn = appState.gameStatus === 'in_game' && player.id === appState.currentTurnPlayerId;
    const hasUno = appState.gameStatus === 'in_game' && player.cardCount === 1;
    const tags = [];
    const totalPoints = typeof player.score === 'number' ? player.score : 0;

    if (player.id === appState.currentTable.hostId) {
      tags.push('host');
    }
    if (player.id === socket.id) {
      tags.push('you');
    }
    if (isCurrentTurn) {
      tags.push('current turn');
      li.classList.add('current-turn');
    }
    if (hasUno) {
      tags.push('Lumo');
      li.classList.add('lumo');
    }

    const countText = appState.gameStatus === 'in_game'
      ? 'Cards: ' + player.cardCount + ' | Total: ' + totalPoints
      : 'Score: ' + totalPoints;
    const tagText = tags.length ? ' (' + tags.join(', ') + ')' : '';

    label.className = 'player-label';
    label.textContent = player.name;
    if (hasUno) {
      unoBadge.className = 'lumo-badge';
      unoBadge.textContent = 'Lumo';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(unoBadge);
    }
    details.className = 'player-tags';
    details.textContent = tagText + ' - ' + countText;

    li.appendChild(label);
    li.appendChild(details);
    el.playerSummary.appendChild(li);
  });
}

function renderStackControls() {
  if (!el.stackControls || !el.stackStatus || !el.acceptStackBtn) {
    return;
  }

  const stackState = appState.currentTable && appState.currentTable.stackState ? appState.currentTable.stackState : null;
  const shouldShow = !!(appState.currentTable && appState.gameStatus === 'in_game' && stackState && stackState.active && stackState.canContinue);

  el.stackControls.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    el.stackStatus.textContent = '';
    return;
  }

  el.stackStatus.textContent = stackState.promptText || '';
  el.acceptStackBtn.textContent = stackState.penalty === 2
    ? 'Take 2-card penalty'
    : ('Take ' + stackState.penalty + '-card penalty');
}

function announcePlayerSummary(table) {
  if (!table || !Array.isArray(table.players) || !table.players.length) {
    return;
  }

  const summary = table.players.map(function (player) {
    const countText = table.status === 'in_game' ? player.cardCount + ' cards' : 'waiting';
    return player.name + ', ' + countText;
  }).join('. ');

  srSpeak('Players: ' + summary, 'polite');
}

function drawHand() {
  const handTop = getHandTopY();
  // Include a small buffer above the hand to erase selected-card glow artifacts.
  const clearTop = Math.max(0, handTop - 16);
  ctx.clearRect(0, clearTop, canvas.width, canvas.height - clearTop);

  const hand = appState.hand;
  const selectedIndex = hand.length ? Math.max(0, Math.min(hand.length - 1, appState.handIndex)) : -1;
  for (let i = 0; i < hand.length; i++) {
    const x = (hand.length / 112) * (cdWidth / 3) + (canvas.width / (2 + (hand.length - 1))) * (i + 1) - (cdWidth / 4);
    const y = handTop;

    const image = getCardImage(hand[i]);
    if (image.complete && image.naturalWidth) {
      ctx.drawImage(image, x, y, cdWidth / 2, cdHeight / 2);
    }

    if (i === selectedIndex) {
      ctx.save();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#ffd166';
      ctx.strokeRect(x - 3, y - 3, cdWidth / 2 + 6, cdHeight / 2 + 6);
      ctx.restore();
    }
  }
}

function drawDiscard(cardNum) {
  if (typeof cardNum !== 'number') {
    return;
  }

  const image = getCardImage(cardNum);
  if (image.complete && image.naturalWidth) {
    ctx.drawImage(image, canvas.width / 2 - cdWidth / 4, canvas.height / 2 - cdHeight / 4, cdWidth / 2, cdHeight / 2);
  }
}

function drawDeckBack() {
  const image = getCardImage('back');
  if (image.complete && image.naturalWidth) {
    ctx.drawImage(image, canvas.width - cdWidth / 2 - 60, canvas.height / 2 - cdHeight / 4, cdWidth / 2, cdHeight / 2);
  }
}

function getDiscardTopY() {
  return canvas.height / 2 - cdHeight / 4;
}

function getDiscardBottomY() {
  return getDiscardTopY() + cdHeight / 2;
}

function getHandTopY() {
  // Gap must exceed drawHand's above-hand clear buffer (16px) so redrawing the
  // hand never erases part of the discard/deck row above it.
  return getDiscardBottomY() + 20;
}

function getHandBottomY() {
  return getHandTopY() + cdHeight / 2;
}

function drawRoundedRectPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTurnIndicator(text) {
  const centerX = canvas.width / 2;
  const bandTop = canvas.height / 2 - cdHeight / 4 - 56;
  const bandHeight = 38;
  const wildLabelTop = bandTop - 28;
  const clearTop = wildLabelTop - 8;
  const clearBottom = bandTop + bandHeight + 8;
  const wildColorLabel = (typeof appState.discard === 'number'
    && cardColor(appState.discard) === 'black'
    && appState.discardChosenColor)
    ? ('Wild color: ' + capitalizeWord(appState.discardChosenColor))
    : '';

  // Keep clearing constrained to the indicator strip so the discard card is never erased.
  ctx.clearRect(centerX - 250, clearTop, 500, clearBottom - clearTop);

  if (!text && !wildColorLabel) {
    return;
  }

  if (wildColorLabel) {
    ctx.save();
    ctx.fillStyle = 'rgba(6, 31, 44, 0.9)';
    ctx.strokeStyle = '#9ad7ff';
    ctx.lineWidth = 2;
    drawRoundedRectPath(centerX - 120, wildLabelTop, 240, 24, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8f7ff';
    ctx.font = 'bold 15px "Segoe UI", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wildColorLabel, centerX, wildLabelTop + 12);
    ctx.restore();
  }

  if (!text) {
    return;
  }

  ctx.save();
  ctx.fillStyle = 'rgba(9, 39, 37, 0.96)';
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 3;
  drawRoundedRectPath(centerX - 165, bandTop, 330, bandHeight, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#082b2a';
  ctx.lineWidth = 5;
  ctx.font = 'bold 24px "Segoe UI", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeText(text, centerX, bandTop + bandHeight / 2);
  ctx.fillText(text, centerX, bandTop + bandHeight / 2);
  ctx.restore();
}

function getOwnPlayerEntry() {
  if (!appState.currentTable) {
    return null;
  }
  return appState.currentTable.players.find(function (player) {
    return player.id === socket.id;
  }) || null;
}

function speakOwnScore() {
  const player = getOwnPlayerEntry();
  const score = player && typeof player.score === 'number' ? player.score : 0;
  srSpeak('Your score is ' + score + (score === 1 ? ' point' : ' points'), 'assertive', { canInterruptLock: true });
}

function speakAllScores() {
  if (!appState.currentTable || !appState.currentTable.players.length) {
    srSpeak('No score data available', 'assertive', { canInterruptLock: true });
    return;
  }

  const sorted = appState.currentTable.players.slice().sort(function (a, b) {
    return (b.score || 0) - (a.score || 0);
  });
  const text = sorted.map(function (player) {
    return player.name + ' ' + (player.score || 0);
  }).join('. ');

  srSpeak(text, 'assertive', { canInterruptLock: true });
}

function getHandRank(card) {
  return getCardKindRank(card) * 100 + getCardValueSortRank(card);
}

function navigateToColorExtreme(color, wantHighest) {
  let bestIndex = -1;
  let bestRank = null;

  for (let i = 0; i < appState.hand.length; i++) {
    if (cardColor(appState.hand[i]) !== color) {
      continue;
    }

    const rank = getHandRank(appState.hand[i]);
    if (bestIndex === -1 || (wantHighest ? rank > bestRank : rank < bestRank)) {
      bestIndex = i;
      bestRank = rank;
    }
  }

  if (bestIndex === -1) {
    playErrorTone();
    return false;
  }

  appState.handIndex = bestIndex;
  drawHand();
  srSpeak(getSelectedCardDescription() + ' selected', 'assertive', { canInterruptLock: true });
  return true;
}

function getSelectedCardDescription() {
  if (!appState.hand.length) {
    return 'No card selected';
  }

  const safeIndex = Math.max(0, Math.min(appState.hand.length - 1, appState.handIndex));
  appState.handIndex = safeIndex;
  return describeCardForSpeech(appState.hand[safeIndex]);
}

function formatCardTypeForSpeech(type) {
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

function describeCardForSpeech(card, forcedColor) {
  // Always speak the color, including "black" for an unplayed Wild/Draw Four - that
  // is the card's real printed color until a player chooses its active color.
  const color = cardColor(card) === 'black' && forcedColor ? forcedColor : cardColor(card);
  const type = formatCardTypeForSpeech(cardType(card));
  return type + ' ' + color;
}

function formatCardList(cards) {
  if (!Array.isArray(cards) || !cards.length) {
    return '';
  }
  if (cards.length === 1) {
    return cards[0];
  }
  return cards.slice(0, -1).join(', ') + ', and ' + cards[cards.length - 1];
}

function buildNextTurnText(playerId, playerName) {
  if (!playerId) {
    return '';
  }
  return playerId === socket.id ? 'It is your turn.' : ("It is " + (playerName || 'Another player') + "'s turn.");
}

function buildTurnTransitionMessage(payload) {
  if (!payload || !payload.actorId) {
    return '';
  }

  if ((payload.action === 'stack_resolve' || payload.action === 'give_resolve' || payload.stackMessage) && (payload.message || payload.stackMessage)) {
    return payload.message || payload.stackMessage;
  }

  const actorIsYou = payload.actorId === socket.id;
  const actorName = payload.actorName || 'Another player';
  const lines = [];
  const draw = payload.draw;

  if (payload.action === 'play' && payload.playedCard) {
    lines.push((actorIsYou ? 'You play the ' : (actorName + ' plays the ')) + payload.playedCard + '.');
  }

  if (payload.actorHasUno) {
    const unoSpeech = window.CardTableUnoSpeech && typeof window.CardTableUnoSpeech.buildUnoSpeechText === 'function'
      ? window.CardTableUnoSpeech.buildUnoSpeechText(actorIsYou, actorName)
      : (actorIsYou ? 'You say Uno.' : (actorName + ' says Uno.'));
    lines.push(unoSpeech);
  }

  if (payload.colorChangedTo) {
    lines.push('Color changes to ' + payload.colorChangedTo + '.');
  }

  if (payload.stackMessage) {
    lines.push(payload.stackMessage);
  }

  if (draw && draw.count > 0) {
    const drawIsYou = draw.playerId === socket.id;
    if (drawIsYou && Array.isArray(draw.cards) && draw.cards.length) {
      lines.push('You draw ' + formatCardList(draw.cards) + '.');
    } else if (drawIsYou) {
      lines.push('You draw ' + draw.count + (draw.count === 1 ? ' card.' : ' cards.'));
    } else {
      const targetName = draw.playerName || 'A player';
      if (draw.count === 1) {
        lines.push(targetName + ' draws a card.');
      } else if (draw.count === 2) {
        lines.push(targetName + ' draws two cards.');
      } else if (draw.count === 4) {
        lines.push(targetName + ' draws four cards.');
      } else {
        lines.push(targetName + ' draws ' + draw.count + ' cards.');
      }
    }
  }

  let skipMentionsNextTurn = false;
  if (payload.skippedPlayerId && payload.nextPlayerName) {
    if (payload.skippedPlayerId === socket.id) {
      lines.push('Play skips you to ' + payload.nextPlayerName + '.');
    } else {
      lines.push('Skipping ' + (payload.skippedPlayerName || 'a player') + ' to ' + payload.nextPlayerName + '.');
    }
    skipMentionsNextTurn = true;
  }

  if (payload.direction) {
    const directionText = String(payload.direction).toLowerCase();
    const nextTurnText = buildNextTurnText(payload.nextPlayerId, payload.nextPlayerName);
    lines.push('Direction is now ' + directionText + (nextTurnText ? '. ' + nextTurnText : '.'));
  } else if (!skipMentionsNextTurn) {
    const nextTurnText = buildNextTurnText(payload.nextPlayerId, payload.nextPlayerName);
    if (nextTurnText) {
      lines.push(nextTurnText);
    }
  }

  return lines.join(' ');
}

function srSpeak(text, priority, options) {
  if (!text) {
    return;
  }

  const statusRegion = document.getElementById('sr-status');
  const alertRegion = document.getElementById('sr-alert');
  const region = priority === 'assertive' ? alertRegion : statusRegion;
  const lockMs = options && typeof options.lockMs === 'number' ? options.lockMs : 0;
  const canInterruptLock = !!(options && options.canInterruptLock);

  if (!region) {
    return;
  }

  if (!canInterruptLock && Date.now() < appState.speechLockUntil) {
    return;
  }

  if (lockMs > 0) {
    appState.speechLockUntil = Date.now() + lockMs;
  } else if (canInterruptLock) {
    appState.speechLockUntil = 0;
  }

  if (speechRenderTimer) {
    window.clearTimeout(speechRenderTimer);
    speechRenderTimer = null;
  }

  if (statusRegion) {
    statusRegion.textContent = '';
  }
  if (alertRegion) {
    alertRegion.textContent = '';
  }

  speechRenderTimer = window.setTimeout(function () {
    region.textContent = text;
    speechRenderTimer = null;
  }, 40);
}

// Give Plus One cards live outside the color*14+value numbering used by every
// other card, in their own ID range (mirrors GIVE_PLUS_ONE_BASE in server.js).
const GIVE_PLUS_ONE_BASE = 1000;
const GIVE_PLUS_ONE_COLORS = ['red', 'yellow', 'green', 'blue'];

function isGivePlusOneCard(num) {
  return typeof num === 'number' && num >= GIVE_PLUS_ONE_BASE && num < GIVE_PLUS_ONE_BASE + GIVE_PLUS_ONE_COLORS.length;
}

function cardColor(num) {
  if (isGivePlusOneCard(num)) {
    return GIVE_PLUS_ONE_COLORS[num - GIVE_PLUS_ONE_BASE];
  }

  if (num % 14 === 13) {
    return 'black';
  }

  switch (Math.floor(num / 14)) {
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

function cardType(num) {
  if (isGivePlusOneCard(num)) {
    return 'GivePlusOne';
  }

  switch (num % 14) {
    case 10:
      return 'Skip';
    case 11:
      return 'Reverse';
    case 12:
      return 'Draw2';
    case 13:
      return Math.floor(num / 14) >= 4 ? 'Draw4' : 'Wild';
    default:
      return 'Number ' + (num % 14);
  }
}

function getColorSortRank(card) {
  switch (cardColor(card)) {
    case 'red':
      return 0;
    case 'yellow':
      return 1;
    case 'green':
      return 2;
    case 'blue':
      return 3;
    case 'black':
      return 4;
    default:
      return 5;
  }
}

function getCardKindRank(card) {
  if (isGivePlusOneCard(card)) {
    return 1;
  }

  if (cardColor(card) === 'black') {
    return 2;
  }

  return card % 14 <= 9 ? 0 : 1;
}

function getCardValueSortRank(card) {
  if (isGivePlusOneCard(card)) {
    return 3;
  }

  const value = card % 14;
  if (value <= 9) {
    return value;
  }

  if (value === 10) {
    return 0;
  }
  if (value === 11) {
    return 1;
  }
  if (value === 12) {
    return 2;
  }

  return Math.floor(card / 14) >= 4 ? 1 : 0;
}

function compareCardsForHandSort(a, b) {
  const colorDiff = getColorSortRank(a) - getColorSortRank(b);
  if (colorDiff !== 0) {
    return colorDiff;
  }

  const kindDiff = getCardKindRank(a) - getCardKindRank(b);
  if (kindDiff !== 0) {
    return kindDiff;
  }

  const valueDiff = getCardValueSortRank(a) - getCardValueSortRank(b);
  if (valueDiff !== 0) {
    return valueDiff;
  }

  return a - b;
}

socket.on('connect', function () {
  srSpeak('Connected to server', 'polite');
  attemptResumeLogin();
});

socket.on('disconnect', function () {
  srSpeak('Disconnected from server', 'assertive');
});

socket.on('serverMessage', function (payload) {
  if (!payload || !payload.message) {
    return;
  }

  srSpeak(payload.message, payload.type === 'error' ? 'assertive' : 'polite');
});

socket.on('loginResult', function (payload) {
  if (!payload || !payload.success) {
    const message = payload && payload.message ? payload.message : 'Login failed';
    const wasSilentResume = appState.resumeLoginPending;

    if (wasSilentResume) {
      clearRememberedLogin();
      appState.resumeLoginPending = false;
    } else {
      // A silent remember-me resume attempt shouldn't flash an error the user
      // never triggered, but an actual login/create-account click needs visible
      // feedback - the sr-only announcement alone is invisible to sighted users.
      setAuthStatus(message, 'alert');
    }

    srSpeak(message, 'assertive');
    setScreen('auth');
    return;
  }

  setAuthStatus('', 'info');
  const wasResumeLogin = appState.resumeLoginPending;
  appState.resumeLoginPending = false;

  appState.loggedIn = true;
  appState.accountEmail = payload.email || '';
  appState.playerName = payload.name;

  // login/resumeLogin reclaim any seat the account still holds server-side
  // (reclaimSeatAfterReconnect) and emit tableState for it before this
  // loginResult arrives. If that happened, stay on the table instead of
  // wiping appState.currentTable and forcing the game picker - otherwise a
  // plain disconnect/reconnect (e.g. a dropped connection right after a
  // game) silently strands the player's view on the picker while the server
  // still has them seated, with no way back to the table or its Leave button.
  if (appState.currentTable) {
    render();
  } else {
    appState.selectedGameType = null;
    appState.selectedGameName = '';
    appState.selectedLobbyIndex = 0;
    appState.lobbyTables = [];
    showGamePicker();
  }

  try {
    if (payload.email) {
      window.localStorage.setItem(playerEmailStorageKey, payload.email);
    }
    window.localStorage.setItem(displayNameStorageKey, payload.name);
  } catch (error) {
    console.warn('Unable to save auth fields', error);
  }

  if (payload.rememberToken) {
    storeRememberedLogin(payload.rememberToken);
  } else if (!wasResumeLogin) {
    clearRememberedLogin();
  }

  el.passwordInput.value = '';
  socket.emit('requestLobbySnapshot');
  srSpeak('Logged in as ' + payload.name, 'assertive');
  render();
});

socket.on('logoutResult', function (payload) {
  if (!payload || !payload.success) {
    srSpeak(payload && payload.message ? payload.message : 'Logout failed', 'assertive');
    return;
  }

  clearRememberedLogin();
  resetLoggedInState();
  appState.selectedGameType = null;
  appState.selectedGameName = '';
  appState.selectedLobbyIndex = 0;
  appState.lobbyTables = [];
  setAuthStatus('', 'info');
  setScreen('auth');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  closeAnnouncementOverlay(false);
  setTableStatus('Join a table to start playing.', 'info');
  render();
  srSpeak(payload.message || 'Logged out', 'assertive');
});

socket.on('deleteAccountResult', function (payload) {
  if (!payload || !payload.success) {
    srSpeak(payload && payload.message ? payload.message : 'Account deletion failed', 'assertive');
    return;
  }

  clearRememberedLogin();
  resetLoggedInState();
  appState.selectedGameType = null;
  appState.selectedGameName = '';
  appState.selectedLobbyIndex = 0;
  appState.lobbyTables = [];
  setAuthStatus('', 'info');
  setScreen('auth');

  try {
    window.localStorage.removeItem(displayNameStorageKey);
  } catch (error) {
    console.warn('Unable to clear saved display name', error);
  }

  el.passwordInput.value = '';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  closeAnnouncementOverlay(false);
  setTableStatus('Join a table to start playing.', 'info');
  render();
  srSpeak(payload.message || 'Account deleted', 'assertive');
});

socket.on('lobbySnapshot', function (payload) {
  const tables = payload && Array.isArray(payload.tables) ? payload.tables : [];
  appState.lobbyTables = tables;
  appState.selectedLobbyIndex = Math.min(appState.selectedLobbyIndex, Math.max(0, tables.length - 1));
  renderLobbyTables();
});

socket.on('tableState', function (payload) {
  const wasInGame = appState.gameStatus === 'in_game';

  if (!payload || !payload.table) {
    const shouldReturnToLobby = appState.loggedIn;
    appState.currentTable = null;
    appState.gameStatus = 'waiting';
    appState.turn = false;
    appState.currentTurnPlayerId = null;
    appState.nextPlayerId = null;
    appState.nextPlayerName = '';
    appState.playDirection = 'clockwise';
    appState.turnIndicatorText = '';
    appState.suppressTurnAnnouncementForPlayerId = null;
    appState.lastAnnouncedTurnPlayerId = null;
    appState.handBeforeDraw = null;
    appState.pendingRoundDealAnnouncement = false;
    clearPlayHistory();
    closeAnnouncementOverlay(false);
    if (shouldReturnToLobby) {
      setScreen('lobby');
      socket.emit('requestLobbySnapshot');
    }
    render();
    return;
  }

  appState.currentTable = payload.table;
  appState.gameStatus = payload.table.status;
  appState.isHost = !!payload.youAreHost;
  const enteredInGame = !wasInGame && appState.gameStatus === 'in_game';

  if (payload.table.status !== 'in_game') {
    appState.turn = false;
    appState.currentTurnPlayerId = null;
    appState.nextPlayerId = null;
    appState.nextPlayerName = '';
    appState.playDirection = 'clockwise';
    appState.turnIndicatorText = '';
    appState.suppressTurnAnnouncementForPlayerId = null;
    appState.lastAnnouncedTurnPlayerId = null;
    appState.hand = [];
    appState.handIndex = 0;
    appState.handBeforeDraw = null;
    appState.discard = null;
    appState.discardChosenColor = null;
    appState.pendingDrawCard = null;
    appState.pendingRoundDealAnnouncement = false;
    clearPlayHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!appState.tableStatusMessage || appState.tableStatusTone !== 'success') {
      setTableStatus('Waiting for the host to start the next game.', 'info');
    }
  } else if (!appState.currentTurnPlayerId) {
    appState.playDirection = normalizeDirection(appState.playDirection);
    const isRoundOrMatchDialogOpen = appState.announcementOpen
      && (appState.announcementKind === 'roundSummary' || appState.announcementKind === 'matchSummary');
    if (!isRoundOrMatchDialogOpen) {
      closeAnnouncementOverlay(false);
    }
    setTableStatus('Game in progress. Waiting for the next turn update.', 'info');
  }

  render();

  if (enteredInGame) {
    clearPlayHistory();
    window.requestAnimationFrame(function () {
      focusBoardForA11y({
        announceOnFocus: true
      });
    });
  }
});

socket.on('kicked', function (payload) {
  const message = (payload && payload.message) || 'You have been removed from the table by the host';
  srSpeak(message, 'assertive', { canInterruptLock: true });
  showAnnouncementOverlay({
    title: 'Removed from table',
    message: message,
    tone: 'info',
    sticky: true,
    kind: 'kicked'
  });
});

socket.on('starterDrawSummary', function (payload) {
  if (!payload || !Array.isArray(payload.draws) || !payload.draws.length) {
    return;
  }

  const drawLines = payload.draws.map(function (draw) {
    return draw.name + ' drew ' + draw.description + ' (' + draw.score + ' points)';
  }).join('. ');
  const winnerName = payload.winner && payload.winner.name ? payload.winner.name : 'A player';
  const winnerMessage = payload.message || (winnerName + ' starts the first round.');
  const message = drawLines + '. ' + winnerMessage;

  setTableStatus(winnerMessage, 'info');
  srSpeak(message, 'assertive', { lockMs: 2000 });
});

socket.on('haveCard', function (cardsInHand) {
  const previousHand = appState.hand.slice();
  const sortedHand = Array.isArray(cardsInHand)
    ? cardsInHand.slice().sort(compareCardsForHandSort)
    : [];
  appState.hand = sortedHand;

  if (typeof appState.pendingDrawCard === 'number' && appState.hand.length) {
    const oldCount = previousHand.filter(function (card) {
      return card === appState.pendingDrawCard;
    }).length;

    let seen = 0;
    let selectedIndex = -1;
    for (let i = 0; i < appState.hand.length; i++) {
      if (appState.hand[i] !== appState.pendingDrawCard) {
        continue;
      }

      if (seen === oldCount) {
        selectedIndex = i;
        break;
      }
      seen += 1;
    }

    if (selectedIndex === -1) {
      selectedIndex = appState.hand.indexOf(appState.pendingDrawCard);
    }

    if (selectedIndex !== -1) {
      appState.handIndex = selectedIndex;
    }
    appState.pendingDrawCard = null;
  } else {
    appState.handIndex = Math.max(0, Math.min(appState.handIndex, Math.max(0, appState.hand.length - 1)));
  }

  appState.handIndex = Math.max(0, Math.min(appState.handIndex, Math.max(0, appState.hand.length - 1)));
  drawHand();
  maybeAnnounceNewRoundHand();
});

socket.on('sendCard', function (payload) {
  const card = typeof payload === 'object' && payload ? payload.card : payload;
  const chosenColor = typeof payload === 'object' && payload ? payload.chosenColor || null : null;

  appState.discard = card;
  appState.discardChosenColor = chosenColor;

  drawDiscard(card);
  drawDeckBack();
  drawTurnIndicator(appState.turnIndicatorText);
});

socket.on('turnTransition', function (payload) {
  const message = buildTurnTransitionMessage(payload);
  const historyLine = buildPlayHistoryLine(payload);
  if (historyLine) {
    pushPlayHistory(historyLine);
  }
  if (!message) {
    return;
  }

  if (payload.actorHasUno && payload.action === 'play') {
    const actorIsYou = payload.actorId === socket.id;
    const actorName = payload.actorName || 'A player';
    const unoSpeech = window.CardTableUnoSpeech && typeof window.CardTableUnoSpeech.buildUnoSpeechText === 'function'
      ? window.CardTableUnoSpeech.buildUnoSpeechText(actorIsYou, actorName)
      : (actorIsYou ? 'You say Lumo!' : (actorName + ' says Lumo!'));
    const overlayMessage = typeof window.CardTableUnoSpeech !== 'undefined' && typeof window.CardTableUnoSpeech.buildUnoAnnouncementMessage === 'function'
      ? window.CardTableUnoSpeech.buildUnoAnnouncementMessage(message)
      : message;

    showAnnouncementOverlay({
      eyebrow: 'Lumo',
      title: actorIsYou ? 'You say Lumo!' : (actorName + ' says Lumo!'),
      message: overlayMessage,
      tone: 'lumo',
      duration: 2200,
      kind: 'uno'
    });

    srSpeak(unoSpeech, 'assertive', { canInterruptLock: true, lockMs: 1400 });
  }

  appState.suppressTurnAnnouncementForPlayerId = payload.nextPlayerId || null;
  appState.nextPlayerId = payload.nextPlayerId || null;
  appState.nextPlayerName = payload.nextPlayerName || '';
  if (payload.direction) {
    appState.playDirection = normalizeDirection(payload.direction);
  }
  setTableStatus(message, payload.nextPlayerId === socket.id ? 'alert' : 'info');
  setPlayDirectionIndicator();
  srSpeak(message, payload.nextPlayerId === socket.id ? 'assertive' : 'polite', { canInterruptLock: true });
});

socket.on('turnPlayer', function (payload) {
  if (!payload) {
    return;
  }

  const isNewTurn = payload.id !== appState.lastAnnouncedTurnPlayerId;

  appState.currentTurnPlayerId = payload.id;
  appState.turn = payload.id === socket.id;
  appState.currentTurnPlayerName = payload.name || '';
  appState.nextPlayerId = payload.id;
  appState.nextPlayerName = payload.name || '';
  appState.currentTurnTopDiscard = payload.topDiscard || '';
  if (payload.stackState) {
    appState.currentTable.stackState = payload.stackState;
  }

  const indicatorText = appState.turn ? 'Your turn' : ((payload.name || 'Another player') + "'s turn");
  appState.turnIndicatorText = indicatorText;
  drawTurnIndicator(indicatorText);

  if (isNewTurn) {
    appState.lastAnnouncedTurnPlayerId = payload.id;

    if (appState.pendingRoundDealAnnouncement) {
      maybeAnnounceNewRoundHand();
      if (!appState.pendingRoundDealAnnouncement) {
        renderPlayerSummary();
        return;
      }
    }

    if (appState.suppressTurnAnnouncementForPlayerId === payload.id) {
      appState.suppressTurnAnnouncementForPlayerId = null;
      renderPlayerSummary();
      return;
    }

    if (payload.stackState && payload.stackState.active && payload.stackState.canContinue) {
      setTableStatus(payload.stackState.promptText, 'alert');
      srSpeak(payload.stackState.promptText, 'assertive', { canInterruptLock: true });
      renderPlayerSummary();
      return;
    }

    if (appState.turn) {
      const topDiscard = payload.topDiscard ? payload.topDiscard + ' shown.' : '';
      const message = payload.mustDraw
        ? 'Your turn. You have no playable cards. ' + topDiscard
        : 'Your turn. ' + topDiscard;
      setTableStatus(message, 'alert');
      srSpeak(message.trim(), 'assertive');
    } else {
      setTableStatus(indicatorText, 'info');
      srSpeak(indicatorText, 'polite');
    }
  }

  setPlayDirectionIndicator();
  renderPlayerSummary();
  renderStackControls();
});

socket.on('giveCardPrompt', function (payload) {
  const recipientName = (payload && payload.toPlayerName) || 'the next player';
  const color = payload && payload.color ? payload.color + ' ' : '';
  srSpeak('You play a ' + color + 'Give Plus One. Pick a card from your hand to pass to ' + recipientName + '.', 'assertive', { canInterruptLock: true });
});

socket.on('discardCardInfo', function (payload) {
  if (!payload) {
    srSpeak('No discard card available', 'assertive', { canInterruptLock: true });
    return;
  }

  srSpeak(payload.message || 'No discard card available', payload.success ? 'polite' : 'assertive', { canInterruptLock: true });
});

socket.on('playResult', function (payload) {
  if (!payload) {
    return;
  }

  if (!payload.success) {
    srSpeak(payload.message || 'Play action updated', 'assertive');
  }
});

socket.on('drawResult', function (payload) {
  if (!payload) {
    return;
  }

  if (payload.success && typeof payload.card === 'number') {
    const focusedDrawnCard = focusDrawnCard(payload.card);
    drawHand();

    const drawMessage = 'You drew ' + describeCardForSpeech(payload.card);
    const detailMessage = payload.message && payload.message.indexOf('You drew') === 0
      ? payload.message.slice(payload.message.indexOf('.') + 1).trim()
      : payload.message;
    const selectedMessage = focusedDrawnCard ? ' Selected.' : '';
    srSpeak((detailMessage ? drawMessage + '. ' + detailMessage : drawMessage) + selectedMessage, 'assertive', { lockMs: 1800 });
    appState.handBeforeDraw = null;
    return;
  }

  appState.handBeforeDraw = null;
  srSpeak(payload.message || 'Draw action updated', payload.success ? 'polite' : 'assertive');
});

socket.on('cardPlayed', function (payload) {
  if (!payload || !payload.description) {
    return;
  }

  srSpeak(payload.description + ' played.', 'polite');
});

socket.on('forcedDraw', function (payload) {
  if (!payload) {
    return;
  }

  const message = payload.playerName + ' plays ' + payload.cardTypeName + ' ' + payload.color + '. You draw '
    + payload.drawnList + '. It is ' + payload.nextPlayerName + "'s turn.";
  srSpeak(message, 'assertive', { lockMs: 2200 });
});

socket.on('forcedDrawOthers', function (payload) {
  if (!payload) {
    return;
  }

  const message = payload.playerName + ' plays ' + payload.cardTypeName + ' ' + payload.color + '. '
    + payload.targetName + ' draws ' + payload.drawWord + ' cards.';
  srSpeak(message, 'polite', { lockMs: 1600 });
});

socket.on('playerDrewCard', function (payload) {
  if (!payload || !payload.playerName) {
    return;
  }

  srSpeak(payload.playerName + ' draws a card.', 'polite');
});

socket.on('actionNotice', function (message) {
  if (!message) {
    return;
  }

  const isUno = /says Lumo/i.test(message);
  if (isUno) {
    const actorIsYou = message.indexOf('You') === 0;
    const actorName = message.replace(/\s+says Lumo/i, '').trim();
    const unoSpeech = window.CardTableUnoSpeech && typeof window.CardTableUnoSpeech.buildUnoSpeechText === 'function'
      ? window.CardTableUnoSpeech.buildUnoSpeechText(actorIsYou, actorName)
      : message;
    setTableStatus(message, 'alert');
    srSpeak(unoSpeech, 'assertive', { canInterruptLock: true, lockMs: 1400 });
    return;
  }

  setTableStatus(message, 'alert');
  srSpeak(message, 'assertive');
});

socket.on('roundSummary', function (summary) {
  if (!summary) {
    return;
  }

  const scoreText = (summary.scores || []).map(function (entry) {
    return entry.name + ': ' + entry.totalPoints + ' total';
  }).join(', ');

  const roundNumber = summary.roundNumber || 1;
  const headline = summary.winner + ' won with ' + summary.roundPoints + ' points.';
  const msg = headline + (scoreText ? ' Scores: ' + scoreText : '');

  appState.currentTurnPlayerId = null;
  appState.lastAnnouncedTurnPlayerId = null;
  appState.turn = false;
  appState.hand = [];
  appState.handIndex = 0;
  appState.handBeforeDraw = null;
  appState.pendingDrawCard = null;
  appState.pendingRoundDealAnnouncement = true;
  appState.roundResultMessage = headline;
  drawHand();
  drawTurnIndicator('');
  showAnnouncementOverlay({
    eyebrow: 'Round ' + roundNumber + ' of ' + (summary.maxRounds || 30),
    title: 'Round ' + roundNumber + ' winner',
    message: msg,
    tone: 'winner',
    duration: 6000,
    kind: 'roundSummary'
  });
  setTableStatus(headline, 'success');
  setRoundResult(headline);
  renderPlayerSummary();
  srSpeak(headline, 'assertive', { lockMs: 3000 });
});

socket.on('matchSummary', function (summary) {
  if (!summary) {
    return;
  }

  const scoreText = (summary.scores || []).map(function (entry) {
    return entry.name + ': ' + entry.totalPoints;
  }).join(', ');

  const headline = summary.winner + ' won with ' + summary.score + ' points.';
  const msg = headline + (scoreText ? ' Final scores: ' + scoreText : '');

  appState.currentTurnPlayerId = null;
  appState.lastAnnouncedTurnPlayerId = null;
  appState.turn = false;
  appState.pendingRoundDealAnnouncement = false;
  appState.roundResultMessage = headline;
  drawTurnIndicator('');

  showAnnouncementOverlay({
    eyebrow: 'Match Winner',
    title: summary.winner + ' won the match',
    message: msg,
    tone: 'winner',
    duration: 3000,
    kind: 'matchSummary'
  });
  setTableStatus(headline, 'success');
  setRoundResult(headline);
  srSpeak(headline, 'assertive', { lockMs: 3000 });
});

init();
