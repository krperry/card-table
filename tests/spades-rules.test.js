// Pure unit tests for games/spades/rules.js - no server spawn, no socket, no
// port needed, since the rules engine takes/returns plain data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../games/spades/rules');

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

test('each player receives 13 cards', () => {
  const hands = rules.deal(orderedDeck());
  assert.equal(hands.length, 4);
  hands.forEach((hand) => assert.equal(hand.length, 13));
  const allCards = [].concat(...hands);
  assert.equal(new Set(allCards).size, 52);
});

test('players must follow suit when able', () => {
  const hand = ['2C', '5C', 'KH', 'AS'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, true);
  assert.deepEqual(legal.sort(), ['2C', '5C'].sort());
  assert.ok(rules.isLegalPlay(hand, trick, true, '2C'));
  assert.ok(!rules.isLegalPlay(hand, trick, true, 'AS'));
});

test('a player can discard another suit (including a spade) when unable to follow suit', () => {
  const hand = ['KH', 'AS', '4D'];
  const trick = [{ playerIndex: 0, card: '9C' }];
  const legal = rules.getLegalPlays(hand, trick, false);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('spades cannot normally be led before being broken', () => {
  const hand = ['4S', '5C', '9D'];
  const legal = rules.getLegalPlays(hand, [], false);
  assert.deepEqual(legal.sort(), ['5C', '9D'].sort());
  assert.ok(!rules.isLegalPlay(hand, [], false, '4S'));
});

test('spades can be led when the player has only spades remaining, even unbroken', () => {
  const hand = ['4S', '9S', 'KS'];
  const legal = rules.getLegalPlays(hand, [], false);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('spades can be led normally once broken', () => {
  const hand = ['4S', '5C', '9D'];
  const legal = rules.getLegalPlays(hand, [], true);
  assert.deepEqual(legal.sort(), hand.slice().sort());
});

test('playing a spade off-suit breaks spades', () => {
  assert.equal(rules.breaksSpades('4S'), true);
  assert.equal(rules.breaksSpades('4C'), false);
  assert.equal(rules.breaksSpades('QS'), true);
});

test('highest card of the led suit wins when no spades were played', () => {
  const trick = [
    { playerIndex: 0, card: '9C' },
    { playerIndex: 1, card: 'KC' },
    { playerIndex: 2, card: '2C' },
    { playerIndex: 3, card: 'AH' }
  ];
  assert.equal(rules.resolveTrick(trick), 1);
});

test('off-suit, non-trump cards never win the trick even if higher ranked', () => {
  const trick = [
    { playerIndex: 0, card: '2C' },
    { playerIndex: 1, card: 'AH' },
    { playerIndex: 2, card: 'KD' },
    { playerIndex: 3, card: '3C' }
  ];
  assert.equal(rules.resolveTrick(trick), 3);
});

test('the highest spade wins the trick whenever any spade was played, regardless of what was led', () => {
  const trick = [
    { playerIndex: 0, card: 'AC' },
    { playerIndex: 1, card: '2S' },
    { playerIndex: 2, card: 'KC' },
    { playerIndex: 3, card: '9S' }
  ];
  assert.equal(rules.resolveTrick(trick), 3);
});

test('a spade lead (from an all-spades hand) still resolves by highest spade', () => {
  const trick = [
    { playerIndex: 0, card: '5S' },
    { playerIndex: 1, card: 'KS' },
    { playerIndex: 2, card: '2S' },
    { playerIndex: 3, card: '9S' }
  ];
  assert.equal(rules.resolveTrick(trick), 1);
});

test('bid domain is 0 (Nil) through 13', () => {
  const legalBids = rules.getLegalBids();
  assert.deepEqual(legalBids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.ok(rules.isLegalBid(0));
  assert.ok(rules.isNilBid(0));
  assert.ok(rules.isLegalBid(13));
  assert.ok(!rules.isLegalBid(14));
  assert.ok(!rules.isLegalBid(-1));
  assert.ok(!rules.isLegalBid(3.5));
});

test('teammate/team helpers reflect the fixed 0&2 vs 1&3 partnership', () => {
  assert.equal(rules.getTeammateIndex(0), 2);
  assert.equal(rules.getTeammateIndex(1), 3);
  assert.equal(rules.getTeammateIndex(2), 0);
  assert.equal(rules.getTeammateIndex(3), 1);
  assert.deepEqual(rules.DEFAULT_TEAMS, [[0, 2], [1, 3]]);
});

test('scoreHand: a made contract scores 10 per bid plus 1 per overtrick (bag)', () => {
  const result = rules.scoreHand({
    bids: [4, 0, 3, 0],
    tricksWon: [5, 1, 4, 3],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [0, 0]
  });
  // Team 0 (seats 0 & 2): bid 4 + 3 = 7, tricks 5 + 4 = 9 -> made, 2 overtricks.
  assert.equal(result.contractMade[0], true);
  assert.equal(result.teamPoints[0], 70 + 2);
  assert.equal(result.bags[0], 2);
});

test('scoreHand: a failed contract scores -10 per bid with zero bags added', () => {
  const result = rules.scoreHand({
    bids: [8, 0, 2, 0],
    tricksWon: [3, 2, 4, 4],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [1, 0]
  });
  // Team 0 (seats 0 & 2): bid 8 + 2 = 10, tricks 3 + 4 = 7 < 10 -> failed.
  assert.equal(result.contractMade[0], false);
  assert.equal(result.teamPoints[0], -100);
  assert.equal(result.bags[0], 1, 'bags carry forward unchanged on a failed contract');
});

test('scoreHand: Nil success adds +100 on top of the partner\'s own contract result', () => {
  const result = rules.scoreHand({
    bids: [0, 5, 4, 3],
    tricksWon: [0, 5, 6, 3],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [0, 0]
  });
  // Team 0 (seats 0 & 2): bid 0(nil) + 4 = 4, tricks 0 + 6 = 6 -> made, 2 overtricks: 40+2=42, plus seat 0's nil success +100 = 142.
  assert.equal(result.teamPoints[0], 40 + 2 + 100);
});

test('scoreHand: Nil failure applies a -100 penalty', () => {
  const result = rules.scoreHand({
    bids: [3, 0, 2, 5],
    tricksWon: [3, 1, 4, 5],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [0, 0]
  });
  // Seat 1 bid Nil but took 1 trick -> -100 penalty for team 1 (seats 1 & 3).
  // Team 1: bid 0 + 5 = 5, tricks 1 + 5 = 6 -> made, 1 overtrick: +50+1=51, nil failure -100 => -49.
  assert.equal(result.teamPoints[1], 50 + 1 - 100);
});

test('scoreHand: bag penalty triggers once a team\'s running bag count reaches 10, resetting the counter by 10', () => {
  const result = rules.scoreHand({
    bids: [2, 0, 2, 0],
    tricksWon: [5, 0, 5, 0],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [8, 0]
  });
  // Team 0: bid 2 + 2 = 4, tricks 5 + 5 = 10 -> made, 6 overtricks. bagsCarry 8 + 6 = 14 -> penalty once, bags settle at 4.
  assert.equal(result.contractMade[0], true);
  assert.equal(result.bags[0], 4);
  assert.equal(result.bagPenaltyApplied[0], true);
  // teamPoints = 40 (contract) + 6 (bags) - 100 (penalty) = -54.
  assert.equal(result.teamPoints[0], 40 + 6 - 100);
});

test('scoreHand: no bag penalty when the running count stays below 10', () => {
  const result = rules.scoreHand({
    bids: [2, 0, 2, 0],
    tricksWon: [3, 0, 3, 0],
    teams: rules.DEFAULT_TEAMS,
    bagsCarry: [3, 0]
  });
  assert.equal(result.bagPenaltyApplied[0], false);
  assert.equal(result.bags[0], 5);
});

test('isGameOver: a team reaching or exceeding the target score ends the game', () => {
  assert.equal(rules.isGameOver([300, 480], 500), false);
  assert.equal(rules.isGameOver([300, 500], 500), true);
  assert.equal(rules.isGameOver([510, 300], 500), true);
});

test('getWinnerTeamIndex: the higher score wins (unlike Hearts, higher is better here)', () => {
  assert.equal(rules.getWinnerTeamIndex([420, 510]), 1);
  assert.equal(rules.getWinnerTeamIndex([510, 420]), 0);
});
