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

// --- Ace High or Low: bot recognizes Q-K-A as a meldable run ---------------

test('chooseMeldsAndLayoffs: recognizes Q-K-A as a natural run only when the table\'s aceHighOrLow option is on', () => {
  const hand = ['QC', 'KC', 'AC', '9H'];
  const context = { rulesOptions: { aceHighOrLow: true } };
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0, context);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['AC', 'KC', 'QC'].sort());
});

test('chooseMeldsAndLayoffs: does not meld Q-K-A when aceHighOrLow is off (no context, matching pre-existing behavior)', () => {
  const hand = ['QC', 'KC', 'AC', '9H'];
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0);
  assert.equal(decision.melds.length, 0);
});

test('chooseMeldsAndLayoffs: with aceHighOrLow on, a Joker completes a Q-K-Ace run by filling the gap left by a missing Queen', () => {
  const hand = ['AC', 'KC', '1J', '9H'];
  const context = { rulesOptions: { aceHighOrLow: true } };
  const decision = bots.chooseMeldsAndLayoffs(hand, [], 0, context);
  assert.equal(decision.melds.length, 1);
  assert.deepEqual(decision.melds[0].slice().sort(), ['1J', 'AC', 'KC'].sort());
});

test('chooseDiscard: with aceHighOrLow on, an Ace sitting near a King/Queen is protected as a near-run card (not the highest-deadwood discard)', () => {
  const hand = ['AC', 'KC', 'QC', '2H', '3H', '9S'];
  const options = { aceHighOrLow: true };
  // KC/QC/AC form a near-run under the ace-high scale, and 2H/3H under the
  // ace-low scale - the only truly "safe" (unprotected) card is 9S.
  assert.equal(bots.chooseDiscard(hand, options), '9S');
});

// --- Entire discard pile: the bot's draw-phase choice -----------------------

test('chooseDrawAction: falls back to the ordinary stock-vs-discard choice when allowDrawEntirePile is not in context', () => {
  const hand = ['5H', '9C'];
  assert.equal(bots.chooseDrawAction(hand, '9S', ['2C', '3C', '4C', '5C'], []), 'stock');
});

test('chooseDrawAction: recognizes taking the entire pile as a possible draw when it would immediately build a meld', () => {
  // Hand already holds 5C/5D; the pile's 5H and 5S would complete a full
  // four-card set the instant they're taken, and the pile is small (2
  // cards) - a clearly good trade.
  const hand = ['5C', '5D', '9H'];
  const discardPile = ['5H', '5S'];
  const context = { allowDrawEntirePile: true, rulesOptions: {} };
  assert.equal(bots.chooseDrawAction(hand, discardPile[discardPile.length - 1], discardPile, [], context), 'pile');
});

test('chooseDrawAction: does not take a large pile of unrelated high-deadwood cards just because the option is enabled', () => {
  const hand = ['2C', '3D', '4H'];
  // A large pile with nothing that helps this hand and no Jokers - taking it
  // would only add a pile of expensive deadwood.
  const discardPile = ['KH', 'QD', 'JS', 'TC', '9D', '8H', '7S', 'KD', 'QH', 'JC'];
  const context = { allowDrawEntirePile: true, rulesOptions: {} };
  const action = bots.chooseDrawAction(hand, discardPile[discardPile.length - 1], discardPile, [], context);
  assert.notEqual(action, 'pile');
});

test('chooseDrawAction: a pile containing a Joker is weighed favorably even when small', () => {
  const hand = ['7H', '7D', '9C'];
  const discardPile = ['1J', '7S'];
  const context = { allowDrawEntirePile: true, rulesOptions: {} };
  assert.equal(bots.chooseDrawAction(hand, discardPile[discardPile.length - 1], discardPile, [], context), 'pile');
});
