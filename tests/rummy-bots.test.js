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

// --- Joker strategy: scoring picks the best play, not the first legal one --

test('chooseMeldsAndLayoffs: a Joker placement that unlocks two more cards beats one that unlocks none', () => {
  const hand = ['1J', '8H', '9H', 'KC'];
  const allMelds = [
    [{ type: 'run', cards: ['4H', '5H', '6H'] }],  // seat 0: Joker(=7H) also lets 8H and 9H land
    [{ type: 'set', cards: ['2C', '2D', '2S'] }]   // seat 1: Joker fills the missing suit, nothing else benefits
  ];
  const decision = bots.chooseMeldsAndLayoffs(hand, allMelds, 2);
  assert.equal(decision.layoffs.length, 1);
  assert.equal(decision.layoffs[0].targetPlayerIndex, 0);
  assert.deepEqual(decision.layoffs[0].cards.slice().sort(), ['1J', '8H', '9H'].sort());
});

test('chooseMeldsAndLayoffs: evaluates every legal Joker position instead of stopping at the first one found in board order', () => {
  const hand = ['1J', '8H', '9H', 'KC'];
  const allMelds = [
    [{ type: 'set', cards: ['2C', '2D', '2S'] }],  // seat 0, checked first: only the Joker fits, nothing else unlocks
    [{ type: 'run', cards: ['4H', '5H', '6H'] }]   // seat 1: Joker(=7H) also lets 8H and 9H land - the better play
  ];
  const decision = bots.chooseMeldsAndLayoffs(hand, allMelds, 2);
  assert.equal(decision.layoffs.length, 1);
  assert.equal(decision.layoffs[0].targetPlayerIndex, 1);
  assert.deepEqual(decision.layoffs[0].cards.slice().sort(), ['1J', '8H', '9H'].sort());
});

test('chooseMeldsAndLayoffs: prefers a Joker play on a hard-to-complete combination over an equally-valuable easy one', () => {
  // Both real-card pairs are worth the same (9+9 = 8+10 = 18 deadwood), so
  // if the bot just chased raw card value it would be a coin flip. The 9s
  // have 2 natural outs (either missing suit completes the set - easy); the
  // 8S/TS run has only 1 (exactly 9S fills the gap - hard). The Joker
  // should go to the harder combination.
  const hand = ['9C', '9D', '8S', 'TS', '1J'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', '8S', 'TS'].sort());
});

test('chooseMeldsAndLayoffs: uses the Joker when it lets the bot go out', () => {
  const hand = ['7C', '7D', '1J'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', '7C', '7D'].sort());
});

test('chooseMeldsAndLayoffs: prefers melding high-value deadwood (Kings) with the Joker over low-value deadwood (2s)', () => {
  const hand = ['KH', 'KD', '2S', '2H', '1J'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', 'KD', 'KH'].sort());
});

test('chooseMeldsAndLayoffs: uses both Jokers together on a chain when a single Joker cannot bridge the gap', () => {
  const hand = ['1J', '2J', '8H', '9H'];
  const allMelds = [[{ type: 'run', cards: ['3H', '4H', '5H'] }]];
  const decision = bots.chooseMeldsAndLayoffs(hand, allMelds, 1);
  assert.equal(decision.layoffs.length, 1);
  assert.deepEqual(decision.layoffs[0].cards.slice().sort(), ['1J', '2J', '8H', '9H'].sort());
  assert.equal(decision.melds.length, 0);
});
