// Trivial Rummy bot heuristics, built on top of the pure rules engine.
// Intentionally simple (no lookahead, no hand-shape planning) per the
// project's standing "do not invent a complicated bot system" constraint
// (see games/spades/bots.js's header comment) - these exist only so a table
// can start with a single human player, not to play well.

const rules = require('./rules');

function cardsShareRank(hand, card) {
  const rank = rules.rankOf(card);
  return hand.filter(function (c) { return c !== card && rules.rankOf(c) === rank; }).length;
}

// True if `card` would immediately complete/extend a set or run the bot can
// already see sitting in its own hand (no deeper lookahead than that).
function completesVisibleMeld(hand, card) {
  if (cardsShareRank(hand, card) >= 2) {
    return true;
  }

  const suit = rules.suitOf(card);
  const sameSuitValues = hand
    .filter(function (c) { return rules.suitOf(c) === suit; })
    .map(rules.rankOrderValue);
  const values = new Set(sameSuitValues);
  const v = rules.rankOrderValue(card);
  return (values.has(v - 1) && values.has(v - 2))
    || (values.has(v - 1) && values.has(v + 1))
    || (values.has(v + 1) && values.has(v + 2));
}

function chooseDrawSource(hand, topDiscard) {
  if (topDiscard && completesVisibleMeld(hand, topDiscard)) {
    return 'discard';
  }
  return 'stock';
}

// Greedily melds every obvious set/run sitting in hand, then lays off any
// remaining card that fits an existing meld group (on any seat, including
// the bot's own melds from earlier this turn). No sequencing optimization,
// no holding back for strategic reasons - see this module's header comment.
function chooseMeldsAndLayoffs(hand, allMelds) {
  const remaining = hand.slice();
  const melds = [];

  // Sets first: any rank held 3+ times.
  const byRank = {};
  remaining.forEach(function (card) {
    const rank = rules.rankOf(card);
    (byRank[rank] = byRank[rank] || []).push(card);
  });
  Object.keys(byRank).forEach(function (rank) {
    const cards = byRank[rank];
    if (cards.length >= 3) {
      melds.push(cards.slice(0, Math.min(4, cards.length)));
      melds[melds.length - 1].forEach(function (card) {
        const index = remaining.indexOf(card);
        if (index !== -1) {
          remaining.splice(index, 1);
        }
      });
    }
  });

  // Runs next: walk each suit's remaining cards in rank order, greedily
  // grabbing the longest consecutive stretch of 3+.
  rules.SUITS.forEach(function (suit) {
    const suitCards = remaining
      .filter(function (card) { return rules.suitOf(card) === suit; })
      .sort(function (a, b) { return rules.rankOrderValue(a) - rules.rankOrderValue(b); });

    let i = 0;
    while (i < suitCards.length) {
      let j = i;
      while (j + 1 < suitCards.length && rules.rankOrderValue(suitCards[j + 1]) === rules.rankOrderValue(suitCards[j]) + 1) {
        j++;
      }
      const runLength = j - i + 1;
      if (runLength >= 3) {
        const run = suitCards.slice(i, j + 1);
        melds.push(run);
        run.forEach(function (card) {
          const index = remaining.indexOf(card);
          if (index !== -1) {
            remaining.splice(index, 1);
          }
        });
      }
      i = j + 1;
    }
  });

  // Lay-offs: simulate each target seat's groups (copying so we can extend
  // them locally as we go, letting a second card stack onto a group the
  // first lay-off just grew) and attach any remaining hand card that fits.
  const simulatedMelds = (allMelds || []).map(function (seatGroups) {
    return (seatGroups || []).map(function (group) {
      return { type: group.type, cards: group.cards.slice() };
    });
  });

  const layoffs = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const card = remaining[i];
      let attached = false;
      for (let seatIndex = 0; seatIndex < simulatedMelds.length && !attached; seatIndex++) {
        const groups = simulatedMelds[seatIndex];
        for (let g = 0; g < groups.length; g++) {
          if (rules.canExtendMeld(groups[g], card)) {
            groups[g].cards.push(card);
            layoffs.push({ targetPlayerIndex: seatIndex, cards: [card] });
            remaining.splice(i, 1);
            attached = true;
            progressed = true;
            break;
          }
        }
      }
      if (attached) {
        break;
      }
    }
  }

  return { melds: melds, layoffs: layoffs };
}

// Discards the highest-deadwood-value card that isn't obviously part of a
// pair (another card of the same rank) or a near-run (a same-suit card
// within 2 rank positions) still sitting in hand - a simple heuristic, not a
// lookahead search. Jokers are never volunteered: this heuristic has no
// lookahead to recognize when a Joker is about to complete a meld, and
// Joker has the highest deadwood value of any card (see rules.js), so a
// naive "discard the highest-value safe card" pass would otherwise dump a
// wild card first every time - the opposite of how anyone actually plays.
function chooseDiscard(hand) {
  if (!Array.isArray(hand) || !hand.length) {
    return null;
  }

  function isPartOfPairOrNearRun(card) {
    if (cardsShareRank(hand, card) >= 1) {
      return true;
    }
    const suit = rules.suitOf(card);
    const v = rules.rankOrderValue(card);
    return hand.some(function (c) {
      if (c === card || rules.suitOf(c) !== suit) {
        return false;
      }
      return Math.abs(rules.rankOrderValue(c) - v) <= 2;
    });
  }

  const nonJokers = hand.filter(function (card) { return !rules.isJoker(card); });
  const candidatePool = nonJokers.length ? nonJokers : hand;
  const safeToDiscard = candidatePool.filter(function (card) { return !isPartOfPairOrNearRun(card); });
  const pool = safeToDiscard.length ? safeToDiscard : candidatePool;

  return pool.reduce(function (highest, card) {
    return rules.cardValue(card) > rules.cardValue(highest) ? card : highest;
  }, pool[0]);
}

module.exports = {
  chooseDrawSource: chooseDrawSource,
  chooseMeldsAndLayoffs: chooseMeldsAndLayoffs,
  chooseDiscard: chooseDiscard
};
