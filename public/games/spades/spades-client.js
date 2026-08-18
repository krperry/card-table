// Spades client module: bidding/hand/trick UI (native buttons, not canvas -
// same reasoning as hearts-client.js), keyboard shortcuts, and all
// Spades-specific socket.io event handlers. Loaded via a plain <script> tag
// after main.js and hearts-client.js (see public/index.html) so it shares
// main.js's global scope and can reference appState/el/socket/srSpeak
// directly, the same way hearts-client.js does.
//
// The one genuinely new UI concept versus Hearts: Spades is a fixed
// partnership game, so every status render also surfaces "who is my
// partner" and per-team (not per-player) bids/tricks/bags/scores.

const SPADES_CARD_IMAGE_BASE = 'images/playing-cards/';
const SPADES_RANK_NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const SPADES_SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

Object.assign(appState, {
  spadesHand: [],
  spadesPhase: null,
  spadesHandNumber: 0,
  spadesDealerIndex: null,
  spadesLeaderIndex: null,
  spadesBids: [null, null, null, null],
  spadesLegalBids: null,
  spadesLegalCards: null,
  spadesTurnPlayerId: null,
  spadesTurnPlayerName: '',
  spadesTrick: [],
  spadesLastTrick: null,
  spadesSpadesBroken: false,
  spadesTrickNumber: 1,
  spadesTeams: null,
  spadesBags: [0, 0],
  spadesHandButtonsHandKey: null,
  spadesBidButtonsKey: null
});

function spadesCardRank(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function spadesCardSuit(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function spadesCardName(card) {
  const rank = SPADES_RANK_NAMES[spadesCardRank(card)];
  const suit = SPADES_SUIT_NAMES[spadesCardSuit(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

function spadesCardImageSrc(card) {
  return SPADES_CARD_IMAGE_BASE + card + '.svg';
}

function spadesSuitFullName(suitChar) {
  return SPADES_SUIT_NAMES[suitChar] || '';
}

function spadesBidLabel(bid) {
  return bid === 0 ? 'Nil' : String(bid);
}

// --- Seat/partnership helpers ------------------------------------------------

function getSpadesOwnSeatIndex() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return -1;
  }
  return appState.currentTable.players.findIndex(function (player) { return player.id === socket.id; });
}

function getSpadesTeamIndexForSeat(seatIndex) {
  return seatIndex % 2;
}

function getSpadesPartnerName() {
  const seatIndex = getSpadesOwnSeatIndex();
  if (seatIndex < 0 || !appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return '';
  }
  const partnerIndex = (seatIndex + 2) % 4;
  const partner = appState.currentTable.players[partnerIndex];
  return partner ? partner.name : '';
}

function getSpadesTeamPlayerNames(teamIndex) {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return [];
  }
  return appState.currentTable.players.filter(function (player, index) {
    return getSpadesTeamIndexForSeat(index) === teamIndex;
  }).map(function (player) { return player.name; });
}

// --- Status region -------------------------------------------------------

function renderSpadesStatus() {
  const handEl = document.getElementById('spades-status-hand');
  if (!handEl) {
    return;
  }

  handEl.textContent = appState.spadesHandNumber ? ('Hand ' + appState.spadesHandNumber) : '';

  const teamEl = document.getElementById('spades-status-team');
  if (teamEl) {
    const seatIndex = getSpadesOwnSeatIndex();
    if (seatIndex >= 0) {
      const teamIndex = getSpadesTeamIndexForSeat(seatIndex);
      const teamLabel = teamIndex === 0 ? 'Team A' : 'Team B';
      teamEl.textContent = 'Your team: ' + teamLabel + ' (' + getSpadesTeamPlayerNames(teamIndex).join(' & ') + ')';
      teamEl.classList.toggle('spades-team-a-text', teamIndex === 0);
      teamEl.classList.toggle('spades-team-b-text', teamIndex === 1);
    } else {
      teamEl.textContent = '';
      teamEl.classList.remove('spades-team-a-text', 'spades-team-b-text');
    }
  }

  const partnerEl = document.getElementById('spades-status-partner');
  if (partnerEl) {
    const partnerName = getSpadesPartnerName();
    partnerEl.textContent = partnerName ? ('Your partner: ' + partnerName) : '';
  }

  const turnEl = document.getElementById('spades-status-turn');
  if (turnEl) {
    if (appState.spadesTurnPlayerId) {
      const verb = appState.spadesPhase === 'bidding' ? "'s turn to bid" : "'s turn";
      turnEl.textContent = appState.spadesTurnPlayerId === socket.id
        ? ('Your turn' + (appState.spadesPhase === 'bidding' ? ' to bid' : ''))
        : ((appState.spadesTurnPlayerName || 'Another player') + verb);
    } else {
      turnEl.textContent = '';
    }
  }

  const bidsEl = document.getElementById('spades-status-bids');
  if (bidsEl && appState.currentTable && Array.isArray(appState.currentTable.players)) {
    const parts = appState.currentTable.players.map(function (player, index) {
      const bid = appState.spadesBids[index];
      const label = player.id === socket.id ? 'You' : player.name;
      return label + ': ' + (bid === null || bid === undefined ? 'not yet' : spadesBidLabel(bid));
    });
    bidsEl.textContent = appState.spadesPhase === 'waiting' ? '' : ('Bids - ' + parts.join(', '));
  }

  const brokenEl = document.getElementById('spades-status-broken');
  if (brokenEl) {
    brokenEl.textContent = appState.spadesPhase === 'playing' || appState.spadesPhase === 'trick_complete'
      ? ('Spades: ' + (appState.spadesSpadesBroken ? 'broken' : 'not broken'))
      : '';
  }

  const trickEl = document.getElementById('spades-status-trick');
  if (trickEl) {
    trickEl.textContent = appState.spadesPhase === 'playing' || appState.spadesPhase === 'trick_complete'
      ? ('Trick ' + appState.spadesTrickNumber + ' of 13')
      : '';
  }

  const bagsEl = document.getElementById('spades-status-bags');
  if (bagsEl) {
    bagsEl.textContent = Array.isArray(appState.spadesBags) && appState.spadesPhase && appState.spadesPhase !== 'waiting'
      ? ('Bags - Team A: ' + (appState.spadesBags[0] || 0) + ', Team B: ' + (appState.spadesBags[1] || 0))
      : '';
  }

  const scoreEl = document.getElementById('spades-status-score');
  if (scoreEl && appState.currentTable && Array.isArray(appState.currentTable.players)) {
    const teamAScore = appState.currentTable.players[0] ? (appState.currentTable.players[0].score || 0) : 0;
    const teamBScore = appState.currentTable.players[1] ? (appState.currentTable.players[1].score || 0) : 0;
    const teamAText = 'Team A (' + getSpadesTeamPlayerNames(0).join(' & ') + '): ' + teamAScore;
    const teamBText = 'Team B (' + getSpadesTeamPlayerNames(1).join(' & ') + '): ' + teamBScore;
    scoreEl.textContent = 'Scores - ' + teamAText + ' | ' + teamBText;
  }
}

function getSpadesOwnPlayer() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return null;
  }
  return appState.currentTable.players.find(function (player) { return player.id === socket.id; }) || null;
}

// --- Trick area ------------------------------------------------------------

function renderSpadesTrick() {
  const area = document.getElementById('spades-trick-area');
  const list = document.getElementById('spades-trick-list');
  if (!list) {
    return;
  }

  const showArea = appState.spadesPhase === 'playing' || appState.spadesPhase === 'trick_complete';
  if (area) {
    area.classList.toggle('hidden', !showArea);
  }
  if (!showArea) {
    return;
  }

  list.innerHTML = '';
  const trick = appState.spadesTrick.length ? appState.spadesTrick : (appState.spadesLastTrick ? appState.spadesLastTrick.cards : []);
  const isPastTrick = !appState.spadesTrick.length && appState.spadesLastTrick;

  if (!trick.length) {
    const li = document.createElement('li');
    li.textContent = 'No cards played yet.';
    list.appendChild(li);
    return;
  }

  trick.forEach(function (entry) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = spadesCardImageSrc(entry.card);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    li.appendChild(img);
    const label = document.createElement('span');
    label.textContent = entry.playerName + ': ' + spadesCardName(entry.card);
    li.appendChild(label);
    list.appendChild(li);
  });

  if (isPastTrick && appState.spadesLastTrick.winnerName) {
    const winnerLi = document.createElement('li');
    winnerLi.className = 'spades-trick-winner';
    winnerLi.textContent = appState.spadesLastTrick.winnerName + ' won this trick.';
    list.appendChild(winnerLi);
  }
}

// --- Shared roving-tabindex button-grid machinery ---------------------------
// Copied and renamed from hearts-client.js's hearts* equivalents, following
// the codebase's existing per-game-duplication style (Hearts itself doesn't
// share this with Lumo either).

function spadesFocusFirstEnabledButton(container) {
  if (!container) {
    return;
  }
  const button = container.querySelector('button[tabindex="0"]') || container.querySelector('button');
  if (button && typeof button.focus === 'function') {
    button.focus();
  }
}

// Called from main.js's shared "F" shortcut (see handleFocusCardsKey there) -
// jumps focus straight to whichever card/bid grid is currently "the cards on
// the table" for this player: the bid grid while it's their turn to bid, or
// their play hand otherwise. No-op (silently) if neither is on screen right
// now (e.g. waiting on another player's bid).
function spadesFocusHand() {
  const container = (appState.spadesPhase === 'bidding' && appState.spadesTurnPlayerId === socket.id)
    ? document.getElementById('spades-bid-grid')
    : document.getElementById('spades-hand');
  spadesFocusFirstEnabledButton(container);
}

// When the caller supplies getGroupKey (the hand is sorted into contiguous
// suit runs - see games/spades/rules.js), Up/Down Arrow jump between suits:
// Up moves to the lowest card of the next suit run, Down moves to the
// highest card of the previous suit run (both wrap around the ends of the
// hand). Without getGroupKey (e.g. the bid grid, which has no suits), Up/Down
// fall back to behaving exactly like Left/Right, unchanged from before.
function spadesBindCardGridKeys(container, options) {
  if (container.dataset.spadesKeysBound) {
    return;
  }
  container.dataset.spadesKeysBound = 'true';

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

function spadesRebuildCardButtons(container, items, buildButton) {
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

// --- Bidding UI --------------------------------------------------------------
// A bid is a single pick from a bounded set (Nil, 1-13), unlike Hearts'
// three-card passing selection - so each bid button submits immediately on
// activation (click/Enter/Space) rather than requiring a separate "select
// then submit" step. Arrow/Home/End roving-tabindex navigation still applies
// via spadesBindCardGridKeys().

function renderSpadesBiddingHand() {
  const area = document.getElementById('spades-bidding-area');
  const container = document.getElementById('spades-bid-grid');
  if (!area || !container) {
    return;
  }

  const myTurn = appState.spadesPhase === 'bidding' && appState.spadesTurnPlayerId === socket.id;
  area.classList.toggle('hidden', !myTurn);
  if (!myTurn) {
    appState.spadesBidButtonsKey = null;
    return;
  }

  spadesBindCardGridKeys(container);

  const bids = Array.isArray(appState.spadesLegalBids) ? appState.spadesLegalBids : [];
  const key = bids.join(',');
  if (appState.spadesBidButtonsKey !== key) {
    spadesRebuildCardButtons(container, bids, function (bid, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.bid = String(bid);
      button.tabIndex = index === 0 ? 0 : -1;
      button.textContent = spadesBidLabel(bid);
      button.setAttribute('aria-label', bid === 0 ? 'Bid Nil (zero tricks)' : ('Bid ' + bid));
      bindPressNoFocus(button, function () { spadesSubmitBid(bid); });
      return button;
    });
    appState.spadesBidButtonsKey = key;
  }
}

function spadesSubmitBid(bid) {
  socket.emit('spadesPlaceBid', { bid: bid });
}

// --- Play (trick) UI ---------------------------------------------------------

function spadesPlayAriaLabel(card) {
  const legal = !appState.spadesLegalCards || appState.spadesLegalCards.indexOf(card) !== -1;
  if (legal) {
    return spadesCardName(card) + ', playable';
  }

  if (appState.spadesTrick.length) {
    const ledSuit = spadesCardSuit(appState.spadesTrick[0].card);
    return spadesCardName(card) + ', unavailable, must follow ' + spadesSuitFullName(ledSuit);
  }
  return spadesCardName(card) + ', unavailable right now';
}

function spadesUpdatePlayButton(button, card) {
  const isMyTurn = appState.spadesTurnPlayerId === socket.id
    && (appState.spadesPhase === 'playing' || appState.spadesPhase === 'trick_complete');
  const legal = isMyTurn && (!appState.spadesLegalCards || appState.spadesLegalCards.indexOf(card) !== -1);
  button.setAttribute('aria-disabled', legal ? 'false' : 'true');
  button.classList.toggle('illegal', !legal);
  button.setAttribute('aria-label', isMyTurn ? spadesPlayAriaLabel(card) : spadesCardName(card));
}

function renderSpadesHand() {
  const area = document.getElementById('spades-hand-area');
  const container = document.getElementById('spades-hand');
  if (!area || !container) {
    return;
  }

  const showHand = appState.spadesPhase !== 'waiting' && appState.spadesHand.length > 0;
  area.classList.toggle('hidden', !showHand);
  if (!showHand) {
    return;
  }

  spadesBindCardGridKeys(container, {
    getGroupKey: function (button) { return spadesCardSuit(button.dataset.card); }
  });

  const handKey = appState.spadesHand.join(',');
  if (appState.spadesHandButtonsHandKey !== handKey) {
    spadesRebuildCardButtons(container, appState.spadesHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = spadesCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      spadesUpdatePlayButton(button, card);
      bindPressNoFocus(button, function () { spadesAttemptPlay(card); });
      return button;
    });
    appState.spadesHandButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      spadesUpdatePlayButton(button, button.dataset.card);
    });
  }
}

function spadesAttemptPlay(card) {
  // Card play is server-authoritative (see the module header comment in
  // games/spades/index.js) - no local legality pre-check here, for the same
  // "state can briefly lag across transition windows" reasoning documented in
  // hearts-client.js's heartsAttemptPlay(). The server's spadesPlayResult
  // response is the sole source of the rejection announcement.
  socket.emit('spadesPlayCard', { card: card });
}

// --- Top-level render --------------------------------------------------------

function renderSpadesWidgets() {
  renderSpadesStatus();
  renderSpadesTrick();
  renderSpadesBiddingHand();
  renderSpadesHand();
}

function renderSpadesPanel() {
  if (!appState.currentTable || appState.currentTable.gameType !== 'spades') {
    return;
  }

  const spades = appState.currentTable.spades;
  if (spades) {
    appState.spadesHandNumber = spades.handNumber;
    appState.spadesPhase = spades.phase;
    appState.spadesDealerIndex = spades.dealerIndex;
    appState.spadesLeaderIndex = spades.leaderIndex;
    appState.spadesTrickNumber = spades.trickNumber;
    appState.spadesSpadesBroken = !!spades.spadesBroken;
    appState.spadesTrick = spades.trick || [];
    appState.spadesLastTrick = spades.lastTrick || null;
    appState.spadesTurnPlayerId = spades.turnPlayerId;
    appState.spadesTurnPlayerName = spades.turnPlayerName;
    appState.spadesBids = spades.bids || [null, null, null, null];
    appState.spadesBags = spades.bags || [0, 0];
    appState.spadesTeams = spades.teams || null;
    if (Object.prototype.hasOwnProperty.call(spades, 'legalBids')) {
      appState.spadesLegalBids = spades.legalBids;
    }
    if (Object.prototype.hasOwnProperty.call(spades, 'legalCards')) {
      appState.spadesLegalCards = spades.legalCards;
    }
  }

  renderSpadesWidgets();
}

// --- Keyboard shortcuts --------------------------------------------------------

function announceSpadesHand() {
  if (!appState.spadesHand.length) {
    srSpeak('Your hand is empty', 'polite', { canInterruptLock: true });
    return;
  }
  const text = appState.spadesHand.map(spadesCardName).join(', ');
  srSpeak('Your hand: ' + text, 'polite', { canInterruptLock: true });
}

function announceSpadesTurnStatus() {
  const parts = [];
  if (appState.spadesHandNumber) {
    parts.push('Hand ' + appState.spadesHandNumber);
  }
  if (appState.spadesPhase === 'bidding') {
    parts.push('bidding');
  } else {
    parts.push('trick ' + appState.spadesTrickNumber + ' of 13');
    parts.push('Spades are ' + (appState.spadesSpadesBroken ? 'broken' : 'not broken'));
  }
  if (appState.spadesTurnPlayerId) {
    parts.push(appState.spadesTurnPlayerId === socket.id ? 'your turn' : ((appState.spadesTurnPlayerName || 'another player') + "'s turn"));
  }
  srSpeak(parts.join('. '), 'assertive', { canInterruptLock: true });
}

function announceSpadesTrick() {
  const trick = appState.spadesTrick.length ? appState.spadesTrick : (appState.spadesLastTrick ? appState.spadesLastTrick.cards : []);
  if (!trick.length) {
    srSpeak('No cards played yet this trick', 'polite', { canInterruptLock: true });
    return;
  }
  const text = trick.map(function (entry) { return entry.playerName + ' played ' + spadesCardName(entry.card); }).join('. ');
  srSpeak(text, 'polite', { canInterruptLock: true });
}

function announceSpadesBids() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const text = appState.currentTable.players.map(function (player, index) {
    const label = player.id === socket.id ? 'You' : player.name;
    const bid = appState.spadesBids[index];
    return label + ' bid ' + (bid === null || bid === undefined ? 'not yet placed' : spadesBidLabel(bid));
  }).join(', ');
  srSpeak(text, 'assertive', { canInterruptLock: true });
}

function announceSpadesPartner() {
  const partnerName = getSpadesPartnerName();
  srSpeak(partnerName ? ('Your partner is ' + partnerName) : 'Your partner is not known yet', 'assertive', { canInterruptLock: true });
}

function announceSpadesTrickCount() {
  const seatIndex = getSpadesOwnSeatIndex();
  const tricksWon = appState.currentTable && appState.currentTable.spades && Array.isArray(appState.currentTable.spades.tricksWon)
    ? appState.currentTable.spades.tricksWon
    : null;
  if (seatIndex < 0 || !tricksWon) {
    srSpeak('Trick count is not available yet', 'polite', { canInterruptLock: true });
    return;
  }
  const teamIndex = getSpadesTeamIndexForSeat(seatIndex);
  const teamTricks = (tricksWon[teamIndex] || 0) + (tricksWon[teamIndex + 2] || 0);
  const partnerName = getSpadesPartnerName();
  const takenBy = partnerName ? ('you and ' + partnerName) : 'you';
  srSpeak(teamTricks + (teamTricks === 1 ? ' trick taken by ' : ' tricks taken by ') + takenBy + '.', 'assertive', { canInterruptLock: true });
}

function announceSpadesOwnScore() {
  const player = getSpadesOwnPlayer();
  const score = player && typeof player.score === 'number' ? player.score : 0;
  srSpeak('Your team’s score is ' + score, 'assertive', { canInterruptLock: true });
}

function announceSpadesAllScores() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const teamAScore = appState.currentTable.players[0] ? (appState.currentTable.players[0].score || 0) : 0;
  const teamBScore = appState.currentTable.players[1] ? (appState.currentTable.players[1].score || 0) : 0;
  const text = 'Team A (' + getSpadesTeamPlayerNames(0).join(' & ') + '): ' + teamAScore
    + '. Team B (' + getSpadesTeamPlayerNames(1).join(' & ') + '): ' + teamBScore;
  srSpeak(text, 'assertive', { canInterruptLock: true });
}

function handleSpadesKeys(event) {
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
    announceSpadesHand();
    event.preventDefault();
  } else if (key === 't') {
    announceSpadesTurnStatus();
    event.preventDefault();
  } else if (key === 'p') {
    announceSpadesTrick();
    event.preventDefault();
  } else if (key === 'b') {
    announceSpadesBids();
    event.preventDefault();
  } else if (key === 'r') {
    announceSpadesPartner();
    event.preventDefault();
  } else if (key === 'c') {
    announceSpadesTrickCount();
    event.preventDefault();
  } else if (key === 's' && event.shiftKey) {
    announceSpadesAllScores();
    event.preventDefault();
  } else if (key === 's') {
    announceSpadesOwnScore();
    event.preventDefault();
  }
}

// --- Socket handlers ------------------------------------------------------------

socket.on('spadesHand', function (payload) {
  if (!payload || !Array.isArray(payload.hand)) {
    return;
  }

  appState.spadesHand = payload.hand;
  appState.spadesHandNumber = payload.handNumber;
  appState.spadesPhase = payload.phase;
  appState.spadesDealerIndex = payload.dealerIndex;
  appState.spadesLeaderIndex = payload.leaderIndex;
  appState.spadesHandButtonsHandKey = null;

  renderSpadesWidgets();

  if (payload.phase === 'bidding') {
    srSpeak('New hand. Your hand: ' + payload.hand.map(spadesCardName).join(', '), 'polite', { canInterruptLock: true });
  }
});

socket.on('spadesBidState', function (payload) {
  if (!payload) {
    return;
  }

  appState.spadesPhase = 'bidding';
  appState.spadesHandNumber = payload.handNumber;
  appState.spadesDealerIndex = payload.dealerIndex;
  appState.spadesLeaderIndex = payload.leaderIndex;
  appState.spadesTurnPlayerId = payload.turnPlayerId;
  appState.spadesTurnPlayerName = payload.turnPlayerName;
  appState.spadesBids = payload.bids || [null, null, null, null];
  if (Object.prototype.hasOwnProperty.call(payload, 'legalBids')) {
    appState.spadesLegalBids = payload.legalBids;
  } else if (payload.turnPlayerId !== socket.id) {
    appState.spadesLegalBids = null;
  }

  renderSpadesWidgets();

  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true, lockMs: 900 });
  }

  if (payload.turnPlayerId === socket.id) {
    window.requestAnimationFrame(function () {
      spadesFocusFirstEnabledButton(document.getElementById('spades-bid-grid'));
    });
  }
});

socket.on('spadesBidResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Bid rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
  }
});

socket.on('spadesTurnState', function (payload) {
  if (!payload) {
    return;
  }

  appState.spadesPhase = 'playing';
  appState.spadesTrickNumber = payload.trickNumber;
  appState.spadesSpadesBroken = !!payload.spadesBroken;
  appState.spadesTrick = payload.trick || [];
  appState.spadesTurnPlayerId = payload.turnPlayerId;
  appState.spadesTurnPlayerName = payload.turnPlayerName;
  if (Object.prototype.hasOwnProperty.call(payload, 'legalCards')) {
    appState.spadesLegalCards = payload.legalCards;
  } else if (payload.turnPlayerId !== socket.id) {
    appState.spadesLegalCards = null;
  }

  renderSpadesWidgets();

  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true, lockMs: 900 });
  }

  if (payload.turnPlayerId === socket.id) {
    window.requestAnimationFrame(function () {
      spadesFocusFirstEnabledButton(document.getElementById('spades-hand'));
    });
  }
});

socket.on('spadesPlayResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Play rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
    return;
  }
  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true });
  }
});

socket.on('spadesTrickResult', function (payload) {
  if (!payload) {
    return;
  }

  appState.spadesTrick = [];
  appState.spadesLastTrick = { cards: payload.trick, winnerId: payload.winnerId, winnerName: payload.winnerName };
  appState.spadesPhase = 'trick_complete';
  appState.spadesTurnPlayerId = payload.winnerId;
  appState.spadesTurnPlayerName = payload.winnerName;
  appState.spadesLegalCards = null;
  renderSpadesWidgets();

  const isWinner = payload.winnerId === socket.id;
  const isLastPlayer = payload.lastPlayerId === socket.id;
  const lastPlayerWon = payload.lastPlayerId === payload.winnerId;
  const breakClause = payload.justBroke ? 'Spades are now broken. ' : '';
  const outcomeClause = isWinner
    ? (payload.isFinalTrick ? 'You take the trick.' : 'You take the trick. Your lead.')
    : (payload.winnerName + ' takes the trick.');

  let message;
  if (!isWinner && !isLastPlayer && lastPlayerWon && !payload.justBroke) {
    message = payload.lastPlayerName + ' plays ' + spadesCardName(payload.lastCard) + ' and takes the trick.';
  } else {
    const playClause = (payload.lastPlayerName && !isLastPlayer)
      ? (payload.lastPlayerName + ' plays ' + spadesCardName(payload.lastCard) + '. ')
      : '';
    message = playClause + breakClause + outcomeClause;
  }

  srSpeak(message, 'assertive', { canInterruptLock: true, lockMs: 1200 });

  socket.emit('spadesAckTrick');
});

socket.on('spadesHandSummary', function (payload) {
  if (!payload) {
    return;
  }

  const playerLines = payload.players.map(function (entry) {
    const nilNote = entry.isNil ? (entry.nilMade ? ' (Nil made)' : ' (Nil failed)') : '';
    return entry.name + ': bid ' + spadesBidLabel(entry.bid) + ', took ' + entry.tricksWon + nilNote + '.';
  });

  const teamLines = payload.teams.map(function (team) {
    const bagNote = team.bagPenaltyApplied ? ' Bag penalty applied.' : '';
    return 'Team (' + team.playerNames.join(' & ') + '): ' + team.handPoints + ' points this hand, ' + team.total + ' total, ' + team.bags + ' bags.' + bagNote;
  });

  const message = playerLines.concat(teamLines).join(' ');

  setRoundResult('Hand ' + payload.handNumber + ' complete. ' + message);

  if (!payload.gameOver) {
    showAnnouncementOverlay({
      eyebrow: 'Hand ' + payload.handNumber + ' complete',
      title: 'Hand complete',
      message: message,
      tone: 'info',
      sticky: true,
      kind: 'spadesHandSummary'
    });
  }

  srSpeak('Hand ' + payload.handNumber + ' complete. ' + message, 'assertive', { canInterruptLock: true, lockMs: 2000 });
});

socket.on('spadesGameOver', function (payload) {
  if (!payload) {
    return;
  }

  const winnerTeam = payload.teams[payload.winnerTeamIndex];
  const scoreText = payload.teams.map(function (team) { return team.playerNames.join(' & ') + ': ' + team.total; }).join(', ');
  const message = payload.winnerNames.join(' & ') + ' win with ' + winnerTeam.total + ' points. Final scores: ' + scoreText;

  setRoundResult('Game over. ' + message);
  showAnnouncementOverlay({
    eyebrow: 'Game Over',
    title: payload.winnerNames.join(' & ') + ' win the game',
    message: message,
    tone: 'winner',
    sticky: true,
    duration: 4000,
    kind: 'spadesGameOver'
  });
  srSpeak('Game over. ' + message, 'assertive', { canInterruptLock: true, lockMs: 3000 });
});

// --- Wiring -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  const spadesPanel = document.getElementById('spades-panel');
  if (spadesPanel) {
    spadesPanel.addEventListener('keydown', handleSpadesKeys);
  }
});

// Scripts run after the DOM has parsed (they are placed at the end of
// <body>), so bind immediately too in case DOMContentLoaded already fired.
if (document.readyState !== 'loading') {
  const spadesPanelNow = document.getElementById('spades-panel');
  if (spadesPanelNow && !spadesPanelNow.dataset.spadesBound) {
    spadesPanelNow.dataset.spadesBound = 'true';
    spadesPanelNow.addEventListener('keydown', handleSpadesKeys);
  }
}
