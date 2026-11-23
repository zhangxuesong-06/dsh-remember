// 只增不改的流。钩子进程走的「瘦写入」路径：
// 只读尾部去重、拼一行、追加、fsync，不建反排索引——索引在常驻 MCP 里做。
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync,
  readSync, statSync, writeFileSync, fsyncSync,
} from 'node:fs'
import { HOME, MARKS, STREAM, loadCfg, diag, redact } from './config.mjs'
import { createIntegrity, sha256 } from './evidence.mjs'

const TAIL_LINES = 2000
const RECENT_LINES = 40

function readFrom(file, start, end) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(Math.max(0, end - start))
    if (buf.length) readSync(fd, buf, 0, buf.length, start)
    return buf
  } finally { if (fd !== null) try { closeSync(fd) } catch {} }
}

// 尾部窗口：eventKey 去重 + 内容指纹去重都在这里取。
function tailState() {
  const keys = new Set()
  const recent = new Map()
  let size = 0
  try { size = statSync(STREAM).size } catch { return { keys, recent, size: 0 } }
  // 从尾部倒着取一段：够 TAIL_LINES 行就停。
  let chunk = Math.min(size, 1024 * 1024)
  let text = ''
  let start = size
  while (start > 0 && (text.match(/\n/g) || []).length < TAIL_LINES && chunk <= 8 * 1024 * 1024) {
    start = Math.max(0, size - chunk)
    text = readFrom(STREAM, start, size).toString('utf8')
    chunk *= 2
  }
  let lines = text.split('\n').filter((l) => l.trim())
  if (start > 0) lines = lines.slice(1) // 第一行可能被截断
  lines = lines.slice(-TAIL_LINES)
  for (const line of lines) {
    try {
      const d = JSON.parse(line)
      if (d.eventKey) keys.add(d.eventKey)
    } catch {}
  }
  for (const line of lines.slice(-RECENT_LINES)) {
    try {
      const d = JSON.parse(line)
      if (d.who !== 'he' && d.who !== 'me') continue
      if (!d.text) continue
      recent.set(fpOf(d), d.ts || 0)
    } catch {}
  }
  return { keys, recent, size }
}

function fpOf(d) {
  const text = String(d.text || '')
  return `${d.who}|${d.sid || ''}|${text.length}|${text.slice(0, 48)}|${text.slice(-24)}`
}

export function writeLine(rec) {
  const line = JSON.stringify(rec) + '\n'
  const fd = openSync(STREAM, 'a', 0o600)
  try { writeFileSync(fd, line, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  return Buffer.byteLength(line, 'utf8')
}

// 追加一条。返回 null 表示被去重/被拦掉，否则返回落盘记录。
export function append(rec, opts = {}) {
  const cfg = opts.cfg || loadCfg()
  if (cfg.enabled === false) return null
  let text = String(rec.text || '')
  if (!text) return null
  if (cfg.redact) text = redact(text)

  const d = {
    ts: rec.ts || Date.now(),
    who: rec.who || null,
    ws: rec.ws || null,
    wsName: rec.wsName || null,
    sid: rec.sid || null,
    turn: rec.turn ?? null,
    text,
    tool: rec.tool || null,
    type: rec.type || null,
    hash: sha256(text),
  }
  for (const key of ['id', 'eventKey', 'messageID', 'turnID', 'source', 'evidence', 'versions', 'workspace',
    'files', 'status', 'artifact', 'completion', 'callId', 'path']) {
    if (rec[key] !== undefined && rec[key] !== null) d[key] = rec[key]
  }

  mkdirSync(HOME, { recursive: true })
  const tail = tailState()
  if (d.eventKey && tail.keys.has(d.eventKey)) return null

  const speech = d.who === 'he' || d.who === 'me'
  const dedupe = opts.dedupe !== false && !d.eventKey
  if (speech && dedupe) {
    const at = tail.recent.get(fpOf(d))
    const winMs = text.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
    // 尾部窗口里记的是「写进来的时刻」还是事件时刻分不清，两种都挡。
    if (at && Math.abs(d.ts - at) < winMs) return null
  }

  writeLine(d)
  // 小库才每次重算基线；大库让 maintenance / cli sync 收口，别在钩子热路径上做 O(N)。
  if (tail.size < 2 * 1024 * 1024) {
    try { createIntegrity(HOME, ['stream.jsonl', 'marks.jsonl']).record('stream.jsonl') } catch (e) {
      diag('integrity 记录失败：' + (e && e.message))
    }
  }
  return d
}

// 显式记下的一条笔记：marks.jsonl 是事实，stream 里镜像一条，跨库 recall 才看得见。
export function mark({ key, text, weight = 1, ws = null, wsName = null, sid = null }) {
  const body = String(text || '')
  if (!body) return null
  mkdirSync(HOME, { recursive: true })
  const rec = {
    ts: Date.now(), key: key || null, text: body, weight,
    id: sha256(Date.now() + '|' + (key || '') + '|' + body).slice(0, 16), hash: sha256(body),
  }
  appendFileSync(MARKS, JSON.stringify(rec) + '\n', 'utf8')
  try { createIntegrity(HOME, ['stream.jsonl', 'marks.jsonl']).record('marks.jsonl') } catch (e) {
    diag('integrity 记录失败：' + (e && e.message))
  }
  append({
    who: 'assistant', ts: rec.ts, ws, wsName, sid, text: body, type: 'note',
    eventKey: 'mark:' + rec.id, source: { type: 'mark', markID: rec.id },
  }, { dedupe: false })
  return rec
}

export function readMarks() {
  const out = []
  try {
    const txt = readFileSync(MARKS, 'utf8')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  return out
}
