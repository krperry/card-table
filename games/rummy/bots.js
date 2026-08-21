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

// Greedily melds every obvious set/run sitting in hand (including
// Joker-assisted ones - see the "Joker-assisted melds" block below), then
// lays off any remaining card that fits an existing meld group (on any
// seat, including the bot's own melds from earlier this turn). No
// sequencing optimization, no holding back for strategic reasons - see this
// module's header comment. `ownSeatIndex` (this bot's own seat index into
// `allMelds`) is used only to prefer the bot's own board over an opponent's
// when a spare Joker has nowhere better to go - see the lay-off block below.
function chooseMeldsAndLayoffs(hand, allMelds, ownSeatIndex) {
  const remaining = hand.slice();
  const melds = [];

  // Sets first: any REAL rank held 3+ times. Jokers are deliberately
  // excluded from this grouping (not just from the resulting melds): a
  // Joker card's first character ("1J"/"2J") happens to collide with the
  // real rank chars "1"/"2" (see rules.js's JOKER_CARDS), so grouping by a
  // raw rankOf() would occasionally sweep a Joker into a "real" 2-set by
  // accident, before the intentional Joker-assisted pass below ever gets a
  // say in it.
  const byRank = {};
  remaining.forEach(function (card) {
    if (rules.isJoker(card)) {
      return;
    }
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

  // Joker-assisted melds: a Joker exists to make a meld the player couldn't
  // otherwise complete (see public/rummy-rules.md) - spending it on the
  // bot's OWN near-complete set/run here, before the lay-off pass below
  // ever gets a chance to hand it to another seat's board, is the whole
  // fix for "the bot dumps its Joker on someone else's meld." Only reached
  // once every real-card-only set/run above has already been grabbed, so a
  // Joker is used here only when it's actually needed - never in place of
  // a run/set the hand could already make on its own.
  //
  // Sets: a real rank still held exactly twice, filled out to 3 by one
  // spare Joker.
  Object.keys(byRank).forEach(function (rank) {
    if (!remaining.some(rules.isJoker)) {
      return;
    }
    const cards = byRank[rank].filter(function (card) { return remaining.indexOf(card) !== -1; });
    if (cards.length === 2) {
      const joker = remaining.find(rules.isJoker);
      const group = cards.concat([joker]);
      if (rules.isValidSet(group)) {
        melds.push(group);
        group.forEach(function (card) {
          const index = remaining.indexOf(card);
          if (index !== -1) {
            remaining.splice(index, 1);
          }
        });
      }
    }
  });

  // Runs: two consecutive same-suit cards left over from the real-run pass,
  // extended to a run of 3 by one spare Joker (filling the gap or extending
  // past either end - both are valid per rules.isValidRun()).
  rules.SUITS.forEach(function (suit) {
    if (!remaining.some(rules.isJoker)) {
      return;
    }
    const suitCards = remaining
      .filter(function (card) { return rules.suitOf(card) === suit; })
      .sort(function (a, b) { return rules.rankOrderValue(a) - rules.rankOrderValue(b); });

    let i = 0;
    while (i + 1 < suitCards.length) {
      if (!remaining.some(rules.isJoker)) {
        break;
      }
      if (rules.rankOrderValue(suitCards[i + 1]) === rules.rankOrderValue(suitCards[i]) + 1) {
        const joker = remaining.find(rules.isJoker);
        const group = [suitCards[i], suitCards[i + 1], joker];
        if (rules.isValidRun(group)) {
          melds.push(group);
          group.forEach(function (card) {
            const index = remaining.indexOf(card);
            if (index !== -1) {
              remaining.splice(index, 1);
            }
          });
          i += 2;
          continue;
        }
      }
      i++;
    }
  });

  // Lay-offs: simulate each target seat's groups (copying so we can extend
  // them locally as we go, letting a second card stack onto a group the
  // first lay-off just grew) and attach any remaining hand card that fits.
  // Real cards are tried first, across all seats, in seat order; any
  // Jokers still left over (with no home in the bot's own hand per the
  // pass above) are held back for a second pass, and within that second
  // pass the bot's own seat (ownSeatIndex) is checked before anyone
  // else's - a spare Joker should shore up the bot's own board before it
  // goes to help an opponent's.
  const simulatedMelds = (allMelds || []).map(function (seatGroups) {
    return (seatGroups || []).map(function (group) {
      return { type: group.type, cards: group.cards.slice() };
    });
  });

  const seatOrder = simulatedMelds.map(function (_, index) { return index; });
  if (typeof ownSeatIndex === 'number') {
    seatOrder.sort(function (a, b) {
      if (a === ownSeatIndex) return -1;
      if (b === ownSeatIndex) return 1;
      return 0;
    });
  }

  const layoffs = [];

  // Tries to attach the first candidate card (in order) that fits some
  // seat's group; returns true and mutates `remaining`/`layoffs` on
  // success, false once none of the candidates fit anywhere.
  function attachOneCard(candidateCards) {
    for (let i = 0; i < candidateCards.length; i++) {
      const card = candidateCards[i];
      for (let s = 0; s < seatOrder.length; s++) {
        const seatIndex = seatOrder[s];
        const groups = simulatedMelds[seatIndex];
        for (let g = 0; g < groups.length; g++) {
          if (rules.canExtendMeld(groups[g], card)) {
            groups[g].cards.push(card);
            layoffs.push({ targetPlayerIndex: seatIndex, cards: [card] });
            const index = remaining.indexOf(card);
            if (index !== -1) {
              remaining.splice(index, 1);
            }
            return true;
          }
        }
      }
    }
    return false;
  }

  let progressed = true;
  while (progressed) {
    progressed = attachOneCard(remaining.filter(function (card) { return !rules.isJoker(card); }));
  }
  progressed = true;
  while (progressed) {
    progressed = attachOneCard(remaining.filter(rules.isJoker));
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
