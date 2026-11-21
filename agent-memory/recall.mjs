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
import { readStream, streams } from './repo.mjs'

const DAY = 864e5
const K1 = 1.25
const B = 0.72
const MIN_COVERAGE = 0.2

const WHO = { he: 'user', me: 'assistant', act: 'action', meta: 'meta' }
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
  const who = WHO[raw.who] || raw.who || ''
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

function recency(ts, now) {
  const days = Math.max(0, (now - (ts || now)) / DAY)
  return 1 + 0.5 * Math.pow(0.5, days / 3)
}

function multiplier(rec) {
  return (KIND_WEIGHT[rec.kind] ?? 1) * (WHO_WEIGHT[rec.who] ?? 1)
}

function dedupeKey(rec) {
  const text = rec.text.replace(/\s+/g, ' ').trim()
  // 长文本按正文折叠：同一段话、每日重复的模板，不该各占一个位置。
  if (text.length >= 80) return `${rec.source}|${rec.who}|${text.slice(0, 120)}`
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

export function recall(query, opts = {}) {
  const { n = 8, now = Date.now() } = opts
  const qterms = [...new Set(tok(query))]
  if (!qterms.length) return []
  const { records, stores } = loadAll({ withTools: !!opts.withTools })
  const pool = records.filter((r) => passes(r, opts))
  if (!pool.length) return []

  const N = pool.length
  const post = new Map()
  const dl = new Array(N)
  let total = 0
  pool.forEach((rec, i) => {
    const t = tok(rec.text)
    dl[i] = t.length
    total += t.length
    const tf = new Map()
    for (const x of t) tf.set(x, (tf.get(x) || 0) + 1)
    for (const [k, v] of tf) {
      let a = post.get(k)
      if (!a) { a = []; post.set(k, a) }
      a.push(i, v)
    }
  })
  const avg = total / N || 1

  const sc = new Map()
  const hitCount = new Map()
  for (const term of qterms) {
    const a = post.get(term)
    if (!a) continue
    const df = a.length / 2
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < a.length; i += 2) {
      const id = a[i], tf = a[i + 1], L = dl[id] || 1
      sc.set(id, (sc.get(id) || 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * L / avg))))
      hitCount.set(id, (hitCount.get(id) || 0) + 1)
    }
  }

  const scored = []
  for (const [i, bm25] of sc) {
    const rec = pool[i]
    const coverage = (hitCount.get(i) || 0) / qterms.length
    if (coverage < MIN_COVERAGE) continue
    scored.push({ ...rec, score: bm25 * recency(rec.ts, now) * multiplier(rec), coverage: +coverage.toFixed(2) })
  }
  scored.sort((a, b) => b.score - a.score)

  const seen = new Set()
  const out = []
  for (const rec of scored) {
    const key = dedupeKey(rec)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rec)
    if (out.length >= n) break
  }
  if (out.length) out.stores = stores
  return out
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

function flags(args) {
  const o = { n: 8, source: null, since: null, ws: null, withTools: false, json: false, rest: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-n') o.n = Math.max(1, Number(args[++i]) || 8)
    else if (a === '--source') o.source = args[++i] || null
    else if (a === '--since') o.since = parseSince(args[++i])
    else if (a === '--ws') o.ws = args[++i] || null
    else if (a === '--with-tools') o.withTools = true
    else if (a === '--json') o.json = true
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
    const o = flags(argv)
    const query = o.rest.join(' ').trim()
    if (!query) { console.error('用法：agent-memory/recall.mjs recall "查询"'); process.exit(1) }
    const hits = recall(query, o)
    if (o.json) { console.log(JSON.stringify({ query, stores: hits.stores || [], hits }, null, 2)); return }
    if (!hits.length) { console.log('没找到。可以试 trace "<原话片段>"，或加 --with-tools。'); return }
    const count = (src) => hits.filter((h) => h.source === src).length
    console.log(`跨库召回 ${hits.length} 条（OpenCode ${count('opencode')} · DSH ${count('dsh')} · WorkBuddy ${count('workbuddy')} · ZCode ${count('zcode')} · Codex ${count('codex')}）\n`)
    for (const h of hits) {
      console.log(`[${h.source}] ${dayOf(h.ts)} ${h.workspace || '-'} ${refOf(h)}  ${excerpt(h.text)}`)
    }
    console.log(`\n回读：node agent-memory/recall.mjs show ${refOf(hits[0])}`)
    return
  }
  if (cmd === 'trace') {
    const o = flags(argv)
    const needle = o.rest.join(' ').trim()
    if (!needle) { console.error('用法：agent-memory/recall.mjs trace "原话片段"'); process.exit(1) }
    const hits = trace(needle, o)
    if (o.json) { console.log(JSON.stringify({ needle, hits }, null, 2)); return }
    if (!hits.length) { console.log('所有来源里都没有这段原话。'); return }
    console.log(`按字命中 ${hits.length} 条\n`)
    for (const h of hits) console.log(`[${h.source}] ${dayOf(h.ts)} ${h.workspace || '-'} ${refOf(h)}  ${excerpt(h.text)}`)
    return
  }
  if (cmd === 'show') {
    const o = flags(argv)
    const ref = parseRef(o.rest[0])
    if (!ref) { console.error('用法：agent-memory/recall.mjs show <source>:<line>'); process.exit(1) }
    const rec = readAt(ref.source, ref.line, ref.workspace)
    if (!rec) { console.error(`没找到 ${o.rest[0]}`); process.exit(1) }
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
  console.log('  node agent-memory/recall.mjs recall "查询" [-n 8] [--source dsh] [--since 7d] [--ws 目录] [--with-tools] [--json]')
  console.log('  node agent-memory/recall.mjs trace "原话片段" [--source dsh] [--json]')
  console.log('  node agent-memory/recall.mjs show <source>:<line>')
  console.log('  node agent-memory/recall.mjs sources')
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
