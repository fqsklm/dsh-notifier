/**
 * 生成扩展图标（纯 Node，不依赖任何图像库）。
 * 用法: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把一个 RGBA 像素函数渲染成 PNG。 */
function renderPng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
      offset += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BG = [37, 99, 235]
const FG = [255, 255, 255]

/** 圆角方块 + 白色铃铛。坐标归一化到 0..1。 */
function bell(x, y, size) {
  const u = (x + 0.5) / size
  const v = (y + 0.5) / size
  const radius = 0.22
  const cx = Math.min(Math.max(u, radius), 1 - radius)
  const cy = Math.min(Math.max(v, radius), 1 - radius)
  const dx = u - cx
  const dy = v - cy
  if (Math.hypot(dx, dy) > radius) return [0, 0, 0, 0]

  // 铃身：上圆下梯形的近似
  const bodyTop = 0.26
  const bodyBottom = 0.66
  const inside = (() => {
    if (v < bodyTop || v > bodyBottom + 0.1) return false
    const t = (v - bodyTop) / (bodyBottom - bodyTop)
    const halfWidth = 0.13 + t * 0.12
    return Math.abs(u - 0.5) <= halfWidth
  })()
  // 顶部提环
  const ring = Math.hypot(u - 0.5, v - (bodyTop - 0.05)) <= 0.06
  // 底部铃舌
  const clapper = Math.hypot(u - 0.5, v - (bodyBottom + 0.11)) <= 0.075

  if (inside || ring || clapper) return [...FG, 255]
  return [...BG, 255]
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT_DIR, `icon${size}.png`)
  writeFileSync(file, renderPng(size, bell))
  console.log(`wrote ${file}`)
}
