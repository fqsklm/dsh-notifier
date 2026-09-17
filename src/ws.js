/**
 * dsh-notifier — 极简 WebSocket 服务端（RFC 6455）。
 *
 * 只实现浏览器扩展需要的那一小块：握手、文本帧、ping/pong、close。
 * 不依赖 `ws` 之类的第三方库，保证插件直接 link 进 profile 就能跑。
 */
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 计算 Sec-WebSocket-Accept。 */
export function acceptKey(clientKey) {
  return createHash('sha1').update(`${String(clientKey)}${GUID}`).digest('base64')
}

/**
 * 解析 Upgrade 请求。返回 null 表示这不是一个合法的 WebSocket 握手。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} path 期望的 pathname
 */
export function handshake(req, path) {
  if (String(req.method).toUpperCase() !== 'GET') return null
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return null
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) return null
  const version = Number(req.headers['sec-websocket-version'])
  if (Number.isFinite(version) && version !== 13) return null
  let url
  try {
    url = new URL(req.url ?? '/', 'http://dsh.invalid')
  } catch {
    return null
  }
  if (url.pathname !== path) return null
  return { url, key, protocol: req.headers['sec-websocket-protocol'] }
}

/** 组一帧（服务端 → 客户端不掩码）。 */
export function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const head = []
  head.push(0x80 | opcode)
  if (body.length < 126) {
    head.push(body.length)
  } else if (body.length < 65536) {
    head.push(126, (body.length >> 8) & 0xff, body.length & 0xff)
  } else {
    head.push(127, 0, 0, 0, 0, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff)
  }
  return Buffer.concat([Buffer.from(head), body])
}

/**
 * 增量解析客户端帧。浏览器发的帧一定带掩码。
 * 返回 { frames, rest }：rest 是尚未收齐的残余字节。
 *
 * 注意 `limit` 要在**读长度头之后立刻**判：否则一条声称自己有几 GB 的帧会让
 * 调用方一直往缓冲区里攒数据（真正的分配发生在收齐那一刻），等于给回环之外的
 * 进程留了一个"用声明长度换内存"的口子。
 * 默认 64 KiB：客户端只发 ready / state / decision / pong 这些小消息，够用。
 */
export function decodeFrames(buffer, limit = 64 * 1024) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      const high = buffer.readUInt32BE(cursor)
      const low = buffer.readUInt32BE(cursor + 4)
      length = high * 2 ** 32 + low
      cursor += 8
    }
    if (length > limit) throw new Error(`dsh-notifier: websocket frame too large (${length} > ${limit})`)
    const maskLength = masked ? 4 : 0
    if (cursor + maskLength + length > buffer.length) break
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null
    cursor += maskLength
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    cursor += length
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
    }
    frames.push({ fin, opcode, payload })
    offset = cursor
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 一个已升级的 socket 包装：文本消息按整条给出（自动聚合分片）。
 * @param {import('node:stream').Duplex} socket
 */
export function createSocket(socket, { onMessage, onClose, onError } = {}) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let closed = false

  const send = (text, opcode = 0x1) => {
    if (closed || socket.destroyed) return false
    try {
      socket.write(encodeFrame(text, opcode))
      return true
    } catch {
      return false
    }
  }

  const close = (code = 1000) => {
    if (closed) return
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    send(body, 0x8)
    closed = true
    try {
      socket.end()
    } catch {
      /* 已断开 */
    }
  }

  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    let parsed
    try {
      parsed = decodeFrames(buffer)
    } catch (error) {
      onError?.(error)
      close(1009)
      return
    }
    buffer = parsed.rest
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        close(1000)
        return
      }
      if (frame.opcode === 0x9) {
        send(frame.payload, 0xa)
        continue
      }
      if (frame.opcode === 0xa) {
        continue
      }
      if (frame.opcode === 0x0) {
        fragments.push(frame.payload)
      } else {
        fragments = [frame.payload]
      }
      if (!frame.fin) continue
      const payload = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      if (frame.opcode === 0x1) onMessage?.(payload.toString('utf8'))
    }
  })

  socket.on('close', () => {
    if (closed) return
    closed = true
    onClose?.()
  })
  socket.on('error', (error) => {
    onError?.(error)
  })

  return {
    send,
    sendJson: (value) => send(JSON.stringify(value)),
    ping: () => send(Buffer.alloc(0), 0x9),
    close,
    get closed() {
      return closed || socket.destroyed
    },
  }
}
