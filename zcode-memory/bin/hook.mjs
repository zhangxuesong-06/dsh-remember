// ZCode 钩子入口：一次事件起一个进程，只做「解析 + 追加 + 注入」。
//
// 三条铁律：
//   1. 任何异常都吞掉，永远 exit 0——钩子是同步内联执行的，报错会挡住用户。
//   2. 不返回任何权限决定（PreToolUse 里绝不 allow/deny）。
//   3. 只在 stdout 输出严格 JSON；没有要注入的东西就什么都不输出。
import { readFileSync, statSync, writeSync } from 'node:fs'
import { HOME, STREAM, diag, inScope, loadCfg } from '../lib/config.mjs'
import { append } from '../lib/journal.mjs'
import { Ledger } from '../lib/store.mjs'
import { anchorBlock, arrivalBlock, emotionCueBlock, factsBlock, primingBlock } from '../lib/assemble.mjs'
import { assistantRecords, failToolRecords, fields, postToolRecords, preToolRecords, titleRecord, userRecords } from '../lib/events.mjs'
import { loadSession, saveSession } from '../lib/sessions.mjs'

const RULE = [
  '【先分清归属，再开口】',
  '这四件事不是一件事：我说过的、他说过的、我引用过或假设过的、我为了举例编的。',
  '要回答「我是不是说过这个」「你答应过我什么」——先用 trace 查原话，不要凭印象。',
  'trace 说没有，就是没有；别拿 recall 里「很像的一段」顶上。',
  '查到就把会话编号和行号一起说出来。',
].join('\n')

const HINT = '你有一套跨会话的长期记忆（MCP 工具：recall / trace / remember / memory_stats / memory_read）。原始对话会自动落盘，不用你手动记。'

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function emit(eventName, extra) {
  try {
    if (!extra) return
    // 用 writeSync 而不是 process.stdout：后面紧跟 process.exit，异步写可能被截断。
    writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: extra } }) + '\n')
  } catch {}
}

function openLedger(budget) {
  try {
    const size = statSync(STREAM).size
    if (size > budget) return null
  } catch { return null }
  return new Ledger(HOME).open()
}

function appendAll(records) {
  for (const rec of records || []) {
    try { append(rec) } catch (e) { diag('append 失败：' + (e && e.message)) }
  }
}

function onSessionStart(f, cfg, state) {
  const source = f.source || 'startup'
  if (source === 'compact') {
    state.compacted = true
    saveSession(f.sid, state)
    emit('SessionStart', '上下文刚被压缩过一次：更早的对话不在眼前了，但记录还在。拿不准的事用 trace/recall 查，不要当没发生过。')
    return
  }
  const parts = [HINT, RULE]
  if (source === 'resume') {
    emit('SessionStart', parts.join('\n\n'))
    return
  }
  const ledger = openLedger(cfg.hookBudgetBytes)
  if (ledger) {
    try {
      if (cfg.arrival !== false) { const b = arrivalBlock(ledger, cfg); if (b) parts.push(b) }
      if (cfg.anchor !== false) { const b = anchorBlock(ledger, cfg); if (b) parts.push(b) }
      if (cfg.facts !== false) { const b = factsBlock(ledger, cfg); if (b) parts.push(b) }
    } catch (e) { diag('开场注入失败：' + (e && e.message)) } finally { try { ledger.close() } catch {} }
  }
  emit('SessionStart', parts.join('\n\n'))
}

function onUserPrompt(f, cfg) {
  const text = String(f.prompt || '')
  if (!text.trim()) return
  const state = loadSession(f.sid)

  if (cfg.capture !== false) {
    appendAll(userRecords(f, cfg))
    if (!state.titleWritten) {
      const title = titleRecord(f)
      if (title) { append(title); state.titleWritten = true }
    }
  }

  if (cfg.perTurnPriming === false) { saveSession(f.sid, state); return }
  if (state.lastCue === text) { saveSession(f.sid, state); return } // 同一句重发不重复浮

  const ledger = openLedger(cfg.hookBudgetBytes)
  if (!ledger) { saveSession(f.sid, state); return }

  const blocks = []
  try {
    const excludeIds = new Set(state.shownIds || [])
    const allowRecent = (state.idleTurns || 0) >= (cfg.primeRecentCooldown ?? 8)
    let picked = 0
    const prime = primingBlock(ledger, text, cfg, f.sid, {
      excludeIds,
      allowRecent,
      onPick: (ids) => {
        picked = ids.length
        for (const id of ids) if (!excludeIds.has(id)) excludeIds.add(id)
      },
    })
    if (prime) blocks.push(prime)
    const emo = emotionCueBlock(ledger, text, cfg, f.sid)
    if (emo) blocks.push(emo)
    state.shownIds = [...excludeIds].slice(-400)
    state.idleTurns = picked ? 0 : (state.idleTurns || 0) + 1
    state.lastCue = text
  } catch (e) {
    diag('预激活失败：' + (e && e.message))
  } finally { try { ledger.close() } catch {} }

  saveSession(f.sid, state)
  if (blocks.length) emit('UserPromptSubmit', blocks.join('\n\n'))
}

function main() {
  const raw = readStdin()
  if (process.env.ZCODE_MEMORY_DEBUG === '1') diag(`debug stdin=${raw.length}`)
  if (!raw.trim()) return
  let payload
  try { payload = JSON.parse(raw) } catch { diag('debug JSON 解析失败'); return }
  const cfg = loadCfg()
  if (cfg.enabled === false) return
  const f = fields(payload)
  if (process.env.ZCODE_MEMORY_DEBUG === '1') diag(`debug event=${f.event} ws=${f.ws} scope=${inScope(cfg, f.cwd)}`)

  if (!inScope(cfg, f.cwd)) return

  switch (f.event) {
    case 'SessionStart':
      onSessionStart(f, cfg, loadSession(f.sid))
      break
    case 'UserPromptSubmit':
      onUserPrompt(f, cfg)
      break
    case 'PreToolUse':
      if (cfg.capture !== false) appendAll(preToolRecords(f, cfg))
      break
    case 'PostToolUse':
      if (cfg.capture !== false) appendAll(postToolRecords(f, cfg))
      break
    case 'PostToolUseFailure':
      if (cfg.capture !== false) appendAll(failToolRecords(f))
      break
    case 'Stop':
      if (cfg.capture !== false) appendAll(assistantRecords(f))
      break
    default:
      break // PermissionRequest 等：不拦、不记
  }
}

try {
  main()
} catch (e) {
  try { diag('hook 崩溃（已忽略）：' + (e && e.message)) } catch {}
}
process.exit(0)
