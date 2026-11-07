// 本地证据层：完整工具输出、文件前后版本、字节完整性检查点。
//
// 原始 JSONL 只追加。证据按 SHA-256 存在 blobs/，不进入检索。
// integrity.json 是“当前接纳到哪里”的基线：它能发现已接纳字节被改、删、重排或截尾，
// 但不能证明基线之前没有丢过东西，也不证明记录内容真实。
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function atomicWrite(file, value) {
  const tmp = file + '.tmp-' + randomUUID()
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } catch (error) { fs.rmSync(tmp, { force: true }); throw error }
}

export function scan(file) {
  if (!fs.existsSync(file)) return { bytes: Buffer.alloc(0), rows: [], errors: [], partial: false }
  const bytes = fs.readFileSync(file)
  const rows = [], errors = []
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const complete = text.endsWith('\n') || text.length === 0 ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  complete.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('not a record')
      rows.push(row)
    } catch { errors.push({ line: i + 1, reason: 'invalid JSON record' }) }
  })
  return { bytes, rows, errors, partial: text.length > 0 && !text.endsWith('\n') }
}

export function createIntegrity(root, names = ['stream.jsonl', 'marks.jsonl']) {
  const checkpoint = path.join(root, 'integrity.json')
  const read = () => {
    if (!fs.existsSync(checkpoint)) return { version: 1, files: {} }
    const value = JSON.parse(fs.readFileSync(checkpoint, 'utf8').replace(/^\uFEFF/, ''))
    if (value.version !== 1 || !value.files || typeof value.files !== 'object') throw new Error('Invalid integrity checkpoint')
    return value
  }
  const inspect = (name, saved) => {
    const data = scan(path.join(root, name))
    const problems = [...data.errors]
    if (saved) {
      if (data.bytes.length < saved.bytes) problems.push({ reason: 'truncated or missing file' })
      else if (sha256(data.bytes.subarray(0, saved.bytes)) !== saved.sha256) {
        problems.push({ reason: 'checkpointed bytes changed, deleted or reordered' })
      }
    }
    for (const row of data.rows) {
      if (!row.hash || typeof row.text !== 'string') continue
      const actual = sha256(row.text)
      if (actual !== row.hash && actual.slice(0, 16) !== row.hash) problems.push({ id: row.id || row.seq, reason: 'text hash mismatch' })
    }
    return { ...data, problems, pending: saved ? data.bytes.length > saved.bytes : data.bytes.length > 0 }
  }
  const verify = () => {
    let state
    try { state = read() } catch (error) { return { ok: false, status: 'BAD', problems: [{ reason: error.message }], files: {} } }
    const files = {}, problems = []
    let pending = 0, untracked = 0
    for (const name of names) {
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
  const sync = () => {
    const state = read()
    for (const name of names) {
      const d = inspect(name, state.files[name])
      if (d.problems.length) throw new Error(`Integrity failure in ${name}: ${d.problems[0].reason}`)
      if (d.partial) throw new Error(`Incomplete tail in ${name}; wait for the writer to finish`)
      if (d.bytes.length || state.files[name]) {
        state.files[name] = { bytes: d.bytes.length, sha256: sha256(d.bytes), records: d.rows.length,
          baselineAt: state.files[name]?.baselineAt || new Date().toISOString() }
      }
    }
    atomicWrite(checkpoint, state)
    return verify()
  }
  // 每次追加后调用：把当前字节接纳为新基线。失败时不吞掉——调用方记日志。
  const record = (name) => {
    if (!names.includes(name)) throw new Error('Unknown integrity file')
    const state = read()
    const file = path.join(root, name)
    const data = scan(file)
    // 另一个进程可能正在写最后一行；不要把半行接纳成基线。
    if (data.errors.length || data.partial) throw new Error('Journal has an incomplete or invalid tail; run verify')
    state.files[name] = { bytes: data.bytes.length, sha256: sha256(data.bytes), records: data.rows.length,
      baselineAt: state.files[name]?.baselineAt || new Date().toISOString() }
    atomicWrite(checkpoint, state)
  }
  return { root, names, verify, sync, record }
}

export function putBlob(root, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  const hash = sha256(bytes)
  const dir = path.join(root, 'blobs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, hash)
  if (!fs.existsSync(file)) {
    const tmp = path.join(dir, '.writing-' + randomUUID())
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    try {
      try { fs.linkSync(tmp, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  if (sha256(fs.readFileSync(file)) !== hash) throw new Error('Existing evidence blob is corrupt: ' + hash)
  return { sha256: hash, bytes: bytes.length }
}

export function readBlob(root, hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) throw new Error('Invalid blob hash')
  const bytes = fs.readFileSync(path.join(root, 'blobs', hash))
  if (sha256(bytes) !== hash) throw new Error('Evidence blob hash mismatch: ' + hash)
  return bytes
}

export function snapshot(root, file, maxBytes = 8 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { path: file, state: 'not-file' }
    if (stat.size > maxBytes) return { path: file, state: 'oversize', bytes: stat.size, limit: maxBytes }
    const bytes = fs.readFileSync(file)
    return { path: file, state: 'saved', ...putBlob(root, bytes) }
  } catch (error) {
    return { path: file, state: error.code === 'ENOENT' ? 'missing' : 'unreadable', error: error.code || error.message }
  }
}

export function artifactPaths(tool, input, directory) {
  const name = String(tool || '').split(/[._]/).pop().toLowerCase()
  const paths = []
  const add = (p) => { if (typeof p === 'string' && p.trim()) paths.push(path.resolve(directory || '.', p)) }
  if (/^(write|edit|patch|multiedit|multi_edit|apply_patch|ops_replace)$/.test(name) || /(?:apply_patch|multi_edit)$/.test(String(tool))) {
    add(input?.filePath || input?.file_path || input?.path || input?.file)
    for (const edit of input?.edits || []) add(edit.filePath || edit.file_path || edit.path)
    const patch = input?.patchText || input?.patch || input?.input || ''
    if (typeof patch === 'string') {
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) add(match[1].trim())
    }
  }
  return [...new Set(paths)]
}

export function verifyBlobs(root, rows) {
  const hashes = new Set()
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) hashes.add(value.sha256)
    for (const v of Object.values(value)) if (typeof v === 'object') visit(v)
  }
  rows.forEach(visit)
  const problems = []
  for (const hash of hashes) {
    try { readBlob(root, hash) } catch (error) { problems.push({ blob: hash, reason: error.message }) }
  }
  return { checked: hashes.size, problems }
}
