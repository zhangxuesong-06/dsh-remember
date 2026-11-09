import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { detectHarnesses, chooseHarness } from './detect.mjs'
import { planInstall, execute } from './install.mjs'

const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const root = fs.mkdtempSync(path.join(base, 'agent-memory-test-'))
const repo = path.join(root, 'repo')
let pass = 0
const check = (name, cond, extra = '') => {
  if (cond) pass += 1
  else { console.error('FAIL ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1 }
}
const mk = (p) => fs.mkdirSync(p, { recursive: true })
const write = (p, v) => { mk(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v), 'utf8') }

function home(name) {
  const h = path.join(root, name)
  mk(h)
  return h
}

try {
  // 1. 只有 DSH，且已装记忆
  const h1 = home('dsh')
  mk(path.join(h1, '.dsh', 'profiles', 'node_modules', 'dsh-memory'))
  mk(path.join(h1, '.dsh', 'dsh-memory'))
  let d = detectHarnesses({ home: h1, repoRoot: repo })
  check('识别 DSH', d.length === 1 && d[0].id === 'dsh')
  check('DSH 已装记忆', d[0].installed === true)
  check('auto 选中 DSH', chooseHarness(d).ok && chooseHarness(d).harness.id === 'dsh')

  // 2. 只有 OpenCode，配置里已有插件
  const h2 = home('opencode')
  write(path.join(h2, '.config', 'opencode', 'opencode.json'), {
    plugins: ['C:/somewhere/plugin/self-memory'],
  })
  d = detectHarnesses({ home: h2, repoRoot: repo })
  check('识别 OpenCode', d.length === 1 && d[0].id === 'opencode')
  check('OpenCode 已装记忆', d[0].installed === true)
  const plan = planInstall(d[0], { home: h2, repoRoot: repo })
  check('OpenCode 计划是改配置', plan.action === 'update-opencode-config')
  check('OpenCode 适配器路径正确', /plugin[\\/]self-memory$/.test(plan.adapter))

  // 3. 只有 WorkBuddy，settings 里有 self-memory hook
  const h3 = home('workbuddy')
  write(path.join(h3, '.workbuddy', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/self-memory/bin/mem.mjs" hook' }] }] },
  })
  d = detectHarnesses({ home: h3, repoRoot: repo })
  check('识别 WorkBuddy', d.length === 1 && d[0].id === 'workbuddy')
  check('WorkBuddy 已装记忆', d[0].installed === true)

  // 4. 多个已装：必须显式选择
  const h4 = home('multi')
  mk(path.join(h4, '.dsh', 'profiles', 'node_modules', 'dsh-memory'))
  write(path.join(h4, '.config', 'opencode', 'opencode.json'), { plugins: ['x/self-memory'] })
  write(path.join(h4, '.workbuddy', 'settings.json'), { hooks: { Stop: [{ hooks: [{ command: 'node self-memory/bin/mem.mjs hook' }] }] } })
  d = detectHarnesses({ home: h4, repoRoot: repo })
  const multi = chooseHarness(d)
  check('多个已装不自动选', multi.ok === false && multi.ambiguous === true)
  check('显式选择可用', chooseHarness(d, 'opencode').ok && chooseHarness(d, 'opencode').harness.id === 'opencode')

  // 5. 只检测到软件、没装记忆：唯一候选仍可选，但 installed=false
  const h5 = home('present')
  mk(path.join(h5, '.workbuddy'))
  d = detectHarnesses({ home: h5, repoRoot: repo })
  check('未装记忆仍被识别', d.length === 1 && d[0].installed === false)
  check('唯一候选可选', chooseHarness(d).ok === true)

  // 6. 什么都没有
  const h6 = home('none')
  d = detectHarnesses({ home: h6, repoRoot: repo })
  check('空机器没有候选', d.length === 0 && chooseHarness(d).ok === false)

  // 7. OpenCode 配置更新幂等
  const h7 = home('oc-update')
  const cfg = path.join(h7, '.config', 'opencode', 'opencode.json')
  write(cfg, { plugins: [], theme: 'dark' })
  const ocPlan = planInstall({ id: 'opencode' }, { home: h7, repoRoot: repo })
  execute(ocPlan)
  let saved = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  check('OpenCode 配置写入了插件', saved.plugins.some((p) => p.includes('plugin/self-memory') || p.includes('plugin\\\\self-memory')))
  check('无关配置保留', saved.theme === 'dark')
  const first = fs.readFileSync(cfg, 'utf8')
  execute(ocPlan)
  check('重复安装不重复添加', fs.readFileSync(cfg, 'utf8') === first)

  console.log(`\n${pass} passed, ${process.exitCode ? 'failures' : '0 failed'}`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
