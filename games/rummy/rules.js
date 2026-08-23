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

  // Once a meld has a stored `jokers` assignment map (see resolveMeld()/
  // resolveGroupExtension() below - every meld created or extended through
  // this module's newer entry points carries one), a Joker's represented
  // card is authoritative and fixed - swap eligibility is then a simple
  // exact-match lookup, not a re-derived "does an unused slot exist" guess.
  // This is what makes rule 9/10 correct: a set's Joker(8) can only be
  // swapped by the exact 8 it represents, never treated as an unrestricted
  // wildcard just because a same-rank different-suit card is also legal to
  // ADD to the set (that's canExtendMeld()'s job, a distinct operation).
  if (meldGroup.jokers) {
    if (meldGroup.type === 'set') {
      // A set Joker's stored identity is rank-only (see
      // assignSetJokerRanks() below) - it never reserves a specific suit
      // (rule: "Do Not Treat a Set Joker as a Missing Specific Suit"). Any
      // card of the matching rank may replace it, as long as that suit isn't
      // already occupied by one of the set's REAL cards.
      const nonJokers = meldGroup.cards.filter(function (c) { return !isJoker(c); });
      if (nonJokers.some(function (c) { return suitOf(c) === suitOf(card); })) {
        return null;
      }
      const matchKey = jokers.filter(function (j) { return meldGroup.jokers[j] === rankOf(card); })[0];
      return matchKey || null;
    }
    const matchKey = jokers.filter(function (j) { return meldGroup.jokers[j] === card; })[0];
    return matchKey || null;
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

// --- Joker identity resolution ----------------------------------------------
// Everything below gives every Joker in a meld a specific, stable, stored
// identity (a real card it represents) the moment it joins that meld -
// instead of the "recompute a plausible position from scratch every time"
// approach the legacy functions above still use for backward compatibility.
// See the module header for why: a Joker's role must not silently change on
// every inspection, must respect the selection order a player marked cards
// in when that's the only thing that disambiguates intent, and must always
// agree across creation/display/sorting/layoff/replacement/scoring, per the
// "Implement Deterministic Joker Melds and Layoffs" issue this section
// exists for.
//
// A meld group built or extended through resolveMeld()/resolveGroupExtension
// below carries two additional fields beyond the legacy { type, cards }
// shape:
//   jokers: { [jokerCard]: representedCard, ... } - e.g. { '1J': '8S' } for a
//     run (the exact rank+suit that Joker fills - a run's Joker DOES have a
//     specific suit, since its exact position in the sequence matters), or
//     { '1J': '8' } for a set (rank ONLY - a set Joker never gets a fake
//     suit; see assignSetJokerRanks() below and findJokerSwapTarget()'s
//     meldGroup.jokers/set branch above, which is what lets ANY still-missing
//     suit of that rank replace it, not just whichever suit a fake
//     assignment happened to pick). A stored value's length is what tells
//     the two apart: 2 characters (rank+suit) for a run, 1 character (rank
//     only) for a set.
//   mode: for a run, which Ace-position mode (ACE_LOW_ORDER_VALUE or
//     ACE_HIGH_ORDER_VALUE - see the "Ace High or Low" section) the run
//     resolved under. null for a set. Stored (not re-derived) so extending an
//     existing Ace-anchored run later never risks flipping its Ace
//     interpretation (rule 13's stability requirement).
//
// Both fields are additive: every legacy function above (isValidSet,
// isValidRun, classifyMeld, canExtendMeld, and findJokerSwapTarget/
// findBestJokerAssignment without a stored `jokers` map) still operates
// purely off `cards` exactly as before, so a meld group built by an older
// test or a stale in-flight table state degrades gracefully - see
// resolveExistingGroupIdentity() below, which lazily derives `jokers`/`mode`
// the first time such a group is touched by resolveGroupExtension().

const ORDER_VALUE_TO_RANK = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K' };

function rankForOrderValue(value) {
  if (value === ACE_LOW_ORDER_VALUE || value === ACE_HIGH_ORDER_VALUE) {
    return 'A';
  }
  return ORDER_VALUE_TO_RANK[value] || '';
}

// Assigns every Joker in `jokerCards` a RANK-ONLY identity within a SET
// anchored by `realCards` (already known to be same-rank, distinct-suit). A
// set Joker never gets a fake suit - it represents the set's rank
// generically, with no specific suit attached (see the "Jokers in Sets Must
// Be Generic by Suit" issue this exists for). This is what lets ANY
// still-missing suit of that rank replace it later (see
// findJokerSwapTarget()'s meldGroup.jokers/set branch above), instead of
// only the one suit a fake assignment happened to pick. Returns null if
// there isn't room for every Joker within MAX_SET_SIZE (can't happen given
// the group was already validated via isValidSet(), but this stays a plain
// data function with no caller-specific assumptions).
function assignSetJokerRanks(realCards, jokerCards) {
  if (!Array.isArray(realCards) || !realCards.length) {
    return null;
  }
  const rank = rankOf(realCards[0]);
  if (!realCards.every(function (c) { return rankOf(c) === rank; })) {
    return null;
  }
  if (realCards.length + (jokerCards ? jokerCards.length : 0) > MAX_SET_SIZE) {
    return null;
  }
  const assignments = {};
  (jokerCards || []).forEach(function (jokerCard) {
    assignments[jokerCard] = rank;
  });
  return assignments;
}

// Splits `leftover` Jokers (ones not needed to fill an internal rank gap)
// between the low and high ends of a run, biased by `beforeCount`/
// `afterCount` - how many of those Jokers the player selected before the
// first real card / after the last real card of the group, in their original
// selection order (see resolveRunJokerPositions() below for how those counts
// are derived). This is what makes "8S, Joker, Joker" resolve as 8-9-10
// (both Jokers selected after the 8, so both extend high) while "Joker, 8S,
// Joker" resolves as 7-8-9 (one before, one after) - see the issue's section
// 1 and 3 examples. When the hint is silent or contradicts available room
// (e.g. a real card already sits at the domain's boundary on the side a
// Joker was "hinted" toward), room availability always wins, and any
// still-unplaced leftover defaults to the low end first, matching this
// module's pre-existing "extend low end first" convention (see the old
// computeRunBoundsForMode() above) for the fully-ambiguous case (no reals to
// be "before"/"after" of at all, e.g. laying off two bare Jokers onto an
// already-real run).
function splitLeftoverJokers(leftover, lowRoom, highRoom, beforeCount, afterCount) {
  if (leftover > lowRoom + highRoom) {
    return null;
  }
  let low = Math.min(beforeCount, leftover, lowRoom);
  let remaining = leftover - low;
  let high = Math.min(afterCount, remaining, highRoom);
  remaining -= high;
  if (remaining > 0) {
    const extraLow = Math.min(remaining, lowRoom - low);
    low += extraLow;
    remaining -= extraLow;
  }
  if (remaining > 0) {
    const extraHigh = Math.min(remaining, highRoom - high);
    high += extraHigh;
    remaining -= extraHigh;
  }
  return remaining === 0 ? { low: low, high: high } : null;
}

// Resolves every Joker in `jokerCards` to a specific card within a RUN
// anchored by `realCards` (all real cards involved - existing anchors plus
// any new ones, already known to share one suit). `hintOrder` is the
// selection-order card list used only to compute the before-first-real/
// after-last-real counts splitLeftoverJokers() above needs; it may be a
// superset of jokerCards+realCards (e.g. the player's full original
// selection) or just the newly added cards when extending an existing group
// (see resolveGroupExtension() below) - only the relative order of entries
// that are actually present in it matters.
//
// `forcedMode`, when given, restricts resolution to that single Ace-position
// mode (ACE_LOW_ORDER_VALUE or ACE_HIGH_ORDER_VALUE) instead of trying every
// mode aceRunModes(options) allows - this is how an existing run's already-
// established Ace interpretation stays stable across a later extension
// (rule 13), instead of potentially being re-derived under a different mode
// just because new cards happened to also validate that way.
//
// Returns { mode, assignments } (assignments maps each Joker card to its
// resolved representation) or null if no applicable mode can place every
// Joker in jokerCards.
function resolveRunJokerPositions(realCards, jokerCards, hintOrder, options, forcedMode) {
  if (!Array.isArray(realCards) || !realCards.length) {
    return null;
  }
  const suit = suitOf(realCards[0]);
  if (!realCards.every(function (c) { return suitOf(c) === suit; })) {
    return null;
  }
  const jokers = jokerCards || [];
  const modesToTry = forcedMode ? [forcedMode] : aceRunModes(options);

  for (let m = 0; m < modesToTry.length; m++) {
    const mode = modesToTry[m];
    const values = realCards.map(function (c) { return runOrderValue(c, mode); });
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    let duplicate = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      continue;
    }
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const domain = runDomainForMode(mode);
    if (min < domain.min || max > domain.max) {
      continue;
    }

    const gapSlots = [];
    for (let v = min; v <= max; v++) {
      if (sorted.indexOf(v) === -1) {
        gapSlots.push(v);
      }
    }
    const leftover = jokers.length - gapSlots.length;
    if (leftover < 0) {
      continue;
    }
    const lowRoom = min - domain.min;
    const highRoom = domain.max - max;

    let beforeCount = 0;
    let afterCount = 0;
    if (Array.isArray(hintOrder) && hintOrder.length) {
      const realIndexes = [];
      hintOrder.forEach(function (c, i) {
        if (!isJoker(c) && realCards.indexOf(c) !== -1) {
          realIndexes.push(i);
        }
      });
      if (realIndexes.length) {
        const firstRealIndex = Math.min.apply(null, realIndexes);
        const lastRealIndex = Math.max.apply(null, realIndexes);
        jokers.forEach(function (j) {
          const idx = hintOrder.indexOf(j);
          if (idx === -1) {
            return;
          }
          if (idx < firstRealIndex) {
            beforeCount++;
          } else if (idx > lastRealIndex) {
            afterCount++;
          }
        });
      }
    }

    const split = splitLeftoverJokers(leftover, lowRoom, highRoom, beforeCount, afterCount);
    if (!split) {
      continue;
    }

    const lowSlots = [];
    for (let v = min - 1; v >= min - split.low; v--) {
      lowSlots.push(v);
    }
    const highSlots = [];
    for (let v = max + 1; v <= max + split.high; v++) {
      highSlots.push(v);
    }
    const allSlots = gapSlots.concat(lowSlots, highSlots).sort(function (a, b) { return a - b; });
    if (allSlots.length !== jokers.length) {
      continue;
    }

    const assignments = {};
    jokers.forEach(function (jokerCard, i) {
      assignments[jokerCard] = rankForOrderValue(allSlots[i]) + suit;
    });
    return { mode: mode, assignments: assignments };
  }

  return null;
}

// Sorts a resolved group's full card list (real cards plus Jokers) into its
// final logical/display order - a set orders by canonical suit (matching the
// pre-existing rummyBuildSetDisplayCards() convention client-side), a run
// orders by rank position under `mode`. A Joker sorts using its assigned
// representation (`jokers[card]`), which is what makes it appear physically
// in the slot it represents (rule 17) instead of always at the end.
function orderGroupCards(type, cards, jokers, mode) {
  const resolvedOf = function (card) {
    if (isJoker(card) && jokers && jokers[card]) {
      return jokers[card];
    }
    return card;
  };
  if (type === 'set') {
    // A set Joker has no suit to sort by (rank-only identity - see
    // assignSetJokerRanks()) - real cards sort by suit as before, and every
    // Joker simply trails after them (their relative order carries no
    // meaning for a set, unlike a run's positional slots).
    const reals = [];
    const wilds = [];
    cards.forEach(function (card) {
      (isJoker(card) ? wilds : reals).push(card);
    });
    reals.sort(function (a, b) { return sortSuitValue(a) - sortSuitValue(b); });
    return reals.concat(wilds);
  }
  const effectiveMode = mode || ACE_LOW_ORDER_VALUE;
  return cards.slice().sort(function (a, b) {
    return runOrderValue(resolvedOf(a), effectiveMode) - runOrderValue(resolvedOf(b), effectiveMode);
  });
}

// The single entry point for interpreting a brand-new meld attempt (rules 1-8
// of the issue this exists for). `selectedCardsInOrder` is the player's
// marked cards in the exact order they selected them (games/rummy/index.js's
// performMeldCards() payload) - never pre-sorted, since selection order is
// load-bearing evidence for where an ambiguous Joker belongs (see
// resolveRunJokerPositions() above).
//
// Returns one of:
//   { ok: false, reason }                                  - not a legal meld at all
//   { ok: true, needsChoice: true, options: [...] }         - genuinely ambiguous; ask the player
//   { ok: true, needsChoice: false, type, cards, jokers, mode } - resolved
//
// `meldTypeChoice` ('run'|'set'), when supplied, is only ever consulted when
// the selection is ACTUALLY ambiguous (both interpretations legal) - per the
// issue's "do not use selection order [or an unnecessary prompt] when doing
// so would contradict an otherwise obvious valid sequence", an unambiguous
// selection always resolves to its one legal interpretation regardless of
// what a stale/mistaken meldTypeChoice might say.
function resolveMeld(selectedCardsInOrder, options, meldTypeChoice) {
  if (!Array.isArray(selectedCardsInOrder) || selectedCardsInOrder.length < MIN_RUN_SIZE) {
    return { ok: false, reason: 'Select at least three cards to meld' };
  }

  const realCards = selectedCardsInOrder.filter(function (c) { return !isJoker(c); });
  const jokerCards = selectedCardsInOrder.filter(isJoker);

  let runResult = null;
  if (realCards.length) {
    const resolvedRun = resolveRunJokerPositions(realCards, jokerCards, selectedCardsInOrder, options, null);
    if (resolvedRun) {
      runResult = {
        type: 'run',
        cards: orderGroupCards('run', selectedCardsInOrder, resolvedRun.assignments, resolvedRun.mode),
        jokers: resolvedRun.assignments,
        mode: resolvedRun.mode
      };
    }
  }

  let setResult = null;
  if (isValidSet(selectedCardsInOrder)) {
    const assignments = assignSetJokerRanks(realCards, jokerCards) || {};
    setResult = {
      type: 'set',
      cards: orderGroupCards('set', selectedCardsInOrder, assignments, null),
      jokers: assignments,
      mode: null
    };
  }

  const validTypes = [];
  if (runResult) {
    validTypes.push('run');
  }
  if (setResult) {
    validTypes.push('set');
  }

  if (!validTypes.length) {
    return { ok: false, reason: 'Those cards do not form a valid set or run' };
  }

  if (validTypes.length > 1 && meldTypeChoice !== 'run' && meldTypeChoice !== 'set') {
    return { ok: true, needsChoice: true, options: validTypes };
  }

  const chosenType = validTypes.length > 1 ? meldTypeChoice : validTypes[0];
  const chosen = chosenType === 'run' ? runResult : setResult;
  if (!chosen) {
    return { ok: false, reason: 'Those cards do not form a valid ' + (chosenType === 'run' ? 'run' : 'set') };
  }
  return { ok: true, needsChoice: false, type: chosen.type, cards: chosen.cards, jokers: chosen.jokers, mode: chosen.mode };
}

// Derives { jokers, mode } for a group that may not have them stored yet - a
// legacy-shaped meld group (plain { type, cards }, e.g. one hand-built by an
// older test or games/rummy/index.js's applyTestState() test hook without a
// jokers/mode payload). Returns the group's own stored fields unchanged when
// present (never re-derives an already-fixed assignment - rule 13), otherwise
// treats the group's own current `cards` order as a stand-in "selection
// order" and resolves it fresh, exactly once, the first time the group is
// touched by resolveGroupExtension() below.
function resolveExistingGroupIdentity(group, options) {
  if (group.jokers) {
    return { jokers: group.jokers, mode: typeof group.mode !== 'undefined' ? group.mode : null };
  }
  const realCards = group.cards.filter(function (c) { return !isJoker(c); });
  const jokerCards = group.cards.filter(isJoker);
  if (!jokerCards.length) {
    return { jokers: {}, mode: typeof group.mode !== 'undefined' ? group.mode : null };
  }
  if (group.type === 'set') {
    const assignments = assignSetJokerRanks(realCards, jokerCards);
    return assignments ? { jokers: assignments, mode: null } : { jokers: {}, mode: null };
  }
  const resolved = resolveRunJokerPositions(realCards, jokerCards, group.cards, options, null);
  return resolved ? { jokers: resolved.assignments, mode: resolved.mode } : { jokers: {}, mode: null };
}

// Applies a Joker-for-real-card swap (see findJokerSwapTarget() above) and
// returns the resulting group, fully re-resolved (jokers map updated, cards
// re-sorted into logical order via orderGroupCards()) rather than just
// splicing the real card onto the end of the array - see rule 10/17.
function applyJokerSwap(group, realCard, jokerCard, options) {
  const identity = resolveExistingGroupIdentity(group, options);
  const mergedJokers = Object.assign({}, identity.jokers);
  delete mergedJokers[jokerCard];
  const newCards = group.cards.filter(function (c) { return c !== jokerCard; }).concat([realCard]);
  return {
    type: group.type,
    cards: orderGroupCards(group.type, newCards, mergedJokers, identity.mode),
    jokers: mergedJokers,
    mode: identity.mode
  };
}

// Resolves adding `subsetCardsInOrder` (already known, via
// findBestJokerAssignment() below, to legally extend `group` as a batch) onto
// an existing meld group, in the player's selection order - the lay-off
// counterpart to resolveMeld() above (rules 9-13). Existing Jokers already
// assigned within `group` keep their exact identity (resolveExistingGroupIdentity()
// only derives fresh ones for cards that don't have one yet); a run's already-
// established Ace mode is preserved (passed as `forcedMode` to
// resolveRunJokerPositions()) rather than potentially re-derived. Returns the
// fully resolved replacement group, or null if identity resolution genuinely
// fails (shouldn't happen given the batch was already legality-checked via
// isValidSet()/isValidRun(), but this stays defensive since it's a distinct
// concern - THIS card, in THIS spot - from plain legality).
function resolveGroupExtension(group, subsetCardsInOrder, options) {
  if (!group || !Array.isArray(group.cards) || !Array.isArray(subsetCardsInOrder) || !subsetCardsInOrder.length) {
    return null;
  }
  const identity = resolveExistingGroupIdentity(group, options);
  const existingJokers = identity.jokers;
  let mergedMode = identity.mode;

  const newReals = subsetCardsInOrder.filter(function (c) { return !isJoker(c); });
  const newJokers = subsetCardsInOrder.filter(isJoker);
  let mergedJokers = Object.assign({}, existingJokers);

  if (group.type === 'set') {
    if (newJokers.length) {
      // A set Joker's identity is rank-only (see assignSetJokerRanks()) - no
      // suit bookkeeping needed here, just the set's one shared rank, taken
      // from whichever real card (existing or newly added) or already-
      // resolved Joker is available.
      const existingReals = group.cards.filter(function (c) { return !isJoker(c); });
      const rankSource = existingReals.length ? existingReals[0] : (newReals.length ? newReals[0] : null);
      const existingJokerKeys = Object.keys(existingJokers);
      const rank = rankSource ? rankOf(rankSource) : (existingJokerKeys.length ? existingJokers[existingJokerKeys[0]] : null);
      if (!rank || group.cards.length + newJokers.length > MAX_SET_SIZE) {
        return null;
      }
      newJokers.forEach(function (jokerCard) { mergedJokers[jokerCard] = rank; });
    }
  } else if (group.type === 'run') {
    const realEquivalents = group.cards.map(function (c) {
      if (!isJoker(c)) {
        return c;
      }
      return existingJokers[c] || c;
    });
    const mergedRealEquivalents = realEquivalents.concat(newReals);
    const resolved = resolveRunJokerPositions(mergedRealEquivalents, newJokers, subsetCardsInOrder, options, mergedMode);
    if (!resolved) {
      return null;
    }
    Object.assign(mergedJokers, resolved.assignments);
    mergedMode = resolved.mode;
  } else {
    return null;
  }

  const allCards = group.cards.concat(subsetCardsInOrder);
  return {
    type: group.type,
    cards: orderGroupCards(group.type, allCards, mergedJokers, mergedMode),
    jokers: mergedJokers,
    mode: mergedMode
  };
}

// Attempts to lay `cardsInOrder` off onto a SINGLE existing group, ALL of it
// at once (as opposed to findBestJokerAssignment() below, which finds the
// largest subset that fits - this requires every card to land). Used by
// games/rummy/index.js's performLayOffCards() to decide, for the player's
// full selection, which of a seat's meld groups can legally receive the
// WHOLE thing - the question "Player Must Be Able to Choose Which Meld
// Receives a Layoff" (see that issue) needs answered before anything is
// committed: zero such groups is a normal rejection, exactly one is applied
// automatically, and more than one means the player must be asked which
// meld they want (see index.js - this function itself is stateless and
// never asks anything; it just reports whether/how a single group can
// absorb the batch).
//
// Same two-pass approach games/rummy/index.js's old cross-group algorithm
// used to run once for the whole target seat - Joker swaps first (a real
// card that exactly/generically replaces a Joker already in this group
// takes its place - rule 3/9's "replace before expanding"), then whatever's
// left is matched against the group as one batch via
// findBestJokerAssignment()/resolveGroupExtension() - except now scoped to
// one candidate group at a time, and requiring every card in `cardsInOrder`
// to be consumed (a partial fit means this group does NOT count as a legal
// whole-batch target). Returns { group: <fully resolved replacement group>,
// returnedJokers: [...] } or null.
function resolveLayoff(group, cardsInOrder, options) {
  if (!group || !Array.isArray(group.cards) || !Array.isArray(cardsInOrder) || !cardsInOrder.length) {
    return null;
  }

  let currentGroup = {
    type: group.type,
    cards: group.cards.slice(),
    jokers: group.jokers ? Object.assign({}, group.jokers) : undefined,
    mode: group.mode
  };
  let remaining = cardsInOrder.slice();
  const returnedJokers = [];

  for (let i = remaining.length - 1; i >= 0; i--) {
    const card = remaining[i];
    const swapJoker = findJokerSwapTarget(currentGroup, card, options);
    if (swapJoker) {
      currentGroup = applyJokerSwap(currentGroup, card, swapJoker, options);
      returnedJokers.push(swapJoker);
      remaining.splice(i, 1);
    }
  }

  if (remaining.length) {
    const assignment = findBestJokerAssignment(currentGroup, remaining, options);
    if (assignment.cards.length !== remaining.length) {
      return null;
    }
    const extended = resolveGroupExtension(currentGroup, assignment.cards, options);
    if (!extended) {
      return null;
    }
    currentGroup = extended;
  }

  return { group: currentGroup, returnedJokers: returnedJokers };
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
  rankForOrderValue: rankForOrderValue,
  assignSetJokerRanks: assignSetJokerRanks,
  resolveRunJokerPositions: resolveRunJokerPositions,
  orderGroupCards: orderGroupCards,
  resolveMeld: resolveMeld,
  resolveExistingGroupIdentity: resolveExistingGroupIdentity,
  applyJokerSwap: applyJokerSwap,
  resolveGroupExtension: resolveGroupExtension,
  resolveLayoff: resolveLayoff,
  isStockExhausted: isStockExhausted,
  reshuffleDiscardIntoStock: reshuffleDiscardIntoStock,
  scoreHand: scoreHand,
  isGameOver: isGameOver,
  getWinnerIndex: getWinnerIndex
};
