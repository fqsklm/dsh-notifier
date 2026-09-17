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

  const report = (port, kind) => {
    try {
      port.postMessage({
        kind,
        origin: location.origin,
        href: location.href,
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
      })
    } catch {
      /* 端口已断开，交给 onDisconnect 重连 */
    }
  }

  let port = null
  let stopped = false

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
    report(port, 'hello')
  }

  const onState = () => {
    if (port) report(port, 'state')
  }
  document.addEventListener('visibilitychange', onState)
  window.addEventListener('focus', onState)
  window.addEventListener('blur', onState)
  window.addEventListener('pagehide', () => {
    stopped = true
  })

  void connect()
})()
