// 跨 harness 只读查询：OpenCode / DSH / WorkBuddy / ZCode / Codex。
//
// 边界：
//   - 只读：只 readFileSync / statSync / readdirSync，不建目录、不拿锁、不写缓存；
//   - 不合并：每个库各自仍是唯一真相，结果只标来源；
//   - 不改写：原文件一个字节都不动，测试用哈希前后比对；
//   - 不自动注入：按需调用，避免每轮对话都背几个库的开销。
//
// 打分和 OpenCode 的 recall 保持一致（同一套 BM25、覆盖率、新鲜加分），
// 这样跨库结果之间才可比。分词来自 mem-tokenize.mjs，不 import mem-core。
import { pathToFileURL } from 'node:url'
import { tok } from '../tools/mem-tokenize.mjs'
import { codexRoot, readStream, streams } from './repo.mjs'
import { caseSource, caseCommand, caseProject } from '../dsh-memory/lib/memory-case-index.mjs'
import path from 'node:path'
import { QUOTE_SIZE, compactLimit, compactQuotes, createTextSearch, quoteFor as quote, serializeRange, speakerOf } from '../tools/mem-recall.mjs'

const DAY = 864e5
export const LONG_TEXT_RANK = Object.freeze({ b: 0.45 })

const KIND = {
  'user/message': 'message',
  'assistant/message': 'message',
  'tool/call': 'tool',
  'tool/result': 'tool',
  'session/title': 'note',
  artifact: 'artifact',
}
const KIND_WEIGHT = { message: 1, note: 1, decision: 1, finding: 1, todo: 1, data: 1, artifact: 0.85, episode: 0.55, tool: 0.35 }
const WHO_WEIGHT = { meta: 0.4 }

function listStores() {
  const { layout, list } = streams()
  return { list, dshRoot: layout.dsh }
}

function normalize(source, workspace, line, raw) {
  const type = String(raw.type || '')
  const who = speakerOf(raw.who)
  const kind = source === 'opencode' ? String(raw.kind || 'message') : (KIND[type] || type || 'message')
  return {
    source,
    store: '',
    workspace: workspace || raw.ws || '',
    line,
    id: raw.id || null,
    ts: Number(raw.ts || 0),
    who,
    kind,
    text: String(raw.text ?? ''),
    sid: raw.sid || null,
    messageID: raw.messageID || null,
    turnID: raw.turnID || null,
    turn: raw.turn ?? null,
    tool: raw.tool || null,
    rawType: type || String(raw.kind || ''),
  }
}

// 默认只收对话与派生记录；工具行要显式打开。
export function loadAll({ withTools = false, withProvenance = false } = {}) {
  const records = []
  const bySource = new Map()
  const { list, dshRoot } = listStores()
  for (const entry of list) {
    let s = bySource.get(entry.source)
    if (!s) {
      s = {
        source: entry.source,
        path: entry.source === 'dsh' ? dshRoot : entry.path,
        exists: false, read: 0, records: 0, tools: 0, included: 0, skipped: 0, workspaces: 0, lastTs: 0,
      }
      bySource.set(entry.source, s)
    }
    const { entries, skipped, missing } = readStream(entry.path)
    if (missing) continue
    s.exists = true
    s.read += entries.length
    s.skipped += skipped
    s.workspaces += 1
    entries.forEach(({ row, line }) => {
      const rec = normalize(entry.source, entry.workspace, line, row)
      rec.store = entry.path
      if (withProvenance && entry.source === 'opencode') {
        rec.seq = Number.isSafeInteger(row.seq) ? row.seq : null
        if (rec.kind === 'episode' && row.source?.type === 'derived.observation') {
          rec.evidenceIds = Array.isArray(row.sourceIDs) ? row.sourceIDs.filter(id => typeof id === 'string') : []
          rec.requestSeq = Number.isSafeInteger(row.requestSeq) ? row.requestSeq : null
        }
      }
      if (!rec.text.trim()) return
      s.records += 1
      if (rec.kind === 'tool') s.tools += 1
      if (rec.kind === 'tool' && !withTools) return
      records.push(rec)
      s.included += 1
      if (rec.ts > s.lastTs) s.lastTs = rec.ts
    })
  }
  const order = { opencode: 0, dsh: 1, workbuddy: 2, zcode: 3, codex: 4 }
  const stores = [...bySource.values()].sort((a, b) => order[a.source] - order[b.source])
  return { records, stores }
}

export function sources() {
  return loadAll({ withTools: true }).stores
}

function multiplier(rec) {
  return (KIND_WEIGHT[rec.kind] ?? 1) * (WHO_WEIGHT[rec.who] ?? 1)
}

function dedupeKey(rec, passages) {
  const text = rec.text.replace(/\s+/g, ' ').trim()
  // 长文本按正文折叠：同一段话、每日重复的模板，不该各占一个位置。
  if (text.length >= 80) return `${rec.source}|${rec.who}|${passages ? text : text.slice(0, 120)}`
  // 短文本保留会话区分，避免把不同会话里碰巧相同的一句吞掉。
  if (text.length >= 12) return `${rec.source}|${rec.sid || ''}|${rec.who}|${text.slice(0, 120)}`
  if (rec.messageID) return `${rec.source}|${rec.sid || ''}|${rec.messageID}|${text}`
  if (rec.id) return `${rec.source}|${rec.id}`
  return `${rec.source}|${rec.sid || ''}|${rec.rawType}|${text}`
}

function passes(rec, opts) {
  if (opts.source && rec.source !== opts.source) return false
  if (opts.since && rec.ts && rec.ts < opts.since) return false
  if (opts.ws && !String(rec.workspace).includes(opts.ws)) return false
  return true
}

export function createRecallSearch({ records, stores }, opts = {}) {
  const search = createTextSearch(records.filter((r) => passes(r, opts)), {
    tokenize: tok, passages: opts.passages, weight: multiplier, key: dedupeKey,
  })
  return (query, options) => {
    const hits = search(query, options)
    if (hits.length) hits.stores = stores
    return hits
  }
}

export function recall(query, opts = {}) {
  if (!tok(query).length) return []
  return createRecallSearch(loadAll({ withTools: !!opts.withTools }), opts)(query, opts)
}

export function trace(text, opts = {}) {
  const needle = String(text || '')
  if (!needle) return []
  const { records } = loadAll({ withTools: opts.withTools !== false })
  return records
    .filter((r) => passes(r, opts) && r.text.includes(needle))
    .sort((a, b) => b.ts - a.ts)
}

export function readAt(source, line, workspace = null) {
  const num = Number(line)
  if (!Number.isFinite(num)) return null
  const { records } = loadAll({ withTools: true })
  return records.find((r) => r.source === source && r.line === num && (!workspace || r.workspace === workspace)) || null
}

export function refOf(rec) {
  if (rec.source === 'dsh' && rec.workspace) return `${rec.source}:${rec.workspace}:${rec.line}`
  return `${rec.source}:${rec.line}`
}

export function parseRef(ref) {
  const parts = String(ref || '').split(':')
  if (parts.length < 2) return null
  const source = parts.shift()
  const line = Number(parts.pop())
  if (!Number.isFinite(line)) return null
  return { source, workspace: parts.length ? parts.join(':') : null, line }
}

export function quoteFor(record, query) {
  return quote(record, query, refOf(record), tok)
}

function dayOf(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '----------'
}

function excerpt(text, max = 90) {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

// —— CLI ——
function parseSince(v) {
  if (!v) return null
  const m = /^(\d+)([dhm])$/.exec(v)
  if (m) {
    const unit = m[2] === 'd' ? DAY : m[2] === 'h' ? 3600e3 : 60e3
    return Date.now() - Number(m[1]) * unit
  }
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function flags(args, command) {
  const o = { n: 8, source: null, since: null, ws: null, withTools: false, json: false, rest: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-n') o.n = Math.max(1, Number(args[++i]) || 8)
    else if (a === '--source') o.source = args[++i] || null
    else if (a === '--since') o.since = parseSince(args[++i])
    else if (a === '--ws') o.ws = args[++i] || null
    else if (a === '--with-tools') o.withTools = true
    else if (a === '--json') o.json = true
    else if (a === '--compact' && command !== 'show') o.compact = true
    else if (a === '--range' && command === 'show') o.range = args[++i] ?? ''
    else if (a === '--rank' && command === 'recall') {
      const name = args[++i]
      if (!['default', 'long-text', 'passage'].includes(name)) return null
      o.rank = name === 'long-text' ? LONG_TEXT_RANK : {}
      o.passages = name === 'passage'
    }
    else o.rest.push(a)
  }
  return o
}

function printStores(list) {
  for (const s of list) {
    const state = s.exists ? 'ok' : 'missing'
    console.log(`${s.source.padEnd(9)} ${state.padEnd(7)} records=${String(s.records).padEnd(5)} conversation=${String(s.records - s.tools).padEnd(5)} tools=${String(s.tools).padEnd(5)} skipped=${s.skipped} ws=${s.workspaces} last=${dayOf(s.lastTs)}`)
    console.log(`          ${s.path}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv.shift()
  if (cmd === 'recall') {
    const o = flags(argv, cmd)
    if (!o) {
      console.error('--rank 可选 default、long-text 或 passage。')
      process.exitCode = 2
      return
    }
    const query = o.rest.join(' ').trim()
    if (!query) { console.error('用法：agent-memory/recall.mjs recall "查询"'); process.exit(1) }
    const hits = recall(query, o.compact ? { ...o, n: compactLimit(o.n) } : o)
    if (o.compact) { console.log(compactQuotes(hits, query, { n: o.n, refOf, tokenize: tok })); return }
    if (o.json) { console.log(JSON.stringify({ query, stores: hits.stores || [], hits }, null, 2)); return }
    if (!hits.length) { console.log('没找到。可以试 trace "<原话片段>"，或加 --with-tools。'); return }
    const count = (src) => hits.filter((h) => h.source === src).length
    console.log(`跨库召回 ${hits.length} 条（OpenCode ${count('opencode')} · DSH ${count('dsh')} · WorkBuddy ${count('workbuddy')} · ZCode ${count('zcode')} · Codex ${count('codex')}）\n`)
    for (const h of hits) {
      const quote = quoteFor(h, query)
      console.log(`[${h.source}] ${dayOf(h.ts)} ${h.workspace || '-'} ${quote.ref} ${quote.start}:${quote.end}  ${excerpt(quote.text, QUOTE_SIZE)}`)
    }
    console.log(`\n回读：node agent-memory/recall.mjs show ${refOf(hits[0])}`)
    return
  }
  if (cmd === 'trace') {
    const o = flags(argv, cmd)
    const needle = o.rest.join(' ').trim()
    if (!needle) { console.error('用法：agent-memory/recall.mjs trace "原话片段"'); process.exit(1) }
    const hits = trace(needle, o)
    if (o.compact) { console.log(compactQuotes(hits, needle, { n: o.n, refOf, tokenize: tok })); return }
    if (o.json) { console.log(JSON.stringify({ needle, hits }, null, 2)); return }
    if (!hits.length) { console.log('所有来源里都没有这段原话。'); return }
    console.log(`按字命中 ${hits.length} 条\n`)
    for (const h of hits) console.log(`[${h.source}] ${dayOf(h.ts)} ${h.workspace || '-'} ${refOf(h)}  ${excerpt(h.text)}`)
    return
  }
  if (cmd === 'show') {
    const o = flags(argv, cmd)
    const ref = parseRef(o.rest[0])
    if (!ref) { console.error('用法：agent-memory/recall.mjs show <source>:<line>'); process.exit(1) }
    const rec = readAt(ref.source, ref.line, ref.workspace)
    if (!rec) { console.error(`没找到 ${o.rest[0]}`); process.exit(1) }
    if (o.range !== undefined) {
      try {
        const value = serializeRange(rec, refOf(rec), o.range)
        console.log(o.json ? value : JSON.parse(value).text)
      } catch (error) {
        console.error('--' + error.message)
        process.exitCode = 2
      }
      return
    }
    if (o.json) { console.log(JSON.stringify(rec, null, 2)); return }
    console.log(`[${rec.source}] ${dayOf(rec.ts)} ${rec.workspace || '-'} ${refOf(rec)} · ${rec.who}/${rec.kind}`)
    console.log('')
    console.log(rec.text)
    return
  }
  if (cmd === 'sources') {
    const list = sources()
    if (argv.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return }
    printStores(list)
    return
  }
  console.log('用法：')
  console.log('  node agent-memory/recall.mjs recall "查询" [-n 8] [--source dsh] [--since 7d] [--ws 目录] [--rank default|long-text|passage] [--with-tools] [--json|--compact]')
  console.log('  node agent-memory/recall.mjs trace "原话片段" [--source dsh] [--json|--compact]')
  console.log('  node agent-memory/recall.mjs show <source>:<line> [--range start:end] [--json]')
  console.log('  node agent-memory/recall.mjs sources')
}

function casesCLI([command, ...args]) {
  const querying = command === 'recall' && args.includes('--cases')
  const reading = command === 'show' && args[0]?.startsWith('case:')
  if (!querying && !reading) return caseCommand(caseSource('codex', codexRoot()), command, [])
  const pos = args.indexOf('--source')
  if (pos < 0) return caseCommand(caseSource('codex', codexRoot(), process.cwd()), command, args)
  let source
  try {
    const alias = args[pos + 1]
    const config = JSON.parse(process.env.MEMORY_CASE_SOURCES || '{}')
    const entry = Object.hasOwn(config, alias) && config[alias]
    if (entry && ['opencode', 'codex', 'dsh', 'workbuddy', 'zcode'].includes(entry.adapter)
      && path.isAbsolute(entry.root) && path.isAbsolute(entry.fromProject) && path.isAbsolute(entry.project)
      && caseProject(entry.fromProject) === caseProject(process.cwd())) {
      const project = entry.adapter === 'dsh' ? entry.root : entry.project
      source = caseSource(entry.adapter, entry.root, project, { singleProject: entry.adapter === 'dsh' })
    }
  } catch {}
  if (!source) return JSON.stringify({ state: 'denied' })
  args.splice(pos, 2)
  return caseCommand(source, command, args)
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const output = casesCLI(process.argv.slice(2))
  if (output === null) main()
  else console.log(output)
}
