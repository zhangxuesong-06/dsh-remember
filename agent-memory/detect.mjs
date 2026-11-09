// 识别当前机器上装了哪些 harness，以及它们是否已经装过记忆。
//
// 这里只做“发现”，不做写入。安装器拿到结果后再决定用哪个 adapter。
// 判断优先看“已经装过”的显式标记，其次才看目录是否存在——避免把
// 只是装了 DSH、但没装记忆的机器误判成“要更新 DSH 记忆”。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HARNESSES = ['dsh', 'opencode', 'workbuddy']

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch { return null }
}

function exists(file) {
  try { return fs.existsSync(file) } catch { return false }
}

function includesSelfMemory(value) {
  return JSON.stringify(value || '').includes('self-memory') || JSON.stringify(value || '').includes('agent-memory')
}

export function detectHarnesses({ home = os.homedir(), repoRoot = process.cwd() } = {}) {
  const out = []

  // ——— DSH ———
  const dshRoot = path.join(home, '.dsh')
  const dshProfile = path.join(dshRoot, 'profiles', 'desktop', 'package.json')
  const dshInstalled = path.join(dshRoot, 'profiles', 'node_modules', 'dsh-memory')
  const dshConfig = path.join(dshRoot, 'dsh-memory', 'config.json')
  const dshProfileJson = readJson(dshProfile)
  const dshBundled = dshProfileJson ? includesSelfMemory(dshProfileJson.bundles || dshProfileJson.dependencies) : false
  if (exists(dshRoot)) {
    out.push({
      id: 'dsh',
      label: 'DeepSeek Harness',
      installed: !!(exists(dshInstalled) || exists(dshConfig) || dshBundled),
      markers: [dshInstalled, dshConfig, dshProfile].filter(exists),
      adapter: path.join(repoRoot, 'dsh-memory'),
      install: 'powershell -ExecutionPolicy Bypass -File dsh-memory/install.ps1',
    })
  }

  // ——— OpenCode ———
  const ocRoot = path.join(home, '.config', 'opencode')
  const ocConfig = path.join(ocRoot, 'opencode.json')
  const ocConfigC = path.join(ocRoot, 'opencode.jsonc')
  const ocJson = readJson(ocConfig) || readJson(ocConfigC)
  const ocPlugins = ocJson && Array.isArray(ocJson.plugins) ? ocJson.plugins : []
  const ocInstalled = ocPlugins.some((p) => includesSelfMemory(p)) || exists(path.join(home, '.opencode-mem', 'stream.jsonl'))
  if (exists(ocRoot) || exists(path.join(home, '.opencode-mem'))) {
    out.push({
      id: 'opencode',
      label: 'OpenCode',
      installed: !!ocInstalled,
      markers: [ocConfig, ocConfigC, path.join(home, '.opencode-mem')].filter(exists),
      adapter: path.join(repoRoot, 'plugin', 'self-memory'),
      install: '把 plugin/self-memory 的绝对路径加进 ~/.config/opencode/opencode.json 的 plugins',
    })
  }

  // ——— WorkBuddy ———
  const wbRoot = path.join(home, '.workbuddy')
  const wbSettings = path.join(wbRoot, 'settings.json')
  const wbSkill = path.join(wbRoot, 'skills', 'self-memory', 'bin', 'mem.mjs')
  const wbJson = readJson(wbSettings)
  const wbHooks = wbJson && wbJson.hooks ? JSON.stringify(wbJson.hooks) : ''
  const wbInstalled = wbHooks.includes('self-memory') || exists(wbSkill)
  if (exists(wbRoot)) {
    out.push({
      id: 'workbuddy',
      label: 'WorkBuddy',
      installed: !!wbInstalled,
      markers: [wbSettings, wbSkill].filter(exists),
      adapter: path.join(repoRoot, 'workbuddy-memory'),
      install: 'node workbuddy-memory/install.mjs',
    })
  }

  return out
}

// 自动选择：只选“已经装过”的；没有装过的只在唯一候选时才选。
// 多个候选就返回 ambiguous，让安装器要求显式 --harness，绝不猜。
export function chooseHarness(candidates, requested = 'auto') {
  if (requested && requested !== 'auto') {
    const hit = candidates.find((c) => c.id === requested)
    if (!hit) return { ok: false, reason: `没有发现 ${requested}；先确认它装在本机。`, candidates }
    return { ok: true, harness: hit }
  }
  const installed = candidates.filter((c) => c.installed)
  if (installed.length === 1) return { ok: true, harness: installed[0] }
  if (installed.length > 1) return { ok: false, reason: '多个 harness 都装过记忆，请显式指定 --harness。', candidates: installed, ambiguous: true }
  if (candidates.length === 1) return { ok: true, harness: candidates[0] }
  if (candidates.length > 1) return { ok: false, reason: '发现了多个 harness，但都没有装过记忆，请显式指定 --harness。', candidates, ambiguous: true }
  return { ok: false, reason: '没有发现 DSH / OpenCode / WorkBuddy。', candidates }
}
