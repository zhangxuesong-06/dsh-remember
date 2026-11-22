// Shared file primitives for the DSH, ZCode and WorkBuddy evidence ledgers.
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
