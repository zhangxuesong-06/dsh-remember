import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createJournal, scanFile } from '../tools/mem-journal.mjs'
import { verifyBlobs as verifyOpenCodeBlobs } from '../tools/mem-verify-blobs.mjs'
import { createIntegrity, scan, verifyBlobs as verifyDshBlobs } from '../dsh-memory/lib/evidence.mjs'
import { RESTORE_ORIGIN_FILE } from '../dsh-memory/lib/memory-case-index.mjs'

const formats = {
  opencode: {
    origin: 'root',
    journals: ['stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl'],
    state: ['integrity.json', 'pins.json', 'aliases.json', 'assoc.json', 'config.json', 'pending.json', 'seqs.json', 'state.json'],
    integrity: createJournal,
    scan: scanFile,
    verifyBlobs: verifyOpenCodeBlobs,
  },
  dsh: {
    origin: 'dir',
    journals: ['stream.jsonl', 'marks.jsonl'],
    state: ['integrity.json', 'seqs.json', 'state.json'],
    integrity: createIntegrity,
    scan,
    verifyBlobs: verifyDshBlobs,
  },
}
const hashName = /^[a-f0-9]{64}$/
const corrupt = detail => new Error(`CORRUPT_SNAPSHOT: ${detail}`)
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const count = value => Number.isSafeInteger(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)

function comparablePath(value) {
  if (process.platform !== 'win32') return path.resolve(value)
  return path.resolve(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''))
}

function contains(parent, file) {
  const relative = path.relative(comparablePath(parent), comparablePath(file))
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function liveLocation(value) {
  try { return fs.realpathSync.native(value) } catch { return value }
}

function regularFile(root, name, required) {
  const file = path.join(root, name)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat && !required) return null
  if (!stat?.isFile()) throw corrupt(`${name} is missing or is not a regular file`)
  return file
}

function verifyCopy(ledger, format, blobs) {
  const checkpoint = JSON.parse(fs.readFileSync(path.join(ledger, 'integrity.json'), 'utf8').replace(/^\uFEFF/, ''))
  if (checkpoint?.version !== 1 || !object(checkpoint.files)) throw corrupt('integrity.json: invalid checkpoint')
  for (const [name, saved] of Object.entries(checkpoint.files)) {
    if (!format.journals.includes(name) || !object(saved) || !count(saved.bytes) || !count(saved.records)
      || typeof saved.sha256 !== 'string' || !hashName.test(saved.sha256)) {
      throw corrupt(`integrity.json: invalid entry for ${name}`)
    }
  }
  const integrity = format.integrity(ledger).verify()
  if (integrity.problems.length) {
    const [{ file, reason }] = integrity.problems
    throw corrupt(`${file || 'integrity.json'}: ${reason}`)
  }
  if (!integrity.ok) throw new Error(`UNVERIFIED_SNAPSHOT: ledger=${integrity.status}`)
  for (const [name, saved] of Object.entries(checkpoint.files)) {
    if (integrity.files[name].records !== saved.records) throw corrupt(`integrity.json: record count mismatch in ${name}`)
  }
  const rows = format.journals.flatMap(name => format.scan(path.join(ledger, name)).rows)
  const evidence = format.verifyBlobs(ledger, [...rows, ...blobs.map(sha256 => ({ sha256 }))])
  if (evidence.problems.length) {
    const [{ blob, reason }] = evidence.problems
    throw new Error(`${reason.startsWith('ENOENT:') ? 'MISSING_BLOB' : 'CORRUPT_BLOB'}: ${blob}: ${reason}`)
  }
  return {
    status: integrity.status, records: rows.length, blobs: evidence.checked,
    streamBytes: Object.fromEntries(format.journals.map(name => [path.basename(name, '.jsonl'), integrity.files[name].bytes])),
  }
}

function restore(adapter, input, output) {
  const format = formats[adapter]
  const snapshot = fs.realpathSync.native(input)
  const parent = fs.realpathSync.native(output)
  let manifest
  try { manifest = readJson(regularFile(snapshot, 'manifest.json', true)) }
  catch (error) { throw corrupt(`manifest.json: ${error.message}`) }
  const originalPath = manifest?.[format.origin]
  const originalRoot = manifest?.caseRoot ?? originalPath
  const files = [...format.journals, ...format.state]
  if (![originalRoot, originalPath].every(value => typeof value === 'string' && path.isAbsolute(value))
    || (manifest.files !== undefined && (!Array.isArray(manifest.files) || !manifest.files.every(name => files.includes(name))))
    || (manifest.blobHashes !== undefined && (!Array.isArray(manifest.blobHashes)
      || !manifest.blobHashes.every(hash => typeof hash === 'string' && hashName.test(hash))))) {
    throw corrupt(`manifest.json: invalid ${adapter} backup manifest`)
  }
  const name = path.basename(originalPath)
  if (adapter === 'dsh' && (!name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name))) {
    throw corrupt('manifest.json: invalid DSH ledger name')
  }
  if ([snapshot, originalRoot, originalPath, liveLocation(originalPath)].some(dir => contains(dir, parent))) {
    throw new Error('INVALID_OUTPUT: output must be outside the snapshot and the original ledger')
  }

  const root = fs.mkdtempSync(path.join(parent, 'memory-restore-'))
  const ledger = adapter === 'dsh' ? path.join(root, 'dsh', name) : path.join(root, 'opencode')
  try {
    fs.mkdirSync(ledger, { recursive: true })
    for (const file of files) {
      const from = regularFile(snapshot, file, ['integrity.json', 'stream.jsonl'].includes(file) || manifest.files?.includes(file))
      if (!from) continue
      if (format.state.includes(file)) {
        let state
        try { state = readJson(from) } catch (error) { throw corrupt(`${file}: ${error.message}`) }
        if (adapter === 'dsh' && file === 'state.json' && (!object(state)
          || (state.episodes !== undefined && !Array.isArray(state.episodes)))) {
          throw corrupt(`${file}: invalid episode state`)
        }
      }
      fs.copyFileSync(from, path.join(ledger, file), fs.constants.COPYFILE_EXCL)
    }
    const fromBlobs = path.join(snapshot, 'blobs')
    const blobDir = fs.lstatSync(fromBlobs, { throwIfNoEntry: false })
    if (blobDir && !blobDir.isDirectory()) throw corrupt('blobs is not a directory')
    const entries = blobDir ? fs.readdirSync(fromBlobs) : []
    const blobs = entries.filter(name => hashName.test(name))
    const present = new Set(blobs)
    const missing = manifest.blobHashes?.find(hash => !present.has(hash))
    if (missing) throw new Error(`MISSING_BLOB: ${missing}`)
    if (blobs.length) fs.mkdirSync(path.join(ledger, 'blobs'))
    for (const hash of blobs) {
      const file = regularFile(fromBlobs, hash, true)
      fs.copyFileSync(file, path.join(ledger, 'blobs', hash), fs.constants.COPYFILE_EXCL)
    }
    const { streamBytes, ...verification } = verifyCopy(ledger, format, blobs)
    const backupBlobs = manifest.blobs?.linked + manifest.blobs?.copied
    if (!manifest.blobHashes && count(backupBlobs) && entries.length < backupBlobs) {
      throw new Error(`MISSING_BLOB: legacy manifest recorded ${backupBlobs} entries, found ${entries.length}`)
    }
    fs.writeFileSync(path.join(ledger, RESTORE_ORIGIN_FILE), JSON.stringify({ adapter, originalRoot, streamBytes }), { flag: 'wx' })
    return { adapter, root, ledger, verification }
  } catch (error) {
    if (path.dirname(root) === parent) fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
}

try {
  const { values } = parseArgs({ options: { adapter: { type: 'string' }, snapshot: { type: 'string' }, output: { type: 'string' } } })
  if (!Object.hasOwn(formats, values.adapter) || !values.snapshot || !values.output) {
    throw new Error('用法: node agent-memory/restore-memory.mjs --adapter opencode|dsh --snapshot <快照目录> --output <已存在的输出父目录>')
  }
  console.log(JSON.stringify(restore(values.adapter, values.snapshot, values.output), null, 2))
} catch (error) {
  console.error(error.code === 'ERR_STRING_TOO_LONG' ? 'UNVERIFIED_SNAPSHOT: journal exceeds the verifier string limit' : error.message)
  process.exitCode = 1
}
