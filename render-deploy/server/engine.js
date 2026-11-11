// 炸金花规则引擎：纯逻辑，不碰网络与存储，可单测。
// 牌点：2..14（11=J，12=Q，13=K，14=A）；花色 0..3，不比大小。
'use strict';

const SUIT_NAMES = ['♠', '♥', '♣', '♦'];
const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function rankName(r) { return RANK_NAMES[r] || String(r); }
function cardName(c) { return rankName(c.rank) + SUIT_NAMES[c.suit]; }

function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  return d;
}

function shuffle(deck, rand) {
  rand = rand || Math.random;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

// 顺子判定：返回顺子最大牌点数；A23 算 3（最小），QKA 算 14（最大）；非顺子返回 0
function straightHigh(ranks) {
  const u = Array.from(new Set(ranks)).sort((a, b) => a - b);
  if (u.length !== 3) return 0;
  if (u[0] === 2 && u[1] === 3 && u[2] === 14) return 3; // A23
  if (u[2] - u[0] === 2 && u[1] - u[0] === 1) return u[2];
  return 0;
}

function straightText(sh) {
  if (sh === 3) return 'A23';
  if (sh === 14) return 'QKA';
  return rankName(sh - 2) + rankName(sh - 1) + rankName(sh);
}

const CAT = { HIGH: 1, PAIR: 2, STRAIGHT: 3, FLUSH: 4, STRAIGHT_FLUSH: 5, TRIPS: 6 };
const CAT_NAME = { 1: '散牌', 2: '对子', 3: '顺子', 4: '金花', 5: '同花顺', 6: '豹子' };

// 评估 3 张牌：返回 {cat, tb, name, text}，tb 为从大到小比牌依据
function evaluate(cards) {
  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);
  const flush = suits[0] === suits[1] && suits[1] === suits[2];
  const sh = straightHigh(ranks);
  const sortedDesc = ranks.slice().sort((a, b) => b - a);
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return { cat: CAT.TRIPS, tb: [ranks[0]], name: '豹子', text: '豹子' + rankName(ranks[0]) };
  }
  if (flush && sh) {
    return { cat: CAT.STRAIGHT_FLUSH, tb: [sh], name: '同花顺', text: '同花顺' + straightText(sh) };
  }
  if (flush) {
    return { cat: CAT.FLUSH, tb: sortedDesc, name: '金花', text: '金花' + sortedDesc.map(rankName).join('') };
  }
  if (sh) {
    return { cat: CAT.STRAIGHT, tb: [sh], name: '顺子', text: '顺子' + straightText(sh) };
  }
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const pairEntry = Object.entries(counts).find((entry) => entry[1] === 2);
  if (pairEntry) {
    const p = Number(pairEntry[0]);
    const kicker = ranks.find((r) => r !== p);
    return { cat: CAT.PAIR, tb: [p, kicker], name: '对子', text: '对子' + rankName(p) + '带' + rankName(kicker) };
  }
  return { cat: CAT.HIGH, tb: sortedDesc, name: '散牌', text: '散牌' + sortedDesc.map(rankName).join('') };
}

// 比较两手牌：>0 表示 a 大，<0 表示 b 大，0 平手
function compareEval(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.tb.length, b.tb.length);
  for (let i = 0; i < n; i++) {
    const d = (a.tb[i] || 0) - (b.tb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 一局对局：发牌、底分、下注轮次、比牌、摊牌结算。
// 约定：底分 base 每人先付；跟注基准 currentBet 从 base 起；
// 看过牌的人跟注/加注/比牌按双倍算；任何一次实际支付不超过 maxBet；
// 满 maxRounds 轮未结束则强制摊牌。
class Game {
  constructor(playerIds, opts) {
    opts = opts || {};
    this.base = opts.base || 10;
    this.maxBet = opts.maxBet || 1000;
    this.maxRounds = opts.maxRounds || 15;
    this.players = playerIds.map((id, i) => ({
      id, seat: i, cards: [], folded: false, seen: false,
      paid: 0, balance: opts.balances ? (opts.balances[id] || 0) : 0,
      startBalance: opts.balances ? (opts.balances[id] || 0) : 0, left: false,
    }));
    this.pot = 0;
    this.currentBet = this.base;
    this.round = 1;
    this.phase = 'dealing';
    this.turn = 0;
    this.winners = null;
    this.result = null;
    this.lastAction = null;
    this.actedThisRound = new Set();
    this.deck = opts.deck || shuffle(makeDeck(), opts.rand);
    this.deal();
  }

  deal() {
    for (let k = 0; k < 3; k++) {
      for (const p of this.players) p.cards.push(this.deck.shift());
    }
    for (const p of this.players) {
      const pay = Math.min(this.base, p.balance);
      p.balance -= pay; p.paid += pay; this.pot += pay;
    }
    this.phase = 'betting';
    this.turn = this.players.length > 1 ? 1 : 0;
    this.lastAction = { by: null, act: 'deal', detail: '发牌，底分' + this.base };
  }

  playerById(id) { return this.players.find((p) => p.id === id) || null; }
  activeCount() { return this.players.filter((p) => !p.folded).length; }

  callCost(p) { return Math.min(this.currentBet * (p.seen ? 2 : 1), this.maxBet); }

  pay(p, amount) {
    const real = Math.min(amount, this.maxBet);
    if (real > p.balance) throw new Error('分数不够，只能弃牌');
    p.balance -= real; p.paid += real; this.pot += real;
    return real;
  }

  // action: look | fold | call | raise | compare；arg：raise 为目标注额，compare 为对手 id
  act(id, action, arg) {
    const p = this.playerById(id);
    if (!p) throw new Error('你不在本局中');
    if (this.phase !== 'betting') throw new Error('本局已结束');
    if (p.folded) throw new Error('你已弃牌');
    if (action === 'look') {
      if (p.seen) throw new Error('已经看过牌了');
      p.seen = true;
      this.lastAction = { by: id, act: 'look', detail: '看牌' };
      return { ok: true };
    }
    if (this.players[this.turn].id !== id) throw new Error('还没轮到你');
    if (action === 'fold') {
      p.folded = true;
      this.lastAction = { by: id, act: 'fold', detail: '弃牌' };
    } else if (action === 'call') {
      const cost = this.callCost(p);
      const paid = this.pay(p, cost);
      this.lastAction = { by: id, act: 'call', detail: '跟注' + paid };
    } else if (action === 'raise') {
      const to = Number(arg);
      if (!Number.isInteger(to) || to <= this.currentBet || to > this.maxBet) {
        throw new Error('加注必须大于当前注额且不超过' + this.maxBet);
      }
      const paid = this.pay(p, to * (p.seen ? 2 : 1));
      this.currentBet = to;
      this.lastAction = { by: id, act: 'raise', detail: '加注到' + to + '，实付' + paid };
    } else if (action === 'compare') {
      const t = this.playerById(arg);
      if (!t || t.folded) throw new Error('比牌对象无效');
      if (t.id === id) throw new Error('不能和自己比牌');
      const cost = Math.min(this.currentBet * 2 * (p.seen ? 2 : 1), this.maxBet);
      const paid = this.pay(p, cost);
      const cmp = compareEval(evaluate(p.cards), evaluate(t.cards));
      let detail = '比牌，支付' + paid;
      if (cmp > 0) { t.folded = true; detail += '，' + t.id + '出局'; }
      else if (cmp < 0) { p.folded = true; detail += '，自己出局'; }
      else { detail += '，平手，双方继续'; }
      this.lastAction = { by: id, act: 'compare', target: t.id, detail };
    } else {
      throw new Error('未知操作');
    }
    this.actedThisRound.add(p.seat);
    this.afterAction();
    return { ok: true };
  }

  afterAction() {
    if (this.activeCount() === 1) { this.endByFold(); return; }
    // 一轮 = 每个未弃牌者都行动过一次（含弃牌）；满轮则轮数 +1
    const allActed = this.players.filter((p) => !p.folded)
      .every((p) => this.actedThisRound.has(p.seat));
    if (allActed) {
      this.actedThisRound.clear();
      this.round++;
      if (this.round > this.maxRounds) { this.showdown('round_cap'); return; }
    }
    this.advanceTurn();
  }

  advanceTurn() {
    const n = this.players.length;
    let idx = this.turn;
    let guard = 0;
    do {
      idx = (idx + 1) % n;
      guard++;
      if (guard > n + 1) break;
    } while (this.players[idx].folded);
    this.turn = idx;
  }

  endByFold() {
    const w = this.players.find((p) => !p.folded);
    w.balance += this.pot;
    this.winners = [w.id];
    this.phase = 'finished';
    this.result = this.buildResult('fold');
  }

  showdown(reason) {
    const active = this.players.filter((p) => !p.folded);
    const scored = active.map((p) => ({ p, ev: evaluate(p.cards) }));
    let best = scored[0].ev;
    for (const s of scored) if (compareEval(s.ev, best) > 0) best = s.ev;
    const winners = scored.filter((s) => compareEval(s.ev, best) === 0).map((s) => s.p);
    winners.sort((a, b) => a.seat - b.seat);
    const share = Math.floor(this.pot / winners.length);
    const rem = this.pot - share * winners.length;
    winners.forEach((w, i) => { w.balance += share + (i === 0 ? rem : 0); });
    this.winners = winners.map((w) => w.id);
    this.phase = 'finished';
    this.result = this.buildResult(reason);
  }

  buildResult(reason) {
    const players = this.players.map((p) => {
      const entry = {
        id: p.id, delta: p.balance - p.startBalance, paid: p.paid,
        hand: p.folded ? '已弃牌' : evaluate(p.cards).name,
        handText: p.folded ? '已弃牌' : evaluate(p.cards).text,
        cards: null,
      };
      if (reason !== 'fold' && !p.folded) entry.cards = p.cards.map(cardName);
      return entry;
    });
    const winEv = this.winners.length
      ? evaluate(this.playerById(this.winners[0]).cards)
      : null;
    return {
      reason, winners: this.winners.slice(), pot: this.pot,
      winHand: winEv ? winEv.name : null, winHandText: winEv ? winEv.text : null,
      players,
    };
  }

  // 给某个玩家看的牌桌状态：别人的牌一律隐藏；摊牌后亮出未弃牌者的牌
  stateFor(viewerId) {
    return {
      phase: this.phase, round: this.round, currentBet: this.currentBet,
      pot: this.pot, turn: this.phase === 'betting' ? this.players[this.turn].id : null,
      maxBet: this.maxBet, base: this.base, maxRounds: this.maxRounds,
      lastAction: this.lastAction,
      winners: this.winners,
      players: this.players.map((p) => ({
        id: p.id, seat: p.seat, folded: p.folded, seen: p.seen,
        paid: p.paid, balance: p.balance, left: p.left,
        cards: (p.id === viewerId || (this.phase === 'finished' && !p.folded))
          ? p.cards.map(cardName) : null,
      })),
    };
  }
}

module.exports = { makeDeck, shuffle, evaluate, compareEval, straightHigh, Game, CAT, CAT_NAME, cardName };
