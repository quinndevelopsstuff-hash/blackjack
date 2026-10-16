/*
 * game.js — UI layer: rendering, animation, input, sound and persistence.
 *
 * The rules and money math are all in engine.js. This file calls engine
 * methods (game.hit(), game.split(), ...) and then render() reconciles the
 * DOM with `game.s`: cards that are new slide out of the shoe, cards that
 * moved (e.g. on a split) glide to their new spot, and the hole card flips.
 */
(() => {
  'use strict';

  const { Game, RULES, handValue, describeHand, isNatural, isRed, basicStrategy, cardValue } = window.BJ;

  const STORAGE_KEY = 'blackjack.save.v1';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const T = (ms) => (reduceMotion ? 0 : ms);
  const DEAL_GAP = T(230);   // ms between consecutive cards in one deal
  const SLIDE_MS = T(420);   // card travel time from the shoe
  const FLIP_MS = T(520);
  const MOVE_MS = T(360);
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const VS15 = '︎';     // forces text glyphs for ♥ ♦ (iOS otherwise draws emoji)

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmt(n) {
    const abs = Math.abs(n);
    const str = abs.toLocaleString('en-US', {
      minimumFractionDigits: abs % 1 ? 2 : 0,
      maximumFractionDigits: 2,
    });
    return (n < 0 ? '−$' : '$') + str;
  }

  // ------------------------------------------------------------ persistence

  function loadSave() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; } catch { return null; }
  }
  const saved = loadSave();
  const prefs = { hints: false, muted: false, ...(saved && saved.prefs) };
  const game = new Game({ state: saved && saved.game });

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ game: game.serialize(), prefs }));
    } catch { /* private mode or storage full: play on without saving */ }
  }

  // ------------------------------------------------------------------ sound

  /** Tiny Web Audio synth; every sound is generated, no files. */
  const Sound = (() => {
    let ctx = null;
    let noiseBuf = null;

    function ac() {
      if (prefs.muted) return null;
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(freq, dur, { type = 'sine', gain = 0.12, delay = 0 } = {}) {
      const c = ac();
      if (!c) return;
      const t = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.03);
    }

    function noise(dur, { freq = 2500, q = 1, gain = 0.2, delay = 0 } = {}) {
      const c = ac();
      if (!c) return;
      if (!noiseBuf) {
        noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.4), c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t = c.currentTime + delay;
      const src = c.createBufferSource();
      src.buffer = noiseBuf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(c.destination);
      src.start(t);
      src.stop(t + dur + 0.02);
    }

    const arp = (notes, opts, gap) => notes.forEach((f, i) => tone(f, opts.dur, { ...opts, delay: i * gap }));

    return {
      deal: () => noise(0.09, { freq: 3400, q: 0.7, gain: 0.28 }),
      flip: () => { noise(0.05, { freq: 1700, gain: 0.22 }); noise(0.06, { freq: 2800, gain: 0.16, delay: 0.09 }); },
      chip: () => { tone(2500, 0.05, { type: 'triangle', gain: 0.07 }); tone(3400, 0.06, { type: 'triangle', gain: 0.05, delay: 0.035 }); },
      shuffle: () => { for (let i = 0; i < 12; i++) noise(0.05, { freq: 1800 + Math.random() * 2400, gain: 0.13, delay: i * 0.055 }); },
      win: () => arp([523.25, 659.25, 783.99], { dur: 0.22, type: 'triangle', gain: 0.11 }, 0.09),
      blackjack: () => arp([523.25, 659.25, 783.99, 1046.5, 1318.5], { dur: 0.3, type: 'triangle', gain: 0.11 }, 0.08),
      lose: () => arp([392, 311.13, 261.63], { dur: 0.28, type: 'sawtooth', gain: 0.04 }, 0.13),
      push: () => arp([440, 440], { dur: 0.14, type: 'triangle', gain: 0.09 }, 0.17),
    };
  })();

  // ------------------------------------------------------------ DOM handles

  const el = {
    table: $('#table'),
    shoe: $('#shoe'),
    shoeFill: $('#shoe-fill'),
    discard: $('#discard'),
    dealerCards: $('#dealer-cards'),
    dealerTotal: $('#dealer-total'),
    hands: $('#hands'),
    betSpot: $('#bet-spot'),
    betStack: $('#bet-stack'),
    betSpotLabel: $('#bet-spot-label'),
    balance: $('#balance'),
    bet: $('#bet'),
    banner: $('#banner'),
    bannerTitle: $('#banner-title'),
    bannerSub: $('#banner-sub'),
    toast: $('#toast'),
    hint: $('#hint'),
    ctlBet: $('#ctl-bet'),
    ctlPlay: $('#ctl-play'),
    ctlIns: $('#ctl-ins'),
    insQ: $('#ins-q'),
    chips: [...document.querySelectorAll('[data-chip]')],
    clear: $('#btn-clear'),
    rebet: $('#btn-rebet'),
    deal: $('#btn-deal'),
    rebuy: $('#btn-rebuy'),
    hit: $('#btn-hit'),
    stand: $('#btn-stand'),
    double: $('#btn-double'),
    split: $('#btn-split'),
    insYes: $('#btn-ins-yes'),
    insNo: $('#btn-ins-no'),
    btnHint: $('#btn-hint'),
    btnStats: $('#btn-stats'),
    btnMute: $('#btn-mute'),
    statsModal: $('#stats-modal'),
    statsGrid: $('#stats-grid'),
    statsClose: $('#btn-stats-close'),
    resetStats: $('#btn-reset-stats'),
  };

  // --------------------------------------------------------------- UI state

  let busy = false;                                     // true while a round animates; blocks input
  let shownRound = game.s.result ? game.s.result.round : 0;  // last round whose result was presented
  const cardEls = new Map();                            // card.seq → DOM node

  /** A settled round whose banner/chip payout hasn't been shown yet. */
  function pendingResult() {
    const r = game.s.result;
    return r && r.round !== shownRound ? r : null;
  }

  /** Money currently sitting on the felt. */
  function tableStake() {
    const s = game.s;
    if (s.phase !== 'betting') return s.hands.reduce((a, h) => a + h.bet, 0) + s.insurance;
    const r = pendingResult();
    return r ? r.wagered : s.bet;
  }

  // ------------------------------------------------------------------ cards

  const RANK_NAMES = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
  const SUIT_NAMES = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };

  function makeCard(card, faceDown) {
    const node = document.createElement('div');
    node.className = 'card' + (faceDown ? ' facedown' : '');
    node.dataset.seq = card.seq;
    node.setAttribute('role', 'img');
    node.innerHTML = '<div class="card-inner"><div class="card-face card-front"></div><div class="card-face card-back"></div></div>';
    // A face-down card's front stays empty until it's revealed.
    if (faceDown) node.setAttribute('aria-label', 'Face-down card');
    else paintFront(node, card);
    return node;
  }

  function paintFront(node, card) {
    const suit = card.suit + VS15;
    const face = card.rank === 'J' || card.rank === 'Q' || card.rank === 'K';
    node.classList.toggle('red', isRed(card));
    node.classList.toggle('face', face);
    node.classList.toggle('ace', card.rank === 'A');
    const corner = `<span class="r">${card.rank}</span><span class="s">${suit}</span>`;
    const center = face ? `<span>${card.rank}<small>${suit}</small></span>` : suit;
    node.querySelector('.card-front').innerHTML =
      `<div class="corner tl">${corner}</div><div class="pip">${center}</div><div class="corner br">${corner}</div>`;
    node.setAttribute('aria-label', `${RANK_NAMES[card.rank] || card.rank} of ${SUIT_NAMES[card.suit]}`);
  }

  function reveal({ node, card }, instant = false) {
    paintFront(node, card);
    if (instant) {
      node.classList.add('no-anim');
      node.classList.remove('facedown');
      void node.offsetWidth;
      node.classList.remove('no-anim');
    } else {
      node.classList.remove('facedown');
    }
  }

  function makeHandEl() {
    const n = document.createElement('div');
    n.className = 'hand';
    n.innerHTML = '<div class="cards"></div><div class="hand-info"><span class="total"></span><span class="hand-bet"></span></div><div class="hand-result"></div>';
    return n;
  }

  /**
   * Make `container` hold exactly `cards`, in order, reusing existing nodes
   * (even ones currently in another container, which is how a split card
   * moves to the new hand). New nodes go into `fresh`; cards that must turn
   * face up go into `flips`.
   */
  function syncCards(container, cards, { hiddenAt = -1, isDealer = false, instant }, fresh, flips) {
    const keep = new Set();
    cards.forEach((card, i) => {
      keep.add(String(card.seq));
      const hidden = i === hiddenAt;
      let node = cardEls.get(card.seq);
      if (!node) {
        // The dealer's hole card always lands face down. If it's already meant
        // to be visible (the round ended on the deal), it flips after landing.
        const arriveDown = hidden || (isDealer && i === 1 && !instant);
        node = makeCard(card, arriveDown);
        cardEls.set(card.seq, node);
        if (!instant) fresh.push({ node, seq: card.seq });
        if (arriveDown && !hidden) flips.push({ node, card });
      } else if (!hidden && node.classList.contains('facedown')) {
        flips.push({ node, card });
      }
      const at = container.children[i];
      if (at !== node) container.insertBefore(node, at || null);
    });
    for (const child of [...container.children]) if (!keep.has(child.dataset.seq)) child.remove();
  }

  function slideFromShoe(node, shoeRect, delay) {
    const r = node.getBoundingClientRect();
    const dx = shoeRect.left + shoeRect.width / 2 - (r.left + r.width / 2);
    const dy = shoeRect.top + shoeRect.height / 2 - (r.top + r.height / 2);
    setTimeout(Sound.deal, delay);
    return node.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(-28deg) scale(0.7)`, opacity: 0.5 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: SLIDE_MS, delay, easing: EASE, fill: 'backwards' },
    ).finished.catch(() => {});
  }

  // ----------------------------------------------------------------- render

  /**
   * Bring the DOM in line with game.s. Returns a promise that resolves when
   * every card animation (deal, move, flip) has finished.
   */
  function render({ instant = false } = {}) {
    const s = game.s;

    // FLIP step 1: remember where every card is right now.
    const before = new Map();
    if (!instant) for (const [k, n] of cardEls) if (n.isConnected) before.set(k, n.getBoundingClientRect());

    const fresh = [];
    const flips = [];
    syncCards(el.dealerCards, s.dealer, { hiddenAt: s.holeHidden ? 1 : -1, isDealer: true, instant }, fresh, flips);

    const count = Math.max(1, s.hands.length);
    while (el.hands.children.length > count) el.hands.lastElementChild.remove();
    while (el.hands.children.length < count) el.hands.appendChild(makeHandEl());
    el.hands.classList.toggle('split', s.hands.length > 1);
    [...el.hands.children].forEach((node, i) => {
      const h = s.hands[i];
      syncCards(node.querySelector('.cards'), h ? h.cards : [], { instant }, fresh, flips);
    });
    for (const [k, n] of cardEls) if (!n.isConnected) cardEls.delete(k);

    updateHandsMeta();
    updateHud();
    updateControls();
    updateHint();

    if (instant) {
      flips.forEach((f) => reveal(f, true));
      updateTotals();
      return Promise.resolve();
    }

    // FLIP step 2: cards that already existed glide from old to new position.
    let moved = false;
    for (const [k, r0] of before) {
      const n = cardEls.get(k);
      if (!n) continue;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left;
      const dy = r0.top - r1.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      moved = true;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: EASE });
    }

    // New cards come out of the shoe in the order they were dealt.
    fresh.sort((a, b) => a.seq - b.seq);
    const shoeRect = el.shoe.getBoundingClientRect();
    fresh.forEach((f, i) => slideFromShoe(f.node, shoeRect, i * DEAL_GAP));
    const landed = Math.max(
      fresh.length ? (fresh.length - 1) * DEAL_GAP + SLIDE_MS : 0,
      moved ? MOVE_MS : 0,
    );

    return (async () => {
      await sleep(landed);
      if (flips.length) {
        flips.forEach((f) => reveal(f));
        Sound.flip();
        await sleep(FLIP_MS);
      }
      // Totals update after the cards are visible, so the dealer's total
      // never gives away the hole card before it flips.
      updateTotals();
    })();
  }

  function setTotal(node, cards, fromSplit) {
    const v = handValue(cards);
    const natural = isNatural(cards, fromSplit);
    node.textContent = describeHand(cards, fromSplit);
    node.classList.toggle('is-bust', cards.length > 0 && v.bust);
    node.classList.toggle('is-bj', natural);
    node.classList.toggle('is-21', !natural && v.total === 21);
  }

  function updateTotals() {
    const s = game.s;
    setTotal(el.dealerTotal, s.holeHidden ? s.dealer.slice(0, 1) : s.dealer, false);
    [...el.hands.children].forEach((node, i) => {
      const h = s.hands[i];
      setTotal(node.querySelector('.total'), h ? h.cards : [], !!(h && h.split));
    });
  }

  const RESULT_LABEL = { win: 'Win', blackjack: 'Blackjack', lose: 'Lose', bust: 'Bust', push: 'Push' };

  function updateHandsMeta() {
    const s = game.s;
    const multi = s.hands.length > 1;
    const resultShown = s.result && s.result.round === shownRound;
    [...el.hands.children].forEach((node, i) => {
      const h = s.hands[i];
      node.classList.toggle('active', !!h && multi && s.phase === 'player' && i === s.active);
      node.classList.toggle('waiting', !!h && multi && s.phase === 'player' && i !== s.active);
      node.querySelector('.hand-bet').innerHTML =
        h && (multi || h.doubled) ? `${fmt(h.bet)}${h.doubled ? ' <span class="tag">2×</span>' : ''}` : '';
      const res = node.querySelector('.hand-result');
      if (h && h.result && resultShown && multi) {
        res.className = `hand-result ${h.result} show`;
        res.textContent = RESULT_LABEL[h.result];
      } else {
        res.className = 'hand-result';
      }
    });
  }

  // ------------------------------------------------------- balance & chips

  let shownBalance = null;
  let balanceTween = 0;

  function setBalance(v, animate = false) {
    if (v === shownBalance) return;
    if (shownBalance === null || !animate || reduceMotion) {
      balanceTween++;
      shownBalance = v;
      el.balance.textContent = fmt(v);
      return;
    }
    const from = shownBalance;
    const start = performance.now();
    const id = ++balanceTween;
    shownBalance = v;
    const step = (now) => {
      if (id !== balanceTween) return;
      const t = Math.min(1, (now - start) / 650);
      const e = 1 - Math.pow(1 - t, 3);
      el.balance.textContent = t < 1 ? fmt(Math.round(from + (v - from) * e)) : fmt(v);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function chipsFor(amount) {
    const out = [];
    let left = amount;
    for (const v of [500, 100, 25, 5]) while (left >= v) { out.push(v); left -= v; }
    if (left > 0) out.push(5);            // half-dollar leftovers from 3:2 payouts
    return out;
  }

  let stackAmount = -1;
  function renderStack(amount) {
    el.betSpot.classList.toggle('has-bet', amount > 0);
    el.betSpotLabel.textContent = amount > 0 ? fmt(amount) : 'Place your bet';
    if (amount === stackAmount) return;
    stackAmount = amount;
    el.betStack.innerHTML = '';
    chipsFor(amount).slice(0, 10).forEach((v, i) => {
      const c = document.createElement('div');
      c.className = `chip chip-${v}`;
      c.style.setProperty('--i', i);
      c.innerHTML = `<span>${v}</span>`;
      el.betStack.appendChild(c);
    });
  }

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function flyChip(value, fromRect, toRect, delay = 0) {
    const size = 46;
    const a = center(fromRect);
    const b = center(toRect);
    const jx = (Math.random() - 0.5) * 14;
    const jy = (Math.random() - 0.5) * 8;
    const c = document.createElement('div');
    c.className = `chip chip-${value} flying`;
    c.innerHTML = `<span>${value}</span>`;
    c.style.left = `${a.x - size / 2}px`;
    c.style.top = `${a.y - size / 2}px`;
    document.body.appendChild(c);
    const dx = b.x - a.x + jx;
    const dy = b.y - a.y + jy;
    return c.animate(
      [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${dx / 2}px, ${dy / 2 - 36}px) scale(1.12)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.9)` },
      ],
      { duration: T(480), delay, easing: 'ease-in-out', fill: 'both' },
    ).finished.catch(() => {}).then(() => c.remove());
  }

  function flyChips(amount, fromRect, toRect) {
    const list = chipsFor(amount).slice(0, 6);
    return Promise.all(list.map((v, i) => flyChip(v, fromRect, toRect, i * T(70))));
  }

  const rect = (node) => node.getBoundingClientRect();

  // -------------------------------------------------------------------- HUD

  function updateHud({ stack = true } = {}) {
    const s = game.s;
    const r = pendingResult();
    // Until the payout animation runs, show the balance as it was before it.
    setBalance(r ? s.bankroll - r.returned : s.bankroll);
    const stake = tableStake();
    el.bet.textContent = fmt(stake);
    if (stack) renderStack(stake);
    el.shoeFill.style.width = `${(100 * s.shoe.length) / s.shoeSize}%`;
    el.shoe.title = `${s.shoe.length} of ${s.shoeSize} cards left · reshuffle at the red line`;
  }

  function updateControls() {
    const s = game.s;
    const ph = s.phase;
    el.ctlBet.hidden = ph !== 'betting';
    el.ctlIns.hidden = ph !== 'insurance';
    el.ctlPlay.hidden = !(ph === 'player' || ph === 'dealer');

    el.chips.forEach((b) => { b.disabled = busy || !game.canAddChip(Number(b.dataset.chip)); });
    const broke = game.canRebuy();
    el.rebuy.hidden = !broke;
    el.clear.hidden = broke;
    el.deal.hidden = broke;
    el.rebet.hidden = broke || !s.lastBet;
    el.clear.disabled = busy || !s.bet;
    el.deal.disabled = busy || !game.canDeal();
    el.rebet.disabled = busy || !game.canRebet();
    el.rebet.innerHTML = `Rebet ${fmt(s.lastBet)} <kbd>R</kbd>`;
    el.rebuy.disabled = busy;

    const can = !busy && ph === 'player';
    el.hit.disabled = !(can && game.canHit());
    el.stand.disabled = !(can && game.canStand());
    el.double.disabled = !(can && game.canDouble());
    el.split.disabled = !(can && game.canSplit());

    el.insYes.disabled = el.insNo.disabled = busy;
    if (ph === 'insurance') {
      const cost = fmt(game.insuranceCost());
      el.insQ.innerHTML = isNatural(s.hands[0].cards)
        ? `You have blackjack. Take <b>even money</b>? (costs ${cost})`
        : `Dealer shows an Ace. Insurance for <b>${cost}</b>?`;
    }
  }

  // ------------------------------------------------------------------ hints

  const ACTION_NAME = { H: 'Hit', S: 'Stand', D: 'Double down', P: 'Split' };

  function hintHandLabel(cards, canSplit) {
    if (canSplit) {
      const v = cardValue(cards[0].rank);
      return `Pair of ${v === 1 ? 'Aces' : v === 10 ? 'tens' : `${cards[0].rank}s`}`;
    }
    const v = handValue(cards);
    return `${v.soft ? 'Soft' : 'Hard'} ${v.total}`;
  }

  function updateHint() {
    const s = game.s;
    el.btnHint.setAttribute('aria-pressed', String(prefs.hints));
    [el.hit, el.stand, el.double, el.split, el.insNo].forEach((b) => b.classList.remove('hinted'));
    el.hint.hidden = !prefs.hints;
    if (!prefs.hints) return;

    if (s.phase === 'player' && !busy) {
      const h = game.hand;
      const canSplit = game.canSplit();
      const code = basicStrategy(h.cards, s.dealer[0], { canDouble: game.canDouble(), canSplit });
      ({ H: el.hit, S: el.stand, D: el.double, P: el.split })[code].classList.add('hinted');
      const up = s.dealer[0].rank === 'A' ? 'Ace' : cardValue(s.dealer[0].rank);
      el.hint.innerHTML = `Basic strategy: <b>${ACTION_NAME[code]}</b> · ${hintHandLabel(h.cards, canSplit)} vs dealer ${up}`;
    } else if (s.phase === 'insurance' && !busy) {
      el.insNo.classList.add('hinted');
      el.hint.innerHTML = 'Basic strategy: <b>decline insurance</b> · it\'s a side bet that loses money in the long run';
    } else if (s.phase === 'betting') {
      el.hint.textContent = 'Hints are on: the optimal move is highlighted during each hand.';
    } else {
      el.hint.textContent = s.phase === 'dealer' ? 'Dealer’s turn…' : '…';
    }
  }

  // ----------------------------------------------------- banner and toasts

  let bannerToken = 0;
  function showBanner(kind, title, sub) {
    bannerToken++;
    el.banner.className = `banner ${kind}`;
    el.bannerTitle.textContent = title;
    el.bannerSub.innerHTML = sub;
    el.banner.hidden = false;
  }
  function hideBanner() {
    if (el.banner.hidden) return;
    const token = ++bannerToken;
    el.banner.classList.add('out');
    setTimeout(() => { if (token === bannerToken) el.banner.hidden = true; }, T(250));
  }

  let toastTimer = 0;
  function toast(msg, ms = 1600) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function summarize() {
    const s = game.s;
    const r = s.result;
    const net = r.net;
    const parts = [net > 0 ? `<b>+${fmt(net)}</b>` : net < 0 ? `<b>${fmt(net)}</b>` : 'Bet returned'];
    let kind;
    let title;

    if (s.hands.length === 1) {
      const h = s.hands[0];
      kind = { blackjack: 'bj', win: 'win', lose: 'lose', bust: 'lose', push: 'push' }[h.result];
      title = {
        blackjack: 'Blackjack!',
        win: r.dealerBust ? 'Dealer Busts!' : 'You Win!',
        lose: r.dealerBJ ? 'Dealer Blackjack' : 'Dealer Wins',
        bust: 'Bust!',
        push: r.dealerBJ ? 'Both Blackjack · Push' : 'Push',
      }[h.result];
      if (r.insuranceReturn) {
        title = h.result === 'push' ? 'Even Money!' : 'Insurance Pays';
        kind = net > 0 ? 'win' : 'push';
      }
      if (!r.dealerBJ && (h.result === 'win' || h.result === 'lose' || h.result === 'push')) {
        parts.push(`${handValue(h.cards).total} vs ${r.dealerBust ? `dealer bust (${r.dealerTotal})` : r.dealerTotal}`);
      }
    } else {
      kind = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
      const allPush = s.hands.every((h) => h.result === 'push');
      title = net > 0 ? 'You Win!' : net < 0 ? 'Dealer Wins' : allPush ? 'Push' : 'Break Even';
      parts.push(s.hands.map((h, i) => `Hand ${i + 1}: ${RESULT_LABEL[h.result]}`).join(' · '));
    }
    if (s.insurance) parts.push(r.insuranceReturn ? 'Insurance paid 2:1' : 'Insurance lost');
    return { kind, title, sub: parts.join(' · ') };
  }

  async function showResult() {
    const r = pendingResult();
    if (!r) return;
    const s = game.s;
    const { kind, title, sub } = summarize();
    shownRound = r.round;
    showBanner(kind, title, sub);
    ({ bj: Sound.blackjack, win: Sound.win, lose: Sound.lose, push: Sound.push })[kind]();
    updateHandsMeta();

    // Chips: losses go to the dealer, winnings come from the dealer, and
    // whatever is left on the spot is swept back to the balance.
    await sleep(T(450));
    const spot = rect(el.betSpot);
    const house = rect(el.dealerCards);
    if (r.net < 0) {
      renderStack(r.returned);
      await flyChips(-r.net, spot, house);
    } else if (r.net > 0) {
      await flyChips(r.net, house, spot);
      renderStack(r.returned);
      await sleep(T(200));
    }
    if (r.returned > 0) {
      renderStack(0);
      Sound.chip();
      setBalance(s.bankroll, true);
      await flyChips(r.returned, spot, rect(el.balance));
    }
    updateHud();
  }

  async function showShuffle() {
    toast('Shuffling a fresh 6-deck shoe…', 1400);
    el.shoe.classList.add('shuffling');
    Sound.shuffle();
    await sleep(T(900));
    el.shoe.classList.remove('shuffling');
  }

  /** Sweep the previous round's cards to the discard tray. */
  async function clearTable() {
    hideBanner();
    const nodes = [...cardEls.values()].filter((n) => n.isConnected);
    if (nodes.length) {
      const d = rect(el.discard);
      await Promise.all(nodes.map((n, i) => {
        const r = rect(n);
        const dx = d.left - r.left;
        const dy = d.top - r.top;
        return n.animate(
          [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) rotate(${-25 + Math.random() * 12}deg) scale(0.6)`, opacity: 0 }],
          { duration: T(380), delay: i * T(25), easing: 'ease-in', fill: 'forwards' },
        ).finished.catch(() => {});
      }));
    }
    cardEls.clear();
    el.dealerCards.innerHTML = '';
    el.hands.innerHTML = '';
    el.dealerTotal.textContent = '';
  }

  // ------------------------------------------------------------------ flows

  async function playDealer() {
    await sleep(T(300));
    while (game.dealerStep()) {
      persist();
      await render();
      await sleep(T(260));
    }
    persist();
    await render();
  }

  /**
   * Run one player action through the engine and play out its consequences:
   * animate, let the dealer play if it's their turn, present the result.
   * `step` returns false if the engine refused the action.
   */
  async function flow(step) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      const stakeBefore = tableStake();
      if ((await step()) === false) return;
      persist();
      const added = tableStake() - stakeBefore;
      if (added > 0 && game.s.phase !== 'betting') flyChips(added, rect(el.balance), rect(el.betSpot));
      await render();
      if (game.s.phase === 'dealer') await playDealer();
      await showResult();
    } finally {
      busy = false;
      persist();
      updateHud();
      updateControls();
      updateHint();
    }
  }

  const doHit = () => flow(() => game.hit());
  const doStand = () => flow(() => game.stand());
  const doDouble = () => flow(() => game.double());
  const doSplit = () => flow(() => game.split());
  const doInsurance = (take) => flow(() => game.takeInsurance(take));

  const doDeal = () => flow(async () => {
    if (!game.canDeal() && !game.rebet()) return false;   // Enter with no bet = rebet
    await clearTable();
    game.deal();
    updateHud();
    if (game.s.justShuffled) await showShuffle();
    return true;
  });

  function onChip(value) {
    if (busy || !game.addChip(value)) return;
    const btn = el.chips.find((b) => Number(b.dataset.chip) === value);
    Sound.chip();
    hideBanner();
    persist();
    updateHud({ stack: false });
    updateControls();
    flyChip(value, rect(btn), rect(el.betSpot)).then(() => renderStack(tableStake()));
  }

  function onClear() {
    if (busy) return;
    const amount = game.s.bet;
    if (!game.clearBet()) return;
    Sound.chip();
    flyChips(amount, rect(el.betSpot), rect(el.balance));
    persist();
    updateHud();
    updateControls();
  }

  function onRebet() {
    if (busy || !game.rebet()) return;
    Sound.chip();
    hideBanner();
    persist();
    updateHud({ stack: false });
    updateControls();
    flyChips(game.s.bet, rect(el.balance), rect(el.betSpot)).then(() => renderStack(tableStake()));
  }

  function onRebuy() {
    if (busy || !game.rebuy()) return;
    Sound.chip();
    hideBanner();
    toast(`Rebought ${fmt(RULES.startingBankroll)} in chips`);
    persist();
    setBalance(game.s.bankroll, true);
    updateControls();
  }

  // ------------------------------------------------------------- stats & prefs

  function renderStats() {
    const st = game.s.stats;
    const pct = st.hands ? `${((100 * st.wins) / st.hands).toFixed(1)}%` : '—';
    const streak = st.streak > 0 ? `${st.streak} win${st.streak > 1 ? 's' : ''}`
      : st.streak < 0 ? `${-st.streak} loss${st.streak < -1 ? 'es' : ''}` : '—';
    const rows = [
      ['Hands played', st.hands],
      ['Win rate', pct],
      ['Biggest win', st.biggestWin ? fmt(st.biggestWin) : '—', st.biggestWin ? 'pos' : ''],
      ['Current streak', streak, st.streak > 0 ? 'pos' : st.streak < 0 ? 'neg' : ''],
      ['Won / Lost / Push', `${st.wins} / ${st.losses} / ${st.pushes}`],
      ['Blackjacks', st.blackjacks],
      ['Best win streak', st.bestStreak || '—'],
      ['Net result', fmt(st.net), st.net > 0 ? 'pos' : st.net < 0 ? 'neg' : ''],
    ];
    if (st.rebuys) rows.push(['Rebuys', st.rebuys]);
    el.statsGrid.innerHTML = rows.map(([k, v, cls = '']) => `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`).join('');
  }

  function openStats() {
    renderStats();
    el.statsModal.hidden = false;
    el.statsClose.focus();
  }
  function closeStats() {
    el.statsModal.hidden = true;
    el.btnStats.focus();
  }

  function updateMute() { el.btnMute.setAttribute('aria-pressed', String(prefs.muted)); }
  function toggleMute() {
    prefs.muted = !prefs.muted;
    updateMute();
    persist();
    if (!prefs.muted) Sound.chip();
  }
  function toggleHints() {
    prefs.hints = !prefs.hints;
    persist();
    updateHint();
  }

  // ------------------------------------------------------------------ input

  el.chips.forEach((b) => b.addEventListener('click', () => onChip(Number(b.dataset.chip))));
  el.clear.addEventListener('click', onClear);
  el.rebet.addEventListener('click', onRebet);
  el.deal.addEventListener('click', doDeal);
  el.rebuy.addEventListener('click', onRebuy);
  el.hit.addEventListener('click', doHit);
  el.stand.addEventListener('click', doStand);
  el.double.addEventListener('click', doDouble);
  el.split.addEventListener('click', doSplit);
  el.insYes.addEventListener('click', () => doInsurance(true));
  el.insNo.addEventListener('click', () => doInsurance(false));
  el.btnHint.addEventListener('click', toggleHints);
  el.btnMute.addEventListener('click', toggleMute);
  el.btnStats.addEventListener('click', openStats);
  el.statsClose.addEventListener('click', closeStats);
  el.statsModal.addEventListener('click', (e) => { if (e.target === el.statsModal) closeStats(); });
  el.resetStats.addEventListener('click', () => {
    if (!window.confirm('Reset all stats? Your balance is kept.')) return;
    game.resetStats();
    persist();
    renderStats();
  });

  // A mouse/touch click shouldn't leave focus on the button, or a later Enter
  // would press it again (e.g. add another chip) instead of dealing.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (!el.statsModal.hidden) {
      if (e.key === 'Escape') closeStats();
      return;
    }
    const k = e.key.toLowerCase();
    // Enter/Space on a focused button should just press that button.
    if ((k === 'enter' || k === ' ') && e.target instanceof HTMLButtonElement) return;
    const ph = game.s.phase;
    switch (k) {
      case 'h': doHit(); break;
      case 's': doStand(); break;
      case 'd': doDouble(); break;
      case 'p': doSplit(); break;
      case 'y': if (ph === 'insurance') doInsurance(true); break;
      case 'n': if (ph === 'insurance') doInsurance(false); break;
      case 'enter':
      case ' ':
        if (ph === 'betting') doDeal();
        break;
      case 'r': onRebet(); break;
      case 'c': onClear(); break;
      case '1': case '2': case '3': case '4':
        onChip(RULES.chips[Number(k) - 1]);
        break;
      case 'm': toggleMute(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ------------------------------------------------------------------- boot

  updateMute();
  render({ instant: true });
  // If the page was reloaded mid-round, pick up where it left off.
  if (game.s.phase === 'dealer') flow(() => true);
  persist();

  // Exposed for poking around in the console.
  window.blackjack = { game, render, isBusy: () => busy };
})();
