// 生成本地插件市场 hx-local（superpowers + zcode-memory），并把它注册给 ZCode。
//
// 为什么要有这一步：ZCode 的 extraKnownMarketplaces 只负责「让市场可见」，
// 真正的安装（复制到 cache、写 installed_plugins.json）必须由客户端走一次安装流程。
// 所以这里把「市场」准备好，剩下的在 Settings → Plugin Management 里点一次 Install。
//
// 用法：
//   node agent-memory/tools/zcode-market.mjs --dry-run
//   node agent-memory/tools/zcode-market.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const HOME = os.homedir()

const MARKET_ID = 'hx-local'
const MARKET_ROOT = process.env.ZCODE_MARKET_HOME || path.join(HOME, '.zcode', 'local-marketplace')
const ZCODE_CLI = path.join(HOME, '.zcode', 'cli')
const PLUGIN_ROOT = path.join(ZCODE_CLI, 'plugins')
const CONFIG = path.join(ZCODE_CLI, 'config.json')
const KNOWN = path.join(PLUGIN_ROOT, 'known_marketplaces.json')
const MANIFEST_COPY = path.join(PLUGIN_ROOT, 'marketplaces', MARKET_ID, 'marketplace.json')
const SUPERPOWERS_SRC = path.join(HOME, '.agents', 'skills', 'superpowers', 'references', 'skills')
const SUPERPOWERS_LICENSE = path.join(HOME, '.agents', 'skills', 'superpowers', 'references', 'LICENSE-superpowers.txt')

const dry = process.argv.includes('--dry-run')
const noInstall = process.argv.includes('--no-install')
const INSTALLED = path.join(PLUGIN_ROOT, 'installed_plugins.json')

function log(msg) { console.log((dry ? '[dry-run] ' : '') + msg) }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dest = `${file}.bak-${stamp}`
  fs.copyFileSync(file, dest)
  return dest
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function copyTree(src, dest, exclude = new Set()) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(ent.name)) continue
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) copyTree(from, to, exclude)
    else if (ent.isFile()) fs.copyFileSync(from, to)
  }
}

function buildSuperpowers() {
  if (!fs.existsSync(SUPERPOWERS_SRC)) {
    throw new Error(`找不到 superpowers 技能目录：${SUPERPOWERS_SRC}\n先确认 ~/.agents/skills/superpowers/references/skills 存在。`)
  }
  const dest = path.join(MARKET_ROOT, 'plugins', 'superpowers')
  if (!dry) {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(path.join(dest, '.zcode-plugin'), { recursive: true })
  }
  const names = fs.readdirSync(SUPERPOWERS_SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  log(`superpowers：${names.length} 个技能 → ${path.join(dest, 'skills')}`)
  if (!dry) {
    for (const name of names) copyTree(path.join(SUPERPOWERS_SRC, name), path.join(dest, 'skills', name))
    if (fs.existsSync(SUPERPOWERS_LICENSE)) fs.copyFileSync(SUPERPOWERS_LICENSE, path.join(dest, 'LICENSE-superpowers.txt'))
    writeJsonAtomic(path.join(dest, '.zcode-plugin', 'plugin.json'), {
      name: 'superpowers',
      version: '1.0.0',
      description: '把想法做成可靠软件的开发方法论：brainstorm → 设计 → 拆任务 → TDD → 子 Agent 实现 → 代码审查 → 收尾。移植自 obra/superpowers（MIT）。',
      author: { name: 'Jesse Vincent (obra/superpowers), ported' },
      license: 'MIT',
      skills: './skills',
    })
  }
  return names.length
}

function buildMemory() {
  const src = path.join(REPO, 'zcode-memory')
  const dest = path.join(MARKET_ROOT, 'plugins', 'zcode-memory')
  if (!fs.existsSync(path.join(src, '.zcode-plugin', 'plugin.json'))) {
    throw new Error(`找不到插件源码：${src}`)
  }
  log(`zcode-memory → ${dest}`)
  if (!dry) {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    // test.mjs 不进插件；它是开发期自测，运行时用不到。
    for (const item of ['package.json', 'README.md', 'lib', 'bin', 'hooks', 'skills', '.zcode-plugin', '.mcp.json']) {
      const from = path.join(src, item)
      if (!fs.existsSync(from)) continue
      if (fs.statSync(from).isDirectory()) copyTree(from, path.join(dest, item))
      else fs.copyFileSync(from, path.join(dest, item))
    }
  }
}

function marketplace() {
  return {
    name: MARKET_ID,
    description: '本地自用插件：superpowers 技能包 + zcode-memory 长期记忆。',
    plugins: [
      {
        name: 'superpowers',
        source: './plugins/superpowers',
        version: '1.0.0',
        description: '把想法做成可靠软件的开发方法论（移植自 obra/superpowers，MIT）。',
        category: 'productivity',
        listing: { displayName: 'Superpowers', displayNameI18n: { 'zh-CN': 'Superpowers 方法论' } },
      },
      {
        name: 'zcode-memory',
        source: './plugins/zcode-memory',
        version: '0.1.0',
        description: '跨会话长期记忆：自动落盘、按线索回想、可溯源，与其它 harness 共用 ~/.agent-memory。',
        category: 'productivity',
        listing: { displayName: 'ZCode Memory', displayNameI18n: { 'zh-CN': 'ZCode 长期记忆' } },
      },
    ],
  }
}

function register() {
  const market = marketplace()
  log(`写市场清单：${path.join(MARKET_ROOT, 'marketplace.json')} 与 ${MANIFEST_COPY}`)
  if (!dry) {
    writeJsonAtomic(path.join(MARKET_ROOT, 'marketplace.json'), market)
    writeJsonAtomic(MANIFEST_COPY, market)
    // 关键：客户端读的是缓存目录里的清单，而里面的 source 是相对路径。
    // 只复制 marketplace.json 不够，插件树必须一起进去，否则
    // 解析 ./plugins/<name> 时找不到，报 "Unsupported or missing plugin source"。
    const cacheMarket = path.dirname(MANIFEST_COPY)
    copyTree(path.join(MARKET_ROOT, 'plugins'), path.join(cacheMarket, 'plugins'))
    log(`市场缓存同步：${path.join(cacheMarket, 'plugins')}`)
  }

  const known = readJson(KNOWN, { version: 1, marketplaces: [] })
  const list = Array.isArray(known.marketplaces) ? known.marketplaces : []
  const entry = {
    id: MARKET_ID,
    name: MARKET_ID,
    description: market.description,
    source: { source: 'directory', path: MARKET_ROOT },
    addedAt: new Date().toISOString(),
    pluginCount: market.plugins.length,
  }
  const at = list.findIndex((m) => m && m.id === MARKET_ID)
  if (at >= 0) list[at] = { ...list[at], ...entry }
  else list.push(entry)
  log(`注册到 ${KNOWN}（${list.length} 个市场）`)
  if (!dry) {
    const bak = backup(KNOWN)
    if (bak) log('  备份：' + bak)
    writeJsonAtomic(KNOWN, { version: 1, marketplaces: list })
  }

  const cfg = readJson(CONFIG, {})
  cfg.plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {}
  cfg.plugins.enabled = cfg.plugins.enabled !== false
  cfg.plugins.enabledPlugins = cfg.plugins.enabledPlugins || {}
  cfg.plugins.extraKnownMarketplaces = cfg.plugins.extraKnownMarketplaces || {}
  cfg.plugins.extraKnownMarketplaces[MARKET_ID] = { source: { source: 'directory', path: MARKET_ROOT } }
  log(`注册到 ${CONFIG} 的 plugins.extraKnownMarketplaces`)
  if (!dry) {
    const bak = backup(CONFIG)
    if (bak) log('  备份：' + bak)
    writeJsonAtomic(CONFIG, cfg)
  }
  return market
}

// 直接安装：复制到 cache/<market>/<name>/<version>，写 installed_plugins.json，
// 并在 enabledPlugins 里打开。等价于客户端「Install」按钮走的那一步。
function install(market) {
  if (noInstall) { log('跳过安装（--no-install）'); return }
  const db = readJson(INSTALLED, { version: 1, plugins: [] })
  const list = Array.isArray(db.plugins) ? db.plugins : []
  const now = new Date().toISOString()
  const enabled = []

  for (const p of market.plugins) {
    const version = p.version || '0.0.0'
    const rel = String(p.source).replace(/^\.\//, '')
    const src = path.join(MARKET_ROOT, ...rel.split('/'))
    const dest = path.join(PLUGIN_ROOT, 'cache', MARKET_ID, p.name, version)
    const id = `${p.name}@${MARKET_ID}`
    log(`安装 ${id} v${version} → ${dest}`)
    if (dry) continue
    if (!fs.existsSync(src)) throw new Error(`插件源不存在：${src}`)
    fs.rmSync(dest, { recursive: true, force: true })
    copyTree(src, dest)

    const entry = {
      id,
      name: p.name,
      marketplace: MARKET_ID,
      version,
      installPath: dest,
      installedAt: now,
      updatedAt: now,
      scope: 'user',
      source: p.source,
      cacheTransactionId: randomUUID(),
    }
    const at = list.findIndex((x) => x && x.id === id)
    if (at >= 0) list[at] = { ...list[at], ...entry, installedAt: list[at].installedAt || now }
    else list.push(entry)
    enabled.push(id)
  }

  if (dry) return
  const bakDb = backup(INSTALLED)
  if (bakDb) log('  备份：' + bakDb)
  writeJsonAtomic(INSTALLED, { version: 1, plugins: list })

  const cfg = readJson(CONFIG, {})
  cfg.plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {}
  cfg.plugins.enabled = true
  cfg.plugins.enabledPlugins = cfg.plugins.enabledPlugins || {}
  for (const id of enabled) cfg.plugins.enabledPlugins[id] = true
  const bakCfg = backup(CONFIG)
  if (bakCfg) log('  备份：' + bakCfg)
  writeJsonAtomic(CONFIG, cfg)
  log(`已启用：${enabled.join('、')}`)
}

try {
  log(`市场根：${MARKET_ROOT}`)
  const n = buildSuperpowers()
  buildMemory()
  const market = register()
  install(market)
  log('')
  log(`完成。superpowers ${n} 个技能；两个插件都在 ${MARKET_ID} 市场里。`)
  if (noInstall) {
    log('下一步（--no-install）：在 Settings → Plugin Management → Discover → hx-local 里手动安装。')
  } else {
    log('已直接安装到 plugins/cache 并启用（等价于点过 Install）。')
    log('下一步：完全退出 ZCode（含后台进程）后重开，插件与钩子都在启动时解析。')
    log('重开后：node agent-memory/recall.mjs sources 应出现 zcode')
  }
} catch (e) {
  console.error('失败：' + (e && e.message ? e.message : e))
  process.exitCode = 1
}
