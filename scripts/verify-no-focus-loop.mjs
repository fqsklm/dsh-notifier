/**
 * 在线验证 focus 死循环已修复。
 *
 * 复现路径：扩展点「回到对话」→ 抢前台 + 发 focus-request →
 * 宿主若把 focus 广播回扩展 → 扩展再抢、再请求 → 自激。
 *
 * 用法: node scripts/verify-no-focus-loop.mjs [base]
 */
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { decodeFrames } from '../src/ws.js'

const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const port = Number(new URL(base).port)

const config = await (await fetch(`${base}/dsh-notifier/config`)).json()
console.log(`宿主连接构成: ${JSON.stringify(config.clientsByKind)}`)

const socket = connect({ port, host: '127.0.0.1' })
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
  `GET /dsh-notifier/ws?t=${config.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
)
await new Promise((resolve) => setTimeout(resolve, 300))

function send(value) {
  const payload = Buffer.from(JSON.stringify(value))
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3]
  const head = [0x81]
  if (masked.length < 126) head.push(0x80 | masked.length)
  else head.push(0x80 | 126, (masked.length >> 8) & 0xff, masked.length & 0xff)
  socket.write(Buffer.concat([Buffer.from(head), mask, masked]))
}

// 冒充扩展：连上后像"点了回到对话"那样连发 5 次 focus-request
send({ type: 'ready', client: 'extension', origin: base })
await new Promise((resolve) => setTimeout(resolve, 200))
for (let i = 0; i < 5; i += 1) send({ type: 'focus-request', sessionId: 'session-verify' })

await new Promise((resolve) => setTimeout(resolve, 4000))
const focusFrames = frames.filter((frame) => frame.type === 'focus').length
console.log(`以 extension 身份请求 focus 后，4 秒内收到 focus 帧: ${focusFrames}`)
console.log(`总帧数 ${frames.length}，类型: ${[...new Set(frames.map((frame) => frame.type))].join(', ')}`)
console.log(focusFrames === 0 ? '✅ 循环已断：focus 不再回给扩展' : '❌ 仍在回给扩展，循环没修好')
process.exit(focusFrames === 0 ? 0 : 1)
