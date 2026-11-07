// Content addressed local evidence. Blobs are never included in automatic context.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './mem-journal.mjs'

export function putBlob(root, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  const hash = sha256(bytes)
  const directory = path.join(root, 'blobs')
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, hash)
  if (!fs.existsSync(file)) {
    const tmp = path.join(directory, '.writing-' + randomUUID())
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
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob hash')
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
  const name = String(tool).split(/[._]/).pop().toLowerCase()
  const paths = []
  const add = (p) => { if (typeof p === 'string' && p.trim()) paths.push(path.resolve(directory, p)) }
  if (/^(write|edit|patch|multiedit|multi_edit|apply_patch)$/.test(name) || /(?:apply_patch|multi_edit)$/.test(tool)) {
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
