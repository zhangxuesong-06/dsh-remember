// 配置与目录。
//
// 与 dsh-memory 最大的不同：这里没有「一个工作区一条身份线」。
// 只有一个用户，换文件夹不该失忆——所以整个 ZCode 共用一条流，
// 工作区（ws）只是记录上的标签，用于展示和按需过滤，不切库。
//
// 数据根优先级：ZCODE_MEM_HOME > 已存在的共享库 ~/.agent-memory/zcode > ~/.zcode/memory
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const HOME_DIR = homedir()
export const SHARED_ROOT = join(HOME_DIR, '.agent-memory', 'zcode')
export const LEGACY_ROOT = join(HOME_DIR, '.zcode', 'memory')

function memoryHome() {
  if (process.env.ZCODE_MEM_HOME) return process.env.ZCODE_MEM_HOME
  return existsSync(SHARED_ROOT) ? SHARED_ROOT : LEGACY_ROOT
}

export const HOME = memoryHome()
export const CFG_PATH = join(HOME, 'config.json')
export const CFG_BAK = join(HOME, 'config.json.bak')
export const DIAG = join(HOME, 'diag.log')
export const STREAM = join(HOME, 'stream.jsonl')
export const MARKS = join(HOME, 'marks.jsonl')
export const PENDING = join(HOME, 'pending.json')
export const SESSIONS = join(HOME, 'sessions')

export const DEFAULT_CFG = {
  enabled: true,
  // 钩子里的总开关：false 时只写用户/助手原话，不记工具。
  capture: true,
  // 空数组 = 所有工作区都记。写路径则是白名单（按规范化路径相等判断）。
  workspaces: [],
  // 子串排除：临时目录、node_modules、.git 之类，命中就不记。
  exclude: ['\\appdata\\local\\temp\\', '\\node_modules\\', '\\.git\\'],
  // 每轮给 0–3 条「这事以前碰过」。
  perTurnPriming: true,
  primeMax: 3,
  primeMinScore: 0,
  // 只认「不那么常见的词」当证据：df 太大说明这个词到处都有，不构成线索。
  primeMaxDf: 22,
  primeRecentCooldown: 8,
  // 他说「累/困/烦…」时，去库里找上次那句话的原因。
  emotionCue: true,
  emotionCueMaxChars: 80,
  // 会话开场给身份锚 / 到达块 / 事实块。
  anchor: true,
  anchorQuotes: 5,
  anchorChars: 150,
  arrival: true,
  arrivalChars: 2400,
  facts: true,
  factMax: 8,
  // 一次回忆最多给多少字。
  recallMaxChars: 2200,
  // 时间衰减：幂律（不是半衰）。数值沿用 dsh-memory 的标定结果。
  recency: { t0: 0.25, alpha: 0.8, floor: 0 },
  // 多长没说话算「换了一次见面」。
  meetingGapMs: 2 * 60 * 60 * 1000,
  // 写入前把明显的密钥抹掉。默认关：这个库的立身之本是原话。
  redact: false,
  // 单个文件快照上限（字节）。超了只记状态，不存内容。
  maxBlobBytes: 2 * 1024 * 1024,
  // 流超过这个大小，钩子里就不再建索引做预激活，只给最近段标题。
  hookBudgetBytes: 5 * 1024 * 1024,
}

function writeAtomic(p, text) {
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, p)
}

function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

let _lastGoodRaw = null

export function loadCfg() {
  let raw = null
  try { raw = readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch {}

  if (raw === null) {
    try {
      mkdirSync(HOME, { recursive: true })
      writeAtomic(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2))
    } catch {}
    return { ...DEFAULT_CFG }
  }

  let parsed = null
  try { parsed = JSON.parse(raw) } catch {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (raw !== _lastGoodRaw) {
      _lastGoodRaw = raw
      try { writeAtomic(CFG_BAK, raw) } catch {}
    }
    return { ...DEFAULT_CFG, ...parsed }
  }

  // 文件在但读不出来：不写盘，退回上一份好的。手滑存坏一次不该把配置冲掉。
  diag('配置读不出来（格式坏了）：这次用上一份好的；没有写盘，把文件改好就自动恢复。')
  return { ...DEFAULT_CFG, ...(readJsonFile(CFG_BAK) || {}) }
}

export function saveCfg(cfg) {
  try {
    mkdirSync(HOME, { recursive: true })
    const text = JSON.stringify(cfg, null, 2)
    writeAtomic(CFG_PATH, text)
    writeAtomic(CFG_BAK, text)
    _lastGoodRaw = text
    return true
  } catch { return false }
}

export function normPath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

// ws 存规范化后的完整路径：只存末段目录名会撞车（记忆、work、src 到处都有）。
export function wsOf(cwd) {
  return normPath(cwd || process.cwd())
}

export function wsNameOf(cwd) {
  const full = String(cwd || process.cwd()).replace(/[\\/]+$/, '')
  return basename(full.replace(/\//g, '\\')) || full || 'root'
}

export function inScope(cfg, cwd) {
  const ws = wsOf(cwd)
  if (Array.isArray(cfg.workspaces) && cfg.workspaces.length) {
    const allow = cfg.workspaces.map(normPath)
    if (!allow.includes(ws)) return false
  }
  for (const bad of cfg.exclude || []) {
    if (!bad) continue
    if (ws.includes(normPath(bad))) return false
  }
  return true
}

export function diag(msg) {
  try {
    mkdirSync(HOME, { recursive: true })
    appendFileSync(DIAG, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch {}
}

// 只抹最常见的几种，宁可漏也不误伤原话之外的结构。
export function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
}
