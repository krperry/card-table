// Rummy bot heuristics, built on top of the pure rules engine. Non-Joker
// play (which melds/lay-offs to make, what to discard) stays intentionally
// simple/greedy, no lookahead, per the project's standing "do not invent a
// complicated bot system" constraint (see games/spades/bots.js's header
// comment) - these exist only so a table can start with fewer than the full
// human complement, not to play optimally.
//
// Jokers are the one place this module deliberately does more than a greedy
// first-fit: a Joker is a scarce, flexible resource (the deck only has two),
// and using one badly (or on the wrong meld) is highly visible to a human
// opponent in a way a slightly-suboptimal discard isn't. So instead of
// "use a Joker as soon as any legal spot exists" (the old behavior), this
// module generates every reasonable legal Joker play - a brand-new meld from
// cards still in hand, or an extension of any existing meld on any seat's
// board - and scores each one (see scoreJokerPlay()) before picking the
// best, per the issue this exists to fix ("Fix Joker Placement and Improve
// Rummy Bot Joker Strategy").
//
// Crucially, every candidate's legality is decided by
// games/rummy/rules.js's isValidSet()/isValidRun()/findBestJokerAssignment()
// - the SAME functions games/rummy/index.js's performLayOffCards() uses to
// resolve a human player's multi-card lay-off selection. This module never
// re-implements what makes a meld or a Joker placement legal; it only
// generates candidates (which groups/combinations to consider) and scores
// them (which one is worth playing). If the configured Rummy variant's
// legality rules ever change (see rules.js's header - e.g. a future "pure
// sequence" requirement), both the human path and this bot automatically
// stay in sync, because neither one owns a separate copy of that logic.

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

function removeCardsFrom(list, cards) {
  cards.forEach(function (card) {
    const index = list.indexOf(card);
    if (index !== -1) {
      list.splice(index, 1);
    }
  });
}

function deepCopyMelds(allMelds) {
  return (allMelds || []).map(function (seatGroups) {
    return (seatGroups || []).map(function (group) {
      return { type: group.type, cards: group.cards.slice() };
    });
  });
}

// --- Natural (non-Joker) melds and lay-offs -------------------------------
// Unchanged in spirit from before: grab every obvious real-card set/run,
// then attach every remaining real card that fits an existing group. Never
// spends a Joker - see the Joker-aware pass below for that.

function extractNaturalSets(remaining, melds) {
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
      const group = cards.slice(0, Math.min(4, cards.length));
      melds.push(group);
      removeCardsFrom(remaining, group);
    }
  });
}

function extractNaturalRuns(remaining, melds) {
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
      if (j - i + 1 >= 3) {
        const run = suitCards.slice(i, j + 1);
        melds.push(run);
        removeCardsFrom(remaining, run);
      }
      i = j + 1;
    }
  });
}

// Attaches every remaining REAL (non-Joker) card that fits some group,
// across all seats (bot's own seat first - see chooseMeldsAndLayoffs()),
// mutating `remaining`/`layoffs`/`simulatedMelds` as it goes so a second
// card can stack onto a group the first lay-off just grew.
function runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const candidates = remaining.filter(function (card) { return !rules.isJoker(card); });
    for (let i = 0; i < candidates.length && !progressed; i++) {
      const card = candidates[i];
      for (let s = 0; s < seatOrder.length && !progressed; s++) {
        const seatIndex = seatOrder[s];
        const groups = simulatedMelds[seatIndex] || [];
        for (let g = 0; g < groups.length; g++) {
          if (rules.canExtendMeld(groups[g], card)) {
            groups[g].cards.push(card);
            layoffs.push({ targetPlayerIndex: seatIndex, cards: [card] });
            removeCardsFrom(remaining, [card]);
            progressed = true;
            break;
          }
        }
      }
    }
  }
}

// --- Joker play candidate generation --------------------------------------
// Each candidate describes one legal way to spend Joker(s): either joining
// an existing meld (via rules.findBestJokerAssignment() - the same engine
// performLayOffCards() uses) or forming a brand-new meld from cards still in
// hand. Only candidates that actually use a Joker are returned - a
// Joker-free option was already handled by the natural passes above.

function generateJokerLayoffCandidates(remaining, simulatedMelds) {
  const candidates = [];
  if (!remaining.some(rules.isJoker)) {
    return candidates;
  }
  simulatedMelds.forEach(function (seatGroups, seatIndex) {
    (seatGroups || []).forEach(function (group, groupIndex) {
      const assignment = rules.findBestJokerAssignment(group, remaining);
      if (assignment.cards.length && assignment.cards.some(rules.isJoker)) {
        candidates.push({
          kind: 'layoff',
          type: group.type,
          targetSeatIndex: seatIndex,
          groupIndex: groupIndex,
          cardsUsed: assignment.cards
        });
      }
    });
  });
  return candidates;
}

// How many distinct real cards would complete this same combination WITHOUT
// a Joker - a rough "how hard is this to finish naturally" proxy (rule 5/10
// in the issue this exists for): a set already holding real cards in 2 of
// the 4 suits has 2 outs (either remaining suit finishes it) and is "easy";
// a run missing one specific internal card has exactly 1 out and is "hard".
// Deliberately ignores which of those outs are already visible elsewhere
// (discards, other melds) - a full deck-count would be more precise but
// isn't needed to make the strategic calls the issue asks for, and keeps
// this a single small function instead of another card-tracking subsystem.
function naturalCompletionOuts(realCards, type) {
  if (type === 'set') {
    const suits = new Set(realCards.map(rules.suitOf));
    return 4 - suits.size;
  }
  if (type === 'run') {
    const suit = rules.suitOf(realCards[0]);
    const values = realCards.map(rules.rankOrderValue).sort(function (a, b) { return a - b; });
    const min = values[0];
    const max = values[values.length - 1];
    const gapOuts = (max - min + 1) - values.length;
    if (gapOuts > 0) {
      return gapOuts;
    }
    let outs = 0;
    if (min > 1) {
      outs++;
    }
    if (max < 13) {
      outs++;
    }
    return outs;
  }
  return 0;
}

// Candidate brand-new melds built from real cards still in hand plus just
// enough of the bot's actual Jokers (never more than it holds) to complete
// them. Mirrors extractNaturalSets()/extractNaturalRuns() above but keeps
// every legal combination as a scored candidate instead of greedily taking
// the first one found.
function generateJokerNewMeldCandidates(remaining) {
  const candidates = [];
  const jokers = remaining.filter(rules.isJoker);
  if (!jokers.length) {
    return candidates;
  }

  const byRank = {};
  remaining.forEach(function (card) {
    if (rules.isJoker(card)) {
      return;
    }
    (byRank[rules.rankOf(card)] = byRank[rules.rankOf(card)] || []).push(card);
  });
  Object.keys(byRank).forEach(function (rank) {
    const cards = byRank[rank];
    if (!cards.length || cards.length > 2) {
      return;
    }
    for (let jokerCount = 1; jokerCount <= jokers.length; jokerCount++) {
      const group = cards.concat(jokers.slice(0, jokerCount));
      if (rules.isValidSet(group)) {
        candidates.push({ kind: 'newMeld', type: 'set', cardsUsed: group, realCardsUsed: cards });
        break; // fewest Jokers that make it legal - no reason to also price out the pricier version
      }
    }
  });

  rules.SUITS.forEach(function (suit) {
    const suitCards = remaining
      .filter(function (card) { return rules.suitOf(card) === suit; })
      .sort(function (a, b) { return rules.rankOrderValue(a) - rules.rankOrderValue(b); });
    for (let i = 0; i < suitCards.length; i++) {
      for (let j = i; j < suitCards.length; j++) {
        const span = suitCards.slice(i, j + 1);
        for (let jokerCount = 1; jokerCount <= jokers.length; jokerCount++) {
          const group = span.concat(jokers.slice(0, jokerCount));
          if (group.length < 3) {
            continue;
          }
          if (rules.isValidRun(group)) {
            candidates.push({ kind: 'newMeld', type: 'run', cardsUsed: group, realCardsUsed: span });
          }
        }
      }
    }
  });

  return candidates;
}

// One-ply lookahead (rule 3/11): after simulating a Joker play, checks
// whether any further remaining REAL cards can now be laid off onto the
// updated board - e.g. the "5S 6S 7S + Joker(=8S) + 9S, then TS also fits"
// chain. Mutates the `simulatedMeldsAfter` copy it's given; the caller is
// responsible for passing a throwaway deep copy.
function simulateFollowUpLayoffs(remainingAfter, simulatedMeldsAfter) {
  let unlockedCount = 0;
  let unlockedValue = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < remainingAfter.length && !progressed; i++) {
      const card = remainingAfter[i];
      if (rules.isJoker(card)) {
        continue;
      }
      for (let s = 0; s < simulatedMeldsAfter.length && !progressed; s++) {
        const groups = simulatedMeldsAfter[s] || [];
        for (let g = 0; g < groups.length; g++) {
          if (rules.canExtendMeld(groups[g], card)) {
            groups[g].cards.push(card);
            unlockedCount++;
            unlockedValue += rules.cardValue(card);
            remainingAfter.splice(i, 1);
            progressed = true;
            break;
          }
        }
      }
    }
  }
  return { unlockedCount: unlockedCount, unlockedValue: unlockedValue };
}

// --- Scoring ---------------------------------------------------------------
// score = cards_removed + deadwood_reduction + additional_cards_unlocked
//       + going_out_bonus + difficult_meld_bonus + opponent_near_out_bonus
//       - joker_opportunity_cost - easy_natural_completion_penalty
// (see the issue's "Suggested Joker Scoring System"). Weights are tuned only
// enough to satisfy the issue's ordering rules (e.g. "a play that lets the
// bot go out should normally dominate all other choices"), not to any
// deeper notion of optimal Rummy strategy.
const CARDS_REMOVED_WEIGHT = 3;
const UNLOCKED_CARD_WEIGHT = 5;
const GOING_OUT_BONUS = 500;
const OPPONENT_NEAR_OUT_HAND_SIZE = 3;
const OPPONENT_NEAR_OUT_BONUS_PER_CARD = 4;
const DIFFICULTY_BONUS_PER_OUT_BELOW_TWO = 3;
const EASY_COMPLETION_PENALTY_PER_EXTRA_OUT = 3;
const JOKER_BASE_OPPORTUNITY_COST = 6;
const OWN_SEAT_TIEBREAK_BONUS = 0.5;
// A hand this size or larger is "early" for the purposes of discounting how
// much it costs to spend a Joker now vs. saving it (rule 7) - not tied to
// any particular deal size, just a reference point for the discount curve.
const EARLY_HAND_REFERENCE_SIZE = 7;

function scoreJokerPlay(candidate, remaining, simulatedMelds, ownSeatIndex, context) {
  const jokersUsed = candidate.cardsUsed.filter(rules.isJoker).length;
  const cardsRemovedCount = candidate.cardsUsed.length;
  const deadwoodRemoved = candidate.cardsUsed.reduce(function (sum, c) { return sum + rules.cardValue(c); }, 0);

  const remainingAfter = remaining.slice();
  removeCardsFrom(remainingAfter, candidate.cardsUsed);

  const meldsAfter = deepCopyMelds(simulatedMelds);
  if (candidate.kind === 'layoff') {
    const group = meldsAfter[candidate.targetSeatIndex][candidate.groupIndex];
    group.cards = group.cards.concat(candidate.cardsUsed);
  } else {
    meldsAfter[ownSeatIndex] = (meldsAfter[ownSeatIndex] || []).concat([{ type: candidate.type, cards: candidate.cardsUsed.slice() }]);
  }

  const followUp = simulateFollowUpLayoffs(remainingAfter, meldsAfter);
  const handSizeAfter = remainingAfter.length;
  const goingOutBonus = handSizeAfter <= 0 ? GOING_OUT_BONUS : 0;

  const minOpponentHandSize = context && typeof context.minOpponentHandSize === 'number' ? context.minOpponentHandSize : null;
  const opponentNearOut = minOpponentHandSize !== null && minOpponentHandSize <= OPPONENT_NEAR_OUT_HAND_SIZE;
  const opponentBonus = opponentNearOut ? (cardsRemovedCount + followUp.unlockedCount) * OPPONENT_NEAR_OUT_BONUS_PER_CARD : 0;

  let difficultyAdjustment = 0;
  if (candidate.kind === 'newMeld') {
    const outs = naturalCompletionOuts(candidate.realCardsUsed, candidate.type);
    difficultyAdjustment = outs <= 1
      ? DIFFICULTY_BONUS_PER_OUT_BELOW_TWO * (2 - outs)
      : -(EASY_COMPLETION_PENALTY_PER_EXTRA_OUT * (outs - 1));
  }

  // Spending a Joker costs more early in a hand (lots of cards still to
  // play, more chances a better spot for it turns up) and less as the hand
  // empties out (rule 7 - "don't hold a Joker forever").
  const lateHandDiscount = Math.min(1, remaining.length / EARLY_HAND_REFERENCE_SIZE);
  const opportunityCost = JOKER_BASE_OPPORTUNITY_COST * jokersUsed * lateHandDiscount;

  const ownSeatBonus = candidate.kind === 'layoff' && candidate.targetSeatIndex === ownSeatIndex ? OWN_SEAT_TIEBREAK_BONUS : 0;

  const score = cardsRemovedCount * CARDS_REMOVED_WEIGHT
    + deadwoodRemoved
    + followUp.unlockedCount * UNLOCKED_CARD_WEIGHT
    + followUp.unlockedValue
    + goingOutBonus
    + opponentBonus
    + difficultyAdjustment
    + ownSeatBonus
    - opportunityCost;

  return { candidate: candidate, score: score };
}

// Greedily melds every obvious real-card set/run and lays off every
// obvious real card first (rule 10 - never spend a Joker on something the
// hand can already do for real), then repeatedly generates every legal
// Joker play still available, scores each one (see scoreJokerPlay() above),
// and takes the best-scoring play as long as it clears a minimum bar -
// otherwise the Joker(s) are held (rule 9). Repeats (bounded, since a table
// Rummy deck only has 2 Jokers) since taking one play can unlock or change
// what the next-best play is. `context.minOpponentHandSize`, when supplied,
// is the fewest cards any opponent is currently holding - used for rule 8
// ("become more aggressive when an opponent is nearly out").
function chooseMeldsAndLayoffs(hand, allMelds, ownSeatIndex, context) {
  const remaining = hand.slice();
  const melds = [];
  const layoffs = [];

  const seatOrder = (allMelds || []).map(function (_, index) { return index; });
  if (typeof ownSeatIndex === 'number') {
    seatOrder.sort(function (a, b) {
      if (a === ownSeatIndex) return -1;
      if (b === ownSeatIndex) return 1;
      return 0;
    });
  }

  extractNaturalSets(remaining, melds);
  extractNaturalRuns(remaining, melds);

  const simulatedMelds = deepCopyMelds(allMelds);
  runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs);

  let guard = 0;
  while (remaining.some(rules.isJoker) && guard < 4) {
    guard++;
    const candidates = generateJokerLayoffCandidates(remaining, simulatedMelds)
      .concat(generateJokerNewMeldCandidates(remaining));
    if (!candidates.length) {
      break;
    }

    let winner = null;
    candidates.forEach(function (candidate) {
      const scored = scoreJokerPlay(candidate, remaining, simulatedMelds, ownSeatIndex, context);
      if (!winner || scored.score > winner.score) {
        winner = scored;
      }
    });

    if (!winner || winner.score <= 0) {
      break;
    }

    const candidate = winner.candidate;
    if (candidate.kind === 'layoff') {
      simulatedMelds[candidate.targetSeatIndex][candidate.groupIndex].cards =
        simulatedMelds[candidate.targetSeatIndex][candidate.groupIndex].cards.concat(candidate.cardsUsed);
      layoffs.push({ targetPlayerIndex: candidate.targetSeatIndex, cards: candidate.cardsUsed.slice() });
    } else {
      simulatedMelds[ownSeatIndex] = (simulatedMelds[ownSeatIndex] || []).concat([{ type: candidate.type, cards: candidate.cardsUsed.slice() }]);
      melds.push(candidate.cardsUsed.slice());
    }
    removeCardsFrom(remaining, candidate.cardsUsed);

    // Cards freed up by the play just taken (e.g. the 9S in a
    // "5S 6S 7S + Joker(=8S) + 9S" lay-off, when the winning candidate
    // didn't already bundle them - or any other card newly adjacent to an
    // updated group) should also go, not wait for a future turn.
    runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs);
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
