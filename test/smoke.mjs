/**
 * dsh-notifier 冒烟测试：
 * 1. 纯函数（文案、配置、去重）
 * 2. WebSocket 帧编解码与握手
 * 3. 真实 HTTP + WebSocket 端到端：审批 waterfall、通知下发、按钮作答、HTTP 回环校验
 *
 * 跑法: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { connect as netConnect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { after, before, describe, finish, it, resetReport } from './harness.mjs'
import { createNotifier } from '../src/index.js'
import { buttonTitle } from '../extension/shared.js'
import { acceptKey, decodeFrames, encodeFrame, handshake } from '../src/ws.js'
import {
  clip,
  createPendingStore,
  describeApproval,
  describeSession,
  isLoopbackAddress,
  isLoopbackHost,
  normalizeConfig,
  sessionKindOf,
  shouldNotify,
} from '../src/util.js'

resetReport()

const silentLogger = { info() {}, warn() {}, error() {} }
const HERE = dirname(fileURLToPath(import.meta.url))

describe('util 纯函数', () => {
  it('裁剪并折叠空白', () => {
    assert.equal(clip('  a\n\n b  ', 20), 'a b')
    assert.equal(clip('abcdefghij', 5), 'abcd…')
  })

  it('识别回环地址与 Host', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('192.168.1.10'), false)
    assert.equal(isLoopbackHost('127.0.0.1:3080'), true)
    assert.equal(isLoopbackHost('localhost:3080'), true)
    assert.equal(isLoopbackHost('[::1]:3080'), true)
    assert.equal(isLoopbackHost('evil.example.com'), false)
  })

  it('归一化配置', () => {
    const cfg = normalizeConfig({ notifyIdle: 'false', titlePrefix: '   ' })
    assert.equal(cfg.notifyIdle, false)
    assert.equal(cfg.titlePrefix, 'dsh')
    assert.equal(normalizeConfig({ enabled: 0 }).enabled, false)
  })

  it('配置里没有冷却字段（回退：一格里连续两次审批会被吞掉一条）', () => {
    // 曾经有 cooldownMs（默认 1000，本机被调到 30 秒），按会话计时：
    // 用户连续同意几个权限请求时，第二次直接不进通知通道。现在没有这个概念了。
    const cfg = normalizeConfig({ cooldownMs: 30000 })
    assert.equal(cfg.cooldownMs, undefined)
  })

  it('审批文案直接用 DSH 抛出的原因', () => {
    const plain = describeApproval({ toolName: 'pwsh', reason: '需要写入工作区之外' })
    assert.equal(plain.title, 'pwsh 请求审批')
    assert.equal(plain.body, '需要写入工作区之外')

    const escalation = describeApproval({
      toolName: 'pwsh',
      reason: 'escalate sandbox to workspace-write: 要写 C:\\temp',
    })
    assert.match(escalation.title, /workspace-write/)
    assert.equal(escalation.body, '要写 C:\\temp')

    assert.equal(describeApproval({}).body, '（未提供原因）')
  })

  it('会话描述带标题与短 id', () => {
    assert.equal(describeSession('session-abcdefgh1234', '修 bug'), '修 bug · #abcdefgh')
    assert.equal(describeSession('session-abcdefgh1234', '修 bug', false), '#abcdefgh')
    assert.equal(describeSession('session-abcdefgh1234'), '#abcdefgh')
  })

  it('只提醒该提醒的会话与事件', () => {
    const cfg = normalizeConfig({})
    assert.equal(shouldNotify('primary', 'approval', cfg), true)
    assert.equal(shouldNotify('primary', 'idle', cfg), true)
    assert.equal(shouldNotify('subagent', 'approval', cfg), false)
    assert.equal(shouldNotify('subagent', 'idle', cfg), false)
    assert.equal(shouldNotify('subagent', 'idle', { ...cfg, notifySubagentIdle: true }), true)
    assert.equal(shouldNotify('unknown', 'idle', cfg), false)
  })

  it('识别子代理会话', () => {
    assert.equal(sessionKindOf({ header: { origin: 'subagent' } }), 'subagent')
    assert.equal(sessionKindOf({ header: { delegationDepth: 1 } }), 'subagent')
    assert.equal(sessionKindOf({ header: {} }), 'primary')
    assert.equal(sessionKindOf(undefined), 'unknown')
  })

  it('待办表能挑出同一会话下要替换的旧记录', () => {
    const store = createPendingStore()
    store.add({ token: 'a', sessionId: 's1', kind: 'approval' })
    store.add({ token: 'b', sessionId: 's1', kind: 'approval' })
    // 工具本身只是"能挑出来"，审批**不会**再用它（见宿主那条回归）：
    // 挑了旧审批出来作废 = 把没作答的申请静默判成允许。
    assert.deepEqual(
      store.supersededBy('s1', 'approval', 'b').map((record) => record.token),
      ['a'],
    )
    // 一轮结束才用它来"一条盖一条"。
    store.add({ token: 'i1', sessionId: 's1', kind: 'idle' })
    store.add({ token: 'i2', sessionId: 's1', kind: 'idle' })
    assert.deepEqual(
      store.supersededBy('s1', 'idle', 'i2').map((record) => record.token),
      ['i1'],
    )
    // 别的会话、别的类型都不算"要替换的旧记录"。
    assert.equal(store.supersededBy('s2', 'idle', 'i2').length, 0)
    assert.equal(store.supersededBy('s1', 'approval', 'x').length, 2)
  })
})

describe('websocket 帧与握手', () => {
  it('握手 accept 值符合 RFC 示例', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('只接受目标路径上的 upgrade', () => {
    const req = {
      method: 'GET',
      url: '/dsh-notifier/ws?t=x',
      headers: { upgrade: 'websocket', 'sec-websocket-key': 'abc', 'sec-websocket-version': '13' },
    }
    assert.ok(handshake(req, '/dsh-notifier/ws'))
    assert.equal(handshake(req, '/other'), null)
    assert.equal(handshake({ ...req, headers: { ...req.headers, upgrade: 'h2c' } }, '/dsh-notifier/ws'), null)
  })

  it('往返编解码掩码帧', () => {
    const payload = Buffer.from(JSON.stringify({ type: 'decision', token: 't', action: 'allow' }), 'utf8')
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3]
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked])
    const { frames, rest } = decodeFrames(frame)
    assert.equal(rest.length, 0)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].payload.toString('utf8'), payload.toString('utf8'))
  })

  it('数据没到齐时不吐帧', () => {
    const full = encodeFrame('hello')
    assert.equal(decodeFrames(full.subarray(0, 3)).frames.length, 0)
  })

  it('声称超大长度的帧在读长度头时就拒绝（别让声明长度换内存）', () => {
    // 只发一个 8 字节长度头，声称 payload 有 2^40 字节：必须在**读到头之后**立刻抛，
    // 否则调用方会一直往缓冲区里攒数据等着"收齐"。
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeUInt32BE(2 ** 8, 2) // high
    header.writeUInt32BE(0, 6) // low
    assert.throws(() => decodeFrames(header), /frame too large/)
  })

  it('正常大小的小消息照旧通过（默认上限 64 KiB 不会误伤）', () => {
    const payload = Buffer.from('x'.repeat(4096), 'utf8')
    const { frames } = decodeFrames(encodeFrame(payload))
    assert.equal(frames.length, 1)
    assert.equal(frames[0].payload.length, 4096)
  })
})

describe('端到端：HTTP + WebSocket + 审批 waterfall', () => {
  let server
  let port
  let notifier
  /** 所有连上来的扩展收到的消息，按连接分组 */
  const inbox = []

  const ctx = {
    logger: silentLogger,
    sessions: { get: () => undefined },
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  }

  before(async () => {
    notifier = createNotifier(ctx, {})
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const route = notifier.routes.find((item) => item.path === path)
      if (!route) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req, res)
    })
    server.on('upgrade', (req, socket, head) => notifier.acceptUpgrade(req, socket, head))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
  })

  after(async () => {
    notifier.stopHeartbeat()
    server.closeAllConnections?.()
    server.close()
  })

  const base = () => `http://127.0.0.1:${port}`

  const connectExtension = async () => {
    const config = await (await fetch(`${base()}/dsh-notifier/config`)).json()
    const frames = []
    const socket = await openWebSocket(port, `/dsh-notifier/ws?t=${config.token}`, (text) => {
      frames.push(JSON.parse(text))
    })
    inbox.push(frames)
    await waitFor(() => frames.some((frame) => frame.type === 'snapshot'))
    socket.send(JSON.stringify({ type: 'ready', client: 'extension', origin: base() }))
    return { frames, socket }
  }

  /** 页面里的中继：自己连一条，身份是 page。 */
  const connectPage = async () => {
    const config = await (await fetch(`${base()}/dsh-notifier/config`)).json()
    const frames = []
    const socket = await openWebSocket(port, `/dsh-notifier/ws?t=${config.token}`, (text) => {
      frames.push(JSON.parse(text))
    })
    await waitFor(() => frames.some((frame) => frame.type === 'snapshot'))
    socket.send(JSON.stringify({ type: 'ready', client: 'page', origin: base() }))
    return { frames, socket }
  }

  it('健康检查可用', async () => {
    const response = await fetch(`${base()}/dsh-notifier/health`)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.ok, true)
    assert.equal(data.name, 'dsh-notifier')
  })

  it('配置带出 ws 路径与 token', async () => {
    const data = await (await fetch(`${base()}/dsh-notifier/config`)).json()
    assert.equal(data.wsPath, '/dsh-notifier/ws')
    assert.equal(typeof data.token, 'string')
    assert.ok(data.token.length > 10)
  })

  it('非回环 Host 一律 403', async () => {
    // fetch/undici 会把 Host 当禁止修改的头，所以这里直接发原始请求。
    const status = await rawRequestStatus(port, '/dsh-notifier/health', { Host: 'evil.example.com' })
    assert.equal(status, 403)
  })

  it('错误的 token 连不上', async () => {
    await assert.rejects(() => openWebSocket(port, '/dsh-notifier/ws?t=wrong', () => {}))
  })

  it('审批：通知文字来自 DSH，点「允许」解析为 allowed-once', async () => {
    const { frames, socket } = await connectExtension()
    const session = { id: 'session-abcd1234', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: 'escalate sandbox to workspace-write: 写工作区外的文件' },
      () => new Promise(() => {}),
    )

    await waitFor(() => frames.some((frame) => frame.type === 'pending'))
    const item = frames.find((frame) => frame.type === 'pending').item
    assert.equal(item.kind, 'approval')
    // Windows 只给两个通知按钮位：放「回到对话 / 允许」。
    // 拒绝的流程是点「回到对话」回网页里点，用户明确要求这样。
    assert.deepEqual(item.actions, ['open', 'allow'])
    assert.match(item.subtitle, /workspace-write/)
    assert.match(item.body, /写工作区外的文件/)
    assert.equal(item.session, '测试会话 · #abcd1234')
    assert.equal(item.openPath, '/#dsh-notifier=session-abcd1234')

    socket.send(JSON.stringify({ type: 'decision', token: item.token, action: 'allow' }))
    assert.equal(await answer, 'allowed-once')
    await waitFor(() => frames.some((frame) => frame.type === 'resolved' && frame.token === item.token))

    const remaining = await (await fetch(`${base()}/dsh-notifier/pending`)).json()
    assert.equal(remaining.items.length, 0)

    socket.send(JSON.stringify({ type: 'decision', token: item.token, action: 'allow' }))
    await waitFor(() => frames.some((frame) => frame.type === 'ack' && frame.result.ok === false))
    socket.close()
  })

  it('审批：点「拒绝」解析为 rejected', async () => {
    const session = { id: 'session-reject01', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '危险操作' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.size() === 1)
    const record = notifier.internals.pending.list()[0]
    assert.equal(notifier.decide(record.token, 'reject').ok, true)
    assert.equal(await answer, 'rejected')
  })

  it('回归：连续两次审批各自弹一条通知，且各自都能作答（曾经被冷却吞掉一条）', async () => {
    // 用户报的原始现象：一句里连续申请两次权限，通知只弹第一条。
    // 两道闸门都在宿主侧，这里一次盯住：
    //   1. 按会话计时的冷却（cooldownMs）—— 第二条压根不进通知通道；
    //   2. "同一会话上一条审批作废" —— 用 finish() 把上一条判成 allowed-once
    //      （等于没作答就放行），并且它的 token 从此点不动。
    const { frames, socket } = await connectExtension()
    const session = { id: 'session-twice001', header: {} }
    const first = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: 'escalate sandbox to workspace-write: 写第一个文件' },
      () => new Promise(() => {}),
    )
    await waitFor(() => frames.filter((frame) => frame.type === 'pending').length === 1)
    // 等过曾经的冷却窗口（默认 1000ms，本机曾调到 30 秒）再发第二条：
    // 现在没有冷却，时间差多少都不该影响。
    await sleep(1200)
    const second = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: 'escalate sandbox to workspace-write: 写第二个文件' },
      () => new Promise(() => {}),
    )
    await waitFor(() => frames.filter((frame) => frame.type === 'pending').length === 2)

    const items = frames.filter((frame) => frame.type === 'pending').map((frame) => frame.item)
    assert.equal(items.length, 2)
    assert.notEqual(items[0].token, items[1].token)
    assert.match(items[0].body, /第一个文件/)
    assert.match(items[1].body, /第二个文件/)
    // 两条都得留在队列里：先点第二条、回头再点第一条是正常操作顺序。
    assert.equal(notifier.internals.pending.size(), 2)
    assert.equal(
      frames.some((frame) => frame.type === 'resolved' && frame.token === items[0].token),
      false,
    )

    // 先答第一条 —— 它必须还在，而且解析成真作答（不是被静默放行）。
    socket.send(JSON.stringify({ type: 'decision', token: items[0].token, action: 'allow' }))
    assert.equal(await first, 'allowed-once')
    // 再答第二条：同样弹过、同样能答。
    socket.send(JSON.stringify({ type: 'decision', token: items[1].token, action: 'allow' }))
    assert.equal(await second, 'allowed-once')

    const leftover = await (await fetch(`${base()}/dsh-notifier/pending`)).json()
    assert.equal(leftover.items.length, 0)
    socket.close()
  })

  it('网页卡片先作答时通知被撤下，并沿用网页结果', async () => {
    const { frames, socket } = await connectExtension()
    const session = { id: 'session-web0001', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'fs', reason: '写文件' },
      () => Promise.resolve('allowed-once'),
    )
    assert.equal(await answer, 'allowed-once')
    await waitFor(() => frames.some((frame) => frame.type === 'resolved' && frame.outcome === 'allowed-once'))
    assert.equal(notifier.internals.pending.size(), 0)
    socket.close()
  })

  it('一轮结束只给「回到对话」，且由页面中继收到切会话指令', async () => {
    const page = await connectPage()
    const { frames, socket } = await connectExtension()
    notifier.internals.onSessionStatus('session-idle001', true)
    notifier.internals.onSessionStatus('session-idle001', false)
    await waitFor(() => frames.some((frame) => frame.type === 'pending' && frame.item.kind === 'idle'))
    const item = frames.find((frame) => frame.type === 'pending' && frame.item.kind === 'idle').item
    // 一轮结束：两个按钮位给「回到对话 / 知道了」（知道了只是把通知收起来）。
    assert.deepEqual(item.actions, ['open', 'dismiss'])
    assert.match(item.title, /一轮对话已结束/)

    const response = await fetch(`${base()}/dsh-notifier/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: item.token, action: 'open' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    // 一轮结束点「回到对话」之后就没后续动作了：宿主必须把待办收掉，
    // 否则记录永远挂着、通知也永远撤不下来（曾经的真 bug）。
    assert.equal(body.pending, false)
    const left = await (await fetch(`${base()}/dsh-notifier/pending`)).json()
    assert.equal(
      left.items.some((entry) => entry.token === item.token),
      false,
      '点「回到对话」后这条待办应该被清掉',
    )
    // 切会话的指令走页面中继（focus 只发给 client === 'page'）
    await waitFor(() => page.frames.some((frame) => frame.type === 'focus' && frame.sessionId === 'session-idle001'))
    page.socket.close()
    socket.close()
  })

  it('审批点「回到对话」：通知撤下（pending=false），但记录留着以便网页里继续作答', async () => {
    const session = { id: 'session-openkeep1', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '点回到对话后通知要撤下' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((entry) => entry.sessionId === 'session-openkeep1'))
    const record = notifier.internals.pending.list().find((entry) => entry.sessionId === 'session-openkeep1')

    const opened = notifier.decide(record.token, 'open')
    assert.equal(opened.ok, true)
    // 扩展据此把通知撤下（用户明确要求"点回到对话就把通知撤掉"）
    assert.equal(opened.pending, false)
    // 但审批本身还悬着：记录必须在，网页里的卡片才能继续答
    assert.notEqual(notifier.internals.pending.get(record.token), undefined)

    // 从通知按钮作答的路径仍然有效（用户在通知中心里点了允许）
    const allowed = notifier.decide(record.token, 'allow')
    assert.equal(allowed.ok, true)
    assert.equal(allowed.pending, false)
    assert.equal(await answer, 'allowed-once')
  })

  it('一轮结束点「知道了」会把待办收掉', async () => {
    notifier.internals.onSessionStatus('session-idle003', true)
    notifier.internals.onSessionStatus('session-idle003', false)
    await waitFor(() => notifier.internals.pending.list().some((entry) => entry.sessionId === 'session-idle003'))
    const record = notifier.internals.pending.list().find((entry) => entry.sessionId === 'session-idle003')
    const dismissed = notifier.decide(record.token, 'dismiss')
    assert.equal(dismissed.ok, true)
    assert.equal(dismissed.pending, false)
    await waitFor(() => notifier.internals.pending.get(record.token) === undefined)
  })

  it('回归：open 不再留下僵尸待办（三种记录都覆盖）', async () => {
    // 1) 一轮结束：点「回到对话」必须清掉，否则记录永远挂着、通知永远撤不下来
    notifier.internals.onSessionStatus('session-zombie01', true)
    notifier.internals.onSessionStatus('session-zombie01', false)
    await waitFor(() => notifier.internals.pending.list().some((entry) => entry.sessionId === 'session-zombie01'))
    const idle = notifier.internals.pending.list().find((entry) => entry.sessionId === 'session-zombie01')
    const idleOpen = notifier.decide(idle.token, 'open')
    assert.equal(idleOpen.pending, false)
    assert.equal(notifier.internals.pending.get(idle.token), undefined, 'idle 记录点 open 后应被清掉')

    // 2) 审批：点「回到对话」要撤下通知（pending=false），但记录留着，
    //    并且之后从通知里点「允许」仍然生效（不能变死按钮）
    const session = { id: 'session-zombie02', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '僵尸记录回归测试' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((entry) => entry.sessionId === 'session-zombie02'))
    const approval = notifier.internals.pending.list().find((entry) => entry.sessionId === 'session-zombie02')
    const approvalOpen = notifier.decide(approval.token, 'open')
    assert.equal(approvalOpen.pending, false, '点回到对话要把通知撤下')
    assert.notEqual(notifier.internals.pending.get(approval.token), undefined, '审批记录本身要留着')
    assert.equal(notifier.decide(approval.token, 'allow').ok, true, '之后点允许必须还能生效')
    assert.equal(await answer, 'allowed-once')
  })

  it('快照会补发真待办（扩展重载后错过的审批还能弹回来）', async () => {
    const session = { id: 'session-snap-real', header: {} }
    notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '真待办要留在快照里' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((entry) => entry.sessionId === 'session-snap-real'))

    // 新连一个客户端，它收到的 snapshot 就是"扩展重连后会看到的东西"
    const { frames, socket } = await connectExtension()
    const snapshot = frames.find((frame) => frame.type === 'snapshot')
    assert.ok(snapshot, '应该收到 snapshot')
    assert.equal(
      (snapshot.items ?? []).some((item) => item.sessionId === 'session-snap-real'),
      true,
      '真审批必须出现在快照里，重连后才能补弹',
    )
    const httpPending = await (await fetch(`${base()}/dsh-notifier/pending`)).json()
    assert.equal(
      httpPending.items.some((item) => item.sessionId === 'session-snap-real'),
      true,
      '真审批也必须留在 /pending 里',
    )
    socket.close()
  })

  it('新一轮开始时撤掉上一轮的结束通知', async () => {
    const { frames, socket } = await connectExtension()
    notifier.internals.onSessionStatus('session-idle002', true)
    notifier.internals.onSessionStatus('session-idle002', false)
    await waitFor(() => frames.some((frame) => frame.type === 'pending' && frame.item.sessionId === 'session-idle002'))
    const first = frames.find((frame) => frame.type === 'pending' && frame.item.sessionId === 'session-idle002').item

    notifier.internals.onSessionStatus('session-idle002', true)
    await waitFor(() => frames.some((frame) => frame.type === 'resolved' && frame.token === first.token))
    assert.equal(notifier.decide(first.token, 'open').ok, false)
    socket.close()
  })

  it('子代理默认不提醒，开启后才提醒', async () => {
    const subagent = { id: 'session-sub00001', header: { origin: 'subagent' } }
    notifier.internals.onSessionCreated(subagent)
    notifier.internals.onSessionStatus('session-sub00001', true)
    notifier.internals.onSessionStatus('session-sub00001', false)
    assert.equal(
      notifier.internals.pending.list().some((record) => record.sessionId === 'session-sub00001'),
      false,
    )
  })

  it('HTTP 回调也能作答，且非法动作被拒', async () => {
    const session = { id: 'session-http0001', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '通过 HTTP 作答' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-http0001'))
    const record = notifier.internals.pending.list().find((item) => item.sessionId === 'session-http0001')

    const bad = await fetch(`${base()}/dsh-notifier/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: record.token, action: 'explode' }),
    })
    assert.equal(bad.status, 409)

    const good = await fetch(`${base()}/dsh-notifier/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: record.token, action: 'allow' }),
    })
    assert.equal(good.status, 200)
    assert.equal(await answer, 'allowed-once')
  })

  it('回归：审批通知被划掉时，宿主必须清掉待办并让位给网页卡片（曾经的僵尸待办）', async () => {
    const session = { id: 'session-dismiss1', header: {} }
    let pageAnswers = 0
    // 网页卡片那一路：dismiss 之后宿主应该 continue waterfall，由这里给答案
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '用户划掉了通知' },
      () => {
        pageAnswers += 1
        return Promise.resolve('allowed-once')
      },
    )
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-dismiss1'))
    const record = notifier.internals.pending.list().find((item) => item.sessionId === 'session-dismiss1')

    // 扩展在 SW 启动时对账"通知中心里已经没有了"的那条，发的就是 dismiss
    const dismissed = notifier.decide(record.token, 'dismiss')
    assert.equal(dismissed.ok, true, '审批上的 dismiss 不能再是 bad-action')
    assert.equal(dismissed.pending, false)
    assert.equal(dismissed.cleaned, true)
    assert.equal(notifier.internals.pending.get(record.token), undefined, '待办必须被清掉，否则永久僵尸')

    // 关键：dismiss 不等于"用户作答"，决定权交回 waterfall（网页卡片）
    assert.equal(await answer, 'allowed-once')
    assert.equal(pageAnswers, 1, 'dismiss 之后必须让 waterfall 继续，且只走一次')
  })

  it('回归：划掉通知后待办不残留（快照不再带着它）', async () => {
    notifier.internals.onSessionStatus('session-dismiss2', true)
    notifier.internals.onSessionStatus('session-dismiss2', false)
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-dismiss2'))
    const idle = notifier.internals.pending.list().find((item) => item.sessionId === 'session-dismiss2')
    const { frames, socket } = await connectExtension()

    assert.equal(notifier.decide(idle.token, 'dismiss').ok, true)
    await waitFor(() => frames.some((frame) => frame.type === 'resolved' && frame.token === idle.token))

    // 再连一次：snapshot 里不该再有这条
    const second = await connectExtension()
    const snapshot = second.frames.find((frame) => frame.type === 'snapshot')
    assert.equal(
      (snapshot?.items ?? []).some((item) => item.sessionId === 'session-dismiss2'),
      false,
      '划掉之后不应再出现在补发快照里',
    )
    second.socket.close()
    socket.close()
  })

  it('回归：重复 dismiss 是幂等的（第二次返回 expired，且不再重复广播）', async () => {
    const session = { id: 'session-dismiss3', header: {} }
    let pageAnswers = 0
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '重复 dismiss' },
      () => {
        pageAnswers += 1
        return Promise.resolve('allowed-once')
      },
    )
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-dismiss3'))
    const record = notifier.internals.pending.list().find((item) => item.sessionId === 'session-dismiss3')

    assert.equal(notifier.decide(record.token, 'dismiss').cleaned, true)
    // 记录已经没了：第二次是 expired，不是崩溃、也不会再广播一次 resolved
    assert.equal(notifier.decide(record.token, 'dismiss').error, 'expired')
    assert.equal(notifier.internals.pending.get(record.token), undefined)
    // dismiss 让位给 waterfall，且只让位一次
    assert.equal(await answer, 'allowed-once')
    assert.equal(pageAnswers, 1)
  })

  it('回归：审批点「回到对话」后记录仍在，仍可从通知里允许（不被 dismiss 逻辑破坏）', async () => {
    const session = { id: 'session-dismiss4', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: 'open 之后仍可作答' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-dismiss4'))
    const record = notifier.internals.pending.list().find((item) => item.sessionId === 'session-dismiss4')
    assert.equal(notifier.decide(record.token, 'open').pending, false)
    assert.notEqual(notifier.internals.pending.get(record.token), undefined, 'open 不能删记录')
    assert.equal(notifier.decide(record.token, 'allow').ok, true)
    assert.equal(await answer, 'allowed-once')
  })

  it('回归：HTTP 通路也能作答（扩展在 WebSocket 断线时靠它兜底）', async () => {
    // 真实场景：扩展点「允许」时 WebSocket 已经死了，于是改用 POST。
    // 宿主这边必须像 WebSocket 一样受理，并回 {ok:true} 让扩展知道送达成功。
    const proxy = await rawJsonRequest(port, 'POST', `${'/'}dsh-notifier/action`, {
      body: JSON.stringify({ token: 'no-such-token', action: 'allow' }),
      contentType: 'application/json',
    })
    assert.equal(proxy.status, 409, '未知 token 应回 409')
    assert.equal(proxy.json.ok, false)

    const session = { id: 'session-httpfall', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: 'HTTP 兜底' },
      () => new Promise(() => {}),
    )
    await waitFor(() => notifier.internals.pending.list().some((item) => item.sessionId === 'session-httpfall'))
    const record = notifier.internals.pending.list().find((item) => item.sessionId === 'session-httpfall')
    const posted = await rawJsonRequest(port, 'POST', '/dsh-notifier/action', {
      body: JSON.stringify({ token: record.token, action: 'allow' }),
      contentType: 'application/json',
    })
    assert.equal(posted.status, 200)
    assert.equal(posted.json.ok, true, 'HTTP 受理必须回 ok:true，否则扩展会以为没送到')
    assert.equal(await answer, 'allowed-once')
  })

  it('回归：ack 一定带 result（扩展只认 ack，不看 send 返回值）', async () => {
    const { frames, socket } = await connectExtension()
    const session = { id: 'session-ackchk1', header: {} }
    const answer = notifier.internals.notifyApproval(
      { agent: { session }, toolName: 'pwsh', reason: '查 ack' },
      () => new Promise(() => {}),
    )
    await waitFor(() => frames.some((frame) => frame.type === 'pending' && frame.item.sessionId === 'session-ackchk1'))
    const item = frames.find((frame) => frame.type === 'pending' && frame.item.sessionId === 'session-ackchk1').item

    socket.send(JSON.stringify({ type: 'decision', token: item.token, action: 'allow' }))
    await waitFor(() => frames.some((frame) => frame.type === 'ack' && frame.token === item.token))
    const ack = frames.find((frame) => frame.type === 'ack' && frame.token === item.token)
    assert.equal(typeof ack.result?.ok, 'boolean', 'ack 必须带 result.ok')
    assert.equal(ack.result.ok, true)
    assert.equal(await answer, 'allowed-once')
    socket.close()
  })

  it('待办列表按回环可读', async () => {
    const data = await (await fetch(`${base()}/dsh-notifier/pending`)).json()
    assert.equal(data.ok, true)
    assert.ok(Array.isArray(data.items))
  })

  /**
   * 回归测试：曾经的死循环。
   * 扩展点「回到对话」时自己会把标签抢到前台，同时发 focus-request 给宿主；
   * 宿主如果把这个 focus 广播回扩展，扩展就会再抢一次前台、再发一次请求 ——
   * 实测 8 秒内产生 4000+ 个 focus 帧，用户被反复抢前台，根本切不走。
   * 现在的契约：focus 只发给页面中继（client === 'page'），绝不回给扩展。
   */
  it('focus 只发给页面中继，不回给扩展（防死循环）', async () => {
    const page = await connectPage()
    const extension = await connectExtension()
    await new Promise((resolve) => setTimeout(resolve, 150))

    // 模拟扩展点击「回到对话」后发出的请求，然后故意多发几次，
    // 模拟"如果宿主回给扩展，扩展就会继续请求"的放大过程。
    for (let i = 0; i < 5; i += 1) {
      extension.socket.send(JSON.stringify({ type: 'focus-request', sessionId: 'session-loop01' }))
    }
    await waitFor(() => page.frames.filter((frame) => frame.type === 'focus').length >= 5)

    const toExtension = extension.frames.filter((frame) => frame.type === 'focus')
    const toPage = page.frames.filter((frame) => frame.type === 'focus')
    assert.equal(toExtension.length, 0, 'focus 不该回给扩展，否则会自激')
    assert.equal(toPage.length, 5, '页面中继应该收到每一次 focus')
    assert.ok(
      page.frames.every((frame) => frame.type !== 'focus' || frame.sessionId === 'session-loop01'),
      '会话 id 要原样带过去',
    )

    // 再等一会儿，确认没有继续放大的帧冒出来（loop 的话这里会长到几百上千）
    const snapshotCount = toPage.length
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(page.frames.filter((frame) => frame.type === 'focus').length, snapshotCount, 'focus 帧数不该自己增长')

    page.socket.close()
    extension.socket.close()
  })
})

/**
 * 商店列表里的描述文案和实际按钮必须一致。
 *
 * 起因：`manifest.json` / `package.json` 的 description 一直写着「回到对话 / 允许 /
 * 拒绝」，可审批通知的按钮早就是 `['open','allow']` 了 —— 描述里承诺的「拒绝」
 * 按钮在扩展页上根本不存在。这种不一致只能靠测试盯住。
 */
describe('扩展描述文案与实际按钮一致', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'extension', 'manifest.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

  /**
   * 走**真实代码路径**得出每种通知的按钮文案：
   * 宿主 `pendingPayload(record)` 决定 actions → 扩展 `buttonTitle(action)` 转成中文。
   * 两个函数都从生产代码里拿，测试不自己拼 actions（否则就是在自证）。
   */
  const buttonLabelsFor = (kind) => {
    const notifier = createNotifier(
      { logger: silentLogger, sessions: { get: () => undefined }, sessionTitle: { get: () => undefined } },
      {},
    )
    const record = {
      kind,
      token: 'tok',
      sessionId: 'session-abcdefgh1234',
      sessionTitle: '测试会话',
      heading: kind === 'approval' ? '需要审批' : '一轮对话已结束',
      subtitle: '副标题',
      body: '正文',
      toolName: 'pwsh',
      createdAt: Date.now(),
    }
    const payload = notifier.pendingPayload(record)
    return payload.actions.map((action) => buttonTitle(action))
  }

  it('审批通知的按钮是「回到对话 / 允许」', () => {
    assert.deepEqual(buttonLabelsFor('approval'), ['回到对话', '允许'])
  })

  it('一轮结束通知的按钮是「回到对话 / 知道了」', () => {
    assert.deepEqual(buttonLabelsFor('idle'), ['回到对话', '知道了'])
  })

  it('描述里不再承诺一个「拒绝」按钮', () => {
    for (const [label, text] of [
      ['manifest.json description', manifest.description],
      ['package.json description', pkg.description],
    ]) {
      // 「拒绝」只允许出现在"点回到对话回网页里点"这种说明里，
      // 不能出现在「回到对话 / 允许 / 拒绝」这种按钮列表中。
      assert.equal(
        /允许\s*\/\s*拒绝/.test(text),
        false,
        `${label} 不能把「拒绝」列成按钮：${text}`,
      )
    }
  })

  it('描述里承诺的按钮，和真实按钮文案一一对上', () => {
    const promised = new Set([...buttonLabelsFor('approval'), ...buttonLabelsFor('idle')])
    for (const button of promised) {
      assert.ok(manifest.description.includes(button), `manifest 描述里应提到通知上真实存在的按钮「${button}」`)
    }
    assert.match(manifest.description, /允许/)
    assert.match(manifest.description, /知道了/)
  })
})

/**
 * 面板（options.html + options.js）的静态一致性检查。
 *
 * 起因：`options.js` 里调用了三个地方的 `flash(...)`，可**这个函数从来没被定义过**。
 * 它出现在 async 监听器里，所以表现只是控制台一条 unhandled rejection
 * （`Uncaught (in promise) ReferenceError: flash is not defined`），
 * 界面上毫无反应 —— 用户点了「强制弹通知」不知道有没有生效。
 *
 * 这类错误（引用了不存在的函数 / DOM 元素）完全静态可查，所以放一套检查在这里。
 */
describe('可发布性：版本 / 权限 / 打包清单', () => {
  const here = join(HERE, '..')
  const manifest = JSON.parse(readFileSync(join(here, 'extension', 'manifest.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

  it('manifest.json 与 package.json 的版本号一致', () => {
    assert.equal(manifest.version, pkg.version, `扩展 ${manifest.version} 与宿主 ${pkg.version} 不一致`)
  })

  it('版本号是 Chrome 认得的格式（1~4 段数字）', () => {
    assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, `"${manifest.version}" 不是合法扩展版本号`)
  })

  it('扩展声明了 script 注入权限（页内按「允许」要用），且没有多余权限', () => {
    // 每加一个权限，老用户升级时都会弹一次"新增权限"。
    assert.deepEqual(
      [...manifest.permissions].sort(),
      ['alarms', 'notifications', 'scripting', 'storage', 'tabs'],
      '权限集合变了：要么是有意为之（记得同步 README 的升级说明），要么是手滑',
    )
  })

  it('宿主权限只覆盖回环地址', () => {
    for (const pattern of manifest.host_permissions) {
      assert.match(pattern, /^http:\/\/(127\.0\.0\.1|localhost)\//, `宿主权限不该包含 ${pattern}`)
    }
  })

  it('content_scripts 声明的文件都存在', () => {
    for (const entry of manifest.content_scripts ?? []) {
      for (const file of entry.js ?? []) {
        assert.ok(existsSync(join(here, 'extension', file)), `content_scripts 里的 ${file} 不存在`)
      }
    }
    assert.ok(existsSync(join(here, 'extension', manifest.background.service_worker)), 'service worker 文件不存在')
  })

  it('内容脚本必须心跳（否则"人在页面上"的证据会过期，通知就会误弹）', () => {
    // 后台用"报告新鲜度"决定内容脚本的自述还算不算数。没有心跳时，
    // 用户一直盯着页面（visibilitychange / focus / blur 都不触发）会让报告变陈旧，
    // 后台退回"活动标签"兜底判据 —— 而那一路看不出"窗口有焦点但用户在别的应用里"。
    // 这条断言只是把"心跳不能删"钉住，具体行为由 test/extension.mjs 的判据用例覆盖。
    const source = readFileSync(join(here, 'extension', 'content.js'), 'utf8')
    assert.match(source, /setInterval\(/, 'content.js 里应当有周期性心跳（setInterval）')
    assert.match(source, /visibilitychange/, 'content.js 应当监听 visibilitychange')
    assert.match(source, /hasFocus\(\)/, 'content.js 应当用 document.hasFocus() 报焦点')
  })

  it('扩展面板引用的图标都存在', () => {
    for (const [size, file] of Object.entries(manifest.icons ?? {})) {
      assert.ok(existsSync(join(here, 'extension', file)), `${size} 图标 ${file} 不存在`)
    }
  })

  it('package.json 的 files 覆盖了运行时真正需要的目录', () => {
    for (const dir of ['src', 'client', 'extension']) {
      assert.ok(pkg.files.includes(dir), `files 里缺少 ${dir}/`)
      assert.ok(existsSync(join(here, dir)), `${dir}/ 不存在`)
    }
    assert.ok(existsSync(join(here, 'cordis.patch.yml')), 'cordis.patch.yml 不存在')
    assert.ok(existsSync(join(here, 'CHANGELOG.md')), 'CHANGELOG.md 不存在（发布要给用户看改了什么）')
  })

  it('宿主插件入口与 client 入口都真实存在', () => {
    assert.ok(existsSync(join(here, pkg.main)), `main=${pkg.main} 不存在`)
    assert.ok(existsSync(join(here, pkg.exports['./client'])), `exports["./client"]=${pkg.exports['./client']} 不存在`)
  })
})

describe('扩展面板与脚本一致', () => {
  const html = readFileSync(join(HERE, '..', 'extension', 'options.html'), 'utf8')
  const js = readFileSync(join(HERE, '..', 'extension', 'options.js'), 'utf8')

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
  const referencedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]))

  it('options.js 引用的每个元素 id 都存在于 options.html', () => {
    const missing = [...referencedIds].filter((id) => !htmlIds.has(id))
    assert.deepEqual(missing, [], `options.js 里引用了不存在的元素 id：${missing.join(', ')}`)
  })

  it('脚本里调用的每个本地函数都有定义（flash 那次就是漏了这个）', () => {
    // 只检查形如 `name(` 的调用，排除语言关键字/内建/方法调用（前面带点号的）。
    const defined = new Set([
      ...[...js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)].map(
        (m) => m[1],
      ),
    ])
    const builtins = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'void', 'delete',
      'async', 'of', 'in', 'do', 'else', 'try', 'finally', 'throw', 'yield', 'class', 'extends',
      'Number', 'String', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'Promise', 'Set', 'Map', 'Error',
      'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'encodeURIComponent', 'decodeURIComponent', 'fetch', 'require', 'import', 'test', 'match', 'then',
    ])
    const called = new Set([...js.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
    const unknown = [...called].filter((name) => !defined.has(name) && !builtins.has(name))
    assert.deepEqual(unknown, [], `options.js 调用了没有定义的函数：${unknown.join(', ')}`)
  })

  it('flash 确实有定义（回归：曾整个函数缺失）', () => {
    assert.match(js, /function\s+flash\s*\(/)
  })

  it('面板脚本用到的消息类型，后台都认识', () => {
    const background = readFileSync(join(HERE, '..', 'extension', 'background.js'), 'utf8')
    const sent = new Set([...js.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]))
    const handled = new Set([...background.matchAll(/message\.type === '([a-z-]+)'/g)].map((m) => m[1]))
    const unknown = [...sent].filter((type) => !handled.has(type))
    assert.deepEqual(unknown, [], `面板发了后台不认识的消息类型：${unknown.join(', ')}（后台要处理的是 ${[...handled].join(', ')}）`)
  })
})

/** 读回响应体里的 JSON，用来验证扩展走 HTTP 兜底时拿到的 result。 */
async function rawJsonRequest(port, method, path, { body = '', contentType } = {}) {
  const socket = netConnect({ port, host: '127.0.0.1' })
  await once(socket, 'connect')
  const headers = [
    `${method} ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    ...(contentType ? [`Content-Type: ${contentType}`] : []),
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    '',
  ]
  socket.write(headers.join('\r\n') + body)
  let text = ''
  for await (const chunk of socket) text += chunk.toString('utf8')
  const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(text) ?? [])[1] ?? 0)
  const raw = text.slice(text.indexOf('\r\n\r\n') + 4)
  let json = null
  try {
    json = JSON.parse(raw)
  } catch {
    /* 不是 JSON 就留 null */
  }
  return { status, json, raw }
}

/** 直接发一条原始 HTTP 请求，用来伪造禁止修改的头（Host）。 */async function rawRequestStatus(port, path, headers) {
  const socket = netConnect({ port, host: '127.0.0.1' })
  await once(socket, 'connect')
  const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), 'Connection: close', '', '']
  socket.write(lines.join('\r\n'))
  let text = ''
  for await (const chunk of socket) text += chunk.toString('latin1')
  const match = /^HTTP\/1\.1 (\d{3})/.exec(text)
  return match ? Number(match[1]) : 0
}

/** 极简 WebSocket 客户端：够用来做端到端验证。 */
async function openWebSocket(port, path, onText) {
  const socket = netConnect({ port, host: '127.0.0.1' })
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  await connected
  const key = randomBytes(16).toString('base64')
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )

  let handshakeDone = false
  let buffer = Buffer.alloc(0)
  let closed = false

  const ready = new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error('handshake 超时')), 5000)
    const settle = (fn) => (value) => {
      clearTimeout(timer)
      timer = null
      fn(value)
    }
    const done = settle(resolve)
    const fail = settle(reject)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshakeDone) {
        const index = buffer.indexOf('\r\n\r\n')
        if (index === -1) return
        const header = buffer.subarray(0, index).toString('latin1')
        buffer = buffer.subarray(index + 4)
        if (!/^HTTP\/1\.1 101/.test(header)) {
          fail(new Error(`handshake failed: ${header.split('\r\n')[0]}`))
          return
        }
        handshakeDone = true
        done()
      }
      const parsed = decodeFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) onText(frame.payload.toString('utf8'))
      }
    })
    socket.on('close', () => {
      closed = true
      fail(new Error('连接在握手完成前被关闭'))
    })
    socket.on('error', (error) => fail(error))
  })

  await ready

  return {
    send(text) {
      const payload = Buffer.from(text, 'utf8')
      const mask = randomBytes(4)
      const masked = Buffer.from(payload)
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3]
      const head = [0x81]
      if (masked.length < 126) head.push(0x80 | masked.length)
      else head.push(0x80 | 126, (masked.length >> 8) & 0xff, masked.length & 0xff)
      socket.write(Buffer.concat([Buffer.from(head), mask, masked]))
    },
    close() {
      if (!closed) socket.destroy()
    },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('waitFor 超时')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await finish()
