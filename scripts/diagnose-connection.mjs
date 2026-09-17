/**
 * 查两件事：
 * 1. 我们的扩展有没有被装进 Chrome / Edge（解压扩展的 ID 由路径哈希决定）。
 * 2. 宿主现在这条 WebSocket 到底是谁连的（扩展 Service Worker 还是页面里的中继）。
 *
 * 用法: node scripts/diagnose-connection.mjs [宿主地址] [扩展目录]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认按本脚本所在位置推扩展目录，可用第二个命令行参数覆盖。 */
const EXT_DIR = process.argv[3] ?? fileURLToPath(new URL('../extension', import.meta.url))

/** Chrome 的扩展 ID：路径 UTF-8 的 SHA-256 前 16 字节，每个 nibble 映射 0-f → a-p。 */
function extensionIdForPath(path) {
  const digest = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)
  return [...digest].map((ch) => String.fromCharCode(parseInt(ch, 16) + 97)).join('')
}

const expectedId = extensionIdForPath(EXT_DIR)
console.log(`扩展目录: ${EXT_DIR}`)
console.log(`期望的解压扩展 ID: ${expectedId}\n`)

const browsers = [
  { name: 'Chrome', dir: join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data') },
  { name: 'Edge', dir: join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data') },
]

for (const browser of browsers) {
  console.log(`=== ${browser.name} ===`)
  if (!existsSync(browser.dir)) {
    console.log('  (没装 / 没这个目录)')
    continue
  }
  const profiles = ['Default', ...Array.from({ length: 8 }, (_, index) => `Profile ${index + 1}`)]
  for (const profile of profiles) {
    const profileDir = join(browser.dir, profile)
    if (!existsSync(profileDir)) continue
    const files = ['Preferences', 'Secure Preferences', join('..', 'Local State')].map((name) => join(profileDir, name))
    const hits = []
    for (const file of files) {
      if (!existsSync(file)) continue
      try {
        const text = readFileSync(file, 'utf8')
        if (text.includes(expectedId)) hits.push(file.split('\\').pop())
      } catch {
        /* 被占用 / 读不了 */
      }
    }
    console.log(`  ${profile}: ${hits.length ? `命中 ${hits.join(', ')}` : '没有这个扩展的记录'}`)
  }
}

console.log('\n=== 宿主这条连接是谁 ===')
const base = process.argv[2] ?? 'http://127.0.0.1:3080'
try {
  const config = await (await fetch(`${base}/dsh-notifier/config`)).json()
  console.log(`  ${base} 扩展连接数 = ${config.clients}，待办 = ${config.pending}`)
} catch (error) {
  console.log(`  读 ${base} 失败: ${error.message}`)
}

console.log('\n说明：页面里的中继脚本（client/client.js）自己也会连一条 WebSocket，')
console.log(`所以"连接数 = 1"不能证明扩展装上了。区别在于：`)
console.log('  - 扩展的 Service Worker 连上后会发 ready{origin, focused, pid}')
console.log('  - 页面中继连上后只发 ready{origin, focused}（没有 pid）')
console.log('用带 debug 的宿主日志能看到 pid，或者直接看 chrome://extensions 最直接。')
