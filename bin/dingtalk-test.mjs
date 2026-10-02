#!/usr/bin/env node
/**
 * 命令行自检：按 `~/.dsh/dingtalk-notify/config.json` 发一条测试消息到钉钉群。
 *
 *   node bin/dingtalk-test.mjs
 *   node bin/dingtalk-test.mjs "自定义测试正文"
 *
 * 退出码：0 发送成功；1 发送失败；2 配置缺失（webhook 为空）。
 *
 * @module dsh-dingtalk-notify/bin/dingtalk-test
 */

import { configPath, ensureConfigFile, loadConfig, sendDingtalk } from '../lib/dingtalk.js'

ensureConfigFile()
const config = loadConfig(undefined)
const custom = process.argv.slice(2).join(' ').trim()

if (typeof config._error === 'string') {
  process.stderr.write(`配置读取有问题：${config._error}\n`)
}
if (typeof config.webhook !== 'string' || config.webhook.trim().length === 0) {
  process.stderr.write(`webhook 还没填。请编辑：${configPath()}\n`)
  process.exit(2)
}

const text = custom.length > 0
  ? custom
  : [
      '### 🔔 DSH 钉钉通知自检',
      '',
      '**状态**：链路正常 ✅',
      `**时间**：${new Date().toLocaleString('zh-CN')}`,
      `**安全模式**：${typeof config.secret === 'string' && config.secret.length > 0 ? '加签' : '自定义关键词'}`,
      '',
      '收到这条消息，说明 DSH 已经能往这个群发通知了。'
    ].join('\n')

const result = await sendDingtalk(config, { title: 'DSH 通知自检', text })
if (result.ok) {
  process.stdout.write('已发送 ✅\n')
  process.exit(0)
}
process.stderr.write(`发送失败 ❌ ${result.skipped ?? result.error ?? '未知原因'}\n`)
process.exit(1)
