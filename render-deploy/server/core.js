// 炸金花服务端核心：房间、对局、账号逻辑，与传输层（TCP / HTTP）无关。
// 两个传输层共用这一份核心：同一批 db、同一批房间，网页与手机 App 可以同桌玩。
// 推送说明：TCP 客户端靠推送拿最新牌桌；HTTP（网页）靠轮询拿最新牌桌，
// 所以 broadcastState 只给 TCP 连接推，HTTP 客户端下次轮询时自己拉。
'use strict';

const crypto = require('crypto');
const store = require('./store');
const { Game } = require('./engine');

const TURN_MS = 60000;

// db 由 init() 异步载入（Postgres 或本地文件），服务启动前必须先 await core.init()。
let db = null;
let initPromise = null;
async function init() {
  if (!initPromise) {
    initPromise = store.loadAsync().then((d) => { db = d; return d; });
  }
  return initPromise;
}

let sessions = new Map();
// code -> room
const rooms = new Map();
// username -> { kind: 'tcp'|'http', send: fn, lastSeen: ms }
// TCP 的 send 是往 socket 写；HTTP 的 send 只在当前请求里收直接回复，推送靠轮询。
const connections = new Map();

function newToken() { return crypto.randomBytes(16).toString('hex'); }
function makeCode() {
  let c;
  do { c = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(c));
  return c;
}
function findRoomOf(username) {
  for (const r of rooms.values()) if (r.players.includes(username)) return r;
  return null;
}
function isOnline(username) {
  const c = connections.get(username);
  if (!c) return false;
  if (c.kind === 'tcp') return true;
  // HTTP 靠最近一次轮询算在线（30 秒内）
  return Date.now() - (c.lastSeen || 0) < 30000;
}

function roomView(room, viewer) {
  const v = {
    code: room.code, size: room.size, creator: room.creator,
    phase: room.phase,
    players: room.players.map((u) => ({ username: u, online: isOnline(u) })),
  };
  if (room.game) v.game = room.game.stateFor(viewer);
  if (room.lastResult) v.lastResult = room.lastResult;
  return v;
}

function sendTo(username, obj) {
  const c = connections.get(username);
  if (c && c.kind === 'tcp') { try { c.send(obj); } catch (e) { /* ignore */ } }
}
function broadcast(room, obj) { for (const u of room.players) sendTo(u, obj); }
function broadcastState(room) {
  for (const u of room.players) sendTo(u, { t: 'state', room: roomView(room, u) });
}

function armTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const g = room.game;
  if (!g || g.phase !== 'betting') return;
  const turnId = g.players[g.turn].id;
  room.timer = setTimeout(() => {
    if (room.game !== g || g.phase !== 'betting') return;
    if (g.players[g.turn].id !== turnId) return;
    try { g.act(turnId, 'fold'); } catch (e) { /* ignore */ }
    afterGameAction(room);
  }, TURN_MS);
}

function finishGame(room) {
  const g = room.game;
  const hist = g.result;
  for (const p of g.players) {
    const u = db.users[p.id];
    if (u) u.points = Math.max(0, u.points + (p.balance - p.startBalance));
  }
  db.history.push({
    time: new Date().toISOString(), code: room.code, pot: hist.pot,
    winners: hist.winners, winHand: hist.winHand, winHandText: hist.winHandText,
    players: hist.players,
  });
  store.save(db);
  room.lastResult = hist;
  room.phase = 'waiting';
  const leftIds = new Set(g.players.filter((p) => p.left).map((p) => p.id));
  room.players = room.players.filter((u) => !leftIds.has(u));
  if (room.creator && !room.players.includes(room.creator)) room.creator = room.players[0] || null;
  room.game = null;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  broadcast(room, { t: 'game_over', result: hist });
  broadcastState(room);
}

function afterGameAction(room) {
  const g = room.game;
  if (!g) return;
  if (g.phase === 'finished') finishGame(room);
  else { broadcastState(room); armTimer(room); }
}

function leaveRoom(room, username) {
  const g = room.game;
  if (g && g.phase === 'betting') {
    const p = g.players.find((x) => x.id === username);
    if (p) {
      if (!p.folded) { try { g.act(username, 'fold'); } catch (e) { /* ignore */ } }
      p.left = true;
    }
    room.players = room.players.filter((u) => u !== username);
    if (room.creator === username) room.creator = room.players[0] || null;
    afterGameAction(room);
    return;
  }
  room.players = room.players.filter((u) => u !== username);
  if (room.creator === username) room.creator = room.players[0] || null;
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  broadcastState(room);
}

function friendsView(username) {
  const u = db.users[username];
  if (!u) return [];
  return u.friends.map((f) => ({ username: f, online: isOnline(f) }));
}

// 当前用户的一份完整快照（网页轮询用）：房间 + 分数 + 好友 + 申请
function snapshotFor(username) {
  const u = db.users[username];
  if (!u) return null;
  const room = findRoomOf(username);
  return {
    username,
    points: u.points,
    friends: friendsView(username),
    requests: u.requests.slice(),
    room: room ? roomView(room, username) : null,
  };
}

function userHistory(username) {
  return db.history
    .filter((h) => h.players.some((p) => p.id === username))
    .slice().reverse();
}

// 处理一条客户端消息。reply(obj) 发直接回复；kind 为 'tcp' 或 'http'。
// 登录成功后登记连接：TCP 靠 socket 在线，HTTP 靠最近轮询时间算在线。
function handle(msg, reply, kind) {
  const t = msg.t;
  const send = (obj) => { try { reply(obj); } catch (e) { /* ignore */ } };
  if (t === 'ping') return send({ t: 'pong' });

  if (t === 'register') {
    const username = String(msg.username || '').trim();
    const password = String(msg.password || '');
    if (!username || username.length > 16) return send({ t: 'error', msg: '昵称 1-16 个字' });
    if (password.length < 4 || password.length > 32) return send({ t: 'error', msg: '密码 4-32 位' });
    if (db.users[username]) return send({ t: 'error', msg: '这个昵称已被注册' });
    store.createUser(db, username, password);
    store.save(db);
    return send({ t: 'register', ok: true });
  }

  if (t === 'login') {
    const username = String(msg.username || '').trim();
    if (!store.verifyUser(db, username, String(msg.password || ''))) {
      return send({ t: 'error', msg: '昵称或密码不对' });
    }
    const u = db.users[username];
    store.dailyReset(u);
    store.save(db);
    const token = newToken();
    sessions.set(token, username);
    connections.set(username, { kind: kind || 'tcp', send: reply, lastSeen: Date.now() });
    return send({
      t: 'login', ok: true, token, username,
      points: u.points, friends: friendsView(username), requests: u.requests,
    });
  }

  const username = sessions.get(msg.token);
  if (!username) return send({ t: 'error', msg: '请先登录' });
  const me = db.users[username];
  if (!me) return send({ t: 'error', msg: '账号不存在' });

  if (t === 'create_room') {
    const size = Number(msg.size);
    if (!Number.isInteger(size) || size < 3 || size > 10) {
      return send({ t: 'error', msg: '房间人数 3-10 人' });
    }
    if (findRoomOf(username)) return send({ t: 'error', msg: '请先退出当前房间' });
    if (!store.canPlay(me)) return send({ t: 'error', msg: '分数不足，今天不能再玩了，明天恢复 1000 分' });
    const code = makeCode();
    const room = {
      code, size, creator: username, phase: 'waiting',
      players: [username], game: null, lastResult: null, timer: null,
    };
    rooms.set(code, room);
    broadcastState(room);
    return send({ t: 'state', room: roomView(room, username) });
  }

  if (t === 'join_room') {
    const room = rooms.get(String(msg.code || ''));
    if (!room) return send({ t: 'error', msg: '房间不存在，检查下邀请码' });
    if (room.phase !== 'waiting') return send({ t: 'error', msg: '对局进行中，不能加入' });
    if (room.players.length >= room.size) return send({ t: 'error', msg: '房间已满' });
    if (findRoomOf(username)) return send({ t: 'error', msg: '请先退出当前房间' });
    if (!store.canPlay(me)) return send({ t: 'error', msg: '分数不足，今天不能再玩了，明天恢复 1000 分' });
    room.players.push(username);
    broadcastState(room);
    return send({ t: 'state', room: roomView(room, username) });
  }

  if (t === 'leave_room') {
    const room = findRoomOf(username);
    if (!room) return send({ t: 'left' });
    leaveRoom(room, username);
    return send({ t: 'left' });
  }

  if (t === 'start_game') {
    const room = findRoomOf(username);
    if (!room) return send({ t: 'error', msg: '你不在房间里' });
    if (room.creator !== username) return send({ t: 'error', msg: '只有房主能开始' });
    if (room.phase !== 'waiting') return send({ t: 'error', msg: '对局已在进行' });
    if (room.players.length < 3) return send({ t: 'error', msg: '人数不足，至少 3 人才能开始' });
    const balances = {};
    for (const u of room.players) {
      if (!store.canPlay(db.users[u])) return send({ t: 'error', msg: u + ' 分数不足，今天不能玩' });
      balances[u] = db.users[u].points;
    }
    room.game = new Game(room.players.slice(), { balances });
    room.phase = 'playing';
    room.lastResult = null;
    broadcastState(room);
    armTimer(room);
    return send({ t: 'state', room: roomView(room, username) });
  }

  if (t === 'act') {
    const room = findRoomOf(username);
    if (!room || !room.game) return send({ t: 'error', msg: '对局未开始' });
    try {
      room.game.act(username, msg.act, msg.act === 'raise' ? msg.to : msg.target);
    } catch (e) {
      return send({ t: 'error', msg: e.message });
    }
    afterGameAction(room);
    return send({ t: 'state', room: roomView(room, username) });
  }

  if (t === 'friend_add') {
    const target = String(msg.username || '').trim();
    if (target === username) return send({ t: 'error', msg: '不能加自己' });
    const tu = db.users[target];
    if (!tu) return send({ t: 'error', msg: '没有这个玩家' });
    if (me.friends.includes(target)) return send({ t: 'error', msg: '已经是好友了' });
    if (tu.requests.includes(username)) return send({ t: 'error', msg: '好友申请已发出，等对方通过' });
    tu.requests.push(username);
    store.save(db);
    sendTo(target, { t: 'friend_request', from: username });
    return send({ t: 'friend_add', ok: true });
  }

  if (t === 'friend_accept') {
    const from = String(msg.username || '').trim();
    if (!me.requests.includes(from)) return send({ t: 'error', msg: '没有这条好友申请' });
    me.requests = me.requests.filter((x) => x !== from);
    if (!me.friends.includes(from)) me.friends.push(from);
    const fu = db.users[from];
    if (fu && !fu.friends.includes(username)) fu.friends.push(username);
    store.save(db);
    sendTo(from, { t: 'friend_accepted', by: username });
    return send({ t: 'friends', friends: friendsView(username), requests: me.requests });
  }

  if (t === 'friends') {
    return send({ t: 'friends', friends: friendsView(username), requests: me.requests });
  }

  if (t === 'profile') {
    store.dailyReset(me);
    return send({ t: 'profile', points: me.points, friends: friendsView(username), requests: me.requests });
  }

  if (t === 'history') {
    return send({ t: 'history', list: userHistory(username) });
  }

  return send({ t: 'error', msg: '未知请求' });
}

// HTTP 轮询/请求时刷新在线时间（网页靠它算在线）。
function touch(username) {
  const c = connections.get(username);
  if (c && c.kind === 'http') c.lastSeen = Date.now();
}

// 玩家断线/离开：清掉连接；如果在房间里，按中途离开处理（对局中算弃牌）。
function onDisconnect(username) {
  const c = connections.get(username);
  if (c && c.kind === 'tcp') connections.delete(username);
  if (username) {
    const room = findRoomOf(username);
    if (room) leaveRoom(room, username);
  }
}

module.exports = {
  sessions, rooms, connections,
  TURN_MS, roomView, snapshotFor, userHistory, handle, onDisconnect, touch,
  findRoomOf, isOnline, broadcastState, store, init,
  // db 用 getter：init() 之后才有值，直接读 core.db 拿到的是当前 db。
  get db() { return db; },
};
