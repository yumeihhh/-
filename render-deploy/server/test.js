// 炸金花自测：规则引擎 + 存储 + 服务端冒烟（3 个客户端真实走一局）。
// 用法：node server/test.js；服务端冒烟用临时端口与临时数据文件，不动正式数据。
'use strict';

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const { evaluate, compareEval, Game, makeDeck } = require('./engine');

function C(rank, suit) { return { rank, suit }; }
function ev(rankSuitList) { return evaluate(rankSuitList.map(([r, s]) => C(r, s))); }

function testEvaluate() {
  // 豹子
  assert(compareEval(ev([[14, 0], [14, 1], [14, 2]]), ev([[2, 0], [2, 1], [2, 2]])) > 0, '豹子A 应大于豹子2');
  // 同花顺：QKA 最大，A23 最小
  assert(compareEval(ev([[12, 0], [13, 0], [14, 0]]), ev([[14, 0], [2, 0], [3, 0]])) > 0, '同花顺QKA 应大于同花顺A23');
  assert(ev([[14, 0], [2, 0], [3, 0]]).cat === 5, 'A23 同花应为同花顺');
  assert(ev([[14, 0], [2, 1], [3, 2]]).cat === 3, 'A23 杂花应为顺子');
  assert(compareEval(ev([[14, 0], [2, 1], [3, 2]]), ev([[2, 0], [3, 1], [4, 2]])) < 0, '顺子A23 应小于顺子234');
  // 金花比单张
  assert(compareEval(ev([[14, 0], [13, 0], [11, 0]]), ev([[14, 0], [13, 0], [9, 0]])) > 0, '金花AKJ 应大于金花AK9');
  // 对子：先比对子，再比单张
  assert(compareEval(ev([[14, 0], [14, 1], [13, 2]]), ev([[14, 0], [14, 1], [12, 2]])) > 0, '对子A带K 应大于对子A带Q');
  assert(compareEval(ev([[13, 0], [13, 1], [14, 2]]), ev([[14, 0], [14, 1], [2, 2]])) < 0, '对子K 应小于对子A');
  // 散牌（KQJ 是顺子，不能用来比散牌，改用 KQ9）
  assert(compareEval(ev([[14, 0], [8, 1], [2, 2]]), ev([[13, 0], [12, 1], [9, 2]])) > 0, '散牌A82 应大于散牌KQ9');
  // 牌型等级
  assert(ev([[14, 0], [14, 1], [14, 2]]).cat > ev([[12, 0], [13, 0], [14, 0]]).cat, '豹子大于同花顺');
  assert(ev([[14, 0], [13, 0], [11, 0]]).cat > ev([[12, 0], [13, 1], [14, 2]]).cat, '金花大于顺子');
  assert(ev([[12, 0], [13, 1], [14, 2]]).cat > ev([[14, 0], [14, 1], [13, 2]]).cat, '顺子大于对子');
  // 平手：同点数不同花色
  assert(compareEval(ev([[14, 0], [13, 1], [11, 2]]), ev([[14, 1], [13, 2], [11, 3]])) === 0, '同点数散牌应平手');
  console.log('evaluate: OK');
}

// 预设发牌顺序（轮流发）：P1 豹子A，P2 豹子K，P3 豹子Q
function riggedDeck() {
  const deck = [
    C(14, 0), C(13, 0), C(12, 0),
    C(14, 1), C(13, 1), C(12, 1),
    C(14, 2), C(13, 2), C(12, 2),
  ];
  const used = new Set(deck.map((c) => c.rank + '-' + c.suit));
  for (const c of makeDeck()) if (!used.has(c.rank + '-' + c.suit)) deck.push(c);
  return deck;
}

function testGameFoldWin() {
  const g = new Game(['P1', 'P2', 'P3'], { balances: { P1: 1000, P2: 1000, P3: 1000 }, deck: riggedDeck() });
  assert.strictEqual(g.pot, 30, '底分 10x3=30');
  assert.strictEqual(g.turn, 1, '首位行动应为 2 号位');
  g.act('P2', 'fold');
  g.act('P3', 'fold');
  assert.strictEqual(g.phase, 'finished', '剩 1 人应结束');
  assert.deepStrictEqual(g.winners, ['P1'], 'P1 应获胜');
  const p1 = g.playerById('P1');
  assert.strictEqual(p1.balance, 1020, 'P1 结算应为 1020（付 10 赢 30）');
  console.log('game fold-win: OK');
}

function testGameShowdown() {
  const g = new Game(['P1', 'P2', 'P3'], { balances: { P1: 1000, P2: 1000, P3: 1000 }, deck: riggedDeck(), maxRounds: 1 });
  g.act('P2', 'call'); // 付 10
  g.act('P3', 'call'); // 付 10
  g.act('P1', 'call'); // 付 10，三人各行动一次 -> 满 1 轮，强制摊牌
  assert.strictEqual(g.phase, 'finished', '满 1 轮应强制摊牌');
  assert.deepStrictEqual(g.winners, ['P1'], '豹子A 应赢');
  assert.strictEqual(g.result.winHand, '豹子', '赢牌应为豹子');
  assert.strictEqual(g.pot, 60, '底池应为 底分 30 + 跟注 30 = 60');
  const p1 = g.playerById('P1');
  assert.strictEqual(p1.balance, 1040, 'P1 结算应为 1040（付 20 赢 60）');
  console.log('game showdown: OK');
}

function testBetCapAndCompare() {
  const g = new Game(['P1', 'P2', 'P3'], { balances: { P1: 10000, P2: 10000, P3: 10000 }, deck: riggedDeck() });
  assert.throws(() => g.act('P2', 'raise', 2000), /不超过1000/, '加注超 1000 应拒绝');
  g.act('P2', 'raise', 500);
  assert.strictEqual(g.currentBet, 500, '当前注额应为 500');
  g.act('P3', 'look');
  g.act('P3', 'call'); // 看牌跟注付 min(500*2,1000)=1000
  assert.strictEqual(g.playerById('P3').paid, 1010, '看牌跟注 500 应实付 1000');
  g.act('P1', 'compare', 'P2'); // P1 豹子A 对 P2 豹子K
  assert.strictEqual(g.playerById('P2').folded, true, '比牌输家 P2 应出局');
  console.log('game bet-cap & compare: OK');
}

function testRoundCap() {
  const g = new Game(['A', 'B', 'C'], { balances: { A: 10000, B: 10000, C: 10000 }, maxRounds: 2 });
  let guard = 0;
  while (g.phase === 'betting' && guard++ < 200) {
    g.act(g.players[g.turn].id, 'call');
  }
  assert.strictEqual(g.phase, 'finished', '15 轮内必结束（本测 maxRounds=2）');
  assert(g.round <= 3, '轮数不应超过 maxRounds+1');
  console.log('game round-cap: OK');
}

// 对局结束翻开所有人的牌（含已弃牌者）
function testRevealCards() {
  const g = new Game(['P1', 'P2', 'P3'], { balances: { P1: 1000, P2: 1000, P3: 1000 }, deck: riggedDeck() });
  g.act('P2', 'fold');
  g.act('P3', 'fold');
  assert.strictEqual(g.phase, 'finished', '剩 1 人应结束');
  for (const p of g.result.players) {
    assert(Array.isArray(p.cards) && p.cards.length === 3, p.id + ' 结算应亮出 3 张牌');
  }
  const st = g.stateFor('P1');
  for (const p of st.players) {
    assert(Array.isArray(p.cards) && p.cards.length === 3, 'stateFor(' + p.id + ') 应亮牌');
  }
  const g2 = new Game(['P1', 'P2', 'P3'], { balances: { P1: 1000, P2: 1000, P3: 1000 }, deck: riggedDeck(), maxRounds: 1 });
  g2.act('P2', 'fold');
  g2.act('P3', 'call');
  g2.act('P1', 'call');
  assert.strictEqual(g2.phase, 'finished', '应摊牌结束');
  const p2 = g2.result.players.find((p) => p.id === 'P2');
  assert(Array.isArray(p2.cards) && p2.cards.length === 3, '摊牌时已弃牌者也应亮牌');
  console.log('reveal cards: OK');
}

function testStore() {
  const tmp = path.join(os.tmpdir(), 'zhajinhua-test-' + Date.now() + '.json');
  process.env.ZHAJINHUA_DATA = tmp;
  delete require.cache[require.resolve('./store')];
  const store = require('./store');
  const db = store.load();
  store.createUser(db, 'u1', 'pass1234');
  assert(store.verifyUser(db, 'u1', 'pass1234'), '密码应校验通过');
  assert(!store.verifyUser(db, 'u1', 'wrong'), '错密码应拒绝');
  const u = db.users.u1;
  u.points = 5;
  u.lastReset = '2000-01-01';
  assert(store.canPlay(u), '隔日分数不足应恢复并可玩');
  assert.strictEqual(u.points, 5000, '次日应恢复 5000');
  u.points = 5;
  assert(!store.canPlay(u), '当天分数不足应不可玩');
  try { fs.unlinkSync(tmp); } catch (e) { /* 未落盘时文件不存在 */ }
  console.log('store: OK');
}

// 服务端冒烟：3 客户端注册/登录/建房/入房/开局/行动，校验 state 推送
async function testServer() {
  const tmp = path.join(os.tmpdir(), 'zhajinhua-srv-' + Date.now() + '.json');
  const port = 23998;
  const child = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, ZHAJINHUA_PORT: String(port), ZHAJINHUA_DATA: tmp },
    silent: true,
  });
  const waitForLine = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
  await waitForLine;

  function client() {
    const sock = net.connect(port, '127.0.0.1');
    const msgs = [];
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) msgs.push(JSON.parse(line));
      }
    });
    const send = (o) => sock.write(JSON.stringify(o) + '\n');
    const waitFor = (pred, timeoutMs) => new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = msgs.find(pred);
        if (m) { clearInterval(iv); resolve(m); }
        else if (Date.now() - start > (timeoutMs || 5000)) { clearInterval(iv); reject(new Error('timeout waiting')); }
      }, 20);
    });
    return { sock, msgs, send, waitFor };
  }

  try {
    const a = client(), b = client(), c = client();
    for (const [cl, name] of [[a, 'a1'], [b, 'b1'], [c, 'c1']]) {
      cl.send({ t: 'register', username: name, password: 'pass1234' });
      await cl.waitFor((m) => m.t === 'register' && m.ok);
      cl.send({ t: 'login', username: name, password: 'pass1234' });
      const login = await cl.waitFor((m) => m.t === 'login' && m.ok);
      cl.token = login.token;
      assert.strictEqual(login.points, 5000, name + ' 初始 5000 分');
    }
    a.send({ t: 'create_room', token: a.token, size: 3 });
    const created = await a.waitFor((m) => m.t === 'state' && m.room.code);
    const code = created.room.code;
    assert(/^\d{6}$/.test(code), '邀请码应为 6 位数字');
    b.send({ t: 'join_room', token: b.token, code });
    c.send({ t: 'join_room', token: c.token, code });
    await b.waitFor((m) => m.t === 'state' && m.room.players.length === 3);
    a.send({ t: 'start_game', token: a.token });
    const started = await a.waitFor((m) => m.t === 'state' && m.room.game && m.room.game.phase === 'betting');
    assert(started.room.game.pot === 30, '开局底池应为 30');
    const turnId = started.room.game.turn;
    const turnClient = { a1: a, b1: b, c1: c }[turnId];
    turnClient.send({ t: 'act', token: turnClient.token, act: 'call' });
    const after = await a.waitFor((m) => m.t === 'state' && m.room.game && m.room.game.pot === 40);
    assert(after.room.game.pot === 40, '跟注后底池应为 40');
    console.log('server smoke: OK (room ' + code + ')');
    a.sock.destroy(); b.sock.destroy(); c.sock.destroy();
  } finally {
    child.kill();
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

// 倒计时 + 自动开下一局：3 人局结束应倒计时 5 秒，到点自动开新局
async function testAutoStart() {
  const tmp = path.join(os.tmpdir(), 'zhajinhua-auto-' + Date.now() + '.json');
  const port = 23997;
  const child = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, ZHAJINHUA_PORT: String(port), ZHAJINHUA_DATA: tmp },
    silent: true,
  });
  const waitForLine = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
  await waitForLine;

  function client() {
    const sock = net.connect(port, '127.0.0.1');
    const msgs = [];
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) msgs.push(JSON.parse(line));
      }
    });
    const send = (o) => sock.write(JSON.stringify(o) + '\n');
    const waitFor = (pred, timeoutMs) => new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const m = msgs.find(pred);
        if (m) { clearInterval(iv); resolve(m); }
        else if (Date.now() - start > (timeoutMs || 8000)) { clearInterval(iv); reject(new Error('timeout waiting')); }
      }, 20);
    });
    return { sock, msgs, send, waitFor };
  }

  try {
    const a = client(), b = client(), c = client();
    for (const [cl, name] of [[a, 'a1'], [b, 'b1'], [c, 'c1']]) {
      cl.send({ t: 'register', username: name, password: 'pass1234' });
      await cl.waitFor((m) => m.t === 'register' && m.ok);
      cl.send({ t: 'login', username: name, password: 'pass1234' });
      const login = await cl.waitFor((m) => m.t === 'login' && m.ok);
      cl.token = login.token;
    }
    a.send({ t: 'create_room', token: a.token, size: 3 });
    const created = await a.waitFor((m) => m.t === 'state' && m.room.code);
    const code = created.room.code;
    b.send({ t: 'join_room', token: b.token, code });
    c.send({ t: 'join_room', token: c.token, code });
    await b.waitFor((m) => m.t === 'state' && m.room.players.length === 3);
    a.send({ t: 'start_game', token: a.token });
    const started = await a.waitFor((m) => m.t === 'state' && m.room.game && m.room.game.phase === 'betting');
    assert(started.room.game.pot === 30, '开局底池应为 30');
    // b1 先行动弃牌，c1 再弃牌，剩 a1 获胜
    const turnId = started.room.game.turn;
    assert.strictEqual(turnId, 'b1', '首位行动应为 b1');
    b.send({ t: 'act', token: b.token, act: 'fold' });
    await a.waitFor((m) => m.t === 'state' && m.room.game && m.room.game.turn === 'c1');
    c.send({ t: 'act', token: c.token, act: 'fold' });
    const over = await a.waitFor((m) => m.t === 'game_over' && m.result);
    assert(over.result.winners.length === 1, '弃牌胜应有 1 位赢家');
    for (const p of over.result.players) {
      assert(Array.isArray(p.cards) && p.cards.length === 3, p.id + ' 结算应亮出 3 张牌');
    }
    // 倒计时：3 人应为 5 秒
    const st = await a.waitFor((m) => m.t === 'state' && m.room.nextGameAt && m.room.countdown === 5, 5000);
    assert(st.room.phase === 'waiting', '倒计时期间房间应为等待态');
    assert(st.room.nextGameAt > Date.now(), 'nextGameAt 应在未来');
    // 等倒计时走完，自动开新局
    const next = await a.waitFor((m) => m.t === 'state' && m.room.game && m.room.game.phase === 'betting' && m.room.game.pot === 30, 12000);
    assert(next.room.phase === 'playing', '倒计时结束应自动开局');
    assert(!next.room.lastResult, '新局开始应清掉旧结算');
    console.log('auto-start: OK (countdown 5s, new game started)');
    a.sock.destroy(); b.sock.destroy(); c.sock.destroy();
  } finally {
    child.kill();
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

(async () => {
  testEvaluate();
  testGameFoldWin();
  testGameShowdown();
  testBetCapAndCompare();
  testRoundCap();
  testRevealCards();
  testStore();
  await testServer();
  await testAutoStart();
  console.log('ALL TESTS PASSED');
})().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
