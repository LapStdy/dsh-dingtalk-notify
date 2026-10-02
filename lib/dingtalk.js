/**
 * dsh-dingtalk-notify — 钉钉自定义群机器人发送端 + 配置存储（v0.2）。
 *
 * 配置来源（按优先级合并，后者覆盖前者）：
 *   1. 内置默认值 DEFAULTS
 *   2. 配置文件 `<DSH_HOME>/dingtalk-notify/config.json`（唯一真相源，面板写的就是它）
 *   3. 插件条目 config（cordis.patch.yml 里的 config 键）
 *
 * 宿主每次发送都重新读文件，所以**面板保存或手改文件都即时生效，不需要重启**。
 *
 * 本模块只负责「配置 + 发送」两件事，不认识 cordis；设置面板的 HTTP 接口在 index.js。
 *
 * @module dsh-dingtalk-notify/dingtalk
 */

import { createHmac } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 可调默认值；与 config.json 的键一一对应。 */
export const DEFAULTS = {
  /** 总开关：false = 一条都不发。 */
  enabled: true,
  /** 钉钉机器人 Webhook 地址（含 access_token）。 */
  webhook: '',
  /** 加签密钥（形如 SECxxxx）。安全设置用「自定义关键词」时留空。 */
  secret: '',
  /** 通知详细度：`brief` 一句话提醒 / `detailed` 带上具体情况。 */
  detailLevel: 'detailed',
  /**
   * 门控模式（什么时候才发）：
   *   `always`     总是发
   *   `away`       没人盯着 DSH 页面时才发（在电脑前看着 = 不打扰）
   *   `mobileOnly` 只有手机端在线时才发
   */
  gating: 'away',
  /** 在线心跳有效期（秒）：超过这个时间没报到就算离线。 */
  presenceTtlSeconds: 300,
  /** 「AI 需要你选择」时通知。 */
  notifyOnQuestion: true,
  /** 「AI 需要你审批某个操作」时通知。 */
  notifyOnApproval: true,
  /** 一轮任务完成时通知。 */
  notifyOnTurnEnd: true,
  /** 一轮任务以失败告终时通知。 */
  notifyOnError: true,
  /** 一轮任务被中断（你按了停止 / 进程被杀）时通知。默认关，避免噪声。 */
  notifyOnAbort: false,
  /** 只通知「干活超过 N 秒」的轮次；0 = 每一轮都通知。 */
  minTurnSeconds: 5,
  /** 子任务（subagent）的轮次也通知。默认关，避免刷屏。 */
  includeSubagents: false,
  /** 需要 @ 的手机号列表。 */
  atMobiles: [],
  /** @ 所有人。 */
  atAll: false,
  /** 免打扰时段：开启后该时段内不发（可保留「出错仍通知」）。 */
  dndEnabled: false,
  /** 免打扰开始时刻 HH:MM。 */
  dndFrom: '23:30',
  /** 免打扰结束时刻 HH:MM（可跨零点）。 */
  dndTo: '07:30',
  /** 免打扰时段内，出错类通知照发。 */
  dndExceptErrors: true,
  /** 合并窗口（秒）：同一轮里连续的同类提醒合并成一条；0 = 不合并。 */
  mergeWindowSeconds: 3,
  /** 发送失败自动重试一次（网络抖动/钉钉偶发繁忙）。 */
  retryOnFail: true,
  /** 每分钟最多发几条（钉钉官方上限 20 条/分钟，留点余量）。 */
  maxMessagesPerMinute: 18
}

/** 首次运行时写出的配置模板（`_` 开头的键是给人看的注释，代码会忽略）。 */
const TEMPLATE = {
  _说明: '钉钉通知配置。改完保存即可，不需要重启 DSH；也可以在 DSH 的「设置 → 钉钉通知」里改。',
  _文档: '群设置 → 智能群助手 → 添加机器人 → 自定义（通过 Webhook 接入自定义服务）',
  _详细度: 'detailLevel: brief=只提醒一句 / detailed=带上问题、选项、用时等具体情况',
  _门控: 'gating: always=总是发 / away=没人盯着 DSH 页面时才发 / mobileOnly=只有手机端在线时才发',
  enabled: DEFAULTS.enabled,
  webhook: DEFAULTS.webhook,
  secret: DEFAULTS.secret,
  detailLevel: DEFAULTS.detailLevel,
  gating: DEFAULTS.gating,
  presenceTtlSeconds: DEFAULTS.presenceTtlSeconds,
  notifyOnQuestion: DEFAULTS.notifyOnQuestion,
  notifyOnApproval: DEFAULTS.notifyOnApproval,
  notifyOnTurnEnd: DEFAULTS.notifyOnTurnEnd,
  notifyOnError: DEFAULTS.notifyOnError,
  notifyOnAbort: DEFAULTS.notifyOnAbort,
  minTurnSeconds: DEFAULTS.minTurnSeconds,
  includeSubagents: DEFAULTS.includeSubagents,
  atMobiles: DEFAULTS.atMobiles,
  atAll: DEFAULTS.atAll,
  dndEnabled: DEFAULTS.dndEnabled,
  dndFrom: DEFAULTS.dndFrom,
  dndTo: DEFAULTS.dndTo,
  dndExceptErrors: DEFAULTS.dndExceptErrors,
  mergeWindowSeconds: DEFAULTS.mergeWindowSeconds,
  retryOnFail: DEFAULTS.retryOnFail,
  maxMessagesPerMinute: DEFAULTS.maxMessagesPerMinute
}

/** 运行期诊断日志的保留上限（字节），超出即截断重写。 */
const LOG_MAX_BYTES = 512 * 1024

/** 面板「发送历史」保留条数。 */
const HISTORY_LIMIT = 40

/** 布尔字段清单（用于配置归一化与面板校验）。 */
const BOOLEAN_KEYS = [
  'enabled',
  'notifyOnQuestion',
  'notifyOnApproval',
  'notifyOnTurnEnd',
  'notifyOnError',
  'notifyOnAbort',
  'includeSubagents',
  'atAll',
  'dndEnabled',
  'dndExceptErrors',
  'retryOnFail'
]

/** 数值字段清单：`[最小值, 最大值]`。 */
const NUMBER_KEYS = {
  presenceTtlSeconds: [60, 3600],
  minTurnSeconds: [0, 86_400],
  mergeWindowSeconds: [0, 30],
  maxMessagesPerMinute: [1, 20]
}

/** 本机 DSH 主目录。 */
function dshHome() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env.length > 0 ? env : join(homedir(), '.dsh')
}

/** 插件状态目录（配置与日志）。 */
export function stateDir() {
  return join(dshHome(), 'dingtalk-notify')
}

/** 配置文件绝对路径。 */
export function configPath() {
  return join(stateDir(), 'config.json')
}

/** 诊断日志绝对路径。 */
export function logPath() {
  return join(stateDir(), 'log.ndjson')
}

/**
 * 把 `HH:MM` 文本规整成合法时刻。
 * @param value - 任意值。
 * @param fallback - 不合法时的兜底值。
 * @returns `HH:MM`。
 */
function normalizeClock(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback
}

/**
 * 把任意值收敛成布尔。
 * @param value - 任意值。
 * @param fallback - 无法判断时的兜底值。
 * @returns 布尔值。
 */
function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/**
 * 把任意值收敛成区间内的数字。
 * @param value - 任意值。
 * @param range - `[最小值, 最大值]`。
 * @param fallback - 无法判断时的兜底值。
 * @returns 数字。
 */
function normalizeNumber(value, range, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(range[0], Math.min(range[1], num))
}

/**
 * 归一化一组配置（补默认值、收敛类型、丢弃未知键与 `_` 注释键）。
 * @param raw - 原始对象（可能缺失/脏）。
 * @returns 完整配置对象。
 */
function normalize(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULTS }
  for (const key of BOOLEAN_KEYS) {
    if (key in source && source[key] !== undefined && source[key] !== null) {
      out[key] = normalizeBoolean(source[key], DEFAULTS[key])
    }
  }
  for (const [key, range] of Object.entries(NUMBER_KEYS)) {
    if (key in source && source[key] !== undefined && source[key] !== null) {
      out[key] = normalizeNumber(source[key], range, DEFAULTS[key])
    }
  }
  if (typeof source.webhook === 'string') out.webhook = source.webhook.trim()
  if (typeof source.secret === 'string') out.secret = source.secret.trim()
  if (source.detailLevel === 'brief' || source.detailLevel === 'detailed') out.detailLevel = source.detailLevel
  if (source.gating === 'always' || source.gating === 'away' || source.gating === 'mobileOnly') out.gating = source.gating
  out.dndFrom = normalizeClock(source.dndFrom, DEFAULTS.dndFrom)
  out.dndTo = normalizeClock(source.dndTo, DEFAULTS.dndTo)
  if (Array.isArray(source.atMobiles)) {
    out.atMobiles = source.atMobiles
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 20)
  } else {
    out.atMobiles = []
  }
  return out
}

/**
 * 读取并合并配置。
 * @param overrides - 插件条目里声明的 config（可缺省）。
 * @returns 完整配置对象；读取失败时退回默认值并附 `_error`。
 */
export function loadConfig(overrides) {
  let fromFile = {}
  let error
  const file = configPath()
  try {
    if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    error = `配置文件无法解析：${cause instanceof Error ? cause.message : String(cause)}`
  }
  // 只有「显式给出且有内容」的 overrides 键参与覆盖：否则 normalize(overrides)
  // 会把补出来的默认值也当成用户设置，反过来盖掉文件里的值。
  const patch = {}
  if (overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key.startsWith('_')) continue
      if (value === undefined || value === null) continue
      if (!(key in DEFAULTS)) continue
      patch[key] = value
    }
  }
  const merged = normalize({ ...normalize(fromFile), ...patch })
  if (error !== undefined) merged._error = error
  return merged
}

/**
 * 首次运行时落一份带注释的配置模板。
 * @returns `true` 表示本次新建了文件。
 */
export function ensureConfigFile() {
  const file = configPath()
  if (existsSync(file)) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(TEMPLATE, null, 2)}\n`, 'utf8')
  return true
}

/**
 * 校验一份来自面板的部分配置。
 * @param patch - 形如 `{ key: value }`；`null` 表示删除该键（用于清除 webhook/secret）。
 * @returns `{ values }` 或 `{ error }`（error 是人话）。
 */
export function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { error: '请求体必须是对象' }
  const values = {}
  for (const [key, raw] of Object.entries(patch)) {
    if (key.startsWith('_')) continue
    if (!(key in DEFAULTS)) return { error: `未知配置项：${key}` }
    if (raw === null) {
      values[key] = null
      continue
    }
    if (BOOLEAN_KEYS.includes(key)) {
      values[key] = normalizeBoolean(raw, DEFAULTS[key])
      continue
    }
    if (key in NUMBER_KEYS) {
      const num = Number(raw)
      if (!Number.isFinite(num)) return { error: `${key} 必须是数字` }
      const range = NUMBER_KEYS[key]
      if (num < range[0] || num > range[1]) return { error: `${key} 需在 ${range[0]}~${range[1]} 之间` }
      values[key] = num
      continue
    }
    if (key === 'webhook') {
      const text = String(raw).trim()
      if (text.length === 0) return { error: 'Webhook 地址不能为空（要清除请点「清除」）' }
      if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]+/i.test(text)) {
        return { error: 'Webhook 地址不对：应以 https://oapi.dingtalk.com/robot/send?access_token= 开头' }
      }
      values[key] = text
      continue
    }
    if (key === 'secret') {
      const text = String(raw).trim()
      if (text.length === 0) return { error: '加签密钥不能为空（要清除请点「清除」；不用加签请留空不填）' }
      if (!/^SEC[A-Za-z0-9]+$/.test(text)) return { error: '加签密钥应以 SEC 开头（钉钉机器人「加签」里的那串）' }
      values[key] = text
      continue
    }
    if (key === 'detailLevel') {
      if (raw !== 'brief' && raw !== 'detailed') return { error: '详细度只能是 brief 或 detailed' }
      values[key] = raw
      continue
    }
    if (key === 'gating') {
      if (raw !== 'always' && raw !== 'away' && raw !== 'mobileOnly') return { error: '门控模式不合法' }
      values[key] = raw
      continue
    }
    if (key === 'dndFrom' || key === 'dndTo') {
      const text = String(raw).trim()
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return { error: `${key} 需形如 23:30` }
      values[key] = text
      continue
    }
    if (key === 'atMobiles') {
      const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,，、;；]+/)
      const cleaned = list
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
      for (const item of cleaned) {
        if (!/^1\d{10}$/.test(item)) return { error: `手机号格式不对：${item}` }
      }
      values[key] = cleaned.slice(0, 20)
      continue
    }
  }
  return { values }
}

/**
 * 写入配置（原子写：先写 .tmp 再改名；覆盖前留一份 .bak）。
 * @param patch - 部分配置；`null` 值表示删除该键。
 * @returns `{ ok: true, config }` 或 `{ ok: false, error }`。
 */
export function writeConfig(patch) {
  const checked = validatePatch(patch)
  if (checked.error !== undefined) return { ok: false, error: checked.error }
  const file = configPath()
  let current = {}
  try {
    if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    current = {}
  }
  const next = {}
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith('_') || key in DEFAULTS) next[key] = value
  }
  for (const [key, value] of Object.entries(checked.values)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        copyFileSync(file, `${file}.bak`)
      } catch {
        /* 备份失败不阻塞写入 */
      }
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (cause) {
    return { ok: false, error: `写配置文件失败：${cause instanceof Error ? cause.message : String(cause)}` }
  }
  return { ok: true, config: loadConfig(undefined) }
}

/**
 * 追加一行诊断日志（JSON Lines）；超过上限时截断重写。
 * @param entry - 任意可序列化对象。
 */
export function logLine(entry) {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0)
    } catch {
      /* 文件不存在：appendFileSync 会创建 */
    }
    appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* 诊断日志失败绝不影响通知链路 */
  }
}

// ── 面板用的发送历史（内存态，重启即清空）────────────────────────────────

/** @type {Array<object>} 最近若干条发送决策，新的在前。 */
const history = []

/**
 * 记一条发送决策。
 * @param entry - `{ kind, outcome, reason?, title?, detail?, ms? }`。
 */
export function pushHistory(entry) {
  history.unshift({ time: new Date().toISOString(), ...entry })
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
}

/**
 * 读取发送历史。
 * @param limit - 最多返回几条。
 * @returns 历史数组副本。
 */
export function getHistory(limit = 20) {
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(HISTORY_LIMIT, Number(limit))) : 20
  return history.slice(0, max)
}

/** 清空发送历史。 */
export function clearHistory() {
  history.length = 0
}

// ── 密钥脱敏 ─────────────────────────────────────────────────────────────

/**
 * 把 Webhook 变成可安全回传浏览器的样子（保留来源，隐藏 token）。
 * @param webhook - 原始地址。
 * @returns 形如 `https://oapi.dingtalk.com/robot/send?access_token=…f3a2` 的掩码串。
 */
export function maskWebhook(webhook) {
  const value = typeof webhook === 'string' ? webhook.trim() : ''
  if (value.length === 0) return ''
  const tail = value.slice(-4)
  const head = value.split('?')[0]
  return `${head}?access_token=…${tail}`
}

/**
 * 加签密钥的对外描述（永不回传密钥本身）。
 * @param secret - 原始密钥。
 * @returns `{ set, tail, length }`。
 */
export function secretInfo(secret) {
  const value = typeof secret === 'string' ? secret.trim() : ''
  return { set: value.length > 0, tail: value.length >= 4 ? value.slice(-4) : '', length: value.length }
}

/**
 * 生成回传浏览器的脱敏配置。
 * @param config - 完整配置对象。
 * @returns 面板可用的配置视图。
 */
export function publicConfig(config) {
  const info = secretInfo(config.secret)
  return {
    enabled: config.enabled,
    webhookMasked: maskWebhook(config.webhook),
    webhookSet: typeof config.webhook === 'string' && config.webhook.trim().length > 0,
    secretSet: info.set,
    secretTail: info.tail,
    detailLevel: config.detailLevel,
    gating: config.gating,
    presenceTtlSeconds: config.presenceTtlSeconds,
    notifyOnQuestion: config.notifyOnQuestion,
    notifyOnApproval: config.notifyOnApproval,
    notifyOnTurnEnd: config.notifyOnTurnEnd,
    notifyOnError: config.notifyOnError,
    notifyOnAbort: config.notifyOnAbort,
    minTurnSeconds: config.minTurnSeconds,
    includeSubagents: config.includeSubagents,
    atMobiles: config.atMobiles,
    atAll: config.atAll,
    dndEnabled: config.dndEnabled,
    dndFrom: config.dndFrom,
    dndTo: config.dndTo,
    dndExceptErrors: config.dndExceptErrors,
    mergeWindowSeconds: config.mergeWindowSeconds,
    retryOnFail: config.retryOnFail,
    maxMessagesPerMinute: config.maxMessagesPerMinute,
    configPath: configPath(),
    error: typeof config._error === 'string' ? config._error : ''
  }
}

// ── 门控与免打扰的时间判断 ────────────────────────────────────────────────

/**
 * 判断当前时刻是否落在免打扰区间内（支持跨零点，如 23:30 → 07:30）。
 * @param config - 完整配置对象。
 * @param now - 当前时间戳。
 * @returns `true` 表示应当静默。
 */
export function inDndWindow(config, now = Date.now()) {
  if (config.dndEnabled !== true) return false
  const toMinutes = (text) => {
    const [hour, minute] = String(text).split(':')
    return Number(hour) * 60 + Number(minute)
  }
  const date = new Date(now)
  const current = date.getHours() * 60 + date.getMinutes()
  const from = toMinutes(config.dndFrom)
  const to = toMinutes(config.dndTo)
  if (from === to) return false
  return from < to ? current >= from && current < to : current >= from || current < to
}

// ── 发送 ────────────────────────────────────────────────────────────────

/**
 * 追加加签参数。
 * @param webhook - 原始 Webhook 地址。
 * @param secret - 加签密钥；空串表示使用「自定义关键词」模式。
 * @returns 可直接 POST 的地址。
 */
export function signUrl(webhook, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return webhook
  const timestamp = Date.now()
  const stringToSign = `${timestamp}\n${secret}`
  const sign = encodeURIComponent(createHmac('sha256', secret).update(stringToSign).digest('base64'))
  const separator = webhook.includes('?') ? '&' : '?'
  return `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`
}

/** 滑窗限流器：钉钉机器人 20 条/分钟，超限会被拒。 */
const recentSends = []

/** 被钉钉限流后的冷却截止时刻（ms）。 */
let cooldownUntil = 0

/**
 * 判断当前是否还能再发一条。
 * @param perMinute - 每分钟上限。
 * @returns `{ ok, reason? }`。
 */
function allowSend(perMinute) {
  const now = Date.now()
  if (now < cooldownUntil) {
    return { ok: false, reason: `cooldown-${Math.ceil((cooldownUntil - now) / 1000)}s` }
  }
  while (recentSends.length > 0 && now - recentSends[0] > 60_000) recentSends.shift()
  if (recentSends.length >= perMinute) return { ok: false, reason: 'rate-limited' }
  recentSends.push(now)
  return { ok: true }
}

/**
 * 把钉钉 errcode 翻译成人话。
 * @param code - errcode。
 * @param message - errmsg。
 * @returns 中文解释。
 */
export function explainError(code, message) {
  const text = typeof message === 'string' ? message : ''
  const table = {
    300001: '机器人 token 无效或已被删除——重新复制 Webhook 地址',
    310000: '关键词或加签不匹配——检查「加签密钥」是否与机器人安全设置一致；用「自定义关键词」模式时消息里必须含关键词（本插件默认带 DSH）',
    410100: '发送太频繁——钉钉限制每分钟 20 条，插件会冷却 60 秒',
    '-1': '钉钉系统繁忙，稍后自动重试'
  }
  const human = table[String(code)]
  return human !== undefined ? human : `钉钉返回错误（errcode=${code}${text.length > 0 ? ` errmsg=${text}` : ''}）`
}

/** 等一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发送一条 markdown 消息到钉钉群（必要时自动重试一次）。
 * @param config - 完整配置对象。
 * @param message - `{ title, text }`；title 是通知横幅，text 是 markdown 正文。
 * @returns 发送结果：`{ ok, skipped?, error?, errcode?, ms?, attempts? }`——本函数**不抛异常**。
 */
export async function sendDingtalk(config, message) {
  const { title, text } = message
  if (config.enabled === false) return { ok: false, skipped: 'disabled' }
  const webhook = typeof config.webhook === 'string' ? config.webhook.trim() : ''
  if (webhook.length === 0) {
    logLine({ kind: 'skip', reason: 'webhook-empty', title, configPath: configPath() })
    return { ok: false, skipped: 'webhook-empty' }
  }
  const gate = allowSend(config.maxMessagesPerMinute)
  if (!gate.ok) {
    logLine({ kind: 'skip', reason: gate.reason, title })
    return { ok: false, skipped: gate.reason }
  }
  const payload = {
    msgtype: 'markdown',
    markdown: { title, text },
    at: { atMobiles: config.atMobiles, isAtAll: config.atAll === true }
  }
  const attempts = config.retryOnFail === true ? 2 : 1
  const started = Date.now()
  let last = { ok: false, error: '未发送' }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(signUrl(webhook, config.secret), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const body = await response.text()
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && parsed.errcode === 0) {
        const result = { ok: true, ms: Date.now() - started, attempts: attempt }
        logLine({ kind: 'sent', title, ms: result.ms, attempt })
        return result
      }
      const code = parsed === undefined ? undefined : parsed.errcode
      const detail = parsed === undefined ? body.slice(0, 300) : `errcode=${code} errmsg=${parsed.errmsg}`
      last = { ok: false, error: explainError(code, parsed === undefined ? body.slice(0, 100) : parsed.errmsg), raw: detail, errcode: code }
      logLine({ kind: 'error', http: response.status, detail, title, attempt })
      // 被限流：立刻进入冷却，重试也没用。
      if (String(code) === '410100') {
        cooldownUntil = Date.now() + 60_000
        break
      }
    } catch (cause) {
      // Node 的 fetch 只抛一句 "fetch failed"，真正的原因（ECONNREFUSED / ENOTFOUND /
      // 证书错误 / 超时）藏在 cause.cause 里 —— 一并记下，否则事后无从判断。
      const root = cause && cause.cause ? cause.cause.code || cause.cause.message || '' : ''
      const detail = (cause instanceof Error ? cause.message : String(cause)) + (root ? ` (${root})` : '')
      last = { ok: false, error: `网络请求失败：${detail}` }
      logLine({ kind: 'error', detail, title, attempt })
    }
    if (attempt < attempts) await sleep(1500)
  }
  return { ...last, ms: Date.now() - started, attempts }
}
