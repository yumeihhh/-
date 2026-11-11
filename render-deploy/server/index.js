// 炸金花统一启动：一个进程同时跑 TCP（手机 App，23999）与 HTTP 网页版（8080）。
// 两边共用同一份 core（同一批账号、分数、房间），网页与手机可以同桌玩。
// 用法：node index.js
// 端口可用环境变量改：ZHAJINHUA_PORT（TCP）、ZHAJINHUA_WEB_PORT（网页）。
'use strict';

require('./server');
require('./webserver');

console.log('zhajinhua running: TCP for app + web at http://<本机地址>:' +
  (process.env.ZHAJINHUA_WEB_PORT || 8080));
