/**
 * dsh-notifier 扩展 — 选项页 / 弹出面板。
 * 只做三件事：看连接状态、手动补一个地址、调通知的显示方式。
 */

const $ = (id) => document.getElementById(id)

/**
 * 面板里所有操作的统一反馈行。
 *
 * 这个函数以前**根本不存在**（改设置/连接时直接抛
 * `ReferenceError: flash is not defined`，而且是在 async 监听器里，
 * 所以只在控制台里变成一条 unhandled rejection，界面上什么也不显示）。
 * 现在它是一个真实存在的 status line。
 */
function flash(message, { error = false } = {}) {
  const box = $('actionResult')
  if (!box) return
  box.textContent = String(message ?? '')
  box.classList.toggle('err', error === true)
  box.classList.add('show')
}

async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

function renderStatus(status) {
  const box = $('origins')
  box.textContent = ''
  const origins = status?.origins ?? []
  if (origins.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没发现 dsh 实例。先打开 dsh 的网页（默认 http://127.0.0.1:3080）。'
    box.append(empty)
  }
  for (const row of origins) {
    const wrap = document.createElement('div')
    wrap.className = 'row'

    const left = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = row.origin
    const detail = document.createElement('div')
    detail.className = 'dim'
    const kind = row.clientsByKind
    const kindText = kind
      ? `扩展 ${kind.extension ?? 0} 条 · 页面中继 ${kind.page ?? 0} 条`
      : ''
    detail.textContent = row.isHost
      ? `${row.connected ? '通知通道已连接' : '未连接'} · 页面${row.visible ? '可见' : '隐藏'}${row.focused ? '且聚焦' : ''}${kindText ? ` · ${kindText}` : ''}`
      : '不是 dsh-notifier 宿主'
    left.append(name, detail)

    const right = document.createElement('div')
    right.className = row.connected ? 'ok' : row.isHost ? 'bad' : 'dim'
    right.textContent = row.connected ? '● 在线' : row.isHost ? '○ 离线' : '—'
    wrap.append(left, right)
    box.append(wrap)
  }

  const pendingBox = $('pending')
  const items = status?.notifications ?? []
  pendingBox.textContent = ''
  if (items.length === 0) {
    pendingBox.textContent = '没有'
  } else {
    const list = document.createElement('ul')
    for (const item of items) {
      const li = document.createElement('li')
      li.textContent = `${item.kind === 'approval' ? '审批' : '一轮结束'} · ${item.sessionId ?? ''}`
      list.append(li)
    }
    pendingBox.append(list)
  }
}

async function refresh() {
  const result = await ask({ type: 'status' })
  if (!result?.ok) {
    $('origins').textContent = `状态读取失败：${result?.error ?? 'unknown'}`
    return
  }
  renderStatus(result.status)
  renderDecision(result.status)
}

const REASON_TEXT = {
  forced: '强制弹通知已打开 · 弹出',
  'already-delivered': '这条之前已经弹过 · 不重复弹',
  'already-shown': '已在通知中心里 · 不重复弹',
  'page-focused': '跳过 · dsh 页面可见且窗口有焦点（网页里的卡片就在眼前）',
  'page-away': '弹出 · dsh 页面不在眼前',
}

function renderDecision(status) {
  const box = $('lastDecision')
  const decision = status?.lastDecision
  const forceBox = $('force')
  if (forceBox && forceBox.checked !== Boolean(status?.forceShow)) forceBox.checked = Boolean(status?.forceShow)

  const durationBox = $('duration')
  if (durationBox && status?.notificationTimeoutSec !== undefined) {
    const value = String(status.notificationTimeoutSec)
    if (durationBox.value !== value && [...durationBox.options].some((entry) => entry.value === value)) {
      durationBox.value = value
    }
  }

  if (!decision) {
    box.textContent = '还没有收到过通知。'
    return
  }
  const page = decision.page
  const pageText = page
    ? `页面${page.visible ? '可见' : '隐藏'}${page.focused ? '、窗口有焦点' : '、窗口没焦点'}`
    : '页面状态未知'
  const reason = REASON_TEXT[decision.reason] ?? decision.reason
  const ago = Math.max(0, Math.round((Date.now() - decision.at) / 1000))
  box.textContent = `最近一条 · ${decision.kind === 'approval' ? '审批' : '提醒'} · ${reason}（${pageText}，${ago} 秒前）`
}

$('duration').addEventListener('change', async () => {
  const value = Number($('duration').value)
  const result = await ask({ type: 'notification-timeout', value })
  const label = value === 0 ? '永久（直到你划掉）' : `${value} 秒`
  const message = result?.ok ? `已保存：${label}` : `保存失败：${result?.error ?? ''}`
  $('durationResult').textContent = message
  flash(message, { error: !result?.ok })
})

$('force').addEventListener('change', async () => {
  const box = $('force')
  const value = box.checked
  const result = await ask({ type: 'force-show', value })
  if (!result?.ok) {
    // 存不上就把勾选状态退回去，否则界面会显示一个并没有生效的设置。
    box.checked = !value
  }
  flash(
    result?.ok ? (value ? '已打开：以后一律弹通知。' : '已关闭：页面在眼前时仍然不打扰。') : `设置失败：${result?.error ?? ''}`,
    { error: !result?.ok },
  )
  void refresh()
})

$('connect').addEventListener('click', async () => {
  const value = $('manual').value.trim()
  if (!value) {
    flash('先填一个地址。', { error: true })
    return
  }
  const result = await ask({ type: 'connect', origin: value })
  flash(result?.ok ? '已尝试连接。' : `连接失败：${result?.error ?? '未知原因'}`, { error: !result?.ok })
  void refresh()
})

$('refresh').addEventListener('click', () => void refresh())

void refresh()
setInterval(() => void refresh(), 3000)
