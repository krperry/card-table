// Rummy client module: hand/meld/lay-off/discard UI (native buttons, not
// canvas - same reasoning as hearts-client.js/spades-client.js/
// cribbage-client.js), keyboard shortcuts, and all Rummy-specific socket.io
// event handlers. Loaded via a plain <script> tag after main.js and the
// other game clients (see public/index.html) so it shares main.js's global
// scope and can reference appState/el/socket/srSpeak/bindPress/
// bindPressNoFocus directly, the same way those files do.
//
// The one genuinely new UI concept versus Hearts/Spades/Cribbage: melds are
// face-up groups every player can see and lay cards off onto - "glance at
// the table" for a sighted player, but there's no sighted equivalent for a
// screen-reader user. The 1-6 keys read any seat's melds aloud on demand and
// set that seat as the pending lay-off target for a following L press - see
// handleRummyKeys() below and #help-content-rummy in index.html for the full
// hotkey table. Lay-offs never ask the player to name a specific meld group
// within a seat - marked cards auto-attach to whichever group they legally
// extend, server-side (games/rummy/index.js's performLayOffCards) - so this
// client only ever needs to track a target SEAT, not a target group.

const RUMMY_CARD_IMAGE_BASE = 'images/playing-cards/';
const RUMMY_RANK_NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const RUMMY_SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
const RUMMY_RANK_ORDER = {
  A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13
};
const RUMMY_SUIT_SORT = { C: 0, D: 1, H: 2, S: 3 };

Object.assign(appState, {
  rummyHand: [],
  rummyPhase: null,
  rummyHandNumber: 0,
  rummyDealerIndex: null,
  rummyTurnPlayerId: null,
  rummyTurnPlayerName: '',
  rummyTurnPhase: null,
  rummyStockCount: 0,
  rummyDiscardTop: null,
  rummyMelds: [],
  rummySelectedCards: [],
  rummyLayoffTargetSeat: null,
  rummyHandButtonsHandKey: null
});

function rummyCardRank(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function rummyCardSuit(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function rummyCardName(card) {
  const rank = RUMMY_RANK_NAMES[rummyCardRank(card)];
  const suit = RUMMY_SUIT_NAMES[rummyCardSuit(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

function rummyCardImageSrc(card) {
  return RUMMY_CARD_IMAGE_BASE + card + '.svg';
}

function rummyRankOrderValue(card) {
  return RUMMY_RANK_ORDER[rummyCardRank(card)] || 0;
}

function rummyDisplayHand() {
  return appState.rummyHand.slice().sort(function (a, b) {
    const suitDiff = RUMMY_SUIT_SORT[rummyCardSuit(a)] - RUMMY_SUIT_SORT[rummyCardSuit(b)];
    if (suitDiff !== 0) {
      return suitDiff;
    }
    return rummyRankOrderValue(a) - rummyRankOrderValue(b);
  });
}

// --- Seat helpers ------------------------------------------------------------

function getRummyOwnSeatIndex() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return -1;
  }
  return appState.currentTable.players.findIndex(function (player) { return player.id === socket.id; });
}

function getRummyOwnPlayer() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return null;
  }
  return appState.currentTable.players.find(function (player) { return player.id === socket.id; }) || null;
}

function isRummyMyTurn() {
  return appState.rummyPhase === 'playing' && appState.rummyTurnPlayerId === socket.id;
}

// --- Status region -------------------------------------------------------

function renderRummyStatus() {
  const handEl = document.getElementById('rummy-status-hand');
  if (handEl) {
    handEl.textContent = appState.rummyHandNumber ? ('Hand ' + appState.rummyHandNumber) : '';
  }

  const turnEl = document.getElementById('rummy-status-turn');
  if (turnEl) {
    if (appState.rummyTurnPlayerId) {
      const phaseLabel = appState.rummyTurnPhase === 'draw' ? ' - draw a card' : ' - meld, lay off, or discard';
      turnEl.textContent = appState.rummyTurnPlayerId === socket.id
        ? ('Your turn' + phaseLabel)
        : ((appState.rummyTurnPlayerName || 'Another player') + "'s turn");
    } else {
      turnEl.textContent = '';
    }
  }

  const pileEl = document.getElementById('rummy-status-pile');
  if (pileEl) {
    pileEl.textContent = appState.rummyPhase && appState.rummyPhase !== 'waiting'
      ? ('Stock: ' + appState.rummyStockCount + ' cards | Discard top: ' + (appState.rummyDiscardTop ? rummyCardName(appState.rummyDiscardTop) : 'none'))
      : '';
  }

  const scoreEl = document.getElementById('rummy-status-score');
  if (scoreEl && appState.currentTable && Array.isArray(appState.currentTable.players)) {
    const parts = appState.currentTable.players.map(function (player) {
      const label = player.id === socket.id ? 'You' : player.name;
      return label + ': ' + (typeof player.score === 'number' ? player.score : 0);
    });
    scoreEl.textContent = 'Scores - ' + parts.join(', ');
  }
}

// --- Meld board (always-visible, public info) --------------------------------

function rummyMeldGroupLabel(group) {
  if (!group || !Array.isArray(group.cards) || !group.cards.length) {
    return '';
  }
  if (group.type === 'set') {
    return 'Set: ' + RUMMY_RANK_NAMES[rummyCardRank(group.cards[0])] + 's';
  }
  const sorted = group.cards.slice().sort(function (a, b) { return rummyRankOrderValue(a) - rummyRankOrderValue(b); });
  const suit = RUMMY_SUIT_NAMES[rummyCardSuit(sorted[0])] || '';
  const ranks = sorted.map(function (card) { return RUMMY_RANK_NAMES[rummyCardRank(card)]; }).join('-');
  return 'Run: ' + ranks + ' of ' + suit;
}

function renderRummyMeldBoard() {
  const board = document.getElementById('rummy-meld-board');
  if (!board || !appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }

  board.innerHTML = '';
  appState.currentTable.players.forEach(function (player, seatIndex) {
    const section = document.createElement('div');
    section.className = 'rummy-meld-seat' + (seatIndex === appState.rummyLayoffTargetSeat ? ' rummy-layoff-target' : '');

    const heading = document.createElement('h4');
    heading.textContent = 'Seat ' + (seatIndex + 1) + ': ' + player.name + (player.id === socket.id ? ' (you)' : '');
    section.appendChild(heading);

    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.textContent = seatIndex === appState.rummyLayoffTargetSeat ? 'Reviewed (lay-off target)' : 'Review melds';
    reviewBtn.setAttribute('aria-label', "Review " + player.name + "'s melds and set as lay-off target");
    bindPress(reviewBtn, function () { rummyReviewSeatMelds(seatIndex); });
    section.appendChild(reviewBtn);

    const groups = (appState.rummyMelds && appState.rummyMelds[seatIndex]) || [];
    const list = document.createElement('ul');
    list.className = 'rummy-meld-group-list';
    if (!groups.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'No melds yet.';
      list.appendChild(li);
    } else {
      groups.forEach(function (group) {
        const li = document.createElement('li');
        li.className = 'rummy-meld-group';
        li.textContent = rummyMeldGroupLabel(group);
        list.appendChild(li);
      });
    }
    section.appendChild(list);

    board.appendChild(section);
  });
}

function rummyReviewSeatMelds(seatIndex) {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const player = appState.currentTable.players[seatIndex];
  if (!player) {
    srSpeak('No player in seat ' + (seatIndex + 1) + '.', 'assertive', { canInterruptLock: true });
    return;
  }

  appState.rummyLayoffTargetSeat = seatIndex;
  const isOwn = player.id === socket.id;
  const groups = (appState.rummyMelds && appState.rummyMelds[seatIndex]) || [];
  const who = isOwn ? 'Your' : (player.name + "'s");

  if (!groups.length) {
    srSpeak(who + ' melds: none yet. Lay-off target set to ' + player.name + '.', 'assertive', { canInterruptLock: true });
  } else {
    const text = groups.map(function (group, index) { return (index + 1) + ': ' + rummyMeldGroupLabel(group); }).join('. ');
    srSpeak(who + ' melds - ' + text + '. Lay-off target set to ' + player.name + '.', 'assertive', { canInterruptLock: true });
  }

  renderRummyMeldBoard();
  renderRummyControlButtons();
}

// --- Shared roving-tabindex button-grid machinery ---------------------------
// Copied and renamed from hearts-client.js/spades-client.js's equivalents,
// following the codebase's existing per-game-duplication style.

function rummyFocusFirstEnabledButton(container) {
  if (!container) {
    return;
  }
  const button = container.querySelector('button[tabindex="0"]') || container.querySelector('button');
  if (button && typeof button.focus === 'function') {
    button.focus();
  }
}

// Called from main.js's shared "F" shortcut (see focusActiveGameCards there).
function rummyFocusHand() {
  rummyFocusFirstEnabledButton(document.getElementById('rummy-hand'));
}

function rummyBindCardGridKeys(container, options) {
  if (container.dataset.rummyKeysBound) {
    return;
  }
  container.dataset.rummyKeysBound = 'true';

  const onEnter = options && typeof options.onEnter === 'function' ? options.onEnter : null;
  const getGroupKey = options && typeof options.getGroupKey === 'function' ? options.getGroupKey : null;

  container.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && onEnter) {
      event.preventDefault();
      onEnter();
      return;
    }

    const buttons = Array.prototype.slice.call(container.querySelectorAll('button'));
    if (!buttons.length) {
      return;
    }
    const currentIndex = buttons.indexOf(document.activeElement);
    let nextIndex = -1;

    if (getGroupKey && currentIndex >= 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const groupKeys = buttons.map(getGroupKey);
      let groupStart = currentIndex;
      while (groupStart > 0 && groupKeys[groupStart - 1] === groupKeys[currentIndex]) {
        groupStart--;
      }
      let groupEnd = currentIndex;
      while (groupEnd < buttons.length - 1 && groupKeys[groupEnd + 1] === groupKeys[currentIndex]) {
        groupEnd++;
      }
      nextIndex = event.key === 'ArrowUp'
        ? (groupEnd + 1) % buttons.length
        : (groupStart - 1 + buttons.length) % buttons.length;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = currentIndex < 0 ? buttons.length - 1 : (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = buttons.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    buttons.forEach(function (button, index) { button.tabIndex = index === nextIndex ? 0 : -1; });
    buttons[nextIndex].focus();
  });
}

function rummyRebuildCardButtons(container, items, buildButton) {
  const hadFocus = container.contains(document.activeElement);
  const previousButtons = Array.prototype.slice.call(container.querySelectorAll('button'));
  const focusedIndex = hadFocus ? previousButtons.indexOf(document.activeElement) : -1;

  container.innerHTML = '';
  items.forEach(function (item, index) {
    container.appendChild(buildButton(item, index));
  });

  const buttons = container.querySelectorAll('button');
  if (hadFocus && buttons.length) {
    const restoreIndex = focusedIndex >= 0 ? Math.min(focusedIndex, buttons.length - 1) : 0;
    Array.prototype.forEach.call(buttons, function (button, index) { button.tabIndex = index === restoreIndex ? 0 : -1; });
    buttons[restoreIndex].focus();
  }
}

// --- Hand UI -----------------------------------------------------------------
// Space (native button activation) marks/unmarks a card for the next meld or
// lay-off commit (M / L, or the matching buttons); Enter discards the
// focused card immediately, ending the turn - the exact same "onEnter does
// something different from Space" split hearts-client.js's passing grid
// uses (see rummyBindCardGridKeys above, which intercepts Enter on keydown
// before the browser's native Enter-triggers-click behavior can fire it).

function rummyUpdateHandButton(button, card) {
  const selected = appState.rummySelectedCards.indexOf(card) !== -1;
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-label', rummyCardName(card) + (selected ? ', marked' : ''));
}

function renderRummyHand() {
  const area = document.getElementById('rummy-hand-area');
  const container = document.getElementById('rummy-hand');
  if (!area || !container) {
    return;
  }

  const showHand = appState.rummyPhase && appState.rummyPhase !== 'waiting' && appState.rummyHand.length > 0;
  area.classList.toggle('hidden', !showHand);
  if (!showHand) {
    return;
  }

  rummyBindCardGridKeys(container, {
    onEnter: rummyAttemptDiscardFocused,
    getGroupKey: function (button) { return rummyCardSuit(button.dataset.card); }
  });

  const displayHand = rummyDisplayHand();
  const handKey = displayHand.join(',');
  if (appState.rummyHandButtonsHandKey !== handKey) {
    rummyRebuildCardButtons(container, displayHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = rummyCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      rummyUpdateHandButton(button, card);
      bindPressNoFocus(button, function () { rummyToggleCard(card, button); });
      return button;
    });
    appState.rummyHandButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      rummyUpdateHandButton(button, button.dataset.card);
    });
  }
}

function rummyToggleCard(card, button) {
  const index = appState.rummySelectedCards.indexOf(card);
  if (index !== -1) {
    appState.rummySelectedCards.splice(index, 1);
    srSpeak('Card unmarked', 'polite', { canInterruptLock: true });
  } else {
    appState.rummySelectedCards.push(card);
    srSpeak('Marked ' + appState.rummySelectedCards.length + ' card' + (appState.rummySelectedCards.length === 1 ? '' : 's'), 'polite', { canInterruptLock: true });
  }
  rummyUpdateHandButton(button, card);
  renderRummyControlButtons();
}

// --- Actions -------------------------------------------------------------

function rummyAttemptDrawStock() {
  socket.emit('rummyDrawStock');
}

function rummyAttemptDrawDiscard() {
  socket.emit('rummyDrawDiscard');
}

function rummyAttemptDiscard(card) {
  // Server-authoritative (see games/rummy/index.js's module header comment) -
  // no local legality pre-check here, matching every other game client's
  // heartsAttemptPlay()/spadesAttemptPlay() reasoning.
  socket.emit('rummyDiscardCard', { card: card });
}

function rummyAttemptDiscardFocused() {
  const focused = document.activeElement;
  const card = focused && focused.dataset ? focused.dataset.card : null;
  if (!card) {
    return;
  }
  rummyAttemptDiscard(card);
}

function rummyAttemptDiscardSelected() {
  if (appState.rummySelectedCards.length !== 1) {
    srSpeak('Select exactly one card to discard', 'assertive', { canInterruptLock: true });
    return;
  }
  rummyAttemptDiscard(appState.rummySelectedCards[0]);
}

function rummyCommitMeld() {
  if (appState.rummySelectedCards.length < 3) {
    srSpeak('Select at least three cards to meld', 'assertive', { canInterruptLock: true });
    return;
  }
  socket.emit('rummyMeldCards', { cards: appState.rummySelectedCards.slice() });
}

function rummyCommitLayoff() {
  if (appState.rummyLayoffTargetSeat === null) {
    srSpeak('Review a player’s melds first - press 1 through 6', 'assertive', { canInterruptLock: true });
    return;
  }
  if (!appState.rummySelectedCards.length) {
    srSpeak('Select at least one card to lay off', 'assertive', { canInterruptLock: true });
    return;
  }
  socket.emit('rummyLayOffCards', { targetPlayerIndex: appState.rummyLayoffTargetSeat, cards: appState.rummySelectedCards.slice() });
}

// --- Control buttons (mouse equivalents of the keyboard shortcuts) -----------

function renderRummyControlButtons() {
  const myTurn = isRummyMyTurn();
  const drawPhase = myTurn && appState.rummyTurnPhase === 'draw';
  const actionPhase = myTurn && appState.rummyTurnPhase === 'action';

  const drawStockBtn = document.getElementById('rummy-draw-stock-btn');
  const drawDiscardBtn = document.getElementById('rummy-draw-discard-btn');
  const meldBtn = document.getElementById('rummy-meld-btn');
  const layoffBtn = document.getElementById('rummy-layoff-btn');
  const discardBtn = document.getElementById('rummy-discard-btn');

  if (drawStockBtn) {
    drawStockBtn.disabled = !drawPhase;
  }
  if (drawDiscardBtn) {
    drawDiscardBtn.disabled = !drawPhase || !appState.rummyDiscardTop;
  }
  if (meldBtn) {
    meldBtn.disabled = !actionPhase || appState.rummySelectedCards.length < 3;
  }
  if (layoffBtn) {
    layoffBtn.disabled = !actionPhase || !appState.rummySelectedCards.length || appState.rummyLayoffTargetSeat === null;
  }
  if (discardBtn) {
    discardBtn.disabled = !actionPhase || appState.rummySelectedCards.length !== 1;
  }
}

// --- Top-level render --------------------------------------------------------

function renderRummyWidgets() {
  renderRummyStatus();
  renderRummyMeldBoard();
  renderRummyHand();
  renderRummyControlButtons();
}

function renderRummyPanel() {
  if (!appState.currentTable || appState.currentTable.gameType !== 'rummy') {
    return;
  }

  const rummy = appState.currentTable.rummy;
  if (rummy) {
    appState.rummyPhase = rummy.phase;
    appState.rummyHandNumber = rummy.handNumber;
    appState.rummyDealerIndex = rummy.dealerIndex;
    appState.rummyTurnPlayerId = rummy.turnPlayerId;
    appState.rummyTurnPlayerName = rummy.turnPlayerName;
    appState.rummyTurnPhase = rummy.turnPhase;
    appState.rummyStockCount = rummy.stock ? rummy.stock.count : 0;
    appState.rummyDiscardTop = rummy.discardPile ? rummy.discardPile.top : null;
    appState.rummyMelds = rummy.melds || [];
  }

  renderRummyWidgets();
}

// --- Keyboard shortcuts --------------------------------------------------------

function announceRummyHand() {
  const displayHand = rummyDisplayHand();
  if (!displayHand.length) {
    srSpeak('Your hand is empty', 'polite', { canInterruptLock: true });
    return;
  }
  srSpeak('Your hand: ' + displayHand.map(rummyCardName).join(', '), 'polite', { canInterruptLock: true });
}

function announceRummyTurnStatus() {
  const parts = [];
  if (appState.rummyHandNumber) {
    parts.push('Hand ' + appState.rummyHandNumber);
  }
  if (appState.rummyPhase === 'playing') {
    parts.push(appState.rummyTurnPhase === 'draw' ? 'draw phase' : 'action phase');
    if (appState.rummyTurnPlayerId) {
      parts.push(appState.rummyTurnPlayerId === socket.id ? 'your turn' : ((appState.rummyTurnPlayerName || 'another player') + "'s turn"));
    }
  }
  const ownSeat = getRummyOwnSeatIndex();
  const total = appState.currentTable && Array.isArray(appState.currentTable.players) ? appState.currentTable.players.length : 0;
  if (ownSeat >= 0 && total) {
    parts.push('You are seat ' + (ownSeat + 1) + ' of ' + total);
  }
  srSpeak(parts.join('. '), 'assertive', { canInterruptLock: true });
}

function announceRummyPile() {
  const text = 'Stock: ' + appState.rummyStockCount + ' cards. Discard top: '
    + (appState.rummyDiscardTop ? rummyCardName(appState.rummyDiscardTop) : 'none') + '.';
  srSpeak(text, 'polite', { canInterruptLock: true });
}

function announceRummyOwnScore() {
  const player = getRummyOwnPlayer();
  const score = player && typeof player.score === 'number' ? player.score : 0;
  srSpeak('Your score is ' + score, 'assertive', { canInterruptLock: true });
}

function announceRummyAllScores() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const text = appState.currentTable.players.map(function (player) {
    const label = player.id === socket.id ? 'You' : player.name;
    return label + ': ' + (typeof player.score === 'number' ? player.score : 0);
  }).join(', ');
  srSpeak(text, 'assertive', { canInterruptLock: true });
}

function handleRummyKeys(event) {
  if (appState.helpOpen || appState.announcementOpen || appState.rulesOpen || appState.kickOpen) {
    return;
  }

  if (event.key === '?') {
    openHelpOverlay();
    event.preventDefault();
    return;
  }

  if (/^[1-6]$/.test(event.key)) {
    rummyReviewSeatMelds(parseInt(event.key, 10) - 1);
    event.preventDefault();
    return;
  }

  const key = event.key.toLowerCase();
  if (key === 'h') {
    announceRummyHand();
    event.preventDefault();
  } else if (key === 't') {
    announceRummyTurnStatus();
    event.preventDefault();
  } else if (key === 'p') {
    announceRummyPile();
    event.preventDefault();
  } else if (key === 'd') {
    rummyAttemptDrawStock();
    event.preventDefault();
  } else if (key === 'w') {
    rummyAttemptDrawDiscard();
    event.preventDefault();
  } else if (key === 'm') {
    rummyCommitMeld();
    event.preventDefault();
  } else if (key === 'l') {
    rummyCommitLayoff();
    event.preventDefault();
  } else if (key === 's' && event.shiftKey) {
    announceRummyAllScores();
    event.preventDefault();
  } else if (key === 's') {
    announceRummyOwnScore();
    event.preventDefault();
  }
}

// --- Socket handlers ------------------------------------------------------------

socket.on('rummyHand', function (payload) {
  if (!payload || !Array.isArray(payload.hand)) {
    return;
  }

  appState.rummyHand = payload.hand;
  appState.rummyHandNumber = payload.handNumber;
  appState.rummyPhase = payload.phase;
  appState.rummyDealerIndex = payload.dealerIndex;
  appState.rummyHandButtonsHandKey = null;
  // The hand's card SET changed (draw/meld/lay-off/discard all mutate it) -
  // any stale marks would silently reference cards that may no longer be in
  // hand, so drop the selection and let the player re-mark for their next
  // action.
  appState.rummySelectedCards = [];

  renderRummyWidgets();

  if (payload.handNumber && appState.rummyDealerIndex !== null) {
    srSpeak('New hand. Your hand: ' + rummyDisplayHand().map(rummyCardName).join(', '), 'polite', { canInterruptLock: true });
  }
});

socket.on('rummyTurnState', function (payload) {
  if (!payload) {
    return;
  }

  appState.rummyPhase = payload.phase;
  appState.rummyHandNumber = payload.handNumber;
  appState.rummyDealerIndex = payload.dealerIndex;
  appState.rummyTurnPlayerId = payload.turnPlayerId;
  appState.rummyTurnPlayerName = payload.turnPlayerName;
  appState.rummyTurnPhase = payload.turnPhase;
  appState.rummyStockCount = payload.stockCount;
  appState.rummyDiscardTop = payload.discardTop;
  appState.rummyMelds = payload.melds || [];

  renderRummyWidgets();

  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true, lockMs: 900 });
  }

  if (payload.turnPlayerId === socket.id && payload.turnPhase === 'draw') {
    window.requestAnimationFrame(function () {
      rummyFocusFirstEnabledButton(document.getElementById('rummy-controls'));
    });
  }
});

socket.on('rummyDrawResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Draw rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
    return;
  }
  srSpeak('You drew ' + rummyCardName(payload.card) + ' from the ' + payload.source + '.', 'polite', { canInterruptLock: true });
  window.requestAnimationFrame(function () {
    rummyFocusHand();
  });
});

socket.on('rummyMeldResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Meld rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
    return;
  }
  srSpeak('Meld formed.', 'polite', { canInterruptLock: true });
});

socket.on('rummyLayOffResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Lay-off rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
    return;
  }
  srSpeak('Lay-off complete.', 'polite', { canInterruptLock: true });
});

socket.on('rummyDiscardResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Discard rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
  }
});

socket.on('rummyHandSummary', function (payload) {
  if (!payload) {
    return;
  }

  const lines = payload.rows.map(function (row) {
    return row.name + ': ' + row.deadwood + ' deadwood' + (row.pointsAwarded ? (', +' + row.pointsAwarded + ' points') : '') + ' (total ' + row.total + ')';
  });
  const headline = payload.noWinner ? 'No winner this hand.' : (payload.wentOutPlayerName + ' went out.');
  const message = headline + ' ' + lines.join(' ');

  setRoundResult('Hand ' + payload.handNumber + ' complete. ' + message);

  if (!payload.gameOver) {
    showAnnouncementOverlay({
      eyebrow: 'Hand ' + payload.handNumber + ' complete',
      title: 'Hand complete',
      message: message,
      tone: 'info',
      sticky: true,
      kind: 'rummyHandSummary'
    });
  }

  srSpeak('Hand ' + payload.handNumber + ' complete. ' + message, 'assertive', { canInterruptLock: true, lockMs: 2000 });
});

socket.on('rummyGameOver', function (payload) {
  if (!payload) {
    return;
  }

  const scoreText = payload.scores.map(function (entry) { return entry.name + ': ' + entry.totalPoints; }).join(', ');
  const message = payload.winnerName + ' wins. Final scores: ' + scoreText;

  setRoundResult('Game over. ' + message);
  showAnnouncementOverlay({
    eyebrow: 'Game Over',
    title: payload.winnerName + ' wins the game',
    message: message,
    tone: 'winner',
    sticky: true,
    duration: 4000,
    kind: 'rummyGameOver'
  });
  srSpeak('Game over. ' + message, 'assertive', { canInterruptLock: true, lockMs: 3000 });
});

// --- Wiring -----------------------------------------------------------------

function rummyBindControls() {
  bindPress(document.getElementById('rummy-draw-stock-btn'), rummyAttemptDrawStock);
  bindPress(document.getElementById('rummy-draw-discard-btn'), rummyAttemptDrawDiscard);
  bindPress(document.getElementById('rummy-meld-btn'), rummyCommitMeld);
  bindPress(document.getElementById('rummy-layoff-btn'), rummyCommitLayoff);
  bindPress(document.getElementById('rummy-discard-btn'), rummyAttemptDiscardSelected);
}

document.addEventListener('DOMContentLoaded', function () {
  const rummyPanel = document.getElementById('rummy-panel');
  if (rummyPanel) {
    rummyPanel.addEventListener('keydown', handleRummyKeys);
  }
  rummyBindControls();
});

// Scripts run after the DOM has parsed (they are placed at the end of
// <body>), so bind immediately too in case DOMContentLoaded already fired.
if (document.readyState !== 'loading') {
  const rummyPanelNow = document.getElementById('rummy-panel');
  if (rummyPanelNow && !rummyPanelNow.dataset.rummyBound) {
    rummyPanelNow.dataset.rummyBound = 'true';
    rummyPanelNow.addEventListener('keydown', handleRummyKeys);
  }
  rummyBindControls();
}
