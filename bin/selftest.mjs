#!/usr/bin/env node
/**
 * 静默自检：完全不碰真实配置、不往钉钉发任何消息，只用临时 DSH_HOME 验证
 *  1. 配置读写（模板生成 / 归一化 / 原子写 / 校验拒绝 / 掩码）
 *  2. 门控时间判断（免打扰跨零点）
 *  3. 浏览器半区能被加载，apply() 能跑通并注册设置面板
 *
 * 目的：DSH 启动名册是 all-or-nothing——坏插件会让 web 界面起不来。
 * 重启之前先证明两边都是活的。
 *
 *   node bin/selftest.mjs
 *
 * 退出码 0 = 全部通过。
 *
 * @module dsh-dingtalk-notify/bin/selftest
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const notes = []

/** 记一条检查结果。 */
function check(label, ok, detail) {
  if (ok) notes.push(`  ✅ ${label}`)
  else failures.push(`${label}${detail !== undefined ? ` —— ${detail}` : ''}`)
}

// 真实配置绝不参与：整段自检都在临时 DSH_HOME 里跑。
const tempHome = mkdtempSync(join(tmpdir(), 'dtn-selftest-'))
process.env.DSH_HOME = tempHome

const dingtalk = await import('../lib/dingtalk.js')

// ── 1. 配置 ────────────────────────────────────────────────────────────────
check('配置文件首次生成', dingtalk.ensureConfigFile() === true)
check('模板带注释键', typeof JSON.parse(readFileSync(dingtalk.configPath(), 'utf8'))._说明 === 'string')

const initial = dingtalk.loadConfig(undefined)
check('默认详细度 = detailed', initial.detailLevel === 'detailed', initial.detailLevel)
check('默认门控 = away', initial.gating === 'away', initial.gating)
check('默认 ack 开关正确', initial.notifyOnQuestion === true && initial.notifyOnAbort === false)

const written = dingtalk.writeConfig({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abcdef123456', detailLevel: 'brief' })
check('写入合法配置', written.ok === true, written.error)
const reloaded = dingtalk.loadConfig(undefined)
check('写入后立即可读（无需重启）', reloaded.detailLevel === 'brief' && reloaded.webhook.endsWith('abcdef123456'))
check('写入保留注释键', typeof JSON.parse(readFileSync(dingtalk.configPath(), 'utf8'))._说明 === 'string')

check('拒绝非法 Webhook', dingtalk.writeConfig({ webhook: 'http://example.com/x' }).ok === false)
check('拒绝非法密钥', dingtalk.writeConfig({ secret: 'hello' }).ok === false)
check('拒绝越界数字', dingtalk.writeConfig({ maxMessagesPerMinute: 99 }).ok === false)
check('拒绝未知键', dingtalk.writeConfig({ nope: 1 }).ok === false)
check('拒绝非法详细度', dingtalk.writeConfig({ detailLevel: 'verbose' }).ok === false)
check('拒绝非法手机号', dingtalk.writeConfig({ atMobiles: ['123'] }).ok === false)
check('接受合法手机号', dingtalk.writeConfig({ atMobiles: ['13800000000'] }).ok === true)

const masked = dingtalk.maskWebhook(reloaded.webhook)
check('Webhook 掩码不泄露 token', !masked.includes('abcdef'), masked)
check('Webhook 掩码保留来源', masked.startsWith('https://oapi.dingtalk.com/robot/send'), masked)
check('密钥只回是否已设置', dingtalk.secretInfo('SECabcdefghijklmnop').set === true && dingtalk.secretInfo('').set === false)

// ── 2. 免打扰时段 ─────────────────────────────────────────────────────────
const dndConfig = { ...initial, dndEnabled: true, dndFrom: '23:30', dndTo: '07:30' }
const at = (hour, minute) => new Date(2026, 8, 22, hour, minute).getTime()
check('免打扰：23:45 在区间内', dingtalk.inDndWindow(dndConfig, at(23, 45)) === true)
check('免打扰：06:00 在区间内（跨零点）', dingtalk.inDndWindow(dndConfig, at(6, 0)) === true)
check('免打扰：12:00 不在区间内', dingtalk.inDndWindow(dndConfig, at(12, 0)) === false)
check('免打扰：关闭时永远不在区间内', dingtalk.inDndWindow({ ...dndConfig, dndEnabled: false }, at(23, 45)) === false)

// ── 3. 浏览器半区 ─────────────────────────────────────────────────────────
let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec } },
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  removeEventListener: () => {}
}
globalThis.document = {
  hidden: false,
  hasFocus: () => true,
  createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
}
/** 覆盖一个可能只读的全局（Node 24 的 navigator 只有 getter）。 */
function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  } catch (cause) {
    failures.push(`无法注入全局 ${name}：${String(cause)}`)
  }
}

defineGlobal('navigator', { userAgent: 'selftest-desktop', sendBeacon: () => true, maxTouchPoints: 0 })
defineGlobal('screen', { width: 1920, height: 1080 })
defineGlobal('localStorage', {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) }
})
defineGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }))
defineGlobal('Blob', class Blob { constructor(parts) { this.parts = parts } })

await import('../lib/client.js')
check('浏览器半区执行了 __ModuleLoader__.load', captured !== null && captured.id === 'dsh-dingtalk-notify')

if (captured !== null) {
  const ReactStub = {
    createElement: () => ({}),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {}
  }
  const clientModule = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`浏览器半区不该 require ${name}`)
  })
  check('浏览器半区导出 apply/inject', typeof clientModule.apply === 'function' && Array.isArray(clientModule.inject))

  let registered = []
  let cleanup = null
  const fakeCtx = {
    effect: (fn) => { cleanup = fn() },
    get: () => undefined,
    slots: {
      inject: (name, cb) => { registered.push({ name, cb }) },
      register: (options, render) => { registered.push({ options, render }); return () => {} }
    }
  }
  try {
    clientModule.apply(fakeCtx)
    await new Promise((resolve) => setTimeout(resolve, 800))
    const injectEntry = registered.find((item) => item.name === 'settings.section' && typeof item.cb === 'function')
    check('设置面板注册到 settings.section', injectEntry !== undefined)
    if (injectEntry !== undefined) {
      injectEntry.cb()
      const panel = registered.find((item) => item.options !== undefined)
      check('面板注册参数正确（id / order）', panel !== undefined && panel.options.id === 'dingtalk-notify' && panel.options.order === 42)
      if (panel !== undefined) {
        const element = panel.render({ close: () => {} })
        check('面板首屏渲染不抛异常', element !== undefined && element !== null)
      }
    }
  } catch (cause) {
    check('浏览器半区 apply() 不抛异常', false, String(cause && cause.stack ? cause.stack.split('\n')[0] : cause))
  }
  if (typeof cleanup === 'function') {
    try {
      cleanup()
      check('浏览器半区能干净卸载', true)
    } catch (cause) {
      check('浏览器半区能干净卸载', false, String(cause))
    }
  }
}

// ── 4. 宿主半区：消息组装（简洁 / 详细）────────────────────────────────────
// 用临时 DSH_HOME 里的配置 + 打桩 fetch 捕获钉钉载荷，真实走一遍组装逻辑。
dingtalk.writeConfig({ detailLevel: 'brief', mergeWindowSeconds: 0 })

/** 捕获到的钉钉请求。 */
const sent = []
defineGlobal('fetch', (url, init) => {
  sent.push({ url: String(url), payload: JSON.parse(init.body) })
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{"errcode":0,"errmsg":"ok"}')
  })
})

const host = await import('../lib/index.js')
const hostListeners = new Map()
const hostRoutes = new Map()
const hostCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: (event, handler) => {
    const bucket = hostListeners.get(event) ?? []
    bucket.push(handler)
    hostListeners.set(event, bucket)
  },
  effect: () => {},
  inject: (deps, callback) => {
    if (Array.isArray(deps) && deps.includes('webServer')) {
      callback({
        webServer: {
          register: (route) => {
            hostRoutes.set(route.path, route)
            return () => hostRoutes.delete(route.path)
          }
        },
        effect: () => {}
      })
    }
  },
  get: () => undefined
}
host.apply(hostCtx, undefined)

/** 直接调一个宿主接口（心跳用）。 */
async function callHost(path, method, body) {
  const route = hostRoutes.get(path)
  if (route === undefined) return undefined
  const handlers = { data: [], end: [] }
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) { if (handlers[event]) handlers[event].push(handler); return req },
    destroy() {}
  }
  const response = { status: 0, text: '', writeHead(status) { this.status = status }, end(text) { this.text = text ?? '' }, destroy() {} }
  const promise = route.handler(req, response)
  setTimeout(() => {
    if (body !== undefined) for (const handler of handlers.data) handler(Buffer.from(JSON.stringify(body)))
    for (const handler of handlers.end) handler()
  }, 0)
  await promise
  return { status: response.status, body: response.text ? JSON.parse(response.text) : undefined }
}

const session = {
  id: 'selftest-session',
  header: { cwd: 'D:\\work\\demo' },
  snapshotEvents: () => [
    { type: 'user/message', data: { content: [{ type: 'text', text: '自检：导出报表' }] } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '自检正文：已完成导出' }] } }
  ]
}
const emitHost = (event, ...args) => (hostListeners.get(event) ?? []).forEach((handler) => handler(...args))
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

emitHost('user-questions/request', {
  questions: [{ header: '导出', question: '机密问题正文ABC', options: [{ label: 'xlsx' }] }],
  agent: { session }
}, () => {})
await settle()
const brief = sent[0]
check('简洁模式发出了请求', brief !== undefined)
if (brief !== undefined) {
  check('简洁模式包含关键词 DSH', brief.payload.markdown.title.includes('DSH'))
  check('简洁模式带上 @ 手机号文本（钉钉才会真的 @）', brief.payload.markdown.text.includes('@13800000000'))
  check('简洁模式不带问题正文', !brief.payload.markdown.text.includes('机密问题正文ABC'))
  check('简洁模式仍标明会话', brief.payload.markdown.text.includes('自检：导出报表'))
}

dingtalk.writeConfig({ detailLevel: 'detailed' })
emitHost('approval/request', { toolName: 'Remove-Item', reason: '自检原因XYZ', agent: { session } }, () => {})
await settle()
const detailed = sent[1]
check('详细模式发出了请求', detailed !== undefined)
if (detailed !== undefined) {
  check('详细模式带工具名', detailed.payload.markdown.text.includes('Remove-Item'))
  check('详细模式带原因', detailed.payload.markdown.text.includes('自检原因XYZ'))
}

// 门控：手机离线 + mobileOnly → 不发；手机在线 → 发。
dingtalk.writeConfig({ gating: 'mobileOnly' })
const before = sent.length
emitHost('approval/request', { toolName: 'pwsh', agent: { session } }, () => {})
await settle()
check('门控 mobileOnly：手机不在线时静默', sent.length === before)

await callHost('/api/dsh-dingtalk-notify/presence', 'POST', {
  clientId: 'selftest-phone',
  device: 'mobile',
  visible: false,
  focused: false
})
const gateStatus = await callHost('/api/dsh-dingtalk-notify/status', 'GET')
check('心跳上报后状态里能看到手机在线', (gateStatus?.body?.presence ?? []).some((item) => item.device === 'mobile'))
emitHost('approval/request', { toolName: 'pwsh', agent: { session } }, () => {})
await settle()
check('门控 mobileOnly：手机在线时发出', sent.length === before + 1)

// 门控 away：手机在线且正在看页面 → 静默。
dingtalk.writeConfig({ gating: 'away' })
await callHost('/api/dsh-dingtalk-notify/presence', 'POST', {
  clientId: 'selftest-phone',
  device: 'mobile',
  visible: true,
  focused: true
})
const beforeAway = sent.length
emitHost('approval/request', { toolName: 'pwsh', agent: { session } }, () => {})
await settle()
check('门控 away：有人正看着页面时静默', sent.length === beforeAway)

// ── 收尾 ──────────────────────────────────────────────────────────────────
try {
  rmSync(tempHome, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉也不影响结论 */
}

process.stdout.write(`${notes.join('\n')}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n自检失败 ❌\n${failures.map((item) => `  - ${item}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('\n自检通过 ✅（未发送任何钉钉消息，未改动真实配置）\n')
process.exit(0)
