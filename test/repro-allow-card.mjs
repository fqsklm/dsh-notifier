/**
 * 回归测试：「通知里点允许」之后，网页那张审批卡会不会被撤下。
 *
 * 用户报的现象是 **「这次允许我在通知里面点了，但还是没有作用，网页里没有收到我的允许」**：
 * 宿主 /config 的 lastApproval 明明已经写着 `answered-from-notification:allowed-once`、
 * 工具也真的执行了，可网页里的卡片还停在「等待审批」。
 *
 * 为什么：网页那张卡片是**浏览器那一半**渲染的（dsh-client-ui-approval 通过
 * `approval/request` 瀑布收到申请 → 挂卡片 → 等自己那半边作答）。
 * 本插件的宿主半边 prepend 抢在 api-remotes 前面，一有结果就**直接把瀑布结算了**；
 * 而 api-remotes 只在"收到客户端答复"时才回 cancel 帧 —— 转发给浏览器的那条
 * waterfall 就此被丢掉，浏览器永远等不到结果。
 *
 * 这个文件把**真实的** cordis Context 和**真实的** `@deepseek-ai/dsh-api-remotes`
 * 桥接代码装起来（profile 里 dsh-web-app 依赖的就是它），再用一个"假网页"复现浏览器
 * 那一半的行为，于是"卡片会不会消失"变成了可断言的东西。
 *
 * 这套测试同时锁住修复后的可用路径：只要网页自己作答（用户在页内点，或扩展点页内
 * 按钮 —— 见 extension/page-approval.js），卡片就会消失、宿主拿到同样的结果。
 *
 * 跑法: node test/repro-allow-card.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { API_REMOTE_FORWARDED_EVENTS, apply as applyRemotes } from '@deepseek-ai/dsh-api-remotes'
import { createNotifier } from '../src/index.js'

const PAUSE_MS = 30
const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: ok === true, detail: String(detail) })

const session = { id: 'session-regression-0001' }

/**
 * 假网页：按真实客户端 `dsh-api-gateway/lib/types/client/remote-events.js` 的语义，
 * 收到 waterfall 帧就挂卡片，收到 cancel 帧就撤卡片。
 */
function createFakePage() {
  const state = { card: false, eventId: null, settledBy: null, cardsShown: 0 }
  let answer = () => {}
  return {
    state,
    showCard(eventId) {
      state.card = true
      state.eventId = eventId
      state.cardsShown += 1
    },
    onCancel(eventId) {
      if (state.eventId !== eventId) return false
      state.card = false
      state.settledBy = 'cancel-frame'
      return true
    },
    /** 用户在网页里点「允许一次」（扩展点页内按钮走的是同一条路）。 */
    answerInPage(outcome) {
      answer(outcome)
    },
    watch(fn) {
      answer = fn
    },
  }
}

/**
 * 复刻 api-remotes 的 `forwardWaterfall` + api-gateway 的 `finishRemoteEvent`：
 * 直接用真实的转发源注册（`applyRemotes`），所以事件名、模式、监听顺序都是真的，
 * 只有"把帧发给浏览器"和"结算时推 cancel 帧"这两步是这里补上的。
 */
function mountBridgedRemotes(ctx, page, log) {
  const fakeGateway = {
    registerRemoteEvents(source) {
      const disposers = API_REMOTE_FORWARDED_EVENTS.map(({ event, mode }) => {
        if (mode === 'emit') return ctx.on(event, () => {})
        return ctx.on(event, function (request, next) {
          const settled = Promise.withResolvers()
          let eventId = null
          const dispatch = {
            event,
            request,
            context: { value: this, subject: this },
            resolve: (outcome) => {
              log.push(outcome?.kind ?? 'undefined')
              // api-gateway 的 finishRemoteEvent：结算时向浏览器推 cancel 帧。
              if (eventId) page.onCancel(eventId)
              if (outcome.kind === 'result') {
                settled.resolve(outcome.value)
                return
              }
              Promise.resolve().then(next).then(settled.resolve, settled.reject)
            },
            reject: settled.reject,
          }
          eventId = `evt-${log.length + 1}`
          page.showCard(eventId)
          page.watch((outcome) => dispatch.resolve({ kind: 'result', value: outcome }))
          return settled.promise
        })
      })
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  }
  applyRemotes({ effect: (fn) => fn(), typertGateway: fakeGateway })
}

function makeHostContext() {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {} }
  ctx.sessions = { get: () => undefined }
  ctx.sessionTitle = { get: () => undefined }
  return ctx
}

/** 一个完整场景：真实 cordis + 真实 api-remotes + 本插件的宿主半边 + 假网页。 */
function scenario() {
  const ctx = makeHostContext()
  const page = createFakePage()
  const forwards = []
  mountBridgedRemotes(ctx, page, forwards)
  const notifier = createNotifier(ctx, { enabled: true, notifyApproval: true })
  // 和真实部署完全一样的注册方式：prepend，抢在 api-remotes 前面。
  ctx.on(
    'approval/request',
    function (request, next) {
      return notifier.internals.notifyApproval(request, next)
    },
    { prepend: true },
  )
  const request = {
    agent: { id: session.id, session },
    toolName: 'pwsh',
    callId: 'call-regression',
    reason: 'escalate sandbox to danger-full-access: 需要在工作区之外写一个临时文件',
  }
  const outcome = ctx.waterfall(session, 'approval/request', request, () => Promise.resolve('unavailable'))
  return { ctx, page, notifier, forwards, outcome }
}

// ---------------------------------------------------------------- 1. 转发真的建立了
{
  const { page, forwards } = scenario()
  await pause()
  check('审批申请被转发给了网页（所以卡片才会出现）', page.state.card === true, `card=${page.state.card}`)
  void forwards
}

// ---------------------------------------------------------------- 2. 根因：通知作答之后，转发被丢掉
{
  const { notifier, page, forwards, outcome } = scenario()
  await pause()
  const record = notifier.internals.pending.list()[0]
  const ack = notifier.decide(record.token, 'allow')
  const answer = await outcome
  await pause()
  check('通知里点「允许」→ 宿主判定 allowed-once（工具会执行）', answer === 'allowed-once', `answer=${JSON.stringify(answer)}`)
  check('宿主 ack 成功', ack.ok === true, JSON.stringify(ack))
  check(
    '**根因**：转发给网页的那条 waterfall 没有被结算（api-remotes 只在收到客户端答复时才回 cancel）',
    forwards.length === 0,
    `dispatch.resolve 调用次数=${forwards.length}`,
  )
  check('**根因**：因此网页卡片停在「等待审批」——这就是用户看到的"网页里没收到我的允许"', page.state.card === true, `card=${page.state.card}`)
}

// ---------------------------------------------------------------- 3. 修复后的路径：网页自己作答，卡片消失
{
  const { notifier, page, outcome, forwards } = scenario()
  await pause()
  const record = notifier.internals.pending.list()[0]
  // 扩展点网页里的「允许一次」按钮 = 这段；页内作答后宿主也会同步结算。
  page.answerInPage('allowed-once')
  const answer = await outcome
  await pause()
  check('网页里作答 → 宿主拿到同一个结果 allowed-once', answer === 'allowed-once', `answer=${JSON.stringify(answer)}`)
  check('网页作答后卡片消失', page.state.card === false, `card=${page.state.card} settledBy=${page.state.settledBy}`)
  check('转发被结算（网关会推 cancel 帧）', forwards.length === 1, `调用=${forwards.length}`)
  check('网页作答后宿主的待办也被清掉（不会留僵尸记录）', notifier.internals.pending.size() === 0, `pending=${notifier.internals.pending.size()}`)
  void record
}

// ---------------------------------------------------------------- 4. 网页拒绝也要能生效
{
  const { page, outcome } = scenario()
  await pause()
  page.answerInPage('rejected')
  const answer = await outcome
  check('网页里点「拒绝」同样能解析成 rejected', answer === 'rejected', `answer=${JSON.stringify(answer)}`)
  check('拒绝后卡片消失', page.state.card === false, `card=${page.state.card}`)
}

// ---------------------------------------------------------------- 5. 划掉通知：不作答，决定权回网页
{
  const { notifier, page } = scenario()
  await pause()
  const record = notifier.internals.pending.list()[0]
  notifier.decide(record.token, 'dismiss')
  await pause()
  check('划掉通知不等于拒绝：卡片留着，决定权交回网页', page.state.card === true, `card=${page.state.card}`)
  check('划掉通知后宿主队列里不留这条待办', notifier.internals.pending.size() === 0, `pending=${notifier.internals.pending.size()}`)
}

console.log('')
let failed = 0
for (const { name, ok, detail } of results) {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  [${detail}]`)
}
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
