// 子代理的归属规则（DSH）。
//
// 子代理会话里的 user/message 是主模型派发的任务提示，不是用户原话；
// assistant/message 是模型之间的对话。这两类都不该写进「我说过 / 他说过」。
// 该留的是证据链：任务提示（标 meta）、工具调用、工具结果、产物。
//
// 实时捕获和回填共用这一处，避免两边口径漂移。
export function isSubagent(header) {
  return !!(header && ((Number(header.delegationDepth) || 0) > 0 || header.origin === 'subagent'))
}

function clip(s, n) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= n ? text : text.slice(0, n) + '…'
}

// seenTask: 每场子代理只留第一条任务提示。调用方按 sid 维护一个 Set 即可。
export function filterSubagentRecords(recs, { sid, header, seenTask }) {
  const out = []
  const parent = (header && header.parentSession) || null
  for (const r of recs || []) {
    const type = r.type
    if (type === 'user/message') {
      if (seenTask && seenTask.has(sid)) continue
      if (seenTask) seenTask.add(sid)
      out.push({
        ...r,
        who: 'meta',
        type: 'subagent/task',
        text: `子代理任务：${clip(r.text, 200)}`,
        source: { ...(r.source || {}), type: 'dsh.subagent', parentSession: parent },
      })
      continue
    }
    if (type === 'assistant/message' || type === 'session/title') continue
    if (type === 'tool/call' || type === 'tool/result' || type === 'artifact') {
      out.push({
        ...r,
        source: { ...(r.source || {}), subagent: true, parentSession: parent },
      })
    }
  }
  return out
}
