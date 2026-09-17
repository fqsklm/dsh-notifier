/**
 * 清掉宿主里排队中的待办（排错时用，例如堆了一批已经不需要的提醒）。
 * 用法: node scripts/clear-pending.mjs [base]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080'

const before = await (await fetch(`${base}/dsh-notifier/pending`)).json()
if (!before.items?.length) {
  console.log('待办本来就是空的')
  process.exit(0)
}
for (const item of before.items) {
  const response = await fetch(`${base}/dsh-notifier/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: item.token, action: 'open' }),
  })
  console.log(`清理 ${item.token} (${item.kind}) -> ${response.status}`)
}
const after = await (await fetch(`${base}/dsh-notifier/pending`)).json()
console.log(`剩余待办: ${after.items.length}`)
