/**
 * dsh-notifier 扩展 — 「在网页里按一次允许」。
 *
 * 为什么需要这个文件（这是"点了允许，网页里却没反应"的根因修复）：
 *
 * 网页里的审批卡是**浏览器那一半**渲染的（`dsh-client-ui-approval` 通过
 * `approval/request` 瀑布收到这条申请，把卡片挂出来，然后等自己那半边作答）。
 * 通知里的「允许」走的是另一条路：扩展把决定发回宿主，宿主**直接给瀑布一个结果**，
 * 于是工具确实执行了 —— 但浏览器那一半的 `pending.result` 没人作答，
 * 转发给页面的那条 waterfall 也永远不被 settle（api-remotes 只在"收到客户端答复"
 * 时才回 cancel 帧），**那张卡片就会一直停在「等待审批」**。
 * 实测：宿主的 /config 里 lastApproval 已经写着 `allowed-from-notification:allowed-once`，
 * 而网页里卡片还在，用户看到的现象就是「我点了允许，网页里没收到」。
 *
 * 所以通知里的「允许」不能只发决定：还要**让网页自己按一下那个按钮**，
 * 让网页沿它本来的通路作答、卡片自然消失、宿主拿到同一个结果。
 * 页内这一步失败（页面没开、卡片不在前台、UI 改版）时，退回原来的"宿主直接作答"。
 *
 * 注入方式：`chrome.scripting.executeScript({ func: findApprovalButton })`。
 * func 会被序列化后注入页面主世界，所以这个函数必须是**自包含**的（不许引用
 * 模块里的其它变量），返回值也必须是可序列化的。
 */

/**
 * 允许按钮的文案（dsh-client-ui-approval 的 zh 字典里写死的）。
 * 只给测试和文档用：注入页面的那个函数必须自包含，所以它自己写了一份同名字面量。
 */
export const ALLOW_LABEL = '允许一次'

/**
 * 注入页面的那次查找 + 点击。自包含，别引用外部变量（包括上面的常量）。
 *
 * 认卡片的规则刻意保守，**不做"页面特征"猜测**：
 *   1. 只认 DSH 自己写在卡片上的 `data-approval-key`（唯一的卡片锚点）；
 *   2. 按钮只在**这张卡片内部**找，且优先要求文案**精确等于**「允许一次 / Allow once」；
 *   3. 精确文案找不到时，才退回"卡片操作行里**最后一个**按钮"
 *      （DSH 的卡片结构是 拒绝 在左、允许 在右），并把这件事写进返回值；
 *   4. 页面上有多张卡、又对不上是哪一条时：报 ambiguous，**坚决不点**
 *      —— 点错卡片等于替用户答掉另一条申请；
 *   5. 连卡片都找不到：报 no-card，退化成"工具照常执行、卡片需手动点"，**不会点错**。
 */
export function findApprovalButton(reason) {
  const text = (node) => String(node?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const clipped = (value, max) => (value.length <= max ? value : `${value.slice(0, max)}…`)
  /**
   * 只在**多张卡片**时才需要判断"这张是不是那一条"：
   * 通知正文是申请原文裁到 320 字的前缀，卡片 headline 是原文，前缀相同即同一条。
   */
  const related = (left, right) => {
    if (!left || !right) return false
    const a = left.slice(0, 200)
    const b = right.slice(0, 200)
    return a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a)
  }

  const cards = [...document.querySelectorAll('[data-approval-key]')]
  if (cards.length === 0) return { ok: false, reason: 'no-card' }

  const reasonText = String(reason ?? '').replace(/\s+/g, ' ').trim()
  let card = cards[0]
  if (cards.length > 1) {
    card = reasonText ? (cards.find((node) => related(text(node), reasonText)) ?? null) : null
    if (!card) return { ok: false, reason: 'ambiguous', cards: cards.length }
  }

  const buttons = [...card.querySelectorAll('button')]
  if (buttons.length === 0) return { ok: false, reason: 'no-button' }
  const enabled = (button) => button.disabled !== true && button.getAttribute?.('aria-disabled') !== 'true'
  const usable = buttons.filter(enabled)
  if (usable.length === 0) return { ok: false, reason: 'no-button' }
  const exact = usable.find((item) => text(item) === '允许一次' || text(item) === 'Allow once')
  // 兜底：卡片操作行的最后一个按钮。DSH 的卡片是 [拒绝][允许一次]，允许永远在最后，
  // 所以这条兜底是"结构"而不是"文案猜测"；matchedBy 会把它标记出来便于排查。
  const button = exact ?? usable.at(-1)
  const matchedBy = exact ? 'exact-label' : 'last-button-fallback'

  const label = text(button)
  try {
    button.click()
  } catch (error) {
    return { ok: false, reason: `click-failed:${String(error?.message ?? error)}` }
  }
  // 点完之后卡片会被 React 置为"已作答"（按钮 disabled），这就是点到了的凭据。
  const answered = button.disabled === true || button.getAttribute?.('aria-disabled') === 'true'
  return { ok: true, answered, matchedBy, label: clipped(label, 20), cards: cards.length }
}

/**
 * 让网页按一次「允许」。只在通知那条路已经送达宿主之后才调用：
 * 顺序反过来的话，宿主先作答会把卡片撤掉，页内就没得点了。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>} ok=false 时调用方应保持现状（通知留着）
 */
export async function allowInPage(tabId, reason, { attempts = 6, gapMs = 150 } = {}) {
  if (typeof tabId !== 'number') return { ok: false, reason: 'no-tab' }
  let last = { ok: false, reason: 'not-run' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: findApprovalButton,
        args: [String(reason ?? '')],
      })
      last = results?.[0]?.result ?? { ok: false, reason: 'no-result' }
    } catch (error) {
      // 标签已关、没有该来源的注入权限、页面还没加载完 —— 都是"这次点不了"。
      return { ok: false, reason: `inject-failed:${String(error?.message ?? error)}` }
    }
    // 已经点到（answered）就算成功；卡片还没渲染出来时再等一会儿重试。
    if (last.ok) return last
    if (last.reason !== 'no-card' && last.reason !== 'no-button') return last
    await new Promise((resolve) => setTimeout(resolve, gapMs))
  }
  return last
}
