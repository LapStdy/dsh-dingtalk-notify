// dsh-dingtalk-notify — 浏览器半区（设置面板 + 设备心跳）。
//
// 由 dsh-client-modules 从 /plugins/dingtalk-notify/client.js 加载，走宿主内置的
// lazy-CJS 模块表（window.__ModuleLoader__.load）；工厂体是普通 CJS，require 由壳的
// 模块表解析（react 来自壳自身的实例）。这里不依赖构建工具、不用 JSX、不用 TS。
//
// 它做两件事：
//   1. 往「设置 → 钉钉通知」注册一整页面板（settings.section 槽位），面板读写的都是
//      宿主接口 /api/dsh-dingtalk-notify/*（配置只读回显掩码；密钥永不回传浏览器）。
//   2. 每 45 秒（以及页面可见性/焦点变化时）向宿主报一次「这台设备还开着 DSH」，
//      宿主的门控据此决定要不要发钉钉。心跳不携带任何配置，也不返回任何数据。
//
// 手机上（经 dsh-pocket）同样会加载本文件：设备类型靠 UA/触屏判定，面板里可手动纠正。

window.__ModuleLoader__.load({
  id: 'dsh-dingtalk-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = null
    try { React = require('react') || null } catch (e) { React = null }

    // ── 常量 ──────────────────────────────────────────────────────────
    var API = {
      config: '/api/dsh-dingtalk-notify/config',
      test: '/api/dsh-dingtalk-notify/test',
      presence: '/api/dsh-dingtalk-notify/presence',
      status: '/api/dsh-dingtalk-notify/status',
      log: '/api/dsh-dingtalk-notify/log'
    }
    var LS_CLIENT = 'dshDingtalk.clientId'
    var LS_DEVICE = 'dshDingtalk.device'
    var HEARTBEAT_MS = 45000
    var NS = 'dtn'

    /** 面板可编辑的字段 → 服务端配置键。 */
    var NUM_KEYS = ['presenceTtlSeconds', 'minTurnSeconds', 'mergeWindowSeconds', 'maxMessagesPerMinute']
    var BOOL_KEYS = [
      'enabled', 'notifyOnQuestion', 'notifyOnApproval', 'notifyOnTurnEnd', 'notifyOnError',
      'notifyOnAbort', 'includeSubagents', 'atAll', 'dndEnabled', 'dndExceptErrors', 'retryOnFail'
    ]
    var TEXT_KEYS = ['detailLevel', 'gating', 'dndFrom', 'dndTo']
    var ALL_KEYS = NUM_KEYS.concat(BOOL_KEYS, TEXT_KEYS, ['atMobiles'])

    var KIND_LABEL = {
      question: '需要选择',
      approval: '需要审批',
      completed: '任务完成',
      error: '任务出错',
      aborted: '已中断',
      test: '自检'
    }
    var OUTCOME_LABEL = { sent: '已发送', skip: '已跳过', error: '发送失败' }
    var SKIP_LABEL = {
      disabled: '插件已停用',
      'webhook-empty': '没填 Webhook',
      'no-mobile-online': '手机端不在线',
      'page-attended': '有人正看着 DSH 页面',
      dnd: '免打扰时段',
      'rate-limited': '超过每分钟上限',
      'cooldown-60s': '被钉钉限流，冷却中'
    }

    // ── 小工具 ────────────────────────────────────────────────────────
    /** React.createElement 的短名（只有真正渲染时才调用）。 */
    function h() { return React.createElement.apply(null, arguments) }

    function isValidElementShim() { return !!(React && React.createElement) }

    function cls() {
      var out = []
      for (var i = 0; i < arguments.length; i += 1) if (arguments[i]) out.push(arguments[i])
      return out.join(' ')
    }

    /** 同源 JSON 请求。 */
    function request(path, options) {
      return fetch(path, {
        method: options && options.method ? options.method : 'GET',
        headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store'
      }).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (data) {
          if (!response.ok && !data.error) data.error = 'HTTP ' + response.status
          return data
        })
      })
    }

    function fmtTime(value) {
      try { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) } catch (e) { return String(value) }
    }

    function fmtAgo(ms) {
      var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return seconds + ' 秒前'
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      return Math.round(minutes / 60) + ' 小时前'
    }

    function stored(key) {
      try { return localStorage.getItem(key) || '' } catch (e) { return '' }
    }

    function store(key, value) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch (e) { /* 隐私模式 */ }
    }

    function clientId() {
      var id = stored(LS_CLIENT)
      if (!id) {
        id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
        store(LS_CLIENT, id)
      }
      return id
    }

    /** 读设备类型（含用户手动纠正）。 */
    function detectDevice() {
      var override = stored(LS_DEVICE)
      if (override === 'mobile' || override === 'desktop') return override
      var ua = ''
      try { ua = navigator.userAgent || '' } catch (e) { ua = '' }
      if (/Android|iPhone|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return 'mobile'
      var touch = 0
      try { touch = navigator.maxTouchPoints || 0 } catch (e) { touch = 0 }
      if (/iPad|Macintosh/.test(ua) && touch > 1) return 'mobile'
      try {
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
          if (Math.min(screen.width, screen.height) <= 820) return 'mobile'
        }
      } catch (e) { /* 忽略 */ }
      return 'desktop'
    }

    // ── 心跳 ──────────────────────────────────────────────────────────
    /**
     * 向宿主报一次到：谁在线、是不是手机、页面是否可见/聚焦。
     * @param gone - true 表示这台设备要走了（关页面），宿主立刻摘掉它。
     */
    function reportPresence(gone) {
      var payload = {
        clientId: clientId(),
        device: detectDevice(),
        visible: true,
        focused: true,
        gone: !!gone
      }
      try {
        payload.visible = !document.hidden
        payload.focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
        payload.ua = String(navigator.userAgent || '').slice(0, 120)
      } catch (e) { /* 忽略 */ }
      var text = JSON.stringify(payload)
      try {
        if (gone && navigator.sendBeacon) {
          navigator.sendBeacon(API.presence, new Blob([text], { type: 'application/json' }))
          return
        }
      } catch (e) { /* 退回 fetch */ }
      try {
        fetch(API.presence, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text,
          credentials: 'same-origin',
          keepalive: !!gone
        }).catch(function () { /* 心跳失败无需打扰用户 */ })
      } catch (e) { /* 忽略 */ }
    }

    // ── 样式 ──────────────────────────────────────────────────────────
    var CSS = [
      '.dtn-wrap{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9))}',
      '.dtn-status{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.dtn-pill{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:999px;padding:2px 9px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(80,80,80,.9))}',
      '.dtn-pill.ok{border-color:var(--dsw-alias-state-success-primary,#16a34a);color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dtn-pill.warn{border-color:var(--dsw-alias-state-warning-primary,#d97706);color:var(--dsw-alias-state-warning-primary,#d97706)}',
      '.dtn-pill.muted{color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}',
      '.dtn-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.05));border-radius:10px;overflow:hidden}',
      '.dtn-cardHead{padding:10px 14px;font-size:13px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}',
      '.dtn-row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;flex-wrap:wrap}',
      '.dtn-row+.dtn-row{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28))}',
      '.dtn-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 200px}',
      '.dtn-label{font-size:13px;font-weight:600;line-height:20px}',
      '.dtn-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9));word-break:break-word}',
      '.dtn-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.dtn-input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));border-radius:8px;padding:5px 8px;font-size:13px;font-family:inherit;min-width:0}',
      '.dtn-input.wide{width:min(360px,60vw)}',
      '.dtn-input.small{width:88px}',
      '.dtn-switch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.2));cursor:pointer;padding:0;transition:background .15s ease}',
      '.dtn-switch.on{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent}',
      '.dtn-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease}',
      '.dtn-switch.on::after{transform:translateX(14px)}',
      '.dtn-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.dtn-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1))}',
      '.dtn-btn:disabled{opacity:.5;cursor:default}',
      '.dtn-btn.primary{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff}',
      '.dtn-seg{display:flex;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:8px;overflow:hidden}',
      '.dtn-segBtn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,rgba(80,80,80,.9));padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.dtn-segBtn+.dtn-segBtn{border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4))}',
      '.dtn-segBtn.on{background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff}',
      '.dtn-preview{margin:0 14px 12px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,rgba(80,80,80,.95))}',
      '.dtn-list{margin:0;padding:0;list-style:none}',
      '.dtn-item{display:flex;gap:10px;align-items:baseline;justify-content:space-between;padding:7px 14px;font-size:12px;line-height:18px}',
      '.dtn-item+.dtn-item{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}',
      '.dtn-itemMain{display:flex;gap:8px;align-items:baseline;min-width:0;flex:1 1 auto}',
      '.dtn-itemTime{color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9));flex:none}',
      '.dtn-itemDetail{color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9));word-break:break-all}',
      '.dtn-empty{padding:10px 14px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}',
      '.dtn-bar{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;background:var(--dsw-alias-bg-base,transparent)}',
      '.dtn-msg{font-size:12px;line-height:18px}',
      '.dtn-msg.ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dtn-msg.err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dtn-msg.info{color:var(--dsw-alias-label-tertiary,rgba(120,120,120,.9))}'
    ].join('')

    /** 注入一次样式表；随插件卸载移除。 */
    function injectStyle(ctx) {
      try {
        if (typeof document === 'undefined') return
        var el = document.createElement('style')
        el.setAttribute('data-dsh-dingtalk-notify', '1')
        el.textContent = CSS
        ;(document.head || document.documentElement).appendChild(el)
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () { try { el.remove() } catch (e) { /* 忽略 */ } }
          })
        }
      } catch (e) { /* 样式失败不影响功能 */ }
    }

    // ── 通用控件 ──────────────────────────────────────────────────────
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: cls('dtn-switch', props.checked && 'on'),
        'aria-pressed': props.checked ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: function () { if (props.disabled !== true) props.onChange(!props.checked) }
      })
    }

    function Row(props) {
      return h('div', { className: 'dtn-row' },
        h('div', { className: 'dtn-rowText' },
          h('div', { className: 'dtn-label' }, props.label),
          props.hint ? h('div', { className: 'dtn-hint' }, props.hint) : null),
        h('div', { className: 'dtn-ctl' }, props.children))
    }

    function Card(props) {
      return h('div', { className: 'dtn-card' },
        props.title ? h('div', { className: 'dtn-cardHead' }, props.title) : null,
        props.children)
    }

    function Segmented(props) {
      return h('div', { className: 'dtn-seg' }, props.options.map(function (option) {
        return h('button', {
          key: option.value,
          type: 'button',
          className: cls('dtn-segBtn', props.value === option.value && 'on'),
          onClick: function () { props.onChange(option.value) }
        }, option.label)
      }))
    }

    /** 面板预览：模拟宿主按当前详细度渲染出来的钉钉消息。 */
    function previewMarkdown(level) {
      if (level === 'brief') {
        return [
          '### 🔔 DSH 需要你选择',
          '',
          '**会话**：钉钉通知插件优化',
          '',
          '请回到 DSH 页面作答（钉钉机器人只能单向通知，不能替你点选）。'
        ].join('\n')
      }
      return [
        '### 🔔 DSH 需要你选择',
        '',
        '**会话**：钉钉通知插件优化',
        '**工作区**：demo-project',
        '',
        '**导出格式：选哪种？**',
        '',
        '- **xlsx** — 双击就能打开',
        '- **csv** — 纯文本、体积小',
        '',
        '请回到 DSH 页面作答（钉钉机器人只能单向通知，不能替你点选）。'
      ].join('\n')
    }

    // ── 设置面板 ──────────────────────────────────────────────────────
    /** 把服务端配置转成面板草稿（数字用字符串，便于编辑中途为空）。 */
    function toDraft(config) {
      var draft = {}
      NUM_KEYS.forEach(function (key) { draft[key] = String(config[key]) })
      BOOL_KEYS.forEach(function (key) { draft[key] = config[key] === true })
      TEXT_KEYS.forEach(function (key) { draft[key] = String(config[key]) })
      draft.atMobiles = (config.atMobiles || []).join(', ')
      return draft
    }

    /** 草稿与服务端配置是否一致。 */
    function draftDirty(draft, config) {
      for (var i = 0; i < ALL_KEYS.length; i += 1) {
        var key = ALL_KEYS[i]
        if (NUM_KEYS.indexOf(key) >= 0) {
          if (Number(draft[key]) !== Number(config[key])) return true
        } else if (BOOL_KEYS.indexOf(key) >= 0) {
          if (draft[key] !== (config[key] === true)) return true
        } else if (key === 'atMobiles') {
          if (normalizeMobiles(draft[key]).join(',') !== (config.atMobiles || []).join(',')) return true
        } else if (String(draft[key]) !== String(config[key])) return true
      }
      return false
    }

    function normalizeMobiles(text) {
      return String(text || '').split(/[\s,，、;；]+/).map(function (item) { return item.trim() }).filter(Boolean)
    }

    function buildPatch(draft, config, clearWebhook, clearSecret, webhookInput, secretInput) {
      var patch = {}
      ALL_KEYS.forEach(function (key) {
        if (NUM_KEYS.indexOf(key) >= 0) {
          if (Number(draft[key]) !== Number(config[key])) patch[key] = Number(draft[key])
        } else if (BOOL_KEYS.indexOf(key) >= 0) {
          if (draft[key] !== (config[key] === true)) patch[key] = draft[key]
        } else if (key === 'atMobiles') {
          var list = normalizeMobiles(draft[key])
          if (list.join(',') !== (config.atMobiles || []).join(',')) patch[key] = list
        } else if (String(draft[key]) !== String(config[key])) {
          patch[key] = draft[key]
        }
      })
      if (clearWebhook) patch.webhook = null
      else if (webhookInput.trim()) patch.webhook = webhookInput.trim()
      if (clearSecret) patch.secret = null
      else if (secretInput.trim()) patch.secret = secretInput.trim()
      return patch
    }

    /**
     * 「设置 → 钉钉通知」整页面板。
     * @param props - `{ ctx }`。
     */
    function DingtalkSettings(props) {
      var useState = React.useState
      var useEffect = React.useEffect
      var stateConfig = useState(null)
      var stateStatus = useState(null)
      var stateDraft = useState(null)
      var stateWebhook = useState('')
      var stateSecret = useState('')
      var stateClearWebhook = useState(false)
      var stateClearSecret = useState(false)
      var stateBusy = useState(false)
      var stateMessage = useState(null)
      var stateTest = useState(null)
      var stateDevice = useState(stored(LS_DEVICE))
      var stateTick = useState(0)

      var config = stateConfig[0]
      var status = stateStatus[0]
      var draft = stateDraft[0]
      var setConfig = stateConfig[1]
      var setStatus = stateStatus[1]
      var setDraft = stateDraft[1]
      var webhookInput = stateWebhook[0]
      var setWebhookInput = stateWebhook[1]
      var secretInput = stateSecret[0]
      var setSecretInput = stateSecret[1]
      var clearWebhook = stateClearWebhook[0]
      var setClearWebhook = stateClearWebhook[1]
      var clearSecret = stateClearSecret[0]
      var setClearSecret = stateClearSecret[1]
      var busy = stateBusy[0]
      var setBusy = stateBusy[1]
      var message = stateMessage[0]
      var setMessage = stateMessage[1]
      var testResult = stateTest[0]
      var setTestResult = stateTest[1]
      var deviceOverride = stateDevice[0]
      var setDeviceOverride = stateDevice[1]
      var setTick = stateTick[1]

      // 拉状态 + 每 5 秒刷新（面板关掉后定时器随组件卸载一起清掉）。
      useEffect(function () {
        var alive = true
        function load() {
          request(API.status).then(function (data) {
            if (!alive || !data || data.ok !== true) return
            setStatus(data)
            setConfig(data.config)
            setDraft(function (prev) { return prev === null ? toDraft(data.config) : prev })
          }).catch(function () { /* 静默重试 */ })
        }
        load()
        var timer = setInterval(load, 5000)
        return function () { alive = false; clearInterval(timer) }
      }, [])

      // 本地每秒刷新「x 分钟前」，不然时间会停在打开那一刻。
      useEffect(function () {
        var timer = setInterval(function () { setTick(function (n) { return n + 1 }) }, 30000)
        return function () { clearInterval(timer) }
      }, [])

      if (!config || !draft) {
        return h('div', { className: 'dtn-wrap' }, h('div', { className: 'dtn-empty' }, '正在读取钉钉通知配置…'))
      }

      function patchDraft(key, value) {
        setDraft(function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      var dirty = draftDirty(draft, config) || clearWebhook || clearSecret
        || webhookInput.trim().length > 0 || secretInput.trim().length > 0

      function save() {
        var patch = buildPatch(draft, config, clearWebhook, clearSecret, webhookInput, secretInput)
        if (Object.keys(patch).length === 0) {
          setMessage({ kind: 'info', text: '没有需要保存的改动。' })
          return
        }
        setBusy(true)
        setMessage({ kind: 'info', text: '正在保存…' })
        request(API.config, { method: 'POST', body: { patch: patch } }).then(function (data) {
          setBusy(false)
          if (data.ok !== true) {
            setMessage({ kind: 'err', text: data.error || '保存失败' })
            return
          }
          setConfig(data.config)
          setDraft(toDraft(data.config))
          setWebhookInput('')
          setSecretInput('')
          setClearWebhook(false)
          setClearSecret(false)
          setMessage({ kind: 'ok', text: '已保存，立即生效（不用重启 DSH）。' })
        }).catch(function (cause) {
          setBusy(false)
          setMessage({ kind: 'err', text: '保存失败：' + String(cause && cause.message ? cause.message : cause) })
        })
      }

      function discard() {
        setDraft(toDraft(config))
        setWebhookInput('')
        setSecretInput('')
        setClearWebhook(false)
        setClearSecret(false)
        setMessage({ kind: 'info', text: '已放弃未保存的改动。' })
      }

      function runTest() {
        setBusy(true)
        setTestResult({ kind: 'info', text: '正在发送…' })
        var body = {}
        if (clearWebhook) body.webhook = null
        else if (webhookInput.trim()) body.webhook = webhookInput.trim()
        if (clearSecret) body.secret = null
        else if (secretInput.trim()) body.secret = secretInput.trim()
        request(API.test, { method: 'POST', body: body }).then(function (data) {
          setBusy(false)
          if (data.ok === true) setTestResult({ kind: 'ok', text: '已送达 ✅（' + data.ms + ' 毫秒）——去钉钉群里看看。' })
          else setTestResult({ kind: 'err', text: '失败：' + (data.error || '未知原因') })
        }).catch(function (cause) {
          setBusy(false)
          setTestResult({ kind: 'err', text: '请求失败：' + String(cause && cause.message ? cause.message : cause) })
        })
      }

      function chooseDevice(value) {
        setDeviceOverride(value)
        store(LS_DEVICE, value || null)
        reportPresence(false)
      }

      // 状态条
      var readyPill = config.enabled === false
        ? h('span', { className: 'dtn-pill warn' }, '已停用')
        : config.webhookSet
          ? h('span', { className: 'dtn-pill ok' }, '已就绪')
          : h('span', { className: 'dtn-pill warn' }, '还没填 Webhook')
      var lastEntry = status && status.history && status.history.length > 0 ? status.history[0] : null
      var gateLabel = status && status.gate ? status.gate.label : ''
      var clients = (status && status.presence) || []

      var statusBar = h('div', { className: 'dtn-status' },
        readyPill,
        h('span', { className: 'dtn-pill muted' }, '详细度：' + (draft.detailLevel === 'brief' ? '简洁' : '详细')),
        h('span', { className: 'dtn-pill muted' }, '门控：' + gateLabel),
        status && status.dnd ? h('span', { className: 'dtn-pill warn' }, '免打扰时段中') : null,
        lastEntry
          ? h('span', { className: 'dtn-pill muted' },
              '上次：' + fmtTime(lastEntry.time) + ' ' + (KIND_LABEL[lastEntry.kind] || lastEntry.kind) + ' · ' + (OUTCOME_LABEL[lastEntry.outcome] || lastEntry.outcome))
          : h('span', { className: 'dtn-pill muted' }, '还没有发送记录'))

      // ① 连接
      var connectionCard = h(Card, { title: '连接（钉钉机器人）' },
        h(Row, {
          label: 'Webhook 地址',
          hint: config.webhookSet
            ? '已保存：' + config.webhookMasked + (clearWebhook ? '（待清除）' : '') + '　留空即不修改'
            : '群设置 → 智能群助手 → 添加机器人 → 自定义（Webhook 接入）'
        },
          h('input', {
            className: 'dtn-input wide',
            type: 'text',
            value: webhookInput,
            placeholder: config.webhookSet ? '输入新地址可替换' : 'https://oapi.dingtalk.com/robot/send?access_token=...',
            spellCheck: false,
            onChange: function (e) { setWebhookInput(e.currentTarget.value) }
          }),
          config.webhookSet
            ? h('button', {
                type: 'button',
                className: 'dtn-btn',
                onClick: function () { setClearWebhook(!clearWebhook) }
              }, clearWebhook ? '撤销清除' : '清除')
            : null),
        h(Row, {
          label: '加签密钥',
          hint: config.secretSet
            ? '已配置（末 4 位 …' + config.secretTail + '）' + (clearSecret ? '（待清除）' : '') + '　密钥不会回传到浏览器'
            : '机器人安全设置选「加签」时填 SEC 开头那串；用「自定义关键词」则留空'
        },
          h('input', {
            className: 'dtn-input wide',
            type: 'password',
            value: secretInput,
            placeholder: config.secretSet ? '输入新密钥可替换' : 'SECxxxxxxxx',
            autoComplete: 'new-password',
            onChange: function (e) { setSecretInput(e.currentTarget.value) }
          }),
          config.secretSet
            ? h('button', {
                type: 'button',
                className: 'dtn-btn',
                onClick: function () { setClearSecret(!clearSecret) }
              }, clearSecret ? '撤销清除' : '清除')
            : null),
        h(Row, { label: '测试发送', hint: '用上面填的内容立刻发一条到群里（不保存也能试）' },
          h('button', { type: 'button', className: 'dtn-btn primary', disabled: busy, onClick: runTest }, '发送测试消息'),
          testResult
            ? h('span', { className: 'dtn-msg ' + (testResult.kind === 'ok' ? 'ok' : testResult.kind === 'err' ? 'err' : 'info') }, testResult.text)
            : null))

      // ② 通知内容
      var detailCard = h(Card, { title: '通知内容' },
        h(Row, {
          label: '详细度',
          hint: draft.detailLevel === 'brief'
            ? '简洁：只说「有事找你」+ 会话名，一眼扫完'
            : '详细：带上问题正文、选项、工具名、用时、回复摘要'
        },
          h(Segmented, {
            value: draft.detailLevel,
            onChange: function (value) { patchDraft('detailLevel', value) },
            options: [{ value: 'brief', label: '简洁' }, { value: 'detailed', label: '详细' }]
          })),
        h('pre', { className: 'dtn-preview' }, previewMarkdown(draft.detailLevel)))

      // ③ 触发时机
      function triggerRow(label, hint, key) {
        return h(Row, { label: label, hint: hint },
          h(Switch, { checked: draft[key], onChange: function (value) { patchDraft(key, value) } }))
      }
      var triggerCard = h(Card, { title: '什么时候提醒我' },
        triggerRow('需要我选择', 'AI 提问 / 计划待确认', 'notifyOnQuestion'),
        triggerRow('需要我审批', '某个操作被拦下等你批准', 'notifyOnApproval'),
        triggerRow('任务完成', '一轮干完了', 'notifyOnTurnEnd'),
        triggerRow('任务出错', '一轮以失败告终（建议一直开着）', 'notifyOnError'),
        triggerRow('任务被中断', '你按了停止 / 进程被杀（默认关，避免噪声）', 'notifyOnAbort'),
        triggerRow('子任务也提醒', 'subagent 的轮次也发（默认关，避免刷屏）', 'includeSubagents'),
        h(Row, { label: '短任务不打扰', hint: '干活不足这么多秒的轮次不发通知；0 = 每轮都发' },
          h('input', {
            className: 'dtn-input small',
            type: 'number',
            min: 0,
            value: draft.minTurnSeconds,
            onChange: function (e) { patchDraft('minTurnSeconds', e.currentTarget.value) }
          }),
          h('span', { className: 'dtn-hint' }, '秒')))

      // ④ 门控 + 在线设备
      var deviceRows = clients.length === 0
        ? h('div', { className: 'dtn-empty' }, '暂时没有在线的 DSH 页面。')
        : h('ul', { className: 'dtn-list' }, clients.map(function (client) {
            var name = client.device === 'mobile' ? '📱 手机' : client.device === 'desktop' ? '💻 电脑' : '❔ 未知设备'
            var look = client.visible && client.focused ? '正在看 DSH' : client.visible ? '页面开着但没聚焦' : '页面在后台'
            return h('li', { className: 'dtn-item', key: client.clientId },
              h('div', { className: 'dtn-itemMain' },
                h('span', null, name),
                h('span', { className: 'dtn-itemDetail' }, look)),
              h('span', { className: 'dtn-itemTime' }, fmtAgo(client.lastSeen)))
          }))
      var gatingCard = h(Card, { title: '什么时候发到钉钉（门控）' },
        h(Row, {
          label: '门控模式',
          hint: '「没人看页面」= 电脑上 DSH 页面切走了/最小化了/关了，或者你只用手机在看'
        },
          h(Segmented, {
            value: draft.gating,
            onChange: function (value) { patchDraft('gating', value) },
            options: [
              { value: 'away', label: '没人看页面时' },
              { value: 'mobileOnly', label: '仅手机在线时' },
              { value: 'always', label: '总是发' }
            ]
          })),
        h(Row, { label: '在线设备', hint: '靠浏览器心跳判断，超过有效期没报到就算离线' },
          h('span', { className: 'dtn-hint' }, clients.length + ' 台在线')),
        deviceRows,
        h(Row, {
          label: '我这台设备算',
          hint: '判定不准时手动纠正（只影响这台设备）'
        },
          h(Segmented, {
            value: deviceOverride || ('auto:' + detectDevice()),
            onChange: function (value) { chooseDevice(value.indexOf('auto:') === 0 ? '' : value) },
            options: [
              { value: 'auto:' + detectDevice(), label: '自动（' + (detectDevice() === 'mobile' ? '手机' : '电脑') + '）' },
              { value: 'mobile', label: '手机' },
              { value: 'desktop', label: '电脑' }
            ]
          })),
        h(Row, { label: '心跳有效期', hint: '超过这么多秒没收到心跳就认为该设备已离开（手机锁屏后浏览器会暂停计时器，别设太小）' },
          h('input', {
            className: 'dtn-input small',
            type: 'number',
            min: 60,
            max: 3600,
            value: draft.presenceTtlSeconds,
            onChange: function (e) { patchDraft('presenceTtlSeconds', e.currentTarget.value) }
          }),
          h('span', { className: 'dtn-hint' }, '秒')))

      // ⑤ 高级
      var advancedCard = h(Card, { title: '高级' },
        h(Row, { label: '@ 谁', hint: '填手机号，多个用逗号分隔（被 @ 的人才会收到提醒）' },
          h('input', {
            className: 'dtn-input wide',
            type: 'text',
            value: draft.atMobiles,
            placeholder: '13800000000, 13900000000',
            onChange: function (e) { patchDraft('atMobiles', e.currentTarget.value) }
          }),
          h(Switch, { checked: draft.atAll, onChange: function (value) { patchDraft('atAll', value) } }),
          h('span', { className: 'dtn-hint' }, '@所有人')),
        h(Row, { label: '免打扰时段', hint: '这段时间不发（跨零点也行，例如 23:30 → 07:30）' },
          h(Switch, { checked: draft.dndEnabled, onChange: function (value) { patchDraft('dndEnabled', value) } }),
          h('input', {
            className: 'dtn-input small',
            type: 'text',
            value: draft.dndFrom,
            placeholder: '23:30',
            onChange: function (e) { patchDraft('dndFrom', e.currentTarget.value) }
          }),
          h('span', { className: 'dtn-hint' }, '→'),
          h('input', {
            className: 'dtn-input small',
            type: 'text',
            value: draft.dndTo,
            placeholder: '07:30',
            onChange: function (e) { patchDraft('dndTo', e.currentTarget.value) }
          })),
        h(Row, { label: '免打扰时出错仍通知', hint: '夜里任务失败照样叫你' },
          h(Switch, { checked: draft.dndExceptErrors, onChange: function (value) { patchDraft('dndExceptErrors', value) } })),
        h(Row, { label: '合并同类提醒', hint: '同一轮里连着来好几条（比如连续几个审批）只发一条；0 = 不合并' },
          h('input', {
            className: 'dtn-input small',
            type: 'number',
            min: 0,
            max: 30,
            value: draft.mergeWindowSeconds,
            onChange: function (e) { patchDraft('mergeWindowSeconds', e.currentTarget.value) }
          }),
          h('span', { className: 'dtn-hint' }, '秒')),
        h(Row, { label: '失败自动重试一次', hint: '网络抖动或钉钉偶发繁忙时再试一次' },
          h(Switch, { checked: draft.retryOnFail, onChange: function (value) { patchDraft('retryOnFail', value) } })),
        h(Row, { label: '每分钟上限', hint: '钉钉官方限制 20 条/分钟，留点余量' },
          h('input', {
            className: 'dtn-input small',
            type: 'number',
            min: 1,
            max: 20,
            value: draft.maxMessagesPerMinute,
            onChange: function (e) { patchDraft('maxMessagesPerMinute', e.currentTarget.value) }
          }),
          h('span', { className: 'dtn-hint' }, '条')),
        h(Row, { label: '总开关', hint: '关掉 = 一条都不发（配置留着）' },
          h(Switch, { checked: draft.enabled, onChange: function (value) { patchDraft('enabled', value) } })))

      // ⑥ 诊断
      var history = (status && status.history) || []
      var historyRows = history.length === 0
        ? h('div', { className: 'dtn-empty' }, '还没有记录。')
        : h('ul', { className: 'dtn-list' }, history.map(function (entry, index) {
            var reason = entry.reason ? (SKIP_LABEL[entry.reason] || entry.reason) : ''
            var detail = entry.detail || reason || ''
            return h('li', { className: 'dtn-item', key: String(index) + entry.time },
              h('div', { className: 'dtn-itemMain' },
                h('span', { className: 'dtn-itemTime' }, fmtTime(entry.time)),
                h('span', null, (KIND_LABEL[entry.kind] || entry.kind) + ' · ' + (OUTCOME_LABEL[entry.outcome] || entry.outcome)),
                detail ? h('span', { className: 'dtn-itemDetail' }, detail) : null),
              h('span', { className: 'dtn-itemTime' }, entry.ms !== undefined ? entry.ms + 'ms' : ''))
          }))
      var diagnosticsCard = h(Card, { title: '诊断' },
        historyRows,
        h(Row, { label: '清空记录', hint: '只清面板里这份内存记录，磁盘日志 ' + (config.configPath || '') + ' 旁还有一份 log.ndjson' },
          h('button', {
            type: 'button',
            className: 'dtn-btn',
            onClick: function () {
              request(API.log, { method: 'POST', body: { action: 'clear' } }).then(function () {
                setStatus(function (prev) {
                  if (!prev) return prev
                  var next = {}
                  for (var k in prev) next[k] = prev[k]
                  next.history = []
                  return next
                })
              }).catch(function () { /* 忽略 */ })
            }
          }, '清空')))

      var bar = h('div', { className: 'dtn-bar' },
        h('button', { type: 'button', className: 'dtn-btn primary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
        h('button', { type: 'button', className: 'dtn-btn', disabled: busy || !dirty, onClick: discard }, '放弃修改'),
        dirty ? h('span', { className: 'dtn-msg info' }, '有未保存的改动') : null,
        message ? h('span', { className: 'dtn-msg ' + (message.kind === 'ok' ? 'ok' : message.kind === 'err' ? 'err' : 'info') }, message.text) : null)

      return h('div', { className: 'dtn-wrap' },
        statusBar,
        connectionCard,
        detailCard,
        triggerCard,
        gatingCard,
        advancedCard,
        diagnosticsCard,
        bar)
    }

    // ── 插件体 ────────────────────────────────────────────────────────
    // 心跳不依赖任何服务；设置面板需要壳的 slots 服务，晚到就重试几次。
    var inject = []

    function apply(ctx) {
      injectStyle(ctx)
      reportPresence(false)

      var timers = []
      var listeners = []
      function addListener(target, event, handler) {
        try {
          target.addEventListener(event, handler)
          listeners.push(function () { try { target.removeEventListener(event, handler) } catch (e) { /* 忽略 */ } })
        } catch (e) { /* 忽略 */ }
      }
      addListener(document, 'visibilitychange', function () { reportPresence(false) })
      addListener(window, 'focus', function () { reportPresence(false) })
      addListener(window, 'blur', function () { reportPresence(false) })
      addListener(window, 'pageshow', function () { reportPresence(false) })
      addListener(window, 'pagehide', function () { reportPresence(true) })
      timers.push(setInterval(function () { reportPresence(false) }, HEARTBEAT_MS))

      var disposed = false
      var attempts = 0
      var timer = setInterval(function () {
        if (disposed) return
        attempts += 1
        if (attempts > 20) {
          clearInterval(timer)
          return
        }
        var slots = null
        try { slots = ctx.slots } catch (e) { slots = null }
        if (!slots && typeof ctx.get === 'function') { try { slots = ctx.get('slots') } catch (e) { slots = null } }
        if (!slots || typeof slots.inject !== 'function' || !isValidElementShim()) return
        clearInterval(timer)
        try {
          slots.inject('settings.section', function () {
            return slots.register({
              name: 'settings.section',
              id: 'dingtalk-notify',
              order: 42,
              label: function () { return '钉钉通知' }
            }, function () { return h(DingtalkSettings, { ctx: ctx }) })
          })
          try { console.log('[dsh-dingtalk-notify] 设置面板已注册（设置 → 钉钉通知）') } catch (e) { /* 忽略 */ }
        } catch (e) {
          try { console.error('[dsh-dingtalk-notify] 设置面板注册失败', e) } catch (e2) { /* 忽略 */ }
        }
      }, 500)
      timers.push(timer)

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            disposed = true
            timers.forEach(function (id) { clearInterval(id) })
            listeners.forEach(function (off) { off() })
            reportPresence(true)
          }
        })
      }
    }

    exports.inject = inject
    exports.apply = apply
    exports.NS = NS
    return module.exports
  }
})
