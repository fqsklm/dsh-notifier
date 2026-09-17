/**
 * dsh-notifier 扩展 — 后台 Service Worker。
 *
 * 架构：
 *   dsh 宿主插件  ──WebSocket(回环端口)──▶  本 SW  ──chrome.notifications──▶  Windows 通知中心
 *        ▲                                    │
 *        └──────── decision / focus ──────────┘
 *
 * 通知按钮（Windows 只给两个按钮位，超出的会被系统静默丢掉）：
 *   - 审批：回到对话 / 允许（拒绝的流程是点「回到对话」回网页里点）
 *   - 一轮结束：回到对话 / 知道了
 *
 * 关于"回到对话"：不用窗口标题猜，而是用 chrome.tabs / chrome.windows
 * 精确激活 dsh 标签；标签已经开着就顺便让它切到对应会话。
 */
import { buttonTitle, getConfig, health } from './shared.js'
import { allowInPage } from './page-approval.js'

const WS_PATH = '/dsh-notifier/ws'
const RECONNECT_MIN_MS = 1500
const RECONNECT_MAX_MS = 30000
const ALARM_NAME = 'dsh-notifier-keepalive'
const STORE_KEY = 'notificationMap'
/** 通知 id 前缀：`dsh-notifier-<token>`，确定性 id 是判重和重建记忆的依据。 */
const NOTIFICATION_ID_PREFIX = 'dsh-notifier-'
/**
 * 扩展这一半的构建代号，随 `ready` / `state` 一起报给宿主。
 *
 * 为什么需要它：宿主是 Node ESM（改了必须重启），扩展是 Service Worker
 * （改了必须在 chrome://extensions 里点刷新）。两边版本不一致时，症状会伪装成
 * 纯粹的"功能不生效"—— 光看现象分不清是代码写错了还是新代码根本没加载。
 * 这一条就是用来一眼分辨的：/health 的 clientList 里会带上它，
 * 版本对不上就说明扩展没刷新。
 */
const EXTENSION_BUILD = '6'

/** origin -> { tabs:Set<number>, visible:boolean, focused:boolean } */
const origins = new Map()
/** origin -> WebSocket */
const sockets = new Map()
/** notificationId -> { token, origin, sessionId, kind, title, actions, pending } */
const notifications = new Map()
/** notificationId -> setTimeout 句柄 */
const timers = new Map()

let storeLoaded = false

function log(...args) {
  console.log('[dsh-notifier]', ...args)
}

function normaliseOrigin(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

function stateOf(origin) {
  let state = origins.get(origin)
  if (!state) {
    state = { tabs: new Set(), visible: false, focused: false, since: Date.now() }
    origins.set(origin, state)
  }
  return state
}

/**
 * 已经弹过的通知 id 集合。
 *
 * 为什么单独记一份：宿主会在每次客户端重连时**全量重发队列**（这是"你不在时
 * 错过的审批回来还能补弹"的保证）。如果扩展对重发的东西不判重，就会重复弹 ——
 * 用户看到的现象就是"每次重新加载扩展，它就自动给我弹几条"。
 *
 * 这份集合只在"我们确实创建过这条通知"时加入，与通知中心里的实际状态解耦，
 * 所以即使通知已经被划掉，重发也不会再弹一次。
 *
 * ⚠️ 它存在 `chrome.storage.session` 里，而**重新加载扩展会把 session 存储清空**
 * （只有浏览器进程活着才保留）。所以刷新扩展之后集合是空的，通知中心里那几条
 * 却还在 —— 宿主紧接着重发快照，就被当成"没见过"重新弹一遍，**而且是在每次刷新
 * 之后都多一条**。修法是启动时以通知中心为准重建这份记忆：通知 id 是
 * `dsh-notifier-<token>` 这种确定性 id，通知中心里还存在的，就一定是弹过的。
 */
const delivered = new Set()

/**
 * 正在处理中的 token。
 *
 * 宿主对同一个 token 可能连发两帧：新连接建立时的全量 `snapshot`，以及紧接着的
 * `pending`（或者同一连接上的两次广播）。`dispatchNotification` 里还有若干次
 * `await`（读配置、建通知），两次调用会**同时**通过 `delivered` 检查，
 * 于是同一个 token 被弹两次。这个集合就是那道同步闸门。
 */
const dispatching = new Set()

async function loadStore() {
  if (storeLoaded) return
  storeLoaded = true
  try {
    const stored = await chrome.storage.session.get(STORE_KEY)
    const rows = stored?.[STORE_KEY]
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && row.id) notifications.set(row.id, row)
      }
    }
    const deliveredRows = stored?.delivered
    if (Array.isArray(deliveredRows)) {
      for (const id of deliveredRows) if (typeof id === 'string') delivered.add(id)
    }
  } catch (error) {
    log('读取通知映射失败', error)
  }
  // 以通知中心为准补齐：扩展刚刷新过时 session 存储是空的，但通知中心里
  // 还留着我们弹过的条目 —— 它们也算"已经弹过"，不能再弹一遍。
  try {
    const live = await chrome.notifications.getAll()
    for (const id of Object.keys(live ?? {})) {
      if (id.startsWith(NOTIFICATION_ID_PREFIX)) delivered.add(id)
    }
  } catch (error) {
    log('读取通知中心失败', error)
  }
}

async function persistStore() {
  try {
    await chrome.storage.session.set({ [STORE_KEY]: [...notifications.values()], delivered: [...delivered] })
  } catch (error) {
    log('保存通知映射失败', error)
  }
}

// ---------------------------------------------------------------- WebSocket

function socketFor(origin) {
  const socket = sockets.get(origin)
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket
  return null
}

async function ensureConnection(origin) {
  if (!origin || socketFor(origin)) return
  const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false)
  if (!allowed) {
    log('没有该来源的权限，跳过', origin)
    return
  }
  const info = await health(origin)
  if (!info?.ok || info.name !== 'dsh-notifier') {
    log('不是 dsh-notifier 宿主，跳过', origin)
    return
  }
  const config = await getConfig(origin)
  const token = config?.token
  if (!token) {
    log('取不到 token，跳过', origin)
    return
  }
  if (config.enabled === false) log('宿主侧通知总开关是关闭的', origin)

  const url = `${origin.replace(/^http/, 'ws')}${WS_PATH}?t=${encodeURIComponent(token)}`
  const socket = new WebSocket(url)
  sockets.set(origin, socket)

  socket.addEventListener('open', () => {
    log('已连接', origin)
    // 注意：`state` 必须在这里再取一次。本作用域里再写 `const state = ...`
    // 会让这一行掉进暂时性死区（TDZ），open 时直接 ReferenceError，
    // 结果就是"连上了但从不报身份"——宿主那边表现为一条多余的 unknown 连接。
    const state = stateOf(origin)
    state.attempts = 0
    send(origin, { type: 'ready', client: 'extension', build: EXTENSION_BUILD, origin, focused: state.focused && state.visible })
    // 启动对账时排队的 dismiss，现在通道通了，补发出去。
    flushPendingDismiss(origin)
  })
  socket.addEventListener('message', (event) => {
    let message = null
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    void onHostMessage(origin, message)
  })
  socket.addEventListener('close', () => {
    log('连接断开', origin)
    // 只有"当前这条"才配把映射删掉：旧 socket 的 close 事件晚到时，
    // 不能顺手把刚建好的新通道删了（否则会再连一条，宿主那边就多一条 extension）。
    if (sockets.get(origin) === socket) {
      sockets.delete(origin)
      scheduleReconnect(origin)
    }
  })
  socket.addEventListener('error', () => {
    try {
      socket.close()
    } catch {
      /* 忽略 */
    }
  })
}

function scheduleReconnect(origin) {
  const state = stateOf(origin)
  state.attempts = (state.attempts ?? 0) + 1
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(6, state.attempts))
  // 记下句柄：SW 被回收时这个定时器会跟着没掉，但它留下的"隐式重试"很容易
  // 变成一次连出两条通道，所以能清就清。
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    if (origins.has(origin)) void ensureConnection(origin)
  }, delay)
}

/**
 * 发一条状态消息。带上 build 是为了让宿主能判断"扩展是不是还在跑旧代码"：
 * 版本对不上时，症状和真 bug 一模一样，很难分辨。
 */
function sendState(origin, focused) {
  send(origin, { type: 'state', build: EXTENSION_BUILD, origin, focused })
}

function send(origin, payload) {
  const socket = socketFor(origin)
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch (error) {
    log('发送失败', error)
    return false
  }
}

/**
 * 待补发的 dismiss：SW 启动时对账发现"通知中心里已经没有了、但记录还标着待作答"
 * 的审批，需要告诉宿主把它清掉；可那时 WebSocket 十有八九还没连上。
 * 先排队，通道一 open 就补发 —— 只排 token，不排大对象。
 */
const pendingDismiss = new Map()

function queueDismiss(origin, token) {
  if (!origin || !token) return
  if (send(origin, { type: 'decision', token, action: 'dismiss' })) return
  const key = `${origin}|${token}`
  if (pendingDismiss.has(key)) return
  pendingDismiss.set(key, { origin, token })
  log('通道未就绪，dismiss 先排队', token)
}

/** 通道刚连上：把排队里的 dismiss 补发出去。 */
function flushPendingDismiss(origin) {
  for (const [key, entry] of [...pendingDismiss]) {
    if (entry.origin !== origin) continue
    if (send(origin, { type: 'decision', token: entry.token, action: 'dismiss' })) {
      pendingDismiss.delete(key)
      log('补发 dismiss', entry.token)
    }
  }
}

// ------------------------------------------------------- 决定的可靠送达

const ACK_TIMEOUT_MS = 3000

/** 待 ack 的决定：token -> { resolve, timer } */
const awaitingAck = new Map()

/** 宿主的回执：只认它，不认"send 的时候 socket 是开着的"。 */
function resolveAck(token, result) {
  const waiter = awaitingAck.get(token)
  if (!waiter) return
  clearTimeout(waiter.timer)
  awaitingAck.delete(token)
  waiter.resolve(result)
}

/** 用 WebSocket 发一条决定，并等宿主的 ack。超时视为失败（通道可能已经死了）。 */
function askOverSocket(origin, token, action) {
  return new Promise((resolve) => {
    if (!send(origin, { type: 'decision', token, action })) {
      resolve({ ok: false, error: 'send-failed' })
      return
    }
    const timer = setTimeout(() => {
      awaitingAck.delete(token)
      resolve({ ok: false, error: 'ack-timeout' })
    }, ACK_TIMEOUT_MS)
    awaitingAck.set(token, { resolve, timer })
  })
}

/** 用 HTTP 发一条决定。宿主回 200 = 它确实受理了。 */
async function askOverHttp(origin, token, action) {
  try {
    const response = await fetch(`${origin}/dsh-notifier/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ token, action }),
    })
    let result = null
    try {
      result = await response.json()
    } catch {
      /* 没有 JSON 就看状态码 */
    }
    if (result && typeof result.ok === 'boolean') return result
    return { ok: response.ok, error: response.ok ? undefined : `http-${response.status}` }
  } catch (error) {
    return { ok: false, error: `http-failed:${String(error?.message ?? error)}` }
  }
}

/**
 * 把一条决定送到宿主，并且**确认它真的到了**。
 *
 * 为什么不能只 `send()` 就完事：`send()` 返回的只是"socket 当时是 OPEN"，
 * 不等于宿主收到了。两种情况下它会静默丢掉：
 *   1. 通道其实已经死了（SW 被回收、宿主重启了换了 token），send 却还报成功；
 *   2. 宿主收到了但判定这条待办已经过期（`{ok:false, error:'expired'}`）。
 * 以前的代码两种情况都照样把通知清掉 —— 用户看到的现象就是"点了允许，
 * 通知没了，但审批根本没通过"。所以这里：ack 成功才算成功，否则走 HTTP 兜底，
 * 两条都不行就返回 false，由调用方**把通知留着**并提示用户。
 */
async function deliverDecision(origin, token, action) {
  const viaSocket = await askOverSocket(origin, token, action)
  if (viaSocket.ok) return viaSocket
  log(`WebSocket 送达失败（${viaSocket.error}），改用 HTTP 重投`, token)
  const viaHttp = await askOverHttp(origin, token, action)
  if (viaHttp.ok) {
    log('HTTP 重投成功', token)
    return viaHttp
  }
  log(`两种通路都没送达：socket=${viaSocket.error} http=${viaHttp.error}`, token)
  return { ok: false, error: `${viaSocket.error}/${viaHttp.error}` }
}

// ---------------------------------------------------------------- 通知

function notificationIdFor(token) {
  return `${NOTIFICATION_ID_PREFIX}${token}`
}

/**
 * 页面就在眼前（可见 + 窗口有焦点）时不打扰。
 *
 * 这里**不能**只看内容脚本报上来的那份状态：那份状态可能是**缺的**
 * （Service Worker 刚被回收、扩展刚刷新、页面刚 reload，内容脚本还没连上），
 * 而缺状态的老写法等价于"没人在看" → 于是人明明坐在 dsh 页面前，通知还是弹了。
 * 实测（test/diagnose-idle-repeat.mjs 的场景 A）：活动标签就是 dsh、窗口有焦点，
 * 但只要状态缺失，判决就是 `page-away`。
 *
 * 所以补一个**新鲜且权威**的判据：dsh 页面是不是当前活动窗口里的活动标签？
 * （chrome.tabs.query 是现问现答，不依赖任何缓存。）
 */
const REPORT_FRESH_MS = 30000

/** 内容脚本那份报告还新鲜吗（断开时 lastSeen 就停在那一刻，自然变陈旧）。 */
function reportIsFresh(state) {
  return Boolean(state) && Number.isFinite(state.lastSeen) && Date.now() - state.lastSeen < REPORT_FRESH_MS
}

/**
 * dsh 页面是不是"当前活动窗口里的活动标签"。
 *
 * 这个判据必须**同时**满足两条，少一条都会误判成"人在看"（用户报的
 * "我在 dsh 网页里它还弹"就是从这里漏出去的）：
 *
 * 1. 某个 dsh 标签自己是 `active`（它在自己窗口里被选中）；
 * 2. 那个标签所在的窗口 == **系统当前聚焦的窗口**（`windows.getLastFocused()`）。
 *
 * 只查 url、把"有结果"当"在看"是错的（老写法，过滤一旦失效就退化成"存在即在看"）；
 * 只看 `tab.active` 也不够 —— 浏览器在后台时，它的活动标签依然 `active === true`。
 *
 * ⚠️ 这里**不**用 `tabs.query` 的 `active` / `lastFocusedWindow` 过滤参数，判据全部自己算。
 */
async function pageIsActiveTab(origin) {
  if (!origin) return false
  try {
    const tabs = await chrome.tabs.query({ url: [`${origin}/*`] })
    const active = tabs.filter((tab) => tab?.active === true)
    if (active.length === 0) return false
    let focusedWindow = null
    try {
      focusedWindow = await chrome.windows.getLastFocused()
    } catch {
      /* 取不到就当"没有焦点窗口"，下面按否决处理 */
    }
    if (!focusedWindow) return false
    // 窗口自己就报"没焦点"（用户在别的应用里）：直接否掉。
    if (focusedWindow.focused === false) return false
    const focusedId = focusedWindow.id
    if (typeof focusedId !== 'number') return true
    // 活动的 dsh 标签必须在**这个**聚焦窗口里；在别的窗口 = 那个窗口在后台。
    return active.some((tab) => tab.windowId === focusedId)
  } catch (error) {
    log('查询活动标签失败', error)
    return false
  }
}

/**
 * 人是不是正在看这个 dsh 页面。
 *
 * 两路证据，**内容脚本的新鲜自述优先**：
 *
 * - 内容脚本（`content.js`）每 20 秒心跳一次，报 `document.visibilityState` 和
 *   `document.hasFocus()`。它新鲜时就是最终结论 —— 它是唯一能分辨
 *   "窗口有焦点但用户在别的应用里"（`hasFocus()` 为 false）的信号。
 * - 报告缺失或已过期（Service Worker 刚被回收、页面刚 reload）：退回
 *   `pageIsActiveTab()` —— 现问现答，看 dsh 标签是不是"聚焦窗口里的活动标签"。
 */
async function pageIsWatching(origin) {
  const state = origins.get(origin)
  if (reportIsFresh(state)) {
    return state.visible === true && state.focused === true
  }
  return await pageIsActiveTab(origin)
}

/**
 * 该不该弹。
 * - 面板里的"强制弹"开关打开时永远弹，方便排查"通知怎么没出来"。
 * - 同一会话同一类事件在短时间内只弹一次（见 claimFor）：会话反复 running→idle
 *   时宿主可能重发同一条提醒，重复弹很烦人。
 * - 其余情况在"页面可见且窗口有焦点"时跳过，因为网页里那张卡片本来就摆在眼前。
 */
async function shouldShow(item) {
  if (await forceShow()) return { show: true, reason: 'forced' }
  const claim = claimFor(item)
  if (!claim.ok) return { show: false, reason: `duplicate:${claim.ageSec}s` }
  if (await pageIsWatching(item?.origin ?? '')) return { show: false, reason: 'page-focused' }
  return { show: true, reason: 'page-away' }
}

async function forceShow() {
  try {
    const stored = await chrome.storage.local.get('forceShow')
    return stored?.forceShow === true
  } catch {
    return false
  }
}

/** 同一会话同一类事件的去重窗口：期内不重复弹。 */
const CLAIM_TTL_MS = 30000
const claims = new Map()

function claimKey(item) {
  const sid = item?.sessionId ?? ''
  const kind = item?.kind ?? '?'
  return sid ? `${kind}:${sid}` : `${kind}:${item?.token ?? ''}`
}

function claimFor(item) {
  if (!item) return { ok: true }
  const key = claimKey(item)
  const last = claims.get(key)
  const now = Date.now()
  if (last !== undefined) {
    const age = now - last
    if (age < CLAIM_TTL_MS) return { ok: false, ageSec: Math.round(age / 1000) }
  }
  claims.set(key, now)
  for (const [entryKey, at] of claims) {
    if (now - at > CLAIM_TTL_MS * 4) claims.delete(entryKey)
  }
  return { ok: true }
}

/** 会话重新跑起来时清掉它的去重记录，这样下一轮结束还能提醒。 */
function releaseClaims(sessionId) {
  for (const key of [...claims.keys()]) {
    if (key.endsWith(`:${sessionId}`)) claims.delete(key)
  }
}

/**
 * 同一会话又来了一条同类通知时，把上一条从通知中心收掉 —— 否则"通知永久保留"
 * 就意味着跑 N 轮就堆 N 条。
 *
 * 只对 idle 生效：审批是"待作答"的东西，不该被自动撤掉。
 */
async function replaceForSession(kind, sessionId, keepToken) {
  if (kind !== 'idle' || !sessionId) return
  for (const row of [...notifications.values()]) {
    if (row.kind !== 'idle') continue
    if (row.sessionId !== sessionId) continue
    if (row.token === keepToken) continue
    log('同会话上一条结束提醒已被新的取代，收掉旧的', row.token)
    await clearNotification(row.id)
  }
}

/** 通知停留时长（秒）。0 = 一直留着，直到你自己划掉。 */
const DEFAULT_NOTIFICATION_TIMEOUT_SEC = 0

async function notificationTimeoutSec() {
  try {
    const stored = await chrome.storage.local.get('notificationTimeoutSec')
    const value = Number(stored?.notificationTimeoutSec)
    if (Number.isFinite(value) && value >= 0) return value
  } catch {
    /* 读不到就用默认 */
  }
  return DEFAULT_NOTIFICATION_TIMEOUT_SEC
}

/**
 * 通知的显示方式。
 *
 * **时长决定 `requireInteraction`**（这是"选了永久却过一会儿自己消失"的根因）：
 *
 * - 用户在面板里选「永久」（`timeoutSec === 0`）→ `requireInteraction: true`。
 *   只有这个标志才是**告诉 Windows"这条别按系统时长收走"**的唯一手段；
 *   一直写死 `false` 等于明说"不用一直留着"，于是系统（设置里的"通知显示时长"，
 *   默认几秒）到点就把横幅收走 —— 用户看到的就是"我选了永久，它还是自己消失"。
 * - 选了具体时长（15 秒 / 1 分钟 …）→ `requireInteraction: false`，
 *   由扩展自己定时收掉，系统那边不必替我们保留。
 *
 * `priority: 2`（高优先级）保持不变。
 *
 * ⚠️ 关于 `requireInteraction: true` 会不会"只进通知中心、不弹横幅"：早期在
 * Windows 10 上确实观察到过这种表现，当时因此把它写死成 false。但那样换来的是
 * "永久也留不住"，两个毛病同时存在。现在按用户的显式选择走，并且在扩展面板里
 * 写清楚：如果横幅还是不出现，去查 **系统 → 通知 → Google Chrome** 是否被静音，
 * 以及"通知显示时长"和「请勿打扰」。
 */
async function showNotification(origin, item) {
  await loadStore()
  const id = notificationIdFor(item.token)
  // 同会话上一条"对话结束"先收掉，避免永久保留把通知中心堆满。
  await replaceForSession(item.kind, item.sessionId, item.token)
  // 同一个 token 又发一次：先把旧的定时器和旧记录清掉，避免泄漏。
  const previous = timers.get(id)
  if (previous) {
    clearTimeout(previous)
    timers.delete(id)
  }
  notifications.delete(id)
  const buttons = (item.actions ?? ['open']).map((action) => ({ title: buttonTitle(action) }))
  const message = [item.subtitle, item.body].filter((part) => part && String(part).trim()).join('\n')
  const timeoutSec = await notificationTimeoutSec()
  const permanent = timeoutSec <= 0
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: String(item.title ?? 'dsh 提醒').slice(0, 120),
      message: (message || String(item.session ?? '')).slice(0, 512),
      contextMessage: String(item.session ?? '').slice(0, 80),
      buttons,
      priority: 2,
      requireInteraction: permanent,
      silent: false,
    })
  } catch (error) {
    log('创建通知失败', error)
    return
  }
  notifications.set(id, {
    id,
    token: item.token,
    origin,
    sessionId: item.sessionId,
    kind: item.kind,
    title: item.title,
    // 这条申请的原文：点「允许」之后要拿它去网页里认准是**哪一张**审批卡，
    // 别点错另一条申请（见 page-approval.js 的关联判断）。
    reason: String(item.body ?? ''),
    actions: item.actions ?? ['open'],
    // 宿主还会等这条通知的后续动作吗？
    // 审批 = true（还要允许）；一轮结束 = false。
    pending: item.kind === 'approval',
    createdAt: Date.now(),
  })
  // 记下"这条已经弹过"：宿主重连时重发同一 token 也不会再弹。
  delivered.add(id)
  void persistStore()
  // 停留时长：0 = 永久（不设定时器，靠 requireInteraction 让系统也别收），
  // 正数 = 到点由扩展自己撤下。
  if (!permanent) {
    const timer = setTimeout(() => void clearNotification(id), timeoutSec * 1000)
    timers.set(id, timer)
  }
}

/**
 * 按钮文案见 `shared.js` 的 `buttonTitle`（纯映射放那边，宿主测试要用来做
 * 描述一致性校验）。这里只保留说明：审批的按钮就是 `['open','allow']`，
 * 没有「拒绝」按钮 —— 拒绝走「回到对话」回网页里点。
 */

async function clearNotification(id, { announce = true } = {}) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const row = notifications.get(id)
  if (row) releaseClaims(row.sessionId)
  notifications.delete(id)
  void persistStore()
  // 拿掉一条"还在等作答"的审批通知时，默认要告诉宿主 —— 否则那条待办永远留在
  // 宿主队列里（列在 /pending、每次重连的 snapshot 都带着它），而这个 token
  // 又已经进过 delivered，于是这个审批再也弹不出通知。用户划掉横幅、通知到点
  // 自动收掉、扩展重载后对账，走的都是这里。
  //
  // `announce: false` 用在两类场合：用户已经作答（决定发回宿主了），
  // 或者用户要的就是"回网页里作答"（点「回到对话」）—— 那时审批得继续悬着。
  if (announce && row?.kind === 'approval' && row.pending === true) queueDismiss(row.origin, row.token)
  try {
    await chrome.notifications.clear(id)
  } catch {
    /* 已经不在了 */
  }
}

async function clearByToken(token) {
  for (const row of [...notifications.values()]) {
    if (row.token === token) await clearNotification(row.id)
  }
}

// ---------------------------------------------------------------- 页内作答

/**
 * 「通知里点了允许」的最后一步：让**网页自己**按一次那个「允许一次」。
 *
 * 为什么非要这一步（根因）：网页里的审批卡是浏览器那一半渲染的，
 * 宿主直接作答虽然能让工具执行，但浏览器那一半的瀑布永远拿不到结果 ——
 * api-remotes 只在"收到客户端答复"时才回 cancel 帧，于是卡片一直停在
 * 「等待审批」。用户看到的就是"我点了允许，网页里没有反应"。
 * 页内点一次，网页沿自己的通路作答，卡片消失、宿主拿到同样的结果。
 *
 * 这一步失败不影响工具执行（决定已经送达宿主了），只影响卡片会不会自己消失，
 * 所以失败只记日志，不打扰用户。
 */
async function clickAllowInPage(origin, reason) {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: [`${origin}/*`] })
  } catch (error) {
    return { ok: false, reason: `query-failed:${String(error?.message ?? error)}` }
  }
  const usable = tabs.filter((tab) => typeof tab.id === 'number')
  if (usable.length === 0) return { ok: false, reason: 'no-tab' }
  // 同一个 dsh 实例可能开着好几个标签（它们都连着同一条 remote event 流，
  // 所以每张卡片在每个标签里都存在）。优先动**当前活动/可见**的那个：
  // 背景标签里的卡片可能是陈旧的，而且用户的视线也在前台那个。
  const target = usable.find((tab) => tab.active === true) ?? usable[0]
  const result = await allowInPage(target.id, reason)
  if (result?.ok) {
    log('已在网页里按下「允许」', JSON.stringify(result))
  } else {
    log('没能在网页里按下「允许」（审批仍已通过，卡片需手动处理）', JSON.stringify(result))
  }
  return result
}

// ---------------------------------------------------------------- 回到对话

/** 抢前台的速率闸门：3 秒内只允许一次，避免任何来回把用户按在 dsh 标签上。 */
const FOCUS_COOLDOWN_MS = 3000
let lastFocusAt = 0
let focusBurst = 0

async function focusSession(origin, sessionId) {
  const now = Date.now()
  if (now - lastFocusAt < FOCUS_COOLDOWN_MS) {
    focusBurst += 1
    if (focusBurst === 1) log(`已忽略重复的「回到对话」（${FOCUS_COOLDOWN_MS}ms 内）`)
    if (focusBurst % 20 === 0) log(`警告：「回到对话」被连续触发 ${focusBurst} 次，可能有循环`)
    return { ok: true, throttled: true }
  }
  lastFocusAt = now
  if (focusBurst > 0) {
    log(`「回到对话」恢复调用（此前被节流 ${focusBurst} 次）`)
    focusBurst = 0
  }

  const tabs = await chrome.tabs.query({ url: [`${origin}/*`] })
  const target = tabs.find((tab) => typeof tab.id === 'number')
  if (!target || typeof target.id !== 'number') {
    await chrome.tabs.create({ url: `${origin}/#dsh-notifier=${encodeURIComponent(sessionId ?? '')}` })
    return { ok: true, created: true }
  }
  // 标签已经开着：把窗口抬起来、激活它，然后直接让页面切会话，
  // 不动 URL —— 不会多开标签，也不会触发页面重载。
  if (typeof target.windowId === 'number') {
    try {
      // 不要 drawAttention：它会让任务栏图标一直闪，用户切走时还在拉人。
      await chrome.windows.update(target.windowId, { focused: true })
    } catch (error) {
      log('窗口激活失败', error)
    }
  }
  try {
    await chrome.tabs.update(target.id, { active: true })
  } catch (error) {
    log('标签激活失败', error)
  }
  if (sessionId) send(origin, { type: 'focus-request', sessionId })
  return { ok: true, tabId: target.id }
}

// ---------------------------------------------------------------- 宿主消息

async function onHostMessage(origin, message) {
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'hello':
      return
    case 'snapshot':
      // 只在"从来没弹过这条"时才补弹。
      // 不判重的话，每次扩展重连（SW 被回收后唤醒、页面刷新、宿主重连都会发
      // snapshot）都会把还挂着的记录重新弹一遍。
      for (const item of message.items ?? []) {
        await remindIfMissing(origin, item)
      }
      return
    case 'pending':
      if (message.item) await dispatchNotification(origin, message.item)
      return
    case 'resolved':
      await clearByToken(message.token)
      return
    case 'ack':
      // 宿主对某条决定的回执：这才是"送达成功"的唯一凭据。
      resolveAck(message.token, message.result ?? { ok: false, error: 'empty-ack' })
      return
    case 'focus':
      await focusSession(origin, message.sessionId)
      return
    default:
      return
  }
}

/** 补弹用的版本：只有"从来没弹过这条"才创建。 */
async function remindIfMissing(origin, item) {
  if (!item?.token) return
  await loadStore()
  const id = notificationIdFor(item.token)
  if (delivered.has(id)) {
    lastDecision = { at: Date.now(), token: item.token, kind: item.kind, show: false, reason: 'already-delivered', page: pageSnapshot(origin) }
    return
  }
  await dispatchNotification(origin, item)
}

/** 决定弹不弹，并把判断结果记下来给面板看。 */
async function dispatchNotification(origin, item) {
  if (!item?.token) return
  await loadStore()
  const id = notificationIdFor(item.token)
  // 弹过就不再弹（哪怕用户已经把它划掉）—— 重连重发的场景全靠这一条挡住。
  if (delivered.has(id)) {
    lastDecision = { at: Date.now(), token: item.token, kind: item.kind, show: false, reason: 'already-delivered', page: pageSnapshot(origin) }
    return
  }
  // 同步闸门：同一个 token 的两帧（snapshot + pending）可能交错进来，
  // 上面那次 await 之后就都会通过 delivered 检查 —— 于是弹两条。
  // 这里在**任何 await 之前**占位，第二个调用直接退出。
  if (dispatching.has(item.token)) {
    lastDecision = { at: Date.now(), token: item.token, kind: item.kind, show: false, reason: 'already-dispatching', page: pageSnapshot(origin) }
    return
  }
  dispatching.add(item.token)
  try {
    const decision = await shouldShow({ ...item, origin })
    lastDecision = { at: Date.now(), token: item.token, kind: item.kind, ...decision, page: pageSnapshot(origin) }
    if (!decision.show) {
      log(`跳过通知（${decision.reason}）`, item.token)
      return
    }
    await showNotification(origin, item)
  } finally {
    dispatching.delete(item.token)
  }
}

function pageSnapshot(origin) {
  const state = origins.get(origin)
  if (!state) return null
  return { visible: state.visible === true, focused: state.focused === true }
}

let lastDecision = null

// ---------------------------------------------------------------- 事件接线

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-page') return
  let origin = ''
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return
    const value = normaliseOrigin(message.origin)
    if (!value) return
    origin = value
    const state = stateOf(origin)
    if (typeof message.visible === 'boolean') state.visible = message.visible
    if (typeof message.focused === 'boolean') state.focused = message.focused
    state.lastSeen = Date.now()
    if (message.href) state.href = message.href
    void ensureConnection(origin)
    sendState(origin, state.focused && state.visible)
  })
  port.onDisconnect.addListener(() => {
    // 页面 reload / SW 被回收都会走到这里。**不要**把 focused 抹成 false：
    // 那等于"断言没人在看"，而这 3 秒的重连窗口里用户可能就坐在页面前
    // （实测症状：人就在 dsh 页里，通知照弹）。
    // 这里只标一个"这条报告不再新鲜"（lastSeen 停在断开那一刻），
    // 让 pageIsWatching 改用"活动标签"那个现问现答的判据兜底。
    if (origin) sendState(origin, false)
  })
})

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  void (async () => {
    await loadStore()
    const row = notifications.get(notificationId)
    if (!row) return
    const item = row.actions?.[buttonIndex]
    const action = item ?? (buttonIndex === 0 ? 'open' : buttonIndex === 1 ? 'allow' : 'reject')
    if (action === 'open') {
      await focusSession(row.origin, row.sessionId)
      // 「回到对话」：通知撤下。审批本身还悬着（记录留在宿主里），
      // 你回网页看完可以接着拒绝或允许 —— 所以这里**不能**对宿主说 dismiss。
      await clearNotification(notificationId, { announce: false })
      return
    }
    if (action === 'dismiss') {
      // 一轮结束的「知道了」：告诉宿主一声，让它把待办收掉。
      // 这条不是"作答"，送不到也不该把通知赖在屏幕上 —— 失败就排队等补发
      // （dismiss 对宿主是幂等的：第二次会回 expired，无害）。
      const result = await deliverDecision(row.origin, row.token, 'dismiss')
      if (!result.ok) queueDismiss(row.origin, row.token)
      await clearNotification(notificationId, { announce: false })
      return
    }
    await answerFromNotification(notificationId, action)
  })()
})

/**
 * 一条通知被作答（目前只有「允许」走这里）。
 *
 * 刻意单独拎出来（测试要直接调它，见 test/extension.mjs）：这是"点了允许到底
 * 发生了什么"的全部逻辑，藏在事件回调里就只能靠真机点通知来验。
 *
 * @param notificationId - 通知中心里的 id（`dsh-notifier-<token>`）
 * @param action - 'allow' | 'reject'
 * @returns 宿主回执；{ok:false} 表示没送达（通知会留着让用户重试）
 */
async function answerFromNotification(notificationId, action) {
  await loadStore()
  const row = notifications.get(notificationId)
  if (!row) return { ok: false, error: 'unknown-notification' }
  // 注意：这里**不能**再看 send() 的返回值就当作送达成功（老代码的 bug）。
  const result = await deliverDecision(row.origin, row.token, action)
  if (!result.ok) {
    if (String(result.error ?? '').split('/').includes('expired')) {
      // 宿主说这条待办已经不在队列里了：说明它已经被作答（或已被撤下、被新的替换）。
      // 这种情况**不能**把通知留着 —— 否则用户看着一条"点了没反应"的通知来回点，
      // 而审批其实早就处理完了（典型场景：先在网页里点了允许，再点通知里那条旧的）。
      // 注意 deliverDecision 失败时给的是 "socket错误/http错误" 这种合成串，所以要拆开看。
      log('这条待办已经不在宿主队列里（已作答/已撤下），收掉通知', row.token)
      await clearNotification(notificationId, { announce: false })
      return result
    }
    // 真的没送到（两条通路都失败）：把通知留在通知中心，让用户还能再点一次，
    // 同时把会话抬到前台 —— 至少别让他干等一个"看起来点了却没反应"的按钮。
    log('决定未能送达宿主，保留通知以便重试', row.token, result.error)
    await focusSession(row.origin, row.sessionId)
    return result
  }
  // 宿主确认受理后才撤下通知，并且不要补 dismiss 把还悬着的审批作废。
  await clearNotification(notificationId, { announce: false })
  // 允许之后还有收尾：让网页自己按一次那个按钮，网页那张审批卡才会消失
  // （宿主侧的作答不会通知浏览器那一半，见 clickAllowInPage 的注释）。
  // 顺序不能反：宿主先作答会把卡片撤掉，页内就没得点了。
  if (action === 'allow') await clickAllowInPage(row.origin, row.reason)
  return result
}

chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    await loadStore()
    const row = notifications.get(notificationId)
    if (!row) return
    await focusSession(row.origin, row.sessionId)
    await clearNotification(notificationId)
  })()
})

chrome.notifications.onClosed.addListener((notificationId) => {
  // 用户划掉、或被系统收走。**不在这里给宿主发 dismiss**：
  //   - 用户划掉／通知到点自动收：都是先经过 clearNotification，它已经发过 dismiss；
  //   - 点「回到对话」/ 已经作答：走的也是 clearNotification(announce:false)，
  //     在这里补一条会把"审批还悬着"给作废掉。
  // 这里只做本地清理：撇下映射、定时器，以及去重记录（否则这一轮会话在
  // CLAIM_TTL 内再结束一次就提醒不出来了）。
  const row = notifications.get(notificationId)
  if (row) releaseClaims(row.sessionId)
  notifications.delete(notificationId)
  const timer = timers.get(notificationId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(notificationId)
  }
  void persistStore()
})

chrome.tabs.onRemoved.addListener(() => {
  void rescanTabs()
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return
  if (!tab?.url) return
  const origin = normaliseOrigin(tab.url)
  if (origin) void ensureConnection(origin)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (!message || typeof message !== 'object') {
      sendResponse({ ok: false })
      return
    }
    if (message.type === 'status') {
      sendResponse({ ok: true, status: await describeStatus() })
      return
    }
    if (message.type === 'connect') {
      const origin = normaliseOrigin(message.origin)
      if (!origin) {
        sendResponse({ ok: false, error: '来源无效' })
        return
      }
      const added = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)
      if (!added) {
        sendResponse({ ok: false, error: '没有授权该来源' })
        return
      }
      stateOf(origin)
      await ensureConnection(origin)
      sendResponse({ ok: true })
      return
    }
    if (message.type === 'notification-timeout') {
      const value = Number(message.value)
      if (!Number.isFinite(value) || value < 0) {
        sendResponse({ ok: false, error: '非法时长' })
        return
      }
      try {
        await chrome.storage.local.set({ notificationTimeoutSec: Math.floor(value) })
        sendResponse({ ok: true, notificationTimeoutSec: Math.floor(value) })
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (message.type === 'force-show') {
      try {
        await chrome.storage.local.set({ forceShow: message.value !== false })
        sendResponse({ ok: true, forceShow: message.value !== false })
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (message.type === 'focus') {
      const row = [...notifications.values()].find((item) => item.token === message.token)
      if (!row) {
        sendResponse({ ok: false, error: '通知已不存在' })
        return
      }
      sendResponse(await focusSession(row.origin, row.sessionId))
      return
    }
    sendResponse({ ok: false, error: 'unknown-message' })
  })()
  return true
})

/** 扫描所有回环标签页，为每个来源准备连接（真正的身份确认由内容脚本 / health 完成）。 */
async function rescanTabs() {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: ['http://127.0.0.1/*', 'http://localhost/*'] })
  } catch (error) {
    log('枚举标签失败', error)
    return
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || !tab.url) continue
    const origin = normaliseOrigin(tab.url)
    if (!origin) continue
    stateOf(origin).tabs.add(tab.id)
    const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false)
    if (allowed) void ensureConnection(origin)
  }
}

async function describeStatus() {
  await loadStore()
  const rows = []
  for (const [origin, state] of origins.entries()) {
    const info = await health(origin)
    rows.push({
      origin,
      isHost: Boolean(info?.ok && info.name === 'dsh-notifier'),
      connected: Boolean(socketFor(origin)),
      visible: state.visible === true,
      focused: state.focused === true,
      tabs: state.tabs?.size ?? 0,
      clientsByKind: info?.clientsByKind,
      hostClients: info?.clients,
    })
  }
  return {
    origins: rows,
    notifications: [...notifications.values()],
    lastDecision,
    forceShow: await forceShow(),
    notificationTimeoutSec: await notificationTimeoutSec(),
    hostPermissions: await chrome.permissions.getAll().then((all) => all.origins ?? []).catch(() => []),
  }
}

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  void (async () => {
    for (const origin of origins.keys()) {
      if (!socketFor(origin)) await ensureConnection(origin)
      else sendState(origin, stateOf(origin).focused)
    }
    // 顺手补扫一遍：Service Worker 被回收过、或页面在扩展加载之后才打开时也能自己接上。
    await rescanTabs()
  })()
})

chrome.runtime.onStartup.addListener(() => void rescanTabs())
chrome.runtime.onInstalled.addListener(() => void rescanTabs())

void (async () => {
  await loadStore()
  // 通知中心里的实际状态和我们的映射对齐：
  // 已经不在通知中心里的（浏览器重启过、用户划掉了）只清映射，
  // **不清 delivered** —— 那份记录的意义就是"别再弹第二次"。
  let changed = false
  for (const id of [...notifications.keys()]) {
    const row = notifications.get(id)
    const exists = await chrome.notifications.getAll().then((all) => Boolean(all?.[id])).catch(() => false)
    if (exists) continue
    notifications.delete(id)
    changed = true
    // 还在等作答的审批被用户划掉了：告诉宿主一声，别让那条待办永远挂着。
    // ⚠️ 这里多半连通道都还没建起来（SW 刚启动），所以必须走"排队 + 连上后补发"，
    // 直接 send() 会静默失败，宿主那条审批就永远留在队列里（B2 的僵尸待办正是
    // 由这一步引发的）。
    if (row?.pending === true) {
      queueDismiss(row.origin, row.token)
    }
  }
  if (changed) await persistStore()
  await rescanTabs()
})()

/**
 * 测试钩子（`test/extension.mjs`）。
 *
 * 判重逻辑（delivered / dispatching / dismiss 排队）是这段代码最容易坏、又最难
 * 人工验证的部分 —— "刷新扩展之后会不会重弹"以前只能靠真机刷新去撞。这里把内部
 * 状态挂到 `globalThis` 上给 Node 侧的测试用。
 *
 * 刻意**不写 `export`**：Service Worker 是扩展的唯一入口，保持成一个没有模块
 * 导出的普通文件，免得 Chrome 在加载/校验时对导出语句有意见。
 * 测试是把这个文件按文本读进来、用 Blob URL 当模块跑（见 test/extension.mjs），
 * 这里挂的钩子正好能被测试拿到。
 */
globalThis.__dshNotifierInternals = {
  delivered,
  dispatching,
  notifications,
  pendingDismiss,
  origins,
  loadStore,
  persistStore,
  ensureConnection,
  socketFor,
  deliverDecision,
  askOverHttp,
  resolveAck,
  awaitingAck,
  dispatchNotification,
  remindIfMissing,
  onHostMessage,
  clearNotification,
  /** 「点了允许」之后到底干了什么：测试直接调它，不用去点真通知。 */
  answerFromNotification,
  clickAllowInPage,
  notificationIdFor,
  queueDismiss,
  flushPendingDismiss,
  shouldShow,
  claims,
  reset: () => {
    delivered.clear()
    dispatching.clear()
    notifications.clear()
    pendingDismiss.clear()
    claims.clear()
    storeLoaded = false
  },
  setStoreLoaded: (value) => {
    storeLoaded = value === true
  },
}
