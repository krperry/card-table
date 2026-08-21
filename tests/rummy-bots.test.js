// Pure unit tests for games/rummy/bots.js - no server spawn, no socket, no
// port needed, since these heuristics take/return plain data only (same
// reasoning as tests/rummy-rules.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const bots = require('../games/rummy/bots');

test('chooseMeldsAndLayoffs uses a spare Joker to complete an own-hand set instead of laying it off', () => {
  const hand = ['5H', '5D', '1J', '9C'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', '5D', '5H'].sort());
  assert.equal(decision.layoffs.length, 0);
});

test('chooseMeldsAndLayoffs uses a spare Joker to complete an own-hand run instead of laying it off', () => {
  const hand = ['5H', '6H', '1J', '9C'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', '5H', '6H'].sort());
  assert.equal(decision.layoffs.length, 0);
});

test('chooseMeldsAndLayoffs does not spend a Joker when the hand can already meld those cards for real', () => {
  const hand = ['5H', '5D', '5C', '1J', '9C'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['5C', '5D', '5H'].sort());
  // The Joker has no home in hand and no melds exist to lay off onto.
  assert.equal(decision.layoffs.length, 0);
});

test('chooseMeldsAndLayoffs prefers the bot\'s own seat when laying off a spare Joker', () => {
  const hand = ['1J', '9C'];
  const allMelds = [
    [{ type: 'set', cards: ['3H', '3D', '3C'] }], // seat 0 (bot's own)
    [{ type: 'set', cards: ['7H', '7D', '7C'] }]  // seat 1 (opponent)
  ];
  const decision = bots.chooseMeldsAndLayoffs(hand, allMelds, 0);
  assert.equal(decision.layoffs.length, 1);
  assert.equal(decision.layoffs[0].targetPlayerIndex, 0);
  assert.deepEqual(decision.layoffs[0].cards, ['1J']);
});

test('chooseMeldsAndLayoffs lays off a real card before spending a Joker on the same group', () => {
  const hand = ['4H', '1J'];
  const allMelds = [[{ type: 'run', cards: ['1H', '2H', '3H'] }]];
  const decision = bots.chooseMeldsAndLayoffs(hand, allMelds, 0);
  assert.equal(decision.layoffs[0].cards[0], '4H');
});
