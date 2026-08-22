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
// Jokers use suit char 'J' (see games/rummy/rules.js's matching constant) -
// never a real suit, so it doubles as an unambiguous discriminator. Sorted
// after Spades/King respectively so a Joker lands at the end of a hand
// instead of colliding with RUMMY_SUIT_SORT/RUMMY_RANK_ORDER's undefined
// lookup (which would otherwise produce NaN and corrupt the sort).
const RUMMY_JOKER_SUIT_CHAR = 'J';
const RUMMY_JOKER_SORT_SUIT = 4;
const RUMMY_JOKER_SORT_RANK = 14;

function rummyIsJoker(card) {
  return typeof card === 'string' && card.charAt(1) === RUMMY_JOKER_SUIT_CHAR;
}

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
  rummyHandButtonsHandKey: null,
  // Player-hand presentation preference only - never consulted by
  // server-authoritative meld/lay-off/discard logic. See rummyDisplayHand().
  rummySortMode: 'value',
  // Sighted-only display preference for the meld board's card-image size.
  // See renderRummyMeldBoard()/rummyToggleMeldSize().
  rummyMeldsEnlarged: false
});

function rummyCardRank(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function rummyCardSuit(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function rummyCardName(card) {
  if (rummyIsJoker(card)) {
    return 'Joker';
  }
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

// Joker-aware sort keys - a Joker has no fixed rank/suit, so RUMMY_RANK_ORDER
// and RUMMY_SUIT_SORT (both keyed by real rank/suit chars) don't cover it;
// falling through to their bare lookups would yield undefined and corrupt
// the sort (undefined - number is NaN). Both sort a Joker to the end.
function rummySortRankValue(card) {
  return rummyIsJoker(card) ? RUMMY_JOKER_SORT_RANK : rummyRankOrderValue(card);
}

function rummySortSuitValue(card) {
  return rummyIsJoker(card) ? RUMMY_JOKER_SORT_SUIT : RUMMY_SUIT_SORT[rummyCardSuit(card)];
}

// --- Hand sort preference (presentation only) -----------------------------
// Mirrors cribbage-client.js's cribbageSortMode section exactly - only ever
// reorders appState.rummyHand, the client's own copy of "what to show/
// announce for the player's hand". Never touches server state, melding, or
// table.game.hands.

function rummySortCardsByValue(cards) {
  return cards.slice().sort(function (a, b) {
    const rankDiff = rummySortRankValue(a) - rummySortRankValue(b);
    return rankDiff !== 0 ? rankDiff : rummySortSuitValue(a) - rummySortSuitValue(b);
  });
}

function rummySortCardsBySuit(cards) {
  return cards.slice().sort(function (a, b) {
    const suitDiff = rummySortSuitValue(a) - rummySortSuitValue(b);
    return suitDiff !== 0 ? suitDiff : rummySortRankValue(a) - rummySortRankValue(b);
  });
}

function rummyDisplayHand() {
  return appState.rummySortMode === 'suit' ? rummySortCardsBySuit(appState.rummyHand) : rummySortCardsByValue(appState.rummyHand);
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

// --- Pile visual (sighted-only; decorative) -----------------------------
// #rummy-status-pile above already carries this same information as text
// for screen readers (unchanged) - this section is purely a visual stand-in
// for what used to be that text's only presentation, replacing it with an
// actual stock pile and discard pile of cards. It is marked aria-hidden in
// index.html so screen reader users see no change: they still get this info
// from #rummy-status-pile and from the P key (announceRummyPile()).

function renderRummyPileVisual() {
  const pileArea = document.getElementById('rummy-pile-area');
  if (!pileArea) {
    return;
  }

  const active = appState.rummyPhase && appState.rummyPhase !== 'waiting';
  pileArea.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  const stockCountEl = document.getElementById('rummy-stock-pile-count');
  if (stockCountEl) {
    stockCountEl.textContent = String(appState.rummyStockCount);
  }
  const stockImg = document.getElementById('rummy-stock-pile-img');
  if (stockImg) {
    stockImg.classList.toggle('rummy-pile-empty', appState.rummyStockCount === 0);
  }

  const discardImg = document.getElementById('rummy-discard-pile-img');
  if (discardImg) {
    if (appState.rummyDiscardTop) {
      discardImg.src = rummyCardImageSrc(appState.rummyDiscardTop);
      discardImg.classList.remove('rummy-pile-empty');
    } else {
      discardImg.removeAttribute('src');
      discardImg.classList.add('rummy-pile-empty');
    }
  }
}

// --- Meld board (always-visible, public info) --------------------------------

// A Joker's exact position within a group is genuinely ambiguous (see
// games/rummy/rules.js's runEffectiveBounds() header) - rather than guess,
// the label names the real cards (which fix the group's rank/suit identity)
// and simply notes how many Jokers ride along.
function rummyMeldGroupLabel(group) {
  if (!group || !Array.isArray(group.cards) || !group.cards.length) {
    return '';
  }
  const jokerCount = group.cards.filter(rummyIsJoker).length;
  const jokerNote = jokerCount ? (', plus ' + jokerCount + ' Joker' + (jokerCount === 1 ? '' : 's')) : '';
  const realCards = group.cards.filter(function (card) { return !rummyIsJoker(card); });

  if (group.type === 'set') {
    if (!realCards.length) {
      return 'Set: unknown' + jokerNote;
    }
    return 'Set: ' + RUMMY_RANK_NAMES[rummyCardRank(realCards[0])] + 's' + jokerNote;
  }

  if (!realCards.length) {
    return 'Run: unknown' + jokerNote;
  }
  const sorted = realCards.slice().sort(function (a, b) { return rummyRankOrderValue(a) - rummyRankOrderValue(b); });
  const suit = RUMMY_SUIT_NAMES[rummyCardSuit(sorted[0])] || '';
  const ranks = sorted.map(function (card) { return RUMMY_RANK_NAMES[rummyCardRank(card)]; }).join('-');
  return 'Run: ' + ranks + ' of ' + suit + jokerNote;
}

// --- Meld card visuals (sighted-only; derived from the same group data the
// accessible label above is built from - see rummyMeldGroupLabel()) --------
// These never independently decide what a meld "is"; they only choose a
// display ORDER for the group's existing cards.cards array, replicating
// (not re-implementing) games/rummy/rules.js's Joker gap-filling logic so a
// Joker renders in the run position it's actually covering. Real rule
// validation and meld/lay-off legality stay entirely server-side.

// Same leftover-Joker "extend low end first, then high end" convention as
// games/rummy/rules.js's runEffectiveBounds()/this file's own
// rummyRunEffectiveBounds() above - kept as a separate function (rather than
// reusing those) because this one needs to return the actual per-position
// cards, not just the resulting min/max bounds.
function rummyBuildRunDisplayCards(cards) {
  const jokerPool = cards.filter(rummyIsJoker).slice();
  const realCards = cards.filter(function (card) { return !rummyIsJoker(card); });
  if (!realCards.length) {
    return cards.slice();
  }

  const byRankOrder = {};
  realCards.forEach(function (card) { byRankOrder[rummyRankOrderValue(card)] = card; });
  const values = realCards.map(rummyRankOrderValue);
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);

  const result = [];
  for (let value = min; value <= max; value++) {
    if (byRankOrder[value]) {
      result.push(byRankOrder[value]);
    } else if (jokerPool.length) {
      result.push(jokerPool.shift());
    }
  }

  while (jokerPool.length) {
    if (min > 1) {
      min--;
      result.unshift(jokerPool.shift());
    } else if (max < 13) {
      max++;
      result.push(jokerPool.shift());
    } else {
      // Shouldn't happen for an already-valid run (see isValidRun()'s
      // roomBelow/roomAbove check server-side), but avoid an infinite loop.
      break;
    }
  }

  return result;
}

function rummyBuildSetDisplayCards(cards) {
  const realCards = cards.filter(function (card) { return !rummyIsJoker(card); })
    .slice()
    .sort(function (a, b) { return rummySortSuitValue(a) - rummySortSuitValue(b); });
  const jokers = cards.filter(rummyIsJoker);
  return realCards.concat(jokers);
}

function rummyBuildMeldDisplayCards(group) {
  if (!group || !Array.isArray(group.cards) || !group.cards.length) {
    return [];
  }
  return group.type === 'run' ? rummyBuildRunDisplayCards(group.cards) : rummyBuildSetDisplayCards(group.cards);
}

// aria-hidden: the visually-hidden label built in renderRummyMeldBoard()
// already carries this same information to assistive tech (and to srSpeak
// via the existing 1-6/Review-melds flow) - this row must never be announced
// on its own, or a screen reader user would hear every meld twice. Clickable
// (mouse/touch only, same target-seat action as the Review melds button) but
// deliberately not given a tabindex, since interactive content shouldn't
// also be aria-hidden for keyboard/AT users - the Review melds button
// remains the keyboard/AT path to the same action.
function rummyBuildMeldCardsElement(group, seatIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'rummy-meld-cards';
  wrap.setAttribute('aria-hidden', 'true');
  rummyBuildMeldDisplayCards(group).forEach(function (card, index) {
    const img = document.createElement('img');
    img.className = 'rummy-meld-card-img' + (index > 0 ? ' rummy-meld-card-img-overlap' : '');
    img.src = rummyCardImageSrc(card);
    img.alt = '';
    wrap.appendChild(img);
  });
  bindPressNoFocus(wrap, function () { rummyReviewSeatMelds(seatIndex); });
  return wrap;
}

function renderRummyMeldBoard() {
  const board = document.getElementById('rummy-meld-board');
  if (!board || !appState.currentTable || !Array.isArray(appState.currentTable.players)) {
    return;
  }

  const sizeToggleBtn = document.getElementById('rummy-meld-size-toggle-btn');
  if (sizeToggleBtn) {
    sizeToggleBtn.textContent = appState.rummyMeldsEnlarged ? 'Shrink Melds' : 'Enlarge Melds';
    sizeToggleBtn.setAttribute('aria-pressed', appState.rummyMeldsEnlarged ? 'true' : 'false');
  }
  board.classList.toggle('rummy-melds-enlarged', !!appState.rummyMeldsEnlarged);

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

        // Accessible text description - kept off-screen (not display:none,
        // so it stays reachable by a screen reader's browse-mode cursor as
        // well as via srSpeak) rather than removed, per the requirement that
        // blind players see no change to the existing meld description.
        const label = document.createElement('span');
        label.className = 'visually-hidden';
        label.textContent = rummyMeldGroupLabel(group);
        li.appendChild(label);

        li.appendChild(rummyBuildMeldCardsElement(group, seatIndex));
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
  // rummy-hand's buttons use roving tabindex (never individually disabled),
  // same as hearts-client.js/spades-client.js's identical helper.
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

// --- Hand sort control -----------------------------------------------------
// Available whenever the hand is shown - a single real <button> whose label
// names the mode the player would switch TO, mirroring
// cribbage-client.js's renderCribbageSortControl()/cribbageToggleSortMode()
// exactly.

function renderRummySortControl() {
  const area = document.getElementById('rummy-sort-control');
  const button = document.getElementById('rummy-sort-toggle-btn');
  if (!area || !button) {
    return;
  }

  const active = appState.rummyPhase && appState.rummyPhase !== 'waiting' && appState.rummyHand.length > 0;
  area.classList.toggle('hidden', !active);
  if (!active) {
    return;
  }

  button.textContent = appState.rummySortMode === 'value' ? 'By suit' : 'By order';
}

// Sighted-only convenience for low-vision players - purely a display-size
// toggle on the meld card images (see .rummy-melds-enlarged in style.css).
// Does not affect the accessible text label, hotkeys, or any server state.
function rummyToggleMeldSize() {
  appState.rummyMeldsEnlarged = !appState.rummyMeldsEnlarged;
  renderRummyMeldBoard();
  srSpeak(appState.rummyMeldsEnlarged ? 'Melds enlarged.' : 'Melds back to default size.', 'polite', { canInterruptLock: true });
}

function rummyToggleSortMode() {
  appState.rummySortMode = appState.rummySortMode === 'value' ? 'suit' : 'value';
  // The hand-button rebuild is keyed off displayHand.join(',') (see
  // renderRummyHand()), which won't change on a re-sort since it's the same
  // cards in a new order - reset the key so the grid actually rebuilds.
  appState.rummyHandButtonsHandKey = null;
  renderRummyWidgets();
  srSpeak(
    'Hand sorted by ' + (appState.rummySortMode === 'suit' ? 'suit' : 'card value') + '.',
    'polite',
    { canInterruptLock: true }
  );
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
  // No aria-pressed here on purpose - it makes screen readers announce
  // "toggle button" on every arrow-key move through the hand. The
  // aria-label alone ("Eight of Clubs" / "Eight of Clubs, selected")
  // carries the selection state instead, per the accessibility fix
  // requested for blind players navigating the hand grid.
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-label', rummyCardName(card) + (selected ? ', selected' : ''));
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
    // Group Up/Down navigation by whichever key the hand is CURRENTLY sorted
    // by (rummySortMode, read fresh on every keypress via this closure) -
    // grouping by suit while the hand is actually sorted by value (or vice
    // versa) would jump between cards that aren't adjacent on screen, since
    // that key's same-value cards aren't contiguous in the other sort order.
    getGroupKey: function (button) {
      return appState.rummySortMode === 'suit' ? rummyCardSuit(button.dataset.card) : rummyCardRank(button.dataset.card);
    }
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

// Clears every marked card without rebuilding the hand grid (unlike a resort
// or a fresh rummyHand event) - so the currently focused button and its
// position stay exactly where they were, satisfying "focus/position must be
// preserved" for the U shortcut below. Harmless (and still announces) when
// nothing is marked.
function rummyUnmarkAllCards() {
  if (appState.rummySelectedCards.length) {
    appState.rummySelectedCards = [];
    const container = document.getElementById('rummy-hand');
    if (container) {
      Array.prototype.forEach.call(container.querySelectorAll('button'), function (button) {
        rummyUpdateHandButton(button, button.dataset.card);
      });
    }
    renderRummyControlButtons();
  }
  srSpeak('All cards unmarked.', 'polite', { canInterruptLock: true });
}

// --- Actions -------------------------------------------------------------

function rummyAttemptDrawStock() {
  socket.emit('rummyDrawStock');
}

function rummyAttemptDrawDiscard() {
  socket.emit('rummyDrawDiscard');
}

// Same underlying action for both the Draw Pile button and the E shortcut
// (see handleRummyKeys() below and rummyBindControls()) - server-authoritative,
// same as every other Rummy action here: no client-side legality pre-check,
// the server responds with a rummyDrawResult either way, giving accessible
// feedback via srSpeak (see that socket handler further down) when the
// action isn't currently available (wrong turn/phase, option off, or the
// pile is empty).
function rummyAttemptDrawPile() {
  socket.emit('rummyDrawDiscardPile');
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
  if (appState.rummySelectedCards.length > 0) {
    const message = appState.rummySelectedCards.length === 1
      ? 'Unselect the marked card before discarding.'
      : 'Unselect the ' + appState.rummySelectedCards.length + ' marked cards before discarding.';
    setTableStatus(message, 'alert');
    srSpeak(message, 'assertive', { canInterruptLock: true });
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

// Client-side duplicate of games/rummy/rules.js's canExtendMeld (pure,
// no io/table there either) - used only to decide whether L's "no cards
// marked, but one is focused" fallback (below) should treat that focused
// card as an implicit lay-off selection. The server's performLayOffCards
// remains the sole source of truth and re-validates independently either
// way - this is purely an informational pre-check to avoid a doomed
// round trip and to give the player specific feedback.
// Same "not stored explicitly" reasoning as games/rummy/rules.js's
// runEffectiveBounds() - a run's covered span (accounting for Jokers used as
// gap-fillers/extensions) is recomputed from its cards each time. Returns
// null if the group has no real card to anchor it.
function rummyRunEffectiveBounds(cards) {
  const jokerCount = cards.filter(rummyIsJoker).length;
  const realCards = cards.filter(function (c) { return !rummyIsJoker(c); });
  if (!realCards.length) {
    return null;
  }
  const values = realCards.map(rummyRankOrderValue).sort(function (a, b) { return a - b; });
  let min = values[0];
  let max = values[values.length - 1];
  let leftover = jokerCount - ((max - min + 1) - values.length);
  while (leftover > 0) {
    if (min > 1) {
      min--;
    } else if (max < 13) {
      max++;
    } else {
      break;
    }
    leftover--;
  }
  return { min: min, max: max };
}

function rummyCardCanExtendGroup(card, group) {
  if (!group || !Array.isArray(group.cards) || !group.cards.length) {
    return false;
  }
  if (group.type === 'set') {
    if (group.cards.length >= 4) {
      return false;
    }
    if (rummyIsJoker(card)) {
      return true;
    }
    const realCards = group.cards.filter(function (c) { return !rummyIsJoker(c); });
    if (!realCards.length || rummyCardRank(card) !== rummyCardRank(realCards[0])) {
      return false;
    }
    return !realCards.some(function (c) { return rummyCardSuit(c) === rummyCardSuit(card); });
  }
  if (group.type === 'run') {
    const bounds = rummyRunEffectiveBounds(group.cards);
    if (!bounds) {
      return false;
    }
    if (rummyIsJoker(card)) {
      return bounds.min > 1 || bounds.max < 13;
    }
    const realCards = group.cards.filter(function (c) { return !rummyIsJoker(c); });
    if (rummyCardSuit(card) !== rummyCardSuit(realCards[0])) {
      return false;
    }
    const cardValue = rummyRankOrderValue(card);
    return cardValue === bounds.min - 1 || cardValue === bounds.max + 1;
  }
  return false;
}

// Client-side duplicate of games/rummy/rules.js's findJokerSwapTarget - a
// real card that matches exactly what a Joker in `group` is standing in for
// may swap it out (the Joker returns to hand, the real card takes its
// place), even when rummyCardCanExtendGroup() above says no (e.g. a run slot
// a Joker already fills). Same "informational pre-check only" caveat as
// rummyCardCanExtendGroup - the server remains the sole source of truth.
function rummyFindJokerSwapTarget(card, group) {
  if (!group || !Array.isArray(group.cards) || rummyIsJoker(card)) {
    return null;
  }
  const jokers = group.cards.filter(rummyIsJoker);
  if (!jokers.length) {
    return null;
  }
  const realCards = group.cards.filter(function (c) { return !rummyIsJoker(c); });
  if (!realCards.length) {
    return null;
  }

  if (group.type === 'set') {
    if (rummyCardRank(card) !== rummyCardRank(realCards[0])) {
      return null;
    }
    const suit = rummyCardSuit(card);
    return realCards.some(function (c) { return rummyCardSuit(c) === suit; }) ? null : jokers[0];
  }

  if (group.type === 'run') {
    if (rummyCardSuit(card) !== rummyCardSuit(realCards[0])) {
      return null;
    }
    const bounds = rummyRunEffectiveBounds(group.cards);
    if (!bounds) {
      return null;
    }
    const cardPosition = rummyRankOrderValue(card);
    if (cardPosition < bounds.min || cardPosition > bounds.max) {
      return null;
    }
    return realCards.some(function (c) { return rummyRankOrderValue(c) === cardPosition; }) ? null : jokers[0];
  }

  return null;
}

function rummyCardCanExtendAnyGroup(card, groups) {
  if (!Array.isArray(groups)) {
    return false;
  }
  return groups.some(function (group) { return rummyCardCanExtendGroup(card, group) || rummyFindJokerSwapTarget(card, group); });
}

function rummyGetFocusedHandCard() {
  const container = document.getElementById('rummy-hand');
  const focused = document.activeElement;
  if (!container || !focused || !container.contains(focused) || !focused.dataset) {
    return null;
  }
  return focused.dataset.card || null;
}

function rummyCommitLayoff() {
  if (appState.rummyLayoffTargetSeat === null) {
    srSpeak('Review a player’s melds first - press 1 through 6', 'assertive', { canInterruptLock: true });
    return;
  }

  let cards = appState.rummySelectedCards.slice();

  if (!cards.length) {
    const focusedCard = rummyGetFocusedHandCard();
    const groups = appState.rummyMelds[appState.rummyLayoffTargetSeat] || [];
    if (focusedCard && rummyCardCanExtendAnyGroup(focusedCard, groups)) {
      appState.rummySelectedCards = [focusedCard];
      cards = [focusedCard];
      renderRummyHand();
      srSpeak('Marked ' + rummyCardName(focusedCard) + ' for lay off.', 'polite', { canInterruptLock: true });
    } else if (focusedCard) {
      srSpeak(rummyCardName(focusedCard) + ' cannot be laid off on that player’s melds.', 'assertive', { canInterruptLock: true });
      return;
    } else {
      srSpeak('Select at least one card to lay off', 'assertive', { canInterruptLock: true });
      return;
    }
  }

  socket.emit('rummyLayOffCards', { targetPlayerIndex: appState.rummyLayoffTargetSeat, cards: cards });
}

// --- Control buttons (mouse equivalents of the keyboard shortcuts) -----------

function renderRummyControlButtons() {
  const myTurn = isRummyMyTurn();
  const drawPhase = myTurn && appState.rummyTurnPhase === 'draw';
  const actionPhase = myTurn && appState.rummyTurnPhase === 'action';

  const drawStockBtn = document.getElementById('rummy-draw-stock-btn');
  const drawDiscardBtn = document.getElementById('rummy-draw-discard-btn');
  const drawPileBtn = document.getElementById('rummy-draw-pile-btn');
  const meldBtn = document.getElementById('rummy-meld-btn');
  const layoffBtn = document.getElementById('rummy-layoff-btn');
  const discardBtn = document.getElementById('rummy-discard-btn');
  const unmarkBtn = document.getElementById('rummy-unmark-btn');

  if (drawStockBtn) {
    drawStockBtn.disabled = !drawPhase;
  }
  if (drawDiscardBtn) {
    drawDiscardBtn.disabled = !drawPhase || !appState.rummyDiscardTop;
  }
  if (drawPileBtn) {
    // The "Allow Drawing Entire Discard Pile" table option, off by default -
    // see games/rummy/index.js's normalizeMatchSettings(). Hidden entirely
    // when the table doesn't have it on (nothing to offer), disabled
    // whenever taking the pile isn't currently legal - same visible/enabled
    // split as every other option-gated Rummy control.
    const allowDrawEntirePile = !!(appState.currentTable && appState.currentTable.matchSettings && appState.currentTable.matchSettings.allowDrawEntirePile);
    drawPileBtn.classList.toggle('hidden', !allowDrawEntirePile);
    drawPileBtn.disabled = !drawPhase || !appState.rummyDiscardTop;
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
  if (unmarkBtn) {
    unmarkBtn.disabled = !appState.rummySelectedCards.length;
  }
}

// --- Top-level render --------------------------------------------------------

function renderRummyWidgets() {
  renderRummyStatus();
  renderRummyPileVisual();
  renderRummyMeldBoard();
  renderRummySortControl();
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
  const text = appState.rummyDiscardTop ? (rummyCardName(appState.rummyDiscardTop) + '.') : 'The discard pile is empty.';
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
  } else if (key === 'e') {
    rummyAttemptDrawPile();
    event.preventDefault();
  } else if (key === 'm') {
    rummyCommitMeld();
    event.preventDefault();
  } else if (key === 'l') {
    rummyCommitLayoff();
    event.preventDefault();
  } else if (key === 'u') {
    rummyUnmarkAllCards();
    event.preventDefault();
  } else if (key === 's' && event.shiftKey) {
    announceRummyAllScores();
    event.preventDefault();
  } else if (key === 's') {
    announceRummyOwnScore();
    event.preventDefault();
  } else if (key === 'g') {
    if (appState.rummyPhase && appState.rummyPhase !== 'waiting' && appState.rummyHand.length > 0) {
      rummyToggleSortMode();
    }
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

  // Rummy's turns are strictly sequential (unlike Hearts/Spades' four-way
  // trick play, only one seat is ever waiting to act) - the moment turnPhase
  // is 'draw' and this client is that seat, that's the start of a brand new
  // turn for this player (their own subsequent meld/lay-off actions stay in
  // 'action' phase and don't retrigger this), so move focus onto the hand
  // grid the same way spadesTurnState moves focus onto #spades-hand in
  // spades-client.js. It lands on the HAND (not the draw controls) because a
  // blind player's first instinct on hearing "It is your turn." is to
  // Left/Right through their cards to decide what to do before drawing - see
  // rummyFocusHand()/#rummy-hand's aria-label. Without this, a blind player
  // never has focus land back in the game table when their turn begins -
  // they'd hear the turn announcement but have to press F to reach the cards.
  // This covers hand start too, since beginHand's first emitRummyTurnState
  // call (games/rummy/index.js) is itself turnPhase 'draw' for whichever
  // seat goes first.
  if (payload.turnPlayerId === socket.id && payload.turnPhase === 'draw') {
    window.requestAnimationFrame(function () {
      rummyFocusHand();
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
  if (payload.source === 'pile') {
    const count = Array.isArray(payload.cards) ? payload.cards.length : 0;
    srSpeak('You draw the discard pile, ' + count + ' card' + (count === 1 ? '' : 's') + ' added to your hand.', 'polite', { canInterruptLock: true });
  } else {
    srSpeak('You drew ' + rummyCardName(payload.card) + ' from the ' + payload.source + '.', 'polite', { canInterruptLock: true });
  }
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
  const jokerCount = (payload.returnedJokers || []).length;
  const message = jokerCount
    ? 'Lay-off complete. You take the Joker' + (jokerCount > 1 ? 's' : '') + ' into your hand.'
    : 'Lay-off complete.';
  srSpeak(message, 'polite', { canInterruptLock: true });
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
  bindPress(document.getElementById('rummy-sort-toggle-btn'), rummyToggleSortMode);
  bindPress(document.getElementById('rummy-meld-size-toggle-btn'), rummyToggleMeldSize);
  bindPress(document.getElementById('rummy-draw-stock-btn'), rummyAttemptDrawStock);
  bindPress(document.getElementById('rummy-draw-discard-btn'), rummyAttemptDrawDiscard);
  bindPress(document.getElementById('rummy-draw-pile-btn'), rummyAttemptDrawPile);
  bindPress(document.getElementById('rummy-meld-btn'), rummyCommitMeld);
  bindPress(document.getElementById('rummy-layoff-btn'), rummyCommitLayoff);
  bindPress(document.getElementById('rummy-discard-btn'), rummyAttemptDiscardSelected);
  bindPress(document.getElementById('rummy-unmark-btn'), rummyUnmarkAllCards);
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
