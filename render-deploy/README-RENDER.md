# 炸金花网页版 · Render 部署步骤

目标：拿到一个公网网址，任何网络的朋友打开就能玩，不用 Tailscale、不用装 App。

## 数据库：数据不会丢了

本包已接好 PostgreSQL：账号、分数、好友、战绩存在数据库里，
服务重启/休眠后都在，不用重新注册。部署时 Render 会自动建一个免费数据库并连上，
不用你手动配。

免费数据库有效期 90 天，到期后 Render 会提示；想长期用可升级成付费数据库
（约 6 美元/月），或到期前导出再建一个。

免费版剩下的一个限制：**会休眠**——15 分钟没人访问服务会休眠，
下一个人打开要等 30–60 秒唤醒，唤醒后数据都在。

## 1. 把代码放到 GitHub

Render 是从 GitHub 拉代码部署的，所以先把代码放进一个 GitHub 仓库：

1. 打开 [github.com/new](https://github.com/new)，新建一个仓库（名字如 `zhajinhua`，选 Public）。
2. 把本包里的全部文件上传到这个仓库（网页上点 **Add file → Upload files**，把文件拖进去就行，不用装 git）。
   本包文件：`package.json`、`render.yaml`、`server/`（全部文件，含 `server/web/index.html`）。
3. 点 **Commit changes** 提交。

## 2. 在 Render 上部署

1. 打开 [dashboard.render.com](https://dashboard.render.com)，注册/登录（可用 GitHub 账号直接登录）。
2. 点 **New → Blueprint**，选刚才那个 GitHub 仓库，Render 会按 `render.yaml`
   自动建一个 Web Service 和一个免费 PostgreSQL 数据库并连好。
   （也可以点 New → Web Service 手动建，记得在 Environment 里把数据库连上；
   用 Blueprint 最省事。）
3. 等几分钟部署完成。部署好后，Web Service 页面顶上会显示一个网址，
   如 `https://zhajinhua-xxxx.onrender.com`，这就是游戏网址。

## 3. 打开游戏

- **网页版**：浏览器打开 `https://zhajinhua-xxxx.onrender.com`，注册昵称就能玩。
- **手机 App**：Render 免费版只暴露网页端口，手机 App 的 TCP 端口连不上，所以在 Render 上只能玩网页版。

## 4. 数据与维护

- 账号、分数、好友、战绩存在 PostgreSQL 数据库里，服务重启/休眠后都在。
- 服务休眠后第一次打开要等唤醒（30–60 秒），之后就正常了。
- 在 Render 面板里能看到日志（Logs）和重启（Manual Deploy → Deploy latest commit）。
- 免费数据库 90 天到期：到期前 Render 会提醒，到时可升级付费库或重建一个。
