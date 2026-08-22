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

// Deadwood/scoring value: ace is always 1 (never 11/high), face cards are all
// 10, everything else is its pip value.
const CARD_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 10, Q: 10, K: 10, A: 1
};

// Ordinal rank position for run-adjacency purposes only, ace low, no
// wraparound (see the header comment above).
const RANK_ORDER_VALUES = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13
};

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

function cardValue(card) {
  if (isJoker(card)) {
    return JOKER_DEADWOOD_VALUE;
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

// 3+ cards, all the same suit, consecutive ranks (ace low only - see
// header). Jokers are wild: they fill gaps between the real cards' ranks,
// and any left over extend the span at either end, as long as there's room
// within the ace-low 1-13 bound (no wraparound). At least one real card is
// required to anchor the run's suit (see header).
function isValidRun(cards) {
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

  const values = nonJokers.map(rankOrderValue).sort(function (a, b) { return a - b; });
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) {
      return false;
    }
  }

  const min = values[0];
  const max = values[values.length - 1];
  const internalGapsNeeded = (max - min + 1) - values.length;
  if (internalGapsNeeded > jokerCount) {
    return false;
  }
  const leftoverJokers = jokerCount - internalGapsNeeded;
  const roomBelow = min - 1;
  const roomAbove = 13 - max;
  return leftoverJokers <= roomBelow + roomAbove;
}

// The contiguous rank-order span a run group currently covers, accounting
// for Jokers used as gap-fillers/extensions - not stored explicitly on the
// group (see the header comment), so it's recomputed from the group's cards
// each time canExtendMeld() needs it. Any leftover (non-gap-filling) Jokers
// are deterministically assigned to extend the low end first, then the high
// end - their exact position is genuinely ambiguous in real Rummy (a Joker's
// identity isn't fixed until a real card replaces it), so this is just a
// consistent, defensible choice, not "the" correct one. Returns null if the
// group has no real card to anchor it (shouldn't happen for an
// already-valid run).
function runEffectiveBounds(cards) {
  const jokers = cards.filter(isJoker);
  const nonJokers = cards.filter(function (card) { return !isJoker(card); });
  if (!nonJokers.length) {
    return null;
  }
  const values = nonJokers.map(rankOrderValue).sort(function (a, b) { return a - b; });
  let min = values[0];
  let max = values[values.length - 1];
  let leftover = jokers.length - ((max - min + 1) - values.length);
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

function classifyMeld(cards) {
  if (isValidSet(cards)) {
    return { valid: true, type: 'set' };
  }
  if (isValidRun(cards)) {
    return { valid: true, type: 'run' };
  }
  return { valid: false };
}

// meldGroup: { type: 'set'|'run', cards: [...] } - an existing melded group
// already on the table. Returns true if `card` could legally be added to it.
// `card` itself may be a Joker (wild) or a real card extending a group that
// already contains a Joker (or both) - see isValidSet()/isValidRun() above
// for how Jokers factor into a group's rank/suit identity.
function canExtendMeld(meldGroup, card) {
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
    const bounds = runEffectiveBounds(meldGroup.cards);
    if (!bounds) {
      return false;
    }
    if (isJoker(card)) {
      return bounds.min > 1 || bounds.max < 13;
    }
    const nonJokers = meldGroup.cards.filter(function (c) { return !isJoker(c); });
    const suit = suitOf(nonJokers[0]);
    if (suitOf(card) !== suit) {
      return false;
    }
    const cardValueOrder = rankOrderValue(card);
    return cardValueOrder === bounds.min - 1 || cardValueOrder === bounds.max + 1;
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
function findJokerSwapTarget(meldGroup, card) {
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
    const bounds = runEffectiveBounds(meldGroup.cards);
    if (!bounds) {
      return null;
    }
    const cardPosition = rankOrderValue(card);
    if (cardPosition < bounds.min || cardPosition > bounds.max) {
      return null;
    }
    const positionTaken = nonJokers.some(function (c) { return rankOrderValue(c) === cardPosition; });
    return positionTaken ? null : jokers[0];
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
function findBestJokerAssignment(meldGroup, candidateCards) {
  if (!meldGroup || !Array.isArray(meldGroup.cards) || !meldGroup.cards.length) {
    return { cards: [] };
  }
  const validate = meldGroup.type === 'set' ? isValidSet : meldGroup.type === 'run' ? isValidRun : null;
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
function scoreHand(hands, wentOutPlayerIndex) {
  const deadwoodByPlayer = hands.map(function (hand) {
    return (hand || []).reduce(function (sum, card) { return sum + cardValue(card); }, 0);
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
