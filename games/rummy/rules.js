// Pure Rummy rules engine: deck, deal, meld/run validation, meld extension
// (lay-off) legality, stock-exhaustion reshuffle data, and deadwood/hand
// scoring. No io/socket/table references anywhere in this file on purpose -
// every function here takes plain data in and returns plain data out, so it
// can be unit tested directly (see tests/rummy-rules.test.js) without
// spawning a server.
//
// Card representation: a two-character string that is also the asset
// filename stem in public/images/playing-cards/ (e.g. "QS" = Queen of
// Spades = QS.svg), the same model games/hearts/rules.js and
// games/spades/rules.js use. Rank chars: 2-9, T (ten), J, Q, K, A. Suit
// chars: C (clubs), D (diamonds), H (hearts), S (spades).
//
// House rule / open-question resolutions (basic Rummy per pagat.com does not
// pin these down definitively, so this implementation picks one and
// documents it - see public/rummy-rules.md for the player-facing version):
//   - Runs are ace-low only (A-2-3 is a run, Q-K-A is not) - the simplest,
//     most common basic-Rummy convention, and it avoids an "ace both high
//     and low" ambiguity pagat.com leaves open.
//   - No minimum-point requirement to lay down a first meld (unlike Gin
//     Rummy) - any valid set/run may be melded the moment a player holds one.
//   - Laying off is allowed onto ANY player's existing melds, including your
//     own, not just melds you personally laid down.
//   - The deck includes 2 Jokers (standard basic-Rummy practice, per
//     pagat.com), which are wild: a Joker may stand in for any card in a set
//     or run, in place of a real card of that suit/rank. A meld still needs
//     at least one real card to anchor its rank (set) or suit (run) - a
//     group made entirely of Jokers is not allowed, since there would be
//     nothing to declare its identity. A Joker left in a player's hand when
//     a hand ends counts as JOKER_DEADWOOD_VALUE (15) deadwood - higher than
//     any real card - since it is the most valuable card to be caught
//     holding.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];
const RANK_NAMES = {
  '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven',
  '8': 'Eight', '9': 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

// Jokers use suit char 'J' (never used by a real suit - see SUITS above),
// which doubles as a cheap, unambiguous discriminator (isJoker()) without
// needing a separate "is this a joker" flag threaded through every card
// value. Rank chars '1'/'2' just distinguish the two physical Jokers; they
// carry no meaning otherwise (a Joker's effective rank/suit is whatever a
// meld needs it to be).
const JOKER_CARDS = ['1J', '2J'];
const JOKER_SUIT_CHAR = 'J';
const JOKER_DEADWOOD_VALUE = 15;

function isJoker(card) {
  return typeof card === 'string' && card.charAt(1) === JOKER_SUIT_CHAR;
}

// Deadwood/scoring value: ace is 1 by default (ace-low-only tables), or 11
// when the table's aceHighOrLow option is on (see the "Ace High or Low"
// section in the header and cardValue() below) - face cards are all 10,
// everything else is its pip value.
const CARD_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 10, Q: 10, K: 10, A: 1
};
const ACE_LOW_DEADWOOD_VALUE = 1;
const ACE_HIGH_DEADWOOD_VALUE = 11;

// Ordinal rank position for run-adjacency purposes only, ace low, no
// wraparound (see the header comment above). This remains the ONLY mapping
// used for sorting/display and for any table that doesn't enable the
// aceHighOrLow option. See ACE_LOW_ORDER_VALUE/ACE_HIGH_ORDER_VALUE and the
// runOrderValue()/computeRunBoundsForMode() helpers further below for how a
// table with aceHighOrLow enabled additionally allows an Ace to anchor the
// TOP of a run (Q-K-A) without ever permitting a wraparound run (K-A-2).
const RANK_ORDER_VALUES = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13
};

// --- Ace High or Low (optional table rule) ----------------------------------
// Default (option off): an Ace is low-only, exactly like RANK_ORDER_VALUES
// above (order value 1, deadwood value 1) - no behavior change for tables
// that don't enable this option.
//
// When games/rummy/index.js's matchSettings.aceHighOrLow is on, a run's Ace
// may instead anchor the TOP of the suit (Q-K-A), worth 11 deadwood in that
// case. Modeled as two independent "modes" a run can be validated under:
// mode ACE_LOW_ORDER_VALUE (1) is the everyday case above; mode
// ACE_HIGH_ORDER_VALUE (14) reassigns the Ace's order value to sit
// immediately above King (13) instead of immediately below 2. A run is
// legal if EITHER mode validates it (see isValidRun() below) - never both at
// once, since only one physical Ace exists per suit, which is exactly what
// rules out a wraparound run: K-A-2 would need the Ace simultaneously above
// King (mode 14) AND below 2 (mode 1), which no single mode can satisfy (see
// computeRunBoundsForMode()'s per-mode domain clamp).
const ACE_LOW_ORDER_VALUE = 1;
const ACE_HIGH_ORDER_VALUE = 14;

// Which Ace-position modes are worth trying for a run, per the table's
// aceHighOrLow setting - just [1] (unchanged behavior) when the option is
// off or unset.
function aceRunModes(options) {
  return options && options.aceHighOrLow ? [ACE_LOW_ORDER_VALUE, ACE_HIGH_ORDER_VALUE] : [ACE_LOW_ORDER_VALUE];
}

// A real card's order value under a specific Ace-position mode - only an
// Ace's value actually depends on `mode`; every other rank keeps its normal
// RANK_ORDER_VALUES entry regardless.
function runOrderValue(card, mode) {
  return rankOf(card) === 'A' ? mode : RANK_ORDER_VALUES[rankOf(card)];
}

// The legal order-value window for a given mode - mode 1 (ace-low) permits
// 1-13 (unchanged from before this option existed); mode 14 (ace-high)
// shifts the SAME 13-slot window up by one, to 2-14, so "2" is still the
// lowest real card and "14" (the Ace) is the highest. A leftover Joker can
// only ever extend a run out to these bounds - never past them - which is
// what keeps a run from ever wrapping past the suit's real top or bottom.
function runDomainForMode(mode) {
  return mode === ACE_HIGH_ORDER_VALUE ? { min: 2, max: 14 } : { min: 1, max: 13 };
}

// Core "does this bag of real+joker cards form one legal run under this
// specific Ace mode" check, shared by isValidRun() (which just needs a
// yes/no across every applicable mode) and runGroupBoundsList() (which needs
// the resulting min/max span, e.g. to decide what a Joker in an
// already-on-the-table run currently represents). Returns null when the
// mode doesn't validate; otherwise { min, max, mode } describing the run's
// effective span under that mode (min/max already account for any leftover
// Jokers extending either end, same as the old runEffectiveBounds()).
function computeRunBoundsForMode(nonJokerCards, jokerCount, mode) {
  const values = nonJokerCards.map(function (card) { return runOrderValue(card, mode); }).sort(function (a, b) { return a - b; });
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) {
      return null;
    }
  }
  const min = values[0];
  const max = values[values.length - 1];
  const domain = runDomainForMode(mode);
  const internalGapsNeeded = (max - min + 1) - values.length;
  if (internalGapsNeeded > jokerCount) {
    return null;
  }
  let leftover = jokerCount - internalGapsNeeded;
  let effMin = min;
  let effMax = max;
  while (leftover > 0) {
    if (effMin > domain.min) {
      effMin--;
    } else if (effMax < domain.max) {
      effMax++;
    } else {
      return null;
    }
    leftover--;
  }
  return { min: effMin, max: effMax, mode: mode };
}

// Every Ace-position mode under which `cards` (a run group's full card list,
// real + Joker) currently forms a legal run - usually exactly one entry, but
// a Joker-heavy group with no cards that pin it to one interpretation (e.g.
// a lone Ace plus two Jokers) can legally validate under more than one, same
// "genuinely ambiguous" territory the header comment already documents for
// a Joker's exact position. canExtendMeld()/findJokerSwapTarget() below
// check every returned mode and accept if ANY of them allow the requested
// extension/swap - the same "accept if any legal interpretation permits it"
// approach the rest of this file already takes toward Joker ambiguity, and
// it's what keeps e.g. a swap-in Ace correctly routed to findJokerSwapTarget
// (the slot a Joker is already occupying) rather than canExtendMeld (which
// only ever grows a group).
function runGroupBoundsList(cards, options) {
  if (!Array.isArray(cards) || !cards.length) {
    return [];
  }
  const nonJokers = cards.filter(function (card) { return !isJoker(card); });
  const jokerCount = cards.length - nonJokers.length;
  if (!nonJokers.length) {
    return [];
  }
  const results = [];
  aceRunModes(options).forEach(function (mode) {
    const bounds = computeRunBoundsForMode(nonJokers, jokerCount, mode);
    if (bounds) {
      results.push({ min: bounds.min, max: bounds.max, mode: mode, domain: runDomainForMode(mode) });
    }
  });
  return results;
}

const MIN_SET_SIZE = 3;
const MAX_SET_SIZE = 4;
const MIN_RUN_SIZE = 3;

function createDeck() {
  const deck = [];
  SUITS.forEach(function (suit) {
    RANKS.forEach(function (rank) {
      deck.push(rank + suit);
    });
  });
  JOKER_CARDS.forEach(function (card) {
    deck.push(card);
  });
  return deck;
}

function rankOf(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function suitOf(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

// options.aceHighOrLow flips an Ace's deadwood value from 1 to 11 (see the
// "Ace High or Low" section above) - every other card's value is unaffected.
function cardValue(card, options) {
  if (isJoker(card)) {
    return JOKER_DEADWOOD_VALUE;
  }
  if (rankOf(card) === 'A') {
    return options && options.aceHighOrLow ? ACE_HIGH_DEADWOOD_VALUE : ACE_LOW_DEADWOOD_VALUE;
  }
  return CARD_VALUES[rankOf(card)] || 0;
}

// Ace-low rank position (see header) - meaningless for a Joker (it has no
// fixed rank), so callers must only invoke this on a real card. Every place
// in this file that might see a Joker filters it out first.
function rankOrderValue(card) {
  return RANK_ORDER_VALUES[rankOf(card)] || 0;
}

function suitName(suit) {
  return SUIT_NAMES[suit] || 'cards';
}

function cardName(card) {
  if (isJoker(card)) {
    return 'Joker';
  }
  const rank = RANK_NAMES[rankOf(card)];
  const suit = SUIT_NAMES[suitOf(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

const SUIT_SORT_ORDER = { C: 0, D: 1, H: 2, S: 3 };
// Sorted after Spades/King respectively, so Jokers land at the end of a
// freshly dealt hand rather than colliding with the "unknown suit/rank"
// fallback of 0 (which would otherwise sort them before the Ace).
const JOKER_SORT_SUIT_VALUE = 4;
const JOKER_SORT_RANK_VALUE = 14;

function sortSuitValue(card) {
  return isJoker(card) ? JOKER_SORT_SUIT_VALUE : SUIT_SORT_ORDER[suitOf(card)];
}

function sortRankValue(card) {
  return isJoker(card) ? JOKER_SORT_RANK_VALUE : rankOrderValue(card);
}

function sortHand(hand) {
  return hand.slice().sort(function (a, b) {
    const suitDiff = sortSuitValue(a) - sortSuitValue(b);
    if (suitDiff !== 0) {
      return suitDiff;
    }
    return sortRankValue(a) - sortRankValue(b);
  });
}

// 10 cards each for a 2-player table, 7 each for 3-6 players - per
// pagat.com's basic Rummy deal sizes.
function dealSizeForPlayerCount(playerCount) {
  return playerCount === 2 ? 10 : 7;
}

// deck must already be a shuffled array of the DECK_SIZE (54, including the
// 2 Jokers) unique cards from createDeck() - randomness is intentionally
// kept out of this pure module (see games/rummy/index.js, which shuffles
// via the shared deps.shuffle before calling this). Deals
// dealSizeForPlayerCount(playerCount) cards round-robin per player, then one
// further card face-up to start the discard pile; everything left over
// becomes the stock. Returns { hands, stock, discard } - discard is an
// array whose LAST element is the visible top card (same "top = last
// element" convention as games/lumo/index.js's discard pile).
const DECK_SIZE = SUITS.length * RANKS.length + JOKER_CARDS.length;

function deal(shuffledDeck, playerCount) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== DECK_SIZE) {
    throw new Error('deal() requires a shuffled ' + DECK_SIZE + '-card deck');
  }
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6) {
    throw new Error('deal() requires a player count between 2 and 6');
  }

  const dealSize = dealSizeForPlayerCount(playerCount);
  const hands = [];
  for (let p = 0; p < playerCount; p++) {
    hands.push([]);
  }

  let cursor = 0;
  for (let round = 0; round < dealSize; round++) {
    for (let p = 0; p < playerCount; p++) {
      hands[p].push(shuffledDeck[cursor]);
      cursor++;
    }
  }

  const discard = [shuffledDeck[cursor]];
  cursor++;

  return {
    hands: hands.map(sortHand),
    stock: shuffledDeck.slice(cursor),
    discard: discard
  };
}

// 3 or 4 cards, all the same rank, all different suits (a standard deck can
// never produce a same-rank duplicate-suit hand, but a defensive check costs
// nothing). Any Jokers in the group are wild and simply fill out the
// remaining suit slots - the size cap (MAX_SET_SIZE) already guarantees
// there's room for them, so no separate Joker-count check is needed. At
// least one real card is required to anchor the set's rank (see header).
function isValidSet(cards) {
  if (!Array.isArray(cards) || cards.length < MIN_SET_SIZE || cards.length > MAX_SET_SIZE) {
    return false;
  }
  const nonJokers = cards.filter(function (card) { return !isJoker(card); });
  if (!nonJokers.length) {
    return false;
  }
  const rank = rankOf(nonJokers[0]);
  const seenSuits = new Set();
  return nonJokers.every(function (card) {
    if (rankOf(card) !== rank) {
      return false;
    }
    const suit = suitOf(card);
    if (seenSuits.has(suit)) {
      return false;
    }
    seenSuits.add(suit);
    return true;
  });
}

// 3+ cards, all the same suit, consecutive ranks. Ace-low only (A-2-3) by
// default; when options.aceHighOrLow is set, an Ace may instead anchor the
// top of the suit (Q-K-A) - see the "Ace High or Low" section above for how
// that's modeled, and why it can never produce a wraparound run (K-A-2).
// Jokers are wild: they fill gaps between the real cards' ranks, and any
// left over extend the span at either end, as long as there's room within
// the applicable mode's bound. At least one real card is required to anchor
// the run's suit (see header).
function isValidRun(cards, options) {
  if (!Array.isArray(cards) || cards.length < MIN_RUN_SIZE) {
    return false;
  }
  const nonJokers = cards.filter(function (card) { return !isJoker(card); });
  const jokerCount = cards.length - nonJokers.length;
  if (!nonJokers.length) {
    return false;
  }
  const suit = suitOf(nonJokers[0]);
  if (!nonJokers.every(function (card) { return suitOf(card) === suit; })) {
    return false;
  }

  return aceRunModes(options).some(function (mode) {
    return computeRunBoundsForMode(nonJokers, jokerCount, mode) !== null;
  });
}

function classifyMeld(cards, options) {
  if (isValidSet(cards)) {
    return { valid: true, type: 'set' };
  }
  if (isValidRun(cards, options)) {
    return { valid: true, type: 'run' };
  }
  return { valid: false };
}

// meldGroup: { type: 'set'|'run', cards: [...] } - an existing melded group
// already on the table. Returns true if `card` could legally be added to it.
// `card` itself may be a Joker (wild) or a real card extending a group that
// already contains a Joker (or both) - see isValidSet()/isValidRun() above
// for how Jokers factor into a group's rank/suit identity.
function canExtendMeld(meldGroup, card, options) {
  if (!meldGroup || !Array.isArray(meldGroup.cards) || !meldGroup.cards.length) {
    return false;
  }

  if (meldGroup.type === 'set') {
    if (meldGroup.cards.length >= MAX_SET_SIZE) {
      return false;
    }
    if (isJoker(card)) {
      // A Joker fills whatever suit slot is left - there's always one
      // available since the group isn't at MAX_SET_SIZE yet.
      return true;
    }
    const nonJokers = meldGroup.cards.filter(function (c) { return !isJoker(c); });
    if (!nonJokers.length) {
      return false;
    }
    const rank = rankOf(nonJokers[0]);
    if (rankOf(card) !== rank) {
      return false;
    }
    const suit = suitOf(card);
    return !nonJokers.some(function (c) { return suitOf(c) === suit; });
  }

  if (meldGroup.type === 'run') {
    // See runGroupBoundsList()'s header - a group can validate under more
    // than one Ace-position mode in rare Joker-heavy cases, so an extension
    // is accepted if ANY applicable mode allows it.
    const boundsList = runGroupBoundsList(meldGroup.cards, options);
    if (!boundsList.length) {
      return false;
    }
    if (isJoker(card)) {
      return boundsList.some(function (bounds) { return bounds.min > bounds.domain.min || bounds.max < bounds.domain.max; });
    }
    const nonJokers = meldGroup.cards.filter(function (c) { return !isJoker(c); });
    const suit = suitOf(nonJokers[0]);
    if (suitOf(card) !== suit) {
      return false;
    }
    return boundsList.some(function (bounds) {
      const cardValueOrder = runOrderValue(card, bounds.mode);
      return cardValueOrder === bounds.min - 1 || cardValueOrder === bounds.max + 1;
    });
  }

  return false;
}

// A "joker swap" lay-off (see public/rummy-rules.md): a real card that
// matches exactly what a Joker in `meldGroup` is currently standing in for
// may take that Joker's place - the Joker comes off the table and into the
// laying-off player's hand, and `card` fills the slot instead. This is a
// distinct case from canExtendMeld() above, which only ever grows a group;
// here the group's size is unchanged, so it applies even when a set is
// already at MAX_SET_SIZE. Returns the specific Joker card to hand back, or
// null if `card` doesn't match any Joker's slot in this group (including
// when meldGroup has no Joker at all, or `card` is itself a Joker - a Joker
// can never swap out another Joker).
function findJokerSwapTarget(meldGroup, card, options) {
  if (!meldGroup || !Array.isArray(meldGroup.cards) || isJoker(card)) {
    return null;
  }
  const jokers = meldGroup.cards.filter(isJoker);
  if (!jokers.length) {
    return null;
  }
  const nonJokers = meldGroup.cards.filter(function (c) { return !isJoker(c); });
  if (!nonJokers.length) {
    return null;
  }

  if (meldGroup.type === 'set') {
    if (rankOf(nonJokers[0]) !== rankOf(card)) {
      return null;
    }
    const suit = suitOf(card);
    const suitTaken = nonJokers.some(function (c) { return suitOf(c) === suit; });
    return suitTaken ? null : jokers[0];
  }

  if (meldGroup.type === 'run') {
    const suit = suitOf(nonJokers[0]);
    if (suitOf(card) !== suit) {
      return null;
    }
    const boundsList = runGroupBoundsList(meldGroup.cards, options);
    for (let i = 0; i < boundsList.length; i++) {
      const bounds = boundsList[i];
      const cardPosition = runOrderValue(card, bounds.mode);
      if (cardPosition < bounds.min || cardPosition > bounds.max) {
        continue;
      }
      const positionTaken = nonJokers.some(function (c) { return runOrderValue(c, bounds.mode) === cardPosition; });
      if (!positionTaken) {
        return jokers[0];
      }
    }
    return null;
  }

  return null;
}

// Given an existing meld group and a pool of "candidate" cards a player has
// selected (e.g. games/rummy/index.js's performLayOffCards() `cards`
// payload, after any exact Joker swaps - see findJokerSwapTarget() above -
// have already been pulled out), finds the largest subset of those
// candidates that can legally join the group as a single batch. Validity is
// decided entirely by isValidSet()/isValidRun() above - the same single
// source of truth every other meld-legality decision in this file uses -
// never a separate/duplicate notion of what a Joker can represent.
//
// This exists because deciding a Joker's role one candidate card at a time
// (the old behavior - "does canExtendMeld() say yes to THIS card, right
// now") locks in whichever position runEffectiveBounds() happens to pick as
// soon as the Joker is considered, even when a different position would
// have let more of the SAME selection attach. Example: against an existing
// 5S-6S-7S run, selecting a Joker plus 9S needs the Joker to represent 8S so
// 9S can also land - but a card-by-card pass sees the Joker first, and
// runEffectiveBounds()'s "extend the low end first" convention assigns it
// 4S, stranding 9S. Trying the group as a whole against every candidate
// subset removes that ordering dependency: whether a subset is legal is
// decided once, on the fully-formed result, exactly like a brand-new meld
// is checked by classifyMeld().
//
// candidateCards is expected to be small (a hand is at most ~13 cards, and a
// single lay-off selection is normally far smaller), so brute-forcing every
// subset (2^n) is simpler and cheap, rather than a bespoke constraint
// solver.
//
// Ties (more than one legal subset of the same maximum size) are broken by,
// in order: fewer Jokers spent (never substitute a Joker for a real card the
// selection already supplies), then whichever subset is found first
// scanning from "every candidate included" down to "just one" (a stable,
// deterministic, but otherwise arbitrary choice - a Joker's exact
// represented card is genuinely ambiguous once more than one legal option
// ties, same as runEffectiveBounds()'s own tie-break above).
//
// Both games/rummy/index.js's performLayOffCards() (human intent: maximize
// how much of what the player selected can legally land) and
// games/rummy/bots.js (bot strategy: generate a candidate play per group,
// then score across groups/new-melds) call this - see this file's header
// and games/rummy/bots.js's header for why the two must share one engine
// instead of forming independent opinions about Joker legality.
function findBestJokerAssignment(meldGroup, candidateCards, options) {
  if (!meldGroup || !Array.isArray(meldGroup.cards) || !meldGroup.cards.length) {
    return { cards: [] };
  }
  const validate = meldGroup.type === 'set'
    ? isValidSet
    : meldGroup.type === 'run'
      ? function (cards) { return isValidRun(cards, options); }
      : null;
  const pool = Array.isArray(candidateCards) ? candidateCards.filter(function (c) { return typeof c === 'string'; }) : [];
  if (!validate || !pool.length) {
    return { cards: [] };
  }

  const n = pool.length;
  let best = null;
  for (let mask = (1 << n) - 1; mask >= 1; mask--) {
    const subset = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.push(pool[i]);
      }
    }
    if (!validate(meldGroup.cards.concat(subset))) {
      continue;
    }
    const jokerCount = subset.filter(isJoker).length;
    if (!best || subset.length > best.cards.length || (subset.length === best.cards.length && jokerCount < best.jokerCount)) {
      best = { cards: subset, jokerCount: jokerCount };
    }
  }
  return best ? { cards: best.cards } : { cards: [] };
}

function isStockExhausted(stock) {
  return !Array.isArray(stock) || stock.length === 0;
}

// discardPile: array whose last element is the visible top card. When the
// stock runs out, standard Rummy reshuffles every discard EXCEPT the top
// card into a fresh stock. This function stays pure/unshuffled on purpose
// (same separation as deal() above) - it returns the candidate new stock in
// its existing (unshuffled) order, plus the discard pile reduced to just its
// top card; the caller (games/rummy/index.js) must shuffle result.stock via
// deps.shuffle before assigning it to table.game.stock.
function reshuffleDiscardIntoStock(discardPile) {
  if (!Array.isArray(discardPile) || !discardPile.length) {
    return { stock: [], discard: [] };
  }
  const topCard = discardPile[discardPile.length - 1];
  return {
    stock: discardPile.slice(0, discardPile.length - 1),
    discard: [topCard]
  };
}

// hands: array indexed by seat, each player's cards remaining IN HAND (not
// melded/laid off) at the moment the hand ended. wentOutPlayerIndex's hand
// should already be empty. Returns { deadwoodByPlayer: [...],
// pointsAwarded: [...] } - the winner is awarded the sum of every other
// player's deadwood; everyone else scores 0 for this hand. Pure function -
// games/rummy/index.js is responsible for adding pointsAwarded onto
// table.scores.
function scoreHand(hands, wentOutPlayerIndex, options) {
  const deadwoodByPlayer = hands.map(function (hand) {
    return (hand || []).reduce(function (sum, card) { return sum + cardValue(card, options); }, 0);
  });

  const pointsAwarded = hands.map(function () { return 0; });
  const totalDeadwood = deadwoodByPlayer.reduce(function (sum, value, index) {
    return index === wentOutPlayerIndex ? sum : sum + value;
  }, 0);
  pointsAwarded[wentOutPlayerIndex] = totalDeadwood;

  return { deadwoodByPlayer: deadwoodByPlayer, pointsAwarded: pointsAwarded };
}

function isGameOver(scores, targetScore) {
  return scores.some(function (score) { return score >= targetScore; });
}

function getWinnerIndex(scores) {
  let winnerIndex = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[winnerIndex]) {
      winnerIndex = i;
    }
  }
  return winnerIndex;
}

module.exports = {
  RANKS: RANKS,
  SUITS: SUITS,
  JOKER_CARDS: JOKER_CARDS,
  JOKER_DEADWOOD_VALUE: JOKER_DEADWOOD_VALUE,
  isJoker: isJoker,
  createDeck: createDeck,
  rankOf: rankOf,
  suitOf: suitOf,
  cardValue: cardValue,
  rankOrderValue: rankOrderValue,
  ACE_LOW_ORDER_VALUE: ACE_LOW_ORDER_VALUE,
  ACE_HIGH_ORDER_VALUE: ACE_HIGH_ORDER_VALUE,
  runOrderValue: runOrderValue,
  cardName: cardName,
  suitName: suitName,
  sortHand: sortHand,
  dealSizeForPlayerCount: dealSizeForPlayerCount,
  deal: deal,
  isValidSet: isValidSet,
  isValidRun: isValidRun,
  classifyMeld: classifyMeld,
  canExtendMeld: canExtendMeld,
  findJokerSwapTarget: findJokerSwapTarget,
  findBestJokerAssignment: findBestJokerAssignment,
  isStockExhausted: isStockExhausted,
  reshuffleDiscardIntoStock: reshuffleDiscardIntoStock,
  scoreHand: scoreHand,
  isGameOver: isGameOver,
  getWinnerIndex: getWinnerIndex
};
