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

export const ROOT = process.env.OPENCODE_MEM_HOME || path.join(os.homedir(), '.opencode-mem')
export const STREAM = path.join(ROOT, 'stream.jsonl')
export const MARKS = path.join(ROOT, 'marks.jsonl')
export const PINS = path.join(ROOT, 'pins.json')
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
  const seq = docs.length ? (docs[docs.length - 1].seq || 0) + 1 : 1
  const row = {
    seq,
    ts: rec.ts || Date.now(),
    who: rec.who || 'user',
    kind: rec.kind || 'message',
    ws: rec.ws || '',
    sid: rec.sid || '',
    text: String(rec.text || '').slice(0, 4000),
  }
  if (!row.text.trim()) return null
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

export function recall(query, { n = 5, ws = null, now = Date.now() } = {}) {
  const docs = readAll()
  if (!docs.length) return []
  const pool = ws ? docs.filter((d) => d.ws === ws) : docs
  if (!pool.length) return []

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
  return [...sc.entries()]
    .map(([i, s]) => ({ ...pool[i], score: s * recency(pool[i].ts, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
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
