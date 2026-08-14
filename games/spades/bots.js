// Trivial Spades bot heuristics, built on top of the pure rules engine.
// Intentionally simple (no lookahead, no partner-awareness, no attempt to
// actually hit a bid) per the project's "do not invent a complicated bot
// system" constraint - these exist only so a table can start early with
// fewer than four humans, not to play well.

const rules = require('./rules');

// Counts Aces/Kings and spade length as a rough hand-strength estimate, then
// clamps to a legal 1-13 bid. Bots never bid Nil (0) - keeps the bot simple
// and avoids needing any bot Nil-defense strategy.
function chooseBotBid(hand) {
  if (!Array.isArray(hand) || !hand.length) {
    return 1;
  }

  let strength = 0;
  hand.forEach(function (card) {
    const rank = rules.rankOf(card);
    if (rank === 'A') {
      strength += 1;
    } else if (rank === 'K') {
      strength += 0.75;
    }
    if (rules.isSpade(card) && (rank === 'A' || rank === 'K' || rank === 'Q')) {
      strength += 0.5;
    }
  });

  const spadeCount = hand.filter(rules.isSpade).length;
  strength += Math.max(0, spadeCount - 3) * 0.5;

  const bid = Math.round(strength);
  return Math.min(rules.MAX_BID, Math.max(1, bid));
}

// Prefer the lowest legal card - no attempt to track partner's position, the
// current trick's winning card, or actually hit its bid.
function chooseBotCard(hand, trick, spadesBroken) {
  const legal = rules.getLegalPlays(hand, trick, spadesBroken);
  if (!legal.length) {
    return null;
  }

  return legal.reduce(function (lowest, card) {
    return rules.rankValue(card) < rules.rankValue(lowest) ? card : lowest;
  }, legal[0]);
}

module.exports = {
  chooseBotBid: chooseBotBid,
  chooseBotCard: chooseBotCard
};
