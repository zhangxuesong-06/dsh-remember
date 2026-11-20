// 从 ZCode 自己的数据库回填缺失的助手回答（只读数据库，只追加共享流）。
//
// 背景：Stop 钩子在部分轮拿不到 last_assistant_message（用户紧接着发下一条、轮被中断、
// 长工具链结束时都可能），于是流里只有用户话和工具记录，没有那轮的回答。
// ZCode 的 db.sqlite 里有完整 message/part，这里按「用户消息 → 下一条用户消息」的时间窗，
// 取该轮最后一条 assistant text part 回填。
//
// 边界：
//   - 只读 db.sqlite；只追加 stream.jsonl；不改任何历史记录。
//   - 按会话和轮次检查已捕获回答，复用 Stop 的 eventKey。
//   - 找不到正文的窗口只计数，不猜；来源标 db.backfill。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOME, STREAM, diag, wsNameOf, wsOf } from '../lib/config.mjs'
import { append } from '../lib/journal.mjs'
import { assistantRecords, clip, stringify } from '../lib/events.mjs'
import { artifactPaths, putBlob, scan, sha256, snapshot } from '../lib/evidence.mjs'

const has = (name) => process.argv.includes('--' + name)
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] || '') : fallback
}

async function openDb(file) {
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (error) {
    throw new Error('当前 Node 没有 node:sqlite（需要 22.5+）：' + error.message)
  }
  return new DatabaseSync(file, { readOnly: true })
}

function windowsOf(prompts) {
  const ordered = prompts.filter((r) => r.ts && r.turn).sort((a, b) => a.ts - b.ts)
  const end = Date.now() + 365 * 864e5
  return ordered.map((r, i) => ({
    turn: r.turn, from: r.ts, to: ordered[i + 1]?.ts ?? end,
    ws: r.ws || null, wsName: r.wsName || null,
  }))
}

export async function backfill({ dbPath, session = null, since = null, dryRun = false } = {}) {
  const file = dbPath || process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  if (!fs.existsSync(file)) throw new Error('找不到 ZCode 数据库：' + file)
  const prompts = new Map()
  const answered = new Map()
  for (const row of scan(STREAM).rows) {
    const sid = row.sid
    if (!sid || (session && sid !== session)) continue
    if (row.type === 'user/message') {
      if (!prompts.has(sid)) prompts.set(sid, [])
      prompts.get(sid).push(row)
    } else if (row.type === 'assistant/message') {
      if (!answered.has(sid)) answered.set(sid, new Set())
      answered.get(sid).add(row.turn)
    }
  }
  const db = await openDb(file)
  const report = { db: file, dryRun, sessions: 0, windows: 0, already: 0, filled: 0, noText: 0, duplicate: 0, rows: [] }
  try {
    const q = db.prepare(`
      select p.time_created ts, json_extract(p.data,'$.text') text
      from part p join message m on m.id = p.message_id
      where p.session_id=? and json_extract(m.data,'$.role')='assistant'
        and json_extract(p.data,'$.type')='text' and p.time_created > ? and p.time_created < ?
      order by p.time_created desc limit 1
    `)
    for (const [sid, sessionPrompts] of prompts) {
      report.sessions += 1
      const windows = windowsOf(sessionPrompts).filter((w) => !since || w.from >= since)
      const haveAssistantTurn = answered.get(sid) || new Set()
      for (const w of windows) {
        report.windows += 1
        if (haveAssistantTurn.has(w.turn)) { report.already += 1; continue }
        let hit = null
        try { hit = q.get(sid, w.from, w.to) } catch (error) { throw new Error('查询失败（schema 可能变了）：' + error.message) }
        const [rec] = assistantRecords({ ...w, sid, last: hit?.text, ts: hit?.ts || w.from })
        if (!rec) { report.noText += 1; continue }
        rec.source = { type: 'db.backfill' }
        if (!dryRun && !append(rec)) { report.duplicate += 1; continue }
        report.filled += 1
        haveAssistantTurn.add(w.turn)
        report.rows.push({ sid, turn: w.turn, bytes: Buffer.byteLength(rec.text, 'utf8') })
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
  const existing = new Set(scan(STREAM).rows.map((r) => r.eventKey).filter(Boolean))
  const db = await openDb(file)
  const report = { mode: 'subagents', db: file, dryRun, sessions: 0, tools: 0, filled: 0, skipped: 0 }
  const apply = (eventKey, build) => {
    if (existing.has(eventKey)) { report.skipped += 1; return }
    const rec = build()
    if (!rec) return
    if (dryRun || append({ ...rec, eventKey })) {
      report.filled += 1
      existing.add(eventKey)
    } else report.skipped += 1
  }
  const evidenceOf = (body) => body && !dryRun ? putBlob(HOME, body) : undefined
  try {
    const sql = `select id, parent_id, directory, task_type, title, time_created from session
      where task_type='subagent_child'${session ? ' and id=?' : ''} order by time_created`
    const subs = session ? db.prepare(sql).all(session) : db.prepare(sql).all()
    const taskBySession = db.prepare(`
      select p.data, p.time_created from part p join message m on m.id=p.message_id
      where p.session_id=? and json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text'
      order by p.time_created limit 1
    `)
    const toolsBySession = db.prepare(`
      select data, time_created from part
      where session_id=? and json_extract(data,'$.type')='tool' order by time_created
    `)
    for (const s of subs) {
      report.sessions += 1
      const dir = s.directory || process.cwd()
      const ws = wsOf(dir)
      const wsName = wsNameOf(dir)
      const link = { type: 'db.subagent', parentSessionId: s.parent_id || null, taskType: s.task_type }

      const task = taskBySession.get(s.id)
      if (task) {
        const text = String(JSON.parse(task.data).text || '').trim()
        if (text) {
          apply(`sub:${s.id}:task`, () => ({
            who: 'meta', type: 'subagent/task', ts: task.time_created, ws, wsName, sid: s.id,
            text: `子代理任务：${clip(text, 200)}`,
            evidence: evidenceOf(text), source: link,
          }))
        }
      }

      const parts = toolsBySession.all(s.id)
      for (const p of parts) {
        report.tools += 1
        let d
        try { d = JSON.parse(p.data) } catch { continue }
        const tool = String(d.tool || 'tool')
        const callId = d.callID || sha256(tool + '\0' + stringify(d.state && d.state.input)).slice(0, 16)
        const input = d.state && d.state.input
        const output = d.state && (d.state.output !== undefined ? d.state.output : d.state.error)
        const status = d.state?.status
        const at = p.time_created || Date.now()
        const inputText = stringify(input ?? '')
        apply(`sub:${s.id}:${callId}:call`, () => ({
          who: 'act', type: 'tool/call', ts: at, ws, wsName, sid: s.id, tool, callId,
          text: `子代理调了 ${tool}：${clip(inputText, 1000)}`,
          evidence: evidenceOf(inputText),
          source: link,
        }))
        if (status !== 'completed' && status !== 'error') continue
        const outText = stringify(output ?? '')
        apply(`sub:${s.id}:${callId}:result`, () => ({
          who: 'act', type: 'tool/result', ts: at, ws, wsName, sid: s.id, tool, callId, status,
          text: status === 'error'
            ? `子代理执行 ${tool} 失败：${clip(outText || '无错误详情', 400)}`
            : (outText.length > 400 ? `子代理执行 ${tool}：结果已存为证据` : `子代理执行 ${tool}：${clip(outText, 400)}`),
          evidence: evidenceOf(outText),
          source: link,
        }))
        if (status !== 'completed') continue
        for (const target of artifactPaths(tool, input, dir)) {
          apply(`sub:${s.id}:${callId}:result:artifact:${target}`, () => {
            const after = snapshot(HOME, target, 2 * 1024 * 1024, { dryRun })
            if (after.state !== 'saved') return null
            return {
              who: 'act', type: 'artifact', ts: at, ws, wsName, sid: s.id, tool, callId,
              text: `子代理写入 ${target}；工具 ${tool} 已完成；版本 ${after.sha256}`,
              artifact: true, path: target,
              versions: { path: target, before: { state: 'unknown' }, after },
              source: { type: 'db.subagent.observation', parentSessionId: s.parent_id || null, callId },
            }
          })
        }
      }
    }
  } finally { db.close() }
  if (report.filled && !dryRun) diag(`backfill --subagents：补 ${report.filled} 条子代理证据（${file}）`)
  return report
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
