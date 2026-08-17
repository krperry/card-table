// Hearts client module: hand/passing/trick UI (native buttons, not canvas),
// keyboard shortcuts, and all Hearts-specific socket.io event handlers.
// Loaded via a plain <script> tag after main.js (see public/index.html) so it
// shares main.js's global scope and can reference appState/el/socket/srSpeak
// directly, the same way public/games/lumo/lumo-client.js does.

const HEARTS_CARD_IMAGE_BASE = 'images/playing-cards/';
const HEARTS_RANK_NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const HEARTS_SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

Object.assign(appState, {
  heartsHand: [],
  heartsPhase: null,
  heartsDirection: null,
  heartsHandNumber: 0,
  heartsSelectedPass: [],
  heartsLegalCards: null,
  heartsTurnPlayerId: null,
  heartsTurnPlayerName: '',
  heartsTrick: [],
  heartsLastTrick: null,
  heartsHeartsBroken: false,
  heartsTrickNumber: 1,
  heartsHandButtonsHandKey: null,
  heartsPassButtonsHandKey: null,
  heartsReceivedCards: []
});

function heartsCardRank(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function heartsCardSuit(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function heartsCardName(card) {
  const rank = HEARTS_RANK_NAMES[heartsCardRank(card)];
  const suit = HEARTS_SUIT_NAMES[heartsCardSuit(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

function heartsCardImageSrc(card) {
  return HEARTS_CARD_IMAGE_BASE + card + '.svg';
}

function heartsSuitFullName(suitChar) {
  return HEARTS_SUIT_NAMES[suitChar] || '';
}

// A short two-note chime, purely a sighted-player convenience cue layered on
// top of the existing "Hearts are now broken" srSpeak announcements (never a
// replacement for them - see the callers below). playTone() is defined in
// lumo-client.js but shared across game clients via the global scope (see
// this file's header comment), the same way playErrorTone() is already
// reused here.
function playHeartsBrokenChime() {
  playTone(660, 140);
  window.setTimeout(function () { playTone(880, 220); }, 130);
}

// Centralizes every place appState.heartsHeartsBroken gets set from a server
// payload, so the chime fires exactly once per hand, right on the
// false-to-true transition, regardless of which of the several events
// (heartsTurnState, tableState-driven renderHeartsPanel) happens to be the
// one that first carries the news for a given seat.
function heartsApplyHeartsBroken(newValue) {
  if (newValue && !appState.heartsHeartsBroken) {
    playHeartsBrokenChime();
  }
  appState.heartsHeartsBroken = !!newValue;
}

// --- Status region -------------------------------------------------------

function renderHeartsStatus() {
  const statusEl = document.getElementById('hearts-status-hand');
  if (!statusEl) {
    return;
  }

  document.getElementById('hearts-status-hand').textContent = appState.heartsHandNumber
    ? ('Hand ' + appState.heartsHandNumber)
    : '';

  const directionEl = document.getElementById('hearts-status-direction');
  if (directionEl) {
    directionEl.textContent = appState.heartsPhase === 'passing'
      ? ('Passing direction: ' + (appState.heartsDirection || 'left'))
      : (appState.heartsDirection === 'hold' ? 'Hold hand - no cards passed' : '');
  }

  const turnEl = document.getElementById('hearts-status-turn');
  if (turnEl) {
    if (appState.heartsPhase === 'passing') {
      turnEl.textContent = appState.heartsSelectedPass.length === 3
        ? ''
        : 'Select three cards to pass';
    } else if (appState.heartsTurnPlayerId) {
      turnEl.textContent = appState.heartsTurnPlayerId === socket.id
        ? 'Your turn'
        : ((appState.heartsTurnPlayerName || 'Another player') + "'s turn");
    } else {
      turnEl.textContent = '';
    }
  }

  const brokenEl = document.getElementById('hearts-status-hearts-broken');
  if (brokenEl) {
    brokenEl.textContent = appState.heartsPhase === 'playing' || appState.heartsPhase === 'trick_complete'
      ? ('Hearts: ' + (appState.heartsHeartsBroken ? 'broken' : 'not broken'))
      : '';
  }

  const trickEl = document.getElementById('hearts-status-trick');
  if (trickEl) {
    trickEl.textContent = appState.heartsPhase === 'playing' || appState.heartsPhase === 'trick_complete'
      ? ('Trick ' + appState.heartsTrickNumber + ' of 13')
      : '';
  }

  const scoreEl = document.getElementById('hearts-status-score');
  if (scoreEl && appState.currentTable && Array.isArray(appState.currentTable.players)) {
    const parts = appState.currentTable.players.map(function (player) {
      const label = player.id === socket.id ? 'You' : player.name;
      return label + ': ' + (typeof player.score === 'number' ? player.score : 0);
    });
    scoreEl.textContent = 'Scores - ' + parts.join(', ');
  }
}

function getHeartsOwnPlayer() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return null;
  }
  return appState.currentTable.players.find(function (player) { return player.id === socket.id; }) || null;
}

// --- Trick area ------------------------------------------------------------

function renderHeartsTrick() {
  const area = document.getElementById('hearts-trick-area');
  const list = document.getElementById('hearts-trick-list');
  if (!list) {
    return;
  }

  // The trick area only makes sense once a hand is actually underway (it has
  // nothing to show during passing, or before the first hand is dealt) - see
  // the module header/CLAUDE.md accessibility notes: this is purely a sighted
  // convenience panel, so it never affects the ARIA-live announcements below
  // or the blind-player experience (announceHeartsTrick/heartsTrickResult
  // already narrate the same information regardless of this panel's
  // visibility).
  const showArea = appState.heartsPhase === 'playing' || appState.heartsPhase === 'trick_complete';
  if (area) {
    area.classList.toggle('hidden', !showArea);
  }
  if (!showArea) {
    return;
  }

  list.innerHTML = '';
  const trick = appState.heartsTrick.length ? appState.heartsTrick : (appState.heartsLastTrick ? appState.heartsLastTrick.cards : []);
  const isPastTrick = !appState.heartsTrick.length && appState.heartsLastTrick;

  if (!trick.length) {
    const li = document.createElement('li');
    li.textContent = 'No cards played yet.';
    list.appendChild(li);
    return;
  }

  trick.forEach(function (entry) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = heartsCardImageSrc(entry.card);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    li.appendChild(img);
    const label = document.createElement('span');
    label.textContent = entry.playerName + ': ' + heartsCardName(entry.card);
    li.appendChild(label);
    list.appendChild(li);
  });

  if (isPastTrick && appState.heartsLastTrick.winnerName) {
    const winnerLi = document.createElement('li');
    winnerLi.className = 'hearts-trick-winner';
    winnerLi.textContent = appState.heartsLastTrick.winnerName + ' won this trick.';
    list.appendChild(winnerLi);
  }
}

// --- Card button helpers ----------------------------------------------------

function heartsFocusFirstEnabledButton(container) {
  if (!container) {
    return;
  }
  const button = container.querySelector('button[tabindex="0"]') || container.querySelector('button');
  if (button && typeof button.focus === 'function') {
    button.focus();
  }
}

// Roving tabindex across a row of card buttons: Left/Right Arrow move focus
// one card at a time, Home/End jump to the ends. Space activation is native
// <button> behavior, so it is not re-implemented here. Enter is native
// activation too, *unless* the caller supplies onEnter (used by the passing
// hand so Enter submits the pass instead of toggling the focused card's
// selection - see renderHeartsPassingHand()).
//
// When the caller supplies getGroupKey (the hand is sorted into contiguous
// suit runs by the server's sortHand - see games/hearts/rules.js), Up/Down
// Arrow instead jump between suits: Up moves to the lowest card of the next
// suit run, Down moves to the highest card of the previous suit run (both
// wrap around the ends of the hand). Without getGroupKey, Up/Down fall back
// to behaving exactly like Left/Right, unchanged from before.
//
// Bound once per container and guarded by a dataset flag rather than
// re-bound on every render, since the container element itself persists
// across hand rebuilds (only its button children are replaced) - rebinding
// on every rebuild would silently stack up duplicate listeners.
function heartsBindCardGridKeys(container, options) {
  if (container.dataset.heartsKeysBound) {
    return;
  }
  container.dataset.heartsKeysBound = 'true';

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

// Rebuilds a card-button grid in place. If a button inside the container
// currently has focus, focus is restored to the same position afterward
// (clamped to the new button count) so replaying/passing a card doesn't
// silently drop keyboard focus out of the hand - see the module header and
// CLAUDE.md's Hearts accessibility notes. When focus was NOT already inside
// the container, focus is left untouched (no forced focus on every render).
function heartsRebuildCardButtons(container, cards, buildButton) {
  const hadFocus = container.contains(document.activeElement);
  const previousButtons = Array.prototype.slice.call(container.querySelectorAll('button'));
  const focusedIndex = hadFocus ? previousButtons.indexOf(document.activeElement) : -1;

  container.innerHTML = '';
  cards.forEach(function (card, index) {
    container.appendChild(buildButton(card, index));
  });

  const buttons = container.querySelectorAll('button');
  if (hadFocus && buttons.length) {
    const restoreIndex = focusedIndex >= 0 ? Math.min(focusedIndex, buttons.length - 1) : 0;
    Array.prototype.forEach.call(buttons, function (button, index) { button.tabIndex = index === restoreIndex ? 0 : -1; });
    buttons[restoreIndex].focus();
  }
}

// --- Passing UI --------------------------------------------------------------

function heartsPassAriaLabel(card) {
  const selectedIndex = appState.heartsSelectedPass.indexOf(card);
  if (selectedIndex === -1) {
    return heartsCardName(card) + ', not selected';
  }
  return heartsCardName(card) + ', selected for passing, ' + appState.heartsSelectedPass.length + ' of 3 selected';
}

function heartsUpdatePassButton(button, card) {
  const selected = appState.heartsSelectedPass.indexOf(card) !== -1;
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-label', heartsPassAriaLabel(card));
}

function renderHeartsPassingHand() {
  const area = document.getElementById('hearts-passing-area');
  const container = document.getElementById('hearts-passing-hand');
  const passBtn = document.getElementById('hearts-pass-btn');
  if (!area || !container) {
    return;
  }

  const active = appState.heartsPhase === 'passing' && !heartsAlreadyPassed();
  area.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  heartsBindCardGridKeys(container, {
    onEnter: heartsSubmitPass,
    getGroupKey: function (button) { return heartsCardSuit(button.dataset.card); }
  });

  const handKey = appState.heartsHand.join(',');
  if (appState.heartsPassButtonsHandKey !== handKey) {
    heartsRebuildCardButtons(container, appState.heartsHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = heartsCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      heartsUpdatePassButton(button, card);
      bindPressNoFocus(button, function () { heartsTogglePassCard(card, button); });
      return button;
    });
    appState.heartsPassButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      heartsUpdatePassButton(button, button.dataset.card);
    });
  }

  if (passBtn) {
    passBtn.disabled = appState.heartsSelectedPass.length !== 3;
  }
}

function heartsAlreadyPassed() {
  return !!(appState.currentTable && appState.currentTable.hearts && appState.currentTable.hearts.awaitingYourPass === false && appState.heartsPhase === 'passing');
}

function heartsTogglePassCard(card, button) {
  const index = appState.heartsSelectedPass.indexOf(card);
  if (index !== -1) {
    appState.heartsSelectedPass.splice(index, 1);
    heartsUpdatePassButton(button, card);
    srSpeak('Card unselected', 'polite', { canInterruptLock: true });
  } else {
    if (appState.heartsSelectedPass.length >= 3) {
      srSpeak('You already selected 3 cards. Unselect one first.', 'assertive', { canInterruptLock: true });
      return;
    }
    appState.heartsSelectedPass.push(card);
    heartsUpdatePassButton(button, card);
    srSpeak('Selected ' + appState.heartsSelectedPass.length + ' of 3 cards', 'polite', { canInterruptLock: true });
  }

  const passBtn = document.getElementById('hearts-pass-btn');
  if (passBtn) {
    passBtn.disabled = appState.heartsSelectedPass.length !== 3;
  }
  renderHeartsStatus();
}

function heartsSubmitPass() {
  if (appState.heartsSelectedPass.length !== 3) {
    srSpeak('Select exactly three cards before passing', 'assertive');
    return;
  }
  socket.emit('heartsSelectPassCards', { cards: appState.heartsSelectedPass.slice() });
}

// --- Play (trick) UI ---------------------------------------------------------

function heartsPlayAriaLabel(card) {
  const receivedSuffix = appState.heartsReceivedCards.indexOf(card) !== -1 ? ', received in the pass' : '';
  const legal = !appState.heartsLegalCards || appState.heartsLegalCards.indexOf(card) !== -1;
  if (legal) {
    return heartsCardName(card) + ', playable' + receivedSuffix;
  }

  if (appState.heartsTrick.length) {
    const ledSuit = heartsCardSuit(appState.heartsTrick[0].card);
    return heartsCardName(card) + ', unavailable, must follow ' + heartsSuitFullName(ledSuit) + receivedSuffix;
  }
  return heartsCardName(card) + ', unavailable right now' + receivedSuffix;
}

function heartsUpdatePlayButton(button, card) {
  // 'trick_complete' counts as "my turn" for the trick winner here too - see
  // the heartsTrickResult handler below, which sets heartsTurnPlayerId to the
  // winner as soon as the trick result arrives (the winner is always who
  // leads next), so this label doesn't lag behind and briefly mislabel the
  // winner's own cards while the ack round-trip is in flight.
  const isMyTurn = appState.heartsTurnPlayerId === socket.id
    && (appState.heartsPhase === 'playing' || appState.heartsPhase === 'trick_complete');
  const legal = isMyTurn && (!appState.heartsLegalCards || appState.heartsLegalCards.indexOf(card) !== -1);
  button.setAttribute('aria-disabled', legal ? 'false' : 'true');
  button.classList.toggle('illegal', !legal);
  const received = appState.heartsReceivedCards.indexOf(card) !== -1;
  button.classList.toggle('received', received);
  const receivedSuffix = received ? ', received in the pass' : '';
  // Browsing your hand is not an attempt to play a card, so this label never
  // says "not your turn" - that announcement only belongs to the actual
  // heartsPlayResult rejection below, which fires when Enter/click is
  // pressed on a card while it isn't your turn.
  button.setAttribute('aria-label', isMyTurn ? heartsPlayAriaLabel(card) : (heartsCardName(card) + receivedSuffix));
}

function renderHeartsHand() {
  const area = document.getElementById('hearts-hand-area');
  const container = document.getElementById('hearts-hand');
  if (!area || !container) {
    return;
  }

  const showPlainHand = !(appState.heartsPhase === 'passing' && !heartsAlreadyPassed());
  area.classList.toggle('hidden', !showPlainHand);
  if (!showPlainHand) {
    return;
  }

  heartsBindCardGridKeys(container, {
    getGroupKey: function (button) { return heartsCardSuit(button.dataset.card); }
  });

  const handKey = appState.heartsHand.join(',');
  if (appState.heartsHandButtonsHandKey !== handKey) {
    heartsRebuildCardButtons(container, appState.heartsHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = heartsCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      heartsUpdatePlayButton(button, card);
      bindPressNoFocus(button, function () { heartsAttemptPlay(card); });
      return button;
    });
    appState.heartsHandButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      heartsUpdatePlayButton(button, button.dataset.card);
    });
  }
}

function heartsAttemptPlay(card) {
  // Card play is server-authoritative (see the module header comment in
  // games/hearts/index.js), so every attempt is forwarded to the server
  // rather than pre-validated here. A local "not your turn" pre-check used
  // to live here, but appState.heartsPhase/heartsTurnPlayerId can briefly lag
  // the server's real state across two different event handoffs - right
  // after a player wins a trick and leads the next one (heartsTrickResult
  // sets phase to 'trick_complete' before the follow-up heartsTurnState
  // supplies 'playing' + the fresh turnPlayerId) and right after passing
  // resolves (heartsHand flips phase to 'playing' before heartsTurnState
  // supplies turnPlayerId for the 2-of-Clubs leader). A fast keypress in
  // either gap read as a false "It is not your turn" even though the play
  // was actually correct. The server's heartsPlayResult response is always
  // fresh, so it is now the sole source of that announcement (and of the
  // specific illegal-card rejection reasons, e.g. "You must follow Clubs.").
  socket.emit('heartsPlayCard', { card: card });
}

// --- Top-level render --------------------------------------------------------

// Re-renders the hand/trick/status widgets from whatever is already in
// appState.hearts* - used by the dedicated socket handlers below, which have
// each just set those fields directly from their own (freshest-available)
// event payload. Does NOT touch appState.currentTable.hearts, unlike
// renderHeartsPanel() below.
function renderHeartsWidgets() {
  renderHeartsStatus();
  renderHeartsTrick();
  renderHeartsPassingHand();
  renderHeartsHand();
}

// Full re-render used by the generic render() in main.js (e.g. on a fresh
// 'tableState', or when closing an overlay): resyncs appState.hearts* from
// the current table snapshot first. Deliberately NOT used by the
// hearts-specific socket handlers below - appState.currentTable.hearts can
// still reflect a stale pre-event snapshot at the moment one of those
// handlers runs (a 'tableState' broadcast for the same change may not have
// arrived yet), so resyncing from it there would clobber the fresher fields
// the handler just set from its own payload (e.g. a just-completed trick
// briefly reverting back to mid-trick state - see heartsTrickResult below).
function renderHeartsPanel() {
  if (!appState.currentTable || appState.currentTable.gameType !== 'hearts') {
    return;
  }

  const hearts = appState.currentTable.hearts;
  if (hearts) {
    appState.heartsHandNumber = hearts.handNumber;
    appState.heartsDirection = hearts.direction;
    appState.heartsPhase = hearts.phase;
    appState.heartsTrickNumber = hearts.trickNumber;
    heartsApplyHeartsBroken(hearts.heartsBroken);
    appState.heartsTrick = hearts.trick || [];
    appState.heartsLastTrick = hearts.lastTrick || null;
    appState.heartsTurnPlayerId = hearts.turnPlayerId;
    appState.heartsTurnPlayerName = hearts.turnPlayerName;
  }

  renderHeartsWidgets();
}

// --- Keyboard shortcuts --------------------------------------------------------

function announceHeartsHand() {
  if (!appState.heartsHand.length) {
    srSpeak('Your hand is empty', 'polite', { canInterruptLock: true });
    return;
  }
  const text = appState.heartsHand.map(heartsCardName).join(', ');
  srSpeak('Your hand: ' + text, 'polite', { canInterruptLock: true });
}

function announceHeartsTurnStatus() {
  const parts = [];
  if (appState.heartsHandNumber) {
    parts.push('Hand ' + appState.heartsHandNumber);
  }
  if (appState.heartsPhase === 'passing') {
    parts.push('passing ' + (appState.heartsDirection || 'left'));
  } else {
    parts.push('trick ' + appState.heartsTrickNumber + ' of 13');
    parts.push('Hearts are ' + (appState.heartsHeartsBroken ? 'broken' : 'not broken'));
  }
  if (appState.heartsTurnPlayerId) {
    parts.push(appState.heartsTurnPlayerId === socket.id ? 'your turn' : ((appState.heartsTurnPlayerName || 'another player') + "'s turn"));
  }
  srSpeak(parts.join('. '), 'assertive', { canInterruptLock: true });
}

function announceHeartsTrick() {
  const trick = appState.heartsTrick.length ? appState.heartsTrick : (appState.heartsLastTrick ? appState.heartsLastTrick.cards : []);
  if (!trick.length) {
    srSpeak('No cards played yet this trick', 'polite', { canInterruptLock: true });
    return;
  }
  const text = trick.map(function (entry) { return entry.playerName + ' played ' + heartsCardName(entry.card); }).join('. ');
  srSpeak(text, 'polite', { canInterruptLock: true });
}

function announceHeartsOwnScore() {
  const player = getHeartsOwnPlayer();
  const score = player && typeof player.score === 'number' ? player.score : 0;
  srSpeak('Your score is ' + score, 'assertive', { canInterruptLock: true });
}

function announceHeartsAllScores() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const sorted = appState.currentTable.players.slice().sort(function (a, b) {
    return (a.score || 0) - (b.score || 0);
  });
  const text = sorted.map(function (player) {
    const label = player.id === socket.id ? 'You' : player.name;
    return label + ': ' + (player.score || 0);
  }).join(', ');
  srSpeak('Scores, lowest to highest: ' + text, 'assertive', { canInterruptLock: true });
}

function handleHeartsKeys(event) {
  if (appState.helpOpen || appState.announcementOpen || appState.rulesOpen || appState.kickOpen) {
    return;
  }

  if (event.key === '?') {
    openHelpOverlay();
    event.preventDefault();
    return;
  }

  const key = event.key.toLowerCase();
  if (key === 'h' && !event.shiftKey) {
    announceHeartsHand();
    event.preventDefault();
  } else if (key === 't') {
    announceHeartsTurnStatus();
    event.preventDefault();
  } else if (key === 'p') {
    announceHeartsTrick();
    event.preventDefault();
  } else if (key === 's' && event.shiftKey) {
    announceHeartsAllScores();
    event.preventDefault();
  } else if (key === 's') {
    announceHeartsOwnScore();
    event.preventDefault();
  }
}

// --- Socket handlers ------------------------------------------------------------

socket.on('heartsHand', function (payload) {
  if (!payload || !Array.isArray(payload.hand)) {
    return;
  }

  const receivedCards = Array.isArray(payload.receivedCards) ? payload.receivedCards : [];

  appState.heartsHand = payload.hand;
  appState.heartsHandNumber = payload.handNumber;
  appState.heartsDirection = payload.direction;
  appState.heartsPhase = payload.phase;
  appState.heartsSelectedPass = [];
  appState.heartsHandButtonsHandKey = null;
  appState.heartsPassButtonsHandKey = null;
  // Cleared by the next heartsHand event with no receivedCards - which
  // naturally happens the moment this player plays their own first card
  // (see the per-play heartsHand emit in games/hearts/index.js), so the
  // "you just received these" highlight fades out once play is underway.
  appState.heartsReceivedCards = receivedCards;

  // For a hold hand or the moment passing resolves, this is the first event
  // this client sees for the new hand, arriving with phase already 'playing'
  // - the follow-up heartsTurnState event confirming turnPlayerId lands a
  // moment later. Without consuming payload.turnPlayerId here too, the
  // render below would use the previous hand's/trick's stale turnPlayerId
  // for one frame, showing the 2-of-Clubs leader's own hand as "not your
  // turn" right as focus moves onto it (see sendHands() in
  // games/hearts/index.js for why the server now always includes it).
  if (payload.phase === 'playing' && Object.prototype.hasOwnProperty.call(payload, 'turnPlayerId')) {
    appState.heartsTurnPlayerId = payload.turnPlayerId;
    appState.heartsTurnPlayerName = payload.turnPlayerName;
  }

  renderHeartsWidgets();

  if (payload.phase === 'passing') {
    srSpeak('New hand. Your hand: ' + payload.hand.map(heartsCardName).join(', '), 'polite', { canInterruptLock: true });
  } else if (payload.phase === 'playing') {
    // This event fires both once per hand (right as passing resolves into
    // play, or immediately for a Hold hand) and after every card this player
    // plays - in both cases the hand contents just changed under the
    // player's feet, so re-anchoring focus in the hand matches the "return
    // focus to the game area after game-state transitions" rule.
    if (receivedCards.length) {
      // Passing just resolved - announce exactly what came in for
      // screen-reader users, since the generic 'actionNotice' broadcast
      // ("Cards have been passed.") is the same for every seat and never
      // says which cards a given player received.
      srSpeak('You received ' + receivedCards.map(heartsCardName).join(', ') + '.', 'assertive', { canInterruptLock: true });
    }
    window.requestAnimationFrame(function () {
      heartsFocusFirstEnabledButton(document.getElementById('hearts-hand'));
    });
  }
});

socket.on('heartsPassPrompt', function (payload) {
  if (!payload) {
    return;
  }
  appState.heartsPhase = 'passing';
  appState.heartsDirection = payload.direction;
  renderHeartsWidgets();

  const message = payload.direction === 'hold'
    ? 'Hold hand. No cards will be passed.'
    : 'Pass three cards to the ' + payload.direction + '.';
  srSpeak(message, 'assertive', { canInterruptLock: true });

  window.requestAnimationFrame(function () {
    heartsFocusFirstEnabledButton(document.getElementById('hearts-passing-hand'));
  });
});

socket.on('heartsPassResult', function (payload) {
  if (!payload) {
    return;
  }
  srSpeak(payload.message || (payload.success ? 'Pass submitted' : 'Pass failed'), payload.success ? 'polite' : 'assertive', { canInterruptLock: true });
  if (payload.success) {
    renderHeartsWidgets();
  }
});

socket.on('heartsTurnState', function (payload) {
  if (!payload) {
    return;
  }

  appState.heartsPhase = 'playing';
  appState.heartsTrickNumber = payload.trickNumber;
  heartsApplyHeartsBroken(payload.heartsBroken);
  appState.heartsTrick = payload.trick || [];
  appState.heartsTurnPlayerId = payload.turnPlayerId;
  appState.heartsTurnPlayerName = payload.turnPlayerName;
  if (Object.prototype.hasOwnProperty.call(payload, 'legalCards')) {
    appState.heartsLegalCards = payload.legalCards;
  } else if (payload.turnPlayerId !== socket.id) {
    appState.heartsLegalCards = null;
  }

  renderHeartsWidgets();

  // The server already composed the single combined announcement this seat
  // needs for this event (who just played plus "Your turn", or the 2C-leader
  // "You start", or nothing at all when another player merely has the turn -
  // see buildTurnMessage() in games/hearts/index.js). No generic "it's X's
  // turn" fallback is spoken here on purpose.
  if (payload.message) {
    let message = payload.message;
    if (payload.startsHand && appState.heartsReceivedCards.length) {
      // When passing has just resolved into this player being the 2C leader,
      // this event lands right behind the heartsHand event that scheduled
      // the "You received ..." announcement, and srSpeak's single
      // ARIA-live-region slot means whichever call runs last wins - so fold
      // the received-cards text in here rather than losing it.
      message = 'You received ' + appState.heartsReceivedCards.map(heartsCardName).join(', ') + '. ' + message;
    }
    srSpeak(message, 'assertive', { canInterruptLock: true, lockMs: 900 });
  }
});

socket.on('heartsPlayResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Play rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
    return;
  }
  // The player already knows which card they just selected and played, so a
  // successful own play is never restated back to them - only genuinely new
  // state (e.g. Hearts breaking) is spoken, and only when the server didn't
  // leave it out because it's about to be folded into the more
  // decision-relevant heartsTrickResult announcement instead (see
  // performPlayCard() in games/hearts/index.js).
  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true });
  }
});

socket.on('heartsTrickResult', function (payload) {
  if (!payload) {
    return;
  }

  appState.heartsTrick = [];
  appState.heartsLastTrick = { cards: payload.trick, winnerId: payload.winnerId, winnerName: payload.winnerName };
  appState.heartsPhase = 'trick_complete';
  // The trick winner always leads the next trick, so this is already known -
  // set it now rather than waiting for the follow-up heartsTurnState event,
  // so the hand's turn/aria-label state (and heartsAttemptPlay, for a fast
  // keypress) is correct immediately instead of briefly showing the previous
  // trick's last actor as still "on turn".
  appState.heartsTurnPlayerId = payload.winnerId;
  appState.heartsTurnPlayerName = payload.winnerName;
  // The just-finished trick's legal-card set (e.g. "must follow Diamonds")
  // no longer applies to the brand-new trick that's about to start - without
  // clearing it here, the winner's hand would render with stale
  // aria-disabled/aria-label state (falsely marking their own playable cards
  // "unavailable") for the gap between this event and the follow-up
  // heartsTurnState, which is the one that supplies the real legal plays for
  // an opening lead. heartsPlayAriaLabel()/heartsUpdatePlayButton() both
  // treat a null heartsLegalCards as "nothing ruled out yet" (see the
  // heartsTurnState handler's own else-branch, which nulls it the same way
  // for a seat that just lost the turn).
  appState.heartsLegalCards = null;
  renderHeartsWidgets();

  // One combined, per-recipient announcement: what the last card played was
  // (skipped for the player who just played it - they already know), whether
  // Hearts just broke, and the trick outcome. The winner leads the next
  // trick, so "Your lead" tells them what to do next - except on the hand's
  // final trick, where there is no next lead to promise (see isFinalTrick in
  // performPlayCard()). Points are deliberately left out, per the Hearts
  // screen-reader announcement spec's minimal-example wording - they're
  // available on demand via the score shortcuts.
  const isWinner = payload.winnerId === socket.id;
  const isLastPlayer = payload.lastPlayerId === socket.id;
  const lastPlayerWon = payload.lastPlayerId === payload.winnerId;
  const breakClause = payload.justBroke ? 'Hearts are now broken. ' : '';
  const outcomeClause = isWinner
    ? (payload.isFinalTrick ? 'You take the trick.' : 'You take the trick. Your lead.')
    : (payload.winnerName + ' takes the trick.');

  let message;
  if (!isWinner && !isLastPlayer && lastPlayerWon && !payload.justBroke) {
    // The same (other) player both played the last card and won the trick -
    // say it as one sentence ("Nina plays the Eight of Diamonds and takes
    // the trick.") instead of naming them twice back to back. Skipped when
    // Hearts also just broke on that card, so the break clause can sit
    // between two clean sentences rather than splitting this one in half.
    message = payload.lastPlayerName + ' plays ' + heartsCardName(payload.lastCard) + ' and takes the trick.';
  } else {
    const playClause = (payload.lastPlayerName && !isLastPlayer)
      ? (payload.lastPlayerName + ' plays ' + heartsCardName(payload.lastCard) + '. ')
      : '';
    message = playClause + breakClause + outcomeClause;
  }

  srSpeak(message, 'assertive', { canInterruptLock: true, lockMs: 1200 });

  // The trick has already been rendered and announced above, so the player
  // has had a chance to see/hear it before it clears - no arbitrary timer is
  // needed to "wait" before acknowledging (see games/hearts/index.js's
  // pendingTrickAcks, the same ack-gating concept Lumo uses between rounds).
  socket.emit('heartsAckTrick');
});

socket.on('heartsHandSummary', function (payload) {
  if (!payload) {
    return;
  }

  const lines = payload.scores.map(function (entry) {
    return entry.name + ': ' + entry.handPoints + ' points this hand, ' + entry.totalPoints + ' total.';
  });

  let message = lines.join(' ');
  if (payload.shotTheMoon) {
    message = payload.shotTheMoon + ' shot the moon! ' + payload.shotTheMoon + ' receives 0 points, everyone else receives 26. ' + message;
  }
  if (!payload.gameOver && payload.nextDirection) {
    message += ' Next hand: ' + (payload.nextDirection === 'hold' ? 'Hold. No cards will be passed.' : ('pass ' + payload.nextDirection + '.'));
  }

  setRoundResult('Hand ' + payload.handNumber + ' complete. ' + message);

  if (!payload.gameOver) {
    showAnnouncementOverlay({
      eyebrow: 'Hand ' + payload.handNumber + ' complete',
      title: payload.shotTheMoon ? (payload.shotTheMoon + ' shot the moon!') : 'Hand complete',
      message: message,
      tone: payload.shotTheMoon ? 'winner' : 'info',
      sticky: true,
      kind: 'heartsHandSummary'
    });
  }

  srSpeak('Hand ' + payload.handNumber + ' complete. ' + message, 'assertive', { canInterruptLock: true, lockMs: 2000 });
});

socket.on('heartsGameOver', function (payload) {
  if (!payload) {
    return;
  }

  const scoreText = payload.scores.map(function (entry) { return entry.name + ': ' + entry.totalPoints; }).join(', ');
  const message = payload.winner + ' wins with ' + (payload.scores.find(function (e) { return e.name === payload.winner; }) || {}).totalPoints + ' points. Final scores: ' + scoreText;

  setRoundResult('Game over. ' + message);
  showAnnouncementOverlay({
    eyebrow: 'Game Over',
    title: payload.winner + ' wins the game',
    message: message,
    tone: 'winner',
    sticky: true,
    duration: 4000,
    kind: 'heartsGameOver'
  });
  srSpeak('Game over. ' + message, 'assertive', { canInterruptLock: true, lockMs: 3000 });
});

// --- Wiring -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  const passBtn = document.getElementById('hearts-pass-btn');
  if (passBtn) {
    bindPress(passBtn, heartsSubmitPass);
  }

  const heartsPanel = document.getElementById('hearts-panel');
  if (heartsPanel) {
    heartsPanel.addEventListener('keydown', handleHeartsKeys);
  }
});

// Scripts run after the DOM has parsed (they are placed at the end of
// <body>), so bind immediately too in case DOMContentLoaded already fired.
if (document.readyState !== 'loading') {
  const passBtnNow = document.getElementById('hearts-pass-btn');
  if (passBtnNow && !passBtnNow.dataset.heartsBound) {
    passBtnNow.dataset.heartsBound = 'true';
    bindPress(passBtnNow, heartsSubmitPass);
  }
  const heartsPanelNow = document.getElementById('hearts-panel');
  if (heartsPanelNow && !heartsPanelNow.dataset.heartsBound) {
    heartsPanelNow.dataset.heartsBound = 'true';
    heartsPanelNow.addEventListener('keydown', handleHeartsKeys);
  }
}
