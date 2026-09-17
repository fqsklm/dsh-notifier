/**
 * dsh-notifier — 浏览器半边（页面内中继）。
 *
 * 只做一件事：宿主要求你"回到某个会话"时，替你在 SPA 里把那个会话打开。
 *
 * 两条来源都会处理：
 * 1. URL hash（`#dsh-notifier=<sessionId>`）—— 扩展新开/复用标签时用得上。
 * 2. 回环 WebSocket 上的 `focus` 指令 —— 标签已经开着时，扩展只要发一句话，
 *    不需要动 URL，也就不会多开标签。
 */
window.__ModuleLoader__.load({
  id: 'dsh-notifier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const HASH_PREFIX = 'dsh-notifier='
    const RECONNECT_MS = 4000
    const PING_MS = 15000

    function parseFocusHash(hash) {
      const raw = String(hash || '')
      const body = raw.charAt(0) === '#' ? raw.slice(1) : raw
      const index = body.indexOf(HASH_PREFIX)
      if (index === -1) return ''
      try {
        return decodeURIComponent(body.slice(index + HASH_PREFIX.length).split('&')[0] || '')
      } catch {
        return ''
      }
    }

    function takeFocusHash() {
      const id = parseFocusHash(location.hash)
      if (!id) return ''
      try {
        history.replaceState(null, '', location.pathname + location.search)
      } catch {
        /* 某些环境不允许改 history，留着 hash 也无害 */
      }
      return id
    }

    function openSession(sessions, sessionId) {
      if (!sessionId || !sessions || typeof sessions.open !== 'function') return false
      try {
        sessions.open(sessionId)
        return true
      } catch {
        return false
      }
    }

    function start(ctx) {
      let sessions = ctx && ctx.sessions
      let pendingSession = ''
      let socket = null
      let disposed = false
      let reconnectTimer = null
      let pingTimer = null
      let wsToken = ''

      const applyFocus = (sessionId) => {
        if (!sessionId) return
        if (!sessions) {
          pendingSession = sessionId
          return
        }
        pendingSession = ''
        openSession(sessions, sessionId)
      }

      // ---- 1. hash 入口：扩展打开/切换标签时最直接的办法 ----
      const onHash = () => {
        const id = takeFocusHash()
        if (id) applyFocus(id)
      }

      // ---- 2. WebSocket 入口：标签已经开着时不用动 URL ----
      const connect = () => {
        if (disposed || socket) return
        let origin = ''
        try {
          origin = location.origin
        } catch {
          return
        }
        const boot = async () => {
          try {
            const response = await fetch('/dsh-notifier/config', { cache: 'no-store' })
            const data = await response.json()
            const next = typeof data?.token === 'string' ? data.token : ''
            if (!next) return
            wsToken = next
          } catch {
            return
          }
          if (!wsToken || disposed) return
          try {
            socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/dsh-notifier/ws?t=${encodeURIComponent(wsToken)}`)
          } catch {
            scheduleReconnect()
            return
          }
          socket.addEventListener('open', () => {
            try {
              socket.send(JSON.stringify({ type: 'ready', client: 'page', focused: document.hasFocus(), origin }))
            } catch {
              /* 忽略 */
            }
            if (pingTimer) clearInterval(pingTimer)
            pingTimer = setInterval(() => {
              try {
                socket?.send(JSON.stringify({ type: 'pong', at: Date.now() }))
              } catch {
                /* 忽略 */
              }
            }, PING_MS)
          })
          socket.addEventListener('message', (event) => {
            let message = null
            try {
              message = JSON.parse(String(event.data))
            } catch {
              return
            }
            if (message && message.type === 'focus' && message.sessionId) applyFocus(String(message.sessionId))
          })
          socket.addEventListener('close', () => {
            socket = null
            if (pingTimer) clearInterval(pingTimer)
            pingTimer = null
            scheduleReconnect()
          })
          socket.addEventListener('error', () => {
            try {
              socket?.close()
            } catch {
              /* 忽略 */
            }
          })
        }
        void boot()
      }

      const scheduleReconnect = () => {
        if (disposed || reconnectTimer) return
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, RECONNECT_MS)
      }

      const reportFocus = () => {
        try {
          socket?.send(JSON.stringify({ type: 'state', focused: document.hasFocus() }))
        } catch {
          /* 忽略 */
        }
      }

      window.addEventListener('hashchange', onHash)
      window.addEventListener('focus', reportFocus)
      window.addEventListener('blur', reportFocus)

      // 会话服务可能比本插件晚就绪，先挂上再重放待处理的会话。
      const bind = (value) => {
        if (value) sessions = value
        if (pendingSession) applyFocus(pendingSession)
      }
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['sessions'], (scope) => {
            bind((scope && scope.sessions) || (ctx && ctx.sessions))
          })
        }
      } catch {
        bind(ctx && ctx.sessions)
      }

      onHash()
      connect()

      return () => {
        disposed = true
        window.removeEventListener('hashchange', onHash)
        window.removeEventListener('focus', reportFocus)
        window.removeEventListener('blur', reportFocus)
        if (reconnectTimer) clearTimeout(reconnectTimer)
        if (pingTimer) clearInterval(pingTimer)
        try {
          socket?.close()
        } catch {
          /* 忽略 */
        }
        socket = null
      }
    }

    function apply(ctx) {
      if (!ctx || typeof ctx.effect !== 'function') {
        start(ctx)
        return
      }
      ctx.effect(() => start(ctx), 'dsh-notifier: page relay')
    }

    exports.apply = apply
    exports.inject = ['sessions']
    return module.exports
  },
})
