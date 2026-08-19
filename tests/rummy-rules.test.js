// Pure unit tests for games/rummy/rules.js - no server spawn, no socket, no
// port needed, since the rules engine takes/returns plain data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../games/rummy/rules');

function orderedDeck() {
  return rules.createDeck();
}

test('deck contains 52 unique cards', () => {
  const deck = rules.createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  ['2C', 'TC', 'JC', 'QC', 'KC', 'AC', 'QS', 'AS', '2S'].forEach((card) => {
    assert.ok(deck.includes(card), card + ' should be in the deck');
  });
});

test('dealSizeForPlayerCount is 10 for two players and 7 for three through six', () => {
  assert.equal(rules.dealSizeForPlayerCount(2), 10);
  [3, 4, 5, 6].forEach((count) => {
    assert.equal(rules.dealSizeForPlayerCount(count), 7);
  });
});

test('deal() gives each of 2 players 10 cards plus a starter discard', () => {
  const result = rules.deal(orderedDeck(), 2);
  assert.equal(result.hands.length, 2);
  result.hands.forEach((hand) => assert.equal(hand.length, 10));
  assert.equal(result.discard.length, 1);
  assert.equal(result.stock.length, 52 - 20 - 1);

  const allCards = [].concat(...result.hands, result.stock, result.discard);
  assert.equal(new Set(allCards).size, 52);
});

test('deal() gives each of 4 players 7 cards plus a starter discard', () => {
  const result = rules.deal(orderedDeck(), 4);
  assert.equal(result.hands.length, 4);
  result.hands.forEach((hand) => assert.equal(hand.length, 7));
  assert.equal(result.discard.length, 1);
  assert.equal(result.stock.length, 52 - 28 - 1);

  const allCards = [].concat(...result.hands, result.stock, result.discard);
  assert.equal(new Set(allCards).size, 52);
});

test('deal() gives each of 6 players 7 cards plus a starter discard', () => {
  const result = rules.deal(orderedDeck(), 6);
  result.hands.forEach((hand) => assert.equal(hand.length, 7));
  assert.equal(result.stock.length, 52 - 42 - 1);
});

test('deal() rejects a player count outside 2-6', () => {
  assert.throws(() => rules.deal(orderedDeck(), 1));
  assert.throws(() => rules.deal(orderedDeck(), 7));
});

test('deal() rejects a deck that is not a shuffled 52-card array', () => {
  assert.throws(() => rules.deal(['2C', '3C'], 4));
});

test('cardValue: ace is 1, face cards are 10, others are pip value', () => {
  assert.equal(rules.cardValue('AC'), 1);
  assert.equal(rules.cardValue('JC'), 10);
  assert.equal(rules.cardValue('QC'), 10);
  assert.equal(rules.cardValue('KC'), 10);
  assert.equal(rules.cardValue('TC'), 10);
  assert.equal(rules.cardValue('5C'), 5);
  assert.equal(rules.cardValue('2C'), 2);
});

test('isValidSet accepts 3 or 4 same-rank cards of distinct suits', () => {
  assert.ok(rules.isValidSet(['7C', '7D', '7H']));
  assert.ok(rules.isValidSet(['7C', '7D', '7H', '7S']));
});

test('isValidSet rejects wrong count, mismatched rank, or a repeated suit', () => {
  assert.ok(!rules.isValidSet(['7C', '7D']));
  assert.ok(!rules.isValidSet(['7C', '7D', '7H', '7S', '6C']));
  assert.ok(!rules.isValidSet(['7C', '8D', '7H']));
  assert.ok(!rules.isValidSet(['7C', '7C', '7H']));
});

test('isValidRun accepts 3+ consecutive same-suit cards', () => {
  assert.ok(rules.isValidRun(['4H', '5H', '6H']));
  assert.ok(rules.isValidRun(['4H', '6H', '5H']));
  assert.ok(rules.isValidRun(['TH', 'JH', 'QH', 'KH']));
});

test('isValidRun accepts an ace-low run at the bottom of the suit', () => {
  assert.ok(rules.isValidRun(['AC', '2C', '3C']));
});

test('isValidRun rejects a run that wraps from King to Ace', () => {
  assert.ok(!rules.isValidRun(['QC', 'KC', 'AC']));
});

test('isValidRun rejects mismatched suits, non-consecutive ranks, or too few cards', () => {
  assert.ok(!rules.isValidRun(['4H', '5H']));
  assert.ok(!rules.isValidRun(['4H', '5D', '6H']));
  assert.ok(!rules.isValidRun(['4H', '6H', '8H']));
});

test('classifyMeld reports set vs run vs invalid', () => {
  assert.deepEqual(rules.classifyMeld(['7C', '7D', '7H']), { valid: true, type: 'set' });
  assert.deepEqual(rules.classifyMeld(['4H', '5H', '6H']), { valid: true, type: 'run' });
  assert.deepEqual(rules.classifyMeld(['4H', '5D', '6H']), { valid: false });
});

test('canExtendMeld: a set accepts a matching rank in an unused suit, up to 4 cards', () => {
  const set = { type: 'set', cards: ['7C', '7D', '7H'] };
  assert.ok(rules.canExtendMeld(set, '7S'));
  assert.ok(!rules.canExtendMeld(set, '7C'));
  assert.ok(!rules.canExtendMeld(set, '8C'));

  const fullSet = { type: 'set', cards: ['7C', '7D', '7H', '7S'] };
  assert.ok(!rules.canExtendMeld(fullSet, '7C'));
});

test('canExtendMeld: a run accepts a same-suit card at either end, not the middle or off-suit', () => {
  const run = { type: 'run', cards: ['5H', '6H', '7H'] };
  assert.ok(rules.canExtendMeld(run, '4H'));
  assert.ok(rules.canExtendMeld(run, '8H'));
  assert.ok(!rules.canExtendMeld(run, '6H'));
  assert.ok(!rules.canExtendMeld(run, '8D'));
});

test('canExtendMeld: a run at the ace-low boundary cannot extend below the ace', () => {
  const run = { type: 'run', cards: ['AC', '2C', '3C'] };
  assert.ok(!rules.canExtendMeld(run, 'KC'));
  assert.ok(rules.canExtendMeld(run, '4C'));
});

test('isStockExhausted reports true only for an empty stock', () => {
  assert.ok(rules.isStockExhausted([]));
  assert.ok(!rules.isStockExhausted(['2C']));
});

test('reshuffleDiscardIntoStock keeps the top discard card and returns the rest as the new stock, unshuffled', () => {
  const discardPile = ['2C', '3D', '4H', '5S'];
  const result = rules.reshuffleDiscardIntoStock(discardPile);
  assert.deepEqual(result.discard, ['5S']);
  assert.deepEqual(result.stock, ['2C', '3D', '4H']);
});

test('reshuffleDiscardIntoStock on a single-card discard pile yields an empty new stock (the double-exhaustion edge case)', () => {
  const result = rules.reshuffleDiscardIntoStock(['5S']);
  assert.deepEqual(result.stock, []);
  assert.deepEqual(result.discard, ['5S']);
});

test('scoreHand awards the winner the sum of every other player’s deadwood, and 0 to everyone else', () => {
  const hands = [
    [], // went out
    ['KC', 'QD'], // 20 deadwood
    ['5H', '5S', '2C'] // 12 deadwood
  ];
  const result = rules.scoreHand(hands, 0);
  assert.deepEqual(result.deadwoodByPlayer, [0, 20, 12]);
  assert.deepEqual(result.pointsAwarded, [32, 0, 0]);
});

test('isGameOver / getWinnerIndex use highest-score-wins, first to target', () => {
  assert.ok(!rules.isGameOver([50, 80], 100));
  assert.ok(rules.isGameOver([50, 120], 100));
  assert.equal(rules.getWinnerIndex([50, 120, 90]), 1);
});
