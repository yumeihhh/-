// 炸金花 TCP 服务端：给手机 App 用。游戏逻辑全在 core.js，这里只负责 TCP 收发。
// 端口默认 23999，可用环境变量 ZHAJINHUA_PORT 覆盖。
'use strict';

const net = require('net');
const core = require('./core');

const PORT = Number(process.env.ZHAJINHUA_PORT || 23999);

const server = net.createServer((sock) => {
  let buf = '';
  const send = (obj) => {
    // 登录成功后把 username 记到 socket 上，断线时用来清连接、退房间。
    if (obj && obj.t === 'login' && obj.ok && obj.username) sock.username = obj.username;
    try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) { /* ignore */ }
  };
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        send({ t: 'error', msg: '请求格式不对' });
        continue;
      }
      try { core.handle(msg, send, 'tcp'); } catch (e) {
        send({ t: 'error', msg: '服务端出错：' + e.message });
      }
    }
  });
  sock.on('close', () => {
    if (!sock.username) return;
    const c = core.connections.get(sock.username);
    // 只有登记的连接正是本 socket 时才清掉并退房（避免同账号多连接时误删）。
    if (c && c.kind === 'tcp' && c.send === send) core.onDisconnect(sock.username);
  });
  sock.on('error', () => { /* ignore */ });
});

// 先载入数据库（Postgres 或本地文件），再开始监听；core.init 是幂等的。
(async () => {
  await core.init();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('zhajinhua server listening on ' + PORT);
  });
})().catch((e) => {
  console.error('server start failed:', e);
  process.exit(1);
});

module.exports = { server };
