// Pure unit tests for games/rummy/rules.js - no server spawn, no socket, no
// port needed, since the rules engine takes/returns plain data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../games/rummy/rules');

function orderedDeck() {
  return rules.createDeck();
}

test('deck contains 52 standard cards plus 2 Jokers', () => {
  const deck = rules.createDeck();
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck).size, 54);
  ['2C', 'TC', 'JC', 'QC', 'KC', 'AC', 'QS', 'AS', '2S', '1J', '2J'].forEach((card) => {
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
  assert.equal(result.stock.length, 54 - 20 - 1);

  const allCards = [].concat(...result.hands, result.stock, result.discard);
  assert.equal(new Set(allCards).size, 54);
});

test('deal() gives each of 4 players 7 cards plus a starter discard', () => {
  const result = rules.deal(orderedDeck(), 4);
  assert.equal(result.hands.length, 4);
  result.hands.forEach((hand) => assert.equal(hand.length, 7));
  assert.equal(result.discard.length, 1);
  assert.equal(result.stock.length, 54 - 28 - 1);

  const allCards = [].concat(...result.hands, result.stock, result.discard);
  assert.equal(new Set(allCards).size, 54);
});

test('deal() gives each of 6 players 7 cards plus a starter discard', () => {
  const result = rules.deal(orderedDeck(), 6);
  result.hands.forEach((hand) => assert.equal(hand.length, 7));
  assert.equal(result.stock.length, 54 - 42 - 1);
});

test('deal() rejects a player count outside 2-6', () => {
  assert.throws(() => rules.deal(orderedDeck(), 1));
  assert.throws(() => rules.deal(orderedDeck(), 7));
});

test('deal() rejects a deck that is not a shuffled 54-card array', () => {
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

// --- Jokers -----------------------------------------------------------------

test('isJoker identifies both physical Jokers and nothing else', () => {
  assert.ok(rules.isJoker('1J'));
  assert.ok(rules.isJoker('2J'));
  assert.ok(!rules.isJoker('7C'));
  assert.ok(!rules.isJoker('AS'));
});

test('cardName and cardValue treat a Joker as "Joker" worth 15 deadwood', () => {
  assert.equal(rules.cardName('1J'), 'Joker');
  assert.equal(rules.cardName('2J'), 'Joker');
  assert.equal(rules.cardValue('1J'), 15);
  assert.equal(rules.cardValue('2J'), 15);
});

test('isValidSet: a Joker fills a missing suit in an otherwise valid set', () => {
  assert.ok(rules.isValidSet(['7C', '7D', '1J']));
  assert.ok(rules.isValidSet(['7C', '1J', '2J']));
  assert.ok(rules.isValidSet(['7C', '7D', '7H', '1J']));
});

test('isValidSet rejects a group made entirely of Jokers - there is no real card to anchor its rank', () => {
  assert.ok(!rules.isValidSet(['1J', '2J', '3J']));
});

test('isValidRun: a Joker fills an internal gap or extends either end', () => {
  assert.ok(rules.isValidRun(['4H', '1J', '6H'])); // Joker stands in for 5H
  assert.ok(rules.isValidRun(['4H', '5H', '1J'])); // Joker extends to 6H
  assert.ok(rules.isValidRun(['1J', '4H', '5H'])); // Joker extends to 3H
  assert.ok(rules.isValidRun(['4H', '1J', '2J'])); // two Jokers extend/fill around a single anchor
});

test('isValidRun rejects a Joker extension that would need to wrap past the ace-low boundary', () => {
  // Ace and King anchor the two ends of the suit; 11 Jokers exactly fill
  // every gap between them (a full 13-card run) with none left over.
  const elevenJokers = new Array(11).fill('1J');
  assert.ok(rules.isValidRun(['AC', 'KC'].concat(elevenJokers)));
  // A 12th Joker has nowhere left to go - both ends are already at the
  // ace-low boundary (no wraparound - see the module header).
  assert.ok(!rules.isValidRun(['AC', 'KC'].concat(elevenJokers, ['1J'])));
});

test('isValidRun rejects a group made entirely of Jokers - there is no real card to anchor its suit', () => {
  assert.ok(!rules.isValidRun(['1J', '2J', '3J']));
});

test('classifyMeld: a lone real card plus Jokers is classified as a set by this implementation\'s tie-break', () => {
  assert.deepEqual(rules.classifyMeld(['5H', '1J', '2J']), { valid: true, type: 'set' });
});

test('canExtendMeld: a Joker can always fill a set that has room', () => {
  const set = { type: 'set', cards: ['7C', '7D', '7H'] };
  assert.ok(rules.canExtendMeld(set, '1J'));
  const fullSet = { type: 'set', cards: ['7C', '7D', '7H', '1J'] };
  assert.ok(!rules.canExtendMeld(fullSet, '2J'));
});

test('canExtendMeld: a real card can extend a set that already contains a Joker, matching the anchor rank', () => {
  const set = { type: 'set', cards: ['7C', '1J'] };
  assert.ok(rules.canExtendMeld(set, '7D'));
  assert.ok(!rules.canExtendMeld(set, '8D'));
  assert.ok(!rules.canExtendMeld(set, '7C'));
});

test('canExtendMeld: a run with an internal Joker still extends at its real ends', () => {
  const run = { type: 'run', cards: ['4H', '1J', '6H'] }; // covers 4-5-6, Joker = 5H
  assert.ok(rules.canExtendMeld(run, '3H'));
  assert.ok(rules.canExtendMeld(run, '7H'));
  assert.ok(!rules.canExtendMeld(run, '5H')); // that slot is already filled by the Joker
  assert.ok(!rules.canExtendMeld(run, '3D'));
});

test('canExtendMeld: a Joker can extend a run at either end, but not past the ace-low boundary', () => {
  const run = { type: 'run', cards: ['AC', '2C', '3C'] };
  assert.ok(rules.canExtendMeld(run, '1J'));
  const fullSpan = { type: 'run', cards: ['AC', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC'] };
  assert.ok(!rules.canExtendMeld(fullSpan, '1J'));
});

test('findJokerSwapTarget: a run gives back the Joker filling the exact slot a real card completes', () => {
  const run = { type: 'run', cards: ['AH', '2H', '1J'] }; // covers 1-2-3, Joker = 3H
  assert.equal(rules.findJokerSwapTarget(run, '3H'), '1J');
  // Off-suit or a slot the run doesn't cover (not the Joker's slot) is not a swap.
  assert.equal(rules.findJokerSwapTarget(run, '3D'), null);
  assert.equal(rules.findJokerSwapTarget(run, '4H'), null); // that's a plain extend, not a swap
  assert.equal(rules.findJokerSwapTarget(run, 'AH'), null); // that slot already has a real card, nothing to swap
});

test('findJokerSwapTarget: a set gives back the Joker filling a missing suit a real card completes', () => {
  const set = { type: 'set', cards: ['5H', '5C', '2J'] };
  assert.equal(rules.findJokerSwapTarget(set, '5D'), '2J');
  assert.equal(rules.findJokerSwapTarget(set, '5S'), '2J');
  assert.equal(rules.findJokerSwapTarget(set, '5H'), null); // suit already real, not a swap
  assert.equal(rules.findJokerSwapTarget(set, '6D'), null); // wrong rank
});

test('findJokerSwapTarget: works even when a set already has 4 cards (swap does not grow the group)', () => {
  const fullSet = { type: 'set', cards: ['5H', '5C', '5S', '1J'] };
  assert.equal(rules.findJokerSwapTarget(fullSet, '5D'), '1J');
});

test('findJokerSwapTarget: returns null with no Joker present, or when the card itself is a Joker', () => {
  const setNoJoker = { type: 'set', cards: ['5H', '5C', '5S'] };
  assert.equal(rules.findJokerSwapTarget(setNoJoker, '5D'), null);
  const runWithJoker = { type: 'run', cards: ['4H', '1J', '6H'] };
  assert.equal(rules.findJokerSwapTarget(runWithJoker, '2J'), null);
});

// --- findBestJokerAssignment: joint batch legality against an existing meld -

test('findBestJokerAssignment: a Joker plus the card past the gap it fills must resolve the Joker to make BOTH cards land, not just the first legal position', () => {
  // Existing run 5S-6S-7S; selecting Joker+9S. A card-by-card pass would
  // place the Joker as 4S (extending the low end, the first legal spot),
  // stranding 9S because 8S would then be missing. The whole selection must
  // be evaluated together so the Joker resolves to 8S instead, letting both
  // selected cards land.
  const run = { type: 'run', cards: ['5S', '6S', '7S'] };
  const result = rules.findBestJokerAssignment(run, ['1J', '9S']);
  assert.deepEqual(result.cards.slice().sort(), ['1J', '9S'].sort());
});

test('findBestJokerAssignment: selecting only a Joker still succeeds (either legal end is fine - the ambiguity is a display-only tie-break elsewhere)', () => {
  const run = { type: 'run', cards: ['5S', '6S', '7S'] };
  const result = rules.findBestJokerAssignment(run, ['1J']);
  assert.deepEqual(result.cards, ['1J']);
});

test('findBestJokerAssignment: a placement that lets two selected cards land beats one that only fits the Joker alone', () => {
  const run = { type: 'run', cards: ['4H', '5H', '6H'] };
  const twoCardResult = rules.findBestJokerAssignment(run, ['1J', '8H', '9H']);
  // Joker=7H lets all three selected cards (Joker, 8H, 9H) land in one go.
  assert.deepEqual(twoCardResult.cards.slice().sort(), ['1J', '8H', '9H'].sort());

  const jokerOnlyResult = rules.findBestJokerAssignment(run, ['1J']);
  assert.equal(jokerOnlyResult.cards.length, 1);
  assert.ok(twoCardResult.cards.length > jokerOnlyResult.cards.length);
});

test('findBestJokerAssignment: prefers a natural card over a Joker when a full set has room for only one more', () => {
  // Set already covers 3 of the 4 suits - only one slot remains. The real
  // card that fills it and a selected Joker can't both fit (a set never
  // exceeds 4 cards), so between the two single-card options the tie goes
  // to the natural card, leaving the Joker unspent (rule 10).
  const set = { type: 'set', cards: ['7C', '7D', '7H'] };
  const result = rules.findBestJokerAssignment(set, ['7S', '1J']);
  assert.deepEqual(result.cards, ['7S']);
});

test('findBestJokerAssignment: works for sets as well as runs', () => {
  const set = { type: 'set', cards: ['9C', '9D'] };
  const result = rules.findBestJokerAssignment(set, ['1J', 'KH']);
  // KH cannot join a rank-9 set - only the Joker (filling a missing suit)
  // should be selected.
  assert.deepEqual(result.cards, ['1J']);
});

test('findBestJokerAssignment: multiple Jokers in the selection are evaluated together, not just the first', () => {
  // Existing run 4H-5H; selecting two Jokers plus 8H. Filling the 6H/7H gap
  // with both Jokers lets 8H land too - a single-Joker-at-a-time pass would
  // only ever place one Joker (extending to 6H) and strand the rest.
  const run = { type: 'run', cards: ['4H', '5H'] };
  const result = rules.findBestJokerAssignment(run, ['1J', '2J', '8H']);
  assert.deepEqual(result.cards.slice().sort(), ['1J', '2J', '8H'].sort());
});

test('findBestJokerAssignment: rejects a candidate card that has no legal position at all', () => {
  const run = { type: 'run', cards: ['5S', '6S', '7S'] };
  const result = rules.findBestJokerAssignment(run, ['2C']);
  assert.deepEqual(result.cards, []);
});

test('scoreHand counts a Joker left in hand as 15 deadwood', () => {
  const hands = [[], ['1J', '5H']];
  const result = rules.scoreHand(hands, 0);
  assert.deepEqual(result.deadwoodByPlayer, [0, 20]);
  assert.deepEqual(result.pointsAwarded, [20, 0]);
});

// --- Hand sorting: Ace low, Jokers always last -----------------------------
// The client offers two presentation sort modes (by suit / by value - see
// public/games/rummy/rummy-client.js's rummySortCardsBySuit/ByValue), but
// both must agree on the same underlying ordinal rules this pure module
// defines: Ace low, and a Joker (no fixed rank/suit) sorts after every real
// card no matter which mode is active.

test('rankOrderValue orders A < 2 < 3 < ... < Q < K (Ace low)', () => {
  const ranksInOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
  for (let i = 1; i < ranksInOrder.length; i++) {
    assert.ok(
      rules.rankOrderValue(ranksInOrder[i - 1] + 'C') < rules.rankOrderValue(ranksInOrder[i] + 'C'),
      ranksInOrder[i - 1] + ' should sort below ' + ranksInOrder[i]
    );
  }
});

test('sortHand (sort by suit): groups by suit, Ace low within each suit', () => {
  const sorted = rules.sortHand(['AH', 'KC', '2H', 'QC', 'AC']);
  assert.deepEqual(sorted, ['AC', 'QC', 'KC', 'AH', '2H']);
});

test('sortHand (sort by suit): every Joker sorts after all suited cards, multiple Jokers stay together', () => {
  const sorted = rules.sortHand(['1J', '2H', 'KC', 'AH', '2J', 'AC']);
  assert.deepEqual(sorted, ['AC', 'KC', 'AH', '2H', '1J', '2J']);
});

// The "sort by value" mode is presentation-only client logic (never
// server-authoritative - see rummy-client.js's module header), so it isn't
// exported from this pure module. It's re-derived here from the same
// exported primitives (rankOrderValue/isJoker/suitOf) the client's
// rummySortCardsByValue() uses, to lock in the exact ordering the issue
// spec requires: Ace low, suit as a tiebreaker, Jokers always last.
function sortHandByValue(hand) {
  const SUIT_SORT_ORDER = { C: 0, D: 1, H: 2, S: 3 };
  const JOKER_SORT_VALUE = 14; // sorts after King (13) regardless of rank
  const JOKER_SUIT_VALUE = 4; // sorts after Spades (3) regardless of suit
  function rankKey(card) { return rules.isJoker(card) ? JOKER_SORT_VALUE : rules.rankOrderValue(card); }
  function suitKey(card) { return rules.isJoker(card) ? JOKER_SUIT_VALUE : SUIT_SORT_ORDER[rules.suitOf(card)]; }
  return hand.slice().sort((a, b) => {
    const rankDiff = rankKey(a) - rankKey(b);
    return rankDiff !== 0 ? rankDiff : suitKey(a) - suitKey(b);
  });
}

test('sort by value: Ace low primarily, suit as tiebreak', () => {
  assert.deepEqual(sortHandByValue(['AH', 'KC', '2H', 'QC', 'AC']), ['AC', 'AH', '2H', 'QC', 'KC']);
});

test('sort by value: every Joker sorts after all ranked cards, multiple Jokers stay together', () => {
  assert.deepEqual(sortHandByValue(['1J', '2H', 'KC', 'AH', '2J', 'AC']), ['AC', 'AH', '2H', 'KC', '1J', '2J']);
});

test('card ordering is A < 2 < ... < Q < K < Joker in both sort modes', () => {
  const bySuit = rules.sortHand(['KC', '1J', 'AC']);
  assert.deepEqual(bySuit, ['AC', 'KC', '1J']);
  const byValue = sortHandByValue(['KC', '1J', 'AC']);
  assert.deepEqual(byValue, ['AC', 'KC', '1J']);
});

// --- Ace High or Low (optional table rule) ----------------------------------
// Off (undefined/false options, or omitted entirely) must reproduce the
// exact pre-existing ace-low-only behavior above - these tests exist to lock
// that default in explicitly, not just rely on it being implied by the tests
// above that never pass an options argument at all.

const ACE_LOW = { aceHighOrLow: false };
const ACE_HIGH = { aceHighOrLow: true };

test('isValidRun: ace-low-only mode (option off) accepts A-2-3', () => {
  assert.ok(rules.isValidRun(['AC', '2C', '3C'], ACE_LOW));
});

test('isValidRun: ace-low-only mode (option off) rejects Q-K-A', () => {
  assert.ok(!rules.isValidRun(['QC', 'KC', 'AC'], ACE_LOW));
});

test('isValidRun: ace-high-or-low mode accepts A-2-3', () => {
  assert.ok(rules.isValidRun(['AC', '2C', '3C'], ACE_HIGH));
});

test('isValidRun: ace-high-or-low mode accepts Q-K-A', () => {
  assert.ok(rules.isValidRun(['QC', 'KC', 'AC'], ACE_HIGH));
});

test('isValidRun: K-A-2 (wraparound) is rejected in both ace-low-only and ace-high-or-low modes', () => {
  assert.ok(!rules.isValidRun(['KC', 'AC', '2C'], ACE_LOW));
  assert.ok(!rules.isValidRun(['KC', 'AC', '2C'], ACE_HIGH));
});

test('cardValue: an Ace is worth 1 deadwood in ace-low-only mode, 11 in ace-high-or-low mode - every other card is unaffected', () => {
  assert.equal(rules.cardValue('AC', ACE_LOW), 1);
  assert.equal(rules.cardValue('AC', ACE_HIGH), 11);
  assert.equal(rules.cardValue('KC', ACE_HIGH), 10);
  assert.equal(rules.cardValue('5C', ACE_HIGH), 5);
});

test('cardValue: omitting options entirely defaults to ace-low (1) - existing callers that never pass options are unaffected', () => {
  assert.equal(rules.cardValue('AC'), 1);
});

test('classifyMeld: Q-K-A classifies as a run only when ace-high-or-low is on', () => {
  assert.deepEqual(rules.classifyMeld(['QC', 'KC', 'AC'], ACE_LOW), { valid: false });
  assert.deepEqual(rules.classifyMeld(['QC', 'KC', 'AC'], ACE_HIGH), { valid: true, type: 'run' });
});

test('canExtendMeld: an ace-low A-2-3 run can still extend upward with 4C, and can never wrap below the Ace, in either mode', () => {
  const run = { type: 'run', cards: ['AC', '2C', '3C'] };
  assert.ok(rules.canExtendMeld(run, '4C', ACE_LOW));
  assert.ok(rules.canExtendMeld(run, '4C', ACE_HIGH));
  assert.ok(!rules.canExtendMeld(run, 'KC', ACE_LOW));
  assert.ok(!rules.canExtendMeld(run, 'KC', ACE_HIGH));
});

test('canExtendMeld: an ace-high Q-K-A run can extend downward with JC, but never wraps back around to 2C', () => {
  const run = { type: 'run', cards: ['QC', 'KC', 'AC'] };
  assert.ok(rules.canExtendMeld(run, 'JC', ACE_HIGH));
  assert.ok(!rules.canExtendMeld(run, '2C', ACE_HIGH));
});

test('canExtendMeld: Q-K-A is never reachable at all when ace-high-or-low is off - KC alone cannot even start toward it', () => {
  const run = { type: 'run', cards: ['TC', 'JC', 'QC'] };
  assert.ok(!rules.canExtendMeld(run, 'AC', ACE_LOW));
});

// --- Ace involved in Joker calculations -------------------------------------

test('isValidRun: a real Ace anchoring the top alongside a King, with a Joker filling the Queen gap between them, is only legal in ace-high-or-low mode', () => {
  // Ace-low alone can't place this Joker at all: interpreting the Ace as
  // low (1) against a King (13) is a 13-card gap no single Joker can span.
  // Only the ace-high interpretation (Ace = 14, right after King) makes the
  // Joker's role unambiguous - it must be the Queen.
  assert.ok(!rules.isValidRun(['AC', 'KC', '1J'], ACE_LOW));
  assert.ok(rules.isValidRun(['AC', 'KC', '1J'], ACE_HIGH));
});

test('findJokerSwapTarget: a real Queen swaps back a Joker standing in for it in a Q(Joker)-K-A run, only reachable in ace-high-or-low mode', () => {
  const run = { type: 'run', cards: ['AC', 'KC', '1J'] };
  assert.equal(rules.findJokerSwapTarget(run, 'QC', ACE_HIGH), '1J');
  // Under ace-low-only this group was never a valid run in the first place
  // (see the isValidRun test above), so there is nothing to swap.
  assert.equal(rules.findJokerSwapTarget(run, 'QC', ACE_LOW), null);
});

test('findBestJokerAssignment: a Joker completes an Ace-King run by filling the Queen gap, only when ace-high-or-low is on', () => {
  const run = { type: 'run', cards: ['AC', 'KC'] };
  assert.deepEqual(rules.findBestJokerAssignment(run, ['1J'], ACE_HIGH).cards, ['1J']);
  assert.deepEqual(rules.findBestJokerAssignment(run, ['1J'], ACE_LOW).cards, []);
});

test('scoreHand: an unmatched Ace left in hand scores 1 deadwood in ace-low-only mode and 11 in ace-high-or-low mode', () => {
  const hands = [[], ['AC', '5H']];
  assert.deepEqual(rules.scoreHand(hands, 0, ACE_LOW).deadwoodByPlayer, [0, 6]);
  assert.deepEqual(rules.scoreHand(hands, 0, ACE_HIGH).deadwoodByPlayer, [0, 16]);
});

// --- Deterministic Joker melds: resolveMeld() -------------------------------
// See the "Implement Deterministic Joker Melds and Layoffs" issue - every
// case below is drawn directly from that issue's own examples.

test('resolveMeld: "8S, Joker, Joker" is genuinely ambiguous (both a set and a run are legal) - needsChoice with no meldTypeChoice given', () => {
  const result = rules.resolveMeld(['8S', '1J', '2J'], ACE_LOW);
  assert.equal(result.ok, true);
  assert.equal(result.needsChoice, true);
  assert.deepEqual(result.options.slice().sort(), ['run', 'set']);
});

test('resolveMeld: "8S, Joker, Joker" as a Set represents three 8s', () => {
  const result = rules.resolveMeld(['8S', '1J', '2J'], ACE_LOW, 'set');
  assert.equal(result.needsChoice, false);
  assert.equal(result.type, 'set');
  assert.equal(rules.rankOf(result.jokers['1J']), '8');
  assert.equal(rules.rankOf(result.jokers['2J']), '8');
  assert.equal(result.cards.length, 3);
});

test('resolveMeld: "8S, Joker, Joker" as a Run represents 8S-9S-TS (both Jokers selected after the 8, so both extend high)', () => {
  const result = rules.resolveMeld(['8S', '1J', '2J'], ACE_LOW, 'run');
  assert.equal(result.needsChoice, false);
  assert.equal(result.type, 'run');
  assert.deepEqual(result.cards, ['8S', '1J', '2J']);
  assert.equal(result.jokers['1J'], '9S');
  assert.equal(result.jokers['2J'], 'TS');
});

test('resolveMeld: "Joker, 8S, Joker" as a Set represents three 8s', () => {
  const result = rules.resolveMeld(['1J', '8S', '2J'], ACE_LOW, 'set');
  assert.equal(result.type, 'set');
  assert.equal(rules.rankOf(result.jokers['1J']), '8');
  assert.equal(rules.rankOf(result.jokers['2J']), '8');
});

test('resolveMeld: "Joker, 8S, Joker" as a Run represents 7S-8S-9S (one Joker before the 8, one after)', () => {
  const result = rules.resolveMeld(['1J', '8S', '2J'], ACE_LOW, 'run');
  assert.equal(result.type, 'run');
  assert.deepEqual(result.cards, ['1J', '8S', '2J']);
  assert.equal(result.jokers['1J'], '7S');
  assert.equal(result.jokers['2J'], '9S');
});

test('resolveMeld: "Joker, King, Ace" (ace-high) has only one legal interpretation and resolves automatically to Queen-King-Ace, no prompt', () => {
  const result = rules.resolveMeld(['1J', 'KS', 'AS'], ACE_HIGH);
  assert.equal(result.needsChoice, false);
  assert.equal(result.type, 'run');
  assert.equal(result.jokers['1J'], 'QS');
  assert.deepEqual(result.cards, ['1J', 'KS', 'AS']);
});

test('resolveMeld: "Ace, King, Joker" (ace-high) resolves the same way regardless of selection order, and stores the Joker in its logical (Queen) position, not at the end', () => {
  const result = rules.resolveMeld(['AS', 'KS', '1J'], ACE_HIGH);
  assert.equal(result.needsChoice, false);
  assert.equal(result.type, 'run');
  assert.equal(result.jokers['1J'], 'QS');
  assert.deepEqual(result.cards, ['1J', 'KS', 'AS']);
});

test('resolveMeld: "7S, Joker, 9S" has only one legal interpretation (the Joker must fill the 8S gap) - no Run/Set prompt since it can never be a set', () => {
  const result = rules.resolveMeld(['7S', '1J', '9S'], ACE_LOW);
  assert.equal(result.needsChoice, false);
  assert.equal(result.type, 'run');
  assert.equal(result.jokers['1J'], '8S');
});

test('resolveMeld: "Ace, Joker, 3S" (ace-low) resolves to Ace-Joker(2S)-3S, stored/displayed in that logical order', () => {
  const result = rules.resolveMeld(['AS', '1J', '3S'], ACE_LOW);
  assert.equal(result.needsChoice, false);
  assert.equal(result.jokers['1J'], '2S');
  assert.deepEqual(result.cards, ['AS', '1J', '3S']);
});

test('resolveMeld: "Queen, King, Ace" (ace-high) stores/displays in that ascending logical order', () => {
  const result = rules.resolveMeld(['QS', 'KS', 'AS'], ACE_HIGH);
  assert.equal(result.type, 'run');
  assert.deepEqual(result.cards, ['QS', 'KS', 'AS']);
});

test('resolveMeld: rejects a King-Ace-2 wraparound run in either Ace mode', () => {
  assert.equal(rules.resolveMeld(['KS', 'AS', '2S'], ACE_LOW).ok, false);
  assert.equal(rules.resolveMeld(['KS', 'AS', '2S'], ACE_HIGH).ok, false);
});

test('resolveMeld: rejects a King-Joker-2 wraparound attempt - the Joker would need to represent an Ace anchoring the top of the suit (for King) and the bottom (for 2) at once', () => {
  assert.equal(rules.resolveMeld(['KS', '1J', '2S'], ACE_LOW).ok, false);
  assert.equal(rules.resolveMeld(['KS', '1J', '2S'], ACE_HIGH).ok, false);
});

test('resolveMeld: an unambiguous selection ignores a stale/wrong meldTypeChoice and resolves to its one legal interpretation', () => {
  const result = rules.resolveMeld(['7S', '1J', '9S'], ACE_LOW, 'set');
  assert.equal(result.ok, true);
  assert.equal(result.type, 'run');
});

test('resolveMeld: rejects a selection that is neither a legal run nor a legal set', () => {
  const result = rules.resolveMeld(['4H', '5D', '6H'], ACE_LOW);
  assert.equal(result.ok, false);
});

// --- Joker replacement -------------------------------------------------------

test('Joker replacement: for "7S, Joker(8S), 9S" - only the exact 8S may replace the Joker; 6S and TS may not, though TS remains a legal extension', () => {
  const meld = rules.resolveMeld(['7S', '1J', '9S'], ACE_LOW);
  const group = { type: meld.type, cards: meld.cards, jokers: meld.jokers, mode: meld.mode };

  assert.equal(rules.findJokerSwapTarget(group, '8S'), '1J');
  assert.equal(rules.findJokerSwapTarget(group, '6S'), null);
  assert.equal(rules.findJokerSwapTarget(group, 'TS'), null);

  // TS is still a legal extension of the group (a distinct operation from
  // replacing the Joker) - this must keep working independently.
  assert.ok(rules.canExtendMeld(group, 'TS', ACE_LOW));

  const swapped = rules.applyJokerSwap(group, '8S', '1J', ACE_LOW);
  assert.deepEqual(swapped.cards, ['7S', '8S', '9S']);
  assert.deepEqual(swapped.jokers, {});
});

// --- Sets --------------------------------------------------------------------

test('Sets: a set containing "8, Joker(8), 8" only accepts another legal 8 for layoff - 7 and 9 are rejected', () => {
  // Reals are 8C/8D; the Joker's identity is rank-only (no suit at all - see
  // assignSetJokerRanks()'s header), so canExtendMeld/findJokerSwapTarget
  // must treat it as generic, not pinned to a specific missing suit.
  const meld = rules.resolveMeld(['8C', '1J', '8D'], ACE_LOW, 'set');
  const group = { type: meld.type, cards: meld.cards, jokers: meld.jokers, mode: meld.mode };
  assert.equal(meld.jokers['1J'], '8');

  assert.ok(rules.canExtendMeld(group, '8S', ACE_LOW));
  assert.ok(rules.canExtendMeld(group, '8H', ACE_LOW));
  assert.ok(!rules.canExtendMeld(group, '7S', ACE_LOW));
  assert.ok(!rules.canExtendMeld(group, '9S', ACE_LOW));
});

test('Sets: a set Joker is generic by suit - either still-missing suit (8H or 8S) replaces it, not just one arbitrarily-picked suit', () => {
  const meld = rules.resolveMeld(['8C', '1J', '8D'], ACE_LOW, 'set');
  const group = { type: meld.type, cards: meld.cards, jokers: meld.jokers, mode: meld.mode };

  assert.equal(rules.findJokerSwapTarget(group, '8H', ACE_LOW), '1J');
  assert.equal(rules.findJokerSwapTarget(group, '8S', ACE_LOW), '1J');
  assert.equal(rules.findJokerSwapTarget(group, '7S', ACE_LOW), null);
  assert.equal(rules.findJokerSwapTarget(group, '9S', ACE_LOW), null);

  const swapped = rules.applyJokerSwap(group, '8H', '1J', ACE_LOW);
  assert.deepEqual(swapped.cards.slice().sort(), ['8C', '8D', '8H']);
  assert.deepEqual(swapped.jokers, {});
});

test('Sets: a real card replaces a set Joker rather than being added beside it, even when the set still has room to grow', () => {
  // Ace8, Ace8, Joker(rank Ace) has room for a 4th card (MAX_SET_SIZE), so a
  // naive "just extend" pass would add AceH beside the Joker instead of
  // replacing it - resolveLayoff (the single-group whole-batch resolver
  // games/rummy/index.js's performLayOffCards() uses) must swap first.
  const meld = rules.resolveMeld(['AC', 'AD', '1J'], ACE_LOW, 'set');
  const group = { type: meld.type, cards: meld.cards, jokers: meld.jokers, mode: meld.mode };

  const result = rules.resolveLayoff(group, ['AH'], ACE_LOW);
  assert.ok(result);
  assert.deepEqual(result.group.cards.slice().sort(), ['AC', 'AD', 'AH']);
  assert.deepEqual(result.returnedJokers, ['1J']);
  assert.deepEqual(result.group.jokers, {});
});

// --- Multiple layoffs at once (resolveGroupExtension) ------------------------

test('resolveGroupExtension: extends the low end of an existing run', () => {
  const run = { type: 'run', cards: ['8S', '9S', 'TS'] };
  const best = rules.findBestJokerAssignment(run, ['7S'], ACE_LOW);
  assert.deepEqual(best.cards, ['7S']);
  const extended = rules.resolveGroupExtension(run, best.cards, ACE_LOW);
  assert.deepEqual(extended.cards, ['7S', '8S', '9S', 'TS']);
});

test('resolveGroupExtension: extends the high end of an existing run', () => {
  const run = { type: 'run', cards: ['8S', '9S', 'TS'] };
  const best = rules.findBestJokerAssignment(run, ['JS'], ACE_LOW);
  const extended = rules.resolveGroupExtension(run, best.cards, ACE_LOW);
  assert.deepEqual(extended.cards, ['8S', '9S', 'TS', 'JS']);
});

test('resolveGroupExtension: extends both ends of an existing run in a single batch', () => {
  const run = { type: 'run', cards: ['8S', '9S', 'TS'] };
  const best = rules.findBestJokerAssignment(run, ['7S', 'JS'], ACE_LOW);
  assert.deepEqual(best.cards.slice().sort(), ['7S', 'JS']);
  const extended = rules.resolveGroupExtension(run, best.cards, ACE_LOW);
  assert.deepEqual(extended.cards, ['7S', '8S', '9S', 'TS', 'JS']);
});

test('resolveGroupExtension: a new Joker added to an existing run resolves to the correct gap and keeps the group\'s established Ace mode stable', () => {
  const run = { type: 'run', cards: ['QC', 'KC', 'AC'], jokers: {}, mode: rules.ACE_HIGH_ORDER_VALUE };
  const best = rules.findBestJokerAssignment(run, ['1J', 'TC'], ACE_HIGH);
  assert.deepEqual(best.cards.slice().sort(), ['1J', 'TC']);
  const extended = rules.resolveGroupExtension(run, best.cards, ACE_HIGH);
  assert.equal(extended.mode, rules.ACE_HIGH_ORDER_VALUE);
  assert.equal(extended.jokers['1J'], 'JC');
  assert.deepEqual(extended.cards, ['TC', '1J', 'QC', 'KC', 'AC']);
});

test('resolveGroupExtension: replacing a Joker while also adding a new card in the same batch resolves both together', () => {
  // Existing run 7S-8S-Joker(9S); the player holds the exact replacement
  // (9S) plus TS, extending past it - both should land in one batch, the
  // Joker released back to the player's hand by the caller (see
  // games/rummy/index.js's performLayOffCards(), exercised end-to-end in
  // tests/rummy-game.test.js).
  const meld = rules.resolveMeld(['7S', '8S', '1J'], ACE_LOW);
  assert.equal(meld.jokers['1J'], '9S');
  const group = { type: meld.type, cards: meld.cards, jokers: meld.jokers, mode: meld.mode };

  const swapJoker = rules.findJokerSwapTarget(group, '9S');
  assert.equal(swapJoker, '1J');
  const swapped = rules.applyJokerSwap(group, '9S', swapJoker, ACE_LOW);
  assert.deepEqual(swapped.cards, ['7S', '8S', '9S']);

  const best = rules.findBestJokerAssignment(swapped, ['TS'], ACE_LOW);
  const extended = rules.resolveGroupExtension(swapped, best.cards, ACE_LOW);
  assert.deepEqual(extended.cards, ['7S', '8S', '9S', 'TS']);
  assert.deepEqual(extended.jokers, {});
});

// --- Ace ordering -------------------------------------------------------------

test('Ace ordering: Ace-2-3 (ace-low) is stored and displayed in that logical order', () => {
  const result = rules.resolveMeld(['3S', 'AS', '2S'], ACE_LOW);
  assert.deepEqual(result.cards, ['AS', '2S', '3S']);
});

test('Ace ordering: Queen-King-Ace (ace-high) is stored and displayed in that logical order', () => {
  const result = rules.resolveMeld(['AS', 'QS', 'KS'], ACE_HIGH);
  assert.deepEqual(result.cards, ['QS', 'KS', 'AS']);
});
