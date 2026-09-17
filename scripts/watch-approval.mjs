/**
 * 盯着正在运行的宿主，把"通知作答"这一串事件的先后顺序记下来。
 *
 * 用途：用户点通知里的按钮时，我们看不到浏览器那一半，但能从宿主这一侧看到
 *   /config.lastApproval（审批钩子的最新状态） 和 /pending（待办队列）怎么变。
 * 修复后期待时序：
 *   1. lastApproval.outcome = notified            （通知弹了，等着作答）
 *   2. lastApproval.outcome = answered-from-notification:allowed-once（通知里的允许到了）
 *   3. /pending 里那条审批消失
 *   4. 位置（不是作者）：工具执行；卡片该随页内点击消失
 *
 * 跑法: node scripts/watch-approval.mjs [origin] [seconds]
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const seconds = Number(process.argv[3] ?? 150)
const deadline = Date.now() + seconds * 1000

const stamp = () => new Date().toISOString().slice(11, 23)
const get = async (path) => {
  try {
    return await (await fetch(`${origin}${path}`, { cache: 'no-store' })).json()
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

let lastOutcome = null
let lastPending = null
let sawNotify = false
let sawAnswer = null
const timeline = []

const record = (line) => {
  timeline.push(`${stamp()} ${line}`)
  console.log(`${stamp()} ${line}`)
}

record(`开始盯着 ${origin}（最多 ${seconds}s）`)

while (Date.now() < deadline) {
  const config = await get('/dsh-notifier/config')
  const approval = config?.lastApproval
  const outcome = approval ? `${approval.outcome} @${new Date(approval.at).toISOString().slice(11, 19)}` : 'null'
  if (outcome !== lastOutcome) {
    lastOutcome = outcome
    record(`lastApproval 变了: outcome=${approval?.outcome ?? 'null'} tool=${approval?.toolName ?? '-'}`)
    if (approval?.outcome === 'notified') sawNotify = true
    if (String(approval?.outcome ?? '').startsWith('answered-from-notification')) {
      sawAnswer = approval.outcome
      record(`✅ 通知里的作答到宿主了：${approval.outcome}（工具会按这个结果执行）`)
    }
  }

  const pending = await get('/dsh-notifier/pending')
  const summary = (pending?.items ?? []).map((item) => `${item.kind}:${item.token}`).join(',') || '空'
  if (summary !== lastPending) {
    lastPending = summary
    record(`pending 变了: ${summary}`)
    if (sawAnswer && summary === '空') record('✅ 那条审批已经从待办队列里清掉了')
  }

  // 每次有变化时顺手记一下扩展那条连接：build 对不上就是"扩展没刷新，跑的还是旧代码"。
  if (config?.clientList) {
    for (const client of config.clientList) {
      if (client.client !== 'extension') continue
      const line = `扩展连接 id=${client.id} build=${client.build ?? '(未上报 → 旧代码)'} idle=${client.idleSec}s`
      if (!timeline.includes(line)) record(line)
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 800))
}

console.log('')
console.log('---- 时间线 ----')
for (const line of timeline) console.log(line)
console.log('')
console.log(sawAnswer ? `结论：通知作答已送达宿主（${sawAnswer}）` : '结论：这段时间里没看到通知作答（lastApproval 没变成 answered-from-notification:*）')
