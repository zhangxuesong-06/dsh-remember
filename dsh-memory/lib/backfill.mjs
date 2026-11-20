// 回填：把一个工作区里已经发生过的对话，倒进记忆里。
//
// 为什么要有这一步：新装上的记忆系统如果只有「从今往后」，那它一开始就是个陌生人。
// 回填让它一睁眼就带着过去——但只倒**自己的**（同 cwd、不含子会话、不含归档的）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME, SESSIONS_DIR } from './config.mjs'
import { listWorkspaceSessions } from './session-file.mjs'
import { eventToRecords, eventKey } from './capture.mjs'
import { filterSubagentRecords, isSubagent } from './subagent.mjs'

export function archivedSessionIds() {
  const set = new Set()
  try {
    const p = join(DSH_HOME, 'storages', 'workspace.json')
    if (!existsSync(p)) return set
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const g = j && (j.global || j)
    const ids = (g && g.archivedSessionIds) || []
    for (const id of ids) set.add(typeof id === 'string' ? id : id && id.id)
  } catch {}
  return set
}

export function backfill(ledger, cwd, cfg = {}, allow = null) {
  const skip = cfg.includeArchived ? new Set() : archivedSessionIds()
  const sessions = listWorkspaceSessions(SESSIONS_DIR, cwd)
  const fingerprint = (sid, record) => JSON.stringify([sid, record.ts, record.who, String(record.text || '').slice(0, 40)])
  const legacyRecords = new Set()
  const seenTask = new Set()
  for (const record of ledger.docs) {
    if (!record) continue
    if (!record.eventKey || String(record.eventKey).startsWith(':')) legacyRecords.add(fingerprint(record.sid, record))
    if (record.type === 'subagent/task') seenTask.add(record.sid)
  }

  let added = 0
  let used = 0
  let subagents = 0
  let subagentAdded = 0
  for (const { id: sid, header, events } of sessions) {
    const child = isSubagent(header)
    const owner = child ? header.parentSession || sid : sid
    if (child && cfg.backfillSubagents === false) continue
    if (skip.has(sid) || skip.has(owner)) continue
    if (typeof allow === 'function' && !allow(owner)) continue
    if (child) subagents += 1
    else used += 1
    const context = child
      ? { sid, root: ledger.dir, cwd, pending: new Map(), historical: true }
      : { sid }
    for (const event of events) {
      const key = eventKey(event)
      if (key !== null && ledger.seenSeq(sid, key)) continue
      const records = eventToRecords(event, context)
      const accepted = child ? filterSubagentRecords(records, { sid, header, seenTask }) : records
      for (const record of accepted) {
        if (legacyRecords.has(fingerprint(sid, record))) continue
        if (ledger.append({ ...record, sid }, { dedupe: false }) === -1) continue
        if (child) subagentAdded += 1
        else added += 1
      }
      if (key !== null) ledger.noteSeq(sid, key)
    }
  }
  if (added || subagentAdded) ledger.seal(true)
  return { added, sessions: used, subagents, subagentAdded }
}
