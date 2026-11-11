// 安装/更新 WorkBuddy 的 self-memory skill，并把 PostToolUse 挂上。
// 只改 hooks 里和 self-memory 有关的条目；其它设置原样保留，改前备份 settings.json。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = os.homedir()
const skillDir = path.join(home, '.workbuddy', 'skills', 'self-memory')
const binDir = path.join(skillDir, 'bin')
const settingsPath = path.join(home, '.workbuddy', 'settings.json')

fs.mkdirSync(binDir, { recursive: true })
for (const [from, to] of [
  [path.join(here, 'bin', 'mem.mjs'), path.join(binDir, 'mem.mjs')],
  [path.join(here, 'bin', 'mem-evidence.mjs'), path.join(binDir, 'mem-evidence.mjs')],
  [path.join(here, 'bin', 'mem-maintenance.mjs'), path.join(binDir, 'mem-maintenance.mjs')],
  [path.join(here, 'SKILL.md'), path.join(skillDir, 'SKILL.md')],
]) {
  fs.copyFileSync(from, to)
  console.log('复制 ' + to)
}

if (!fs.existsSync(settingsPath)) {
  console.log('找不到 ' + settingsPath + '；脚本已装好，但 hook 需要手动挂。')
  process.exit(0)
}

const original = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
let settings
try { settings = JSON.parse(original) } catch (error) {
  console.error('settings.json 不是合法 JSON，未改动：' + error.message)
  process.exit(1)
}

const backup = settingsPath + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
fs.writeFileSync(backup, original, 'utf8')
console.log('备份 ' + backup)

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
const command = 'node "' + path.join(binDir, 'mem.mjs').replace(/\\/g, '/') + '" hook 2>/dev/null || true'
const hasSelf = (group) => (group.hooks || []).some((h) => String(h && h.command || '').includes('self-memory'))
function ensure(event, matcher) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : (settings.hooks[event] = [])
  if (list.some(hasSelf)) return false
  const group = { hooks: [{ type: 'command', command, timeout: 10 }] }
  if (matcher) group.matcher = matcher
  list.push(group)
  return true
}

const added = []
if (ensure('SessionStart')) added.push('SessionStart')
if (ensure('UserPromptSubmit')) added.push('UserPromptSubmit')
if (ensure('PreToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit')) added.push('PreToolUse')
if (ensure('PostToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit')) added.push('PostToolUse')
if (ensure('Stop')) added.push('Stop')

const tmp = settingsPath + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
fs.renameSync(tmp, settingsPath)
console.log(added.length ? '已挂 hook：' + added.join(', ') : 'hook 已存在，未重复添加')
console.log('重开一次 WorkBuddy 让新 hook 生效。')
