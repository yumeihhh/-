// 持久化存储：账号（密码只存加盐哈希）、分数、好友、战绩。
// 两路存储（自动选）：
//   - 有 DATABASE_URL 环境变量时用 PostgreSQL（Render 部署用，数据不丢）；
//   - 否则用本地 JSON 文件 data/zhajinhua.json（Windows 版用）。
// 数据模型不变：db = { users: {name: {...}}, history: [...] }，整个 db 以一份 JSON 存取。
// 为兼容原有同步调用，save(db) 在 Postgres 下是“串行异步写、调用处不用等”；
// 启动时必须先 await loadAsync() 再开服务（core.init 会做这件事）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.ZHAJINHUA_DATA ||
  path.join(__dirname, '..', 'data', 'zhajinhua.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const usePostgres = !!DATABASE_URL;

let pool = null;
let saveQueue = Promise.resolve();

function getPool() {
  if (pool) return pool;
  // pg 只在用 Postgres 时才加载，Windows 版没装 pg 也能跑（走 JSON 文件）。
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    throw new Error('未安装 pg 依赖：Render 上请确认 package.json 含 pg 且已 npm install；本地请 npm install pg');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  pool.on('error', (err) => { console.error('Postgres pool error:', err.message); });
  return pool;
}

async function ensureTable() {
  const p = getPool();
  // 注意：不用 PRIMARY KEY / ON CONFLICT（pg-mem 测不了，真实库也可用更简单的写法）；
  // 保存时先 UPDATE、没行再 INSERT，且 save() 已串行化，不会并发写出重复行。
  await p.query(
    'CREATE TABLE IF NOT EXISTS zhajinhua_store (key TEXT, value JSONB)'
  );
}

async function loadFromPostgres() {
  const p = getPool();
  await ensureTable();
  const r = await p.query('SELECT value FROM zhajinhua_store WHERE key = $1', ['db']);
  if (r.rows.length === 0) return { users: {}, history: [] };
  const db = r.rows[0].value || {};
  if (!db.users) db.users = {};
  if (!db.history) db.history = [];
  return db;
}

function loadFromFile() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.users) db.users = {};
    if (!db.history) db.history = [];
    return db;
  } catch (e) {
    return { users: {}, history: [] };
  }
}

// 启动时调用：Postgres 下从库里读，否则读本地文件。返回 db 对象。
async function loadAsync() {
  if (usePostgres) return loadFromPostgres();
  return loadFromFile();
}

function load() {
  if (usePostgres) {
    throw new Error('Postgres 模式下请用 await loadAsync()，不要用同步 load()');
  }
  return loadFromFile();
}

function saveToFile(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

async function saveToPostgres(db) {
  const p = getPool();
  await ensureTable();
  const val = JSON.stringify(db);
  const upd = await p.query(
    'UPDATE zhajinhua_store SET value = $1::jsonb WHERE key = $2',
    [val, 'db']
  );
  if (upd.rowCount === 0) {
    await p.query(
      'INSERT INTO zhajinhua_store (key, value) VALUES ($1, $2::jsonb)',
      ['db', val]
    );
  }
}

// 保存 db：文件模式同步写盘；Postgres 模式串行异步写（调用处不用 await）。
// 多次 save 连续调用时按顺序写，最后一次写的是最新的完整 db，不会互相覆盖丢数据。
function save(db) {
  if (!usePostgres) return saveToFile(db);
  saveQueue = saveQueue
    .then(() => saveToPostgres(db))
    .catch((e) => { console.error('Postgres save failed:', e.message); });
  return saveQueue;
}

// 北京时间当日日期 YYYY-MM-DD
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createUser(db, username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[username] = {
    salt, hash: hashPassword(password, salt),
    points: 1000, lastReset: todayStr(),
    friends: [], requests: [], createdAt: new Date().toISOString(),
  };
}

function verifyUser(db, username, password) {
  const u = db.users[username];
  if (!u) return false;
  return hashPassword(password, u.salt) === u.hash;
}

// 次日恢复：分数不足 10 且上次恢复不是今天，恢复到 1000
function dailyReset(user) {
  const t = todayStr();
  if (user.points < 10 && user.lastReset !== t) {
    user.points = 1000;
    user.lastReset = t;
    return true;
  }
  return false;
}

// 当天能不能玩：先算次日恢复，再看够不够底分
function canPlay(user) {
  dailyReset(user);
  return user.points >= 10;
}

module.exports = {
  DATA_FILE, DATABASE_URL, usePostgres, load, loadAsync, save, todayStr,
  hashPassword, createUser, verifyUser, dailyReset, canPlay,
};
