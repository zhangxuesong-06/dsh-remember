// ZCode 钩子载荷 → 共享库的记录。
//
// 载荷同时给驼峰和蛇形两套字段（ZCode 内部对象整体展开 + Claude 兼容别名），
// 这里统一按「蛇形优先、驼峰兜底」取，少一处兼容就少一处静默丢数据。
import { HOME, inScope, wsNameOf, wsOf } from './config.mjs'
import { artifactPaths, putBlob, sha256, snapshot } from './evidence.mjs'
import { putPending, takePending } from './pending.mjs'
import { isAbsolute } from 'node:path'

const pick = (p, ...names) => {
  for (const n of names) if (p[n] !== undefined && p[n] !== null && p[n] !== '') return p[n]
  return null
}

export function fields(payload, now = Date.now()) {
  const cwd = pick(payload, 'cwd', 'cwd_path') || process.cwd()
  const rawTs = Number(pick(payload, 'timestamp', 'ts'))
  return {
    event: pick(payload, 'hook_event_name', 'hookEventName') || '',
    sid: pick(payload, 'session_id', 'sessionId') || null,
    cwd,
    ws: wsOf(cwd),
    wsName: wsNameOf(cwd),
    ts: Number.isFinite(rawTs) && rawTs > 0 ? rawTs : now,
    turn: pick(payload, 'turnId', 'turn_id', 'turnID'),
    source: pick(payload, 'source'),
    prompt: pick(payload, 'prompt'),
    last: pick(payload, 'last_assistant_message', 'lastAssistantMessage', 'responseText', 'responsePreview'),
    tool: pick(payload, 'tool_name', 'toolName'),
    input: pick(payload, 'tool_input', 'toolInput'),
    callId: pick(payload, 'tool_use_id', 'toolUseId', 'toolCallId', 'tool_call_id', 'call_id'),
    response: pick(payload, 'tool_response', 'toolResponse'),
    error: pick(payload, 'error'),
    errorDetails: pick(payload, 'error_details', 'errorDetails'),
    isInterrupt: Boolean(pick(payload, 'is_interrupt', 'isInterrupt')),
    model: pick(payload, 'model'),
  }
}

export function clip(s, n) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= n ? text : text.slice(0, n) + '…'
}

export function stringify(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function base(f, who, type, extra = {}) {
  return { who, type, ts: f.ts, ws: f.ws, wsName: f.wsName, sid: f.sid, turn: f.turn,
    ...(typeof f.cwd === 'string' && isAbsolute(f.cwd) ? { workspace: f.cwd } : {}), ...extra }
}

// ——— 用户原话 ———
export function userRecords(f, cfg) {
  const text = String(f.prompt ?? '').trim()
  if (!text) return []
  // 极短的斜杠命令不是话，是操作。
  if (/^\/\S{0,39}$/.test(text)) return []
  return [base(f, 'he', 'user/message', {
    text,
    eventKey: `user:${f.sid || ''}:${f.turn ?? ''}:${sha256(text).slice(0, 8)}`,
    source: { type: 'hook.user_prompt' },
  })]
}

// 会话标题：只在每场会话的第一句用户话时写一次（由 sessions 状态保证）。
export function titleRecord(f) {
  const text = String(f.prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return base(f, 'meta', 'session/title', {
    text: `这个对话叫「${clip(text, 30)}」`,
    eventKey: `title:${f.sid || ''}`,
    source: { type: 'hook.session_title' },
  })
}

// ——— 助手最后一段 ———
export function assistantRecords(f) {
  const text = String(f.last ?? '').trim()
  if (!text) return []
  return [base(f, 'me', 'assistant/message', {
    text,
    eventKey: `assistant:${f.sid || ''}:${f.turn ?? ''}:${sha256(text).slice(0, 8)}`,
    source: { type: 'hook.stop' },
  })]
}

// ——— 工具调用 ———
export function preToolRecords(f, cfg) {
  if (!f.tool) return []
  const callId = f.callId || sha256(f.tool + '\0' + stringify(f.input)).slice(0, 16)
  const paths = artifactPaths(f.tool, f.input, f.cwd)
  const before = []
  for (const p of paths) {
    try { before.push(snapshot(HOME, p, cfg.maxBlobBytes)) } catch { before.push({ path: p, state: 'unreadable' }) }
  }
  if (paths.length) putPending(f.sid, callId, { paths, before, name: f.tool })

  let evidence = null
  try {
    const body = stringify(f.input ?? {})
    if (body) evidence = putBlob(HOME, body)
  } catch {}

  return [base(f, 'act', 'tool/call', {
    text: `我调了 ${f.tool}：${clip(stringify(f.input ?? {}), 2000)}`,
    tool: f.tool,
    callId,
    eventKey: `tool:${f.sid || ''}:${callId}:call`,
    ...(evidence ? { evidence } : {}),
    source: { type: 'hook.pre_tool', callId },
  })]
}

export function postToolRecords(f, cfg) {
  if (!f.tool) return []
  const callId = f.callId || sha256(f.tool + '\0' + stringify(f.input)).slice(0, 16)
  const pending = takePending(f.sid, callId)
  const paths = pending && Array.isArray(pending.paths) && pending.paths.length
    ? pending.paths
    : artifactPaths(f.tool, f.input, f.cwd)
  const before = pending && Array.isArray(pending.before) && pending.before.length
    ? pending.before
    : paths.map((p) => ({ path: p, state: 'unknown' }))

  const body = stringify(f.response ?? '')
  let evidence = null
  try { if (body) evidence = putBlob(HOME, body) } catch {}

  const files = []
  for (let i = 0; i < paths.length; i++) {
    let after
    try { after = snapshot(HOME, paths[i], cfg.maxBlobBytes) } catch { after = { path: paths[i], state: 'unreadable' } }
    files.push({ path: paths[i], before: before[i] || { path: paths[i], state: 'unknown' }, after })
  }

  const changed = files.filter((x) => {
    const a = x.after || {}
    const b = x.before || {}
    if (a.state === 'saved') return b.state !== 'saved' || b.sha256 !== a.sha256
    return a.state === 'missing' && b.state === 'saved'
  })

  const records = [base(f, 'act', 'tool/result', {
    text: body.length > 400 ? `我处理了 ${f.tool}：结果已存为证据` : `我处理了 ${f.tool}：${clip(body, 400)}`,
    tool: f.tool,
    callId,
    status: 'completed',
    eventKey: `tool:${f.sid || ''}:${callId}:result`,
    ...(evidence ? { evidence } : {}),
    ...(files.length ? { files } : {}),
    source: { type: 'hook.post_tool', callId },
  })]

  for (const file of changed) {
    const after = file.after || {}
    records.push(base(f, 'act', 'artifact', {
      text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${f.tool} 已完成；版本 ${after.sha256 || 'missing'}`,
      tool: f.tool,
      callId,
      artifact: true,
      path: file.path,
      versions: file,
      eventKey: `tool:${f.sid || ''}:${callId}:result:artifact:${file.path}`,
      source: { type: 'tool.observation', callId },
    }))
  }
  return records
}

export function failToolRecords(f) {
  if (!f.tool) return []
  const callId = f.callId || sha256(f.tool + '\0' + stringify(f.input)).slice(0, 16)
  // 把 pending 收掉：失败不会产生产物，但文件可能已经被半写。
  takePending(f.sid, callId)
  const detail = [f.error, f.errorDetails ? stringify(f.errorDetails) : ''].filter(Boolean).join('\n')
  const text = `Error: ${clip(detail || '工具调用失败', 400)}${f.isInterrupt ? '（被中断）' : ''}`
  let evidence = null
  try { if (detail) evidence = putBlob(HOME, detail) } catch {}
  return [base(f, 'act', 'tool/result', {
    text,
    tool: f.tool,
    callId,
    status: 'error',
    eventKey: `tool:${f.sid || ''}:${callId}:result`,
    ...(evidence ? { evidence } : {}),
    source: { type: 'hook.post_tool_failure', callId },
  })]
}

export function inCaptureScope(f, cfg) {
  return inScope(cfg, f.cwd)
}
