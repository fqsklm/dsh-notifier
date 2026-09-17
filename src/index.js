/**
 * dsh-notifier — 宿主半边。
 *
 * 职责只有两件：
 * 1. 听 DSH 的事件：需要审批（`approval/request` waterfall）和一轮结束（`api-session/status`）。
 * 2. 通过本实例回环端口上的一条 WebSocket 把这些事件交给浏览器扩展，
 *    再把扩展上的按钮点击（回到对话 / 允许 / 拒绝）落成真正的决定。
 *
 * 刻意不做的事：不起任何子进程（没有 PowerShell、没有控制台闪窗），
 * 不抢浏览器前台，不做窗口标题猜测。通知与窗口切换全部由 Chrome 扩展完成。
 */
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  clip,
  createPendingStore,
  describeApproval,
  describeSession,
  isLoopbackAddress,
  isLoopbackHost,
  normalizeConfig,
  sessionKindOf,
  shortSessionId,
  shouldNotify,
} from './util.js'
import { acceptKey, createSocket, handshake } from './ws.js'

export const name = 'dsh-notifier'
export const inject = ['webServer']

const PREFIX = '/dsh-notifier'
const PING_INTERVAL_MS = 20000
const CLIENT_TIMEOUT_MS = 60000
const MAX_BODY_BYTES = 8192
/** 注入到 index.html 的标记：扩展内容脚本用它确认这个页面是 dsh。 */
const META_MARK = '<meta name="dsh-notifier-host" content="1">'

/**
 * 给记录挂一个只 settle 一次的本地决议 Promise：
 * 扩展上的按钮、请求中止、插件卸载都会 settle 它，先到先得。
 */
export function createPendingDecision(record, signal) {
  let resolve
  let settled = false
  const local = new Promise((res) => {
    resolve = res
  })
  let onAbort
  const settle = (value) => {
    if (settled) return false
    settled = true
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    resolve(value)
    return true
  }
  if (signal) {
    onAbort = () => settle({ type: 'aborted', reason: signal.reason })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort)
  }
  record.local = local
  record.settle = settle
  record.settled = () => settled
  return record
}

/** 组装 notifier 的内部状态与处理函数；`apply()` 只负责把它接到 cordis 上。 */
export function createNotifier(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  let webUrl = 'http://127.0.0.1:3080'
  /** 每次 dsh web 启动生成一次；扩展从 /config 取到后用来建立 WebSocket。 */
  const wsToken = randomBytes(18).toString('base64url')
  const pending = createPendingStore()
  const clients = new Map()
  const runningBySession = new Map()
  const kindById = new Map()
  const titleById = new Map()
  let connectionSeq = 0
  let pingTimer = null
  /** 最近一次审批钩子的状态，供面板排查"为什么没弹提醒"。 */
  let lastApproval = null

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-notifier: ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  const rememberTitle = (sessionId, title) => {
    if (!sessionId) return
    const clean = typeof title === 'string' ? clip(title, 48) : ''
    if (clean) titleById.set(sessionId, clean)
  }

  /** 会话标题：先读缓存，再问 sessionTitle 服务，最后翻会话事件。 */
  const resolveTitle = (sessionId, session) => {
    const cached = titleById.get(sessionId)
    if (cached) return cached
    try {
      const current = session ?? ctx.sessions?.get?.(sessionId)
      const title = ctx.sessionTitle?.get?.(current)?.title
      if (typeof title === 'string' && title.trim()) {
        rememberTitle(sessionId, title.trim())
        return titleById.get(sessionId)
      }
      for (const event of current?.events ?? []) {
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim()) {
          rememberTitle(sessionId, event.data.title.trim())
          return titleById.get(sessionId)
        }
      }
    } catch {
      /* 会话可能已经销毁 */
    }
    return undefined
  }

  /** 交给扩展的通知内容：文字一律来自 DSH 抛出的申请。 */
  const pendingPayload = (record) => ({
    token: record.token,
    kind: record.kind,
    sessionId: record.sessionId,
    session: describeSession(record.sessionId, record.sessionTitle, cfg.showSessionTitle),
    title: `${cfg.titlePrefix} · ${record.heading}`,
    subtitle: record.subtitle,
    body: record.body,
    toolName: record.toolName,
    callId: record.callId,
    openPath: `/#dsh-notifier=${encodeURIComponent(record.sessionId)}`,
    // Windows 只给两个通知按钮位，第三个会被系统静默丢掉（早先放 3 个，"拒绝"永远不显示）。
    //   - 审批：回到对话 / 允许（拒绝就走「回到对话」回网页里点）
    //   - 一轮结束：回到对话 / 知道了（知道了只是把通知收起来）
    actions: record.kind === 'approval' ? ['open', 'allow'] : ['open', 'dismiss'],
    createdAt: record.createdAt,
  })

  /**
   * 广播。`only` 用来限定收件人身份：
   *
   * `focus` 必须只发给页面中继，绝不能回给扩展 —— 扩展收到 focus 会去抢标签前台，
   * 而它自己的 focus-request 又会被这里广播回来，两边来回就是无限循环：
   * 实测一次点击能在 8 秒里产生 4000+ 个 focus 帧，浏览器被反复抢前台，
   * 用户根本切不走（这就是"点了回到对话后打不开别的网页"的原因）。
   */
  /**
   * 队列里的全部记录，用于扩展重连时的全量补发
   * （"你不在时错过的审批，回来还能弹"）。
   * "重连不会重弹"的责任在消费端（扩展）：它记着自己已经弹过哪些 token。
   */
  const liveItems = () => pending.list().map(pendingPayload)

  const broadcast = (message, only) => {
    let sent = 0
    for (const client of clients.values()) {
      if (client.socket.closed) continue
      if (only && client.client !== only) continue
      if (client.socket.sendJson(message)) sent += 1
    }
    return sent
  }

  const pushPending = (record) => {
    broadcast({ type: 'pending', item: pendingPayload(record) })
  }

  const pushResolved = (record, outcome) => {
    broadcast({ type: 'resolved', token: record.token, outcome })
  }

  /**
   * 有人（网页卡片或通知按钮）先答了：撤下通知，并让另一条通路失效。
   * `outcome` 是给扩展/日志看的字符串，本地决议一律包成 `{type:'answer'}`，
   * 和超时、中止区分开。
   */
  const finish = (record, outcome) => {
    if (!pending.has(record.token)) return false
    pending.delete(record.token)
    clearTimeout(record.timer)
    record.settle?.({ type: 'answer', value: outcome })
    pushResolved(record, outcome)
    return true
  }

  /**
   * 「这条不提醒了，但问题本身不算被作答」：撤记录、放下通知，
   * 本地决议 settle 成 `{type:'dismissed'}` —— 它会走到 notifyApproval 的
   * `return next()` 分支，把决定权交回 waterfall（网页卡片），而不是代替用户作答。
   *
   * 和 `finish()` 的区别：`finish` 是"有人给答案了"，`cancel` 是"这条提醒作废了"。
   */
  const cancel = (record, outcome) => {
    if (!pending.has(record.token)) return false
    pending.delete(record.token)
    clearTimeout(record.timer)
    record.settle?.({ type: 'dismissed', reason: outcome })
    pushResolved(record, outcome)
    return true
  }

  /**
   * 会话身份：优先缓存，其次问 sessions 服务，最后按主会话处理。
   * 默认成主会话是有意的——`api-session/status` 不告诉我们会话来源，
   * 若因为查不到就当成 unknown，主会话的结束提醒会全部丢掉。
   */
  const sessionKind = (sessionId, session) => {
    const cached = kindById.get(sessionId)
    if (cached) return cached
    const kind = sessionKindOf(session ?? ctx.sessions?.get?.(sessionId))
    const resolved = kind === 'unknown' ? 'primary' : kind
    if (sessionId) kindById.set(sessionId, resolved)
    return resolved
  }

  /**
   * 调用原有 waterfall，但只把它"已经明确作答"的结果当成结果：
   * `unavailable` 是没有人作答时的失败关闭值，这时仍应等通知按钮。
   */
  const raceRemote = (next) => {
    let remote
    try {
      remote = Promise.resolve(next())
    } catch {
      return new Promise(() => {})
    }
    return remote.then(
      (value) => (value === undefined || value === 'unavailable' ? new Promise(() => {}) : value),
      () => new Promise(() => {}),
    )
  }

  /**
   * 审批请求：让出给原有 waterfall（网页卡片照常显示），同时等扩展上的按钮。
   * 按钮先点，就直接给出 `allowed-once` / `rejected`；网页卡片先答，
   * 通知会在 resolved 回合被撤下。
   */
  const notifyApproval = (request, next) => {
    let session
    let sessionId
    try {
      session = request?.agent?.session
      sessionId = session?.id ?? request?.agent?.id
    } catch {
      sessionId = undefined
    }
    // 排查用的最近审批记录：面板里能看到"审批请求到底有没有走到钩子"。
    lastApproval = {
      at: Date.now(),
      sessionId: sessionId ?? null,
      toolName: request?.toolName ?? null,
      reason: clip(request?.reason ?? '', 160),
      outcome: null,
    }
    if (!sessionId) {
      lastApproval.outcome = 'passed-through:no-session'
      log('warn', '审批请求没有会话 id，直接放行给网页卡片')
      return next()
    }
    if (!cfg.enabled) {
      lastApproval.outcome = 'passed-through:disabled'
      return next()
    }
    const kind = sessionKind(sessionId, session)
    if (!shouldNotify(kind, 'approval', cfg)) {
      lastApproval.outcome = `passed-through:kind=${kind}`
      return next()
    }

    const wording = describeApproval(
      { toolName: request?.toolName, reason: request?.reason },
      { showToolName: cfg.showToolName },
    )
    const token = randomBytes(12).toString('base64url')
    const record = {
      kind: 'approval',
      token,
      sessionId,
      sessionTitle: resolveTitle(sessionId, session),
      heading: '需要审批',
      subtitle: wording.title,
      body: wording.body,
      toolName: request?.toolName,
      callId: request?.callId,
      createdAt: Date.now(),
      settle: null,
      timer: null,
    }
    createPendingDecision(record, request?.signal)
    pending.add(record)
    // 这里刻意**不**去"作废同一会话里上一条审批"，哪怕通知会被新的那条顶掉：
    //   - `finish(stale, 'superseded')` 是"有人作答了"，而没人作答，它会直接把那次申请
    //     判成 allowed-once，用户根本没点过就放行了（真出过：一条里连续申请两次权限，
    //     第一条被静默放行）；
    //   - 每条审批都有自己的 token，用户可能先点第二条、回头再点第一条，
    //     撤掉记录就等于让那条点不动了。
    // 通知中心里"一条盖一条"由扩展负责（它只对 idle 做替换、审批各留各的，
    // 见 extension/background.js 的 replaceForSession），和队列里的记录是两回事。
    pushPending(record)
    if (lastApproval) lastApproval.outcome = 'notified'
    log('info', `approval pending session=${shortSessionId(sessionId)} tool=${record.toolName ?? '?'}`)

    return Promise.race([record.local, raceRemote(next)])
      .then((value) => {
        // 通知按钮先作答：直接给出结果（0..N 都在这条分支）。
        if (value?.type === 'answer') {
          clearTimeout(record.timer)
          if (lastApproval) lastApproval.outcome = `answered-from-notification:${value.value}`
          return value.value
        }
        // 网页卡片先答完：撤下通知，沿用网页的结果。
        if (typeof value === 'string') {
          clearTimeout(record.timer)
          if (lastApproval) lastApproval.outcome = `answered-in-page:${value}`
          if (pending.has(record.token)) {
            pending.delete(record.token)
            pushResolved(record, value)
          }
          return value
        }
        // 通知被划掉 / 被扩展对账清理：这条提醒作废，但审批问题本身没被作答 ——
        // 交回 waterfall 让网页卡片去处理（cancel() 已经撤下通知并删了记录）。
        if (value?.type === 'dismissed') {
          clearTimeout(record.timer)
          if (lastApproval) lastApproval.outcome = `dismissed:${value.reason ?? 'dismissed'}`
          return next()
        }
        // 超时 / 中止 / 被替换 / 插件卸载：撤下通知并把决定权交回 waterfall。
        //
        // ⚠️ 这里必须先看这条记录**还在不在队列里**：`finish()` 已经把它删掉之后，
        // 「作答」和「等网页」两条腿会同时落地 —— 竞速取了等网页那一腿时，
        // `next()` 会**再答一次**（网页卡片已经答过一回了）。实测症状：
        // 日志里连续两条 `dismissed:superseded` / 两次 allowed-once，
        // 看起来像"我点了一下，它执行了两次"。记录已经不在 = 有人已经作答，
        // 直接沿用那条腿的结果，不要再问一次。
        clearTimeout(record.timer)
        if (pending.has(record.token)) {
          pending.delete(record.token)
          pushResolved(record, 'passed-through')
        }
        return next()
      })
      .catch(() => {
        clearTimeout(record.timer)
        if (pending.has(record.token)) {
          pending.delete(record.token)
          pushResolved(record, 'failed')
        }
        return 'unavailable'
      })
      .then((answer) => (answer === undefined ? 'unavailable' : answer))
  }

  /** 新会话出现时先记住身份和标题，结束时才判断得出该不该提醒。 */
  const onSessionCreated = (session) => {
    const sessionId = session?.id
    if (!sessionId) return
    const kind = sessionKindOf(session)
    if (kind !== 'unknown') kindById.set(sessionId, kind)
    try {
      const title = ctx.sessionTitle?.get?.(session)?.title
      if (typeof title === 'string' && title.trim()) rememberTitle(sessionId, title.trim())
    } catch {
      /* sessionTitle 不在 ctx 上时忽略；resolveTitle 后面还会再试 */
    }
  }

  /** 一轮对话结束（running → idle）。 */
  const notifyIdle = (sessionId) => {
    if (!cfg.enabled) return
    const kind = sessionKind(sessionId)
    if (!shouldNotify(kind, 'idle', cfg)) return
    for (const stale of pending.supersededBy(sessionId, 'idle', '')) finish(stale, 'superseded')

    const token = randomBytes(12).toString('base64url')
    const isSubagent = kind === 'subagent'
    const title = resolveTitle(sessionId)
    const record = {
      kind: 'idle',
      token,
      sessionId,
      sessionTitle: title,
      heading: isSubagent ? '子代理任务已完成' : '一轮对话已结束',
      subtitle: describeSession(sessionId, title, cfg.showSessionTitle),
      body: isSubagent ? '回到会话查看子代理结果。' : '回到会话继续下一步。',
      createdAt: Date.now(),
      settle: null,
      timer: null,
    }
    pending.add(record)
    pushPending(record)
    log('info', `idle pending session=${shortSessionId(sessionId)} subagent=${String(isSubagent)}`)
  }

  const onSessionStatus = (sessionId, running) => {
    const id = String(sessionId ?? '')
    if (!id) return
    const was = runningBySession.get(id)
    runningBySession.set(id, running === true)
    if (running === true) {
      // 重新开始干活：把上一轮的结束通知撤掉。
      for (const stale of pending.supersededBy(id, 'idle', '')) finish(stale, 'superseded')
      kindById.set(id, sessionKind(id))
      return
    }
    if (was === true) notifyIdle(id)
  }

  /** 扩展按钮、网页卡片、HTTP 回调统一从这里落地。 */
  const decide = (token, action) => {
    const record = pending.get(token)
    if (!record) return { ok: false, error: 'expired' }

    if (action === 'open') {
      // 只让页面中继去切会话；扩展自己已经把标签抢到前台了，
      // 回给它只会触发"抢前台 → 再发 focus-request → 再抢"的无限循环。
      const sent = broadcast({ type: 'focus', sessionId: record.sessionId, token: record.token }, 'page')
      if (record.kind === 'approval') {
        // 审批：**记录**要留着（你回网页看完可能还要允许/拒绝，网页里的卡片得继续在），
        // 但**通知**不占着了 —— 点「回到对话」就把通知撤下，
        // 所以返回 pending:false 让扩展收起通知。
        return { ok: true, action: 'open', sessionId: record.sessionId, pageRelayed: sent > 0, pending: false }
      }
      // 一轮结束：没有后续动作，记录也一起收掉 ——
      // 否则它会永远留在待办里，点「回到对话」怎么点都清不掉。
      pending.delete(record.token)
      pushResolved(record, 'opened')
      return { ok: true, action: 'open', sessionId: record.sessionId, pageRelayed: sent > 0, pending: false }
    }

    if (action === 'dismiss') {
      // 通知被划掉了 / 点了「知道了」。两种情况都会走到这里：
      //   - 一轮结束：没有要作答的东西，直接收掉记录；
      //   - 审批：扩展在 Service Worker 每次启动时会核对"通知中心里已经没有、
      //     但记录还标着待作答"的条目并发来 dismiss。**必须清掉**，否则这条待办
      //     永远挂在队列里，每次重连的 snapshot 都带着它，而扩展的 delivered 里
      //     也一直记着 —— 结果就是这个审批再也弹不出通知（曾经的僵尸待办 bug）。
      //     审批本身不算被作答：settle 成 dismissed，本地 await 让位给网页卡片。
      const cleaned = cancel(record, 'dismissed')
      return { ok: true, action, sessionId: record.sessionId, pending: false, cleaned }
    }

    if (record.kind !== 'approval') {
      // 一轮结束没有被作答的东西：open 在上面处理过，dismiss 在上面那段。
      // 其余动作没有意义。
      return { ok: false, error: 'bad-action' }
    }
    if (action === 'allow' || action === 'reject') {
      const outcome = action === 'allow' ? 'allowed-once' : 'rejected'
      const settled = finish(record, outcome)
      log('info', `${action} session=${shortSessionId(record.sessionId)} settled=${String(settled)}`)
      return settled
        ? { ok: true, action, sessionId: record.sessionId, pending: false }
        : { ok: false, error: 'not-pending' }
    }
    return { ok: false, error: 'bad-action' }
  }

  // ---- HTTP：只回环可达；不含 token 也能读，供扩展发现本实例 ----

  const rejectUnlessLoopback = (req, res) => {
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-notifier: loopback only')
      return true
    }
    return false
  }

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('payload-too-large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    return JSON.parse(text)
  }

  const publicConfig = () => {
    const byKind = { extension: 0, page: 0, unknown: 0 }
    for (const client of clients.values()) byKind[client.client ?? 'unknown'] += 1
    const now = Date.now()
    return {
      ok: true,
      name,
      protocol: 1,
      enabled: cfg.enabled,
      notifyApproval: cfg.notifyApproval,
      notifyIdle: cfg.notifyIdle,
      notifySubagentIdle: cfg.notifySubagentIdle,
      titlePrefix: cfg.titlePrefix,
      clients: clients.size,
      // 关键区分：页面里的中继脚本自己也会连一条 WebSocket，
      // 所以 clients=1 不能证明扩展装上了；只有 extension>0 才算。
      clientsByKind: byKind,
      // 每个连接的身份与存活时间：排查"多出来一条 extension"时看这里，
      // 能区分"扩展真的连了两条"和"上一条 socket 还没被回收"。
      clientList: [...clients.values()].map((client) => ({
        id: client.id,
        client: client.client,
        build: client.build ?? null,
        origin: client.origin ?? null,
        pid: client.pid ?? null,
        ageSec: Math.round((now - client.since) / 1000),
        idleSec: Math.round((now - client.lastSeen) / 1000),
      })),
      pending: pending.size(),
      lastApproval,
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        const { clients: total, clientsByKind, clientList } = publicConfig()
        sendJson(res, 200, { ok: true, name, protocol: 1, clients: total, clientsByKind, clientList })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/config`,
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        sendJson(res, 200, {
          ...publicConfig(),
          port: Number(new URL(webUrl).port) || 0,
          wsPath: `${PREFIX}/ws`,
          token: wsToken,
        })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/pending`,
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        // 队列里的全部记录。重复弹的防护在扩展侧（它记着已弹过的 token）。
        sendJson(res, 200, { ok: true, items: liveItems() })
      },
    },    {
      kind: 'exact',
      path: `${PREFIX}/action`,
      async handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        try {
          const body = await readJsonBody(req)
          const result = decide(String(body?.token ?? ''), String(body?.action ?? ''))
          sendJson(res, result.ok ? 200 : 409, result)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]

  // ---- WebSocket：扩展的实时通道 ----

  const acceptUpgrade = (req, socket, head) => {
    const hs = handshake(req, `${PREFIX}/ws`)
    if (!hs || hs.url.searchParams.get('t') !== wsToken) {
      socket.destroy()
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(hs.key)}\r\n\r\n`,
    )
    if (head?.length) socket.unshift(head)

    const id = (connectionSeq += 1)
    let client = null
    const conn = createSocket(socket, {
      onMessage(text) {
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        handleClientMessage(client, message)
      },
      onClose() {
        if (client) clients.delete(client.id)
        log('info', `extension disconnected id=${id} remaining=${clients.size}`)
      },
      onError(error) {
        log('warn', `socket error id=${id}: ${String(error?.message ?? error)}`)
      },
    })
    client = {
      id,
      socket: conn,
      client: 'unknown',
      origin: undefined,
      focused: false,
      pid: undefined,
      since: Date.now(),
      lastSeen: Date.now(),
    }
    clients.set(id, client)
    conn.sendJson({ type: 'hello', protocol: 1, config: publicConfig() })
    conn.sendJson({ type: 'snapshot', items: liveItems() })
    log('info', `client connected id=${id} total=${clients.size}`)
  }

  const handleClientMessage = (client, message) => {
    if (!client || !message || typeof message !== 'object') return
    client.lastSeen = Date.now()
    switch (message.type) {
      case 'ready':
      case 'state': {
        client.focused = message.focused === true
        if (Number.isFinite(Number(message.pid))) client.pid = Number(message.pid)
        if (typeof message.origin === 'string' && message.origin) client.origin = message.origin
        // 客户端自报的构建代号：用来判断扩展是不是还在跑旧代码
        // （扩展改了必须在 chrome://extensions 刷新才生效；忘了刷新时症状和真 bug 一样）。
        if (typeof message.build === 'string' && message.build) client.build = message.build
        // 自我申报身份：扩展的 Service Worker 报 'extension'，页面中继报 'page'。
        if (message.client === 'extension' || message.client === 'page') client.client = message.client
        else if (client.client === 'unknown' && Number.isFinite(Number(message.pid))) client.client = 'extension'
        return
      }
      case 'pong':
        return
      case 'snapshot-request':
        client.socket.sendJson({ type: 'snapshot', items: liveItems() })
        return
      case 'decision': {
        const result = decide(String(message.token ?? ''), String(message.action ?? ''))
        client.socket.sendJson({ type: 'ack', token: message.token, action: message.action, result })
        return
      }
      case 'focus-request': {
        // 扩展已经自己把标签抢到前台了，这里只需要让**页面中继**切到对应会话。
        // 回给扩展 = 无限循环（见 broadcast 的注释）。
        const sessionId = String(message.sessionId ?? '')
        if (sessionId) broadcast({ type: 'focus', sessionId }, 'page')
        return
      }
      default:
        log('warn', `unknown message type=${String(message.type)}`)
    }
  }

  /** 每 20 秒 ping 一次，顺带清理掉线连接；这也让扩展的 Service Worker 保持唤醒。 */
  const startHeartbeat = () => {
    if (pingTimer) return
    let lastShape = ''
    pingTimer = setInterval(() => {
      const now = Date.now()
      for (const client of [...clients.values()]) {
        if (client.socket.closed || now - client.lastSeen > CLIENT_TIMEOUT_MS) {
          try {
            client.socket.close(1001)
          } catch {
            /* 已断开 */
          }
          clients.delete(client.id)
          log(
            'info',
            `回收连接 id=${client.id} kind=${client.client} 存活=${Math.round((now - client.since) / 1000)}s ` +
              `静默=${Math.round((now - client.lastSeen) / 1000)}s 剩余=${clients.size}`,
          )
          continue
        }
        client.socket.ping()
      }
      // 连接构成变化时记一行：排查"无端多出一条 extension"全靠它。
      const shape = [...clients.values()].map((client) => `${client.id}:${client.client}`).join(',')
      if (shape !== lastShape) {
        lastShape = shape
        log('info', `连接构成变化 total=${clients.size} [${shape || '空'}]`)
      }
    }, PING_INTERVAL_MS)
    pingTimer.unref?.()
  }

  const stopHeartbeat = () => {
    clearInterval(pingTimer)
    pingTimer = null
  }

  return {
    config: cfg,
    wsToken,
    routes,
    acceptUpgrade,
    decide,
    pendingPayload,
    publicConfig,
    getWebUrl: () => webUrl,
    setWebUrl: (url) => {
      webUrl = url
    },
    startHeartbeat,
    stopHeartbeat,
    internals: {
      notifyApproval,
      notifyIdle,
      onSessionStatus,
      onSessionCreated,
      clients,
      pending,
      rememberTitle,
      broadcast,
      pushPending,
    },
  }
}

export function apply(ctx, config = {}) {
  const notifier = createNotifier(ctx, config)

  ctx.on('session/created', notifier.internals.onSessionCreated, { global: true })
  ctx.on('approval/request', function (request, next) {
    return notifier.internals.notifyApproval(request, next)
  }, { prepend: true })
  ctx.on('api-session/status', notifier.internals.onSessionStatus)

  ctx.inject(['webServer'], (scope) => {
    const port = Number(scope.webServer?.port)
    if (Number.isSafeInteger(port) && port > 0) notifier.setWebUrl(`http://127.0.0.1:${port}`)
    for (const route of notifier.routes) {
      scope.effect(() => scope.webServer.register(route), `dsh-notifier: ${route.path}`)
    }
    scope.effect(
      () => scope.webServer.registerUpgrade({ path: `${PREFIX}/ws`, handler: notifier.acceptUpgrade }),
      'dsh-notifier: websocket',
    )
    // 给 index.html 盖一个标记，扩展的内容脚本据此确认"这个页面就是 dsh"，
    // 不会去连别的本地服务。
    scope.effect(
      () =>
        scope.webServer.tapIndex((html) =>
          html.includes(META_MARK) ? html : html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${META_MARK}`),
        ),
      'dsh-notifier: index marker',
    )
    notifier.startHeartbeat()
    ctx.logger?.info?.(`dsh-notifier: 通知通道就绪 http://127.0.0.1:${port}${PREFIX}/ws`)
  })

  ctx.effect(
    () => () => {
      notifier.stopHeartbeat()
      for (const record of notifier.internals.pending.clear()) record.settle?.({ type: 'disposed' })
      for (const client of [...notifier.internals.clients.values()]) {
        try {
          client.socket.close(1001)
        } catch {
          /* 已断开 */
        }
      }
      notifier.internals.clients.clear()
    },
    'dsh-notifier: cleanup',
  )
}

export { DEFAULT_CONFIG }
