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

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];
const RANK_NAMES = {
  '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven',
  '8': 'Eight', '9': 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

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
  return deck;
}

function rankOf(card) {
  return typeof card === 'string' ? card.charAt(0) : '';
}

function suitOf(card) {
  return typeof card === 'string' ? card.charAt(1) : '';
}

function cardValue(card) {
  return CARD_VALUES[rankOf(card)] || 0;
}

function rankOrderValue(card) {
  return RANK_ORDER_VALUES[rankOf(card)] || 0;
}

function suitName(suit) {
  return SUIT_NAMES[suit] || 'cards';
}

function cardName(card) {
  const rank = RANK_NAMES[rankOf(card)];
  const suit = SUIT_NAMES[suitOf(card)];
  if (!rank || !suit) {
    return 'unknown card';
  }
  return rank + ' of ' + suit;
}

const SUIT_SORT_ORDER = { C: 0, D: 1, H: 2, S: 3 };

function sortHand(hand) {
  return hand.slice().sort(function (a, b) {
    const suitDiff = SUIT_SORT_ORDER[suitOf(a)] - SUIT_SORT_ORDER[suitOf(b)];
    if (suitDiff !== 0) {
      return suitDiff;
    }
    return rankOrderValue(a) - rankOrderValue(b);
  });
}

// 10 cards each for a 2-player table, 7 each for 3-6 players - per
// pagat.com's basic Rummy deal sizes.
function dealSizeForPlayerCount(playerCount) {
  return playerCount === 2 ? 10 : 7;
}

// deck must already be a shuffled array of the 52 unique cards from
// createDeck() - randomness is intentionally kept out of this pure module
// (see games/rummy/index.js, which shuffles via the shared deps.shuffle
// before calling this). Deals dealSizeForPlayerCount(playerCount) cards
// round-robin per player, then one further card face-up to start the
// discard pile; everything left over becomes the stock. Returns
// { hands, stock, discard } - discard is an array whose LAST element is the
// visible top card (same "top = last element" convention as
// games/lumo/index.js's discard pile).
function deal(shuffledDeck, playerCount) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== 52) {
    throw new Error('deal() requires a shuffled 52-card deck');
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
// nothing).
function isValidSet(cards) {
  if (!Array.isArray(cards) || cards.length < MIN_SET_SIZE || cards.length > MAX_SET_SIZE) {
    return false;
  }
  const rank = rankOf(cards[0]);
  const seenSuits = new Set();
  return cards.every(function (card) {
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

// 3+ cards, all the same suit, consecutive ranks (ace low only - see header).
function isValidRun(cards) {
  if (!Array.isArray(cards) || cards.length < MIN_RUN_SIZE) {
    return false;
  }
  const suit = suitOf(cards[0]);
  if (!cards.every(function (card) { return suitOf(card) === suit; })) {
    return false;
  }

  const values = cards.map(rankOrderValue).sort(function (a, b) { return a - b; });
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] + 1) {
      return false;
    }
  }
  return true;
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
function canExtendMeld(meldGroup, card) {
  if (!meldGroup || !Array.isArray(meldGroup.cards) || !meldGroup.cards.length) {
    return false;
  }

  if (meldGroup.type === 'set') {
    if (meldGroup.cards.length >= MAX_SET_SIZE) {
      return false;
    }
    const rank = rankOf(meldGroup.cards[0]);
    if (rankOf(card) !== rank) {
      return false;
    }
    const suit = suitOf(card);
    return !meldGroup.cards.some(function (c) { return suitOf(c) === suit; });
  }

  if (meldGroup.type === 'run') {
    const suit = suitOf(meldGroup.cards[0]);
    if (suitOf(card) !== suit) {
      return false;
    }
    const values = meldGroup.cards.map(rankOrderValue);
    const minValue = Math.min.apply(null, values);
    const maxValue = Math.max.apply(null, values);
    const cardValueOrder = rankOrderValue(card);
    return cardValueOrder === minValue - 1 || cardValueOrder === maxValue + 1;
  }

  return false;
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
  isStockExhausted: isStockExhausted,
  reshuffleDiscardIntoStock: reshuffleDiscardIntoStock,
  scoreHand: scoreHand,
  isGameOver: isGameOver,
  getWinnerIndex: getWinnerIndex
};
