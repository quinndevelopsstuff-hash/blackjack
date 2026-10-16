/*
 * engine.js — pure blackjack logic. No DOM access.
 *
 * Everything that decides the outcome of a hand lives here: the shoe, hand
 * scoring, the round state machine (bet → deal → insurance → player → dealer
 * → settle) and basic strategy. The UI (game.js) only calls these methods and
 * draws whatever `game.s` says. Loads as `window.BJ` in the browser and via
 * `require('./engine.js')` in Node (see tests.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BJ = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  const RULES = Object.freeze({
    decks: 6,
    reshuffleAt: 0.25,      // reshuffle before a round once < 25% of the shoe remains
    blackjackPays: 1.5,     // 3:2
    insurancePays: 2,       // 2:1
    startingBankroll: 1000,
    minBet: 5,
    chips: [5, 25, 100, 500],
  });

  // ---------------------------------------------------------------- cards ---

  function cardValue(rank) {
    if (rank === 'A') return 1;                       // aces start at 1; see handValue
    if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
    return Number(rank);
  }

  function isRed(card) {
    return card.suit === '♥' || card.suit === '♦';
  }

  function defaultRng() {
    const c = typeof globalThis !== 'undefined' && globalThis.crypto;
    if (c && c.getRandomValues) {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }

  /** Build and Fisher–Yates shuffle a shoe. Cards are drawn with pop(). */
  function buildShoe(decks, rng) {
    const shoe = [];
    for (let d = 0; d < decks; d++)
      for (const suit of SUITS)
        for (const rank of RANKS) shoe.push({ rank, suit });
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    return shoe;
  }

  // -------------------------------------------------------------- scoring ---

  /**
   * Score a hand.
   *
   * Ace handling: every ace is first counted as 1, giving the "hard" total.
   * At most ONE ace can ever usefully count as 11 (two would already be 22),
   * so the only question is whether promoting a single ace (+10) keeps the
   * hand at 21 or less. If it does, the hand is "soft": it can take any card
   * without busting, because that ace can drop back to 1.
   *
   *   A,6      → hard 7,  +10 = 17 ≤ 21 → Soft 17
   *   A,6,10   → hard 17, +10 = 27 > 21 → Hard 17
   *   A,A,9    → hard 11, +10 = 21      → Soft 21 (one ace is 11, one is 1)
   */
  function handValue(cards) {
    let hard = 0;
    let aces = 0;
    for (const c of cards) {
      hard += cardValue(c.rank);
      if (c.rank === 'A') aces++;
    }
    const soft = aces > 0 && hard + 10 <= 21;
    const total = soft ? hard + 10 : hard;
    return { total, soft, bust: total > 21 };
  }

  /**
   * A natural is exactly two cards totalling 21. A hand created by splitting
   * is never a natural: A + 10 after splitting aces is just 21 and pays 1:1.
   */
  function isNatural(cards, fromSplit = false) {
    return !fromSplit && cards.length === 2 && handValue(cards).total === 21;
  }

  /** Human label for a hand total: "Soft 17", "20", "Blackjack", "Bust (24)". */
  function describeHand(cards, fromSplit = false) {
    if (!cards.length) return '';
    if (isNatural(cards, fromSplit)) return 'Blackjack';
    const v = handValue(cards);
    if (v.bust) return `Bust (${v.total})`;
    if (v.soft && v.total < 21) return `Soft ${v.total}`;
    return String(v.total);
  }

  /** Dealer AI: hit 16 or less, stand on ALL 17s (soft 17 included). */
  function dealerShouldHit(cards) {
    return handValue(cards).total < 17;
  }

  // ------------------------------------------------------- basic strategy ---

  /**
   * Basic strategy for this ruleset: 6 decks, dealer stands on soft 17,
   * double after split allowed, no surrender.
   * Returns 'H' | 'S' | 'D' | 'P'. When doubling isn't allowed (3+ cards or
   * not enough chips) the chart's fallback is used: "Dh" → hit, "Ds" → stand.
   */
  function basicStrategy(cards, dealerUpCard, { canDouble = true, canSplit = true } = {}) {
    const upRaw = cardValue(dealerUpCard.rank);
    const up = upRaw === 1 ? 11 : upRaw;                  // dealer ace = 11
    const dbl = (fallback) => (canDouble && cards.length === 2 ? 'D' : fallback);

    // Pairs
    if (canSplit && cards.length === 2 && cardValue(cards[0].rank) === cardValue(cards[1].rank)) {
      const p = cardValue(cards[0].rank);
      const rules = {
        1: () => true,                       // always split aces
        8: () => true,                       // always split 8s
        10: () => false,                     // never split tens
        9: (u) => u <= 9 && u !== 7,         // split 9s vs 2–6, 8–9
        7: (u) => u <= 7,
        6: (u) => u <= 6,
        5: () => false,                      // play 5,5 as hard 10
        4: (u) => u === 5 || u === 6,
        3: (u) => u <= 7,
        2: (u) => u <= 7,
      };
      if (rules[p](up)) return 'P';
    }

    const { total, soft } = handValue(cards);

    if (soft) {
      if (total >= 19) return 'S';
      if (total === 18) {
        if (up >= 3 && up <= 6) return dbl('S');
        if (up === 2 || up === 7 || up === 8) return 'S';
        return 'H';
      }
      if (total === 17) return up >= 3 && up <= 6 ? dbl('H') : 'H';
      if (total === 15 || total === 16) return up >= 4 && up <= 6 ? dbl('H') : 'H';
      if (total === 13 || total === 14) return up >= 5 && up <= 6 ? dbl('H') : 'H';
      return 'H';                            // soft 12 = A,A when not splitting
    }

    if (total >= 17) return 'S';
    if (total >= 13) return up <= 6 ? 'S' : 'H';
    if (total === 12) return up >= 4 && up <= 6 ? 'S' : 'H';
    if (total === 11) return up <= 10 ? dbl('H') : 'H';
    if (total === 10) return up <= 9 ? dbl('H') : 'H';
    if (total === 9) return up >= 3 && up <= 6 ? dbl('H') : 'H';
    return 'H';
  }

  // ----------------------------------------------------------------- game ---

  function freshStats() {
    return {
      hands: 0, rounds: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0,
      biggestWin: 0, streak: 0, bestStreak: 0, net: 0, rebuys: 0,
    };
  }

  function newHand(bet, extra = {}) {
    return {
      cards: [], bet, doubled: false, split: false, splitAces: false,
      done: false, result: null, payout: 0, ...extra,
    };
  }

  class Game {
    constructor({ rules = {}, rng = defaultRng, state = null } = {}) {
      this.rules = { ...RULES, ...rules };
      this.rng = rng;
      this.s = Game.isValidState(state) ? state : this.freshState();
    }

    static isValidState(st) {
      return !!st && st.v === 1 && typeof st.bankroll === 'number' && isFinite(st.bankroll) &&
        Array.isArray(st.shoe) && Array.isArray(st.hands) && Array.isArray(st.dealer) &&
        typeof st.phase === 'string' && !!st.stats;
    }

    freshState() {
      const shoe = buildShoe(this.rules.decks, this.rng);
      return {
        v: 1,
        bankroll: this.rules.startingBankroll,  // chips in front of the player (not on the table)
        bet: 0,                                 // chips in the betting circle before the deal
        lastBet: 0,
        phase: 'betting',
        shoe, shoeSize: shoe.length,
        justShuffled: false,
        seq: 0,                                 // every dealt card gets a unique, increasing seq
        dealer: [], holeHidden: false,
        hands: [], active: 0,
        insurance: 0,
        round: 0,
        result: null,
        stats: freshStats(),
      };
    }

    serialize() { return this.s; }

    resetStats() { this.s.stats = freshStats(); }

    get hand() { return this.s.hands[this.s.active]; }

    draw() {
      const s = this.s;
      // Safety net: the 25% cut card makes this practically unreachable.
      if (!s.shoe.length) s.shoe = buildShoe(this.rules.decks, this.rng);
      const card = s.shoe.pop();
      card.seq = ++s.seq;
      return card;
    }

    // --- betting -----------------------------------------------------------

    canAddChip(v) { return this.s.phase === 'betting' && this.s.bankroll >= v; }

    addChip(v) {
      if (!this.canAddChip(v)) return false;
      this.s.bankroll -= v;
      this.s.bet += v;
      return true;
    }

    clearBet() {
      if (this.s.phase !== 'betting' || !this.s.bet) return false;
      this.s.bankroll += this.s.bet;
      this.s.bet = 0;
      return true;
    }

    canRebet() {
      const s = this.s;
      return s.phase === 'betting' && s.lastBet > 0 && s.bet !== s.lastBet && s.bankroll + s.bet >= s.lastBet;
    }

    rebet() {
      if (!this.canRebet()) return false;
      const s = this.s;
      s.bankroll += s.bet;
      s.bankroll -= s.lastBet;
      s.bet = s.lastBet;
      return true;
    }

    canRebuy() {
      const s = this.s;
      return s.phase === 'betting' && s.bankroll + s.bet < this.rules.minBet;
    }

    rebuy() {
      if (!this.canRebuy()) return false;
      this.s.bankroll += this.rules.startingBankroll;
      this.s.stats.rebuys++;
      return true;
    }

    canDeal() { return this.s.phase === 'betting' && this.s.bet > 0; }

    // --- dealing -----------------------------------------------------------

    deal() {
      if (!this.canDeal()) return false;
      const s = this.s;
      s.justShuffled = false;
      if (s.shoe.length < s.shoeSize * this.rules.reshuffleAt) {
        s.shoe = buildShoe(this.rules.decks, this.rng);
        s.shoeSize = s.shoe.length;
        s.justShuffled = true;
      }
      s.round++;
      s.result = null;
      s.insurance = 0;
      s.lastBet = s.bet;
      s.hands = [newHand(s.bet)];
      s.bet = 0;
      s.dealer = [];
      s.active = 0;
      s.holeHidden = true;

      // Casino order: player, dealer up-card, player, dealer hole card.
      const h = s.hands[0];
      h.cards.push(this.draw());
      s.dealer.push(this.draw());
      h.cards.push(this.draw());
      s.dealer.push(this.draw());

      // Insurance is offered when the dealer shows an ace and it's affordable.
      if (s.dealer[0].rank === 'A' && s.bankroll >= h.bet / 2) s.phase = 'insurance';
      else this._peek();
      return true;
    }

    /** Insurance is a side bet of half the main bet; it pays 2:1 if the dealer has blackjack. */
    insuranceCost() { return this.s.hands.length ? this.s.hands[0].bet / 2 : 0; }

    takeInsurance(take) {
      const s = this.s;
      if (s.phase !== 'insurance') return false;
      if (take) {
        const cost = this.insuranceCost();
        s.bankroll -= cost;
        s.insurance = cost;
      }
      this._peek();
      return true;
    }

    /**
     * US hole-card rule: with an ace or ten-value card showing, the dealer
     * checks for blackjack before the player acts, so a dealer natural ends
     * the round at once and the player never puts double/split money on it.
     * A player natural also ends the round at once (pays 3:2, or pushes
     * against a dealer natural).
     */
    _peek() {
      const s = this.s;
      const upVal = cardValue(s.dealer[0].rank);
      const dealerBJ = (upVal === 1 || upVal === 10) && isNatural(s.dealer);
      if (dealerBJ || isNatural(s.hands[0].cards)) {
        this._settle();
        return;
      }
      s.phase = 'player';
    }

    // --- player actions ----------------------------------------------------

    canHit() { return this.s.phase === 'player' && !!this.hand && !this.hand.done; }
    canStand() { return this.canHit(); }

    canDouble() {
      const h = this.hand;
      return this.canHit() && h.cards.length === 2 && !h.splitAces && this.s.bankroll >= h.bet;
    }

    /** One split max: only when the round still has a single hand. */
    canSplit() {
      const s = this.s;
      const h = this.hand;
      return this.canHit() && s.hands.length === 1 && h.cards.length === 2 &&
        cardValue(h.cards[0].rank) === cardValue(h.cards[1].rank) && s.bankroll >= h.bet;
    }

    hit() {
      if (!this.canHit()) return false;
      const h = this.hand;
      h.cards.push(this.draw());
      if (handValue(h.cards).total >= 21) this._nextHand();   // bust or 21: auto-stand
      return true;
    }

    stand() {
      if (!this.canStand()) return false;
      this._nextHand();
      return true;
    }

    double() {
      if (!this.canDouble()) return false;
      const h = this.hand;
      this.s.bankroll -= h.bet;
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(this.draw());       // exactly one card, then the hand is finished
      this._nextHand();
      return true;
    }

    /**
     * Split a pair into two hands, each with the original bet.
     *
     * - The first hand gets its second card now. The second hand gets its
     *   second card when play reaches it (see _nextHand), as at a real table.
     * - Split aces get ONE card each and both hands finish immediately; an
     *   ace + ten here is 21, not blackjack.
     * - Re-splitting is not allowed (canSplit requires a single hand). Doubling
     *   after a split is allowed, except on split aces.
     */
    split() {
      if (!this.canSplit()) return false;
      const s = this.s;
      const orig = this.hand;
      const aces = orig.cards[0].rank === 'A';
      const h1 = newHand(orig.bet, { split: true, splitAces: aces, cards: [orig.cards[0]] });
      const h2 = newHand(orig.bet, { split: true, splitAces: aces, cards: [orig.cards[1]] });
      s.bankroll -= orig.bet;
      s.hands = [h1, h2];
      s.active = 0;

      h1.cards.push(this.draw());
      if (aces) {
        h2.cards.push(this.draw());
        h1.done = h2.done = true;
        this._finishPlayer();
        return true;
      }
      if (handValue(h1.cards).total === 21) this._nextHand();
      return true;
    }

    /** Finish the active hand and move to the next one that still needs a decision. */
    _nextHand() {
      const s = this.s;
      s.hands[s.active].done = true;
      while (s.active < s.hands.length - 1) {
        s.active++;
        const h = s.hands[s.active];
        if (h.cards.length < 2) h.cards.push(this.draw());   // second card for a split hand
        if (handValue(h.cards).total < 21) return;            // player acts on this one
        h.done = true;                                        // 21: nothing to decide
      }
      this._finishPlayer();
    }

    _finishPlayer() {
      const s = this.s;
      s.holeHidden = false;
      // If every hand busted the dealer doesn't draw: the bets are already lost.
      if (s.hands.every((h) => handValue(h.cards).bust)) this._settle();
      else s.phase = 'dealer';
    }

    // --- dealer ------------------------------------------------------------

    /**
     * Take one dealer card. Returns true if a card was drawn and false once the
     * dealer stands, at which point the round is settled. The UI calls this in
     * a loop with pauses so each dealer card can be animated.
     */
    dealerStep() {
      if (this.s.phase !== 'dealer') return false;
      if (dealerShouldHit(this.s.dealer)) {
        this.s.dealer.push(this.draw());
        return true;
      }
      this._settle();
      return false;
    }

    playDealer() { while (this.dealerStep()); }

    // --- settlement --------------------------------------------------------

    _settle() {
      const s = this.s;
      s.holeHidden = false;
      const d = handValue(s.dealer);
      const dealerBJ = isNatural(s.dealer);

      let wagered = s.insurance;
      let returned = 0;
      const insuranceReturn = s.insurance && dealerBJ ? s.insurance * (1 + this.rules.insurancePays) : 0;
      returned += insuranceReturn;

      for (const h of s.hands) {
        const v = handValue(h.cards);
        const natural = isNatural(h.cards, h.split);
        let r;
        if (v.bust) r = 'bust';
        else if (natural && dealerBJ) r = 'push';
        else if (natural) r = 'blackjack';
        else if (dealerBJ) r = 'lose';
        else if (d.bust || v.total > d.total) r = 'win';
        else if (v.total < d.total) r = 'lose';
        else r = 'push';

        h.result = r;
        h.done = true;
        h.payout = r === 'blackjack' ? h.bet * (1 + this.rules.blackjackPays)
          : r === 'win' ? h.bet * 2
          : r === 'push' ? h.bet
          : 0;
        wagered += h.bet;
        returned += h.payout;
      }

      s.bankroll += returned;
      const net = returned - wagered;
      s.result = {
        round: s.round, net, wagered, returned, insuranceReturn,
        dealerBJ, dealerBust: d.bust, dealerTotal: d.total,
      };
      s.phase = 'betting';
      this._recordStats(net);
    }

    _recordStats(net) {
      const st = this.s.stats;
      st.rounds++;
      st.net += net;
      for (const h of this.s.hands) {
        st.hands++;
        if (h.result === 'win' || h.result === 'blackjack') st.wins++;
        else if (h.result === 'push') st.pushes++;
        else st.losses++;
        if (h.result === 'blackjack') st.blackjacks++;
      }
      if (net > 0) {
        st.streak = st.streak > 0 ? st.streak + 1 : 1;
        st.biggestWin = Math.max(st.biggestWin, net);
      } else if (net < 0) {
        st.streak = st.streak < 0 ? st.streak - 1 : -1;
      } // a push leaves the streak alone
      st.bestStreak = Math.max(st.bestStreak, st.streak);
    }
  }

  return {
    SUITS, RANKS, RULES,
    cardValue, isRed, buildShoe, handValue, isNatural, describeHand,
    dealerShouldHit, basicStrategy, Game,
  };
});
