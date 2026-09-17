/**
 * 探测运行中的 dsh 是如何提供客户端插件 bundle 的。
 * 用法: node scripts/probe-client-bundles.mjs <启动 token>
 *
 * token 就是 `dsh web` 启动时打印的那个（http://127.0.0.1:3080/?token=...）。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const token = process.argv[3]

let cookie = ''
if (token) {
  const root = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  cookie = (root.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
  console.log(`token 交换: status=${root.status} cookie=${cookie ? '已获得' : '没有'}`)
} else {
  console.log('没给 token，只探测公开资源')
}

const headers = cookie ? { cookie } : {}

const index = await fetch(`${base}/`, { headers, redirect: 'manual' })
console.log(`GET / -> ${index.status}`)
if (index.status === 200) {
  const html = await index.text()
  console.log(`  index 长度 ${html.length}`)
  const hits = html.match(/[^\s"'<>]*dsh-notifier[^\s"'<>]*/g) ?? []
  console.log(`  html 里 dsh-notifier 出现 ${hits.length} 次:`, hits.slice(0, 5))
  const bootMatch = html.match(/globalThis\.__DSH_BOOT__\s*=/)
  console.log(`  内联 __DSH_BOOT__: ${bootMatch ? '有' : '没有'}`)
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
  console.log('  script src:', scripts)
  const graph = html.match(/"graph"\s*:\s*(\[[\s\S]{0,600})/)
  if (graph) console.log('  graph 片段:', graph[1].slice(0, 500))
  const combo = html.match(/\/plugins\/\?\?[^"']+/)
  if (combo) console.log('  combo url:', combo[0].slice(0, 300))
}

for (const path of [
  '/plugins/dsh-notifier/client.js',
  '/plugins/dsh-balance-chart/client.js',
  '/plugins/??dsh-notifier/client.js&rev=x',
]) {
  const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' })
  console.log(`${path} -> ${response.status}`)
}
