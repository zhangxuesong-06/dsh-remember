// 从 ZCode 自己的数据库回填缺失的助手回答（只读数据库，只追加共享流）。
//
// 背景：Stop 钩子在部分轮拿不到 last_assistant_message（用户紧接着发下一条、轮被中断、
// 长工具链结束时都可能），于是流里只有用户话和工具记录，没有那轮的回答。
// ZCode 的 db.sqlite 里有完整 message/part，这里按「用户消息 → 下一条用户消息」的时间窗，
// 取该轮最后一条 assistant text part 回填。
//
// 边界：
//   - 只读 db.sqlite；只追加 stream.jsonl；不改任何历史记录。
//   - 以 eventKey + 正文哈希双重去重，重复执行不增行。
//   - 找不到正文的窗口只计数，不猜；来源标 db.backfill。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOME, STREAM, diag, wsNameOf, wsOf } from '../lib/config.mjs'
import { append } from '../lib/journal.mjs'
import { artifactPaths, putBlob, sha256, snapshot } from '../lib/evidence.mjs'

const has = (name) => process.argv.includes('--' + name)
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] || '') : fallback
}

function readRows(file) {
  const rows = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return rows }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r) } catch {}
  }
  return rows
}

async function openDb(file) {
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (error) {
    throw new Error('当前 Node 没有 node:sqlite（需要 22.5+）：' + error.message)
  }
  return new DatabaseSync(file, { readOnly: true })
}

function windowsOf(rows, session) {
  const mine = rows.filter((r) => r.sid === session && r.type === 'user/message' && r.ts && r.turn)
  mine.sort((a, b) => a.ts - b.ts)
  const end = Date.now() + 365 * 864e5
  return mine.map((r, i) => ({
    turn: r.turn, from: r.ts, to: i + 1 < mine.length ? mine[i + 1].ts : end,
    ws: r.ws || null, wsName: r.wsName || null,
  }))
}

export async function backfill({ dbPath, session = null, since = null, dryRun = false } = {}) {
  const file = dbPath || process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  if (!fs.existsSync(file)) throw new Error('找不到 ZCode 数据库：' + file)
  const rows = readRows(STREAM)
  const sessions = [...new Set(rows.filter((r) => r.type === 'user/message' && r.sid).map((r) => r.sid))]
  const targets = session ? sessions.filter((s) => s === session) : sessions
  const db = await openDb(file)
  const q = db.prepare(`
    select p.time_created ts, json_extract(p.data,'$.text') text
    from part p join message m on m.id = p.message_id
    where p.session_id=? and json_extract(m.data,'$.role')='assistant'
      and json_extract(p.data,'$.type')='text' and p.time_created > ? and p.time_created < ?
    order by p.time_created desc limit 1
  `)
  const assistantTexts = new Map()
  for (const r of rows) {
    if (r.type !== 'assistant/message' || !r.sid || !r.text) continue
    const set = assistantTexts.get(r.sid) || new Set()
    set.add(sha256(r.text))
    assistantTexts.set(r.sid, set)
  }

  const report = { db: file, dryRun, sessions: 0, windows: 0, already: 0, filled: 0, noText: 0, duplicate: 0, rows: [] }
  try {
    for (const sid of targets) {
      report.sessions += 1
      const windows = windowsOf(rows, sid).filter((w) => !since || w.from >= since)
      const haveAssistantTurn = new Set(rows.filter((r) => r.sid === sid && r.type === 'assistant/message').map((r) => r.turn))
      const seen = assistantTexts.get(sid) || new Set()
      for (const w of windows) {
        report.windows += 1
        if (haveAssistantTurn.has(w.turn)) { report.already += 1; continue }
        let hit = null
        try { hit = q.get(sid, w.from, w.to) } catch (error) { throw new Error('查询失败（schema 可能变了）：' + error.message) }
        const text = String((hit && hit.text) || '').trim()
        if (!text) { report.noText += 1; continue }
        const hash = sha256(text)
        if (seen.has(hash)) { report.duplicate += 1; continue }
        const rec = {
          who: 'me', ts: hit.ts || w.from, ws: w.ws, wsName: w.wsName, sid, turn: w.turn,
          text, type: 'assistant/message',
          eventKey: `assistant:${sid}:${w.turn}:backfill:${hash.slice(0, 8)}`,
          source: { type: 'db.backfill' },
        }
        report.rows.push({ sid, turn: w.turn, bytes: Buffer.byteLength(text, 'utf8') })
        if (!dryRun) {
          const saved = append(rec, { dedupe: false })
          if (saved) { report.filled += 1; seen.add(hash); haveAssistantTurn.add(w.turn) }
        } else {
          report.filled += 1
          seen.add(hash)
          haveAssistantTurn.add(w.turn)
        }
      }
    }
  } finally { db.close() }
  if (report.filled && !dryRun) diag(`backfill：补 ${report.filled} 条助手回答（${file}）`)
  return report
}

// ——— 子代理 ———
// 子代理的 user 消息是主模型派发的任务提示，不是用户原话；这里只补
// 「任务提示（标 meta）→ 工具调用 → 工具结果 → 产物」这条证据链，
// 不把模型之间的对话写成「我说过的话」。
export async function backfillSubagents({ dbPath, session = null, dryRun = false } = {}) {
  const file = dbPath || process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  if (!fs.existsSync(file)) throw new Error('找不到 ZCode 数据库：' + file)
  const existing = new Set(readRows(STREAM).map((r) => r.eventKey).filter(Boolean))
  const db = await openDb(file)
  const report = { mode: 'subagents', db: file, dryRun, sessions: 0, tools: 0, filled: 0, skipped: 0 }
  const apply = (rec) => {
    if (rec.eventKey && existing.has(rec.eventKey)) { report.skipped += 1; return }
    if (dryRun) { report.filled += 1; if (rec.eventKey) existing.add(rec.eventKey); return }
    const saved = append(rec, { dedupe: false })
    if (saved) { report.filled += 1; if (rec.eventKey) existing.add(rec.eventKey) } else report.skipped += 1
  }
  try {
    const sql = `select id, parent_id, directory, task_type, title, time_created from session
      where task_type='subagent_child'${session ? ' and id=?' : ''} order by time_created`
    const subs = session ? db.prepare(sql).all(session) : db.prepare(sql).all()
    for (const s of subs) {
      report.sessions += 1
      const dir = s.directory || process.cwd()
      const ws = wsOf(dir)
      const wsName = wsNameOf(dir)
      const link = { type: 'db.subagent', parentSessionId: s.parent_id || null, taskType: s.task_type }

      const task = db.prepare(`
        select p.data, p.time_created from part p join message m on m.id=p.message_id
        where p.session_id=? and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text'
        order by p.time_created limit 1
      `).get(s.id)
      if (task) {
        const text = String(JSON.parse(task.data).text || '').trim()
        if (text) {
          apply({
            who: 'meta', type: 'subagent/task', ts: task.time_created, ws, wsName, sid: s.id,
            text: `子代理任务：${clip(text, 200)}`,
            eventKey: `sub:${s.id}:task`, evidence: putBlob(HOME, text), source: link,
          })
        }
      }

      const parts = db.prepare(`
        select data, time_created from part
        where session_id=? and json_extract(data,'$.type')='tool' order by time_created
      `).all(s.id)
      for (const p of parts) {
        report.tools += 1
        let d
        try { d = JSON.parse(p.data) } catch { continue }
        const tool = String(d.tool || 'tool')
        const callId = d.callID || sha256(tool + '\0' + stringify(d.state && d.state.input)).slice(0, 16)
        const input = d.state && d.state.input
        const output = d.state && (d.state.output !== undefined ? d.state.output : d.state.error)
        const status = d.state && d.state.status === 'completed' ? 'completed' : 'error'
        const at = p.time_created || Date.now()
        const inputText = stringify(input ?? '')
        apply({
          who: 'act', type: 'tool/call', ts: at, ws, wsName, sid: s.id, tool, callId,
          text: `子代理调了 ${tool}：${clip(inputText, 1000)}`,
          ...(inputText ? { evidence: putBlob(HOME, inputText) } : {}),
          eventKey: `sub:${s.id}:${callId}:call`,
          source: link,
        })
        const outText = stringify(output ?? '')
        apply({
          who: 'act', type: 'tool/result', ts: at, ws, wsName, sid: s.id, tool, callId, status,
          text: status === 'error'
            ? `子代理执行 ${tool} 失败：${clip(outText || '无错误详情', 400)}`
            : (outText.length > 400 ? `子代理执行 ${tool}：结果已存为证据` : `子代理执行 ${tool}：${clip(outText, 400)}`),
          ...(outText ? { evidence: putBlob(HOME, outText) } : {}),
          eventKey: `sub:${s.id}:${callId}:result`,
          source: link,
        })
        if (status !== 'completed') continue
        for (const target of artifactPaths(tool, input, dir)) {
          const after = snapshot(HOME, target, 2 * 1024 * 1024)
          if (after.state !== 'saved') continue
          apply({
            who: 'act', type: 'artifact', ts: at, ws, wsName, sid: s.id, tool, callId,
            text: `子代理写入 ${target}；工具 ${tool} 已完成；版本 ${after.sha256}`,
            artifact: true, path: target,
            // 子代理是事后回填，拿不到历史版本；只保当前快照，标 before unknown。
            versions: { path: target, before: { state: 'unknown' }, after },
            eventKey: `sub:${s.id}:${callId}:result:artifact:${target}`,
            source: { type: 'db.subagent.observation', parentSessionId: s.parent_id || null, callId },
          })
        }
      }
    }
  } finally { db.close() }
  if (report.filled && !dryRun) diag(`backfill --subagents：补 ${report.filled} 条子代理证据（${file}）`)
  return report
}

function stringify(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function clip(s, n) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= n ? text : text.slice(0, n) + '…'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sinceRaw = arg('since')
  let since = null
  if (sinceRaw) {
    const m = /^(\d+)([dhm])$/.exec(sinceRaw)
    since = m ? Date.now() - Number(m[1]) * (m[2] === 'd' ? 864e5 : m[2] === 'h' ? 36e5 : 6e4) : Date.parse(sinceRaw)
    if (!Number.isFinite(since)) { console.error('--since 只认 7d / 12h / 30m 或日期'); process.exitCode = 1; process.exit() }
  }
  const opts = { dbPath: arg('db'), session: arg('session'), dryRun: has('dry-run') }
  const run = has('subagents') ? backfillSubagents(opts) : backfill({ ...opts, since })
  run.then((r) => { console.log(JSON.stringify(r, null, 2)) })
    .catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 1 })
}
