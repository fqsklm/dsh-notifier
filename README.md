<div align="center">

# dsh-notifier

**一轮对话结束、或者模型要动你的文件时，让 Windows 弹一条能直接点的系统通知。**

一个 [DSH (DeepSeek Harness)](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件：
宿主半边挂在 DSH 的审批与状态钩子上，浏览器半边是一个 Chrome MV3 扩展，
通知和窗口切换全部交给 Chrome 自己 —— **没有子进程、没有 PowerShell 闪窗、不抢前台、不猜窗口标题**。

[![License: MIT](https://img.shields.io/badge/License-MIT-4d6bfe.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-plugin-4d6bfe.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-3c873a.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-ff7a2a.svg)](#技术实现)
[![Tests](https://img.shields.io/badge/checks-117%20passed-2ea44f.svg)](#测试)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Chrome%20%2F%20Edge-lightgrey.svg)](#设计边界)

[效果](#效果) · [快速开始](#快速开始) · [配置](#配置) · [为什么没有冷却](#为什么没有冷却) · [常见问题](#常见问题) · [协议](#协议想自己写客户端时看这里)

</div>

---

## 这个插件解决什么问题

用 DSH 干活的时候，真正会让你「等一下」的只有两个时刻：

- **模型要提权 / 要动工作区外的文件**，网页里挂出一张审批卡等你点「允许一次」——
  可你这时候正在看别的窗口（或者干脆去泡茶了），网页里那张卡片就这么挂着；
- **一轮对话跑完了**——你想知道，但 DSH 网页不在前台，你只能隔一会儿切回去看一眼。

这个插件把这两个时刻变成**系统通知**，通知里直接带上 DSH 抛出来的申请原文：

| 通知类型 | 标题 | 正文 | 按钮 |
|---|---|---|---|
| 需要审批 | `dsh · 需要审批` | `pwsh 申请提权到 workspace-write` + 申请原文（裁到 320 字） | **回到对话** / **允许** |
| 一轮对话结束 | `dsh · 一轮对话已结束` | 会话标题 · `#短id` | **回到对话** / **知道了** |
| 子代理任务完成 | `dsh · 子代理任务已完成` | 同上（默认关闭，避免一次编排刷出十几条） | 同上 |

点**回到对话**：把 Chrome 抬到前台、切到对应会话，并把那条通知撤下来，
审批本身仍然悬着 —— 你可以回去看完再决定。点**允许**：宿主立刻放行、工具马上执行，
同时扩展会去网页里把那张卡片按掉（见「点通知里的「允许」，到底发生了什么」）。

**为什么审批通知没有「拒绝」按钮**：Windows 的通知只给两个按钮位，第三个会被系统静默丢掉
（早先放的是「回到对话 / 允许 / 拒绝」，结果"拒绝"永远不显示，看起来像坏了）。
两个按钮位留给「回到对话 / 允许」，拒绝就走**回到对话**回网页里点 ——
拒绝之前通常要先看清楚申请内容，回网页点是更稳的流程。

## 效果

配图在 `docs/_mock/` 下，是**可以直接用浏览器打开的还原页**（样式与结构逐字取自真实代码，
只把运行时才有的内容写成静态的）：

| 文件 | 内容 | 对应真实代码 |
|---|---|---|
| `docs/_mock/notification-approval.html` | 审批通知：`回到对话` / `允许` | `extension/background.js` 里 `chrome.notifications.create` 的字段 |
| `docs/_mock/notification-idle.html` | 一轮结束通知：`回到对话` / `知道了` | 同上 |
| `docs/_mock/panel.html` | 扩展面板：连接状态、待处理、停留时长、强制弹通知 | `extension/options.html` |

想变成 PNG 就 `powershell -File docs\shoot.ps1`（用无头 Chrome 渲染这三张，
产物落在 `docs/images/`，已 gitignore）。

## 功能一览

<table>
<tr><td width="170"><b>审批 / 提权通知</b></td><td>通知正文就是 DSH 抛出的申请原文（`escalate sandbox to workspace-write: …` 会被拆成"申请提权到 workspace-write" + 原因），按钮：回到对话 / 允许。</td></tr>
<tr><td><b>一轮结束通知</b></td><td>会话由 running 变 idle 时提醒，带会话标题和短 id，一眼看出是哪个会话跑完了。</td></tr>
<tr><td><b>每条审批各弹一条</b></td><td>一次到底申请了几次权限就弹几条，不设任何时间间隔；每条各有 token，先点哪条都行（见「为什么没有冷却」）。</td></tr>
<tr><td><b>精确回到那个会话</b></td><td>扩展枚举标签页，已经开着就原地切过去 —— 不新开标签、不重新加载页面。</td></tr>
<tr><td><b>页面就在眼前时不打扰</b></td><td>dsh 页面可见且窗口有焦点时**不弹**（那时网页里的卡片本来就在眼前）。想强制弹，面板里勾一下。</td></tr>
<tr><td><b>错过的审批回来还能弹</b></td><td>扩展重连时宿主补发全量快照；扩展自己记着哪些 token 弹过，**弹过就不再弹**，你划掉的也不会再弹回来。</td></tr>
<tr><td><b>通道断了也不僵住</b></td><td>按钮点击是浏览器的独立事件，会唤醒 Service Worker。决定先走 WebSocket 等 ack，送不到就自动改走 <code>POST /dsh-notifier/action</code> 重投；两条都不成功时**通知会留着**让你再点一次。</td></tr>
<tr><td><b>两边都能作答</b></td><td>通知按钮和网页审批卡是竞速关系：谁先答谁生效，另一边会自动撤下 / 同步。</td></tr>
<tr><td><b>多开 dsh 也认得出</b></td><td>每个实例在不同端口 = 不同来源，扩展会给每个来源各建一条通道，面板里逐条列出来。</td></tr>
</table>

## 快速开始

四步。前置：**Node.js ≥ 18**、DSH 已经能跑起来（`dsh web` 能打开页面）、
**Chrome / Edge**（通知那一半是 MV3 扩展）。

```powershell
# 1) 克隆到一个不会被随手删掉的目录
git clone https://github.com/fqsklm/dsh-notifier.git
cd dsh-notifier

# 2) 装进 web profile（包本体留在原地，profile 里建一个链接指向它）
dsh plugin --profile web add link:(Get-Location).Path
```

3）**重启 `dsh web`**。宿主半边是 Node ESM，模块缓存按 specifier 命中，**必须重启才生效**
（`extension/` 和 `client/` 改了不用重启，见「改了之后怎么让两边都生效」）。

4）**装 Chrome 扩展**：

1. 打开 `chrome://extensions`；
2. 右上角打开 **开发者模式**；
3. 点 **加载已解压的扩展程序**，选中本仓库下的 `extension` 文件夹；
4. Windows 上首次弹通知如果看不到，检查 **系统 → 通知 → Google Chrome** 是否被静音/关闭。

Edge 用户同理（`edge://extensions`），MV3 的 `chrome.*` API 在 Edge 里是同一套。

### 确认装上了

打开 dsh 网页（默认 `http://127.0.0.1:3080`），点扩展图标，应该看到：

```
http://127.0.0.1:3080                              ● 在线
通知通道已连接 · 页面可见且聚焦 · 扩展 1 条 · 页面中继 1 条
```

其中"页面中继"是 dsh 网页自带的那条连接（`client/client.js`），**不是**扩展；
"扩展 1 条"才是 Service Worker。不需要手填扩展 ID，也不需要配端口：扩展是从页面里的注入标记
（`<meta name="dsh-notifier-host">`）确认"这个页面是 dsh"，再调 `/dsh-notifier/health`
二次确认，然后才连 WebSocket。没有"发一条测试通知"这类按钮 —— 请用真实事件验证。

宿主侧也可以直接查：

```powershell
curl.exe -s http://127.0.0.1:3080/dsh-notifier/health   # 含每个连接的 id / 类型 / 存活秒数
curl.exe -s http://127.0.0.1:3080/dsh-notifier/config   # 配置 + WebSocket token + lastApproval
```

## 它是怎么工作的

```
DSH 宿主（本插件 src/index.js）
   │  approval/request waterfall、api-session/status
   │  回环 WebSocket  http://127.0.0.1:<dsh端口>/dsh-notifier/ws?t=<token>
   ▼
Chrome 扩展（extension/，MV3 Service Worker）
   │  chrome.notifications.create  →  Windows 通知中心（带按钮）
   │  chrome.tabs / chrome.windows →  精确激活 dsh 标签
   ▼
点按钮 → WebSocket 把 decision 发回宿主 → 宿主 resolve 审批请求
```

### 目录结构

```
dsh-notifier/
├─ src/
│  ├─ index.js     宿主半边：approval/request + api-session/status 钩子、HTTP 路由、WebSocket
│  ├─ ws.js        极简 RFC6455 服务端（握手 + 帧编解码），零依赖
│  └─ util.js      纯函数：文案裁剪、配置归一化、回环校验、待办表
├─ client/
│  └─ client.js    浏览器半边：收到 focus 指令时在 SPA 里切到该会话
├─ extension/      Chrome MV3 扩展
│  ├─ manifest.json
│  ├─ background.js     Service Worker：连 WebSocket、弹通知、处理按钮、激活标签
│  ├─ page-approval.js  点完「允许」之后，去网页里按下那张卡片的「允许一次」
│  ├─ content.js        内容脚本：确认"这是 dsh 页面"、汇报可见/聚焦状态
│  ├─ options.html      面板：连接状态 + 手动填地址 + 停留时长 + 强制弹通知
│  ├─ shared.js
│  └─ icons/
├─ test/           四套测试（见「测试」）
├─ scripts/        诊断脚本（清队列、查连接、盯审批、盯一轮结束）
├─ docs/_mock/     README 配图用的还原页 + 生成脚本
└─ cordis.patch.yml  bundle 的加载行（含默认配置）
```

### 技术实现

- **零运行时依赖**：WebSocket 服务端（握手 + 帧编解码）是 `src/ws.js` 自己写的，
  聊天级的小消息够用；帧的声明长度在读长度头时就校验，不让"声明长度"换内存。
- **只监听回环**：所有 HTTP 路由与 WebSocket 只接受回环地址与回环 Host，非回环一律 403。
- **宿主不做任何界面**：不 spawn、不模拟按键、不枚举窗口，只把事件推给扩展。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `dsh-notifier` 的 `config`
（`~/.dsh/profiles/web/cordis.patch.yml`，默认值见本仓库自带的 `cordis.patch.yml`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifyApproval` | `true` | 审批 / 提权提醒（带回到对话 / 允许按钮） |
| `notifyIdle` | `true` | 一轮对话结束提醒（带回到对话 / 知道了） |
| `notifySubagentIdle` | `false` | 子代理会话结束提醒；一次编排可能刷出很多条，默认关 |
| `titlePrefix` | `dsh` | 通知标题前缀，例如 `dsh · 需要审批` |
| `showSessionTitle` | `true` | 通知里是否带会话标题（`修 bug · #abcd1234`） |
| `showToolName` | `true` | 是否在正文里带工具名（`pwsh 申请提权到 workspace-write`） |

配置按**白名单**逐字段读取：不在表里的字段一律忽略。
所以老配置里留着已经删掉的字段（比如 `cooldownMs: 30000`）不会报错，但也一点作用都没有。

> ⚠️ 手改 `package.json` / `cordis.patch.yml` 时**不要用 Windows PowerShell 5.1 的
> `Set-Content -Encoding utf8`**：它会写入 BOM，`package.json` 带 BOM 后 `JSON.parse`
> 直接抛 `SyntaxError: Unexpected token ''`，dsh 起不来。
> 而 `-Encoding utf8NoBOM` 这个值**只有 PowerShell 7 才有**，5.1 会在参数绑定处报错
> （`Cannot bind parameter 'Encoding'`）。在 5.1 下请用 .NET 的写法：
>
> ```powershell
> $p = "$env:USERPROFILE\.dsh\profiles\web\package.json"
> $text = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
> [System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($false))
> ```
>
> 或者更省事：用 `node` 读写、或编辑器另存为「UTF-8 无 BOM」。

## 为什么没有冷却

这里曾经有一个 `cooldownMs`（默认 1000ms），按**会话**计时：同一会话两次提醒之间必须隔够
这么久，否则第二条直接不进通知通道，只在日志里留一句 `passed-through:cooldown`。
同时宿主还会"用新审批替换同一会话里上一条审批"。

这两条合起来会造成一个很难自查的现象：**一句话里连续申请两次权限时，你只看到一条通知。**
第二条被冷却挡住；第一条又被新审批作废，而作废走的是"有人作答了"的路径，
于是那条**没人点过**的申请被静默判成允许（工具真的执行了），token 也随即失效 ——
点它只会得到 `expired`。

现在两条都删掉了：

- **每条审批各自弹一条通知**，不设任何时间间隔；
- **审批之间不互相作废**：每条有自己的 token，全部留在待办里，
  先点第二条、回头再点第一条都是正常操作；
- 通知中心里"一条盖一条"由扩展负责，而且只对**一轮结束**生效（那类提醒没有"待作答"的含义，
  堆着只会刷屏），新一轮开始时上一条会被撤掉。

## 行为细节

- **重连不会重复弹。** 扩展每次重连都会收到宿主的全量快照（"错过的审批还能补弹"就靠它）；
  扩展记着自己已经弹过哪些 token，弹过就不再弹。这份记录以**通知中心**为准：
  刷新扩展会清空 `storage.session`，所以启动时会把通知中心里还留着的
  `dsh-notifier-<token>` 重新认成"已弹过"；正在处理中的 token 还有一道同步闸门，
  快照和 pending 两帧交错时也只会弹一条。
- **页面就在眼前时不打扰。** 内容脚本持续汇报页面的可见性与焦点，扩展只在
  「dsh 页面不可见」或「窗口没焦点」时才弹。想知道上一条为什么没弹，打开面板看「最近一条」那行。
- **点「回到对话」会把那条通知撤下**，但审批本身仍然悬着：网页里的卡片还在，
  你回去看完可以接着拒绝。点「知道了」（一轮结束）则连待办一起收掉。
- **划掉通知会告诉宿主。** 你把审批横幅划掉、或通知到点自动收掉时，扩展会发一条 `dismiss`
  让宿主清掉那条待办（通道没连上就先排队，连上后补发）；否则那条待办会永远留在队列里、
  而且再也弹不出通知（僵尸待办）。注意 `dismiss` **不等于拒绝**：审批交回网页卡片。
- **通知停留时长**在面板里选：**永久（默认，直到你划掉）** / 15 秒 / 1 分钟 / 5 分钟 / 1 小时。
  它控制的是**通知中心**里的保留时间。屏幕右下角的**横幅**一定会弹出并一直挂着，
  直到你点它或划掉它 —— 这是固定的，面板里没有开关。
  （`requireInteraction: true` 在 Windows 上的实际表现是"只进通知中心、不弹横幅"，
  和它的名字给人的预期正好相反，所以固定用 `priority: 2` + `requireInteraction: false`。）
- **通道断了也不僵住。** 点「允许」/「知道了」时，扩展会等宿主的 **ack 回执**才算送达；
  WebSocket 送不到（通道已死、或宿主回 `expired`）、或 3 秒内没有回执，就自动改用
  `POST /dsh-notifier/action` 重投一次。

## 点通知里的「允许」，到底发生了什么

```
通知里点「允许」
  1. 扩展把 decision{allow} 发回宿主，等 ack 回执（这才是"送达"的凭据）
  2. 宿主结算 approval/request 瀑布 → 工具立刻执行 ✅
  3. 扩展**再让网页自己按一次那个「允许一次」按钮** →
     网页沿它本来的通路作答，网页那张卡片随之消失 ✅
```

为什么非要第 3 步：**网页里的审批卡是浏览器那一半渲染的** ——
`dsh-client-ui-approval` 通过 `approval/request` 瀑布收到申请、挂出卡片，
然后等**自己那半边**作答。而宿主在第 2 步直接给了瀑布一个结果，
api-remotes 只在"收到客户端答复"时才向浏览器回 cancel 帧，
于是转发给页面的那条 waterfall 被丢掉，**卡片会一直停在「等待审批」**。

这个 bug 的表现很唬人：宿主 `/dsh-notifier/config` 里 `lastApproval.outcome` 已经是
`answered-from-notification:allowed-once`、工具也确实跑了，可网页里看到的还是"等待审批"。
（回归测试：`test/repro-allow-card.mjs`，它把真实 cordis + 真实 api-remotes 装起来，
用假网页复现这一条，盯住"卡片会不会消失"。）

第 3 步失败（页面没开、卡片不在前台、DSH 的 UI 改版认不出按钮）**不影响工具执行**，
只影响卡片会不会自己消失：扩展日志里会写一行
`没能在网页里按下「允许」（审批仍已通过，卡片需手动处理）`。

第 3 步认卡片的规则刻意保守，不做"页面特征"猜测（`extension/page-approval.js`）：

1. 只认 DSH 自己写在卡片上的 `data-approval-key` —— 这是卡片的唯一锚点，不是类名/样式猜测；
2. 按钮只在**这张卡片内部**找，且要求文案**精确等于**「允许一次 / Allow once」；
3. 精确文案找不到时，退回"卡片操作行里最后一个按钮"（DSH 的卡片结构是拒绝在左、允许在右），
   并在日志里标成 `matchedBy: "last-button-fallback"`，一眼能看出用的是兜底；
4. 页面上有**多张**审批卡、又对不上是哪一条时：报 `ambiguous`，**坚决不点** ——
   点错卡片等于替你答掉另一条申请；
5. 卡片认不出来就报 `no-card`，退化成"工具照常执行、卡片手动点"，**不会点错**。

## 测试

不需要任何测试框架，四套都是 `node` 直接跑的脚本，**当前 117 项全绿**：

```powershell
npm test                        # 四套一起跑
node test/smoke.mjs             # 宿主半边：真 HTTP + 真 WebSocket 端到端（55 项）
node test/extension.mjs         # 扩展 Service Worker：假 chrome.* 跑真代码（26 项）
node test/page-approval.mjs     # "页内按一次允许"：假 DOM（23 项）
node test/repro-allow-card.mjs  # 卡片回归：真实 cordis + 真实 api-remotes（13 项）
npm run check                   # 九个文件逐个语法检查
```

| 测试 | 盯住什么 |
|---|---|
| `test/smoke.mjs` | 宿主端到端。其中「连续两次审批各自弹一条通知，且各自都能作答」是 0.2.1 的回归：一条消息里连续申请两次权限时，两条都要弹、都要点得动 |
| `test/extension.mjs` | 扩展 SW 的全部行为：判重、身份上报、决定送达、页内点击、**该不弹就别弹**（活动标签 / 断线窗口 / 后台标签 / 别的应用 / 标签关掉），以及"扩展刚刷新过（session 存储被清空、通知中心里那几条还在）"这类会重复弹通知的路径 |
| `test/page-approval.mjs` | 页内找卡片、按按钮的规则（精确文案 / 结构兜底 / 认不准就不动手） |
| `test/repro-allow-card.mjs` | 「通知里点允许 → 网页卡片会不会消失」：真实 cordis + 真实 api-remotes + 假网页 |

> 后两套要 import `@deepseek-ai/*`，用的是 `node_modules/@deepseek-ai/` 下指向本机 dsh 安装的
> **目录联接**（junction，已 gitignore）。换机器跑不动时按需重建：
> ```powershell
> $t = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
> foreach ($n in 'cordis','dsh-api-remotes','dsh-deque','dsh-scope','dsh-util-values','cosmokit') {
>   cmd /c mklink /J "node_modules\@deepseek-ai\$n" "$t\$n"
> }
> ```

### 自检 / 排错脚本

```powershell
node scripts/diagnose-connection.mjs      # 扩展到底装上没有、宿主那条连接是扩展还是页面中继
node scripts/probe-live-page-leg.mjs      # 连上正在跑的宿主，冒充页面中继看它到底收到什么
node scripts/verify-no-focus-loop.mjs     # focus 会不会自激（曾经把用户按在 dsh 标签上切不走）
node scripts/clear-pending.mjs            # 清空宿主队列（排错时用）
node scripts/watch-approval.mjs           # 挂着盯宿主：lastApproval 和 /pending 的每一次变化
node scripts/watch-idle.mjs               # 挂着盯「一轮结束」：打出每条待办的会话 id
node scripts/watch-extension-install.mjs  # 守着看扩展什么时候连上
node scripts/probe-client-bundles.mjs     # 查客户端 bundle 有没有下发
node scripts/make-icons.mjs               # 重新生成扩展图标
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 扩展面板里没有实例 | dsh 页面没打开，或页面还在 401（先用 `dsh web` 打印的带 token 链接打开一次） |
| 面板显示 `○ 离线` | 宿主没起来 / 已重启（token 变了）。扩展每 30 秒自动重连；也可点「刷新状态」 |
| 通知不出现 | 页面当前可见且聚焦（按设计不打扰，可勾「强制弹通知」）；或 Chrome 通知被系统静音/关闭 |
| 点了「允许」工具跑了，网页卡片却还停在「等待审批」 | 扩展没能去页内按按钮。看扩展日志里 `没能在网页里按下「允许」` 那行的 reason：`no-card` / `ambiguous` / `inject-failed`；同时确认扩展刷新过、`scripting` 权限已同意 |
| 点了「允许」但工具没执行 | 先看 `/dsh-notifier/config` 的 `lastApproval.outcome`：是 `notified` 就是决定没送达宿主（扩展那一刻正在重连）。通知会**留着**让你再点一次 |
| 连续几次审批只弹了一条 | 0.2.1 已修（冷却 + 审批互相作废都删掉了）。确认宿主**重启过**（宿主半边是 ESM，不重启跑的还是旧代码） |
| 自定义端口 | 面板里「手动连接」填 `http://127.0.0.1:<端口>`，会就地申请该来源权限 |
| `git clone` 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | Windows 版 Git 的 schannel TLS 后端在这台机器上拿不到凭据。让它改用 OpenSSL 后端即可：`git -c http.sslBackend=openssl clone https://github.com/fqsklm/dsh-notifier.git`（想长期生效就 `git config --global http.sslBackend openssl`） |

`/config` 里的 `lastApproval.outcome` 是最有用的排错入口：

| 取值 | 含义 |
|---|---|
| `answered-from-notification:allowed-once` | 宿主确实收到了通知里的作答，工具会执行。网页卡片若还亮着 → 是页内点击那一步没成功 |
| `answered-in-page:*` | 网页卡片先答的，通知已被撤下 |
| `dismissed:*` | 通知被划掉 / 被扩展对账清理，决定权交回网页卡片 |
| `notified` | 通知弹了但还没人作答（宿主还在等） |
| `passed-through:*` | 这条审批压根没走通知（会话身份 / 总开关），决定权在网页卡片 |
| 一直是上一次的旧值 | 审批请求没走到本插件（宿主没重启，或扩展与宿主版本不一致） |

`/health` 里的 `clientList` 是排查"多出来一条 extension"用的：正常的浏览器会话应当只有
一条 `extension`（扩展的 Service Worker）和一条 `page`（页面里的中继）。多出来的条目看
`idleSec` —— 长时间静默的那种是上一代 Service Worker 留下的连接，宿主会在心跳里回收并打日志。
`clientList[].build` 是扩展自报的构建代号：和 `extension/background.js` 里的
`EXTENSION_BUILD` 对不上，就说明扩展没刷新。

## 开发 / 发布

### 改了之后怎么让两边都生效

| 改了哪半边 | 怎么生效 | 忘了会怎样 |
|---|---|---|
| `extension/**` | `chrome://extensions` → 刷新该扩展 | 跑的还是旧代码，症状和真 bug 一模一样 |
| `src/**`（宿主） | **重启 `dsh web`** | 同上（ESM 模块缓存按 specifier 命中） |
| `client/**`（浏览器半边） | 刷新 dsh 页面 | 同上 |
| `cordis.patch.yml` 里的配置 | `patchReload: live` 会热加载 | 一般不需要重启 |

### 发布前检查清单

```powershell
npm run check    # 九个文件逐个语法检查
npm test         # 四套测试，全绿才算数（当前 117 项）
```

| 项 | 规矩 | 由谁盯着 |
|---|---|---|
| 版本号 | `extension/manifest.json` 的 `version` **必须**等于 `package.json` 的 `version` | `npm test`（宿主那套的「可发布性」） |
| 权限 | 扩展权限集合被钉住了：`notifications / storage / tabs / alarms / scripting`。每加一个，老用户升级时都会弹一次"新增权限"并**暂停扩展** | 同上 |
| 宿主权限 | 只允许回环（`http://127.0.0.1/*`、`http://localhost/*`） | 同上 |
| 清单完整性 | `content_scripts` / `background` / `icons` / `package.json.files` 里引用的文件都真实存在 | 同上 |
| 构建代号 | 改了扩展代码就把 `background.js` 里的 `EXTENSION_BUILD` 加一 | 人工（宿主 `/config` 的 `clientList[].build` 能看到） |

`EXTENSION_BUILD` 是排查"到底是代码没生效还是真 bug"的唯一凭据，别省。
`client.build` 这个字段本身是宿主较新版本才记的 —— 老宿主上 `/config` 里看不到 `build`，
不代表扩展没刷新。

## 设计边界

- 通知和窗口切换**只由 Chrome 扩展**完成，所以**浏览器没开就收不到提醒**
  （换来的是没有子进程、没有闪窗、不抢前台、不猜窗口标题）。
- 「回到对话」依赖扩展枚举标签页，因此只在 **Chrome / Edge** 这类 Chromium 浏览器里有效。
- 宿主侧的 HTTP + WebSocket 接口是通用的：想接别的客户端，只要实现
  `pending` / `decision` / `focus` 三类消息即可（见下节）。

## 协议（想自己写客户端时看这里）

回环 `GET /dsh-notifier/ws?t=<token>`，服务端 → 客户端 JSON：

| `type` | 负载 |
|---|---|
| `hello` | `{ protocol, config }` |
| `snapshot` | `{ items: PendingItem[] }` 连接建立时的一次性补发 |
| `pending` | `{ item: PendingItem }` |
| `resolved` | `{ token, outcome }` 这条提醒已作废（网页里答了 / 划掉了 / 被新一轮结束提醒替换 / 请求被中止） |
| `focus` | `{ sessionId }` 请切到这个会话 |
| `ack` | `{ token, action, result }` 对客户端 decision 的回执 |

客户端 → 服务端：

| `type` | 负载 |
|---|---|
| `ready` / `state` | `{ client: 'extension' \| 'page', origin, focused }` |
| `decision` | `{ token, action: 'open' \| 'allow' \| 'reject' \| 'dismiss' }` |
| `focus-request` | `{ sessionId }` 让网页中继切到该会话（**不会**回给扩展，否则自激） |
| `pong` | 心跳回执 |

`PendingItem`：

```json
{
  "token": "…",
  "kind": "approval",
  "sessionId": "session-…",
  "session": "修 bug · #abcd1234",
  "title": "dsh · 需要审批",
  "subtitle": "pwsh 申请提权到 workspace-write",
  "body": "要写工作区外的文件",
  "toolName": "pwsh",
  "openPath": "/#dsh-notifier=session-…",
  "actions": ["open", "allow"],
  "createdAt": 1736899200000
}
```

HTTP 侧另有 `GET /health`、`GET /config`（带 WebSocket token）、`GET /pending`、
`POST /action {token, action}`，全部只接受回环地址与回环 Host。

## 许可

[MIT](./LICENSE)
