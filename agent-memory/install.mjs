#!/usr/bin/env node
// 通用安装器：先识别，再选择 adapter，最后调用对应后端的安装脚本。
//
// 用法：
//   node agent-memory/install.mjs --dry-run
//   node agent-memory/install.mjs --harness dsh --workspace "D:\deepseek harness"
//   node agent-memory/install.mjs --harness opencode
//   node agent-memory/install.mjs --harness workbuddy
//
// 默认 auto：只自动选“已经装过记忆”的那一个；多个就要求显式指定，绝不猜。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectHarnesses, chooseHarness } from './detect.mjs'
import { ADAPTERS } from './adapters/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { harness: 'auto', workspace: '', dryRun: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--harness') out.harness = argv[++i] || 'auto'
    else if (a === '--workspace') out.workspace = argv[++i] || ''
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else out.unknown = [...(out.unknown || []), a]
  }
  return out
}

export function planInstall(harness, { home = os.homedir(), repoRoot = REPO, workspace = '' } = {}) {
  const adapter = ADAPTERS[harness.id]
  if (!adapter) throw new Error('未知 harness: ' + harness.id)
  return adapter.plan({ home, repoRoot, workspace })
}

function updateOpencodeConfig(plan) {
  const file = plan.config
  if (!fs.existsSync(file)) throw new Error('找不到 ' + file + '；先启动一次 OpenCode。')
  const original = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  let json
  try { json = JSON.parse(original) } catch {
    throw new Error(file + ' 不是纯 JSON（可能是 JSONC）；请手动把 ' + plan.pluginPath + ' 加进 plugins。')
  }
  json.plugins = Array.isArray(json.plugins) ? json.plugins : []
  const already = json.plugins.some((p) => String(p).replace(/\\/g, '/') === plan.pluginPath)
  if (already) return { changed: false, file }
  const backup = file + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  fs.copyFileSync(file, backup)
  json.plugins.push(plan.pluginPath)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return { changed: true, file, backup }
}

export function execute(plan, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, plan }
  if (plan.action === 'update-opencode-config') return updateOpencodeConfig(plan)
  const [cmd, ...args] = plan.command
  const r = spawnSync(cmd, args, { cwd: plan.cwd, stdio: 'inherit', windowsHide: true })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${plan.harness} 安装失败（exit ${r.status}）`)
  return { ok: true, harness: plan.harness }
}

function printHelp() {
  console.log(`agent-memory 通用安装器

  node agent-memory/install.mjs --dry-run
  node agent-memory/install.mjs --harness dsh --workspace "D:\\deepseek harness"
  node agent-memory/install.mjs --harness opencode
  node agent-memory/install.mjs --harness workbuddy

  --harness auto|dsh|opencode|workbuddy   默认 auto：只自动选已装过记忆的那个
  --workspace <路径>                       DSH 首次安装时写入的工作区
  --dry-run                                只打印计划，不写任何文件
  --json                                   用 JSON 输出识别结果
`)
}

function main() {
  const args = parseArgs()
  if (args.help) { printHelp(); return }
  const candidates = detectHarnesses({ home: os.homedir(), repoRoot: REPO })
  const choice = chooseHarness(candidates, args.harness)

  if (args.json) {
    console.log(JSON.stringify({ candidates, choice, args }, null, 2))
    // JSON 是识别结果，不是安装失败；让调用方按 choice.ok 自行判断。
    return
  }

  if (!choice.ok) {
    console.error(choice.reason)
    for (const c of choice.candidates || candidates) {
      console.error(`  ${c.id.padEnd(10)} ${c.installed ? '已装记忆' : '仅检测到软件'}  ${c.markers[0] || ''}`)
    }
    console.error('\n用 --harness dsh|opencode|workbuddy 明确指定。')
    // 识别结果不是安装失败：dry-run / json 是给人或模型看的，退出码保持 0。
    if (!args.dryRun && !args.json) process.exitCode = 2
    return
  }

  const plan = planInstall(choice.harness, { workspace: args.workspace })
  console.log(`识别：${choice.harness.label}（${choice.harness.id}）`)
  console.log(`适配器：${plan.adapter}`)
  console.log(`动作：${plan.note}`)
  if (args.dryRun) {
    console.log('[dry-run] 没有写任何文件。')
    return
  }
  const result = execute(plan, { dryRun: false })
  console.log(JSON.stringify(result))
  console.log('下一步：重启对应的 harness，然后跑 health / verify。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
