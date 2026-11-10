// Shared by live hooks and replay tests. All summaries point back to source rows.
import { sha256 } from './mem-journal.mjs'
import { artifactPaths, snapshot, putBlob } from './mem-artifacts.mjs'
import { excerpt } from './mem-context.mjs'

const keyOf = (...parts) => sha256(JSON.stringify(parts))
const fileOperation = (tool) => /(?:^|[._])(read|write|edit|patch|glob|grep|list|ls|rg|multiedit|multi_edit|apply_patch)$/.test(String(tool))
export function createCapture(core, ws) {
  const { append, appendTool, readAll, readTools, ROOT, journal } = core
  const known = new Map(readAll().filter((r) => r.eventKey).slice(-5000).map((r) => [r.eventKey, r]))
  const assistantSeen = new Map()
  for (const r of readAll()) {
    if (r.kind === 'message' && r.who === 'assistant' && r.messageID) {
      assistantSeen.set(`${r.sid || ''}|${r.messageID}|${r.ordinal ?? 0}`, r)
    }
  }
  function rememberEvent(row) {
    if (known.has(row.eventKey)) return known.get(row.eventKey)
    const saved = append(row)
    if (saved) known.set(row.eventKey, saved)
    if (known.size > 5000) known.delete(known.keys().next().value)
    return saved
  }
  const latestTurn = (sid) => {
    const row = readAll().filter((r) => r.sid === sid && r.who === 'user').at(-1)
    return row ? row.messageID || row.id || 'legacy:' + row.seq : ''
  }
  function user(sid, messageID, text, ts) {
    if (!messageID || !String(text).trim()) return null
    return rememberEvent({ who: 'user', kind: 'message', ws, sid, messageID, turnID: messageID, text, ts,
      source: { type: 'session.user', messageID }, eventKey: keyOf('user', sid, messageID) })
  }
  function assistant(sid, messageID, ordinal, text, ts, turnID = latestTurn(sid), completion = 'text-ended') {
    if (!messageID || !String(text).trim()) return null
    // 流式回答会以多个中间版本出现。同一消息同一段只留「首次观察」和「最终完成」两版，
    // 不按正文 hash 建键——否则每个增量都会变成一条独立记忆。
    const stage = completion === 'completed' || completion === 'text-ended' ? 'final' : 'observed'
    const slot = `${sid || ''}|${messageID}|${ordinal ?? 0}`
    const seen = assistantSeen.get(slot)
    // 同一段已经有相同正文：不再写第二份。真实场景里 context 和 text.ended
    // 经常先后拿到同一段完整文本，这正是重复 top-2 的来源。
    if (seen && String(seen.text) === String(text)) return seen
    // 已经有最终版时，迟到的中间观察不再补记。
    if (seen && stage === 'observed' && (seen.completion === 'completed' || seen.completion === 'text-ended')) return seen
    const eventKey = keyOf('assistant', sid, messageID, ordinal, stage)
    const prior = known.get(eventKey)
    if (prior) return prior
    const saved = rememberEvent({ who: 'assistant', kind: 'message', ws, sid, messageID, ordinal, turnID, text, ts, completion,
      source: { type: 'session.text', messageID, ordinal }, eventKey })
    if (saved) assistantSeen.set(slot, saved)
    return saved
  }
  function messages(sid, list) {
    let turnID = ''
    for (const m of list || []) {
      if (m.type === 'user') {
        turnID = m.id
        user(sid, m.id, m.text, m.time?.created)
      } else if (m.type === 'assistant') {
        for (const [ordinal, part] of (m.content || []).entries()) {
          if (part.type === 'text') assistant(sid, m.id, ordinal, part.text, m.time?.created, turnID || latestTurn(sid), m.time?.completed ? 'completed' : 'observed')
        }
      }
    }
  }
  function before(e) {
    const sid = e.sessionID, callID = e.id
    if (!sid || !callID) throw new Error('Tool event lacks session/call ID')
    const eventKey = keyOf('call', sid, callID)
    const prior = readTools().find((r) => r.eventKey === eventKey)
    if (prior) return prior
    const input = e.input ?? {}
    const files = artifactPaths(e.tool, input, ws).map((p) => snapshot(ROOT, p))
    return appendTool({ sid, ws, callID, messageID: e.messageID, turnID: latestTurn(sid),
      tool: e.tool, phase: 'call', eventKey, fileOp: !!files.length || fileOperation(e.tool),
      input: putBlob(ROOT, JSON.stringify(input)), files })
  }
  function project(row) {
    if (row.phase !== 'completed') return []
    const out = []
    for (const file of row.files || []) {
      const { before, after } = file
      if (before?.state === 'saved' && after.state === 'saved' && before.sha256 === after.sha256) continue
      if (after.state !== 'saved' && !(after.state === 'missing' && before?.state === 'saved')) continue
      out.push(append({ who: 'system', kind: 'artifact', ws: row.ws, sid: row.sid, turnID: row.turnID, ts: row.ts,
        text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${row.tool} 已完成；版本 ${after.sha256 || 'missing'}`,
        path: file.path, versions: file, source: { type: 'tool.observation', toolEventID: row.id, callID: row.callID },
        eventKey: keyOf('artifact', row.id, file.path) }))
    }
    return out
  }
  function after(e) {
    const sid = e.sessionID, callID = e.id
    if (!sid || !callID) throw new Error('Tool event lacks session/call ID')
    const eventKey = keyOf('result', sid, callID)
    const prior = readTools().find((r) => r.eventKey === eventKey)
    if (prior) { project(prior); return prior }
    const call = readTools().find((r) => r.sid === sid && r.callID === callID && r.phase === 'call')
    const paths = call?.files?.map((f) => f.path) || artifactPaths(e.tool, e.input, ws)
    const files = paths.map((p) => ({ path: p, before: call?.files?.find((f) => f.path === p) || { state: 'unknown' }, after: snapshot(ROOT, p) }))
    const error = e.error ? { name: e.error.name, message: e.error.message || String(e.error), ...e.error } : undefined
    const row = appendTool({ sid, ws, callID, messageID: e.messageID, turnID: call?.turnID || latestTurn(sid),
      tool: e.tool, phase: e.status === 'completed' ? 'completed' : 'error', eventKey, fileOp: !!files.length || fileOperation(e.tool),
      callEventID: call?.id, paired: !!call, files, durationMs: call ? Math.max(0, Date.now() - call.ts) : null,
      error: error ? String(error.message || error).slice(0, 300) : undefined,
      output: putBlob(ROOT, JSON.stringify(e.status === 'completed' ? e.result ?? null : error ?? null)) })
    project(row)
    return row
  }
  function replay() {
    let count = 0
    for (const row of readTools()) count += project(row).length
    for (const row of journal.rows('episodes.jsonl')) append({ ...row, id: undefined, eventKey: 'episode:' + row.id })
    for (const row of core.readMarks()) append({ who: 'assistant', kind: 'note', text: row.text, ws: row.ws,
      source: { markID: row.id }, eventKey: 'mark:' + (row.id || keyOf(row)) })
    return count
  }
  function finish(sid, status = 'completed', turnID = latestTurn(sid)) {
    if (status === 'succeeded') status = 'completed'
    if (!turnID) return null
    const docs = readAll().filter((r) => r.sid === sid && r.turnID === turnID && r.kind !== 'episode')
    const calls = readTools().filter((r) => r.sid === sid && r.turnID === turnID)
    const results = calls.filter((r) => r.phase === 'completed' || r.phase === 'error')
    const request = docs.find((r) => r.who === 'user') || readAll().find((r) => r.sid === sid && r.who === 'user'
      && (r.messageID === turnID || r.id === turnID || 'legacy:' + r.seq === turnID))
    const answers = docs.filter((r) => r.who === 'assistant' && r.kind === 'message')
    const artifacts = docs.filter((r) => r.kind === 'artifact')
    if (!results.length && !answers.length) return null
    const sourceIDs = [...docs.map((r) => r.id), ...calls.map((r) => r.id), request?.id || (request ? 'stream:#' + request.seq : '')].filter(Boolean).sort()
    const text = [
      `任务摘录：${excerpt(request?.text || '（未捕获）', 240)}`,
      `执行状态：${status}；工具完成 ${results.filter((r) => r.phase === 'completed').length}，报错 ${results.filter((r) => r.phase === 'error').length}。工具完成只代表调用返回。`,
      ...artifacts.map((r) => `产物 #${r.seq}：${r.path}`),
      ...answers.map((r) => `助手摘录 #${r.seq}：${excerpt(r.text, 360)}`),
    ].join('\n')
    const row = journal.append('episodes.jsonl', { who: 'system', kind: 'episode', ws, sid, turnID, text,
      status, sourceIDs, requestID: request?.id, requestSeq: request?.seq, answerIDs: answers.map((r) => r.id),
      toolEventIDs: calls.map((r) => r.id), artifactIDs: artifacts.map((r) => r.id),
      source: { type: 'derived.observation', inferredReason: false } },
    { dedupeKey: keyOf('episode', sid, turnID, status, sourceIDs) })
    return append({ ...row, id: undefined, eventKey: 'episode:' + row.id })
  }
  return { user, assistant, messages, before, after, replay, finish, latestTurn }
}
