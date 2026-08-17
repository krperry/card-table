// Cribbage client module: discard/pegging/show UI (native buttons, not
// canvas - same reasoning as hearts-client.js/spades-client.js), the
// graphical peg-scoring board (inline SVG, aria-hidden - purely a sighted
// supplement, never the sole channel for score info), keyboard shortcuts,
// and all Cribbage-specific socket.io event handlers. Loaded via a plain
// <script> tag after main.js/hearts-client.js/spades-client.js (see
// public/index.html) so it shares main.js's global scope and can reference
// appState/el/socket/srSpeak directly.

const CRIBBAGE_CARD_IMAGE_BASE = 'images/playing-cards/';
const CRIBBAGE_RANK_NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const CRIBBAGE_SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

Object.assign(appState, {
  cribbageHand: [],
  cribbagePhase: null,
  cribbageHandNumber: 0,
  cribbageDealerIndex: null,
  cribbageSelectedDiscard: [],
  cribbageOwnDiscardSubmitted: false,
  cribbageDiscardButtonsHandKey: null,
  cribbagePegButtonsHandKey: null,
  cribbageLegalCards: null,
  cribbageMustGo: false,
  cribbageTurnPlayerId: null,
  cribbageTurnPlayerName: '',
  cribbagePegCount: 0,
  cribbagePegSegment: [],
  cribbageStarter: null,
  cribbageHisHeelsAwarded: false,
  cribbageCrib: null,
  cribbageShowStep: null,
  cribbageShowOwnerId: null,
  cribbageShowOwnerName: '',
  cribbageShowCards: [],
  cribbageShowLabel: '',
  cribbageShowClaimedPoints: 0,
  cribbageShowCorrectTotal: 0,
  cribbageShowShortfall: 0,
  cribbageMugginsOpen: false,
  cribbagePegFront: null,
  cribbagePegBack: null,
  cribbageBoardHolesKey: null
});

function cribbageCardRank(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function cribbageCardSuit(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function cribbageCardName(card) {
  const rank = CRIBBAGE_RANK_NAMES[cribbageCardRank(card)];
  const suit = CRIBBAGE_SUIT_NAMES[cribbageCardSuit(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

function cribbageCardImageSrc(card) {
  return CRIBBAGE_CARD_IMAGE_BASE + card + '.svg';
}

function cribbageGetTargetScore() {
  return (appState.currentTable && appState.currentTable.matchSettings && appState.currentTable.matchSettings.targetScore) || 121;
}

function cribbageGetSeatName(seatIndex) {
  if (seatIndex === null || seatIndex === undefined || !appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return '';
  }
  const player = appState.currentTable.players[seatIndex];
  if (!player) {
    return '';
  }
  return player.id === socket.id ? 'You' : player.name;
}

// The dealer always owns the crib, so the two concepts are the same seat -
// but nothing else in the UI said so explicitly, which is what prompted this
// helper (see the srSpeak/status calls that use it below).
function cribbageGetCribOwnerPhrase(dealerIndex) {
  const dealerName = cribbageGetSeatName(dealerIndex);
  if (!dealerName) {
    return '';
  }
  return dealerName === 'You' ? 'your crib' : (dealerName + '’s crib');
}

function getCribbageOwnPlayer() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return null;
  }
  return appState.currentTable.players.find(function (player) { return player.id === socket.id; }) || null;
}

// --- Status region -----------------------------------------------------

function renderCribbageStatus() {
  const handEl = document.getElementById('cribbage-status-hand');
  if (!handEl) {
    return;
  }
  handEl.textContent = appState.cribbageHandNumber ? ('Hand ' + appState.cribbageHandNumber) : '';

  const dealerEl = document.getElementById('cribbage-status-dealer');
  if (dealerEl) {
    const dealerName = cribbageGetSeatName(appState.cribbageDealerIndex);
    const cribPhrase = cribbageGetCribOwnerPhrase(appState.cribbageDealerIndex);
    dealerEl.textContent = dealerName ? ('Dealer: ' + dealerName + ' (' + cribPhrase + ')') : '';
  }

  const turnEl = document.getElementById('cribbage-status-turn');
  if (turnEl) {
    if (appState.cribbagePhase === 'discard') {
      turnEl.textContent = appState.cribbageOwnDiscardSubmitted ? 'Waiting for the other player to discard' : 'Select two cards to discard';
    } else if (appState.cribbagePhase === 'peg' && appState.cribbageTurnPlayerId) {
      turnEl.textContent = appState.cribbageTurnPlayerId === socket.id ? 'Your turn to peg' : ((appState.cribbageTurnPlayerName || 'The other player') + "'s turn");
    } else if (appState.cribbagePhase === 'show') {
      turnEl.textContent = 'Counting the ' + (appState.cribbageShowLabel || 'hand');
    } else {
      turnEl.textContent = '';
    }
  }

  const scoreEl = document.getElementById('cribbage-status-score');
  if (scoreEl && appState.currentTable && Array.isArray(appState.currentTable.players)) {
    const parts = appState.currentTable.players.map(function (player) {
      const label = player.id === socket.id ? 'You' : player.name;
      return label + ': ' + (typeof player.score === 'number' ? player.score : 0);
    });
    scoreEl.textContent = 'Scores - ' + parts.join(', ') + ' (target ' + cribbageGetTargetScore() + ')';
  }
}

// --- Starter card sidebar -------------------------------------------------
// Mirrors Lumo's play-history-panel: a sidebar next to the play area rather
// than upper-left status text, and it stays visible for the rest of the hand
// once the starter is cut (see .cribbage-starter-panel in style.css).

function renderCribbageStarterPanel() {
  const panelEl = document.getElementById('cribbage-starter-panel');
  const emptyEl = document.getElementById('cribbage-starter-empty');
  const content = document.getElementById('cribbage-starter-content');
  if (!content || !emptyEl) {
    return;
  }

  // While a hand or the crib is being counted, cribbageRenderCardList()
  // already appends the starter card to that hand/crib's own card list
  // below - so keep this sidebar hidden then, or the starter card would
  // appear twice on screen at once (see cribbageRenderCardList()).
  const counting = appState.cribbagePhase === 'show';
  if (panelEl) {
    panelEl.classList.toggle('hidden', counting);
  }
  if (counting) {
    return;
  }

  if (!appState.cribbageStarter) {
    emptyEl.classList.remove('hidden');
    content.dataset.starterCard = '';
    Array.prototype.forEach.call(content.querySelectorAll('.cribbage-starter-card'), function (node) {
      node.remove();
    });
    return;
  }

  emptyEl.classList.add('hidden');
  if (content.dataset.starterCard === appState.cribbageStarter) {
    return;
  }
  content.dataset.starterCard = appState.cribbageStarter;

  Array.prototype.forEach.call(content.querySelectorAll('.cribbage-starter-card'), function (node) {
    node.remove();
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'cribbage-starter-card';

  const img = document.createElement('img');
  img.src = cribbageCardImageSrc(appState.cribbageStarter);
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  wrapper.appendChild(img);

  const name = document.createElement('p');
  name.className = 'cribbage-starter-name';
  name.textContent = cribbageCardName(appState.cribbageStarter);
  wrapper.appendChild(name);

  if (appState.cribbageHisHeelsAwarded) {
    const heels = document.createElement('p');
    heels.className = 'cribbage-starter-heels';
    heels.textContent = 'His heels! Dealer scores 2.';
    wrapper.appendChild(heels);
  }

  content.appendChild(wrapper);
}

// --- Shared roving-tabindex button-grid machinery -----------------------
// Copied and renamed from hearts-client.js's hearts* equivalents, per the
// codebase's existing per-game-duplication style.

function cribbageFocusFirstEnabledButton(container) {
  if (!container) {
    return;
  }
  const button = container.querySelector('button[tabindex="0"]') || container.querySelector('button');
  if (button && typeof button.focus === 'function') {
    button.focus();
  }
}

function cribbageBindCardGridKeys(container, options) {
  if (container.dataset.cribbageKeysBound) {
    return;
  }
  container.dataset.cribbageKeysBound = 'true';

  const onEnter = options && typeof options.onEnter === 'function' ? options.onEnter : null;

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

function cribbageRebuildCardButtons(container, cards, buildButton) {
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

// --- Discard UI ----------------------------------------------------------
// Toggle-select up to two cards (mirrors Hearts' three-card pass flow,
// capped at 2), then a standalone Confirm Discard button.

function cribbageDiscardAriaLabel(card) {
  const selectedIndex = appState.cribbageSelectedDiscard.indexOf(card);
  if (selectedIndex === -1) {
    return cribbageCardName(card) + ', not selected';
  }
  return cribbageCardName(card) + ', selected for discard, ' + appState.cribbageSelectedDiscard.length + ' of 2 selected';
}

function cribbageUpdateDiscardButton(button, card) {
  const selected = appState.cribbageSelectedDiscard.indexOf(card) !== -1;
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-label', cribbageDiscardAriaLabel(card));
}

function renderCribbageDiscardHand() {
  const area = document.getElementById('cribbage-discard-area');
  const container = document.getElementById('cribbage-discard-hand');
  const discardBtn = document.getElementById('cribbage-discard-btn');
  if (!area || !container) {
    return;
  }

  const active = appState.cribbagePhase === 'discard' && !appState.cribbageOwnDiscardSubmitted;
  area.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  const cribOwnerEl = document.getElementById('cribbage-discard-crib-owner');
  if (cribOwnerEl) {
    const cribPhrase = cribbageGetCribOwnerPhrase(appState.cribbageDealerIndex);
    cribOwnerEl.textContent = cribPhrase ? ('It’s ' + cribPhrase + ' this hand.') : '';
  }

  cribbageBindCardGridKeys(container, { onEnter: cribbageSubmitDiscard });

  const handKey = appState.cribbageHand.join(',');
  if (appState.cribbageDiscardButtonsHandKey !== handKey) {
    cribbageRebuildCardButtons(container, appState.cribbageHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = cribbageCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      cribbageUpdateDiscardButton(button, card);
      bindPressNoFocus(button, function () { cribbageToggleDiscardCard(card, button); });
      return button;
    });
    appState.cribbageDiscardButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      cribbageUpdateDiscardButton(button, button.dataset.card);
    });
  }

  if (discardBtn) {
    discardBtn.disabled = appState.cribbageSelectedDiscard.length !== 2;
  }
}

function cribbageToggleDiscardCard(card, button) {
  const index = appState.cribbageSelectedDiscard.indexOf(card);
  if (index !== -1) {
    appState.cribbageSelectedDiscard.splice(index, 1);
    cribbageUpdateDiscardButton(button, card);
    srSpeak('Card unselected', 'polite', { canInterruptLock: true });
  } else {
    if (appState.cribbageSelectedDiscard.length >= 2) {
      srSpeak('You already selected 2 cards. Unselect one first.', 'assertive', { canInterruptLock: true });
      return;
    }
    appState.cribbageSelectedDiscard.push(card);
    cribbageUpdateDiscardButton(button, card);
    srSpeak('Selected ' + appState.cribbageSelectedDiscard.length + ' of 2 cards', 'polite', { canInterruptLock: true });
  }

  const discardBtn = document.getElementById('cribbage-discard-btn');
  if (discardBtn) {
    discardBtn.disabled = appState.cribbageSelectedDiscard.length !== 2;
  }
  renderCribbageStatus();
}

function cribbageSubmitDiscard() {
  if (appState.cribbageSelectedDiscard.length !== 2) {
    srSpeak('Select exactly two cards before discarding', 'assertive');
    return;
  }
  socket.emit('cribbageSubmitDiscard', { cards: appState.cribbageSelectedDiscard.slice() });
}

// --- Pegging UI ------------------------------------------------------------
// Immediate single-press play (mirrors Hearts/Spades trick play) - no
// client-side legality pre-check, the server is sole authority on rejection
// (see cribbageAttemptPegPlay() below). A standalone Go button, shown only
// when the player has no legal play, emits cribbagePegGo.

function cribbagePegAriaLabel(card) {
  const legal = !appState.cribbageLegalCards || appState.cribbageLegalCards.indexOf(card) !== -1;
  return legal ? (cribbageCardName(card) + ', playable') : (cribbageCardName(card) + ', unavailable right now');
}

function cribbageUpdatePegButton(button, card) {
  const isMyTurn = appState.cribbagePhase === 'peg' && appState.cribbageTurnPlayerId === socket.id;
  const legal = isMyTurn && (!appState.cribbageLegalCards || appState.cribbageLegalCards.indexOf(card) !== -1);
  button.setAttribute('aria-disabled', legal ? 'false' : 'true');
  button.classList.toggle('illegal', !legal);
  button.setAttribute('aria-label', isMyTurn ? cribbagePegAriaLabel(card) : cribbageCardName(card));
}

function renderCribbagePegHand() {
  const area = document.getElementById('cribbage-peg-area');
  const container = document.getElementById('cribbage-peg-hand');
  const goBtn = document.getElementById('cribbage-go-btn');
  if (!area || !container) {
    return;
  }

  const active = appState.cribbagePhase === 'peg';
  area.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  cribbageBindCardGridKeys(container);

  const handKey = appState.cribbageHand.join(',');
  if (appState.cribbagePegButtonsHandKey !== handKey) {
    cribbageRebuildCardButtons(container, appState.cribbageHand, function (card, index) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.card = card;
      button.tabIndex = index === 0 ? 0 : -1;
      const img = document.createElement('img');
      img.src = cribbageCardImageSrc(card);
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      button.appendChild(img);
      cribbageUpdatePegButton(button, card);
      bindPressNoFocus(button, function () { cribbageAttemptPegPlay(card); });
      return button;
    });
    appState.cribbagePegButtonsHandKey = handKey;
  } else {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
      cribbageUpdatePegButton(button, button.dataset.card);
    });
  }

  const isMyTurn = appState.cribbageTurnPlayerId === socket.id;
  if (goBtn) {
    goBtn.classList.toggle('hidden', !(isMyTurn && appState.cribbageMustGo));
  }
}

function cribbageAttemptPegPlay(card) {
  // Card play is server-authoritative (see the module header comment in
  // games/cribbage/index.js) - the server's cribbagePegPlayResult response is
  // the sole source of any rejection announcement, same rationale as Hearts'
  // documented client/server staleness window.
  socket.emit('cribbagePlayCard', { card: card });
}

function cribbageSayGo() {
  socket.emit('cribbagePegGo');
}

function renderCribbagePegSegment() {
  const list = document.getElementById('cribbage-peg-segment-list');
  if (!list) {
    return;
  }
  list.innerHTML = '';

  if (!appState.cribbagePegSegment.length) {
    const li = document.createElement('li');
    li.textContent = 'No cards played yet this count.';
    list.appendChild(li);
    return;
  }

  appState.cribbagePegSegment.forEach(function (entry, index) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = cribbageCardImageSrc(entry.card);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    li.appendChild(img);
    // The running count is shown as a badge over the first card laid this
    // count, rather than as separate upper-left status text - it's always
    // separately available via the C-key announceCribbageCount() shortcut.
    if (index === 0) {
      const countBadge = document.createElement('span');
      countBadge.className = 'cribbage-count-badge';
      countBadge.textContent = String(appState.cribbagePegCount);
      countBadge.setAttribute('aria-hidden', 'true');
      li.appendChild(countBadge);
    }
    const label = document.createElement('span');
    label.textContent = entry.playerName + ': ' + cribbageCardName(entry.card);
    li.appendChild(label);
    list.appendChild(li);
  });
}

// --- Show (counting) UI -----------------------------------------------------

function cribbageRenderCardList(list, cards) {
  list.innerHTML = '';
  cards.forEach(function (card) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = cribbageCardImageSrc(card);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    li.appendChild(img);
    const label = document.createElement('span');
    label.textContent = cribbageCardName(card);
    li.appendChild(label);
    list.appendChild(li);
  });

  if (appState.cribbageStarter) {
    const li = document.createElement('li');
    li.className = 'cribbage-show-starter';
    const img = document.createElement('img');
    img.src = cribbageCardImageSrc(appState.cribbageStarter);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    li.appendChild(img);
    const label = document.createElement('span');
    label.textContent = 'Starter: ' + cribbageCardName(appState.cribbageStarter);
    li.appendChild(label);
    list.appendChild(li);
  }
}

function renderCribbageShow() {
  const area = document.getElementById('cribbage-show-area');
  const ownerEl = document.getElementById('cribbage-show-owner');
  const list = document.getElementById('cribbage-show-cards');
  const breakdownEl = document.getElementById('cribbage-show-breakdown');
  if (!area || !list) {
    return;
  }

  const active = appState.cribbagePhase === 'show' && !appState.cribbageMugginsOpen;
  area.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  if (ownerEl) {
    const ownerLabel = appState.cribbageShowOwnerId === socket.id ? 'Your' : (appState.cribbageShowOwnerName + "'s");
    ownerEl.textContent = ownerLabel + ' ' + appState.cribbageShowLabel;
  }

  cribbageRenderCardList(list, appState.cribbageShowCards);

  if (breakdownEl) {
    let text = appState.cribbageShowClaimedPoints + ' point' + (appState.cribbageShowClaimedPoints === 1 ? '' : 's') + '.';
    if (appState.cribbageShowShortfall > 0) {
      text += ' ' + appState.cribbageShowShortfall + ' missed point' + (appState.cribbageShowShortfall === 1 ? '' : 's') + ' claimed by the opponent.';
    }
    breakdownEl.textContent = text;
  }
}

function cribbageAckShow() {
  socket.emit('cribbageAckShow');
}

// --- Muggins claim UI (only ever shown when the host enabled Muggins) ------

function renderCribbageMuggins() {
  const area = document.getElementById('cribbage-muggins-area');
  const list = document.getElementById('cribbage-muggins-cards');
  const submitBtn = document.getElementById('cribbage-muggins-submit-btn');
  const claimBtn = document.getElementById('cribbage-muggins-claim-btn');
  const input = document.getElementById('cribbage-muggins-count-input');
  if (!area || !list) {
    return;
  }

  area.classList.toggle('hidden', !appState.cribbageMugginsOpen);
  if (!appState.cribbageMugginsOpen) {
    return;
  }

  cribbageRenderCardList(list, appState.cribbageShowCards);

  const isOwner = appState.cribbageShowOwnerId === socket.id;
  if (submitBtn) {
    submitBtn.classList.toggle('hidden', !isOwner);
  }
  if (input) {
    input.classList.toggle('hidden', !isOwner);
  }
  if (claimBtn) {
    claimBtn.classList.toggle('hidden', isOwner);
  }
}

function cribbageSubmitCount() {
  const input = document.getElementById('cribbage-muggins-count-input');
  const claimedPoints = input ? parseInt(input.value, 10) : 0;
  socket.emit('cribbageSubmitCount', { claimedPoints: Number.isFinite(claimedPoints) ? claimedPoints : 0 });
}

function cribbageMugginsClaim() {
  socket.emit('cribbageMugginsClaim');
}

// --- Peg-scoring board (inline SVG, decorative) ------------------------------
// A traditional physical-cribbage-board visualization: two lanes (one per
// player), holes every point up to the target score (every 5th styled
// distinctly), and a leapfrogging peg pair per lane (a dimmed "back" peg at
// the previous score, a solid "front" peg at the current score, joined by a
// faint connector) - the standard way a real board shows "how many points
// were just scored". aria-hidden="true" throughout: this is a sighted
// supplement only, never the sole channel for score info (see
// renderCribbageStatus() above and the srSpeak() calls throughout this file).

const CRIBBAGE_BOARD_VIEW_WIDTH = 950;
const CRIBBAGE_BOARD_MARGIN = 44;
const CRIBBAGE_LANE_Y = [50, 120];
const SVG_NS = 'http://www.w3.org/2000/svg';

function cribbageBoardHoleX(index, targetScore) {
  const trackWidth = CRIBBAGE_BOARD_VIEW_WIDTH - CRIBBAGE_BOARD_MARGIN * 2;
  return CRIBBAGE_BOARD_MARGIN + (Math.min(index, targetScore) / targetScore) * trackWidth;
}

function cribbageUpdatePegHistory(scoresBySeat) {
  if (!appState.cribbagePegFront) {
    appState.cribbagePegFront = scoresBySeat.slice();
    appState.cribbagePegBack = scoresBySeat.slice();
    return;
  }
  scoresBySeat.forEach(function (score, index) {
    if (score !== appState.cribbagePegFront[index]) {
      appState.cribbagePegBack[index] = appState.cribbagePegFront[index];
      appState.cribbagePegFront[index] = score;
    }
  });
}

function cribbageBuildBoardHoles(svg, targetScore) {
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }

  for (let lane = 0; lane < 2; lane++) {
    const y = CRIBBAGE_LANE_Y[lane];

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(CRIBBAGE_BOARD_MARGIN));
    line.setAttribute('x2', String(CRIBBAGE_BOARD_VIEW_WIDTH - CRIBBAGE_BOARD_MARGIN));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('class', 'cribbage-lane-line');
    svg.appendChild(line);

    for (let i = 0; i <= targetScore; i++) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(cribbageBoardHoleX(i, targetScore)));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', i % 5 === 0 ? '4.5' : '3');
      circle.setAttribute('class', 'cribbage-hole' + (i % 5 === 0 ? ' tick' : ''));
      svg.appendChild(circle);
    }

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(CRIBBAGE_BOARD_VIEW_WIDTH - CRIBBAGE_BOARD_MARGIN + 6));
    label.setAttribute('y', String(y + 4));
    label.setAttribute('class', 'cribbage-board-finish-label');
    label.textContent = String(targetScore);
    svg.appendChild(label);
  }

  for (let lane = 0; lane < 2; lane++) {
    const connector = document.createElementNS(SVG_NS, 'line');
    connector.setAttribute('class', 'cribbage-peg-gap');
    connector.setAttribute('data-player-index', String(lane));
    svg.appendChild(connector);

    const back = document.createElementNS(SVG_NS, 'circle');
    back.setAttribute('r', '7');
    back.setAttribute('class', 'cribbage-peg cribbage-peg-back');
    back.setAttribute('data-player-index', String(lane));
    svg.appendChild(back);

    const front = document.createElementNS(SVG_NS, 'circle');
    front.setAttribute('r', '8');
    front.setAttribute('class', 'cribbage-peg cribbage-peg-front');
    front.setAttribute('data-player-index', String(lane));
    svg.appendChild(front);
  }
}

function cribbageUpdatePegPositions(svg, targetScore) {
  for (let lane = 0; lane < 2; lane++) {
    const y = CRIBBAGE_LANE_Y[lane];
    const backScore = (appState.cribbagePegBack && appState.cribbagePegBack[lane]) || 0;
    const frontScore = (appState.cribbagePegFront && appState.cribbagePegFront[lane]) || 0;
    const backX = cribbageBoardHoleX(backScore, targetScore);
    const frontX = cribbageBoardHoleX(frontScore, targetScore);

    const back = svg.querySelector('.cribbage-peg-back[data-player-index="' + lane + '"]');
    const front = svg.querySelector('.cribbage-peg-front[data-player-index="' + lane + '"]');
    const connector = svg.querySelector('.cribbage-peg-gap[data-player-index="' + lane + '"]');

    if (back) {
      back.setAttribute('cx', String(backX));
      back.setAttribute('cy', String(y));
    }
    if (front) {
      front.setAttribute('cx', String(frontX));
      front.setAttribute('cy', String(y));
    }
    if (connector) {
      connector.setAttribute('x1', String(backX));
      connector.setAttribute('y1', String(y));
      connector.setAttribute('x2', String(frontX));
      connector.setAttribute('y2', String(y));
    }
  }
}

function renderCribbageBoard() {
  const svg = document.getElementById('cribbage-board');
  if (!svg || !appState.currentTable || appState.currentTable.gameType !== 'cribbage') {
    return;
  }

  const targetScore = cribbageGetTargetScore();
  const players = Array.isArray(appState.currentTable.players) ? appState.currentTable.players : [];
  const scoresBySeat = players.map(function (player) { return typeof player.score === 'number' ? player.score : 0; });
  while (scoresBySeat.length < 2) {
    scoresBySeat.push(0);
  }

  cribbageUpdatePegHistory(scoresBySeat);

  if (appState.cribbageBoardHolesKey !== targetScore) {
    cribbageBuildBoardHoles(svg, targetScore);
    appState.cribbageBoardHolesKey = targetScore;
  }

  cribbageUpdatePegPositions(svg, targetScore);
}

// --- Top-level render --------------------------------------------------------

function renderCribbageWidgets() {
  renderCribbageStatus();
  renderCribbageStarterPanel();
  renderCribbagePegSegment();
  renderCribbageDiscardHand();
  renderCribbagePegHand();
  renderCribbageShow();
  renderCribbageMuggins();
  renderCribbageBoard();
}

function renderCribbagePanel() {
  if (!appState.currentTable || appState.currentTable.gameType !== 'cribbage') {
    return;
  }

  const cribbage = appState.currentTable.cribbage;
  if (cribbage) {
    appState.cribbageHandNumber = cribbage.handNumber;
    appState.cribbagePhase = cribbage.phase;
    appState.cribbageDealerIndex = cribbage.dealerIndex;
    appState.cribbageStarter = cribbage.starter;
    appState.cribbageHisHeelsAwarded = !!cribbage.hisHeelsAwarded;
    if (cribbage.peg) {
      appState.cribbagePegCount = cribbage.peg.count;
      appState.cribbagePegSegment = cribbage.peg.segment || [];
      appState.cribbageTurnPlayerId = cribbage.peg.turnPlayerId;
      appState.cribbageTurnPlayerName = cribbage.peg.turnPlayerName;
    }
    if (cribbage.crib) {
      appState.cribbageCrib = cribbage.crib;
    }
  }

  renderCribbageWidgets();
}

// --- Keyboard shortcuts --------------------------------------------------------

function announceCribbageHand() {
  if (!appState.cribbageHand.length) {
    srSpeak('Your hand is empty', 'polite', { canInterruptLock: true });
    return;
  }
  srSpeak('Your hand: ' + appState.cribbageHand.map(cribbageCardName).join(', '), 'polite', { canInterruptLock: true });
}

function announceCribbageStatus() {
  const parts = [];
  if (appState.cribbageHandNumber) {
    parts.push('Hand ' + appState.cribbageHandNumber);
  }
  const dealerName = cribbageGetSeatName(appState.cribbageDealerIndex);
  if (dealerName) {
    parts.push('Dealer: ' + dealerName);
  }
  if (appState.cribbagePhase === 'discard') {
    parts.push(appState.cribbageOwnDiscardSubmitted ? 'waiting for the other player to discard' : 'select two cards to discard');
  } else if (appState.cribbagePhase === 'peg') {
    parts.push('count is ' + appState.cribbagePegCount);
    if (appState.cribbageTurnPlayerId) {
      parts.push(appState.cribbageTurnPlayerId === socket.id ? 'your turn' : ((appState.cribbageTurnPlayerName || 'the other player') + "'s turn"));
    }
  } else if (appState.cribbagePhase === 'show') {
    parts.push('counting the ' + (appState.cribbageShowLabel || 'hand'));
  }
  srSpeak(parts.join('. '), 'assertive', { canInterruptLock: true });
}

function announceCribbageCount() {
  srSpeak(appState.cribbagePhase === 'peg' ? ('Count is ' + appState.cribbagePegCount) : 'Not currently pegging', 'assertive', { canInterruptLock: true });
}

function announceCribbagePegSegment() {
  if (!appState.cribbagePegSegment.length) {
    srSpeak('No cards played yet this count', 'polite', { canInterruptLock: true });
    return;
  }
  const text = appState.cribbagePegSegment.map(function (entry) { return entry.playerName + ' played ' + cribbageCardName(entry.card); }).join('. ');
  srSpeak(text, 'polite', { canInterruptLock: true });
}

function announceCribbageStarter() {
  srSpeak(appState.cribbageStarter ? ('Starter: ' + cribbageCardName(appState.cribbageStarter)) : 'No starter has been revealed yet', 'assertive', { canInterruptLock: true });
}

// Builds the "who/what/how many points" sentence for whichever show
// (counting) step is currently active, from the appState fields
// cribbageShowStep populates. Shared by the initial cribbageShowStep
// announcement and the 'h' shortcut's repeat-during-counting behavior below,
// so a blind player who missed the first read-out can re-hear it on demand.
function cribbageBuildShowStepMessage() {
  const ownerLabel = appState.cribbageShowOwnerId === socket.id ? 'Your' : (appState.cribbageShowOwnerName + "'s");
  const cardsText = appState.cribbageShowCards.map(cribbageCardName).join(', ');
  const starterText = appState.cribbageStarter ? (', with the starter ' + cribbageCardName(appState.cribbageStarter)) : '';
  let message = ownerLabel + ' ' + appState.cribbageShowLabel + ': ' + cardsText + starterText + '. Scores ' + appState.cribbageShowClaimedPoints + ' point' + (appState.cribbageShowClaimedPoints === 1 ? '' : 's') + '.';
  if (appState.cribbageShowShortfall > 0) {
    message += ' ' + appState.cribbageShowShortfall + ' missed point' + (appState.cribbageShowShortfall === 1 ? '' : 's') + ' claimed.';
  }
  return message;
}

function announceCribbageShowStep() {
  if (!appState.cribbageShowStep || !appState.cribbageShowCards.length) {
    srSpeak('Nothing is being counted right now', 'polite', { canInterruptLock: true });
    return;
  }
  // During a Muggins claim window the score hasn't been decided yet -
  // cribbageShowClaimedPoints still holds the previous step's total, so
  // repeating cribbageBuildShowStepMessage() here would read a wrong score.
  // Read back just the cards being counted instead.
  if (appState.cribbageMugginsOpen) {
    const ownerLabel = appState.cribbageShowOwnerId === socket.id ? 'your' : (appState.cribbageShowOwnerName + "'s");
    const cardsText = appState.cribbageShowCards.map(cribbageCardName).join(', ');
    const starterText = appState.cribbageStarter ? (', with the starter ' + cribbageCardName(appState.cribbageStarter)) : '';
    srSpeak('Counting ' + ownerLabel + ' ' + appState.cribbageShowLabel + ': ' + cardsText + starterText + '.', 'assertive', { canInterruptLock: true, lockMs: 1400 });
    return;
  }
  srSpeak(cribbageBuildShowStepMessage(), 'assertive', { canInterruptLock: true, lockMs: 1400 });
}

function announceCribbageCrib() {
  if (!appState.cribbageCrib) {
    srSpeak('The crib has not been revealed yet', 'polite', { canInterruptLock: true });
    return;
  }
  srSpeak('Crib: ' + appState.cribbageCrib.map(cribbageCardName).join(', '), 'polite', { canInterruptLock: true });
}

function announceCribbageOwnScore() {
  const player = getCribbageOwnPlayer();
  const score = player && typeof player.score === 'number' ? player.score : 0;
  srSpeak('Your score is ' + score, 'assertive', { canInterruptLock: true });
}

function announceCribbageAllScores() {
  if (!appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }
  const text = appState.currentTable.players.map(function (player) {
    const label = player.id === socket.id ? 'You' : player.name;
    return label + ': ' + (typeof player.score === 'number' ? player.score : 0);
  }).join(', ');
  srSpeak('Scores - ' + text, 'assertive', { canInterruptLock: true });
}

function handleCribbageKeys(event) {
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
    if (appState.cribbagePhase === 'show') {
      announceCribbageShowStep();
    } else {
      announceCribbageHand();
    }
    event.preventDefault();
  } else if (key === 't') {
    announceCribbageStatus();
    event.preventDefault();
  } else if (key === 'c') {
    announceCribbageCount();
    event.preventDefault();
  } else if (key === 'p') {
    announceCribbagePegSegment();
    event.preventDefault();
  } else if (key === 'u') {
    announceCribbageStarter();
    event.preventDefault();
  } else if (key === 'k') {
    announceCribbageCrib();
    event.preventDefault();
  } else if (key === 's' && event.shiftKey) {
    announceCribbageAllScores();
    event.preventDefault();
  } else if (key === 's') {
    announceCribbageOwnScore();
    event.preventDefault();
  }
}

// --- Socket handlers ------------------------------------------------------------

socket.on('cribbageHand', function (payload) {
  if (!payload || !Array.isArray(payload.hand)) {
    return;
  }

  appState.cribbageHand = payload.hand;
  appState.cribbageHandNumber = payload.handNumber;
  appState.cribbagePhase = payload.phase;
  appState.cribbageDealerIndex = payload.dealerIndex;
  appState.cribbageDiscardButtonsHandKey = null;
  appState.cribbagePegButtonsHandKey = null;

  if (payload.phase === 'discard') {
    appState.cribbageSelectedDiscard = [];
    appState.cribbageOwnDiscardSubmitted = false;
  }
  // A fresh game always starts at hand 1 - reset the peg board's leapfrog
  // history here rather than carrying over a stale previous game's positions.
  if (payload.handNumber === 1) {
    appState.cribbagePegFront = null;
    appState.cribbagePegBack = null;
  }

  renderCribbageWidgets();

  if (payload.phase === 'discard') {
    const cribPhrase = cribbageGetCribOwnerPhrase(payload.dealerIndex);
    srSpeak('New hand. It’s ' + cribPhrase + '. Your hand: ' + payload.hand.map(cribbageCardName).join(', '), 'polite', { canInterruptLock: true });
    window.requestAnimationFrame(function () {
      cribbageFocusFirstEnabledButton(document.getElementById('cribbage-discard-hand'));
    });
  } else if (payload.phase === 'peg') {
    window.requestAnimationFrame(function () {
      cribbageFocusFirstEnabledButton(document.getElementById('cribbage-peg-hand'));
    });
  }
});

socket.on('cribbageDiscardPrompt', function (payload) {
  if (!payload) {
    return;
  }
  appState.cribbagePhase = 'discard';
  appState.cribbageDealerIndex = payload.dealerIndex;
  renderCribbageWidgets();
  const cribPhrase = cribbageGetCribOwnerPhrase(payload.dealerIndex);
  srSpeak('Discard two cards to ' + cribPhrase + '.', 'assertive', { canInterruptLock: true });
});

socket.on('cribbageDiscardResult', function (payload) {
  if (!payload) {
    return;
  }
  srSpeak(payload.message || (payload.success ? 'Discard submitted' : 'Discard failed'), payload.success ? 'polite' : 'assertive', { canInterruptLock: true });
  if (payload.success) {
    appState.cribbageOwnDiscardSubmitted = true;
    // Drop the two discarded cards from the hand immediately rather than
    // waiting for the server's next cribbageHand payload (which doesn't
    // arrive until pegging actually starts) - otherwise they'd linger,
    // greyed out, in the pegging hand until then.
    const discarded = appState.cribbageSelectedDiscard;
    appState.cribbageHand = appState.cribbageHand.filter(function (card) { return discarded.indexOf(card) === -1; });
    appState.cribbageSelectedDiscard = [];
    renderCribbageWidgets();
  } else {
    playErrorTone();
  }
});

socket.on('cribbageCutResult', function (payload) {
  if (!payload) {
    return;
  }
  appState.cribbageStarter = payload.starter;
  appState.cribbageHisHeelsAwarded = !!payload.hisHeels;
  renderCribbageWidgets();

  const message = 'Starter: ' + cribbageCardName(payload.starter)
    + (payload.hisHeels ? ('. His heels! ' + payload.dealerName + ' scores 2.') : '');
  srSpeak(message, 'assertive', { canInterruptLock: true, lockMs: 1200 });
});

socket.on('cribbagePegState', function (payload) {
  if (!payload) {
    return;
  }

  appState.cribbagePhase = 'peg';
  appState.cribbagePegCount = payload.count;
  appState.cribbagePegSegment = payload.segment || [];
  appState.cribbageTurnPlayerId = payload.turnPlayerId;
  appState.cribbageTurnPlayerName = payload.turnPlayerName;
  if (Object.prototype.hasOwnProperty.call(payload, 'legalCards')) {
    appState.cribbageLegalCards = payload.legalCards;
    appState.cribbageMustGo = !!payload.mustGo;
  } else if (payload.turnPlayerId !== socket.id) {
    appState.cribbageLegalCards = null;
    appState.cribbageMustGo = false;
  }

  renderCribbageWidgets();

  // The server already composed the single combined announcement this seat
  // needs (see buildPegMessage() in games/cribbage/index.js) - never
  // re-derived here (matches Hearts'/Spades' "don't roll your own" rule).
  if (payload.message) {
    srSpeak(payload.message, 'assertive', { canInterruptLock: true, lockMs: 900 });
  }

  if (payload.turnPlayerId === socket.id) {
    window.requestAnimationFrame(function () {
      if (appState.cribbageMustGo) {
        const goBtn = document.getElementById('cribbage-go-btn');
        if (goBtn) {
          goBtn.focus();
          return;
        }
      }
      cribbageFocusFirstEnabledButton(document.getElementById('cribbage-peg-hand'));
    });
  }
});

socket.on('cribbagePegPlayResult', function (payload) {
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

socket.on('cribbagePegGoResult', function (payload) {
  if (!payload) {
    return;
  }
  if (!payload.success) {
    srSpeak(payload.message || 'Go rejected', 'assertive', { canInterruptLock: true });
    playErrorTone();
  }
});

socket.on('cribbagePegRoundResult', function (payload) {
  if (!payload) {
    return;
  }
  const reasonText = payload.reason === 'thirtyOne' ? 'Thirty-one!' : 'Go.';
  srSpeak(reasonText + ' ' + payload.scorerName + ' scores ' + payload.points + '. Count resets to zero.', 'assertive', { canInterruptLock: true, lockMs: 1200 });
});

socket.on('cribbageShowStep', function (payload) {
  if (!payload) {
    return;
  }

  appState.cribbagePhase = 'show';
  appState.cribbageMugginsOpen = false;
  appState.cribbageShowStep = payload.step;
  appState.cribbageShowOwnerId = payload.ownerId;
  appState.cribbageShowOwnerName = payload.ownerName;
  appState.cribbageShowCards = payload.cards || [];
  appState.cribbageShowLabel = payload.label;
  appState.cribbageShowClaimedPoints = payload.claimedPoints;
  appState.cribbageShowCorrectTotal = payload.correctTotal;
  appState.cribbageShowShortfall = payload.shortfallAwardedToOpponent || 0;
  if (payload.starter) {
    appState.cribbageStarter = payload.starter;
  }

  renderCribbageWidgets();

  // Announce the actual cards being counted, not just the point total - a
  // sighted player sees the card list via renderCribbageShow()/
  // cribbageRenderCardList() above, but a blind player previously only heard
  // the score, never which cards made it up (most noticeable for the crib,
  // which no other announcement ever lists).
  srSpeak(cribbageBuildShowStepMessage(), 'assertive', { canInterruptLock: true, lockMs: 1400 });

  window.requestAnimationFrame(function () {
    const continueBtn = document.getElementById('cribbage-show-continue-btn');
    if (continueBtn) {
      continueBtn.focus();
    }
  });
});

socket.on('cribbageShowClaimOpen', function (payload) {
  if (!payload) {
    return;
  }

  appState.cribbagePhase = 'show';
  appState.cribbageMugginsOpen = true;
  appState.cribbageShowStep = payload.step;
  appState.cribbageShowOwnerId = payload.ownerId;
  appState.cribbageShowOwnerName = payload.ownerName;
  appState.cribbageShowCards = payload.cards || [];
  appState.cribbageShowLabel = payload.label;
  if (payload.starter) {
    appState.cribbageStarter = payload.starter;
  }

  renderCribbageWidgets();

  const isOwner = payload.ownerId === socket.id;
  const message = isOwner
    ? ('Count your ' + payload.label + ' and enter your total.')
    : (payload.ownerName + ' is counting their ' + payload.label + '.');
  srSpeak(message, 'assertive', { canInterruptLock: true, lockMs: 1200 });

  if (isOwner) {
    window.requestAnimationFrame(function () {
      const input = document.getElementById('cribbage-muggins-count-input');
      if (input) {
        input.focus();
      }
    });
  }
});

socket.on('cribbageHandSummary', function (payload) {
  if (!payload) {
    return;
  }

  const lines = payload.scores.map(function (entry) {
    return entry.name + ': ' + entry.handPoints + ' points this hand, ' + entry.totalPoints + ' total.';
  });
  let message = lines.join(' ');
  if (payload.hisHeelsAwarded) {
    message = 'His heels was scored this hand. ' + message;
  }

  setRoundResult('Hand ' + payload.handNumber + ' complete. ' + message);

  showAnnouncementOverlay({
    eyebrow: 'Hand ' + payload.handNumber + ' complete',
    title: 'Hand complete',
    message: message,
    tone: 'info',
    sticky: true,
    kind: 'cribbageHandSummary'
  });

  srSpeak('Hand ' + payload.handNumber + ' complete. ' + message, 'assertive', { canInterruptLock: true, lockMs: 2000 });
});

socket.on('cribbageGameOver', function (payload) {
  if (!payload) {
    return;
  }

  const scoreText = payload.scores.map(function (entry) { return entry.name + ': ' + entry.totalPoints; }).join(', ');
  const winnerScore = (payload.scores.find(function (entry) { return entry.name === payload.winner; }) || {}).totalPoints;
  const message = payload.winner + ' wins with ' + winnerScore + ' points. Final scores: ' + scoreText;

  setRoundResult('Game over. ' + message);
  showAnnouncementOverlay({
    eyebrow: 'Game Over',
    title: payload.winner + ' wins the game',
    message: message,
    tone: 'winner',
    sticky: true,
    duration: 4000,
    kind: 'cribbageGameOver'
  });
  srSpeak('Game over. ' + message, 'assertive', { canInterruptLock: true, lockMs: 3000 });
});

// --- Wiring -----------------------------------------------------------------

function cribbageBindOnce(element, handler) {
  if (!element || element.dataset.cribbageBound) {
    return;
  }
  element.dataset.cribbageBound = 'true';
  bindPress(element, handler);
}

function bindCribbageUi() {
  cribbageBindOnce(document.getElementById('cribbage-discard-btn'), cribbageSubmitDiscard);
  cribbageBindOnce(document.getElementById('cribbage-go-btn'), cribbageSayGo);
  cribbageBindOnce(document.getElementById('cribbage-show-continue-btn'), cribbageAckShow);
  cribbageBindOnce(document.getElementById('cribbage-muggins-submit-btn'), cribbageSubmitCount);
  cribbageBindOnce(document.getElementById('cribbage-muggins-claim-btn'), cribbageMugginsClaim);

  const cribbagePanel = document.getElementById('cribbage-panel');
  if (cribbagePanel && !cribbagePanel.dataset.cribbageBound) {
    cribbagePanel.dataset.cribbageBound = 'true';
    cribbagePanel.addEventListener('keydown', handleCribbageKeys);
  }
}

document.addEventListener('DOMContentLoaded', bindCribbageUi);

// Scripts run after the DOM has parsed (they are placed at the end of
// <body>), so bind immediately too in case DOMContentLoaded already fired.
if (document.readyState !== 'loading') {
  bindCribbageUi();
}
