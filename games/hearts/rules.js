// Pure Hearts rules engine: deck, deal, legal-play calculation, trick
// resolution, and scoring (including shooting the moon). No io/socket/table
// references anywhere in this file on purpose - every function here takes
// plain data in and returns plain data out, so it can be unit tested directly
// (see tests/hearts-rules.test.js) without spawning a server.
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

const TWO_OF_CLUBS = '2C';
const QUEEN_OF_SPADES = 'QS';
const PASS_DIRECTIONS = ['left', 'right', 'across', 'hold'];

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

function rankValue(card) {
  return RANKS.indexOf(rankOf(card)) + 2;
}

function isHeart(card) {
  return suitOf(card) === 'H';
}

function isQueenOfSpades(card) {
  return card === QUEEN_OF_SPADES;
}

function cardPoints(card) {
  if (isQueenOfSpades(card)) {
    return 13;
  }
  if (isHeart(card)) {
    return 1;
  }
  return 0;
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

const SUIT_SORT_ORDER = { C: 0, D: 1, S: 2, H: 3 };

function sortHand(hand) {
  return hand.slice().sort(function (a, b) {
    const suitDiff = SUIT_SORT_ORDER[suitOf(a)] - SUIT_SORT_ORDER[suitOf(b)];
    if (suitDiff !== 0) {
      return suitDiff;
    }
    return rankValue(a) - rankValue(b);
  });
}

// deck must already be a shuffled array of the 52 unique cards from
// createDeck() - randomness is intentionally kept out of this pure module
// (see games/hearts/index.js, which shuffles via the shared deps.shuffle
// before calling this).
function deal(shuffledDeck) {
  if (!Array.isArray(shuffledDeck) || shuffledDeck.length !== 52) {
    throw new Error('deal() requires a shuffled 52-card deck');
  }

  const hands = [[], [], [], []];
  shuffledDeck.forEach(function (card, index) {
    hands[index % 4].push(card);
  });
  return hands.map(sortHand);
}

function findTwoOfClubsHolder(hands) {
  return hands.findIndex(function (hand) {
    return hand.indexOf(TWO_OF_CLUBS) !== -1;
  });
}

// Hand numbers are 1-based. Sequence: 1=left, 2=right, 3=across, 4=hold,
// then repeats (5=left, 6=right, ...).
function getPassDirection(handNumber) {
  const index = ((handNumber - 1) % 4 + 4) % 4;
  return PASS_DIRECTIONS[index];
}

function getPassTargetIndex(fromIndex, direction, playerCount) {
  const count = playerCount || 4;
  if (direction === 'left') {
    return (fromIndex + 1) % count;
  }
  if (direction === 'right') {
    return (fromIndex - 1 + count) % count;
  }
  if (direction === 'across') {
    return (fromIndex + 2) % count;
  }
  return fromIndex;
}

// selections: array of 4 arrays, each exactly 3 cards, indexed by the
// passing player's seat index. Validates membership/count, then returns new
// hand arrays with all four passes applied simultaneously (nobody's outgoing
// selection is visible to anybody until every hand has been rebuilt).
function applyPass(hands, selections, direction) {
  if (direction === 'hold') {
    return hands.map(function (hand) { return hand.slice(); });
  }

  if (!Array.isArray(selections) || selections.length !== hands.length) {
    throw new Error('applyPass() requires one selection per player');
  }

  selections.forEach(function (selection, fromIndex) {
    if (!Array.isArray(selection) || selection.length !== 3) {
      throw new Error('Each player must pass exactly three cards');
    }
    selection.forEach(function (card) {
      if (hands[fromIndex].indexOf(card) === -1) {
        throw new Error('Cannot pass a card that is not in hand');
      }
    });
  });

  const newHands = hands.map(function (hand, index) {
    return hand.filter(function (card) {
      return selections[index].indexOf(card) === -1;
    });
  });

  selections.forEach(function (selection, fromIndex) {
    const toIndex = getPassTargetIndex(fromIndex, direction, hands.length);
    selection.forEach(function (card) {
      newHands[toIndex].push(card);
    });
  });

  return newHands.map(sortHand);
}

// trick: array of { playerIndex, card } already played this trick, in play
// order (empty when this player is about to lead). isFirstTrick: true only
// for the very first trick of the hand (the one led with 2C).
function getLegalPlays(hand, trick, heartsBroken, isFirstTrick) {
  if (!Array.isArray(hand) || !hand.length) {
    return [];
  }

  const playedCards = Array.isArray(trick) ? trick.map(function (entry) { return entry.card; }) : [];

  if (playedCards.length === 0) {
    // Leading this trick.
    if (isFirstTrick) {
      return hand.indexOf(TWO_OF_CLUBS) !== -1 ? [TWO_OF_CLUBS] : hand.slice();
    }

    if (heartsBroken) {
      return hand.slice();
    }

    const nonHearts = hand.filter(function (card) { return !isHeart(card); });
    return nonHearts.length ? nonHearts : hand.slice();
  }

  // Following.
  const ledSuit = suitOf(playedCards[0]);
  const sameSuit = hand.filter(function (card) { return suitOf(card) === ledSuit; });

  if (sameSuit.length) {
    return sameSuit;
  }

  // Void in the led suit - any card is normally legal, except during the
  // first trick a Heart or the Queen of Spades may only be played if there
  // is no other legal alternative.
  if (isFirstTrick) {
    const safe = hand.filter(function (card) { return !isHeart(card) && !isQueenOfSpades(card); });
    return safe.length ? safe : hand.slice();
  }

  return hand.slice();
}

function isLegalPlay(hand, trick, heartsBroken, isFirstTrick, card) {
  return getLegalPlays(hand, trick, heartsBroken, isFirstTrick).indexOf(card) !== -1;
}

// A Heart is "legally discarded on a trick where another suit was led" the
// moment any Heart lands on the table - whether it was led (only possible
// via the only-Hearts-remaining exception) or discarded off-suit. Both cases
// break Hearts from that point on.
function breaksHearts(card) {
  return isHeart(card);
}

// trick: array of { playerIndex, card } in play order (length 4). Returns
// the winning playerIndex: the highest-ranked card of the suit that was led;
// off-suit cards (including any Hearts sluffed in) never win.
function resolveTrick(trick) {
  if (!Array.isArray(trick) || trick.length !== 4) {
    throw new Error('resolveTrick() requires exactly 4 plays');
  }

  const ledSuit = suitOf(trick[0].card);
  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const entry = trick[i];
    if (suitOf(entry.card) === ledSuit && rankValue(entry.card) > rankValue(winner.card)) {
      winner = entry;
    }
  }
  return winner.playerIndex;
}

// captures: array (indexed by playerIndex) of arrays of cards that player
// won in tricks this hand. Returns { points: number[], shotTheMoon: number|null }.
// Structured as a small standalone step so a different shoot-the-moon scoring
// option (e.g. -26 to the shooter instead of +26 to everyone else) could be
// swapped in later without touching trick/pass logic.
function scoreHandCaptures(captures) {
  const rawPoints = captures.map(function (cards) {
    return cards.reduce(function (sum, card) { return sum + cardPoints(card); }, 0);
  });

  const shooterIndex = rawPoints.findIndex(function (points) { return points === 26; });

  if (shooterIndex !== -1) {
    return {
      points: rawPoints.map(function (points, index) { return index === shooterIndex ? 0 : 26; }),
      shotTheMoon: shooterIndex
    };
  }

  return { points: rawPoints, shotTheMoon: null };
}

function isGameOver(cumulativeScores, pointsToEndGame) {
  return cumulativeScores.some(function (score) { return score >= pointsToEndGame; });
}

function getWinnerIndex(cumulativeScores) {
  let winnerIndex = 0;
  for (let i = 1; i < cumulativeScores.length; i++) {
    if (cumulativeScores[i] < cumulativeScores[winnerIndex]) {
      winnerIndex = i;
    }
  }
  return winnerIndex;
}

module.exports = {
  RANKS: RANKS,
  SUITS: SUITS,
  TWO_OF_CLUBS: TWO_OF_CLUBS,
  QUEEN_OF_SPADES: QUEEN_OF_SPADES,
  PASS_DIRECTIONS: PASS_DIRECTIONS,
  createDeck: createDeck,
  rankOf: rankOf,
  suitOf: suitOf,
  rankValue: rankValue,
  isHeart: isHeart,
  isQueenOfSpades: isQueenOfSpades,
  cardPoints: cardPoints,
  cardName: cardName,
  suitName: suitName,
  sortHand: sortHand,
  deal: deal,
  findTwoOfClubsHolder: findTwoOfClubsHolder,
  getPassDirection: getPassDirection,
  getPassTargetIndex: getPassTargetIndex,
  applyPass: applyPass,
  getLegalPlays: getLegalPlays,
  isLegalPlay: isLegalPlay,
  breaksHearts: breaksHearts,
  resolveTrick: resolveTrick,
  scoreHandCaptures: scoreHandCaptures,
  isGameOver: isGameOver,
  getWinnerIndex: getWinnerIndex
};
