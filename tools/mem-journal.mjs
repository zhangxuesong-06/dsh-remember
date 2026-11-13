// Durable JSONL storage. Legacy files are enrolled as a baseline, never rewritten.
// A separate checkpoint detects changed/deleted/reordered bytes, including tail loss.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const FILES = ['stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl']

export function scanFile(file) {
  if (!fs.existsSync(file)) return { bytes: Buffer.alloc(0), rows: [], errors: [] }
  const bytes = fs.readFileSync(file)
  const rows = [], errors = []
  bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('not a record')
      rows.push(row)
    } catch { errors.push({ line: i + 1, reason: 'invalid JSON record' }) }
  })
  return { bytes, rows, errors }
}

export function createJournal(root) {
  const checkpoint = path.join(root, 'integrity.json')
  function readCheckpoint() {
    if (!fs.existsSync(checkpoint)) return { version: 1, files: {} }
    const value = JSON.parse(fs.readFileSync(checkpoint, 'utf8').replace(/^\uFEFF/, ''))
    if (value.version !== 1 || !value.files || typeof value.files !== 'object') throw new Error('Invalid integrity checkpoint')
    return value
  }
  function atomicWrite(file, value) {
    const tmp = file + '.tmp-' + randomUUID()
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    try { fs.renameSync(tmp, file) } catch (error) { fs.rmSync(tmp, { force: true }); throw error }
  }
  function locked(fn, timeoutMs = 8000) {
    fs.mkdirSync(root, { recursive: true })
    const lock = path.join(root, '.journal-lock')
    const started = Date.now()
    for (;;) {
      try {
        fs.mkdirSync(lock)
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }))
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        // 上一个持有者如果是崩溃退出，锁会永久留在盘上。只回收能确认已死亡的 PID，
        // 不按年龄强拆活进程的锁；owner 文件缺失/损坏时留给 unlock 人工处理。
        let owner = null
        try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) } catch {}
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (probe) {
            if (probe.code === 'ESRCH') {
              fs.rmSync(lock, { recursive: true, force: true })
              continue
            }
          }
        } else {
          // 软件更新/崩溃可能停在 mkdir 和 owner.json 之间，留下空 owner。
          // 只有锁已经老到不可能还是“刚创建、正在写 owner”的活进程，才回收。
          try {
            const age = Date.now() - fs.statSync(lock).mtimeMs
            if (age > 30000) {
              fs.rmSync(lock, { recursive: true, force: true })
              continue
            }
          } catch {}
        }
        if (Date.now() - started > timeoutMs) throw new Error('Memory journal is busy; use unlock only after its writer has stopped')
        sleep(10)
      }
    }
    try { return fn() } finally {
      fs.rmSync(path.join(lock, 'owner.json'), { force: true })
      fs.rmdirSync(lock)
    }
  }
  function inspect(name, saved) {
    const file = path.join(root, name)
    const data = scanFile(file)
    const problems = [...data.errors]
    if (saved) {
      if (data.bytes.length < saved.bytes) problems.push({ reason: 'truncated or missing file' })
      else if (sha256(data.bytes.subarray(0, saved.bytes)) !== saved.sha256) problems.push({ reason: 'checkpointed bytes changed, deleted or reordered' })
    }
    for (const row of data.rows) {
      if (!row.hash || typeof row.text !== 'string') continue
      const actual = sha256(row.text)
      if (!(actual === row.hash || actual.slice(0, 16) === row.hash)) problems.push({ id: row.id || row.seq, reason: 'text hash mismatch' })
    }
    return { ...data, problems, pending: saved ? data.bytes.length > saved.bytes : data.bytes.length > 0 }
  }
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
          baselineAt: state.files[name]?.baselineAt || new Date().toISOString() }
      }
      atomicWrite(checkpoint, state)
      return inspectAll()
    })
  }
  function append(name, value, { dedupeKey = null } = {}) {
    if (!FILES.includes(name)) throw new Error('Unknown journal')
    return locked(() => {
      const state = readCheckpoint()
      const old = state.files[name]
      const d = inspect(name, old)
      if (d.problems.length) throw new Error(`Integrity failure in ${name}: ${d.problems[0].reason}`)
      // Do not silently bless a complete/partial tail left by an interrupted writer.
      if (old && d.pending) throw new Error(`Uncheckpointed tail in ${name}; run verify and sync explicitly`)
      if (dedupeKey) {
        const prior = d.rows.find((r) => r.eventKey === dedupeKey)
        if (prior) return prior
      }
      const row = { ...value, id: value.id || randomUUID(), ts: value.ts ?? Date.now() }
      if (name === 'stream.jsonl') row.seq = d.rows.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0) + 1
      if (dedupeKey) row.eventKey = dedupeKey
      if (typeof row.text === 'string') row.hash = sha256(row.text)
      // Enroll legacy data before the first append. Baseline is not a historical guarantee.
      if (!old) {
        state.files[name] = { bytes: d.bytes.length, sha256: sha256(d.bytes), records: d.rows.length, baselineAt: new Date().toISOString() }
        atomicWrite(checkpoint, state)
      }
      const separator = d.bytes.length && d.bytes[d.bytes.length - 1] !== 10 ? '\n' : ''
      const line = Buffer.from(separator + JSON.stringify(row) + '\n', 'utf8')
      const file = path.join(root, name)
      const fd = fs.openSync(file, 'a', 0o600)
      try { fs.writeFileSync(fd, line); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const bytes = Buffer.concat([d.bytes, line])
      state.files[name] = { bytes: bytes.length, sha256: sha256(bytes), records: d.rows.length + 1,
        baselineAt: state.files[name]?.baselineAt || new Date().toISOString() }
      atomicWrite(checkpoint, state)
      return row
    })
  }
  function updateJson(name, update) {
    if (!['pins.json', 'aliases.json'].includes(name)) throw new Error('Unknown mutable state')
    return locked(() => {
      const file = path.join(root, name)
      const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
      const next = update(old)
      atomicWrite(file, next)
      return next
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
  return { root, append, updateJson, verify: () => inspectAll(), sync, unlock,
    rows: (name) => scanFile(path.join(root, name)).rows }
}
