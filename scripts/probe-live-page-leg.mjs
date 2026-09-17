/**
 * 一次性探针：连上**正在运行的** dsh 宿主上的 /dsh-notifier/ws，
 * 冒充"页面中继"（client: 'page'），看宿主的每条广播到底发了什么。
 *
 * 目的：验证「通知里点允许后，网页那半边究竟收到了什么」。
 * 只读 + 一条 decision，不改宿主状态之外的任何东西。
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const action = process.argv[3] ?? 'allow'
const waitMs = Number(process.argv[4] ?? 6000)

const config = await (await fetch(`${origin}/dsh-notifier/config`, { cache: 'no-store' })).json()
const token = config.token
console.log('host port', config.port, 'clients', JSON.stringify(config.clientsByKind), 'pending', config.pending)
console.log('lastApproval', JSON.stringify(config.lastApproval))

const wsUrl = `${origin.replace(/^http/, 'ws')}/dsh-notifier/ws?t=${encodeURIComponent(token)}`
const socket = new WebSocket(wsUrl)
const seen = []
/** 我们要作答的那条审批。 */
let target = null
let answered = false

const stamp = () => new Date().toISOString().slice(11, 23)

socket.addEventListener('open', () => {
  console.log(stamp(), 'open -> ready(page)')
  socket.send(JSON.stringify({ type: 'ready', client: 'page', build: 'probe', origin, focused: false }))
  void run()
})

socket.addEventListener('message', (event) => {
  let message
  try {
    message = JSON.parse(String(event.data))
  } catch {
    console.log(stamp(), 'non-json', String(event.data).slice(0, 120))
    return
  }
  seen.push(message)
  const brief = message.type === 'pending' || message.type === 'snapshot'
    ? JSON.stringify(message.items ?? message.item).slice(0, 200)
    : JSON.stringify(message).slice(0, 200)
  console.log(stamp(), '<<', message.type, brief)
  if (message.type === 'pending' && message.item?.kind === 'approval' && !target) target = message.item
  if (message.type === 'snapshot' && !target) {
    target = (message.items ?? []).find((item) => item.kind === 'approval') ?? null
    if (target) console.log(stamp(), 'snapshot 里已经有一条待作答审批：', target.token)
  }
})

async function run() {
  // 等宿主把 snapshot/pending 发过来。
  for (let i = 0; i < 40 && !target; i += 1) await new Promise((r) => setTimeout(r, 50))
  if (!target) {
    console.log(stamp(), '这次连接没收到审批待办；改成直接向 /pending 问一条')
    const live = await (await fetch(`${origin}/dsh-notifier/pending`, { cache: 'no-store' })).json()
    target = (live.items ?? []).find((item) => item.kind === 'approval') ?? null
    if (target) console.log(stamp(), '沿用已有待办', target.token)
  }
  if (!target) {
    console.log(stamp(), '没有待作答审批，退出')
    socket.close()
    process.exit(0)
  }
  console.log(stamp(), '模拟"点通知里的按钮" -> POST /action', action, target.token)
  answered = true
  const res = await fetch(`${origin}/dsh-notifier/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: target.token, action }),
  })
  console.log(stamp(), 'POST /action ->', res.status, JSON.stringify(await res.json()))
  await new Promise((r) => setTimeout(r, waitMs))
  console.log(stamp(), '---- 这次连接一共收到 ----')
  for (const message of seen) {
    console.log('   ', message.type, JSON.stringify(message).slice(0, 240))
  }
  console.log(
    stamp(),
    '作答后是否收到 resolved/该 token 的任何指令：',
    String(seen.some((m) => m.type === 'resolved' && m.token === target.token)),
  )
  socket.close()
  process.exit(0)
}

setTimeout(() => {
  console.log(stamp(), '超时退出；answered =', answered)
  process.exit(0)
}, 20000)
