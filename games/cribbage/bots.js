// Trivial Cribbage bot heuristics, built on top of the pure rules engine.
// Intentionally simple (no lookahead, no card counting) per the project's
// "do not invent a complicated bot system" constraint - these exist only so
// a table can start early with a single human player.

const rules = require('./rules');

function combinations(items, size) {
  const results = [];
  function recurse(start, chosen) {
    if (chosen.length === size) {
      results.push(chosen.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]);
      recurse(i + 1, chosen);
      chosen.pop();
    }
  }
  recurse(0, []);
  return results;
}

// Rough static value of a 4-card hand's fifteen/pair/run potential (starter
// unknown, so this only looks at the 4 cards themselves).
function evaluateRetainedHand(fourCards) {
  let score = 0;

  for (let mask = 1; mask < 16; mask++) {
    let sum = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (mask & (1 << bit)) {
        sum += rules.cardValue(fourCards[bit]);
      }
    }
    if (sum === 15) {
      score += 2;
    }
  }

  const rankCounts = {};
  fourCards.forEach(function (card) {
    const rank = rules.rankOf(card);
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
  });
  Object.keys(rankCounts).forEach(function (rank) {
    const size = rankCounts[rank];
    if (size >= 2) {
      score += size * (size - 1);
    }
  });

  const orderValues = fourCards.map(rules.rankOrderValue).sort(function (a, b) { return a - b; });
  const uniqueValues = orderValues.filter(function (value, index) { return orderValues.indexOf(value) === index; });
  for (let n = uniqueValues.length; n >= 3; n--) {
    for (let start = 0; start + n <= uniqueValues.length; start++) {
      const window = uniqueValues.slice(start, start + n);
      let consecutive = true;
      for (let i = 1; i < window.length; i++) {
        if (window[i] !== window[i - 1] + 1) {
          consecutive = false;
          break;
        }
      }
      if (consecutive) {
        score += n;
      }
    }
  }

  return score;
}

// Bonus (own crib) or penalty (opponent's crib) for the two discarded cards:
// pairs, cards summing to 5 or 15, a lone 5, and adjacent ranks (a cheap
// run-start) are all good crib material.
function evaluateCribAdjustment(discarded) {
  let bonus = 0;
  const [a, b] = discarded;

  if (rules.rankOf(a) === rules.rankOf(b)) {
    bonus += 4;
  }
  const sum = rules.cardValue(a) + rules.cardValue(b);
  if (sum === 5 || sum === 15) {
    bonus += 3;
  }
  if (rules.rankOf(a) === '5' || rules.rankOf(b) === '5') {
    bonus += 2;
  }
  if (Math.abs(rules.rankOrderValue(a) - rules.rankOrderValue(b)) === 1) {
    bonus += 1;
  }

  return bonus;
}

function chooseBotDiscard(hand, isOwnCrib) {
  const candidates = combinations(hand, 2);
  let best = candidates[0];
  let bestScore = -Infinity;

  candidates.forEach(function (discard) {
    const retained = hand.filter(function (card) { return discard.indexOf(card) === -1; });
    const retainedScore = evaluateRetainedHand(retained);
    const cribAdjustment = evaluateCribAdjustment(discard);
    const netScore = retainedScore + (isOwnCrib ? cribAdjustment : -cribAdjustment);

    if (netScore > bestScore) {
      bestScore = netScore;
      best = discard;
    }
  });

  return { cards: best };
}

// lastPlayedCard (optional): the most recently played card in the current
// pegging segment, if any - used only to look for a cheap pair-completion.
function choosePegPlay(hand, count, lastPlayedCard) {
  const legal = rules.getLegalPeggingPlays(hand, count);
  if (!legal.length) {
    return null;
  }

  const scoring = legal.filter(function (card) {
    const total = count + rules.cardValue(card);
    return total === 15 || total === 31;
  });
  if (scoring.length) {
    return scoring[0];
  }

  if (lastPlayedCard) {
    const pairing = legal.filter(function (card) { return rules.rankOf(card) === rules.rankOf(lastPlayedCard); });
    if (pairing.length) {
      return pairing[0];
    }
  }

  const safe = legal.filter(function (card) {
    const total = count + rules.cardValue(card);
    return total !== 5 && total !== 21;
  });
  const pool = safe.length ? safe : legal;

  return pool.reduce(function (lowest, card) {
    return rules.cardValue(card) < rules.cardValue(lowest) ? card : lowest;
  }, pool[0]);
}

module.exports = {
  chooseBotDiscard: chooseBotDiscard,
  choosePegPlay: choosePegPlay
};
