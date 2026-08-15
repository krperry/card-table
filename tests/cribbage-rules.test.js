// Pure unit tests for games/cribbage/rules.js - no server spawn, no socket,
// no port needed, since the rules engine takes/returns plain data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../games/cribbage/rules');

test('deck contains 52 unique cards', () => {
  const deck = rules.createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  ['2C', 'TC', 'JC', 'QC', 'KC', 'AC', 'QS', 'AH', '2H'].forEach((card) => {
    assert.ok(deck.includes(card), card + ' should be in the deck');
  });
});

test('dealHands deals 6 cards to each of 2 players and a 40-card stub', () => {
  const dealt = rules.dealHands(rules.createDeck());
  assert.equal(dealt.hands.length, 2);
  dealt.hands.forEach((hand) => assert.equal(hand.length, 6));
  assert.equal(dealt.stub.length, 40);
  const allCards = [].concat(dealt.hands[0], dealt.hands[1], dealt.stub);
  assert.equal(new Set(allCards).size, 52);
});

test('dealHands rejects anything other than a shuffled 52-card deck', () => {
  assert.throws(() => rules.dealHands(['2C', '3C']));
});

test('isValidDiscard requires exactly two distinct cards from the hand', () => {
  const hand = ['2C', '3C', '4C', '5C', '6C', '7C'];
  assert.ok(rules.isValidDiscard(hand, ['2C', '3C']));
  assert.ok(!rules.isValidDiscard(hand, ['2C', '2C']));
  assert.ok(!rules.isValidDiscard(hand, ['2C', '9D']));
  assert.ok(!rules.isValidDiscard(hand, ['2C']));
});

test('applyDiscard removes the discarded cards from the hand and returns them', () => {
  const hand = ['2C', '3C', '4C', '5C', '6C', '7C'];
  const result = rules.applyDiscard(hand, ['2C', '3C']);
  assert.deepEqual(result.remainingHand.sort(), ['4C', '5C', '6C', '7C'].sort());
  assert.deepEqual(result.discarded.sort(), ['2C', '3C'].sort());
});

test('applyDiscard throws on an invalid discard', () => {
  assert.throws(() => rules.applyDiscard(['2C', '3C'], ['2C', '9D']));
});

test('revealStarter takes the first card of the stub as a fair cut', () => {
  const stub = ['5C', '6D', '7H'];
  const revealed = rules.revealStarter(stub);
  assert.equal(revealed.starter, '5C');
  assert.deepEqual(revealed.remainingStub, ['6D', '7H']);
});

test('isHisHeels is true only for a Jack starter', () => {
  assert.equal(rules.isHisHeels('JS'), true);
  assert.equal(rules.isHisHeels('JC'), true);
  assert.equal(rules.isHisHeels('TS'), false);
  assert.equal(rules.isHisHeels('QS'), false);
});

test('getLegalPeggingPlays excludes any card that would push the count past 31', () => {
  const hand = ['TC', '9D', 'AC'];
  assert.deepEqual(rules.getLegalPeggingPlays(hand, 25), ['AC']);
  assert.deepEqual(rules.getLegalPeggingPlays(hand, 20).sort(), ['9D', 'AC', 'TC'].sort());
  assert.deepEqual(rules.getLegalPeggingPlays([], 0), []);
});

test('getLegalPeggingPlays returns nothing when every card would exceed 31 - a forced Go', () => {
  assert.deepEqual(rules.getLegalPeggingPlays(['TC', 'JD'], 25), []);
});

test('isLegalPeggingPlay matches getLegalPeggingPlays', () => {
  assert.ok(rules.isLegalPeggingPlay(['AC', 'TC'], 25, 'AC'));
  assert.ok(!rules.isLegalPeggingPlay(['AC', 'TC'], 25, 'TC'));
});

test('scoreTrailingPlay: exact fifteen scores 2', () => {
  const result = rules.scoreTrailingPlay(['9C', '6D']);
  assert.equal(result.count, 15);
  assert.equal(result.fifteenPoints, 2);
  assert.equal(result.total, 2);
});

test('scoreTrailingPlay: exact thirty-one scores 2', () => {
  const result = rules.scoreTrailingPlay(['TC', 'TD', 'TH', 'AS']);
  assert.equal(result.count, 31);
  assert.equal(result.thirtyOnePoints, 2);
  assert.equal(result.total, 2);
});

test('scoreTrailingPlay: a pair/triple/quad played consecutively scores 2/6/12', () => {
  assert.equal(rules.scoreTrailingPlay(['5C', '5D']).pairPoints, 2);
  const triple = rules.scoreTrailingPlay(['5C', '5D', '5H']);
  assert.equal(triple.pairSize, 3);
  assert.equal(triple.pairPoints, 6);
  const quad = rules.scoreTrailingPlay(['5C', '5D', '5H', '5S']);
  assert.equal(quad.pairSize, 4);
  assert.equal(quad.pairPoints, 12);
});

test('scoreTrailingPlay: a pair broken by an intervening card does not score', () => {
  const result = rules.scoreTrailingPlay(['5C', '5D', '2H', '5S']);
  assert.equal(result.pairPoints, 0);
  assert.equal(result.pairSize, 0);
});

test('scoreTrailingPlay: a run scores regardless of play order', () => {
  const result = rules.scoreTrailingPlay(['5C', '3D', '4H']);
  assert.equal(result.runLength, 3);
  assert.equal(result.runPoints, 3);
});

test('scoreTrailingPlay: the longest run is preferred over a nested shorter run', () => {
  const result = rules.scoreTrailingPlay(['2C', '3D', '4H', '5S']);
  assert.equal(result.runLength, 4);
  assert.equal(result.runPoints, 4);
});

test('scoreTrailingPlay: a duplicate rank disqualifies a pegging run', () => {
  const result = rules.scoreTrailingPlay(['3C', '3D', '4H']);
  assert.equal(result.runLength, 0);
  assert.equal(result.runPoints, 0);
  assert.equal(result.pairPoints, 0, 'the last card (4H) has no matching rank immediately before it, so no pair either');
});

test('scoreFiveCards: double run of 3 = 8', () => {
  const result = rules.scoreFiveCards(['2C', '3C', '5C', '2D'], 'AC', false);
  assert.equal(result.total, 8);
  assert.equal(result.runs.length, 3);
  assert.equal(result.runs.waysCount, 2);
  assert.equal(result.pairs.points, 2);
});

test('scoreFiveCards: triple run = 15', () => {
  const result = rules.scoreFiveCards(['2C', '3C', '4C', '2D'], '2H', false);
  assert.equal(result.total, 15);
  assert.equal(result.runs.waysCount, 3);
  assert.equal(result.pairs.points, 6);
});

test('scoreFiveCards: double-double run = 16', () => {
  const result = rules.scoreFiveCards(['2C', '3C', '4C', '2D'], '3D', false);
  assert.equal(result.total, 16);
  assert.equal(result.runs.waysCount, 4);
  assert.equal(result.pairs.points, 4);
});

test('scoreFiveCards: the canonical maximum hand (5-5-5-J + starter 5) scores 29', () => {
  const result = rules.scoreFiveCards(['5C', '5D', '5H', 'JS'], '5S', false);
  assert.equal(result.total, 29);
  assert.equal(result.fifteens.points, 16);
  assert.equal(result.pairs.points, 12);
  assert.equal(result.nobs.points, 1);
});

test('scoreFiveCards: a hand flush scores 4, or 5 if the starter also matches', () => {
  const fourMatch = rules.scoreFiveCards(['2C', '5C', '9C', 'KC'], '3D', false);
  assert.equal(fourMatch.flush.points, 4);
  assert.equal(fourMatch.flush.matchesStarter, false);

  const fiveMatch = rules.scoreFiveCards(['2C', '5C', '9C', 'KC'], '3C', false);
  assert.equal(fiveMatch.flush.points, 5);
  assert.equal(fiveMatch.flush.matchesStarter, true);
});

test('scoreFiveCards: a crib flush requires all five cards to match - a matching 4-card crib with a non-matching starter scores 0', () => {
  const partial = rules.scoreFiveCards(['2C', '5C', '9C', 'KC'], '3D', true);
  assert.equal(partial.flush.points, 0, 'unlike a hand, a crib gets no partial-flush credit');

  const full = rules.scoreFiveCards(['2C', '5C', '9C', 'KC'], '3C', true);
  assert.equal(full.flush.points, 5);
});

test('scoreFiveCards: nobs scores 1 for a Jack in hand matching the starter suit', () => {
  const withNobs = rules.scoreFiveCards(['JC', '4D', '6H', '9S'], '2C', false);
  assert.equal(withNobs.nobs.points, 1);

  const withoutNobs = rules.scoreFiveCards(['JC', '4D', '6H', '9S'], '2D', false);
  assert.equal(withoutNobs.nobs.points, 0);
});

test('nextDealerIndex alternates between the two seats', () => {
  assert.equal(rules.nextDealerIndex(0), 1);
  assert.equal(rules.nextDealerIndex(1), 0);
});

test('isGameOver/getWinnerIndex: the highest score wins once either score reaches the target - checked at both 121 and 61', () => {
  assert.equal(rules.isGameOver([120, 90], 121), false);
  assert.equal(rules.isGameOver([121, 90], 121), true);
  assert.equal(rules.getWinnerIndex([121, 90]), 0);

  assert.equal(rules.isGameOver([60, 10], 61), false);
  assert.equal(rules.isGameOver([61, 10], 61), true);
  assert.equal(rules.getWinnerIndex([10, 61]), 1);
});

test('computeMugginsShortfall is the positive gap between the correct total and what was claimed', () => {
  assert.equal(rules.computeMugginsShortfall(2, 8), 6);
  assert.equal(rules.computeMugginsShortfall(8, 8), 0);
  assert.equal(rules.computeMugginsShortfall(10, 8), 0, 'never negative, even if the claim overshoots');
});
