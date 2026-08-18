// Pure Cribbage rules engine: deck, deal, discard-to-crib, pegging (the
// play) legal-play + scoring, and show (counting) scoring. No io/socket/
// table references anywhere in this file on purpose - every function here
// takes plain data in and returns plain data out, so it can be unit tested
// directly (see tests/cribbage-rules.test.js) without spawning a server.
//
// Card representation: a two-character string that is also the asset
// filename stem in public/images/playing-cards/ (e.g. "QS" = Queen of
// Spades = QS.svg). Rank chars: 2-9, T (ten), J, Q, K, A. Suit chars:
// C (clubs), D (diamonds), H (hearts), S (spades).

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];
const RANK_NAMES = {
  '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven',
  '8': 'Eight', '9': 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

// Counting/pegging point value: 2-9 are face value, T/J/Q/K are all 10, Ace
// is 1. This is distinct from rankOrderValue() below, which is used only for
// run adjacency (where T/J/Q/K are NOT all equal).
const CARD_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 10, Q: 10, K: 10, A: 1
};

// Ordinal rank position for run-adjacency purposes (Ace low, King high, no
// wraparound) - e.g. 9-T-J is a run even though T and J are both worth 10
// points via CARD_VALUES.
const RANK_ORDER_VALUES = {
  A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13
};

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

// deck must already be a shuffled array of the 52 unique cards from
// createDeck() - randomness is intentionally kept out of this pure module
// (see games/cribbage/index.js, which shuffles via the shared deps.shuffle
// before calling this). Deals 6 cards to each of 2 players, alternating one
// at a time; the remaining 40 cards are returned as `stub`, standing in for
// "the rest of the deck" that the starter is later cut from.
function dealHands(shuffledDeck) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== 52) {
    throw new Error('dealHands() requires a shuffled 52-card deck');
  }

  const hands = [[], []];
  for (let i = 0; i < 12; i++) {
    hands[i % 2].push(shuffledDeck[i]);
  }
  return {
    hands: hands.map(sortHand),
    stub: shuffledDeck.slice(12)
  };
}

function isValidDiscard(hand, cards) {
  if (!Array.isArray(hand) || !Array.isArray(cards) || cards.length !== 2) {
    return false;
  }
  if (cards[0] === cards[1]) {
    return false;
  }
  return cards.every(function (card) { return hand.indexOf(card) !== -1; });
}

// Returns { remainingHand, discarded }. Throws if the discard isn't valid -
// callers should check isValidDiscard() first and only call this on success.
function applyDiscard(hand, cards) {
  if (!isValidDiscard(hand, cards)) {
    throw new Error('applyDiscard() requires exactly two cards from the given hand');
  }
  return {
    remainingHand: hand.filter(function (card) { return cards.indexOf(card) === -1; }),
    discarded: cards.slice()
  };
}

// stub is already a shuffled remainder of the deck (see dealHands above), so
// taking its first card IS a fair cut - no separate "cut position" simulation
// is needed. Returns { starter, remainingStub }.
function revealStarter(stub) {
  if (!Array.isArray(stub) || !stub.length) {
    throw new Error('revealStarter() requires a non-empty stub');
  }
  return {
    starter: stub[0],
    remainingStub: stub.slice(1)
  };
}

function isHisHeels(starterCard) {
  return rankOf(starterCard) === 'J';
}

// Cards that may legally be played next without pushing the running count
// past 31. Empty result means the player must say "Go".
function getLegalPeggingPlays(hand, count) {
  if (!Array.isArray(hand) || !hand.length) {
    return [];
  }
  return hand.filter(function (card) { return count + cardValue(card) <= 31; });
}

function isLegalPeggingPlay(hand, count, card) {
  return getLegalPeggingPlays(hand, count).indexOf(card) !== -1;
}

// segmentCards: ordered array of card strings played so far in the CURRENT
// 31-count segment only (already reset to [] after every Go/31 - pairs and
// runs never span a reset). The just-played card must be the last element.
// Returns a scoring breakdown for the play that was just made.
function scoreTrailingPlay(segmentCards) {
  if (!Array.isArray(segmentCards) || !segmentCards.length) {
    throw new Error('scoreTrailingPlay() requires at least one played card');
  }

  const count = segmentCards.reduce(function (sum, card) { return sum + cardValue(card); }, 0);
  const fifteenPoints = count === 15 ? 2 : 0;
  const thirtyOnePoints = count === 31 ? 2 : 0;

  // Trailing pair/triple/quad: walk backward from the last card, counting
  // consecutive matches of its rank, stopping at the first mismatch.
  const lastRank = rankOf(segmentCards[segmentCards.length - 1]);
  let pairSize = 1;
  for (let i = segmentCards.length - 2; i >= 0; i--) {
    if (rankOf(segmentCards[i]) === lastRank) {
      pairSize++;
    } else {
      break;
    }
  }
  const pairPoints = pairSize >= 2 ? pairSize * (pairSize - 1) : 0;

  // Trailing run: try the longest possible window first (any nested shorter
  // run within a found run is NOT separately credited). Pegging runs require
  // the trailing cards to be rank-distinct - a repeated rank breaks run
  // eligibility for that window (the repeat is instead captured by the pair
  // score above, never double-counted as a run).
  let runLength = 0;
  for (let n = segmentCards.length; n >= 3; n--) {
    const windowCards = segmentCards.slice(segmentCards.length - n);
    const values = windowCards.map(rankOrderValue);
    const uniqueValues = new Set(values);
    if (uniqueValues.size !== n) {
      continue;
    }
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    let consecutive = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        consecutive = false;
        break;
      }
    }
    if (consecutive) {
      runLength = n;
      break;
    }
  }
  const runPoints = runLength;

  return {
    count: count,
    fifteenPoints: fifteenPoints,
    thirtyOnePoints: thirtyOnePoints,
    pairSize: pairSize >= 2 ? pairSize : 0,
    pairPoints: pairPoints,
    runLength: runLength,
    runPoints: runPoints,
    total: fifteenPoints + thirtyOnePoints + pairPoints + runPoints
  };
}

// Enumerates every non-empty subset of the 5 cards (4-card hand/crib plus the
// shared starter) via a 5-bit mask, returning how many subsets sum to exactly
// 15 and the resulting point total (2 per qualifying subset).
function countFifteens(fiveCards) {
  let count = 0;
  for (let mask = 1; mask < 32; mask++) {
    let sum = 0;
    for (let bit = 0; bit < 5; bit++) {
      if (mask & (1 << bit)) {
        sum += cardValue(fiveCards[bit]);
      }
    }
    if (sum === 15) {
      count++;
    }
  }
  return { count: count, points: count * 2 };
}

// Every same-rank pair among all 5 cards scores 2 points; a rank appearing k
// times (k>=2) scores k*(k-1) total (2/6/12 for a pair/triple/quad).
function countPairs(fiveCards) {
  const groupsByRank = {};
  fiveCards.forEach(function (card) {
    const rank = rankOf(card);
    groupsByRank[rank] = (groupsByRank[rank] || 0) + 1;
  });

  const groups = [];
  let points = 0;
  Object.keys(groupsByRank).forEach(function (rank) {
    const size = groupsByRank[rank];
    if (size >= 2) {
      const groupPoints = size * (size - 1);
      groups.push({ rank: rank, size: size, points: groupPoints });
      points += groupPoints;
    }
  });

  return { points: points, groups: groups };
}

// Finds the longest run of consecutive DISTINCT rank-values present among
// the 5 cards (duplicates collapsed for the adjacency search), then
// multiplies by how many ways one card of each participating rank could be
// chosen (the product of each rank's multiplicity) - this is what produces
// the standard "double run" (3*2=6, plus the separate pair score of 2, for a
// combined 8), "triple run" (3*3=9, plus pairs 6, for 15), and
// "double-double run" (3*4=12, plus pairs 4, for 16) reference totals. Runs
// and pairs are additive, not exclusive - both legitimately derive from the
// same underlying duplicate rank.
function countRuns(fiveCards) {
  const multiplicityByValue = {};
  fiveCards.forEach(function (card) {
    const value = rankOrderValue(card);
    multiplicityByValue[value] = (multiplicityByValue[value] || 0) + 1;
  });
  const distinctValues = Object.keys(multiplicityByValue).map(Number).sort(function (a, b) { return a - b; });

  let bestLength = 0;
  let bestWaysCount = 0;
  let runStart = distinctValues.length ? distinctValues[0] : null;
  let runValues = [];

  for (let i = 0; i < distinctValues.length; i++) {
    if (i > 0 && distinctValues[i] !== distinctValues[i - 1] + 1) {
      runStart = distinctValues[i];
      runValues = [];
    }
    runValues.push(distinctValues[i]);
    if (runValues.length >= 3 && runValues.length > bestLength) {
      bestLength = runValues.length;
      bestWaysCount = runValues.reduce(function (product, value) { return product * multiplicityByValue[value]; }, 1);
    }
  }

  return {
    length: bestLength,
    waysCount: bestLength ? bestWaysCount : 0,
    points: bestLength ? bestLength * bestWaysCount : 0
  };
}

// isCrib controls the flush rule: a hand scores 4 for an all-matching 4-card
// hand (5 if the starter also matches), but a crib requires ALL FIVE cards
// (the 4 crib cards and the starter) to match for any credit at all.
function countFlush(fourCards, starter, isCrib) {
  const suits = fourCards.map(suitOf);
  const allFourMatch = suits.every(function (suit) { return suit === suits[0]; });
  const starterMatches = allFourMatch && suitOf(starter) === suits[0];

  if (isCrib) {
    return { points: starterMatches ? 5 : 0, matchesStarter: starterMatches };
  }
  if (!allFourMatch) {
    return { points: 0, matchesStarter: false };
  }
  return { points: starterMatches ? 5 : 4, matchesStarter: starterMatches };
}

// "His Nobs": a Jack among the 4 hand/crib cards (not the starter itself)
// whose suit matches the starter's suit scores 1 point.
function countNobs(fourCards, starter) {
  const hasNobs = fourCards.some(function (card) {
    return rankOf(card) === 'J' && suitOf(card) === suitOf(starter);
  });
  return { points: hasNobs ? 1 : 0 };
}

// fourCards: the 4-card hand or crib being scored. starter: the single
// shared starter card. isCrib: controls the flush rule (see countFlush).
function scoreFiveCards(fourCards, starter, isCrib) {
  const fiveCards = fourCards.concat([starter]);

  const fifteens = countFifteens(fiveCards);
  const pairs = countPairs(fiveCards);
  const runs = countRuns(fiveCards);
  const flush = countFlush(fourCards, starter, !!isCrib);
  const nobs = countNobs(fourCards, starter);

  return {
    fifteens: fifteens,
    pairs: pairs,
    runs: runs,
    flush: flush,
    nobs: nobs,
    total: fifteens.points + pairs.points + runs.points + flush.points + nobs.points
  };
}

function nextDealerIndex(currentDealerIndex) {
  return currentDealerIndex === 0 ? 1 : 0;
}

// Unlike Hearts (lowest score loses at target), Cribbage's first player to
// reach/exceed the target score wins - same "highest wins" convention as
// Spades' team scoring.
function isGameOver(cumulativeScores, targetScore) {
  return cumulativeScores.some(function (score) { return score >= targetScore; });
}

function getWinnerIndex(cumulativeScores) {
  let winnerIndex = 0;
  for (let i = 1; i < cumulativeScores.length; i++) {
    if (cumulativeScores[i] > cumulativeScores[winnerIndex]) {
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
  dealHands: dealHands,
  isValidDiscard: isValidDiscard,
  applyDiscard: applyDiscard,
  revealStarter: revealStarter,
  isHisHeels: isHisHeels,
  getLegalPeggingPlays: getLegalPeggingPlays,
  isLegalPeggingPlay: isLegalPeggingPlay,
  scoreTrailingPlay: scoreTrailingPlay,
  scoreFiveCards: scoreFiveCards,
  nextDealerIndex: nextDealerIndex,
  isGameOver: isGameOver,
  getWinnerIndex: getWinnerIndex
};
