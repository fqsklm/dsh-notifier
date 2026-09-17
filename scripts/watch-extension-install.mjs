/**
 * 守候扩展安装：盯着宿主，等着看"扩展身份"的连接出现，并确认排队中的通知被取走。
 *
 * 用法: node scripts/watch-extension-install.mjs [等待秒数] [base]
 */
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { decodeFrames } from '../src/ws.js'

const waitSec = Number(process.argv[2] ?? 600)
const base = process.argv[3] ?? 'http://127.0.0.1:3080'
const started = Date.now()

const stamp = () => `[${((Date.now() - started) / 1000).toFixed(0)}s]`

/** 借一条我们自己的 WebSocket，用 ready/state 的身份字段反推宿主当前的连接构成。 */
async function probe() {
  const config = await (await fetch(`${base}/dsh-notifier/config`)).json()
  const socket = connect({ port: Number(new URL(base).port), host: '127.0.0.1' })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  let buffer = Buffer.alloc(0)
  let handshaken = false
  const frames = []
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!handshaken) {
      const index = buffer.indexOf('\r\n\r\n')
      if (index === -1) return
      handshaken = /^HTTP\/1\.1 101/.test(buffer.subarray(0, index).toString('latin1'))
      buffer = buffer.subarray(index + 4)
    }
    const parsed = decodeFrames(buffer)
    buffer = parsed.rest
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x1) frames.push(JSON.parse(frame.payload.toString('utf8')))
    }
  })
  socket.write(
    `GET /dsh-notifier/ws?t=${config.token} HTTP/1.1\r\nHost: 127.0.0.1:${new URL(base).port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  const hello = frames.find((frame) => frame.type === 'hello')
  const snapshot = frames.find((frame) => frame.type === 'snapshot')
  try {
    socket.destroy()
  } catch {
    /* 忽略 */
  }
  return {
    clients: hello?.config?.clients ?? 0,
    byKind: hello?.config?.clientsByKind,
    pending: snapshot?.items?.length ?? 0,
    token: config.token,
  }
}

console.log(`${stamp()} 开始守候（最多 ${waitSec}s）。请现在去 chrome://extensions 加载扩展。`)

let sawExtension = false
let lastLine = ''
while (Date.now() - started < waitSec * 1000) {
  let state
  try {
    state = await probe()
  } catch (error) {
    console.log(`${stamp()} 读宿主失败：${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    continue
  }
  const kind = state.byKind ?? {}
  const extensionCount = kind.extension ?? null
  const line = `连接 ${state.clients}（扩展 ${extensionCount ?? '?'} / 页面 ${kind.page ?? '?'}）· 待办 ${state.pending}`
  if (line !== lastLine) {
    console.log(`${stamp()} ${line}${extensionCount === null ? '  ← 宿主还是旧代码，认不出身份，但待办数能说明问题' : ''}`)
    lastLine = line
  }
  if (extensionCount !== null && extensionCount > 0) sawExtension = true

  // 判定：待办从"有"变成 0，说明有客户端在连上时把快照里的通知都取走并弹了。
  if (state.pending === 0 && sawExtension) {
    console.log(`${stamp()} ✅ 扩展已连上（身份确认为 extension），并且排队中的通知已被取走。`)
    console.log(`${stamp()} 去看 Windows 通知中心（Win+N）：应该有一批通知，审批是「回到对话 / 允许」，一轮结束是「回到对话 / 知道了」。`)
    process.exit(0)
  }
  if (state.pending === 0 && !sawExtension) {
    console.log(`${stamp()} ✅ 待办已经清空（通知被取走了）。去看通知中心确认。`)
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

console.log(`${stamp()} ⏱ 等超时了。宿主侧待办仍是 ${lastLine}。`)
console.log('如果扩展已经加载：点扩展图标看一眼状态；必要时在 chrome://extensions 上点一下它的刷新按钮。')
process.exit(2)
