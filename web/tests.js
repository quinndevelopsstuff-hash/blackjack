/*
 * Quick console tests for the game logic. Run with:  node web/tests.js
 * Uses stacked shoes so every scenario is deterministic.
 */
'use strict';
const BJ = require('./engine.js');
const { handValue, describeHand, isNatural, dealerShouldHit, basicStrategy, Game } = BJ;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

// "A K 5" → card objects (suit irrelevant for scoring)
const C = (str) => str.split(/\s+/).map((rank) => ({ rank, suit: '♠' }));

/**
 * Game with a stacked shoe. `order` lists ranks in the order they are dealt:
 * player, dealer up, player, dealer hole, then any further draws.
 * 200 filler cards sit underneath so no reshuffle triggers.
 */
function stacked(order, bet = 100, bankroll = 1000) {
  const g = new Game({ rng: () => 0.5 });
  const filler = Array.from({ length: 200 }, () => ({ rank: '2', suit: '♣' }));
  g.s.shoe = [...filler, ...C(order).reverse()];
  g.s.bankroll = bankroll;
  g.addChip(bet);
  g.deal();
  return g;
}

console.log('\nHand scoring');
test('A,K = 21 soft, natural', () => {
  eq(handValue(C('A K')), { total: 21, soft: true, bust: false });
  eq(isNatural(C('A K')), true);
});
test('A,A = soft 12', () => eq(handValue(C('A A')), { total: 12, soft: true, bust: false }));
test('A,A,9 = soft 21 (not natural)', () => {
  eq(handValue(C('A A 9')), { total: 21, soft: true, bust: false });
  eq(isNatural(C('A A 9')), false);
});
test('A,6 = soft 17', () => eq(describeHand(C('A 6')), 'Soft 17'));
test('A,6,10 = hard 17', () => eq(handValue(C('A 6 10')), { total: 17, soft: false, bust: false }));
test('A,A,A,A,7 = soft 21', () => eq(handValue(C('A A A A 7')), { total: 21, soft: true, bust: false }));
test('A,5,A,9 = hard 16', () => eq(handValue(C('A 5 A 9')), { total: 16, soft: false, bust: false }));
test('K,Q,2 = bust 22', () => {
  eq(handValue(C('K Q 2')).bust, true);
  eq(describeHand(C('K Q 2')), 'Bust (22)');
});
test('5,5,A = 21 labelled "21", not "Soft 21"', () => eq(describeHand(C('5 5 A')), '21'));
test('J,Q,K count as 10', () => eq(handValue(C('J Q')).total, 20));
test('split A,K is 21, not blackjack', () => {
  eq(isNatural(C('A K'), true), false);
  eq(describeHand(C('A K'), true), '21');
});

console.log('\nDealer AI');
test('hits hard 16', () => eq(dealerShouldHit(C('10 6')), true));
test('stands on soft 17 (A,6)', () => eq(dealerShouldHit(C('A 6')), false));
test('stands on soft 17 (A,A,5)', () => eq(dealerShouldHit(C('A A 5')), false));
test('hits soft 16 (A,5)', () => eq(dealerShouldHit(C('A 5')), true));
test('stands on hard 17 (10,6,A)', () => eq(dealerShouldHit(C('10 6 A')), false));

console.log('\nShoe');
test('6 decks = 312 cards, 24 of each rank', () => {
  const g = new Game();
  eq(g.s.shoe.length, 312);
  eq(g.s.shoe.filter((c) => c.rank === 'A').length, 24);
  eq(g.s.shoe.filter((c) => c.rank === 'Q' && c.suit === '♥').length, 6);
});
test('reshuffles when under 25% remain', () => {
  const g = new Game();
  g.s.shoe = g.s.shoe.slice(0, 77);           // < 78 = 25% of 312
  g.addChip(5);
  g.deal();
  eq(g.s.justShuffled, true);
  eq(g.s.shoe.length, 312 - 4);
});
test('no reshuffle at exactly 25%', () => {
  const g = new Game();
  g.s.shoe = g.s.shoe.slice(0, 78);
  g.addChip(5);
  g.deal();
  eq(g.s.justShuffled, false);
});

console.log('\nRounds');
test('player blackjack pays 3:2, hole card revealed', () => {
  const g = stacked('A 9 K 7');
  eq(g.s.phase, 'betting');
  eq(g.s.hands[0].result, 'blackjack');
  eq(g.s.result.net, 150);
  eq(g.s.bankroll, 1150);
  eq(g.s.holeHidden, false);
});
test('both blackjack = push', () => {
  const g = stacked('A K K A');   // dealer up K, hole A
  eq(g.s.hands[0].result, 'push');
  eq(g.s.bankroll, 1000);
});
test('dealer blackjack (10 up) ends round before player acts', () => {
  const g = stacked('9 K 9 A');
  eq(g.s.phase, 'betting');
  eq(g.s.hands[0].result, 'lose');
  eq(g.s.bankroll, 900);
});
test('ace up offers insurance; taken + dealer BJ = net 0', () => {
  const g = stacked('9 A 9 K');
  eq(g.s.phase, 'insurance');
  g.takeInsurance(true);
  eq(g.s.hands[0].result, 'lose');
  eq(g.s.result.insuranceReturn, 150);       // 50 stake + 100 win
  eq(g.s.result.net, 0);
  eq(g.s.bankroll, 1000);
});
test('even money: player BJ + insurance vs dealer BJ = +1x bet', () => {
  const g = stacked('A A K K');
  eq(g.s.phase, 'insurance');
  g.takeInsurance(true);
  eq(g.s.hands[0].result, 'push');
  eq(g.s.result.net, 100);
});
test('insurance lost when dealer has no BJ; play continues', () => {
  const g = stacked('10 A 8 7');
  g.takeInsurance(true);
  eq(g.s.phase, 'player');
  eq(g.s.bankroll, 850);
  g.stand();                                   // 18 vs soft 18 → push
  g.playDealer();
  eq(g.s.hands[0].result, 'push');
  eq(g.s.result.net, -50);
});
test('player bust loses; dealer draws nothing', () => {
  const g = stacked('10 6 6 10 K 5');
  g.hit();                                     // 10+6+K = 26
  eq(g.s.phase, 'betting');
  eq(g.s.hands[0].result, 'bust');
  eq(g.s.dealer.length, 2);
  eq(g.s.bankroll, 900);
});
test('dealer stands on soft 17, player 18 wins', () => {
  const g = stacked('10 A 8 6 5');
  g.takeInsurance(false);
  g.stand();
  g.playDealer();
  eq(g.s.dealer.length, 2);
  eq(g.s.hands[0].result, 'win');
  eq(g.s.bankroll, 1100);
});
test('dealer busts', () => {
  const g = stacked('10 10 7 6 9');
  g.stand();
  g.playDealer();
  eq(g.s.result.dealerBust, true);
  eq(g.s.hands[0].result, 'win');
});
test('push on equal totals', () => {
  const g = stacked('10 10 9 9');
  g.stand();
  g.playDealer();
  eq(g.s.hands[0].result, 'push');
  eq(g.s.bankroll, 1000);
});
test('hitting to 21 auto-stands', () => {
  const g = stacked('5 10 6 8 K');
  g.hit();
  eq(g.s.phase, 'dealer');
});
test('double: one card, bet doubled, hand done', () => {
  const g = stacked('6 6 5 10 K 10');       // player 11 vs 16; draws K → 21; dealer draws 10 → bust
  eq(g.canDouble(), true);
  g.double();
  eq(g.s.hands[0].bet, 200);
  eq(g.s.hands[0].cards.length, 3);
  eq(g.s.phase, 'dealer');
  g.playDealer();
  eq(g.s.hands[0].result, 'win');
  eq(g.s.bankroll, 1200);
});
test('cannot double on 3 cards', () => {
  const g = stacked('2 6 3 10 4');
  g.hit();
  eq(g.canDouble(), false);
  eq(g.double(), false);
});
test('cannot double/split without enough chips', () => {
  const g = stacked('8 6 8 10', 100, 150);   // 50 left after betting
  eq(g.canDouble(), false);
  eq(g.canSplit(), false);
});
test('split 8s: two hands, second gets its card later, DAS allowed', () => {
  const g = stacked('8 6 8 10 3 2 10');
  eq(g.canSplit(), true);
  g.split();
  eq(g.s.hands.length, 2);
  eq(g.s.hands[0].cards.length, 2);          // 8,3
  eq(g.s.hands[1].cards.length, 1);          // 8 (waits)
  eq(g.canDouble(), true);                   // double after split
  g.double();                                // 8,3,2 = 13, bet 200
  eq(g.s.active, 1);
  eq(g.s.hands[1].cards.length, 2);          // 8,10
  eq(g.canSplit(), false);                   // one split max
  g.stand();
  g.playDealer();                            // dealer 16 draws: next card is filler 2 → 18
  eq(g.s.hands.map((h) => h.result), ['lose', 'push']);
  eq(g.s.result.net, -200);
  eq(g.s.bankroll, 800);
});
test('one split max: re-pair after split cannot split again', () => {
  const g = stacked('8 6 8 10 8');
  g.split();                                 // hand 1 = 8,8
  eq(g.s.hands[0].cards.map((c) => c.rank), ['8', '8']);
  eq(g.canSplit(), false);
});
test('split aces (dealer 9 up): one card each, 21 pays even money', () => {
  const g = stacked('A 9 A 8 K 5');
  eq(g.s.phase, 'player');
  g.split();
  eq(g.s.hands.map((h) => h.cards.length), [2, 2]);
  eq(g.s.phase, 'dealer');                   // no further decisions on split aces
  eq(g.canHit(), false);
  g.playDealer();                            // dealer 17 stands
  eq(g.s.hands.map((h) => h.result), ['win', 'lose']);   // 21 wins 1:1; A,5=16 loses
  eq(g.s.hands[0].payout, 200);              // 1:1, not 3:2
  eq(g.s.result.net, 0);
});
test('10-value pair (K,Q) may be split', () => {
  const g = stacked('K 6 Q 10');
  eq(g.canSplit(), true);
});
test('all split hands bust → dealer does not draw', () => {
  const g = stacked('8 6 8 10 K 7 K 9');
  g.split();
  g.hit();                                   // 8,K,7 = 25
  eq(g.s.active, 1);
  g.hit();                                   // 8,K,9 = 27
  eq(g.s.phase, 'betting');
  eq(g.s.dealer.length, 2);
  eq(g.s.bankroll, 800);
});
test('stats: wins, streak, biggest win', () => {
  const g = stacked('A 9 K 7');
  eq(g.s.stats.wins, 1);
  eq(g.s.stats.blackjacks, 1);
  eq(g.s.stats.biggestWin, 150);
  eq(g.s.stats.streak, 1);
});
test('betting: chips, clear, rebet, rebuy', () => {
  const g = new Game();
  g.addChip(500); g.addChip(500);
  eq(g.addChip(5), false);                   // can't bet more than you have
  g.clearBet();
  eq(g.s.bankroll, 1000);
  g.s.bankroll = 0;
  eq(g.canRebuy(), true);
  g.rebuy();
  eq(g.s.bankroll, 1000);
});
test('all in: whole balance goes on the bet, even odd amounts', () => {
  const g = new Game();
  g.s.bankroll = 937.5;
  g.addChip(25);
  eq(g.allIn(), true);
  eq([g.s.bankroll, g.s.bet], [0, 937.5]);
  eq(g.canAllIn(), false);
  g.deal();
  eq(g.canDouble(), false);                  // nothing left to double with
});
test('state survives a JSON round trip mid-round', () => {
  const g = stacked('8 6 8 10 3');
  g.split();
  const g2 = new Game({ state: JSON.parse(JSON.stringify(g.serialize())) });
  eq(g2.s.phase, 'player');
  eq(g2.s.hands.length, 2);
  g2.stand();
  eq(g2.s.active, 1);
});

console.log('\nBasic strategy (6D, S17, DAS)');
const bs = (hand, up, o) => basicStrategy(C(hand), { rank: up }, o);
test('hard 16 vs 10 hit, vs 6 stand', () => { eq(bs('10 6', '10'), 'H'); eq(bs('10 6', '6'), 'S'); });
test('hard 12 vs 3 hit, vs 4 stand', () => { eq(bs('10 2', '3'), 'H'); eq(bs('10 2', '4'), 'S'); });
test('11 vs 10 double, vs A hit (S17)', () => { eq(bs('6 5', '10'), 'D'); eq(bs('6 5', 'A'), 'H'); });
test('soft 18: double vs 6, stand vs 7, hit vs 9', () => {
  eq(bs('A 7', '6'), 'D'); eq(bs('A 7', '7'), 'S'); eq(bs('A 7', '9'), 'H');
});
test('soft 18 vs 6 with 3 cards: stand', () => eq(bs('A 3 4', '6'), 'S'));
test('always split A,A and 8,8; never 10,10', () => {
  eq(bs('A A', '10'), 'P'); eq(bs('8 8', 'A'), 'P'); eq(bs('K K', '6'), 'S');
});
test('9,9 vs 7 stand, vs 8 split', () => { eq(bs('9 9', '7'), 'S'); eq(bs('9 9', '8'), 'P'); });
test('5,5 vs 9 double (treated as 10)', () => eq(bs('5 5', '9'), 'D'));
test('8,8 when split not allowed → hard 16 rules', () => eq(bs('8 8', '10', { canSplit: false }), 'H'));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
