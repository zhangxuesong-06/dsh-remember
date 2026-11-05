// mem-core —— 记忆的存储与检索。CLI 和 OpenCode 插件共用这一份。
//
// 设计跟 dsh-memory 一致：
//   原文只追加；摘要只当索引；真相永远回原话。
//
// 存储位置是全局的（~/.opencode-mem），每条记录带 ws 标签。
// 换文件夹不该等于换一个人——ws 只用来过滤，不用来隔离。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { facetsOf, parseScope, matchScope, expandQuery, buildMap, vocabFromAliases, suggestAlias } from './mem-facets.mjs'
import { buildAssoc, expandAssoc, assocStats } from './mem-assoc.mjs'

export const ROOT = process.env.OPENCODE_MEM_HOME || path.join(os.homedir(), '.opencode-mem')
export const STREAM = path.join(ROOT, 'stream.jsonl')
export const MARKS = path.join(ROOT, 'marks.jsonl')
export const PINS = path.join(ROOT, 'pins.json')
export const ALIASES = path.join(ROOT, 'aliases.json')
export const ASSOC = path.join(ROOT, 'assoc.json')
export const DIAG = path.join(ROOT, 'diag.log')

export function ensure() {
  fs.mkdirSync(ROOT, { recursive: true })
}

export function diag(msg) {
  try {
    ensure()
    fs.appendFileSync(DIAG, `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch {}
}

export function readAll() {
  try {
    const out = []
    for (const line of fs.readFileSync(STREAM, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  } catch { return [] }
}

export function readMarks() {
  try {
    return fs.readFileSync(MARKS, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

export function readPins() {
  try { return JSON.parse(fs.readFileSync(PINS, 'utf8')) } catch { return {} }
}

export function setPin(key, text) {
  ensure()
  const p = readPins()
  p[key] = { text, ts: Date.now() }
  fs.writeFileSync(PINS, JSON.stringify(p, null, 2), 'utf8')
}

export function append(rec) {
  ensure()
  const docs = readAll()
  const text = String(rec.text || '').slice(0, 4000)
  if (!text.trim()) return null

  // 跨进程去重：插件重启会丢掉内存里的去重表，同一段话会被再记一遍。
  // 只看最近 300 条、24 小时内——再往前的重复是真重复，不该吞。
  const norm = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  const cutoff = Date.now() - 24 * 3600e3
  for (let i = docs.length - 1; i >= 0 && i >= docs.length - 300; i--) {
    const d = docs[i]
    if (!d || d.ts < cutoff) break
    if (String(d.text).replace(/\s+/g, ' ').trim().slice(0, 200) === norm) return null
  }

  const seq = docs.length ? (docs[docs.length - 1].seq || 0) + 1 : 1
  const row = {
    seq,
    ts: rec.ts || Date.now(),
    who: rec.who || 'user',
    kind: rec.kind || 'message',
    ws: rec.ws || '',
    sid: rec.sid || '',
    text,
  }
  fs.appendFileSync(STREAM, JSON.stringify(row) + '\n', 'utf8')
  return row
}

export function mark(text, key = null, ws = '') {
  ensure()
  const row = { ts: Date.now(), key, ws, text: String(text || '').slice(0, 2000) }
  fs.appendFileSync(MARKS, JSON.stringify(row) + '\n', 'utf8')
  return row
}

// —— 分词：中文 bigram + 英文词 ——
const CJK = /[\u4e00-\u9fff]+/g
const LATIN = /[a-zA-Z][a-zA-Z0-9_.\-]*/g
export function tok(s) {
  const o = []
  for (const m of String(s).matchAll(CJK)) {
    const r = m[0]
    if (r.length === 1) o.push(r)
    else for (let i = 0; i + 1 < r.length; i++) o.push(r.slice(i, i + 2))
  }
  for (const m of String(s).matchAll(LATIN)) o.push(m[0].toLowerCase())
  return o
}

const DAY = 864e5

// 时间衰减：幂律，不是指数。近期陡、远期平。
function recency(ts, now = Date.now()) {
  const days = Math.max(0, (now - (ts || now)) / DAY)
  const t0 = 0.25, alpha = 0.8, floor = 0.03
  return floor + (1 - floor) * Math.pow(1 + days / t0, -alpha)
}

export function recall(query, { n = 5, ws = null, scope = null, now = Date.now() } = {}) {
  const docs = readAll()
  if (!docs.length) return []
  let pool = ws ? docs.filter((d) => d.ws === ws) : docs
  if (!pool.length) return []

  // 别名表既用于扩展查询，也当实体词表——模型加词，代码匹配。
  const aliases = readAliases()
  const vocab = vocabFromAliases(aliases)

  // scope 只缩范围，不改排序。范围里没东西就退回全库——宁可多给，也别假装没有。
  const filter = parseScope(scope)
  let scopeNote = ''
  if (filter) {
    const narrowed = pool.filter((d) => matchScope(facetsOf(d.text, vocab), filter))
    if (narrowed.length) {
      pool = narrowed
    } else {
      scopeNote = `scope ${scope} 里没有命中，已退回全库`
    }
  }

  // 别名扩展：同义词表是模型能维护的那部分，错了也只是召回差一点。
  const { extra, hit } = expandQuery(query, aliases)

  const post = new Map()
  const dl = []
  let total = 0
  pool.forEach((d, i) => {
    const t = tok(d.text)
    dl.push(t.length); total += t.length
    const tf = new Map()
    for (const x of t) tf.set(x, (tf.get(x) || 0) + 1)
    for (const [k, v] of tf) {
      let a = post.get(k); if (!a) { a = []; post.set(k, a) }
      a.push(i, v)
    }
  })
  const N = pool.length, avg = total / N || 1, K1 = 1.25, B = 0.72
  const sc = new Map()
  const add = (term, weight) => {
    const a = post.get(term); if (!a) return
    const df = a.length / 2
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) * weight
    for (let i = 0; i < a.length; i += 2) {
      const id = a[i], tf = a[i + 1], L = dl[id] || 1
      sc.set(id, (sc.get(id) || 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * L / avg))))
    }
  }
  for (const t of new Set(tok(query))) {
    if (t.length === 1 && /[\u4e00-\u9fff]/.test(t)) {
      for (const k of post.keys()) if (k.length === 2 && k.includes(t)) add(k, 0.35)
    } else add(t, 1)
  }
  for (const w of extra) for (const t of new Set(tok(w))) add(t, 0.7)

  // 联想扩展：共现推出来的关系，权重比别名低一档。
  // 别名是「有人说过它们同义」，联想只是「老一起出现」——后者更容易错。
  // 图过期了就现重建一次（小库），大库交给 assoc build 手动跑。
  let assocDoc = readAssoc()
  const stale = !assocDoc || Math.abs((assocDoc.meta && assocDoc.meta.docCount || 0) - docs.length)
    > Math.max(10, Math.round(docs.length * 0.15))
  if (stale && docs.length <= 3000) {
    try { buildAssocIndex(); assocDoc = readAssoc() } catch {}
  }
  const assocHit = assocDoc ? expandAssoc(query, assocDoc.map) : { extra: [], hit: [] }
  for (const w of assocHit.extra) for (const t of new Set(tok(w))) add(t, 0.35)

  // 覆盖率：查询里的词，这条记录命中了几成。
  // BM25 永远能返回点什么——「量子纠缠」也会因为「时间」两个字命中一条无关记录。
  // 所以"空召回"几乎不存在，触发提示要靠覆盖率，不能靠 hits.length。
  const qterms = [...new Set(tok(query))]
  const hitCount = new Map()
  for (const t of qterms) {
    const a = post.get(t)
    if (!a) continue
    for (let i = 0; i < a.length; i += 2) hitCount.set(a[i], (hitCount.get(a[i]) || 0) + 1)
  }
  const coverage = (id) => (qterms.length ? (hitCount.get(id) || 0) / qterms.length : 0)

  const minCoverage = 0.2
  const out = [...sc.entries()]
    .filter(([i]) => coverage(i) >= minCoverage)
    .map(([i, s]) => ({ ...pool[i], score: s * recency(pool[i].ts, now), coverage: +coverage(i).toFixed(2) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
  if (scopeNote) out.note = scopeNote
  if (hit.length) out.aliasHit = hit
  if (assocHit.hit.length) out.assocHit = assocHit.hit
  if (!out.length) out.hint = suggestAlias(query, docs)
  return out
}

// 记忆地图：从 facet 现算，只读。
export function map(opts = {}) {
  const vocab = vocabFromAliases(readAliases())
  return buildMap(readAll(), { ...opts, vocab })
}

// 联想图：从共现现算，存一份缓存。过期了就忽略，不阻塞查询。
export function readAssoc() {
  try {
    const j = JSON.parse(fs.readFileSync(ASSOC, 'utf8'))
    return j && j.map ? j : null
  } catch { return null }
}

export function buildAssocIndex(opts = {}) {
  const docs = readAll()
  const vocab = vocabFromAliases(readAliases())
  const map = buildAssoc(docs, { ...opts, vocab })
  const meta = {
    builtAt: Date.now(),
    docCount: docs.length,
    lastSeq: docs.length ? docs[docs.length - 1].seq : 0,
    ...assocStats(map),
  }
  ensure()
  fs.writeFileSync(ASSOC, JSON.stringify({ meta, map }), 'utf8')
  return meta
}

export function assocNeighbors(term) {
  const j = readAssoc()
  if (!j) return null
  const t = String(term || '').toLowerCase()
  return j.map[t] || []
}

// 别名表：模型可以加，错了只是局部影响。
export function readAliases() {
  try { return JSON.parse(fs.readFileSync(ALIASES, 'utf8')) } catch { return {} }
}

export function addAlias(term, synonyms) {
  ensure()
  const t = String(term || '').trim()
  if (!t) return null
  const list = (Array.isArray(synonyms) ? synonyms : String(synonyms || '').split(/[,，\s]+/))
    .map((x) => String(x).trim()).filter(Boolean)
  const a = readAliases()
  const key = Object.keys(a).find((k) => k.toLowerCase() === t.toLowerCase()) || t
  const set = new Set([...(a[key] || []), ...list])
  a[key] = [...set]
  fs.writeFileSync(ALIASES, JSON.stringify(a, null, 2), 'utf8')
  return { key, synonyms: a[key] }
}

// 按字查：一字不差，返回归属。
export function trace(query, { limit = 20 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  return readAll()
    .filter((d) => d.text.includes(q))
    .slice(-limit)
    .map((d) => ({ ...d, attribution: d.who === 'user' ? '他说的' : d.who === 'assistant' ? '我说的' : '工具' }))
}

export function stats() {
  const docs = readAll()
  const byKind = {}
  const byWs = {}
  for (const d of docs) {
    byKind[d.kind] = (byKind[d.kind] || 0) + 1
    byWs[d.ws] = (byWs[d.ws] || 0) + 1
  }
  let bytes = 0
  try { bytes = fs.statSync(STREAM).size } catch {}
  return { total: docs.length, bytes, byKind, byWs, marks: readMarks().length, pins: Object.keys(readPins()).length }
}

export const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10)
