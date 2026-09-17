/**
 * 「在网页里按一次允许」的单元测试（extension/page-approval.js）。
 *
 * 这段代码是"通知点允许后，网页卡片不消失"的修复本体，所以必须盯着：
 * - 卡片只有一个时，要按下那个「允许一次」；
 * - 卡片有多个而认不准是哪一张时，**宁可不动**（点错卡片＝替用户答掉另一条申请）；
 * - 认不得按钮文案（UI 改版）时，退回操作行最后一个按钮；
 * - 页面里没有卡片时要如实报 no-card，让后台保留"宿主直接作答"的兜底。
 *
 * 用一套极简假 DOM：`findApprovalButton` 只用到 querySelectorAll / textContent /
 * closest / disabled / getAttribute / click，够用就行，不引第三方依赖。
 *
 * 跑法: node test/page-approval.mjs
 */
import { findApprovalButton, allowInPage, ALLOW_LABEL } from '../extension/page-approval.js'

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: ok === true, detail: String(detail) })

// ---------------------------------------------------------------- 极简假 DOM

function el(tag, { text = '', disabled = false, attrs = {}, children = [] } = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    ownText: text,
    disabled,
    children,
    parent: null,
    _listeners: {},
    attrs,
    /** 和真实 DOM 一样：textContent 包含整棵子树的文字。 */
    get textContent() {
      return [node.ownText, ...(node.children ?? []).map((child) => child.textContent)].join('')
    },
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? String(attrs[name]) : null
    },
    click() {
      node.clicked = true
      for (const fn of node._listeners.click ?? []) fn()
    },
    addEventListener(type, fn) {
      node._listeners[type] = [...(node._listeners[type] ?? []), fn]
    },
    // Element.querySelectorAll：只在子树里找。
    querySelectorAll(selector) {
      return collect(node, (candidate) => matches(candidate, selector))
    },
  }
  for (const child of children) child.parent = node
  return node
}

/** 收集一个节点子树里所有带 tagName 的节点。 */
function collect(node, predicate, out = []) {
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

function matches(node, selector) {
  const parts = selector.split(',').map((part) => part.trim())
  return parts.some((part) => {
    const tag = /^[a-z]+$/i.exec(part)
    if (tag) return node.tagName === tag[0].toUpperCase()
    if (part.startsWith('[data-approval-key]')) return node.getAttribute?.('data-approval-key') !== null
    return false
  })
}

/** 装一个最小 document：按 selector 做子树过滤。 */
function mountDocument(cards) {
  const root = el('body', { children: cards })
  const document = {
    querySelectorAll(selector) {
      return collect(root, (node) => matches(node, selector))
    },
  }
  return { root, document }
}

/** 造一张审批卡：headline + 操作行（拒绝 / 允许一次）。 */
function approvalCard(reason, { allowLabel = ALLOW_LABEL, key = 'approval:1' } = {}) {
  const reject = el('button', { text: '拒绝' })
  const allow = el('button', { text: allowLabel })
  const row = el('div', { attrs: { class: 'mna1RW_actionRow' }, children: [reject, allow] })
  const headline = el('div', { text: reason })
  const body = el('div', { children: [headline, row] })
  const card = el('div', { attrs: { 'data-approval-key': key }, children: [body] })
  card.allowButton = allow
  card.rejectButton = reject
  return card
}

const Reason = 'escalate sandbox to danger-full-access: 需要在工作区之外写一个临时文件'

/** 在假 document 下调用被注入页面的那个函数。 */
function run(cards, reason) {
  const { document } = mountDocument(cards)
  const saved = globalThis.document
  globalThis.document = document
  try {
    return findApprovalButton(reason)
  } finally {
    globalThis.document = saved
  }
}

// ---------------------------------------------------------------- 断言

{
  const card = approvalCard(Reason)
  const result = run([card], Reason)
  check('单张卡片：按下「允许一次」', result.ok === true && card.allowButton.clicked === true, JSON.stringify(result))
  check('没有误点「拒绝」', card.rejectButton.clicked !== true, `reject clicked=${card.rejectButton.clicked}`)
  check('返回值里带 cards 数（排查用）', result.cards === 1, JSON.stringify(result))
  check('按精确文案命中，matchedBy=exact-label', result.matchedBy === 'exact-label', JSON.stringify(result))
}

{
  // 英文界面：同一颗按钮换成 Allow once。
  const card = approvalCard(Reason, { allowLabel: 'Allow once' })
  const result = run([card], Reason)
  check('英文界面下按 Allow once 命中', result.ok === true && card.allowButton.clicked === true && result.matchedBy === 'exact-label', JSON.stringify(result))
}

{
  // 卡片被别的 UI 包了一层（比如 slot 容器）也照样找得到，因为只认 data-approval-key。
  const inner = approvalCard(Reason)
  const wrapper = el('div', { attrs: { class: 'some-wrapper' }, children: [inner] })
  const result = run([wrapper], Reason)
  check('卡片外面套了别的东西也认得出（只认卡片自身标记）', result.ok === true && inner.allowButton.clicked === true, JSON.stringify(result))
}

{
  // 通知正文被 clip 到 320 字，卡片上是原文 —— 前缀相同就算同一条。
  const card = approvalCard(`${Reason}${'很长的补充说明'.repeat(60)}`)
  const clipped = `${Reason}${'很长的补充说明'.repeat(20)}`.slice(0, 320)
  const result = run([card], clipped)
  check('正文被裁过（前缀相同）也能认准卡片', result.ok === true && card.allowButton.clicked === true, JSON.stringify(result))
}

{
  const a = approvalCard('escalate sandbox to danger-full-access: 改造 A 目录', { key: 'approval:1' })
  const b = approvalCard('escalate sandbox to danger-full-access: 改造 B 目录', { key: 'approval:2' })
  const result = run([a, b], 'escalate sandbox to danger-full-access: 改造 B 目录')
  check('多张卡片时按正文认准目标', result.ok === true && b.allowButton.clicked === true && a.allowButton.clicked !== true, JSON.stringify(result))
}

{
  const a = approvalCard('原因甲', { key: 'approval:1' })
  const b = approvalCard('原因乙', { key: 'approval:2' })
  const result = run([a, b], '')
  check('多张卡片又说不清是哪条：宁可不动', result.ok === false && a.allowButton.clicked !== true && b.allowButton.clicked !== true, JSON.stringify(result))
  check('这种情况如实报 ambiguous', result.reason === 'ambiguous', JSON.stringify(result))
}

{
  const a = approvalCard('原因甲', { key: 'approval:1' })
  const b = approvalCard('原因乙', { key: 'approval:2' })
  const result = run([a, b], '完全对不上的一条申请')
  check('多张卡片且都对不上：报 ambiguous 而不是瞎点', result.ok === false && result.reason === 'ambiguous', JSON.stringify(result))
}

{
  // UI 改版：文案变了，靠"卡片操作行里最后一个按钮"的结构兜底（并标记出来）。
  const card = approvalCard(Reason, { allowLabel: '同意' })
  const result = run([card], Reason)
  check('文案改版时退回操作行最后一个按钮', result.ok === true && card.allowButton.clicked === true, JSON.stringify(result))
  check('这种情况标记 matchedBy=last-button-fallback（日志能看出来）', result.matchedBy === 'last-button-fallback', JSON.stringify(result))
}

{
  // 只有一张卡片、但按钮文案完全不认识：仍然只动**最后一个**按钮，不碰第一个（拒绝）。
  const card = approvalCard(Reason, { allowLabel: 'Yes' })
  const result = run([card], Reason)
  check('陌生文案下不会点到第一个按钮（拒绝）', result.ok === true && card.rejectButton.clicked !== true && card.allowButton.clicked === true, JSON.stringify(result))
}

{
  const result = run([], Reason)
  check('页面里没有卡片：报 no-card（后台据此走宿主直接作答）', result.ok === false && result.reason === 'no-card', JSON.stringify(result))
}

{
  // 卡片上的按钮已经 disabled（网页先答完了）：不该再点。
  const card = approvalCard(Reason)
  card.allowButton.disabled = true
  card.rejectButton.disabled = true
  const result = run([card], Reason)
  check('按钮已 disabled 时不动它', result.ok === false && card.allowButton.clicked !== true, JSON.stringify(result))
}

{
  // 点完 React 会把按钮置灰 —— 这是"确实点到了"的凭据。
  const card = approvalCard(Reason)
  card.allowButton.addEventListener('click', () => {
    card.allowButton.disabled = true
  })
  const result = run([card], Reason)
  check('点完之后按钮置灰 → answered=true', result.ok === true && result.answered === true, JSON.stringify(result))
}

// ---------------------------------------------------------------- 注入那一步（allowInPage）

{
  const calls = []
  const saved = globalThis.chrome
  globalThis.chrome = {
    scripting: {
      async executeScript({ target, args }) {
        calls.push({ target, args })
        // 前两次"卡片还没渲染出来"，第三次才点到 —— 真实时序就是这样。
        if (calls.length < 3) return [{ result: { ok: false, reason: 'no-card' } }]
        return [{ result: { ok: true, answered: true } }]
      },
    },
  }
  try {
    const result = await allowInPage(7, Reason, { attempts: 5, gapMs: 1 })
    check('页面还没渲染出卡片时会重试，最终点到', result.ok === true, JSON.stringify(result))
    check('重试次数符合"卡片晚一点出现"的实际情况', calls.length === 3, `calls=${calls.length}`)
    check('注入目标就是那个标签页', calls[0].target.tabId === 7, JSON.stringify(calls[0].target))
    check('把申请原文一起注入（用来认准哪张卡片）', calls[0].args[0] === Reason, JSON.stringify(calls[0].args).slice(0, 80))
  } finally {
    globalThis.chrome = saved
  }
}

{
  const saved = globalThis.chrome
  globalThis.chrome = {
    scripting: {
      async executeScript() {
        throw new Error('Cannot access contents of the page')
      },
    },
  }
  try {
    const result = await allowInPage(7, Reason, { attempts: 3, gapMs: 1 })
    check('注入失败（标签已关/没权限）如实返回失败，不抛给调用方', result.ok === false && /inject-failed/.test(result.reason), JSON.stringify(result))
  } finally {
    globalThis.chrome = saved
  }
}

{
  const result = await allowInPage(undefined, Reason, { attempts: 1, gapMs: 1 })
  check('拿不到标签 id 时报 no-tab', result.ok === false && result.reason === 'no-tab', JSON.stringify(result))
}

console.log('')
let failed = 0
for (const { name, ok, detail } of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  [${detail}]`)
}
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
