# 变更记录

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
