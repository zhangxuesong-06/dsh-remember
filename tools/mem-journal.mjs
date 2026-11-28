import fs from 'node:fs'
import path from 'node:path'
import { FILES, openJournal, sha256, stamp } from './mem-journal-write.mjs'
import { withMutableState } from './mem-journal-state.mjs'

export { scanFile, sha256 } from './mem-journal-write.mjs'

export function createJournal(root) {
  const journal = openJournal(root)
  const { checkpoint, readCheckpoint, atomicWrite, locked, inspect } = journal
  function inspectAll() {
    let state
    try { state = readCheckpoint() } catch (error) { return { ok: false, status: 'BAD', problems: [{ reason: error.message }], files: {} } }
    const files = {}, problems = []
    let pending = 0, untracked = 0
    for (const name of FILES) {
      const saved = state.files[name]
      const d = inspect(name, saved)
      files[name] = { records: d.rows.length, bytes: d.bytes.length, checkpointed: !!saved, baselineAt: saved?.baselineAt, pending: d.pending }
      problems.push(...d.problems.map((p) => ({ file: name, ...p })))
      if (d.pending) pending++
      if (!saved && d.bytes.length) untracked++
    }
    const status = problems.length ? 'BAD' : pending ? (untracked ? 'UNTRACKED' : 'PENDING') : 'OK'
    return { ok: status === 'OK', status, pending, untracked, files, problems }
  }
  function sync() {
    return locked(() => {
      const state = readCheckpoint()
      // Validate every old checkpoint before accepting new tails or baselines.
      const pending = []
      for (const name of FILES) {
        const d = inspect(name, state.files[name])
        if (d.problems.length) throw new Error(`Integrity failure in ${name}: ${d.problems[0].reason}`)
        if (d.bytes.length || state.files[name]) pending.push([name, d])
      }
      for (const [name, d] of pending) {
        state.files[name] = { bytes: d.bytes.length, sha256: sha256(d.bytes), records: d.rows.length,
          ...(d.bytes.length ? stamp(fs.statSync(path.join(root, name))) : {}),
          baselineAt: state.files[name]?.baselineAt || new Date().toISOString() }
      }
      atomicWrite(checkpoint, state)
      return inspectAll()
    })
  }
  function unlock() {
    const lock = path.join(root, '.journal-lock')
    if (!fs.existsSync(lock)) return false
    let owner
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) } catch {
      // 空/坏 owner：只有锁已经老到不可能是“正在创建”的活进程，才允许清理。
      const age = Date.now() - fs.statSync(lock).mtimeMs
      if (age > 30000) { fs.rmSync(lock, { recursive: true, force: true }); return true }
      throw new Error('Invalid lock owner and lock is recent; inspect manually')
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid lock owner; inspect manually')
    try { process.kill(owner.pid, 0); throw new Error('Writer is still alive; refusing to unlock') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    // An abandoned lock is never removed by competing appenders.
    fs.rmSync(lock, { recursive: true, force: true })
    return true
  }
  return { ...withMutableState(journal), verify: inspectAll, sync, unlock }
}
