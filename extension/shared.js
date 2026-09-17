/**
 * dsh-notifier 扩展 — 后台与选项页共用的小工具。
 */

/**
 * 通知按钮的动作 → 中文文案。
 *
 * 刻意**没有 `reject` 分支**：审批通知的按钮就是 `['open','allow']`
 * （Windows 只给两个按钮位，放第三个会被系统静默丢掉），拒绝走「回到对话」
 * 回网页里点。`reject` 作为协议动作仍然有效（网页卡片 / HTTP 都能发），
 * 只是不会成为通知按钮。
 *
 * 放在这里而不是 background.js：它是纯映射，宿主的测试要拿它和 manifest /
 * package 的描述做一致性校验，而 Service Worker 自己没法被 Node 直接 import。
 */
export function buttonTitle(action) {
  if (action === 'allow') return '允许'
  if (action === 'dismiss') return '知道了'
  return '回到对话'
}

export async function health(origin, timeoutMs = 1500) {
  try {
    const response = await fetch(`${origin}/dsh-notifier/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

export async function getConfig(origin, timeoutMs = 2000) {
  try {
    const response = await fetch(`${origin}/dsh-notifier/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}
