/**
 * dsh-notifier 扩展 — 内容脚本。
 *
 * 只做两件事：
 * 1. 判断"当前这个页面是不是 dsh 的 Web UI"。
 * 2. 把页面的可见/聚焦状态报给后台，让后台决定该不该弹通知。
 *
 * 判据（任一成立即认定）：
 * - 宿主插件注入的 <meta name="dsh-notifier-host" content="1">；
 * - 页面里出现了 dsh 的启动标记 / dsh-notifier 的接口。
 * 普通页面（比如别的本地工具）不会命中，避免误连。
 */
(() => {
  const SEEN_KEY = '__dshNotifierPageSeen'
  if (window[SEEN_KEY]) return
  window[SEEN_KEY] = true

  const markSeen = () =>
    new Promise((resolve) => {
      let tries = 0
      const probe = () => {
        tries += 1
        if (document.querySelector('meta[name="dsh-notifier-host"]') || window.__DSH_BOOT__) {
          resolve(true)
          return
        }
        if (tries >= 12) {
          resolve(false)
          return
        }
        setTimeout(probe, 500)
      }
      probe()
    })

  /** 让窗口标题带上 " · dsh"，方便在任务栏/标签栏一眼认出。 */
  const markTitle = () => {
    try {
      const title = String(document.title || '')
      if (!title) return
      if (/\bdsh\b|DeepSeek|Harness/i.test(title)) return
      document.title = `${title} · dsh`
    } catch {
      /* 忽略 */
    }
  }

  /** 只报"状态",不报 href —— 后台的判据只用得到这两项。 */
  const stateNow = () => ({
    kind: 'state',
    origin: location.origin,
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  })

  /**
   * 心跳：**只在状态真的变了**或**心跳超时**时才发。
   *
   * 为什么必须有：后台用「报告是否新鲜（30 秒内）」来判断"这份 DOM 自述还作不作数"。
   * 而内容脚本原先只在 visibilitychange / focus / blur 时才报 —— 用户一直盯着页面看时
   * 那些事件根本不会触发，报告的 lastSeen 停在很久以前，看起来"过期"，
   * 后台于是退回另一套判据。心跳让"人在看"这件事一直有新鲜证据，
   * 也让"人真的走了"（对方抢走焦点但没触发 blur 的情况）最迟 20 秒就暴露出来。
   */
  const HEARTBEAT_MS = 20000
  const HEARTBEAT_GRACE_MS = 5000
  let lastSent = null
  let lastSentAt = 0

  const report = (kind) => {
    let payload
    try {
      payload = kind === 'hello' ? { ...stateNow(), kind: 'hello', href: location.href } : stateNow()
    } catch {
      return
    }
    const now = Date.now()
    const same = lastSent && lastSent.visible === payload.visible && lastSent.focused === payload.focused
    if (kind !== 'hello' && same && now - lastSentAt < HEARTBEAT_MS * 2) return
    try {
      port?.postMessage(payload)
      lastSent = payload
      lastSentAt = now
    } catch {
      /* 端口已断开，交给 onDisconnect 重连 */
    }
  }

  let port = null
  let stopped = false
  let heartbeat = null

  const connect = async () => {
    if (stopped) return
    const isDsh = await markSeen()
    if (!isDsh || stopped) return
    markTitle()
    try {
      port = chrome.runtime.connect({ name: 'dsh-page' })
    } catch {
      return
    }
    port.onDisconnect.addListener(() => {
      port = null
      // Service Worker 会被回收；过一会儿再挂回去。
      if (!stopped) setTimeout(connect, 3000)
    })
    lastSent = null
    report('hello')
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (port) report('state')
      }, HEARTBEAT_MS)
    }
  }

  const onState = () => {
    if (port) report('state')
  }
  document.addEventListener('visibilitychange', onState)
  window.addEventListener('focus', onState)
  window.addEventListener('blur', onState)
  // 页面重新可见/重新被点回前台时补一次，别等心跳。
  document.addEventListener('mousemove', () => {
    if (Date.now() - lastSentAt > HEARTBEAT_GRACE_MS) onState()
  })
  window.addEventListener('pagehide', () => {
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
  })

  void connect()
})()
