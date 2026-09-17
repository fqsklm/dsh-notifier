/**
 * 盯住宿主的「待办 + 最近审批」，把每一条待办**属于哪个会话**记下来。
 *
 * 为什么需要它：用户报"一轮结束的通知总是重复弹"。宿主每轮结束会为**每个会话**
 * 各发一条 idle 待办，所以"看起来重复"有两种完全不同的原因：
 *   a) 同一个会话被连发了两条（真 bug）；
 *   b) 不同会话各自结束（正常，但提醒文案里只写了 #短id，看着像重复）。
 * 这个脚本把 sessionId 一起打出来，一眼能分辨是 a 还是 b。
 *
 * 只读，不动宿主任何状态。
 *
 * 跑法: node scripts/watch-idle.mjs [origin] [seconds]
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const seconds = Number(process.argv[3] ?? 600)
const deadline = Date.now() + seconds * 1000

const stamp = () => new Date().toISOString().slice(11, 19)
const short = (id) => (String(id ?? '').startsWith('session-') ? String(id).slice(8, 16) : String(id ?? '?'))
const get = async (path) => {
  try {
    return await (await fetch(`${origin}${path}`, { cache: 'no-store' })).json()
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 上一次每条待办的关键字段，用来判断"变了"和"怎么变的"。 */
let previous = new Map()
const seenIdle = []

console.log(`${stamp()} 盯着 ${origin} 的待办（最多 ${seconds}s）；每行 = 一次变化`)

while (Date.now() < deadline) {
  const pending = await get('/dsh-notifier/pending')
  const items = pending?.items ?? []
  const now = new Map(items.map((item) => [item.token, item]))

  for (const [token, item] of now) {
    if (previous.has(token)) continue
    const line = `${stamp()} ＋ ${item.kind} token=${token} 会话=#${short(item.sessionId)} (${item.sessionId}) 标题=${item.title}`
    console.log(line)
    if (item.kind === 'idle') seenIdle.push({ at: Date.now(), sessionId: item.sessionId, token })
  }
  for (const [token, item] of previous) {
    if (now.has(token)) continue
    console.log(`${stamp()} － ${item.kind} token=${token} 会话=#${short(item.sessionId)}（已作答/被撤下/被替换）`)
  }
  previous = now

  await new Promise((resolve) => setTimeout(resolve, 700))
}

console.log('')
console.log(`---- 本次共看到 ${seenIdle.length} 条「一轮结束」待办 ----`)
const perSession = new Map()
for (const entry of seenIdle) perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1)
for (const [sessionId, count] of perSession) {
  console.log(`   #${short(sessionId)}（${sessionId}）：${count} 条${count > 1 ? '  ← 同一个会话连发，这才是要查的那种"重复"' : ''}`)
}
if (seenIdle.length > 1) {
  for (let i = 1; i < seenIdle.length; i += 1) {
    const gap = ((seenIdle[i].at - seenIdle[i - 1].at) / 1000).toFixed(1)
    const same = seenIdle[i].sessionId === seenIdle[i - 1].sessionId
    console.log(`   第 ${i} → ${i + 1} 条间隔 ${gap}s ${same ? '（同一个会话）' : '（不同会话，属正常）'}`)
  }
}
