/**
 * 诊断：两条症状 ——
 *   (1)「一轮结束」的通知重复弹；
 *   (2) 人就在 dsh 网页前面，它还是弹。
 *
 * 用真实的 extension/background.js（假的 chrome.*）把这两种时序复现出来：
 *   A. 内容脚本**还没连上 / 刚断过**那一刻来了一条 idle → 该不该弹？
 *   B. 连续几轮结束（宿主每轮一个 token，间隔 1.5 秒）→ 通知中心里留几条？
 *
 * 跑法: node test/diagnose-idle-repeat.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = join(HERE, '..', 'extension')
const ORIGIN = 'http://127.0.0.1:3080'
const ID_PREFIX = 'dsh-notifier-'

const fake = {
  center: new Map(),
  store: {},
  created: [],
  tabs: [],
  injections: [],
  pageCardReady: true,
  injectionFails: false,
  activeTabId: null,
  windowFocused: true,
}

const event = () => ({ addListener() {}, removeListener() {} })

globalThis.chrome = {
  notifications: {
    async create(id, options) {
      fake.created.push({ id, title: options?.title, message: options?.message })
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
      async get() {
        return {}
      },
      async set() {},
    },
  },
  permissions: {
    async contains() {
      return false
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
      // 扩展问"哪个标签是活动标签"时，按假状态回答。
      if (query?.active === true) {
        return fake.tabs.filter((tab) => tab.id === fake.activeTabId)
      }
      return fake.tabs
    },
    async update() {},
    async create() {},
    onRemoved: event(),
    onUpdated: event(),
  },
  windows: {
    async update() {},
    async getLastFocused() {
      return { id: 1, focused: fake.windowFocused }
    },
  },
  scripting: {
    async executeScript({ target, func, args }) {
      fake.injections.push({ target, func, args })
      if (fake.injectionFails) throw new Error('Cannot access contents of the page')
      if (!fake.pageCardReady) return [{ result: { ok: false, reason: 'no-card' } }]
      return [{ result: { ok: true, answered: true, matchedBy: 'exact-label', label: '允许一次', cards: 1 } }]
    },
  },
  alarms: { create() {}, onAlarm: event() },
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.listeners = { open: [], message: [], close: [], error: [] }
  }
  addEventListener(type, fn) {
    this.listeners[type].push(fn)
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}
globalThis.WebSocket = FakeWebSocket

const GENERATED = join(EXT_DIR, '_under-test.generated.mjs')
const source = readFileSync(join(EXT_DIR, 'background.js'), 'utf8')
writeFileSync(GENERATED, source, 'utf8')
try {
  await import(pathToFileURL(GENERATED).href)
} finally {
  rmSync(GENERATED, { force: true })
}

const internals = globalThis.__dshNotifierInternals
assert.ok(internals, 'background.js 应挂出测试钩子')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idleItem = (token, sessionId = 'session-x') => ({
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

/** 把扩展恢复到"刚启动"的样子。 */
function reset({ tabs = [], activeTabId = null, windowFocused = true } = {}) {
  internals.reset()
  internals.setStoreLoaded(false)
  fake.center.clear()
  fake.created.length = 0
  fake.store = {}
  fake.tabs = tabs
  fake.activeTabId = activeTabId
  fake.windowFocused = windowFocused
}

console.log('')
console.log('---- A. 页面就是当前活动标签，但内容脚本还没报告过状态 ----')
{
  reset({ tabs: [{ id: 1, url: `${ORIGIN}/#/` }], activeTabId: 1, windowFocused: true })
  // 内容脚本还没连上：origins 里什么都没有（等价于 SW 刚被回收过）
  const decision = await internals.shouldShow({ ...idleItem('idleA'), origin: ORIGIN })
  console.log(`   shouldShow → ${JSON.stringify(decision)}`)
  console.log(
    decision.show
      ? '   ❌ 人就在页面前，却判定"可以弹" —— 这就是"我明明在网页里它还弹"'
      : '   ✅ 正确地判定"页面在眼前，不打扰"',
  )
}

console.log('')
console.log('---- B. 内容脚本刚断过（页面还开着、窗口还有焦点）----')
{
  reset({ tabs: [{ id: 1, url: `${ORIGIN}/#/` }], activeTabId: 1, windowFocused: true })
  // 先让它连上并报"可见 + 有焦点"
  internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: true, since: Date.now() })
  const before = await internals.shouldShow({ ...idleItem('idleB1'), origin: ORIGIN })
  console.log(`   连着的时候 shouldShow → ${JSON.stringify(before)}`)

  // 现在模拟 onDisconnect：3 秒重连窗口里，状态被清成"没焦点"
  const state = internals.origins.get(ORIGIN)
  state.focused = false
  const during = await internals.shouldShow({ ...idleItem('idleB2'), origin: ORIGIN })
  console.log(`   断线窗口里 shouldShow → ${JSON.stringify(during)}`)
  console.log(
    during.show
      ? '   ❌ 断线那 3 秒里会误弹 —— 这就是"有时候我在网页里它还弹"'
      : '   ✅ 断线窗口里也不打扰',
  )
}

console.log('')
console.log('---- C. 连续三轮结束（每轮一个新 token，间隔 1.5 秒）----')
{
  reset({ tabs: [{ id: 1, url: `${ORIGIN}/#/` }], activeTabId: 1, windowFocused: false })
  internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: false, since: Date.now() })
  await internals.onHostMessage(ORIGIN, { type: 'pending', item: idleItem('idleC1') })
  await sleep(1500)
  await internals.onHostMessage(ORIGIN, { type: 'pending', item: idleItem('idleC2') })
  await sleep(1500)
  await internals.onHostMessage(ORIGIN, { type: 'pending', item: idleItem('idleC3') })
  await sleep(200)
  console.log(`   notifications.create 调用 ${fake.created.length} 次：${fake.created.map((entry) => entry.id).join(', ')}`)
  console.log(`   通知中心里剩 ${fake.center.size} 条：${[...fake.center.keys()].join(', ')}`)
  console.log(
    fake.created.length === 3 && fake.center.size === 1
      ? '   ✅ 弹 3 次但只留最后一条（旧的那条被收掉）'
      : `   ⚠️ 需要看清楚：弹了 ${fake.created.length} 次、留了 ${fake.center.size} 条`,
  )
}

console.log('')
console.log('---- D. 宿主重连时重发快照（同一个 token 又发一次）----')
{
  reset({ tabs: [{ id: 1, url: `${ORIGIN}/#/` }], activeTabId: 1, windowFocused: false })
  internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: false, since: Date.now() })
  await internals.onHostMessage(ORIGIN, { type: 'pending', item: idleItem('idleD') })
  await sleep(1200)
  await internals.onHostMessage(ORIGIN, { type: 'snapshot', items: [idleItem('idleD')] })
  await sleep(200)
  console.log(`   notifications.create 调用 ${fake.created.length} 次（期望 1）`)
  console.log(fake.created.length === 1 ? '   ✅ 快照重发不会重复弹' : '   ❌ 同一个 token 被弹了多次')
}

console.log('')
console.log('---- E. 一轮结束通知还挂着，会话又跑起来了（宿主发 resolved）----')
{
  reset({ tabs: [{ id: 1, url: `${ORIGIN}/#/` }], activeTabId: 1, windowFocused: false })
  internals.origins.set(ORIGIN, { tabs: new Set([1]), visible: true, focused: false, since: Date.now() })
  await internals.onHostMessage(ORIGIN, { type: 'pending', item: idleItem('idleE1') })
  await sleep(150)
  await internals.onHostMessage(ORIGIN, { type: 'resolved', token: 'idleE1', outcome: 'superseded' })
  await sleep(150)
  console.log(`   收到 resolved 后通知中心剩 ${fake.center.size} 条（期望 0）`)
  console.log(fake.center.size === 0 ? '   ✅ 撤下了' : '   ❌ resolved 没把通知撤下')
}
