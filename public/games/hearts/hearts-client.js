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
  heartsPassButtonsHandKey: null
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
        ? 'Waiting for other players to pass'
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
  const list = document.getElementById('hearts-trick-list');
  if (!list) {
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

// Roving tabindex across a row of card buttons: Arrow keys move focus,
// Home/End jump to the ends. Enter/Space activation is native <button>
// behavior, so it is not re-implemented here.
function heartsBindCardGridKeys(container) {
  container.addEventListener('keydown', function (event) {
    const buttons = Array.prototype.slice.call(container.querySelectorAll('button'));
    if (!buttons.length) {
      return;
    }
    const currentIndex = buttons.indexOf(document.activeElement);
    let nextIndex = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
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

  const handKey = appState.heartsHand.join(',');
  if (appState.heartsPassButtonsHandKey !== handKey) {
    container.innerHTML = '';
    appState.heartsHand.forEach(function (card, index) {
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
      container.appendChild(button);
    });
    heartsBindCardGridKeys(container);
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
  const legal = !appState.heartsLegalCards || appState.heartsLegalCards.indexOf(card) !== -1;
  if (legal) {
    return heartsCardName(card) + ', playable';
  }

  if (appState.heartsTrick.length) {
    const ledSuit = heartsCardSuit(appState.heartsTrick[0].card);
    return heartsCardName(card) + ', unavailable, must follow ' + heartsSuitFullName(ledSuit);
  }
  return heartsCardName(card) + ', unavailable right now';
}

function heartsUpdatePlayButton(button, card) {
  const isMyTurn = appState.heartsTurnPlayerId === socket.id && appState.heartsPhase === 'playing';
  const legal = isMyTurn && (!appState.heartsLegalCards || appState.heartsLegalCards.indexOf(card) !== -1);
  button.setAttribute('aria-disabled', legal ? 'false' : 'true');
  button.classList.toggle('illegal', !legal);
  button.setAttribute('aria-label', isMyTurn ? heartsPlayAriaLabel(card) : (heartsCardName(card) + ', not your turn'));
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

  const handKey = appState.heartsHand.join(',');
  if (appState.heartsHandButtonsHandKey !== handKey) {
    container.innerHTML = '';
    appState.heartsHand.forEach(function (card, index) {
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
      container.appendChild(button);
    });
    heartsBindCardGridKeys(container);
    appState.heartsHandButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      heartsUpdatePlayButton(button, button.dataset.card);
    });
  }
}

function heartsAttemptPlay(card) {
  if (appState.heartsPhase !== 'playing' || appState.heartsTurnPlayerId !== socket.id) {
    srSpeak('It is not your turn', 'assertive', { canInterruptLock: true });
    return;
  }

  if (appState.heartsLegalCards && appState.heartsLegalCards.indexOf(card) === -1) {
    srSpeak(heartsCardName(card) + ' is not a legal play right now', 'assertive', { canInterruptLock: true });
    return;
  }

  socket.emit('heartsPlayCard', { card: card });
}

// --- Top-level render --------------------------------------------------------

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
    appState.heartsHeartsBroken = hearts.heartsBroken;
    appState.heartsTrick = hearts.trick || [];
    appState.heartsLastTrick = hearts.lastTrick || null;
    appState.heartsTurnPlayerId = hearts.turnPlayerId;
    appState.heartsTurnPlayerName = hearts.turnPlayerName;
  }

  renderHeartsStatus();
  renderHeartsTrick();
  renderHeartsPassingHand();
  renderHeartsHand();
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

  appState.heartsHand = payload.hand;
  appState.heartsHandNumber = payload.handNumber;
  appState.heartsDirection = payload.direction;
  appState.heartsPhase = payload.phase;
  appState.heartsSelectedPass = [];
  appState.heartsHandButtonsHandKey = null;
  appState.heartsPassButtonsHandKey = null;

  renderHeartsPanel();

  if (payload.phase === 'passing') {
    srSpeak('New hand. Your hand: ' + payload.hand.map(heartsCardName).join(', '), 'polite', { canInterruptLock: true });
  }
});

socket.on('heartsPassPrompt', function (payload) {
  if (!payload) {
    return;
  }
  appState.heartsPhase = 'passing';
  appState.heartsDirection = payload.direction;
  renderHeartsPanel();

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
    renderHeartsPanel();
  }
});

socket.on('heartsTurnState', function (payload) {
  if (!payload) {
    return;
  }

  const becameMyTurn = payload.turnPlayerId === socket.id && appState.heartsTurnPlayerId !== socket.id;

  appState.heartsPhase = 'playing';
  appState.heartsTrickNumber = payload.trickNumber;
  appState.heartsHeartsBroken = payload.heartsBroken;
  appState.heartsTrick = payload.trick || [];
  appState.heartsTurnPlayerId = payload.turnPlayerId;
  appState.heartsTurnPlayerName = payload.turnPlayerName;
  if (Object.prototype.hasOwnProperty.call(payload, 'legalCards')) {
    appState.heartsLegalCards = payload.legalCards;
  } else if (payload.turnPlayerId !== socket.id) {
    appState.heartsLegalCards = null;
  }

  renderHeartsPanel();

  if (becameMyTurn) {
    srSpeak('Your turn.', 'assertive', { canInterruptLock: true, lockMs: 900 });
  }
});

socket.on('heartsPlayResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Play rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
  }
});

socket.on('heartsTrickResult', function (payload) {
  if (!payload) {
    return;
  }

  appState.heartsTrick = [];
  appState.heartsLastTrick = { cards: payload.trick, winnerId: payload.winnerId, winnerName: payload.winnerName };
  appState.heartsPhase = 'trick_complete';
  renderHeartsPanel();

  const pointsText = payload.points > 0 ? (' ' + payload.winnerName + ' takes ' + payload.points + (payload.points === 1 ? ' point.' : ' points.')) : '';
  srSpeak('Trick complete. ' + payload.winnerName + ' wins the trick.' + pointsText, 'assertive', { canInterruptLock: true, lockMs: 1200 });

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
