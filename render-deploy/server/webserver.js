// 炸金花网页版服务端：HTTP + JSON，复用 core.js（与手机 App 同一份房间与分数）。
// 网页打开 http://<服务器地址>:8080 就能玩，不用装 App。
// 接口（与 TCP 协议同一套消息格式）：
//   POST /api  body: {t, token?, ...}  -> { reply, snapshot }
//   GET  /api/state?token=...          -> { snapshot }
// snapshot: { username, points, friends, requests, room }，room 为 null 表示不在房间。
// 网页靠每 1.5 秒轮询 /api/state 拿最新牌桌；60 秒轮次超时由 core 的定时器自动弃牌。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const PORT = Number(process.env.PORT || process.env.ZHAJINHUA_WEB_PORT || 8080);
const WEB_DIR = path.join(__dirname, 'web');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function snapshotForToken(token) {
  if (!token) return null;
  const username = core.sessions.get(String(token));
  if (!username) return null;
  core.touch(username);
  return core.snapshotFor(username);
}

function handleApi(req, res, bodyText) {
  let msg;
  try { msg = JSON.parse(bodyText || '{}'); } catch (e) {
    return sendJson(res, 400, { reply: { t: 'error', msg: '请求格式不对' }, snapshot: null });
  }
  let replyObj = null;
  const reply = (obj) => { if (replyObj === null) replyObj = obj; };
  try {
    core.handle(msg, reply, 'http');
  } catch (e) {
    return sendJson(res, 200, { reply: { t: 'error', msg: '服务端出错：' + e.message }, snapshot: snapshotForToken(msg.token) });
  }
  if (!replyObj) replyObj = { t: 'error', msg: '无响应' };
  return sendJson(res, 200, { reply: replyObj, snapshot: snapshotForToken(msg.token) });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const file = path.join(WEB_DIR, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('网页文件缺失：请确认 server/web/index.html 已部署');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/state') {
    const snap = snapshotForToken(u.searchParams.get('token'));
    return sendJson(res, 200, { snapshot: snap });
  }
  if (req.method === 'POST' && u.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => handleApi(req, res, body));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// 先载入数据库（Postgres 或本地文件），再开始监听；core.init 是幂等的。
(async () => {
  await core.init();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('zhajinhua web server listening on ' + PORT);
  });
})().catch((e) => {
  console.error('webserver start failed:', e);
  process.exit(1);
});

module.exports = { server };
