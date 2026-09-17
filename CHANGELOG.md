# 变更记录

## 0.2.2

### 修复

- **选了「在 dsh 页面时不通知」，还是经常弹**（用户报）。
  根因：`pageIsActiveTab` 用
  `chrome.tabs.query({ url, active: true, lastFocusedWindow: true })` 的**"有没有结果"**
  当"用户正在看这个页面"。真实 Chrome 里 `tabs.query` 的 `active` / `lastFocusedWindow`
  这两个过滤参数并不可靠 —— 一旦过滤失效，这个判据就退化成"浏览器里存在 dsh 标签即算在看"，
  于是人在别的窗口里也被判成 `page-focused`。
  修法：**只按 url 查 dsh 标签，活动性由标签自己的 `active` / `windowId` 字段用 JS 判断**，
  再问那个窗口有没有焦点（`chrome.windows.get`）；拿不到 windowId 时才退回
  `getLastFocused()`。这样"存在标签"和"人在看"再也不会混为一谈。
  回归测试：`test/extension.mjs` 的「dsh 标签在**别的窗口**里挂着 → 照常弹」、
  「内容脚本的报告过期后，改用"活动标签"兜底判据」；
  测试里的假 `chrome.tabs.query` 也改成**照真实行为只按 url 过滤** ——
  早先它按 `query.active` 过滤，正好把这个 bug 盖住了。
- **选了「永久」停留，横幅过一会儿还是自己消失**（用户报）。
  根因：`chrome.notifications.create` 一直写死 `requireInteraction: false`，
  等于告诉 Windows"这条不用一直留着"，于是系统按自己的"通知显示时长"（默认几秒）
  把横幅收走 —— 面板里选的"永久"只管了扩展这边的定时器，管不到系统。
  修法：**时长决定 `requireInteraction`** —— 选「永久」（`timeoutSec === 0`）时传 `true`，
  选具体秒数时传 `false`（由扩展自己定时撤下）。
  早期"`requireInteraction: true` 在 Windows 上只进通知中心、不弹横幅"的观察因此被推翻：
  现在按用户的显式选择走，并在扩展面板里写清楚横幅不出现时该查哪里
  （系统 → 通知 → Google Chrome 是否静音 / 通知显示时长 / 勿扰）。
  回归测试：`test/extension.mjs` 的「停留时长「永久」…」「停留时长选了 15 秒…」
  「永久保留时不会被任何定时器收走」。

### 变更

- 扩展构建代号 `EXTENSION_BUILD`：`4` → `5`（宿主 `/config` 的 `clientList[].build` 能看到）。
  这次改了扩展代码，**装过旧版的要在 `chrome://extensions` 里点一次刷新**。
- 扩展面板「通知停留时长」的说明改写：写清「永久」是怎么生效的，以及横幅仍不出现时该查什么。
- `test/extension.mjs` 的假 `chrome.windows` 改成按窗口 id 判焦点（`get(windowId)`），
  这样"dsh 标签挂在后台窗口里"这种多窗口场景才测得出。

## 0.2.1

### 修复

- **一条消息里连续申请两次权限，第二条通知不会弹**（用户报：「我需要连续同意几个允许权限请求，
  这样会把通知漏掉」）。根因有两道闸门，都在宿主侧，都会让用户少看到一条通知：
  1. `cooldownMs`（默认 1000ms，本机被调到 30 秒）按**会话**计时：第二条审批落在窗口内就
     直接 `passed-through:cooldown`，压根不进通知通道；
  2. "同一会话里上一条审批作废"：新审批到达时对旧记录调 `finish(stale, 'superseded')`。
     `finish` 的语义是"有人作答了"，于是那条**没人点过**的申请被静默判成 allowed-once，
     工具直接执行，而且它的 token 从此再点也点不动。
  修法：**冷却整个删掉**（不再有 `cooldownMs`，也不再有 `cooled()`），审批不再互相作废 ——
  每条审批各有 token、全部留在队列里、各自独立可作答。
  通知中心里"一条盖一条"由扩展负责（它只对 idle 做替换），和队列里的记录是两回事。
  回归测试：`test/smoke.mjs` 的「连续两次审批各自弹一条通知，且各自都能作答」、
  「配置里没有冷却字段」。
- `normalizeConfig` 改成**白名单**逐字段取值（原来是 `Object.assign` 照搬整个对象）：
  用户的 `cordis.patch.yml` 里残留的老字段（比如 `cooldownMs`）不会再有办法漏进运行配置。

### 变更

- 去掉配置项 `cooldownMs`、运行时状态 `lastNotifyAt`、以及 `passed-through:cooldown` 这个取值。
  老配置里留着 `cooldownMs` 也不会报错，只是不再有任何效果。

## 0.2.0

### 修复

- **通知里点「允许」，网页那张审批卡不消失**（用户报：「这次允许我在通知里面点了，但还是没有作用，网页里没有收到我的允许」）。
  根因：网页的审批卡由**浏览器那一半**渲染，而宿主插件抢先把 `approval/request` 瀑布结算掉了；
  `api-remotes` 只在"收到客户端答复"时才向浏览器回 cancel 帧，于是转发给页面的那条 waterfall
  被丢掉，卡片永远停在「等待审批」（宿主侧 `lastApproval.outcome` 却已经是
  `answered-from-notification:allowed-once`、工具也真的执行了）。
  修法：通知的「允许」在送达宿主之后，再用 `chrome.scripting.executeScript` **让网页自己按一次
  那个「允许一次」**，让网页沿它本来的通路作答 → 卡片消失、宿主拿到同一个结果。
  页内这步失败只影响卡片能否自动消失，**不影响工具执行**。
  回归测试：`test/repro-allow-card.mjs`（真实 cordis + 真实 api-remotes + 假网页）、
  `test/page-approval.mjs`。
- **人就在 dsh 网页前面，通知还是会弹**。旧代码只看内容脚本报上来的状态，状态**缺失**时
  等价于"没人在看"。而状态常常是缺的：Service Worker 刚被回收、扩展刚刷新、页面刚 reload。
  修法：状态新鲜（30 秒内有报告）时以内容脚本的 `document.hasFocus()` 为准；
  缺失或陈旧时改用现问现答的判据（`chrome.tabs.query({active:true,lastFocusedWindow:true})`
  + 窗口是否有焦点）；`port.onDisconnect` 不再把 `focused` 抹成 `false`。
- **过期的通知点了没反应**：宿主要么回 `expired`（这条早被作答/撤下）。
  现在会收掉通知，而不是把它留成一颗"点了没反应"的死按钮。
- **WebSocket 帧的声明长度可以换内存**：超大长度的帧现在在读长度头时就拒绝（默认上限 64 KiB），
  不再等"收齐"才判。

### 变更

- 扩展新增 `scripting` 权限（页内按「允许」要用）。老用户升级时 Chrome 会提示新增权限
  并**暂停扩展**，需要手动同意一次。
- 扩展构建代号 `EXTENSION_BUILD`：`2` → `4`（宿主 `/config` 的 `clientList[].build` 能看到，
  用来分辨"代码没生效"和"真 bug"）。
- 同一实例开着多个标签时，页内点击优先动**当前活动**的那个标签。
- 清理 `extension/shared.js` 里三个没人用的导出（`setOriginState` / `getOriginState` / `setToken`）。

### 测试

- 新增四类回归：卡片是否消失（真实 cordis + api-remotes）、页内点击规则（假 DOM）、
  该不弹就别弹（活动标签 / 断线窗口 / 后台标签 / 别的应用 / 标签关掉）、
  可发布性（版本号一致、权限集合、清单文件齐全）。
- 新增诊断脚本：`test/diagnose-idle-repeat.mjs`、`scripts/watch-approval.mjs`、`scripts/watch-idle.mjs`。

## 0.1.0

- 首个版本：宿主插件（`approval/request` + `api-session/status` 钩子、回环 HTTP + WebSocket）
  + Chrome MV3 扩展（系统通知、按钮作答、精确激活标签页），取代旧 `dsh-attention` 的
  PowerShell 方案。
