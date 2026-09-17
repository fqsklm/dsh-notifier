/**
 * dsh-notifier — 纯函数工具：文案裁剪、回环校验、配置归一化、待办项去重。
 * 不依赖 cordis，方便直接跑测试。
 */

export const DEFAULT_CONFIG = {
  /** 总开关 */
  enabled: true,
  /** 提权 / 沙箱审批提醒 */
  notifyApproval: true,
  /** 一轮对话结束时提醒 */
  notifyIdle: true,
  /** 子代理会话结束时提醒（默认关闭，避免刷屏） */
  notifySubagentIdle: false,
  /** 标题前缀 */
  titlePrefix: 'dsh',
  /** 通知里是否带上会话标题 */
  showSessionTitle: true,
  /** 通知正文里是否显示工具名 */
  showToolName: true,
}

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

export function asBool(value, fallback) {
  if (value === false || value === 0 || value === 'false' || value === '0') return false
  if (value === true || value === 1 || value === 'true' || value === '1') return true
  return fallback
}

export function nonNegativeInt(value, fallback) {
  if (value === false || value === null || value === '') return fallback
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/**
 * 归一化配置。
 *
 * 用**白名单**逐字段取值，而不是 `Object.assign(cfg, config)`：
 * 老版本的字段会留在用户的 `cordis.patch.yml` 里，如果照搬过来，
 * 一个已经从代码里删掉的开关会看起来"还在生效"（比如曾经那个
 * `cooldownMs`，删掉逻辑却还从配置里漏进 cfg，读起来就分不清到底还有没有冷却）。
 */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    enabled: asBool(raw.enabled, DEFAULT_CONFIG.enabled),
    notifyApproval: asBool(raw.notifyApproval, DEFAULT_CONFIG.notifyApproval),
    notifyIdle: asBool(raw.notifyIdle, DEFAULT_CONFIG.notifyIdle),
    notifySubagentIdle: asBool(raw.notifySubagentIdle, DEFAULT_CONFIG.notifySubagentIdle),
    showSessionTitle: asBool(raw.showSessionTitle, DEFAULT_CONFIG.showSessionTitle),
    showToolName: asBool(raw.showToolName, DEFAULT_CONFIG.showToolName),
    // 这里刻意**没有**任何冷却 / 间隔字段。见 README「为什么没有冷却」：
    // 一句话里连续申请两次权限是常态，按会话设的最小间隔会把第二次提醒直接吞掉。
    titlePrefix:
      typeof raw.titlePrefix === 'string' && raw.titlePrefix.trim()
        ? clip(raw.titlePrefix, 24)
        : DEFAULT_CONFIG.titlePrefix,
  }
}

export function isLoopbackAddress(address) {
  const raw = String(address ?? '').trim().toLowerCase()
  if (raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1') return true
  if (raw.startsWith('::ffff:127.')) return true
  return false
}

export function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? '').trim().toLowerCase()
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  if (text.startsWith('session-')) return text.slice(8, 16)
  return text.slice(0, 8)
}

export function sessionKindOf(session) {
  const header = session?.header
  if (!header || typeof header !== 'object') return 'unknown'
  if (header.origin === 'subagent' || Number(header.delegationDepth) > 0) return 'subagent'
  return 'primary'
}

export function shouldNotify(kind, eventKind, cfg) {
  if (kind === 'subagent') return eventKind === 'idle' ? cfg.notifySubagentIdle === true : false
  if (kind !== 'primary') return false
  if (eventKind === 'approval') return cfg.notifyApproval === true
  if (eventKind === 'idle') return cfg.notifyIdle === true
  return false
}

/**
 * 审批理由来自 `escalate sandbox to <mode>: <why>` 这种机器可读前缀，
 * 拆开以后通知里更好读。
 */
export function describeApproval({ toolName, reason } = {}, { showToolName = true } = {}) {
  const raw = String(reason ?? '').trim()
  const escalation = /^escalate sandbox to (\S+):\s*([\s\S]*)$/.exec(raw)
  if (escalation) {
    const mode = escalation[1]
    const why = clip(escalation[2], 320)
    const head = showToolName && toolName ? `${toolName} 申请提权到 ${mode}` : `申请提权到 ${mode}`
    return { title: head, body: why || '（未提供原因）' }
  }
  const head = showToolName && toolName ? `${toolName} 请求审批` : '请求审批'
  return { title: head, body: clip(raw, 320) || '（未提供原因）' }
}

/** 按会话标题 + 短 id 生成"哪个会话"的说明。 */
export function describeSession(sessionId, title, showSessionTitle = true) {
  const short = `#${shortSessionId(sessionId)}`
  const clean = typeof title === 'string' ? clip(title, 48) : ''
  if (!showSessionTitle || !clean) return short
  return `${clean} · ${short}`
}

/**
 * 待办表：token → 记录。同一会话同一类事件只保留最新一条，
 * 避免模型连续申请时通知刷屏。
 */
export function createPendingStore() {
  const byToken = new Map()

  const listOf = (predicate) => [...byToken.values()].filter((record) => !predicate || predicate(record))

  return {
    add(record) {
      byToken.set(record.token, record)
      return record
    },
    get(token) {
      return byToken.get(token)
    },
    delete(token) {
      return byToken.delete(token)
    },
    has(token) {
      return byToken.has(token)
    },
    list: listOf,
    /** 同一会话下同类事件的旧记录：新提醒替换旧提醒。 */
    supersededBy(sessionId, kind, keepToken) {
      const stale = []
      for (const record of byToken.values()) {
        if (record.sessionId !== sessionId) continue
        if (record.kind !== kind) continue
        if (record.token === keepToken) continue
        stale.push(record)
      }
      return stale
    },
    size() {
      return byToken.size
    },
    clear() {
      const all = [...byToken.values()]
      byToken.clear()
      return all
    },
  }
}
