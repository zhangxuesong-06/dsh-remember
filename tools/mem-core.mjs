// CLI operations over the same runtime storage used by the OpenCode plugin.
import fs from 'node:fs'
import { verifyBlobs } from './mem-verify-blobs.mjs'
import { createJournal } from './mem-journal.mjs'
import { ROOT, STREAM, TOOLS, readAll, readTools, readMarks, readPins, readAssoc } from './mem-runtime.mjs'

export * from './mem-runtime.mjs'
export const journal = createJournal(ROOT)

export function setPin(key, text) {
  journal.updateJson('pins.json', (pins) => ({ ...pins, [key]: { text, ts: Date.now() } }))
}

export function toolStats() {
  const rows = readTools()
  const byTool = {}
  const byPhase = {}
  let fileOps = 0
  let bytes = 0
  try { bytes = fs.statSync(TOOLS).size } catch {}
  for (const r of rows) {
    byTool[r.tool] = (byTool[r.tool] || 0) + 1
    byPhase[r.phase] = (byPhase[r.phase] || 0) + 1
    if (r.fileOp) fileOps += 1
  }
  return { total: rows.length, bytes, byTool, byPhase, fileOps }
}

// 只统计同会话的重复文本。原始账本不做物理去重。
export function compact({ apply = false } = {}) {
  if (apply) throw new Error('stream.jsonl 只追加；不再支持 compact --apply。重复只在派生视图里处理。')
  const docs = readAll()
  const seen = new Set()
  const kept = []
  let dropped = 0
  for (const d of docs) {
    const n = String(d.text).replace(/\s+/g, ' ').trim()
    if (n.length >= 80) {
      const key = JSON.stringify([d.ws, d.sid, d.who, d.kind, n])
      if (seen.has(key)) { dropped += 1; continue }
      seen.add(key)
    }
    kept.push(d)
  }
  return { total: docs.length, kept: kept.length, dropped, apply: false, backup: null }
}

// 校验已接纳字节、文本指纹和引用的证据。历史基线不能证明接纳前的完整性。
export function verify() {
  const docs = readAll()
  let result
  try { result = journal.verify() } catch (error) {
    result = { ok: false, status: 'BUSY', problems: [{ reason: error.message }], files: {} }
  }
  const blobs = verifyBlobs(ROOT, [...docs, ...readTools()])
  const problems = [...result.problems, ...blobs.problems]
  const noHash = docs.filter((d) => !d.hash).length
  return { ...result, ok: result.ok && !problems.length, status: problems.length ? 'BAD' : result.status,
    total: docs.length, checked: docs.length - noHash, noHash, bad: problems.length, problems, blobs: blobs.checked }
}

export const syncIntegrity = () => journal.sync()
export const unlockJournal = () => journal.unlock()
// 一行体检。放计划任务里每天跑一次，出问题一眼看见。
export function health({ report = false } = {}) {
  const docs = readAll()
  const pins = Object.keys(readPins()).length
  const marks = readMarks().length
  const t = toolStats()
  const a = readAssoc()
  const v = verify()
  const artifacts = docs.filter((d) => d.kind === 'artifact').length
  const day = new Date().toISOString().slice(0, 10)
  const line = `[memory] ${day} total=${docs.length} pinned=${pins} marks=${marks} artifacts=${artifacts}`
    + ` tools=${t.total} assoc=${a ? `${a.meta.terms}/${a.meta.edges}` : 'none'}`
    + ` ledger=${v.status} problems=${v.bad} blobs=${v.blobs} noHash=${v.noHash}`
  return report ? { line, ok: v.status !== 'BAD', status: v.status } : line
}

export function assocNeighbors(term) {
  const j = readAssoc()
  if (!j) return null
  const t = String(term || '').toLowerCase()
  return j.map[t] || []
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
