/**
 * dsh-notifier 扩展（Service Worker）的回归测试。
 *
 * 为什么要有这个文件：判重逻辑和"连上之后报身份"是这段代码里最容易坏、又最难
 * 人工验证的部分 —— "刷新扩展之后会不会重弹一条"以前只能靠真机刷新去撞。
 * 这里用一套假的 `chrome.*` 把 background.js 真的跑起来。
 *
 * 加载方式：background.js 是扩展的入口，刻意保持成没有 `export` 的普通模块文件
 * （免得 Chrome 对 Service Worker 的导出语句有意见）。测试把它按文本读进来，
 * 用 Blob URL 当模块执行 —— 相对导入 `./shared.js` 会以本目录为基准解析，
 * 所以跑的就是生产代码本身。
 *
 * 跑法: node test/extension.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 报告写到自己的文件，别覆盖宿主那套的 test/last-run.txt。
// 必须在 harness.mjs **之后**才能问它要路径，所以这里先设变量、后导入。
process.env.DSH_NOTIFIER_REPORT = 'last-run-extension.txt'

const { after, before, describe, finish, it, resetReport } = await import('./harness.mjs')

resetReport()

const ID_PREFIX = 'dsh-notifier-'

// ------------------------------------------------- 假宿主（承接 HTTP 兜底）

/** 记录所有打到 /dsh-notifier/action 的 POST */
const hostPosts = []
let hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
let hostServer = null
let ORIGIN = 'http://127.0.0.1:3080'

// ---------------------------------------------------------------- chrome 假实现

const fake = {
  /** notificationId -> notification 选项（模拟通知中心） */
  center: new Map(),
  /** 本会话的 storage.session 内容 */
  store: {},
  /** 记录我们发出去的所有 socket 消息 */
  sent: [],
  /** 当前 socket 是否连上 */
  open: false,
  /** notifications.create 的调用记录，用来数"弹了几条" */
  created: [],
  createShouldFail: false,
  /** 模拟 storage 读取的跨进程延迟（竞态窗口需要它） */
  slowConfig: true,
  /** 是否已授权来源（决定 ensureConnection 会不会真的建通道） */
  grantPermission: false,
  /** 记录注入页面的那次调用 */
  injections: [],
  /** 页面里有没有审批卡（false = 模拟"卡片还没渲染出来 / 页面没这张卡"） */
  pageCardReady: true,
  /** 注入是否直接抛错（模拟没有注入权限 / 标签已关） */
  injectionFails: false,
  /** tabs.query 返回的标签页（每个标签自带 active / windowId，后台自己算"谁在看"） */
  tabs: [],
  /** 活动标签所在的窗口 id（pageIsActiveTab 会去问这个窗口有没有焦点） */
  activeTabId: null,
  /** 最后聚焦的窗口 id（标签没带 windowId 时的退路） */
  focusedWindowId: 1,
  /** 最近聚焦窗口是否有焦点（判断"页面在眼前"用） */
  windowFocused: true,
  /** 面板里选的"通知停留时长"（秒）。undefined = 没存过，用默认的"永久" */
  notificationTimeoutSec: undefined,
  /** 面板里的"强制弹通知"开关 */
  forceShow: false,
}

/** chrome.tabs.query 的 url 模式匹配：够用来区分 `http://127.0.0.1:3080/*` 这类模式。 */
function matchesUrl(url, pattern) {
  if (pattern === '<all_urls>') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(url)
}

/** 造一个标签，顺手把 active / windowId 补上，省得每个用例都写全。 */
function tab(id, url, { active = false, windowId = 1 } = {}) {
  return { id, url, active, windowId }
}

const event = () => ({ addListener() {}, removeListener() {} })

globalThis.chrome = {
  notifications: {
    async create(id, options) {
      fake.created.push({ id, title: options?.title })
      if (fake.createShouldFail) throw new Error('create failed')
      fake.center.set(id, options)
      return id
    },
    async clear(id) {
      fake.center.delete(id)
      return true
    },
    async getAll() {
      return Object.fromEntries([...fake.center.keys()].map((id) => [id, true]))
    },
    onButtonClicked: event(),
    onClicked: event(),
    onClosed: event(),
  },
  storage: {
    session: {
      async get(key) {
        if (typeof key === 'string') return key in fake.store ? { [key]: fake.store[key] } : {}
        return { ...fake.store }
      },
      async set(patch) {
        Object.assign(fake.store, patch)
      },
    },
    local: {
      async get(key) {
        // 让配置读取真的让出一次微任务/宏任务：真实环境里
        // `chrome.storage.local.get` 是跨进程往返，正是这个 await 窗口
        // 让"两帧交错"变成可以复现的竞态。
        if (fake.slowConfig) await new Promise((resolve) => setTimeout(resolve, 15))
        if (key === 'forceShow') return { forceShow: fake.forceShow === true }
        if (key === 'notificationTimeoutSec' && Number.isFinite(fake.notificationTimeoutSec)) {
          return { notificationTimeoutSec: fake.notificationTimeoutSec }
        }
        return {}
      },
      async set() {},
    },
  },
  permissions: {
    async contains() {
      // 默认**不**授权：这样只有显式打开开关的测试才会真的去建 WebSocket。
      // SW 启动时的 rescanTabs / alarm 不然会顺手连一条，把测试的断言搅乱。
      if (!fake.grantPermission) return false
      return true
    },
    async request() {
      return true
    },
    async getAll() {
      return { origins: [`${ORIGIN}/*`] }
    },
  },
  runtime: {
    getURL: (path) => `chrome-extension://fake/${path}`,
    onConnect: event(),
    onMessage: event(),
    onStartup: event(),
    onInstalled: event(),
  },
  tabs: {
    async query(query) {
      // 真实调用只按 url 模式过滤，**不**按 active / lastFocusedWindow 过滤：
      // 后台就是靠每个标签自己的 active/windowId 字段自己算的（见 pageIsActiveTab）。
      // 这里刻意照真实行为模拟 —— 早先的假实现会按 query.active 过滤，
      // 于是掩盖了"只要浏览器里有 dsh 标签就算人正在看"这个真 bug。
      const patterns = query?.url ?? []
      if (patterns.length === 0) return fake.tabs
      return fake.tabs.filter((tab) => patterns.some((pattern) => matchesUrl(tab.url ?? '', pattern)))
    },
    async update() {},
    async create() {},
    onRemoved: event(),
    onUpdated: event(),
  },
  windows: {
    async update() {},
    async get(windowId) {
      // 只有"当前有焦点的那个窗口"才 report focused: true —— 多窗口误判那条回归
      // （dsh 标签挂在后台窗口里）正是靠这里区分开的。
      return { id: windowId, focused: windowId === fake.focusedWindowId }
    },
    async getLastFocused() {
      return { id: fake.focusedWindowId, focused: true }
    },
  },  /**
   * 注入页内点击用的假实现。真实调用是
   * `chrome.scripting.executeScript({ target: {tabId}, func, args: [reason] })`。
   */
  scripting: {
    async executeScript({ target, func, args }) {
      fake.injections.push({ target, func, args })
      if (fake.injectionFails) throw new Error('Cannot access contents of the page')
      if (!fake.pageCardReady) return [{ result: { ok: false, reason: 'no-card' } }]
      return [{ result: { ok: true, answered: true, label: '允许一次', cards: 1 } }]
    },
  },
  alarms: {
    create() {},
    onAlarm: event(),
  },
}

/** 极简 WebSocket 假实现：只够 background.js 用。 */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.listeners = { open: [], message: [], close: [], error: [] }
    FakeWebSocket.last = this
  }

  addEventListener(type, fn) {
    this.listeners[type].push(fn)
  }

  send(text) {
    fake.sent.push({ url: this.url, text })
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  // 测试驱动用
  emitOpen() {
    this.readyState = FakeWebSocket.OPEN
    fake.open = true
    for (const fn of this.listeners.open) fn()
  }

  emitMessage(value) {
    for (const fn of this.listeners.message) fn({ data: JSON.stringify(value) })
  }

  emitClose() {
    this.readyState = FakeWebSocket.CLOSED
    fake.open = false
    for (const fn of this.listeners.close) fn()
  }
}

globalThis.WebSocket = FakeWebSocket

const NATIVE_FETCH = globalThis.fetch

/** 宿主探测用的 fetch 假实现：health / config 各回一个够用的对象。 */
const stubFetch = async (url) => {
  const text = String(url)
  const body = text.includes('/health')
    ? { ok: true, name: 'dsh-notifier', protocol: 1, clients: 1, clientsByKind: { extension: 1, page: 1, unknown: 0 } }
    : { ok: true, name: 'dsh-notifier', enabled: true, token: 'token-abc', wsPath: '/dsh-notifier/ws' }
  return { ok: true, status: 200, async json() { return body } }
}

// ------------------------------------------------- 假宿主：/dsh-notifier/action

/**
 * 一个真实的小 HTTP 服务，用来验证"扩展在 WebSocket 送不到时改用
 * POST /dsh-notifier/action 兜底"。这就是用户报"点了允许其实没通过"的那条通路 ——
 * 必须有测试盯着，否则它坏了只会表现为点了没反应。
 */
hostServer = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    if (!String(req.url).startsWith('/dsh-notifier/action')) {
      res.writeHead(404)
      res.end()
      return
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* 留 null */
    }
    hostPosts.push({ method: req.method, body: parsed, at: Date.now() })
    const payload = JSON.stringify(hostResponse.body)
    res.writeHead(hostResponse.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(payload)
  })
})
hostServer.listen(0, '127.0.0.1')
await once(hostServer, 'listening')
hostServer.unref?.()
const HOST_PORT = hostServer.address().port
ORIGIN = `http://127.0.0.1:${HOST_PORT}`

// /dsh-notifier/action 交给真实 HTTP 假宿主，其余（health / config）走桩函数。
globalThis.fetch = async (url, init) => {
  const text = String(url)
  if (text.includes('/dsh-notifier/action')) {
    return NATIVE_FETCH(`http://127.0.0.1:${HOST_PORT}/dsh-notifier/action`, init)
  }
  return stubFetch(url, init)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = join(HERE, '..', 'extension')
/**
 * 生成文件必须落在 extension/ 里：background.js 里的
 * `import { getConfig, health } from './shared.js'` 是相对导入，
 * 换个目录就解析不到。文件名以 `_` 开头，加载完就删掉。
 */
const GENERATED = join(EXT_DIR, '_under-test.generated.mjs')

const source = readFileSync(join(EXT_DIR, 'background.js'), 'utf8')
writeFileSync(GENERATED, source, 'utf8')
try {
  await import(pathToFileURL(GENERATED).href)
} finally {
  rmSync(GENERATED, { force: true })
}

const internals = globalThis.__dshNotifierInternals
assert.ok(internals, 'background.js 应该挂出测试钩子 __dshNotifierInternals')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const item = (token, extra = {}) => ({
  token,
  kind: 'approval',
  sessionId: `session-${token}`,
  session: `会话 · #${token}`,
  title: 'dsh · 需要审批',
  subtitle: 'pwsh 请求审批',
  body: '要写工作区外的文件',
  actions: ['open', 'allow'],
  createdAt: Date.now(),
  ...extra,
})

/** 模拟"用户重新加载了扩展"：session 存储清空，通知中心保持不动。 */
async function simulateExtensionReload() {
  fake.store = {}
  fake.sent.length = 0
  fake.created.length = 0
  internals.reset()
  internals.setStoreLoaded(false)
  // 清掉可能残留的 socket 映射，让 ensureConnection 重新建通道
  for (const [origin, state] of internals.origins) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    internals.origins.delete(origin)
    void origin
  }
  await sleep(500)
}

describe('扩展：刷新后不重复弹通知', () => {
  before(async () => {
    // 等 background.js 启动时那一轮对账跑完
    await sleep(600)
  })

  after(() => {
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  })

  it('刷新（session 存储被清空）后，通知中心里已有的条目不会重弹', async () => {
    // 先正常弹一条
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0

    await internals.dispatchNotification(ORIGIN, item('tokA'))
    assert.equal(fake.created.length, 1, '第一次应该弹一条')
    assert.equal(fake.center.has(`${ID_PREFIX}tokA`), true)

    // 用户刷新扩展：storage.session 清空，通知中心里的那条还在，
    // 宿主紧接着把还挂着的这条重新放进快照发过来。
    await simulateExtensionReload()
    fake.center.set(`${ID_PREFIX}tokA`, { title: 'dsh · 需要审批' }) // 通知中心里仍然在

    await internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [item('tokA')] })
    assert.equal(fake.created.length, 0, '刷新后重发的快照不能再弹一条')
  })

  it('刷新后，通知中心里已经没有的条目仍然可以补弹', async () => {
    await simulateExtensionReload()
    fake.center.clear() // 用户把旧通知划掉了
    fake.created.length = 0

    await internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [item('tokB')] })
    assert.equal(fake.created.length, 1, '划掉过的旧 id 不在通知中心里，但也只能补这一次')
    assert.equal(fake.center.has(`${ID_PREFIX}tokB`), true)
  })

  it('snapshot 与 pending 两帧交错时同一个 token 只弹一条', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}

    const payload = item('tokC')
    // 第一帧（快照）先跑起来，它会停在 shouldShow 里那几次异步读取上；
    // 第二帧（紧跟着广播的 pending）在窗口中间到达 —— 这就是宿主
    // "连上先发快照、紧接着广播 pending" 的真实时序。
    const first = internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [payload] })
    await sleep(8)
    const second = internals.onHostMessage(ORIGIN, { type: 'pending', item: payload })
    await Promise.all([first, second])

    assert.equal(fake.created.length, 1, 'dispatchNotification 必须自带同步闸门')
  })

  it('两条通道同时收到同一个 token 也只弹一条', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}

    const payload = item('tokC2')
    const first = internals.onHostMessage(ORIGIN, { type: 'pending', item: payload })
    await sleep(8)
    const second = internals.onHostMessage(ORIGIN, { type: 'pending', item: payload })
    await Promise.all([first, second])

    assert.equal(fake.created.length, 1)
  })

  it('同一 token 重复广播多次仍然只弹一条', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}

    await Promise.all([
      internals.onHostMessage(ORIGIN, { type: 'pending', item: item('tokD') }),
      internals.onHostMessage(ORIGIN, { type: 'pending', item: item('tokD') }),
      internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [item('tokD')] }),
    ])
    assert.equal(fake.created.length, 1)
  })
})

describe('扩展：连上之后要报身份（TDZ 回归）', () => {
  it('通道 open 时不会抛 ReferenceError，并报出 client=extension', async () => {
    internals.origins.set(ORIGIN, { tabs: new Set(), visible: false, focused: false, since: Date.now() })
    internals.originAttempts?.clear?.()
    fake.sent.length = 0
    fake.grantPermission = true
    try {
      // 造一条新通道并让它 open —— 这一步曾经因为
      // `const state` 的暂时性死区直接抛 ReferenceError：
      // 结果就是"连上了但从不报身份"，宿主那边只看到一条 unknown 连接。
      await internals.ensureConnection(ORIGIN)
      const socket = internals.socketFor(ORIGIN)
      assert.ok(socket, '授权之后应该建出 WebSocket')
      FakeWebSocket.last.emitOpen()

      const ready = fake.sent.map((entry) => JSON.parse(entry.text)).find((message) => message.type === 'ready')
      assert.ok(ready, `open 之后必须发送 ready 报身份，实际发送: ${JSON.stringify(fake.sent)}`)
      assert.equal(ready.client, 'extension')
    } finally {
      fake.grantPermission = false
    }
  })
})

describe('扩展：决定必须真的送到宿主（"点了允许没通过"回归）', () => {
  /** 造一条"已连接"的通道，测试自己控制 ack */
  const connectFake = async () => {
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    const existing = internals.socketFor(ORIGIN)
    if (existing) {
      existing.close()
      FakeWebSocket.last.emitClose()
    }
    internals.origins.set(ORIGIN, { tabs: new Set(), visible: false, focused: false, since: Date.now() })
    fake.grantPermission = true
    try {
      await internals.ensureConnection(ORIGIN)
    } finally {
      fake.grantPermission = false
    }
    const socket = internals.socketFor(ORIGIN)
    assert.ok(socket, '应该建出 WebSocket')
    socket.emitOpen()
    return socket
  }

  it('宿主回 ack ok 时：算送达，且不去走 HTTP', async () => {
    hostPosts.length = 0
    hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
    await connectFake()

    const pending = internals.deliverDecision(ORIGIN, 'tokAck', 'allow')
    await sleep(20)
    internals.resolveAck('tokAck', { ok: true, action: 'allow', pending: false })
    const result = await pending

    assert.equal(result.ok, true)
    assert.equal(hostPosts.length, 0, 'socket 送达成功就不该再用 HTTP')
  })

  it('宿主回 ack {ok:false,error:"expired"} 时：转 HTTP 重投', async () => {
    hostPosts.length = 0
    hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
    await connectFake()

    const pending = internals.deliverDecision(ORIGIN, 'tokB', 'allow')
    await sleep(20)
    internals.resolveAck('tokB', { ok: false, error: 'expired' })
    const result = await pending

    assert.equal(result.ok, true, 'HTTP 重投成功应算送达')
    assert.equal(hostPosts.length, 1)
    assert.deepEqual(hostPosts[0].body, { token: 'tokB', action: 'allow' })
  })

  it('socket 已死（send 返回 false）时：走 HTTP 兜底', async () => {
    hostPosts.length = 0
    hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
    // 没有任何可用 socket
    const existing = internals.socketFor(ORIGIN)
    if (existing) {
      existing.close()
      FakeWebSocket.last.emitClose()
    }
    assert.equal(internals.socketFor(ORIGIN), null)

    const result = await internals.deliverDecision(ORIGIN, 'tokC3', 'allow')
    assert.equal(result.ok, true)
    assert.equal(hostPosts.length, 1)
  })

  it('askOverHttp 解析宿主回执：409/ok:false 要能被识别成未受理', async () => {
    hostResponse = { status: 409, body: { ok: false, error: 'expired' } }
    const result = await internals.askOverHttp(ORIGIN, 'tokGone', 'allow')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'expired')
  })

  it('两条通路都失败时必须返回 ok:false（调用方据此保留通知）', async () => {
    const existing = internals.socketFor(ORIGIN)
    if (existing) {
      existing.close()
      FakeWebSocket.last.emitClose()
    }
    hostResponse = { status: 409, body: { ok: false, error: 'expired' } }
    const result = await internals.deliverDecision(ORIGIN, 'tokDead', 'allow')
    assert.equal(result.ok, false)
    assert.match(String(result.error), /send-failed/)
  })

  it('ack 超时后转 HTTP（socket 开着但宿主不回执）', async () => {
    hostPosts.length = 0
    hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
    await connectFake()
    // 故意不回 ack：deliverDecision 应该在 ACK_TIMEOUT_MS 之后自己转 HTTP
    const started = Date.now()
    const result = await internals.deliverDecision(ORIGIN, 'tokSlow', 'allow')
    assert.equal(result.ok, true)
    assert.equal(hostPosts.length, 1)
    assert.ok(Date.now() - started >= 3000, '必须等满 ack 超时才转 HTTP')
  })
})

describe('扩展：划掉通知后告知宿主（B2 的扩展侧）', () => {
  it('通道没连上时 dismiss 会排队，连上后补发', async () => {
    internals.pendingDismiss.clear()
    fake.sent.length = 0

    // 显式造出"通道不可用"的局面：把上一条测试留下的 socket 关掉。
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    const existing = internals.socketFor(ORIGIN)
    if (existing) {
      existing.close()
      FakeWebSocket.last.emitClose()
    }
    assert.equal(internals.socketFor(ORIGIN), null, '这一步必须真的没有可用通道')

    // 发不出去就必须排队，不能静默丢弃
    internals.queueDismiss(ORIGIN, 'tokE')
    assert.equal(internals.pendingDismiss.size, 1)
    assert.equal(fake.sent.length, 0)

    // 建一条通道并 open：应该补发
    internals.origins.set(ORIGIN, { tabs: new Set(), visible: false, focused: false, since: Date.now() })
    fake.grantPermission = true
    try {
      await internals.ensureConnection(ORIGIN)
      const socket = internals.socketFor(ORIGIN)
      assert.ok(socket, '应该建出新的 WebSocket')
      socket.emitOpen()

      const dismiss = fake.sent.map((entry) => JSON.parse(entry.text)).find((message) => message.action === 'dismiss')
      assert.ok(dismiss, `open 之后必须补发 dismiss，实际发送: ${JSON.stringify(fake.sent)}`)
      assert.equal(dismiss.token, 'tokE')
      assert.equal(internals.pendingDismiss.size, 0, '补发成功后要出队')
    } finally {
      fake.grantPermission = false
    }
  })
})

describe('扩展：通知点「允许」之后，网页那张卡片也要跟着消失', () => {
  /** 造一条"已连接"的通道。 */
  const connectFake = async () => {
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    const existing = internals.socketFor(ORIGIN)
    if (existing) {
      existing.close()
      FakeWebSocket.last.emitClose()
    }
    internals.origins.set(ORIGIN, { tabs: new Set(), visible: false, focused: false, since: Date.now() })
    fake.grantPermission = true
    try {
      await internals.ensureConnection(ORIGIN)
    } finally {
      fake.grantPermission = false
    }
    const socket = internals.socketFor(ORIGIN)
    assert.ok(socket, '应该建出 WebSocket')
    socket.emitOpen()
    return socket
  }

  /** 弹一条审批通知，返回它的 id（并清掉注入记录）。 */
  const armNotification = async (id) => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    fake.injections.length = 0
    fake.pageCardReady = true
    fake.injectionFails = false
    await internals.dispatchNotification(ORIGIN, { ...item('tokPage'), sessionId: 'session-tokPage' })
    assert.equal(fake.center.has(id), true, '通知应该已经弹出')
  }

  it('「允许」送达宿主之后，还会去网页里按一次「允许一次」', async () => {
    const notificationId = internals.notificationIdFor('tokPage')
    await armNotification(notificationId)
    const socket = await connectFake()
    fake.tabs = [{ id: 42, url: `${ORIGIN}/#dsh-notifier=session-tokPage` }]
    try {
      const answering = internals.answerFromNotification(notificationId, 'allow')
      await sleep(20)
      // 扩展先等宿主 ack —— 送到才算数。
      internals.resolveAck('tokPage', { ok: true, action: 'allow', pending: false })
      const result = await answering

      assert.equal(result.ok, true, '宿主受理了这条决定')
      const decision = fake.sent.map((entry) => JSON.parse(entry.text)).find((message) => message.action === 'allow')
      assert.ok(decision, `必须把 allow 发给宿主，实际: ${JSON.stringify(fake.sent)}`)
      assert.equal(decision.token, 'tokPage')

      // 关键一步：网页里也要真的按下那个按钮，否则卡片会停在「等待审批」。
      assert.equal(fake.injections.length, 1, '应该注入页内点击一次')
      assert.equal(fake.injections[0].target.tabId, 42, '注入到 dsh 标签页')
      // 注入的函数必须自包含：Chrome 会把它序列化后丢进页面里跑。
      assert.equal(typeof fake.injections[0].func, 'function')
      assert.equal(fake.injections[0].args[0], '要写工作区外的文件', '把申请原文一起带进去，用来认准是哪张卡片')
      // 通知本身照样收掉。
      assert.equal(fake.center.has(notificationId), false, '作答后通知要撤下')
    } finally {
      fake.tabs = []
      void socket
    }
  })

  it('页内按不动（页面没开卡片 / 注入失败）时：不影响工具执行，只是卡片要手动处理', async () => {
    const notificationId = internals.notificationIdFor('tokPage')
    await armNotification(notificationId)
    await connectFake()
    fake.tabs = []
    fake.injectionFails = true
    try {
      const answering = internals.answerFromNotification(notificationId, 'allow')
      await sleep(20)
      internals.resolveAck('tokPage', { ok: true, action: 'allow', pending: false })
      const result = await answering
      assert.equal(result.ok, true, '宿主侧仍然算送达：工具会执行')
      assert.equal(fake.center.has(notificationId), false, '通知照常撤下（宿主已受理）')
    } finally {
      fake.tabs = []
      fake.injectionFails = false
    }
  })

  it('宿主说 expired（这条早被作答/撤下）：收掉通知，别留一条点了没反应的', async () => {
    const notificationId = internals.notificationIdFor('tokPage')
    await armNotification(notificationId)
    await connectFake()
    fake.tabs = []
    // 两条通路都回 expired —— 典型场景：用户先在网页里点了允许，再点通知里那条旧的。
    hostResponse = { status: 409, body: { ok: false, error: 'expired' } }
    try {
      const answering = internals.answerFromNotification(notificationId, 'allow')
      await sleep(20)
      internals.resolveAck('tokPage', { ok: false, error: 'expired' })
      const result = await answering
      assert.equal(result.ok, false, '宿主确实没受理')
      assert.equal(fake.center.has(notificationId), false, 'expired 说明已作答，通知必须收掉（不能留成死按钮）')
    } finally {
      hostResponse = { status: 200, body: { ok: true, action: 'allow', pending: false } }
    }
  })

  it('同一个实例开着多个标签时，优先动当前活动那个', async () => {
    const notificationId = internals.notificationIdFor('tokPage')
    await armNotification(notificationId)
    await connectFake()
    // 标签 42 在后台、标签 51 是活动标签：应该注入到 51。
    fake.tabs = [
      { id: 42, url: `${ORIGIN}/#/a`, active: false },
      { id: 51, url: `${ORIGIN}/#/b`, active: true },
    ]
    try {
      const answering = internals.answerFromNotification(notificationId, 'allow')
      await sleep(20)
      internals.resolveAck('tokPage', { ok: true, action: 'allow', pending: false })
      await answering
      assert.equal(fake.injections.length, 1)
      assert.equal(fake.injections[0].target.tabId, 51, '应当注入到当前活动的那个 dsh 标签')
    } finally {
      fake.tabs = []
    }
  })

  it('页内点击失败时不会把通知赖在屏幕上，也不会重复发决定', async () => {
    const notificationId = internals.notificationIdFor('tokPage')
    await armNotification(notificationId)
    await connectFake()
    fake.tabs = [{ id: 43, url: `${ORIGIN}/` }]
    fake.pageCardReady = false // 页面里暂时没有卡片 → 注入会重试若干次后放弃
    fake.sent.length = 0
    try {
      const answering = internals.answerFromNotification(notificationId, 'allow')
      await sleep(20)
      internals.resolveAck('tokPage', { ok: true, action: 'allow', pending: false })
      await answering
      const decisions = fake.sent.map((entry) => JSON.parse(entry.text)).filter((message) => message.type === 'decision')
      assert.equal(decisions.length, 1, `allow 只发一次，实际: ${JSON.stringify(decisions)}`)
      assert.ok(fake.injections.length > 1, '卡片还没渲染出来时会重试注入')
    } finally {
      fake.tabs = []
      fake.pageCardReady = true
    }
  })
})

describe('扩展：人就在网页前面时不该打扰（"有时候我在网页里它还弹"）', () => {
  const idle = (token) => ({
    token,
    kind: 'idle',
    sessionId: 'session-visible01',
    session: '会话 · #visible01',
    title: 'dsh · 一轮对话已结束',
    subtitle: '会话',
    body: '回到会话继续下一步。',
    actions: ['open', 'dismiss'],
    createdAt: Date.now(),
  })

  /** 每个用例都从"扩展刚启动"开始：状态表是空的（这正是出问题那种时刻）。 */
  const freshStart = (options = {}) => {
    internals.reset()
    internals.setStoreLoaded(false)
    // 前面的用例往 origins 里塞过状态；这里真的清空，才叫"什么都没报过"。
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    internals.origins.clear()
    // 去重窗口（claims）也是内存态：真实情况里扩展重启就没了。
    // 不清它的话，同一会话的第二条用例会被上一条的 claim 挡成 duplicate。
    internals.claims.clear()
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    fake.notificationTimeoutSec = undefined
    fake.forceShow = false
    const defaults = [tab(1, `${ORIGIN}/#/`, { active: true })]
    fake.tabs = options.tabs ?? defaults
    // 活动标签由标签自己声明（active: true）；用例也可以只给 id 显式指定。
    const declared = fake.tabs.find((entry) => entry.active === true)?.id ?? null
    fake.activeTabId = options.activeTabId ?? declared
    fake.windowFocused = options.windowFocused ?? true
    fake.focusedWindowId = options.focusedWindowId ?? 1
  }

  it('内容脚本还没报告过状态，但 dsh 就是当前活动标签 → 不弹', async () => {
    freshStart()
    assert.equal(internals.origins.size, 0, '这一步必须真的"什么都没报过"')
    const decision = await internals.shouldShow({ ...idle('tokVisA'), origin: ORIGIN })
    // 老写法：缺状态 → 等价于"没人在看" → 人在页面前也弹（用户报的就是这个）。
    assert.equal(decision.show, false, `人就在页面前，不该弹：${JSON.stringify(decision)}`)
    assert.equal(decision.reason, 'page-focused')
  })

  it('内容脚本断线窗口里（重连那 3 秒）也不弹', async () => {
    freshStart()
    // 连上并报过"可见 + 有焦点"
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: true, lastSeen: Date.now(), since: Date.now() })
    assert.equal((await internals.shouldShow({ ...idle('tokVisB'), origin: ORIGIN })).show, false)
  })

  it('页面在后台标签里、窗口还有焦点 → 照常弹', async () => {
    freshStart({ tabs: [tab(1, `${ORIGIN}/#/`, { active: false })], activeTabId: 99 })
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: false, focused: false, lastSeen: Date.now(), since: Date.now() })
    const decision = await internals.shouldShow({ ...idle('tokVisC'), origin: ORIGIN })
    assert.equal(decision.show, true, '用户在看别的页面，应当提醒')
  })

  it('用户在别的应用里（没有浏览器窗口有焦点）→ 照常弹', async () => {
    // 窗口 1 里的 dsh 标签是活动标签，但整个浏览器都没焦点（用户在别的应用里）。
    freshStart({ focusedWindowId: 2 })
    const decision = await internals.shouldShow({ ...idle('tokVisD'), origin: ORIGIN })
    assert.equal(decision.show, true, '窗口没焦点，应当提醒')
  })

  it('dsh 标签关掉了 → 照常弹', async () => {
    freshStart({ tabs: [], activeTabId: null })
    const decision = await internals.shouldShow({ ...idle('tokVisE'), origin: ORIGIN })
    assert.equal(decision.show, true, '页面都没开，应当提醒')
  })

  it('回归：dsh 标签在**别的窗口**里挂着 → 照常弹（老判据会误判成"人在看"）', async () => {
    // 用户报："我明明选了在 dsh 页面时不给我通知，但它还是经常弹。"
    // 根因：老判据用 `tabs.query({url, active:true, lastFocusedWindow:true})` 的
    // "有没有结果"当"用户正在看"，而真实 Chrome 里这两个过滤参数不可靠 ——
    // 只要浏览器里存在 dsh 标签就命中，于是判决直接是 page-focused。
    // 这个用例里 dsh 标签在窗口 1（后台），焦点在窗口 2 的别的页面上。
    freshStart({
      tabs: [
        tab(1, `${ORIGIN}/#/`, { active: true, windowId: 1 }),
        tab(2, 'https://example.com/', { active: true, windowId: 2 }),
      ],
      activeTabId: null, // 让判据只能靠标签自己的 active/windowId
      focusedWindowId: 2,
    })
    const decision = await internals.shouldShow({ ...idle('tokVisF'), origin: ORIGIN })
    assert.equal(decision.show, true, `焦点在别的窗口，应当提醒：${JSON.stringify(decision)}`)
  })

  it('回归：活动标签是 dsh 时 → 不弹（判据是"标签自己声明 active"，不靠 tabs.query 的过滤参数）', async () => {
    freshStart({
      tabs: [
        tab(1, `${ORIGIN}/#/a`, { active: false, windowId: 1 }),
        tab(2, `${ORIGIN}/#/b`, { active: true, windowId: 1 }),
      ],
      activeTabId: null,
    })
    // 内容脚本报的是"可见 + 有焦点"（人在这个页面上）。
    // 这里刻意把 activeTabId 设成 null：老判据靠 tabs.query 的 active 过滤，
    // 过滤一旦失效就会误判成"没人在看"→ 弹通知；新判据只看标签自己的 active 字段。
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: true, lastSeen: Date.now(), since: Date.now() })
    const decision = await internals.shouldShow({ ...idle('tokVisG'), origin: ORIGIN })
    assert.equal(decision.show, false, `人在 dsh 页面上，不该弹：${JSON.stringify(decision)}`)
    assert.equal(decision.reason, 'page-focused')
  })

  it('内容脚本的报告过期后，改用"活动标签"兜底判据（人还在页面上 → 不弹）', async () => {
    freshStart({
      tabs: [tab(1, `${ORIGIN}/#/`, { active: true, windowId: 1 })],
      activeTabId: null,
    })
    // 报告过期（>30 秒没更新，比如 SW 被回收那段时间）：内容脚本那份不可信，
    // 这时要看"dsh 标签是不是活动标签"——是，就不打扰。
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: false, focused: false, lastSeen: Date.now() - 60000, since: Date.now() - 60000 })
    const decision = await internals.shouldShow({ ...idle('tokVisH'), origin: ORIGIN })
    assert.equal(decision.show, false, `报告过期但 dsh 就是活动标签，不该弹：${JSON.stringify(decision)}`)
  })
})

describe('扩展：选了「永久」横幅就不该自己消失', () => {
  const approval = (token) => ({
    token,
    kind: 'approval',
    sessionId: 'session-lifetime1',
    session: '会话 · #lifetime1',
    title: 'dsh · 需要审批',
    subtitle: 'pwsh 申请提权到 workspace-write',
    body: '要写工作区外的文件',
    actions: ['open', 'allow'],
    createdAt: Date.now(),
  })

  /** 让"人不在看页面"，这样通知一定会真的弹出来。 */
  const awayFromPage = () => {
    internals.origins.set(ORIGIN, {
      tabs: new Set([1]),
      visible: false,
      focused: false,
      lastSeen: Date.now(),
      since: Date.now(),
    })
  }

  const freshStart = (options = {}) => {
    internals.reset()
    internals.setStoreLoaded(false)
    for (const [, state] of internals.origins) if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    internals.origins.clear()
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    fake.forceShow = false
    fake.notificationTimeoutSec = options.notificationTimeoutSec
    fake.tabs = [tab(1, `${ORIGIN}/#/`, { active: false })]
    fake.activeTabId = options.activeTabId ?? 99
    fake.windowFocused = true
    // 这个 describe 不关心"谁在看"，固定成"窗口有焦点但活动标签不是 dsh"。
    fake.focusedWindowId = options.focusedWindowId ?? 1
  }

  it('停留时长「永久」（默认）：create 时不带 requireInteraction=false —— 否则 Windows 按系统时长自动收掉', async () => {
    // 用户报："我选择让通知横幅永久显示，但它过了一会会自己消失。"
    // 根因：一直写死 requireInteraction: false，等于告诉系统"这条不用一直留着"，
    // 于是 Windows 的"通知显示时长"（默认几秒）到了就把横幅收走。
    freshStart()
    awayFromPage()
    await internals.onHostMessage(ORIGIN, { type: 'pending', item: approval('tokForever') })
    await sleep(60)
    const created = fake.created.find((entry) => entry.id === `${ID_PREFIX}tokForever`)
    assert.ok(created, '应当弹出来了')
    const options = fake.center.get(`${ID_PREFIX}tokForever`)
    assert.equal(options.requireInteraction, true, `「永久」必须让系统别自动收：${JSON.stringify(options)}`)
    assert.equal(fake.center.has(`${ID_PREFIX}tokForever`), true)
  })

  it('停留时长选了 15 秒：到点由扩展自己收掉，而且此时不要求系统保留', async () => {
    freshStart({ notificationTimeoutSec: 15 })
    awayFromPage()
    await internals.onHostMessage(ORIGIN, { type: 'pending', item: approval('tokTimed') })
    await sleep(60)
    const options = fake.center.get(`${ID_PREFIX}tokTimed`)
    assert.ok(options, '应当弹出来了')
    assert.equal(options.requireInteraction, false, '有明确时长时不需要系统保留')
    assert.equal(fake.center.has(`${ID_PREFIX}tokTimed`), true, '15 秒还没到，不该提前收')
  })

  it('回归：永久保留时不会被任何定时器收走（等过 CLAIM_TTL 也不动它）', async () => {
    freshStart()
    awayFromPage()
    await internals.onHostMessage(ORIGIN, { type: 'pending', item: approval('tokSticky') })
    await sleep(60)
    assert.equal(fake.center.has(`${ID_PREFIX}tokSticky`), true)
    // 宿主重连补发快照：不能把已经弹过的那条重复弹、更不能撤掉它
    await internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [approval('tokSticky')] })
    await sleep(60)
    assert.equal(fake.center.has(`${ID_PREFIX}tokSticky`), true, '快照补发不该动它')
    assert.equal(fake.center.size, 1, '也不该多出一条')
  })
})

describe('扩展：一轮结束的通知不会重复堆着', () => {
  const idle = (token, sessionId) => ({
    token,
    kind: 'idle',
    sessionId,
    session: `会话 · #${sessionId.slice(-8)}`,
    title: 'dsh · 一轮对话已结束',
    subtitle: '会话',
    body: '回到会话继续下一步。',
    actions: ['open', 'dismiss'],
    createdAt: Date.now(),
  })

  it('同一会话连续两轮结束：通知中心里只留最后一条', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    fake.tabs = [{ id: 1, url: `${ORIGIN}/#/` }]
    fake.activeTabId = 1
    // 页面在后台、窗口有焦点 → 会真的弹
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: false, focused: false, lastSeen: Date.now(), since: Date.now() })

    await internals.onHostMessage(ORIGIN, { type: 'pending', item: idle('idleR1', 'session-repeat01') })
    // 第二轮：claim 的 30 秒窗口过去之后（真实里两轮间隔常常超过 30 秒）
    internals.claims.clear()
    await internals.onHostMessage(ORIGIN, { type: 'pending', item: idle('idleR2', 'session-repeat01') })
    await sleep(120)

    assert.equal(fake.center.size, 1, `通知中心里应该只剩最新一条，实际: ${[...fake.center.keys()].join(',')}`)
    assert.equal(fake.center.has(`${ID_PREFIX}idleR2`), true, '留下的应该是新的那条')
  })

  it('不同会话各自结束：各留一条（不是重复，别误伤）', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: false, focused: false, lastSeen: Date.now(), since: Date.now() })

    await internals.onHostMessage(ORIGIN, { type: 'pending', item: idle('idleS1', 'session-aa000001') })
    internals.claims.clear()
    await internals.onHostMessage(ORIGIN, { type: 'pending', item: idle('idleS2', 'session-bb000002') })
    await sleep(120)

    assert.equal(fake.center.size, 2, '两个会话各自结束，应该各有一条')
  })

  it('同一个 token 被重发（宿主重连补快照）只弹一次', async () => {
    internals.reset()
    internals.setStoreLoaded(false)
    fake.center.clear()
    fake.created.length = 0
    fake.store = {}
    internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: false, focused: false, lastSeen: Date.now(), since: Date.now() })

    await internals.onHostMessage(ORIGIN, { type: 'pending', item: idle('idleT1', 'session-same0001') })
    await sleep(60)
    await internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [idle('idleT1', 'session-same0001')] })
    await sleep(120)

    assert.equal(fake.created.length, 1, `同一个 token 只能弹一次，实际弹了 ${fake.created.length} 次`)
  })
})

await finish()
