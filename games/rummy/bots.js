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

// --- Entire discard pile (optional table rule: matchSettings.
// allowDrawEntirePile - see games/rummy/index.js's normalizeMatchSettings)---
// The bot must never take the whole pile just because it's an option (per
// the issue this exists for: "do not have the bot blindly take the pile
// simply because it can") - taking 12 cards for one mildly useful one is a
// bad trade, while taking 4 cards that immediately meld or lay off is a good
// one. countUsefulPileCards() walks the pile top-to-bottom, simulating it
// being added to the hand one card at a time (so a pair of same-rank cards
// BOTH sitting in the pile counts each other, same reasoning as
// chooseDrawSource()'s single-card completesVisibleMeld() check), scoring a
// card "useful" if it would either complete/extend something already
// visible in the (growing) simulated hand, or lay off directly onto an
// existing meld on the table. A Joker is always useful (it's the scarcest,
// most flexible resource in the deck - see games/rummy/rules.js's header).
const PILE_MIN_SIZE_TO_CONSIDER = 2;
const PILE_USEFUL_CARD_WEIGHT = 6;
const PILE_JOKER_BONUS = 10;
const PILE_USELESS_CARD_PENALTY = 4;
const PILE_DEADWOOD_WEIGHT = 0.5;
const PILE_TAKE_SCORE_THRESHOLD = 3;

function countUsefulPileCards(hand, discardPile, melds, options) {
  const simulatedHand = hand.slice();
  let useful = 0;
  discardPile.forEach(function (card) {
    const isUseful = rules.isJoker(card)
      || completesVisibleMeld(simulatedHand, card)
      || (melds || []).some(function (seatGroups) {
        return (seatGroups || []).some(function (group) { return rules.canExtendMeld(group, card, options); });
      });
    if (isUseful) {
      useful++;
    }
    simulatedHand.push(card);
  });
  return useful;
}

// score = useful_cards*weight + jokers*bonus - useless_cards*penalty -
// deadwood_added*weight (see the issue's list of factors to weigh: pile
// size, immediate/extended melds, deadwood added/eliminated, Jokers, and how
// close it gets the bot to going out - going-out potential is already
// implicitly covered since a hand full of useful cards drives deadwood and
// uselessCount both toward zero, which is exactly what maximizes this
// score). Only ever considered for a pile with at least
// PILE_MIN_SIZE_TO_CONSIDER cards - a 1-card pile is just an ordinary
// top-discard take, already handled by chooseDrawSource().
function evaluateDiscardPile(hand, discardPile, melds, options) {
  if (!Array.isArray(discardPile) || discardPile.length < PILE_MIN_SIZE_TO_CONSIDER) {
    return { take: false, score: -Infinity };
  }
  const usefulCount = countUsefulPileCards(hand, discardPile, melds, options);
  const uselessCount = discardPile.length - usefulCount;
  const jokerCount = discardPile.filter(rules.isJoker).length;
  const deadwoodAdded = discardPile.reduce(function (sum, c) { return sum + rules.cardValue(c, options); }, 0);
  const score = usefulCount * PILE_USEFUL_CARD_WEIGHT
    + jokerCount * PILE_JOKER_BONUS
    - uselessCount * PILE_USELESS_CARD_PENALTY
    - deadwoodAdded * PILE_DEADWOOD_WEIGHT;
  return { take: score > PILE_TAKE_SCORE_THRESHOLD, score: score, usefulCount: usefulCount };
}

// The bot's full draw-phase choice - 'pile' (only ever offered when the
// table rule is on, per context.allowDrawEntirePile), 'discard', or 'stock'.
// Falls back to the existing chooseDrawSource() stock-vs-discard heuristic
// whenever taking the whole pile isn't on the table or isn't worth it.
// context: { allowDrawEntirePile, rulesOptions } - see
// games/rummy/index.js's runBotTurn(), which builds this from the table's
// matchSettings/rulesOptions() the same way a human player's client reads
// them off table.matchSettings.
function chooseDrawAction(hand, topDiscard, discardPile, melds, context) {
  const options = context && context.rulesOptions;
  if (context && context.allowDrawEntirePile && Array.isArray(discardPile) && discardPile.length >= PILE_MIN_SIZE_TO_CONSIDER) {
    const evaluation = evaluateDiscardPile(hand, discardPile, melds, options);
    if (evaluation.take) {
      return 'pile';
    }
  }
  return chooseDrawSource(hand, topDiscard);
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

// Ace-low order value (rules.rankOrderValue, unaffected by any option) and
// ace-high order value (Ace sorts as if it were rank 14, immediately above
// King - see games/rummy/rules.js's "Ace High or Low" section) - used to
// scan a suit's cards for BOTH a low-anchored run (A-2-3, always considered)
// and, when the table's aceHighOrLow option is on, a high-anchored one
// (Q-K-A) too. A plain rankOrderValue-only scan would never notice Q-K-A:
// sorted ace-low, the Ace sits at the very front of the array (value 1),
// nowhere near Q/K at the back, so no contiguous slice of that single
// sorted order can ever capture all three.
function aceLowOrderValue(card) {
  return rules.rankOrderValue(card);
}
function aceHighOrderValue(card) {
  return rules.rankOf(card) === 'A' ? rules.ACE_HIGH_ORDER_VALUE : rules.rankOrderValue(card);
}

function extractNaturalRunsForOrder(remaining, melds, orderValueFn) {
  rules.SUITS.forEach(function (suit) {
    const suitCards = remaining
      .filter(function (card) { return rules.suitOf(card) === suit; })
      .sort(function (a, b) { return orderValueFn(a) - orderValueFn(b); });

    let i = 0;
    while (i < suitCards.length) {
      let j = i;
      while (j + 1 < suitCards.length && orderValueFn(suitCards[j + 1]) === orderValueFn(suitCards[j]) + 1) {
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

function extractNaturalRuns(remaining, melds, options) {
  extractNaturalRunsForOrder(remaining, melds, aceLowOrderValue);
  if (options && options.aceHighOrLow) {
    extractNaturalRunsForOrder(remaining, melds, aceHighOrderValue);
  }
}

// Attaches every remaining REAL (non-Joker) card that fits some group,
// across all seats (bot's own seat first - see chooseMeldsAndLayoffs()),
// mutating `remaining`/`layoffs`/`simulatedMelds` as it goes so a second
// card can stack onto a group the first lay-off just grew.
function runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs, options) {
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
          if (rules.canExtendMeld(groups[g], card, options)) {
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

function generateJokerLayoffCandidates(remaining, simulatedMelds, options) {
  const candidates = [];
  if (!remaining.some(rules.isJoker)) {
    return candidates;
  }
  simulatedMelds.forEach(function (seatGroups, seatIndex) {
    (seatGroups || []).forEach(function (group, groupIndex) {
      const assignment = rules.findBestJokerAssignment(group, remaining, options);
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
// Resolves a run candidate's real cards to order values (+ the domain those
// values live in) for the "how many outs" estimate below. When the group
// holds an Ace and the table's aceHighOrLow option is on, which of the two
// possible Ace positions applies is inferred from the OTHER real cards
// riding along with it: cards T/J/Q/K alongside the Ace mean it's anchoring
// the top (Q-K-A), cards 2/3/4 mean it's anchoring the bottom (A-2-3) - the
// same distinction games/rummy/rules.js's isValidRun() makes precisely by
// trying both and keeping whichever validates, simplified here to a single
// guess since this is only a soft "how hard to complete" heuristic, not a
// legality decision.
function resolveRunOrderValuesAndDomain(realCards, options) {
  const hasAce = realCards.some(function (c) { return rules.rankOf(c) === 'A'; });
  if (!hasAce || !(options && options.aceHighOrLow)) {
    return { values: realCards.map(rules.rankOrderValue), domain: { min: 1, max: 13 } };
  }
  const nonAceValues = realCards.filter(function (c) { return rules.rankOf(c) !== 'A'; }).map(rules.rankOrderValue);
  const looksHigh = nonAceValues.some(function (v) { return v >= 10; });
  const looksLow = nonAceValues.some(function (v) { return v <= 4; });
  const useHigh = looksHigh && !looksLow;
  const aceValue = useHigh ? rules.ACE_HIGH_ORDER_VALUE : rules.ACE_LOW_ORDER_VALUE;
  const values = realCards.map(function (c) { return rules.rankOf(c) === 'A' ? aceValue : rules.rankOrderValue(c); });
  return { values: values, domain: useHigh ? { min: 2, max: 14 } : { min: 1, max: 13 } };
}

function naturalCompletionOuts(realCards, type, options) {
  if (type === 'set') {
    const suits = new Set(realCards.map(rules.suitOf));
    return 4 - suits.size;
  }
  if (type === 'run') {
    const resolved = resolveRunOrderValuesAndDomain(realCards, options);
    const values = resolved.values.slice().sort(function (a, b) { return a - b; });
    const min = values[0];
    const max = values[values.length - 1];
    const gapOuts = (max - min + 1) - values.length;
    if (gapOuts > 0) {
      return gapOuts;
    }
    let outs = 0;
    if (min > resolved.domain.min) {
      outs++;
    }
    if (max < resolved.domain.max) {
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
// Run-span candidates for one specific card ordering (see aceLowOrderValue/
// aceHighOrderValue above) - split out of generateJokerNewMeldCandidates()
// so it can be run twice (ace-low and, when the table's aceHighOrLow option
// is on, ace-high too) for the same reason extractNaturalRunsForOrder() is:
// a single ace-low-sorted scan can never produce a Q-K-A span, since the Ace
// sorts to the very front of that order, nowhere near Q/K at the back.
function generateJokerRunCandidatesForOrder(remaining, jokers, orderValueFn, options) {
  const candidates = [];
  rules.SUITS.forEach(function (suit) {
    const suitCards = remaining
      .filter(function (card) { return rules.suitOf(card) === suit; })
      .sort(function (a, b) { return orderValueFn(a) - orderValueFn(b); });
    for (let i = 0; i < suitCards.length; i++) {
      for (let j = i; j < suitCards.length; j++) {
        const span = suitCards.slice(i, j + 1);
        for (let jokerCount = 1; jokerCount <= jokers.length; jokerCount++) {
          const group = span.concat(jokers.slice(0, jokerCount));
          if (group.length < 3) {
            continue;
          }
          if (rules.isValidRun(group, options)) {
            candidates.push({ kind: 'newMeld', type: 'run', cardsUsed: group, realCardsUsed: span });
          }
        }
      }
    }
  });
  return candidates;
}

// Candidate brand-new melds built from real cards still in hand plus just
// enough of the bot's actual Jokers (never more than it holds) to complete
// them. Mirrors extractNaturalSets()/extractNaturalRuns() above but keeps
// every legal combination as a scored candidate instead of greedily taking
// the first one found.
function generateJokerNewMeldCandidates(remaining, options) {
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

  candidates.push.apply(candidates, generateJokerRunCandidatesForOrder(remaining, jokers, aceLowOrderValue, options));
  if (options && options.aceHighOrLow) {
    candidates.push.apply(candidates, generateJokerRunCandidatesForOrder(remaining, jokers, aceHighOrderValue, options));
  }

  return candidates;
}

// One-ply lookahead (rule 3/11): after simulating a Joker play, checks
// whether any further remaining REAL cards can now be laid off onto the
// updated board - e.g. the "5S 6S 7S + Joker(=8S) + 9S, then TS also fits"
// chain. Mutates the `simulatedMeldsAfter` copy it's given; the caller is
// responsible for passing a throwaway deep copy.
function simulateFollowUpLayoffs(remainingAfter, simulatedMeldsAfter, options) {
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
          if (rules.canExtendMeld(groups[g], card, options)) {
            groups[g].cards.push(card);
            unlockedCount++;
            unlockedValue += rules.cardValue(card, options);
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
  const options = context && context.rulesOptions;
  const jokersUsed = candidate.cardsUsed.filter(rules.isJoker).length;
  const cardsRemovedCount = candidate.cardsUsed.length;
  const deadwoodRemoved = candidate.cardsUsed.reduce(function (sum, c) { return sum + rules.cardValue(c, options); }, 0);

  const remainingAfter = remaining.slice();
  removeCardsFrom(remainingAfter, candidate.cardsUsed);

  const meldsAfter = deepCopyMelds(simulatedMelds);
  if (candidate.kind === 'layoff') {
    const group = meldsAfter[candidate.targetSeatIndex][candidate.groupIndex];
    group.cards = group.cards.concat(candidate.cardsUsed);
  } else {
    meldsAfter[ownSeatIndex] = (meldsAfter[ownSeatIndex] || []).concat([{ type: candidate.type, cards: candidate.cardsUsed.slice() }]);
  }

  const followUp = simulateFollowUpLayoffs(remainingAfter, meldsAfter, options);
  const handSizeAfter = remainingAfter.length;
  const goingOutBonus = handSizeAfter <= 0 ? GOING_OUT_BONUS : 0;

  const minOpponentHandSize = context && typeof context.minOpponentHandSize === 'number' ? context.minOpponentHandSize : null;
  const opponentNearOut = minOpponentHandSize !== null && minOpponentHandSize <= OPPONENT_NEAR_OUT_HAND_SIZE;
  const opponentBonus = opponentNearOut ? (cardsRemovedCount + followUp.unlockedCount) * OPPONENT_NEAR_OUT_BONUS_PER_CARD : 0;

  let difficultyAdjustment = 0;
  if (candidate.kind === 'newMeld') {
    const outs = naturalCompletionOuts(candidate.realCardsUsed, candidate.type, options);
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
  const options = context && context.rulesOptions;
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
  extractNaturalRuns(remaining, melds, options);

  const simulatedMelds = deepCopyMelds(allMelds);
  runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs, options);

  let guard = 0;
  while (remaining.some(rules.isJoker) && guard < 4) {
    guard++;
    const candidates = generateJokerLayoffCandidates(remaining, simulatedMelds, options)
      .concat(generateJokerNewMeldCandidates(remaining, options));
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
    runNaturalLayoffs(remaining, simulatedMelds, seatOrder, layoffs, options);
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
function chooseDiscard(hand, options) {
  if (!Array.isArray(hand) || !hand.length) {
    return null;
  }

  // "Near" a card means within 2 rank positions on the SAME order-value
  // scale. Ace-low is always checked; when the table's aceHighOrLow option
  // is on, the Ace is also checked against the ace-high scale (so a K/Q
  // sitting near an Ace correctly protects it as a near-run card too - see
  // aceHighOrderValue() above). This only ever makes a card MORE likely to
  // be protected (never less), matching the issue's guidance that Ace
  // becomes more important to hang onto (or meld) once it's worth 11
  // deadwood instead of 1.
  function isNearInOrder(hand, card, orderValueFn) {
    const suit = rules.suitOf(card);
    const v = orderValueFn(card);
    return hand.some(function (c) {
      if (c === card || rules.suitOf(c) !== suit) {
        return false;
      }
      return Math.abs(orderValueFn(c) - v) <= 2;
    });
  }

  function isPartOfPairOrNearRun(card) {
    if (cardsShareRank(hand, card) >= 1) {
      return true;
    }
    if (isNearInOrder(hand, card, aceLowOrderValue)) {
      return true;
    }
    return !!(options && options.aceHighOrLow) && isNearInOrder(hand, card, aceHighOrderValue);
  }

  const nonJokers = hand.filter(function (card) { return !rules.isJoker(card); });
  const candidatePool = nonJokers.length ? nonJokers : hand;
  const safeToDiscard = candidatePool.filter(function (card) { return !isPartOfPairOrNearRun(card); });
  const pool = safeToDiscard.length ? safeToDiscard : candidatePool;

  return pool.reduce(function (highest, card) {
    return rules.cardValue(card, options) > rules.cardValue(highest, options) ? card : highest;
  }, pool[0]);
}

module.exports = {
  chooseDrawSource: chooseDrawSource,
  chooseDrawAction: chooseDrawAction,
  chooseMeldsAndLayoffs: chooseMeldsAndLayoffs,
  chooseDiscard: chooseDiscard
};
