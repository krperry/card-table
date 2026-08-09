// Trivial Hearts bot heuristics, built on top of the pure rules engine.
// Intentionally simple (no lookahead, no card counting) per the project's
// "do not invent a complicated bot system" constraint - these exist only so
// a table can start early with fewer than four humans.

const rules = require('./rules');

// Prefer a safe (non point-scoring) legal card when one exists; otherwise
// play the lowest-ranked legal card to minimize the damage of taking points.
function chooseBotCard(hand, trick, heartsBroken, isFirstTrick) {
  const legal = rules.getLegalPlays(hand, trick, heartsBroken, isFirstTrick);
  if (!legal.length) {
    return null;
  }

  const safe = legal.filter(function (card) { return rules.cardPoints(card) === 0; });
  const pool = safe.length ? safe : legal;

  return pool.reduce(function (lowest, card) {
    return rules.rankValue(card) < rules.rankValue(lowest) ? card : lowest;
  }, pool[0]);
}

// Pass the three highest-value point-risk cards (Queen of Spades and high
// Hearts first, then high spades that could be forced to take the Queen,
// then just the highest remaining ranks) to get rid of likely liabilities.
function chooseBotPassCards(hand) {
  const sorted = hand.slice().sort(function (a, b) {
    const riskA = rules.isQueenOfSpades(a) ? 100 : rules.isHeart(a) ? 50 + rules.rankValue(a) : rules.rankValue(a);
    const riskB = rules.isQueenOfSpades(b) ? 100 : rules.isHeart(b) ? 50 + rules.rankValue(b) : rules.rankValue(b);
    return riskB - riskA;
  });
  return sorted.slice(0, 3);
}

module.exports = {
  chooseBotCard: chooseBotCard,
  chooseBotPassCards: chooseBotPassCards
};
