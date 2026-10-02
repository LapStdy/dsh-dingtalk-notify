/**
 * dsh-dingtalk-notify — 宿主侧插件（v0.2：带设置面板 + 设备门控）。
 *
 * 监听三个扩展点，把「需要你拍板」和「活干完了」推到钉钉群：
 *
 *   user-questions/request   AI 调 ask_user_question（含 plan-review）→「需要你选择」
 *   approval/request         某个操作需要审批                        →「需要你审批」
 *   session/event turn/end   一轮任务结束                            →「任务完成 / 出错」
 *
 * 两个 request 都是 waterfall：本插件只**观察**，立刻 `next()` 把决策权交回原有
 * 回答者（界面弹窗 / dsh-auto-review），绝不抢答、绝不阻塞。
 *
 * v0.2 新增：
 *   - 设置面板接口（`/api/dsh-dingtalk-notify/*`，仅回环可写；手机经 dsh-pocket
 *     代理进来时同样表现为回环，所以手机上也能开面板）：浏览器半区在 lib/client.js。
 *   - 设备在线心跳 + 门控：`gating=away` 表示「有人正盯着 DSH 页面就不发」，
 *     `gating=mobileOnly` 表示「只有手机在线才发」。
 *   - 通知详细度 `brief` / `detailed`。
 *   - 免打扰时段、同类提醒合并、失败重试、发送历史。
 *
 * 所有回调整体 try/catch：通知链路出问题也绝不影响 agent 运行。
 *
 * @module dsh-dingtalk-notify
 */

import {
  clearHistory,
  ensureConfigFile,
  explainError,
  getHistory,
  inDndWindow,
  loadConfig,
  logLine,
  maskWebhook,
  publicConfig,
  pushHistory,
  secretInfo,
  sendDingtalk,
  stateDir,
  writeConfig
} from './dingtalk.js'

/** 插件身份（cordis.yml / 补丁层按 id 引用）。 */
export const name = 'dsh-dingtalk-notify'

/** 不硬依赖任何服务：`sessionTitle` / `webServer` 都走懒查找或 inject。 */
export const inject = []

/** 面板接口版本（Diagnostics 区展示用）。 */
const VERSION = '0.2.0'

/** 设置面板接口路径表。 */
const API = {
  config: '/api/dsh-dingtalk-notify/config',
  test: '/api/dsh-dingtalk-notify/test',
  presence: '/api/dsh-dingtalk-notify/presence',
  status: '/api/dsh-dingtalk-notify/status',
  log: '/api/dsh-dingtalk-notify/log'
}

/** 每轮开始时刻（sessionId -> { turn, at }），用于算「这一轮干了多久」。 */
const turnStartedAt = new Map()

/**
 * 把毫秒时长写成「1 分 05 秒」这类人话。
 * @param ms - 毫秒。
 * @returns 中文时长串。
 */
function humanDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/**
 * 压缩空白并截断。
 * @param value - 任意值。
 * @param max - 最大字符数。
 * @returns 单行文本；空内容返回空串。
 */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 从一个会话事件的数据里抽出文本内容。
 * @param data - 事件 data。
 * @returns 纯文本。
 */
function textOf(data) {
  const blocks = Array.isArray(data?.content)
    ? data.content
    : Array.isArray(data?.message?.content)
      ? data.message.content
      : []
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * 会话标题：优先用 DSH 的 sessionTitle 服务，其次首条用户消息。
 * @param ctx - cordis 上下文。
 * @param session - 会话对象。
 * @returns 标题文本（可能为空串）。
 */
function titleOf(ctx, session) {
  try {
    const service = ctx.get?.('sessionTitle')
    const snapshot = service?.get?.(session)
    if (typeof snapshot === 'string' && snapshot.trim().length > 0) return snapshot.trim()
    if (typeof snapshot?.title === 'string' && snapshot.title.trim().length > 0) return snapshot.title.trim()
  } catch {
    /* 服务缺失或尚未就绪：退回消息内容 */
  }
  try {
    for (const event of session.snapshotEvents()) {
      if (event?.type !== 'user/message') continue
      const text = clip(textOf(event.data), 60)
      if (text.length > 0) return text
    }
  } catch {
    /* 会话日志读取失败：调用方会用兜底文案 */
  }
  return ''
}

/**
 * 倒序找最近一条某类消息的文本。
 * @param session - 会话对象。
 * @param type - 事件类型，如 `assistant/message`。
 * @param max - 截断长度。
 * @returns 单行文本（可能为空串）。
 */
function lastTextOf(session, type, max) {
  try {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== type) continue
      const text = clip(textOf(event.data), max)
      if (text.length > 0) return text
    }
  } catch {
    /* 忽略：正文缺失不影响通知送达 */
  }
  return ''
}

/**
 * 会话的一行描述：标题 + 工作目录名。
 * @param ctx - cordis 上下文。
 * @param session - 会话对象。
 * @returns `{ title, folder }`。
 */
function describeSession(ctx, session) {
  const title = titleOf(ctx, session)
  const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  const folder = cwd.length > 0 ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
  return { title, folder }
}

/**
 * 从请求里取回它所属的会话（question / approval 的 request 都带 agent）。
 * @param request - waterfall 请求对象。
 * @returns Session 或 undefined。
 */
function sessionOf(request) {
  try {
    const session = request?.agent?.session
    return session !== null && typeof session === 'object' ? session : undefined
  } catch {
    return undefined
  }
}

/** 会话是否属于子任务（subagent）。 */
function isSubagent(session) {
  const header = session?.header
  if (header?.origin === 'subagent') return true
  const depth = Number(header?.delegationDepth ?? 0)
  return Number.isFinite(depth) && depth > 0
}

/**
 * 按详细度渲染成钉钉 markdown。
 * @param config - 完整配置对象。
 * @param item - 组装好的通知条目。
 * @param mergedCount - 被合并进这一条的同类提醒数量（≥1）。
 * @returns `{ title, text }`。
 */
function renderMessage(config, item, mergedCount) {
  const brief = config.detailLevel === 'brief'
  const lines = []
  if (brief) {
    // 简洁模式：会话名一行 + 一句提醒；不带问题正文/选项/工具名/用时/摘要。
    if (item.session.length > 0) lines.push(item.session[0])
  } else {
    if (item.session.length > 0) lines.push(...item.session)
    if (item.session.length > 0 && item.body.length > 0) lines.push('')
    if (item.body.length > 0) lines.push(...item.body)
  }
  if (mergedCount > 1) {
    if (lines.length > 0) lines.push('')
    lines.push(`> 这一轮共有 ${mergedCount} 条同类提醒，已合并为一条。`)
  }
  if (typeof item.tail === 'string' && item.tail.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(item.tail)
  }
  return { title: item.title, text: `${item.head}\n\n${lines.join('\n')}` }
}

/**
 * 给正文补上 @手机号 文本行。
 * 钉钉要求在正文里出现 `@手机号`，被 @ 的人才会真的收到提醒；只发 at 字段是不够的。
 * @param text - markdown 正文。
 * @param config - 完整配置对象。
 * @returns 追加后的正文。
 */
function withMentions(text, config) {
  const mobiles = Array.isArray(config.atMobiles) ? config.atMobiles : []
  if (mobiles.length === 0) return text
  return `${text}\n\n${mobiles.map((mobile) => `@${mobile}`).join(' ')}`
}

/**
 * 插件入口。
 * @param ctx - 宿主 cordis 上下文。
 * @param config - 插件条目 config（可选；优先级高于配置文件）。
 */
export function apply(ctx, config) {
  const overrides = config

  /**
   * 打一行诊断：**同时**走宿主 logger 与 stdout。
   * 只走 logger 会落进 DSH 自己的日志（不出现在 `_DSH\launcher\logs\` 的启动日志里），
   * 排障时看不到挂载痕迹；只走 stdout 又拿不到宿主的结构化日志。所以两边都写。
   * @param level - `info` | `warn`
   * @param message - 文案。
   */
  const say = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') {
        logger[level](message)
      }
    } catch {
      /* logger 不可用不影响 stdout */
    }
    try {
      console.log(`[dingtalk-notify] ${message}`)
    } catch {
      /* 连 stdout 都写不了就不再挣扎 */
    }
  }

  /** 注册一个随插件卸载而执行的清理函数（测试桩 ctx 可能没有 effect）。 */
  const onCleanup = (fn) => {
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => fn)
    } catch {
      /* 没有 effect 就算了：进程级插件本来也不会被热卸载 */
    }
  }

  if (ensureConfigFile()) {
    say('info', `已生成配置模板 ${stateDir()}，请填入 webhook 后生效`)
  }
  const initial = loadConfig(overrides)
  if (typeof initial.webhook !== 'string' || initial.webhook.trim().length === 0) {
    say('warn', `尚未配置 webhook，通知不会发出（可以打开 DSH「设置 → 钉钉通知」填写）`)
  } else {
    say('info', `已挂载（需要选择 / 需要审批 / 任务完成 → 钉钉；详细度=${initial.detailLevel}，门控=${initial.gating}）`)
  }

  // ── 在线设备表（内存态，靠浏览器半区心跳维护）─────────────────────────
  /** @type {Map<string, {clientId:string, device:string, visible:boolean, focused:boolean, firstSeen:number, lastSeen:number, ua:string, ip:string}>} */
  const presence = new Map()

  /** 丢掉过期心跳，返回仍在线的设备。 */
  const activeClients = (current) => {
    const ttl = Math.max(60, Number(current?.presenceTtlSeconds ?? 300)) * 1000
    const now = Date.now()
    for (const [id, record] of presence) {
      if (now - record.lastSeen > ttl) presence.delete(id)
    }
    return [...presence.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * 门控判断：现在该不该发。
   * @param current - 完整配置对象。
   * @returns `{ allow, reason?, label }`。
   */
  const evaluateGate = (current) => {
    if (current.gating === 'always') return { allow: true, label: '总是发送' }
    const alive = activeClients(current)
    if (current.gating === 'mobileOnly') {
      // 「只有手机在线才发」是字面语义：一台都没有 = 不发（哪怕电脑页面也关着）。
      const mobile = alive.filter((record) => record.device === 'mobile')
      if (mobile.length === 0) {
        return {
          allow: false,
          reason: 'no-mobile-online',
          label: alive.length === 0 ? '手机端不在线（当前没有任何页面在线）' : '手机端不在线'
        }
      }
      return { allow: true, label: `手机端在线（${mobile.length} 台）` }
    }
    // away：只要有人在盯着 DSH 页面就不打扰；一台页面都没有 = 人不在电脑前。
    if (alive.length === 0) return { allow: true, label: '没有任何在线页面 → 视为不在电脑前' }
    const attentive = alive.filter((record) => record.visible && record.focused)
    if (attentive.length > 0) {
      return { allow: false, reason: 'page-attended', label: '有人正看着 DSH 页面' }
    }
    return { allow: true, label: '页面没人看（切走了 / 关掉了 / 手机在线）' }
  }

  /**
   * 统一出口：现读配置 → 门控 → 免打扰 → 发送 → 记历史。
   * @param item - 组装好的通知条目。
   * @param mergedCount - 合并数量。
   */
  const deliver = (item, mergedCount) => {
    let current
    try {
      current = loadConfig(overrides)
    } catch (cause) {
      logLine({ kind: 'error', detail: `loadConfig 失败：${String(cause)}` })
      return
    }
    if (current.enabled === false) {
      pushHistory({ kind: item.kind, title: item.title, outcome: 'skip', reason: 'disabled' })
      return
    }
    if (typeof current.webhook !== 'string' || current.webhook.trim().length === 0) {
      pushHistory({ kind: item.kind, title: item.title, outcome: 'skip', reason: 'webhook-empty' })
      return
    }
    const gate = evaluateGate(current)
    if (!gate.allow) {
      pushHistory({ kind: item.kind, title: item.title, outcome: 'skip', reason: gate.reason, detail: gate.label })
      return
    }
    const dnd = inDndWindow(current)
    if (dnd && !(current.dndExceptErrors === true && item.kind === 'error')) {
      pushHistory({ kind: item.kind, title: item.title, outcome: 'skip', reason: 'dnd', detail: '免打扰时段' })
      return
    }
    const rendered = renderMessage(current, item, mergedCount)
    const text = withMentions(rendered.text, current)
    void sendDingtalk(current, { title: rendered.title, text }).then((result) => {
      pushHistory({
        kind: item.kind,
        title: rendered.title,
        level: current.detailLevel,
        outcome: result.ok ? 'sent' : 'error',
        reason: result.skipped,
        detail: result.error,
        ms: result.ms
      })
    })
  }

  // ── 同类提醒合并窗口 ────────────────────────────────────────────────
  /** @type {Map<string, { item: object, count: number, timer: ReturnType<typeof setTimeout> }>} */
  const pendingMerge = new Map()

  /** 把攒着的合并条目发出去。 */
  const flushMerge = (key) => {
    const entry = pendingMerge.get(key)
    if (entry === undefined) return
    pendingMerge.delete(key)
    deliver(entry.item, entry.count)
  }

  /**
   * 入队：窗口内同 key 的提醒合并成一条。
   * @param key - 合并键（同类 + 同一会话）。
   * @param item - 通知条目。
   * @param windowSeconds - 合并窗口秒数；0 表示立即发。
   */
  const enqueue = (key, item, windowSeconds) => {
    const windowMs = Math.max(0, Number(windowSeconds) || 0) * 1000
    if (windowMs === 0) {
      deliver(item, 1)
      return
    }
    const existing = pendingMerge.get(key)
    if (existing !== undefined) {
      existing.count += 1
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => flushMerge(key), windowMs)
      return
    }
    pendingMerge.set(key, {
      item,
      count: 1,
      timer: setTimeout(() => flushMerge(key), windowMs)
    })
  }

  onCleanup(() => {
    for (const entry of pendingMerge.values()) clearTimeout(entry.timer)
    pendingMerge.clear()
  })

  // ── 设置面板接口 ────────────────────────────────────────────────────
  /**
   * 请求是否来自本机回环（手机经 dsh-pocket 代理进来时也表现为回环）。
   * @param req - node http 请求。
   * @returns 布尔值。
   */
  const isLoopbackRequest = (req) => {
    const address = req?.socket?.remoteAddress
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const host = String(req?.headers?.host ?? '')
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === ''
  }

  /** 回一个 JSON 响应。 */
  const writeJson = (res, status, body) => {
    try {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(text)
    } catch {
      try {
        res.destroy()
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 读取 JSON 请求体（超过 256KB 直接拒绝）。 */
  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 262_144) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw.length === 0) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch (cause) {
          reject(new Error(`请求体不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`))
        }
      })
      req.on('error', reject)
    })

  /** 本插件接口统一的回环守卫。 */
  const guard = (req, res) => {
    if (isLoopbackRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }

  const registerRoutes = () => {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (serverCtx) => {
      const server = serverCtx?.webServer
      if (server === null || server === undefined || typeof server.register !== 'function') return

      const routes = [
        {
          kind: 'exact',
          path: API.config,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const method = req.method || 'GET'
            if (method === 'GET') {
              const current = loadConfig(overrides)
              writeJson(res, 200, {
                ok: true,
                version: VERSION,
                config: publicConfig(current),
                gate: evaluateGate(current)
              })
              return
            }
            if (method !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req).catch((cause) => ({ __error: String(cause?.message ?? cause) }))
            if (body.__error !== undefined) {
              writeJson(res, 400, { ok: false, error: body.__error })
              return
            }
            const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : body
            const result = writeConfig(patch)
            if (result.ok !== true) {
              writeJson(res, 400, { ok: false, error: result.error })
              return
            }
            say('info', `设置面板已更新配置（${Object.keys(patch).join(', ')}）`)
            writeJson(res, 200, {
              ok: true,
              config: publicConfig(result.config),
              gate: evaluateGate(result.config)
            })
          }
        },
        {
          kind: 'exact',
          path: API.test,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if ((req.method || 'POST') !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req).catch(() => ({}))
            const current = loadConfig(overrides)
            // 测试用草稿里的地址/密钥（面板还没保存也能先试），空值表示沿用已保存的。
            const trial = { ...current }
            if (typeof body.webhook === 'string' && body.webhook.trim().length > 0) trial.webhook = body.webhook.trim()
            if (body.webhook === null) trial.webhook = ''
            if (typeof body.secret === 'string' && body.secret.trim().length > 0) trial.secret = body.secret.trim()
            if (body.secret === null) trial.secret = ''
            if (typeof trial.webhook !== 'string' || trial.webhook.trim().length === 0) {
              writeJson(res, 200, { ok: false, error: '还没填 Webhook 地址' })
              return
            }
            if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]+/i.test(trial.webhook)) {
              writeJson(res, 200, { ok: false, error: 'Webhook 地址格式不对（应以 https://oapi.dingtalk.com/robot/send?access_token= 开头）' })
              return
            }
            const levelName = trial.detailLevel === 'brief' ? '简洁' : '详细'
            const gateName = { always: '总是发送', away: '只在没人看页面时发送', mobileOnly: '只在手机端在线时发送' }[trial.gating] ?? trial.gating
            const text = [
              '### 🔔 DSH 钉钉通知自检',
              '',
              '**结果**：链路正常 ✅',
              `**时间**：${new Date().toLocaleString('zh-CN')}`,
              `**详细度**：${levelName}`,
              `**门控**：${gateName}`,
              `**安全模式**：${secretInfo(trial.secret).set ? '加签' : '自定义关键词'}`,
              '',
              '收到这条消息，说明 DSH 已经能往这个群发通知了。'
            ].join('\n')
            const result = await sendDingtalk({ ...trial, enabled: true }, { title: 'DSH 通知自检', text })
            if (result.ok) {
              pushHistory({ kind: 'test', title: 'DSH 通知自检', outcome: 'sent', ms: result.ms, detail: '面板测试发送' })
              writeJson(res, 200, { ok: true, ms: result.ms, attempts: result.attempts })
              return
            }
            const detail = result.skipped !== undefined ? `被跳过：${result.skipped}` : result.error
            pushHistory({ kind: 'test', title: 'DSH 通知自检', outcome: 'error', detail })
            writeJson(res, 200, { ok: false, error: detail, errcode: result.errcode })
          }
        },
        {
          kind: 'exact',
          path: API.presence,
          handler: async (req, res) => {
            // 心跳不设回环守卫：手机直连局域网时也要能报到。它只写「谁在线」，读不到任何配置。
            if ((req.method || 'POST') !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req).catch(() => ({}))
            const clientId = clip(String(body.clientId ?? ''), 64)
            if (clientId.length === 0) {
              writeJson(res, 400, { ok: false, error: 'clientId required' })
              return
            }
            if (body.gone === true) {
              presence.delete(clientId)
              writeJson(res, 200, { ok: true, clients: presence.size })
              return
            }
            const device = body.device === 'mobile' || body.device === 'desktop' ? body.device : 'unknown'
            const previous = presence.get(clientId)
            presence.set(clientId, {
              clientId,
              device,
              visible: body.visible === true,
              focused: body.focused === true,
              firstSeen: previous?.firstSeen ?? Date.now(),
              lastSeen: Date.now(),
              ua: clip(String(body.ua ?? req.headers['user-agent'] ?? ''), 120),
              ip: clip(String(req.socket?.remoteAddress ?? ''), 40)
            })
            writeJson(res, 200, { ok: true, clients: presence.size })
          }
        },
        {
          kind: 'exact',
          path: API.status,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const current = loadConfig(overrides)
            const alive = activeClients(current)
            writeJson(res, 200, {
              ok: true,
              version: VERSION,
              config: publicConfig(current),
              gate: evaluateGate(current),
              dnd: inDndWindow(current),
              presence: alive.map((record) => ({
                clientId: record.clientId,
                device: record.device,
                visible: record.visible,
                focused: record.focused,
                lastSeen: record.lastSeen,
                ua: record.ua
              })),
              history: getHistory(20),
              defaults: {
                detailLevel: loadConfig(undefined).detailLevel,
                configPath: publicConfig(current).configPath
              }
            })
          }
        },
        {
          kind: 'exact',
          path: API.log,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if ((req.method || 'POST') !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req).catch(() => ({}))
            if (body.action === 'clear') {
              clearHistory()
              writeJson(res, 200, { ok: true, history: [] })
              return
            }
            writeJson(res, 400, { ok: false, error: `未知动作：${String(body.action)}` })
          }
        }
      ]

      let registered = 0
      for (const route of routes) {
        try {
          const dispose = server.register(route)
          if (typeof dispose === 'function' && typeof serverCtx.effect === 'function') {
            serverCtx.effect(() => dispose)
          }
          registered += 1
        } catch (cause) {
          say('warn', `接口注册失败 ${route.path}：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      say('info', `设置面板接口已就绪（${registered} 条，仅本机可写）`)
    })
  }

  registerRoutes()

  // ── AI 需要你选择（ask_user_question，含 plan-review 计划审批）──────────
  ctx.on('user-questions/request', (request, next) => {
    try {
      const current = loadConfig(overrides)
      if (current.notifyOnQuestion) {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const session = sessionOf(request)
        const sessionId = String(session?.id ?? 'unknown')
        const described = session !== undefined ? describeSession(ctx, session) : { title: '', folder: '' }
        const sessionLines = []
        if (described.title.length > 0) sessionLines.push(`**会话**：${described.title}`)
        if (described.folder.length > 0) sessionLines.push(`**工作区**：${described.folder}`)
        const body = []
        for (const [index, question] of questions.entries()) {
          const heading = questions.length > 1 ? `${index + 1}. ` : ''
          const header = clip(question?.header, 40)
          body.push(`**${heading}${header.length > 0 ? `${header}：` : ''}${clip(question?.question, 200)}**`)
          const detail = clip(question?.detail, 300)
          if (detail.length > 0) body.push(`> ${detail}`)
          const options = Array.isArray(question?.options) ? question.options : []
          if (options.length > 0) {
            body.push('')
            for (const option of options) {
              const description = clip(option?.description, 80)
              body.push(`- **${clip(option?.label, 60)}**${description.length > 0 ? ` — ${description}` : ''}`)
            }
          }
        }
        enqueue(
          `question:${sessionId}`,
          {
            kind: 'question',
            sessionId,
            title: 'DSH 需要你选择',
            head: '### 🔔 DSH 需要你选择',
            session: sessionLines,
            body,
            tail: '请回到 DSH 页面作答（钉钉机器人只能单向通知，不能替你点选）。'
          },
          current.mergeWindowSeconds
        )
      }
    } catch (cause) {
      logLine({ kind: 'error', detail: `question handler: ${String(cause)}` })
    }
    return typeof next === 'function' ? next() : undefined
  })

  // ── 需要你审批（工具/操作被拦下）──────────────────────────────────────
  ctx.on('approval/request', (request, next) => {
    try {
      const current = loadConfig(overrides)
      if (current.notifyOnApproval) {
        const session = sessionOf(request)
        const sessionId = String(session?.id ?? 'unknown')
        const described = session !== undefined ? describeSession(ctx, session) : { title: '', folder: '' }
        const sessionLines = []
        if (described.title.length > 0) sessionLines.push(`**会话**：${described.title}`)
        if (described.folder.length > 0) sessionLines.push(`**工作区**：${described.folder}`)
        const body = [`**操作**：\`${clip(request?.toolName, 60) || '未知工具'}\``]
        const reason = clip(request?.reason, 300)
        if (reason.length > 0) body.push(`**原因**：${reason}`)
        enqueue(
          `approval:${sessionId}`,
          {
            kind: 'approval',
            sessionId,
            title: 'DSH 需要你审批',
            head: '### 🔐 DSH 需要你审批',
            session: sessionLines,
            body,
            tail: '请回到 DSH 页面批准或拒绝。'
          },
          current.mergeWindowSeconds
        )
      }
    } catch (cause) {
      logLine({ kind: 'error', detail: `approval handler: ${String(cause)}` })
    }
    return typeof next === 'function' ? next() : undefined
  })

  // ── 一轮任务结束 ────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/start' && event?.type !== 'turn/end') return
      const sessionId = String(session?.id ?? '')
      if (event.type === 'turn/start') {
        turnStartedAt.set(sessionId, { turn: event.data?.turn, at: Date.now() })
        return
      }
      if (event.type !== 'turn/end') return

      const started = turnStartedAt.get(sessionId)
      turnStartedAt.delete(sessionId)
      const elapsedMs = started !== undefined && started.turn === event.data?.turn ? Date.now() - started.at : undefined

      const current = loadConfig(overrides)
      if (!current.includeSubagents && isSubagent(session)) return

      const kind = event.data?.reason?.kind ?? 'completed'
      const isError = kind === 'error'
      const isAbort = kind === 'aborted' || kind === 'interrupted'
      if (isError && !current.notifyOnError) return
      if (isAbort && !current.notifyOnAbort) return
      if (!isError && !isAbort && !current.notifyOnTurnEnd) return
      if (!isError && !isAbort && elapsedMs !== undefined && elapsedMs < current.minTurnSeconds * 1000) return

      const described = describeSession(ctx, session)
      const sessionLines = []
      if (described.title.length > 0) sessionLines.push(`**会话**：${described.title}`)
      if (described.folder.length > 0) sessionLines.push(`**工作区**：${described.folder}`)
      const body = []
      if (elapsedMs !== undefined) body.push(`**用时**：${humanDuration(elapsedMs)}`)
      const snippet = lastTextOf(session, 'assistant/message', 160)
      if (snippet.length > 0) body.push('', snippet)

      let head
      let title
      let itemKind
      if (isError) {
        head = '### ❌ DSH 任务出错'
        title = 'DSH 任务出错'
        itemKind = 'error'
        const detail = clip(event.data?.reason?.error?.message, 300)
        if (detail.length > 0) body.push('', `**错误**：${detail}`)
      } else if (isAbort) {
        head = '### ⏹ DSH 任务已中断'
        title = 'DSH 任务已中断'
        itemKind = 'aborted'
      } else {
        head = '### ✅ DSH 任务完成'
        title = 'DSH 任务完成'
        itemKind = 'completed'
      }
      // 轮次结束是终态事件：不参与合并，直接按当前配置发出。
      deliver(
        {
          kind: itemKind,
          sessionId,
          title,
          head,
          session: sessionLines,
          body,
          tail: ''
        },
        1
      )
    } catch (cause) {
      logLine({ kind: 'error', detail: `session handler: ${String(cause)}` })
    }
  })
}

/** 供自检脚本复用的导出。 */
export { VERSION, API, maskWebhook, explainError }
