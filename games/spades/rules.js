// Pure Spades rules engine: deck, deal, legal-play calculation (with spades
// as permanent trump), trick resolution, and partnership bidding/scoring
// (bids, bags/sandbagging, Nil). No io/socket/table references anywhere in
// this file on purpose - every function here takes plain data in and returns
// plain data out, so it can be unit tested directly (see
// tests/spades-rules.test.js) without spawning a server.
//
// Card representation: a two-character string that is also the asset
// filename stem in public/images/playing-cards/ (e.g. "QS" = Queen of
// Spades = QS.svg), the same model games/hearts/rules.js uses. Rank chars:
// 2-9, T (ten), J, Q, K, A. Suit chars: C (clubs), D (diamonds), H (hearts),
// S (spades).
//
// Partnerships: Spades is always played as two fixed teams of two, seated
// opposite each other - seats 0 & 2 are partners, seats 1 & 3 are partners
// (see DEFAULT_TEAMS / getTeamIndexForSeat). Unlike Hearts, scoring and
// game-over/winner detection operate on two team totals, not four
// individual ones.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];
const RANK_NAMES = {
  '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven',
  '8': 'Eight', '9': 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace'
};
const SUIT_NAMES = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };

const NIL_BID = 0;
const MIN_BID = 0;
const MAX_BID = 13;
const DEFAULT_TEAMS = [[0, 2], [1, 3]];
const BAGS_PER_PENALTY = 10;
const BAG_PENALTY_POINTS = 100;
const NIL_BONUS_POINTS = 100;

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

function isSpade(card) {
  return suitOf(card) === 'S';
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

// Spades sort last (trump) so a hand visually groups its trump suit at the
// end, distinct from Hearts' C/D/S/H order (which has no trump concept).
const SUIT_SORT_ORDER = { C: 0, D: 1, H: 2, S: 3 };

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
// (see games/spades/index.js, which shuffles via the shared deps.shuffle
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

// trick: array of { playerIndex, card } already played this trick, in play
// order (empty when this player is about to lead).
function getLegalPlays(hand, trick, spadesBroken) {
  if (!Array.isArray(hand) || !hand.length) {
    return [];
  }

  const playedCards = Array.isArray(trick) ? trick.map(function (entry) { return entry.card; }) : [];

  if (playedCards.length === 0) {
    // Leading this trick. Spades may not be led until broken, unless the
    // hand holds only spades (the only-Hearts-remaining exception in Hearts
    // has a direct analog here).
    if (spadesBroken) {
      return hand.slice();
    }
    const nonSpades = hand.filter(function (card) { return !isSpade(card); });
    return nonSpades.length ? nonSpades : hand.slice();
  }

  // Following - must follow the led suit if able; void hands may play
  // anything, including a spade (which breaks spades - see breaksSpades()).
  const ledSuit = suitOf(playedCards[0]);
  const sameSuit = hand.filter(function (card) { return suitOf(card) === ledSuit; });
  return sameSuit.length ? sameSuit : hand.slice();
}

function isLegalPlay(hand, trick, spadesBroken, card) {
  return getLegalPlays(hand, trick, spadesBroken).indexOf(card) !== -1;
}

// A spade "breaks" spades the moment any spade lands on the table, whether
// led (only possible via the only-spades-remaining exception) or discarded/
// trumped in off-suit. From that point on spades may be led freely.
function breaksSpades(card) {
  return isSpade(card);
}

// trick: array of { playerIndex, card } in play order (length 4). Spades are
// permanent trump: if any spade was played this trick, the highest-ranked
// spade wins regardless of what was led; otherwise the highest card of the
// led suit wins (off-suit, non-trump discards never win).
function resolveTrick(trick) {
  if (!Array.isArray(trick) || trick.length !== 4) {
    throw new Error('resolveTrick() requires exactly 4 plays');
  }

  const spadesPlayed = trick.filter(function (entry) { return isSpade(entry.card); });
  const ledSuit = suitOf(trick[0].card);
  const contenders = spadesPlayed.length
    ? spadesPlayed
    : trick.filter(function (entry) { return suitOf(entry.card) === ledSuit; });

  let winner = contenders[0];
  for (let i = 1; i < contenders.length; i++) {
    if (rankValue(contenders[i].card) > rankValue(winner.card)) {
      winner = contenders[i];
    }
  }
  return winner.playerIndex;
}

// Bid domain is 0-13, where 0 represents Nil (a bid to take zero tricks) -
// there is no other legal meaning for a bid of 0 in Spades, so no separate
// flag is needed to distinguish it from a "real" bid.
function getLegalBids() {
  const bids = [];
  for (let bid = MIN_BID; bid <= MAX_BID; bid++) {
    bids.push(bid);
  }
  return bids;
}

function isLegalBid(bid) {
  return typeof bid === 'number' && Number.isInteger(bid) && bid >= MIN_BID && bid <= MAX_BID;
}

function isNilBid(bid) {
  return bid === NIL_BID;
}

function getTeammateIndex(seatIndex) {
  return (seatIndex + 2) % 4;
}

// Fixed partnership layout: seats 0 & 2 are team 0, seats 1 & 3 are team 1.
function getTeamIndexForSeat(seatIndex) {
  return seatIndex % 2;
}

// bids/tricksWon: arrays indexed by seat (length 4). teams: e.g.
// DEFAULT_TEAMS ([[0,2],[1,3]]). bagsCarry: [teamABags, teamBBags] carried in
// from the caller - this function stays pure by taking/returning it rather
// than mutating any shared state itself (see games/spades/index.js, which
// persists the returned bags array hand-to-hand on table.game.bags).
//
// Returns { teamPoints: [pts0, pts1], bags: [bags0, bags1],
// bagPenaltyApplied: [bool, bool], contractMade: [bool, bool] }.
function scoreHand(params) {
  const bids = params.bids;
  const tricksWon = params.tricksWon;
  const teams = params.teams || DEFAULT_TEAMS;
  const bagsCarry = params.bagsCarry || [0, 0];

  const teamPoints = [];
  const bags = [];
  const bagPenaltyApplied = [];
  const contractMade = [];

  teams.forEach(function (seats, teamIndex) {
    const a = seats[0];
    const b = seats[1];
    const teamBid = bids[a] + bids[b];
    const teamTricks = tricksWon[a] + tricksWon[b];
    const madeContract = teamTricks >= teamBid;

    let contractPoints;
    let overtricks = 0;
    if (madeContract) {
      contractPoints = 10 * teamBid;
      overtricks = teamTricks - teamBid;
    } else {
      contractPoints = -10 * teamBid;
    }

    let nilPoints = 0;
    seats.forEach(function (seat) {
      if (isNilBid(bids[seat])) {
        nilPoints += tricksWon[seat] === 0 ? NIL_BONUS_POINTS : -NIL_BONUS_POINTS;
      }
    });

    let teamBags = (typeof bagsCarry[teamIndex] === 'number' ? bagsCarry[teamIndex] : 0) + overtricks;
    let bagPenaltyPoints = 0;
    let penaltyApplied = false;
    while (teamBags >= BAGS_PER_PENALTY) {
      teamBags -= BAGS_PER_PENALTY;
      bagPenaltyPoints -= BAG_PENALTY_POINTS;
      penaltyApplied = true;
    }

    teamPoints.push(contractPoints + overtricks + nilPoints + bagPenaltyPoints);
    bags.push(teamBags);
    bagPenaltyApplied.push(penaltyApplied);
    contractMade.push(madeContract);
  });

  return { teamPoints: teamPoints, bags: bags, bagPenaltyApplied: bagPenaltyApplied, contractMade: contractMade };
}

function isGameOver(teamScores, targetScore) {
  return teamScores.some(function (score) { return score >= targetScore; });
}

function getWinnerTeamIndex(teamScores) {
  let winnerIndex = 0;
  for (let i = 1; i < teamScores.length; i++) {
    if (teamScores[i] > teamScores[winnerIndex]) {
      winnerIndex = i;
    }
  }
  return winnerIndex;
}

module.exports = {
  RANKS: RANKS,
  SUITS: SUITS,
  NIL_BID: NIL_BID,
  MIN_BID: MIN_BID,
  MAX_BID: MAX_BID,
  DEFAULT_TEAMS: DEFAULT_TEAMS,
  createDeck: createDeck,
  rankOf: rankOf,
  suitOf: suitOf,
  rankValue: rankValue,
  isSpade: isSpade,
  cardName: cardName,
  suitName: suitName,
  sortHand: sortHand,
  deal: deal,
  getLegalPlays: getLegalPlays,
  isLegalPlay: isLegalPlay,
  breaksSpades: breaksSpades,
  resolveTrick: resolveTrick,
  getLegalBids: getLegalBids,
  isLegalBid: isLegalBid,
  isNilBid: isNilBid,
  getTeammateIndex: getTeammateIndex,
  getTeamIndexForSeat: getTeamIndexForSeat,
  scoreHand: scoreHand,
  isGameOver: isGameOver,
  getWinnerTeamIndex: getWinnerTeamIndex
};
