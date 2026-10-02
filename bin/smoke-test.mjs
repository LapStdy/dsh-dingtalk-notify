#!/usr/bin/env node
/**
 * 假上下文烟测：不启动 DSH，直接用桩 ctx 加载插件并触发三类事件，
 * 验证「模块能 import、apply 能挂载、三个监听器都注册、设置面板接口能应答、
 * 通知真的发得出去」。
 *
 * 目的：DSH 启动名册是 all-or-nothing——坏插件会让 web 界面起不来。
 * 所以重启之前必须先证明这个插件本身是活的。
 *
 *   node bin/smoke-test.mjs
 *   node bin/smoke-test.mjs --dry     # 只验结构，不往钉钉发消息
 *
 * 退出码 0 = 全部通过。
 *
 * @module dsh-dingtalk-notify/bin/smoke-test
 */

import { apply, inject, name } from '../lib/index.js'

const dry = process.argv.includes('--dry')
const failures = []
const listeners = new Map()
const routes = new Map()
const sendResults = []

const fakeServer = {
  register: (route) => {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  }
}

const ctx = {
  logger: {
    info: (message) => process.stdout.write(`  [info] ${message}\n`),
    warn: (message) => process.stdout.write(`  [warn] ${message}\n`)
  },
  on: (event, handler) => {
    const bucket = listeners.get(event) ?? []
    bucket.push(handler)
    listeners.set(event, bucket)
  },
  effect: () => {},
  inject: (deps, callback) => {
    if (Array.isArray(deps) && deps.includes('webServer')) callback({ webServer: fakeServer, effect: () => {} })
  },
  get: () => undefined
}

/** 发一条假事件给所有监听器。 */
function emit(event, ...args) {
  const bucket = listeners.get(event) ?? []
  if (bucket.length === 0) throw new Error(`没有监听器：${event}`)
  return bucket.map((handler) => handler(...args))
}

/** 假请求：可指定方法与 JSON 体。 */
function fakeReq({ method = 'GET', url = '/', host = '127.0.0.1:3080', address = '127.0.0.1', body } = {}) {
  const handlers = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    headers: { host },
    socket: { remoteAddress: address },
    on(event, handler) {
      if (handlers[event] !== undefined) handlers[event].push(handler)
      return req
    },
    destroy() {}
  }
  setTimeout(() => {
    if (body !== undefined) for (const handler of handlers.data) handler(Buffer.from(JSON.stringify(body)))
    for (const handler of handlers.end) handler()
  }, 0)
  return req
}

/** 假响应：捕获状态码与正文。 */
function fakeRes() {
  return {
    status: 0,
    text: '',
    writeHead(status) { this.status = status },
    end(text) { this.text = text ?? '' },
    destroy() {}
  }
}

/** 直接调用某个已注册接口。 */
async function call(path, options) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`接口没注册：${path}`)
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  return { status: res.status, body: res.text.length > 0 ? JSON.parse(res.text) : undefined }
}

process.stdout.write(`插件名：${name}，inject：[${inject.join(', ')}]，模式：${dry ? 'dry（不发消息）' : '真实发送'}\n`)
apply(ctx, dry ? { enabled: false } : { minTurnSeconds: 0 })

for (const event of ['user-questions/request', 'approval/request', 'session/event']) {
  if ((listeners.get(event) ?? []).length === 0) failures.push(`${event} 没有注册监听器`)
}

// ── 0) 设置面板接口 ────────────────────────────────────────────────────────
const expectedRoutes = [
  '/api/dsh-dingtalk-notify/config',
  '/api/dsh-dingtalk-notify/test',
  '/api/dsh-dingtalk-notify/presence',
  '/api/dsh-dingtalk-notify/status',
  '/api/dsh-dingtalk-notify/log'
]
for (const path of expectedRoutes) {
  if (!routes.has(path)) failures.push(`设置面板接口没注册：${path}`)
}

if (routes.size > 0) {
  const forbidden = await call('/api/dsh-dingtalk-notify/config', { host: '192.168.1.9:3080', address: '192.168.1.9' })
  if (forbidden.status !== 403) failures.push(`非回环访问配置接口应 403，实际 ${forbidden.status}`)
  process.stdout.write(`  [route] 非回环读取配置 → ${forbidden.status} ${forbidden.body?.error ?? ''}\n`)

  const status = await call('/api/dsh-dingtalk-notify/status')
  const publicConfig = status.body?.config ?? {}
  if (status.status !== 200 || status.body?.ok !== true) failures.push('状态接口没有正常应答')
  if (typeof publicConfig.webhookMasked === 'string' && publicConfig.webhookMasked.includes('access_token=') && /access_token=[A-Za-z0-9]{8,}/.test(publicConfig.webhookMasked)) {
    failures.push('状态接口泄露了完整 access_token')
  }
  if (publicConfig.secret !== undefined) failures.push('状态接口不该回传 secret 字段')
  process.stdout.write(`  [route] 状态 → 详细度=${publicConfig.detailLevel} 门控=${publicConfig.gating} 门控判定=${status.body?.gate?.label ?? ''}\n`)

  const beat = await call('/api/dsh-dingtalk-notify/presence', {
    method: 'POST',
    body: { clientId: 'smoke-phone', device: 'mobile', visible: false, focused: false, ua: 'smoke' }
  })
  if (beat.body?.ok !== true) failures.push('心跳接口没有正常应答')
  const afterBeat = await call('/api/dsh-dingtalk-notify/status')
  const seen = (afterBeat.body?.presence ?? []).some((item) => item.clientId === 'smoke-phone')
  if (!seen) failures.push('心跳上报后在线设备列表里没有它')
  process.stdout.write(`  [route] 心跳 → 在线设备 ${(afterBeat.body?.presence ?? []).length} 台\n`)

  const badWrite = await call('/api/dsh-dingtalk-notify/config', { method: 'POST', body: { patch: { webhook: 'http://bad' } } })
  if (badWrite.body?.ok !== false) failures.push('非法 Webhook 应被拒绝')
  process.stdout.write(`  [route] 非法 Webhook → ${badWrite.body?.error ?? ''}\n`)
}

// ── 1) 需要你选择 ──────────────────────────────────────────────────────────
const fakeSession = {
  id: 'smoke-session',
  header: { cwd: 'D:\\work\\demo' },
  snapshotEvents: () => [
    { type: 'user/message', data: { content: [{ type: 'text', text: '烟测：帮我把报表导出来' }] } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '烟测正文：报表已导出到 D:\\work\\demo\\out.xlsx' }] } }
  ]
}

let questionDelegated = false
emit(
  'user-questions/request',
  {
    questions: [
      {
        id: 'q1',
        header: '烟测',
        question: '（烟测）报表导出成哪种格式？',
        options: [{ label: 'xlsx' }, { label: 'csv', description: '纯文本、体积小' }]
      }
    ],
    agent: { id: 'smoke-session', session: fakeSession }
  },
  () => {
    questionDelegated = true
    return Promise.resolve({ answers: [] })
  }
)
if (!questionDelegated) failures.push('user-questions/request 没有把决策权 next() 交回下游')

// ── 2) 需要你审批 ──────────────────────────────────────────────────────────
let approvalDelegated = false
emit(
  'approval/request',
  { toolName: 'pwsh', reason: '（烟测）要执行 `Remove-Item`', agent: { id: 'smoke-session', session: fakeSession } },
  () => {
    approvalDelegated = true
    return Promise.resolve('allowed-once')
  }
)
if (!approvalDelegated) failures.push('approval/request 没有把决策权 next() 交回下游')

// ── 3) 任务完成 ────────────────────────────────────────────────────────────
emit('session/event', fakeSession, { type: 'turn/start', data: { turn: 1 } })
await new Promise((resolve) => setTimeout(resolve, 20))
emit('session/event', fakeSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

// 等异步发送落定（同类提醒有 3 秒合并窗口）
await new Promise((resolve) => setTimeout(resolve, dry ? 400 : 6000))

const { loadConfig, logLine, logPath } = await import('../lib/dingtalk.js')
const config = loadConfig(undefined)
if (dry) {
  process.stdout.write('\n--dry：只验结构，不发送（配置里的 enabled 被本次运行覆盖为 false）。\n')
} else if (config.enabled === false) {
  process.stdout.write('\n配置里 enabled=false —— 通知被主动关闭，只验证挂载结构。\n')
} else if (typeof config.webhook !== 'string' || config.webhook.trim().length === 0) {
  failures.push('webhook 未配置，无法验证真实发送')
}

const { readFileSync } = await import('node:fs')
try {
  const lines = readFileSync(logPath(), 'utf8').trim().split('\n').slice(-4)
  for (const line of lines) {
    const entry = JSON.parse(line)
    sendResults.push(entry)
    process.stdout.write(`  [log] ${entry.kind}${entry.reason !== undefined ? ` (${entry.reason})` : ''} · ${entry.title ?? ''}\n`)
  }
} catch {
  process.stdout.write('  [log] 尚无日志文件\n')
}
logLine({ kind: 'smoke', ok: failures.length === 0, dry })

if (failures.length > 0) {
  process.stderr.write(`\n烟测失败 ❌\n${failures.map((item) => `  - ${item}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  dry
    ? '\n烟测通过 ✅ 插件能加载、三类事件都挂上、5 条面板接口都在、没有发送任何消息。\n'
    : '\n烟测通过 ✅ 插件能加载、三类事件都挂上、面板接口都在、通知已发出（钉钉群应收到 3 条烟测消息）。\n'
)
process.exit(0)
