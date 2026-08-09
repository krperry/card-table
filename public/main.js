// Socket.IO's default path ("/socket.io") is absolute, so it breaks when this
// app is reverse-proxied under a sub-path (e.g. valhalla.com/games/). Derive
// the Socket.IO path from the current page location so it works whether the
// app is served from the domain root or from a proxied sub-path.
const socketIoPath = window.location.pathname.replace(/[^/]*$/, '') + 'socket.io';
const socket = io({ path: socketIoPath, autoConnect: true });

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const playerEmailStorageKey = 'unoPlayerEmail';
const displayNameStorageKey = 'unoDisplayName';
const rememberTokenStorageKey = 'unoRememberToken';

const GAME_CATALOG = {
  uno: { type: 'uno', name: 'Lumo', playable: true, description: 'Join a live Lumo table.' },
  hearts: { type: 'hearts', name: 'Hearts', playable: true, description: 'Join a live Hearts table.' },
  spades: { type: 'spades', name: 'Spades', playable: false, description: 'Spades is not implemented yet.' },
  cribbage: { type: 'cribbage', name: 'Cribbage', playable: false, description: 'Cribbage is not implemented yet.' }
};




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
  playHistoryList: document.getElementById('play-history-list'),
  lumoTableSettings: document.getElementById('lumo-table-settings'),
  heartsTableSettings: document.getElementById('hearts-table-settings'),
  newTablePointsToEndGame: document.getElementById('new-table-points-to-end-game'),
  heartsPanel: document.getElementById('hearts-panel')
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
  const pointsToEndGame = parseInt(el.newTablePointsToEndGame && el.newTablePointsToEndGame.value, 10);

  socket.emit('createTable', {
    name: tableName,
    gameType: selectedGame.type,
    securityCode: rawCode || undefined,
    winningScore: Number.isFinite(winningScore) ? winningScore : undefined,
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined,
    allowDrawTwoStacking: !!(el.allowDrawTwoStacking && el.allowDrawTwoStacking.checked),
    allowWildDrawFourStacking: !!(el.allowWildDrawFourStacking && el.allowWildDrawFourStacking.checked),
    computerPlayers: Number.isFinite(computerPlayers) ? computerPlayers : undefined,
    computerSkill: el.newTableComputerSkill ? el.newTableComputerSkill.value : undefined,
    pointsToEndGame: Number.isFinite(pointsToEndGame) ? pointsToEndGame : undefined
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

function isHeartsTable() {
  return !!(appState.currentTable && appState.currentTable.gameType === 'hearts');
}

function openHelpOverlay() {
  appState.helpOpen = true;
  const heartsHelp = document.getElementById('help-content-hearts');
  const lumoHelp = document.getElementById('help-content-lumo');
  if (heartsHelp && lumoHelp) {
    heartsHelp.classList.toggle('hidden', !isHeartsTable());
    lumoHelp.classList.toggle('hidden', isHeartsTable());
  }
  el.helpOverlay.classList.remove('hidden');
  el.closeHelpBtn.focus();
}

function closeHelpOverlay() {
  appState.helpOpen = false;
  el.helpOverlay.classList.add('hidden');
  if (appState.currentTable && appState.gameStatus === 'in_game' && isHeartsTable() && el.heartsPanel) {
    el.heartsPanel.focus();
  } else if (appState.currentTable && appState.gameStatus === 'in_game' && !isHeartsTable()) {
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

  if (wasOpen && kind === 'heartsHandSummary') {
    socket.emit('heartsAckHandSummary');
    setTableStatus('Waiting for other players to continue...', 'info');
  }

  if (restoreFocus === false) {
    return;
  }

  if (appState.currentTable && appState.gameStatus === 'in_game' && isHeartsTable() && el.heartsPanel) {
    el.heartsPanel.focus();
  } else if (appState.currentTable && appState.gameStatus === 'in_game' && !isHeartsTable()) {
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
      : 'Pick a card game to continue. Lumo and Hearts are available now; the others are accessible previews for later work.';
  }

  const isHearts = appState.selectedGameType === 'hearts' || (appState.currentTable && appState.currentTable.gameType === 'hearts');
  if (el.lumoTableSettings) {
    el.lumoTableSettings.classList.toggle('hidden', isHearts);
  }
  if (el.heartsTableSettings) {
    el.heartsTableSettings.classList.toggle('hidden', !isHearts);
  }

  if (appState.currentTable) {
    if (isHearts) {
      if (el.gamePanel) {
        el.gamePanel.classList.add('hidden');
      }
      if (el.heartsPanel) {
        el.heartsPanel.classList.toggle('hidden', appState.gameStatus !== 'in_game');
      }
    } else {
      if (el.heartsPanel) {
        el.heartsPanel.classList.add('hidden');
      }
      el.gamePanel.classList.toggle('hidden', appState.gameStatus !== 'in_game');
    }

    el.tableMeta.textContent = (appState.currentTable.gameName || 'Lumo') + ': ' + appState.currentTable.name + ' - ' + (appState.gameStatus === 'in_game' ? 'In game' : 'Waiting for players');
    el.tableHost.textContent = 'Host: ' + appState.currentTable.hostName;
    if (el.tableMatchSettings) {
      const matchSettings = appState.currentTable.matchSettings || {};
      if (isHearts) {
        const handText = appState.gameStatus === 'in_game' && appState.currentTable.hearts
          ? ' | Hand ' + appState.currentTable.hearts.handNumber
          : '';
        el.tableMatchSettings.textContent = 'Points to end game: ' + (matchSettings.pointsToEndGame || 100) + handText;
      } else {
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
    }

    if (isHearts) {
      // Hearts always fills to exactly four seats with computer players when
      // the host starts, so there is no minimum-player gate to enforce here.
      el.startGameBtn.disabled = !appState.isHost || appState.gameStatus === 'in_game';
    } else {
      const computerPlayerCount = (appState.currentTable.matchSettings && appState.currentTable.matchSettings.computerPlayers) || 0;
      const effectivePlayerCount = appState.currentTable.players.length + computerPlayerCount;
      el.startGameBtn.disabled = !appState.isHost || effectivePlayerCount < 2 || appState.gameStatus === 'in_game';
    }
    if (el.kickPlayerBtn) {
      const hasOtherPlayers = appState.currentTable.players.some(function (player) {
        return player.id !== socket.id && !player.isBot;
      });
      el.kickPlayerBtn.classList.toggle('hidden', !appState.isHost);
      el.kickPlayerBtn.disabled = !hasOtherPlayers;
    }
    setTableStatus(appState.tableStatusMessage, appState.tableStatusTone);
    if (!isHearts) {
      setPlayDirectionIndicator();
    } else if (el.playDirection) {
      el.playDirection.textContent = '';
    }
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
  if (typeof renderHeartsPanel === 'function') {
    renderHeartsPanel();
  }
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

  const isHearts = appState.currentTable.gameType === 'hearts';
  const heartsTurnPlayerId = isHearts && appState.currentTable.hearts ? appState.currentTable.hearts.turnPlayerId : null;

  appState.currentTable.players.forEach(function (player) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const unoBadge = document.createElement('span');
    const details = document.createElement('span');
    const isCurrentTurn = appState.gameStatus === 'in_game'
      && (player.id === appState.currentTurnPlayerId || player.id === heartsTurnPlayerId);
    const hasUno = !isHearts && appState.gameStatus === 'in_game' && player.cardCount === 1;
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
