// 捕获完整性体检：只读，统计每个来源「用户轮有没有对应的助手记录」。
//
// 为什么按「轮」而不是按条数：一条用户消息就是一次提问，理应有至少一段回答。
// 回答条数受工具步数影响，不能直接比；「这一轮有没有回答」才是能跨 harness 比的量。
//
// 边界：只读 stream.jsonl，不建目录、不写缓存；工具行不参与配对（OpenCode 的工具在
// tools.jsonl 里，不在共享流里）。判定用文件顺序，不用时间戳排序——补写的旧记录
// 时间可能倒序，顺序才是写入事实。
import { pathToFileURL } from 'node:url'
import { readStream, streams } from './repo.mjs'

const USER = new Set(['he', 'user'])
const ME = new Set(['me', 'assistant'])

function kindOf(raw, source) {
  if (source === 'opencode') return String(raw.kind || raw.type || '')
  return String(raw.type || raw.kind || '')
}

function isMessage(raw, source, who) {
  const kind = kindOf(raw, source)
  const userKind = kind === 'message' || kind === 'user/message'
  const meKind = kind === 'message' || kind === 'assistant/message'
  if (who === 'user') return userKind && USER.has(raw.who)
  return meKind && ME.has(raw.who)
}

function sidOf(raw) {
  return String(raw.sid || raw.session || raw.ws || '(no-sid)')
}

// 一轮 = 一条用户消息到「下一条用户消息之前」。answered 表示这一轮里有助手消息。
function analyse(entries, source) {
  const sessions = new Map()
  for (const { row: raw, line } of entries) {
    const sid = sidOf(raw)
    let s = sessions.get(sid)
    if (!s) {
      s = { sid, turns: 0, answered: 0, assistant: 0, orphans: 0, turnsList: [], lastAssistantLine: 0 }
      sessions.set(sid, s)
    }
    if (isMessage(raw, source, 'user')) {
      s.current = { line, answered: false, ts: raw.ts || 0 }
      s.turns += 1
      s.turnsList.push(s.current)
      continue
    }
    if (isMessage(raw, source, 'assistant')) {
      s.assistant += 1
      s.lastAssistantLine = line
      if (s.current) s.current.answered = true
      else s.orphans += 1
    }
  }
  for (const s of sessions.values()) {
    s.unanswered = 0
    s.silent = 0
    for (const turn of s.turnsList) {
      if (turn.answered) { s.answered += 1; continue }
      const ref = { line: turn.line, ts: turn.ts }
      s.unanswered += 1
      s.firstMissing ??= ref
      if (turn.line > s.lastAssistantLine) {
        s.silent += 1
        s.firstSilent ??= ref
      }
    }
  }
  return sessions
}

function toolPairing(rows, source) {
  const calls = new Map()
  const results = new Map()
  for (const raw of rows) {
    const kind = kindOf(raw, source)
    const id = raw.callId || raw.callID || raw.tool_call_id || null
    if (!id) continue
    const key = JSON.stringify([sidOf(raw), id])
    if (kind === 'tool/call') calls.set(key, raw)
    else if (kind === 'tool/result') results.set(key, raw)
  }
  let noResult = 0
  let noCall = 0
  for (const id of calls.keys()) if (!results.has(id)) noResult += 1
  for (const id of results.keys()) if (!calls.has(id)) noCall += 1
  return { calls: calls.size, results: results.size, noResult, noCall }
}

export function coverage({ source = null, since = null, now = Date.now() } = {}) {
  const { list } = streams()
  const out = []
  for (const entry of list) {
    if (source && entry.source !== source) continue
    const file = entry.path
    const data = readStream(file)
    const entries = since ? data.entries.filter(({ row }) => !row.ts || row.ts >= since) : data.entries
    const rows = entries.map(({ row }) => row)
    const sessions = analyse(entries, entry.source)
    const tools = toolPairing(rows, entry.source)
    let turns = 0
    let answered = 0
    let assistant = 0
    let unanswered = 0
    let silent = 0
    let lastTs = 0
    const worst = []
    const worstSilent = []
    for (const s of sessions.values()) {
      turns += s.turns
      answered += s.answered
      assistant += s.assistant
      unanswered += s.unanswered
      silent += s.silent
      if (s.unanswered) {
        worst.push({ sid: s.sid, turns: s.turns, answered: s.answered, missing: s.unanswered, firstMissing: s.firstMissing })
      }
      if (s.silent) {
        worstSilent.push({ sid: s.sid, silentCount: s.silent, first: s.firstSilent })
      }
    }
    for (const r of rows) if (Number(r.ts) > lastTs) lastTs = Number(r.ts)
    worst.sort((a, b) => b.missing - a.missing)
    out.push({
      source: entry.source,
      workspace: entry.workspace,
      path: file,
      exists: !data.missing,
      records: rows.length,
      skipped: data.skipped,
      sessions: sessions.size,
      turns,
      answered,
      unanswered,
      // 用户连发：后面还有回答，只是合并到了下一轮。
      followup: unanswered - silent,
      // 硬缺口：整场会话后面也没有任何助手记录。
      silent,
      rate: turns ? +(answered / turns).toFixed(3) : null,
      // 有效覆盖：把「连发」算子轮的一部分。
      effective: turns ? +((answered + (unanswered - silent)) / turns).toFixed(3) : null,
      assistant,
      orphanAssistant: [...sessions.values()].reduce((n, s) => n + s.orphans, 0),
      tools,
      lastTs,
      worst: worst.slice(0, 5),
      worstSilent: worstSilent.slice(0, 5),
    })
  }
  // 与 recall.mjs 保持同一来源顺序，输出才稳定可比。
  const order = { opencode: 0, dsh: 1, workbuddy: 2, zcode: 3, codex: 4 }
  out.sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9))
  return out
}

function day(ts) {
  if (!ts) return '----------'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function format(rows) {
  const lines = []
  const head = ['source', 'ok', 'sessions', 'turns', 'answered', 'missing', 'followup', 'silent', 'rate', 'eff', 'assistant', 'tool', 'noResult', 'last']
  const widths = [10, 8, 8, 6, 8, 7, 8, 6, 7, 7, 9, 7, 8, 10]
  const pad = (v, i) => String(v).padEnd(widths[i])
  lines.push(head.map(pad).join(' '))
  for (const r of rows) {
    lines.push([
      r.source, r.exists ? 'ok' : 'missing', r.sessions, r.turns, r.answered, r.unanswered, r.followup, r.silent,
      r.rate === null ? '-' : (r.rate * 100).toFixed(1) + '%',
      r.effective === null ? '-' : (r.effective * 100).toFixed(1) + '%',
      r.assistant, r.tools.calls, r.tools.noResult, day(r.lastTs),
    ].map(pad).join(' '))
    lines.push('          ' + r.path)
  }
  return lines.join('\n')
}

function parseSince(value) {
  if (!value) return null
  const m = /^(\d+)([dhm])$/.exec(value)
  if (m) {
    const n = Number(m[1])
    return Date.now() - n * (m[2] === 'd' ? 864e5 : m[2] === 'h' ? 36e5 : 6e4)
  }
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

function main() {
  const argv = process.argv.slice(2)
  const opts = { source: null, since: null, json: false, worst: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--worst') opts.worst = true
    else if (a === '--source') opts.source = argv[++i] || null
    else if (a === '--since') opts.since = parseSince(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log('用法：node agent-memory/coverage.mjs [--source opencode|dsh|workbuddy|zcode|codex] [--since 7d] [--json] [--worst]')
      return
    }
  }
  const rows = coverage(opts)
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return }
  console.log(format(rows))
  if (opts.worst) {
    for (const r of rows) {
      if (r.worstSilent.length) {
        console.log(`\n[${r.source}] 整场后面没有任何回答（硬缺口）：`)
        for (const w of r.worstSilent) console.log(`  · ${w.sid.slice(0, 40)}  缺 ${w.silentCount}  first=${r.source}:${w.first.line}`)
      }
      if (!r.worst.length) continue
      console.log(`\n[${r.source}] 严格口径缺失最多的会话：`)
      for (const w of r.worst) console.log(`  · ${w.sid.slice(0, 40)}  轮 ${w.turns} / 答 ${w.answered} / 缺 ${w.missing}  first=${r.source}:${w.firstMissing.line}`)
    }
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
