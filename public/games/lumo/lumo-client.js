// Lumo (UNO-like) client module: card model, canvas rendering, keyboard
// shortcuts, color picker, stacking/give UI, rules overlay, and all Lumo-
// specific socket.io event handlers. Loaded via a plain <script> tag after
// main.js (see public/index.html) so it shares main.js's global scope and
// can reference appState/el/socket/srSpeak/canvas/ctx directly, the same
// way this code worked when it lived inside main.js - nothing here changes
// behavior, it only moves where the code lives.
const cdWidth = 240;
const cdHeight = 360;

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

function acceptStackPenalty() {
  if (!appState.currentTable || appState.gameStatus !== 'in_game' || !appState.currentTable.stackState || !appState.currentTable.stackState.active) {
    srSpeak('No active draw stack', 'assertive');
    return;
  }

  socket.emit('acceptStackPenalty');
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
  // The canvas's drawing-buffer resolution (canvas.width/height, fixed at
  // 1000x600) is independent of its displayed CSS size, which now varies a
  // lot more (up to 1300px normally, 1800px full screen - see style.css).
  // Scale pointer coordinates from displayed/CSS pixels into drawing-buffer
  // pixels so hit-testing against canvas.width/height-based math below stays
  // correct at every display size, not just when they happen to match.
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  const x = (pointer.clientX - rect.left) * scaleX;
  const y = (pointer.clientY - rect.top) * scaleY;

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

// Hand is kept sorted by color (see compareCardsForHandSort/the 'haveCard'
// handler below), so consecutive cards sharing cardColor() form a contiguous
// run. Up/Down Arrow jump between those color runs: 'next' moves to the
// lowest-value card of the next color (wrapping past the last card back to
// the first), 'prev' moves to the highest-value card of the previous color
// (wrapping past the first card back to the last).
function lumoHandGroupNavIndex(direction) {
  const hand = appState.hand;
  const currentIndex = appState.handIndex;
  if (!hand.length) {
    return currentIndex;
  }
  const currentColor = cardColor(hand[currentIndex]);
  let groupStart = currentIndex;
  while (groupStart > 0 && cardColor(hand[groupStart - 1]) === currentColor) {
    groupStart--;
  }
  let groupEnd = currentIndex;
  while (groupEnd < hand.length - 1 && cardColor(hand[groupEnd + 1]) === currentColor) {
    groupEnd++;
  }
  return direction === 'next'
    ? (groupEnd + 1) % hand.length
    : (groupStart - 1 + hand.length) % hand.length;
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
      message = getSelectedCardDescription();
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'arrowright') {
    if (appState.hand.length) {
      appState.handIndex = Math.min(appState.hand.length - 1, appState.handIndex + 1);
      drawHand();
      message = getSelectedCardDescription();
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'arrowup') {
    if (appState.hand.length) {
      appState.handIndex = lumoHandGroupNavIndex('next');
      drawHand();
      message = getSelectedCardDescription();
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'arrowdown') {
    if (appState.hand.length) {
      appState.handIndex = lumoHandGroupNavIndex('prev');
      drawHand();
      message = getSelectedCardDescription();
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'home') {
    if (appState.hand.length) {
      appState.handIndex = 0;
      drawHand();
      message = getSelectedCardDescription();
    } else {
      message = 'No cards in hand';
    }
    handled = true;
  } else if (key === 'end') {
    if (appState.hand.length) {
      appState.handIndex = appState.hand.length - 1;
      drawHand();
      message = getSelectedCardDescription();
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
  const selectedText = describeCardForSpeech(selected.card) + '.';
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
  srSpeak(getSelectedCardDescription(), 'assertive', { canInterruptLock: true });
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

  if (payload.actorHasUno && (payload.action === 'play' || payload.action === 'give_resolve')) {
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
