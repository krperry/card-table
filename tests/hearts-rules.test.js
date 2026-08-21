// Pure unit tests for games/hearts/rules.js - no server spawn, no socket, no
// port needed, since the rules engine takes/returns plain data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../games/hearts/rules');

function orderedDeck() {
  return rules.createDeck();
}

test('deck contains 52 unique cards', () => {
  const deck = rules.createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  ['2C', 'TC', 'JC', 'QC', 'KC', 'AC', 'QS', 'AH', '2H'].forEach((card) => {
    assert.ok(deck.includes(card), card + ' should be in the deck');
  });
});

test('each player receives 13 cards', () => {
  const hands = rules.deal(orderedDeck());
  assert.equal(hands.length, 4);
  hands.forEach((hand) => assert.equal(hand.length, 13));
  const allCards = [].concat(...hands);
  assert.equal(new Set(allCards).size, 52);
});

test('2 of Clubs starts the first trick', () => {
  const hands = rules.deal(orderedDeck());
  const leaderIndex = rules.findTwoOfClubsHolder(hands);
  assert.ok(leaderIndex >= 0);
  assert.ok(hands[leaderIndex].includes('2C'));

  const legal = rules.getLegalPlays(hands[leaderIndex], [], false, true);
  assert.deepEqual(legal, ['2C']);
});

test('players must follow suit when able', () => {
  const hand = ['2C', '5C', 'KH', 'AS'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, true, false);
  assert.deepEqual(legal.sort(), ['2C', '5C'].sort());
  assert.ok(rules.isLegalPlay(hand, trick, true, false, '2C'));
  assert.ok(!rules.isLegalPlay(hand, trick, true, false, 'AS'));
});

test('a player can discard another suit when unable to follow suit', () => {
  const hand = ['KH', 'AS', '4D'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, true, false);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('highest card of the led suit wins the trick', () => {
  const trick = [
    { playerIndex: 0, card: '9C' },
    { playerIndex: 1, card: 'KC' },
    { playerIndex: 2, card: '2C' },
    { playerIndex: 3, card: 'AH' }
  ];
  assert.equal(rules.resolveTrick(trick), 1);
});

test('off-suit cards cannot win the trick even if higher ranked', () => {
  const trick = [
    { playerIndex: 0, card: '2C' },
    { playerIndex: 1, card: 'AH' },
    { playerIndex: 2, card: 'KS' },
    { playerIndex: 3, card: '3C' }
  ];
  assert.equal(rules.resolveTrick(trick), 3);
});

test('Hearts cannot normally be led before being broken', () => {
  const hand = ['4H', '5C', '9D'];
  const legal = rules.getLegalPlays(hand, [], false, false);
  assert.deepEqual(legal.sort(), ['5C', '9D'].sort());
  assert.ok(!rules.isLegalPlay(hand, [], false, false, '4H'));
});

test('Hearts can be led when the player has only Hearts remaining', () => {
  const hand = ['4H', '9H', 'KH'];
  const legal = rules.getLegalPlays(hand, [], false, false);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('Hearts can be led normally once broken', () => {
  const hand = ['4H', '5C', '9D'];
  const legal = rules.getLegalPlays(hand, [], true, false);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('playing a Heart off-suit breaks Hearts', () => {
  assert.equal(rules.breaksHearts('4H'), true);
  assert.equal(rules.breaksHearts('4C'), false);
  assert.equal(rules.breaksHearts('QS'), false);
});

test('first-trick restriction: cannot discard a Heart when void in the led suit unless no alternative', () => {
  const hand = ['4H', '9D', 'KS'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, false, true);
  assert.deepEqual(legal.sort(), ['9D', 'KS'].sort());
  assert.ok(!rules.isLegalPlay(hand, trick, false, true, '4H'));

  const heartsOnlyHand = ['4H', '9H'];
  const forcedLegal = rules.getLegalPlays(heartsOnlyHand, trick, false, true);
  assert.deepEqual(forcedLegal.sort(), heartsOnlyHand.slice().sort());
});

test('first-trick restriction: cannot discard the Queen of Spades unless no alternative', () => {
  const hand = ['QS', '9D', 'KD'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, false, true);
  assert.deepEqual(legal.sort(), ['9D', 'KD'].sort());
  assert.ok(!rules.isLegalPlay(hand, trick, false, true, 'QS'));

  const forcedHand = ['QS', '4H'];
  const forcedLegal = rules.getLegalPlays(forcedHand, trick, false, true);
  assert.deepEqual(forcedLegal.sort(), forcedHand.slice().sort());
});

test('the Queen of Spades scores 13 points', () => {
  assert.equal(rules.cardPoints('QS'), 13);
});

test('each Heart scores 1 point', () => {
  assert.equal(rules.cardPoints('2H'), 1);
  assert.equal(rules.cardPoints('AH'), 1);
});

test('normal hand scoring sums captured card points per player', () => {
  const captures = [
    ['2H', '3H'],      // 2 points
    ['QS'],            // 13 points
    ['4H', '5H', '6H'], // 3 points
    []                 // 0 points
  ];
  const result = rules.scoreHandCaptures(captures);
  assert.deepEqual(result.points, [2, 13, 3, 0]);
  assert.equal(result.shotTheMoon, null);
});

test('shooting the moon: the shooter scores 0 and everyone else scores 26', () => {
  const allHearts = rules.SUITS.includes('H') ? Array.from({ length: 13 }, (_, i) => rules.RANKS[i] + 'H') : [];
  const captures = [
    allHearts.concat(['QS']),
    [],
    [],
    []
  ];
  const result = rules.scoreHandCaptures(captures);
  assert.deepEqual(result.points, [0, 26, 26, 26]);
  assert.equal(result.shotTheMoon, 0);
});

test('passing direction sequence: left, right, across, hold, then repeats', () => {
  assert.equal(rules.getPassDirection(1), 'left');
  assert.equal(rules.getPassDirection(2), 'right');
  assert.equal(rules.getPassDirection(3), 'across');
  assert.equal(rules.getPassDirection(4), 'hold');
  assert.equal(rules.getPassDirection(5), 'left');
  assert.equal(rules.getPassDirection(6), 'right');
  assert.equal(rules.getPassDirection(7), 'across');
  assert.equal(rules.getPassDirection(8), 'hold');
});

test('left passing moves each selection to the next seat', () => {
  const hands = rules.deal(orderedDeck());
  const selections = hands.map((hand) => hand.slice(0, 3));
  const passed = rules.applyPass(hands, selections, 'left');
  selections[0].forEach((card) => assert.ok(passed[1].includes(card)));
  selections[1].forEach((card) => assert.ok(passed[2].includes(card)));
  selections[2].forEach((card) => assert.ok(passed[3].includes(card)));
  selections[3].forEach((card) => assert.ok(passed[0].includes(card)));
  passed.forEach((hand) => assert.equal(hand.length, 13));
});

test('right passing moves each selection to the previous seat', () => {
  const hands = rules.deal(orderedDeck());
  const selections = hands.map((hand) => hand.slice(0, 3));
  const passed = rules.applyPass(hands, selections, 'right');
  selections[0].forEach((card) => assert.ok(passed[3].includes(card)));
  selections[1].forEach((card) => assert.ok(passed[0].includes(card)));
  selections[2].forEach((card) => assert.ok(passed[1].includes(card)));
  selections[3].forEach((card) => assert.ok(passed[2].includes(card)));
});

test('across passing moves each selection to the opposite seat', () => {
  const hands = rules.deal(orderedDeck());
  const selections = hands.map((hand) => hand.slice(0, 3));
  const passed = rules.applyPass(hands, selections, 'across');
  selections[0].forEach((card) => assert.ok(passed[2].includes(card)));
  selections[1].forEach((card) => assert.ok(passed[3].includes(card)));
  selections[2].forEach((card) => assert.ok(passed[0].includes(card)));
  selections[3].forEach((card) => assert.ok(passed[1].includes(card)));
});

test('a Hold hand does not pass any cards', () => {
  const hands = rules.deal(orderedDeck());
  const passed = rules.applyPass(hands, null, 'hold');
  hands.forEach((hand, index) => {
    assert.deepEqual(passed[index].slice().sort(), hand.slice().sort());
  });
});

test('exactly three cards must be passed', () => {
  const hands = rules.deal(orderedDeck());
  const badSelections = hands.map((hand) => hand.slice(0, 2));
  assert.throws(() => rules.applyPass(hands, badSelections, 'left'));

  const tooMany = hands.map((hand) => hand.slice(0, 4));
  assert.throws(() => rules.applyPass(hands, tooMany, 'left'));
});

test('game ends after someone reaches or exceeds 100 at the end of a hand', () => {
  assert.equal(rules.isGameOver([40, 60, 99, 20], 100), false);
  assert.equal(rules.isGameOver([40, 60, 100, 20], 100), true);
  assert.equal(rules.isGameOver([40, 60, 130, 20], 100), true);
});

test('the player with the lowest final score wins', () => {
  assert.equal(rules.getWinnerIndex([81, 72, 96, 104]), 1);
  assert.equal(rules.getWinnerIndex([72, 81, 96, 104]), 0);
});

// --- Hand sorting: Ace high, above King ---------------------------------
// Hearts is the one game of the three where Ace is HIGH, not low - these
// tests exist specifically to guard against that rule getting flipped while
// fixing the shared Ace-low sort logic for Rummy/Cribbage (see
// games/rummy/rules.js and games/cribbage/rules.js). deal()/applyPass() both
// route every hand through this same sortHand(), so locking it in here
// covers "visual/keyboard/screen-reader order must match" for every place a
// Hearts hand is sorted - there is no separate client-side re-sort the way
// Rummy/Cribbage offer (hearts-client.js just renders appState.heartsHand in
// the order the server already sorted it).

test('rankValue orders 2 < 3 < ... < Q < K < A (Ace high)', () => {
  const ranksInOrder = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  for (let i = 1; i < ranksInOrder.length; i++) {
    assert.ok(
      rules.rankValue(ranksInOrder[i - 1] + 'C') < rules.rankValue(ranksInOrder[i] + 'C'),
      ranksInOrder[i - 1] + ' should sort below ' + ranksInOrder[i]
    );
  }
});

test('sortHand groups by suit and sorts Ace above King within each suit', () => {
  const sorted = rules.sortHand(['AH', 'KC', '2H', 'QC', 'AC']);
  assert.deepEqual(sorted, ['QC', 'KC', 'AC', '2H', 'AH']);
});
