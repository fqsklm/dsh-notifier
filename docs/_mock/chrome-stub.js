/**
 * 截图用的假 chrome API（只是让真实的 options.html / options.js 在页面上跑起来）。
 *
 * 两点很关键，否则截出来是一张"还没检测到实例"的空面板：
 *   1. 不能整体替换 window.chrome —— 在 Chromium 里 chrome 已经存在且属性不可写，
 *      `window.chrome = {...}` 静默失败，options.js 会调用真的 chrome.runtime.sendMessage
 *      并抛 "Extension context invalid"。所以这里**逐个属性覆盖**。
 *   2. 顺带把文档真实高度写进 <html data-doc-height>，shoot.ps1 用它在截图前把
 *      视口高度调到位，避免底部被裁掉。
 */
const stubOrigin = {
  origin: 'http://127.0.0.1:3080',
  isHost: true,
  connected: true,
  visible: true,
  focused: true,
  clientsByKind: { extension: 1, page: 1 },
}

function define(target, key, value) {
  try {
    target[key] = value
  } catch {
    /* 不可写就退回 defineProperty */
  }
  try {
    Object.defineProperty(target, key, { value, configurable: true, writable: true })
  } catch {
    /* 全都不行也没关系，下面的填充逻辑会兜住 */
  }
}

const status = {
  origins: [stubOrigin],
  notifications: [{ kind: 'approval', sessionId: 'session-a1b2c3d4e5f6' }],
  forceShow: false,
  notificationTimeoutSec: 0,
  // 「最近一条」那一行显示的判定结果：取一个"页面不在眼前所以弹了"的例子。
  // 示例文字和 README / 通知示意图里用的是同一条申请，看起来是一件事。
  lastDecision: {
    kind: 'approval',
    reason: 'page-away',
    at: Date.now() - 42000,
    page: { visible: false, focused: false },
  },
}

const chromeObject = window.chrome ?? {}
define(window, 'chrome', chromeObject)
define(chromeObject, 'runtime', {
  lastError: undefined,
  sendMessage: async (message) => {
    if (message?.type === 'notification-timeout') return { ok: true }
    if (message?.type === 'force-show') return { ok: true }
    if (message?.type === 'connect') return { ok: true }
    return { ok: true, status }
  },
})
define(chromeObject, 'storage', {
  session: { get: async () => ({}), set: async () => {} },
  local: { get: async () => ({}), set: async () => {} },
})

// 面板每 3 秒自己刷新一次，所以状态渲染完会再量一次（只是为了本地排错时能看数）。
// 截图本身**不**依赖这个数：shoot.ps1 用固定视口高度，量高度那条路已经证明不可靠
// （同一份文件既量出过 1900，也量出过 16，被截图时序左右）。
const measure = () => {
  const body = document.body
  const children = [...body.children]
  const last = children[children.length - 1]
  const paddingBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0
  const bottom = last ? last.getBoundingClientRect().bottom + window.scrollY : 0
  document.documentElement.dataset.docDebug = `kids=${children.length} bottom=${Math.round(bottom)} pad=${paddingBottom}`
}
window.addEventListener('load', () => {
  setTimeout(measure, 800)
  setTimeout(measure, 3600)
})
