// zcode-memory 维护：校验、接纳合法尾巴、快照、保留、无引用 blob 清理、体积报告。
// 由 SessionStart 钩子以 --due 触发；也可以手动跑。不做系统计划任务。
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from '../lib/config.mjs'
import { createIntegrity, scan, verifyBlobs } from '../lib/evidence.mjs'

const root = HOME
const maintenanceFile = path.join(root, 'maintenance.json')
const snapshotsRoot = path.join(root, 'snapshots')
const SMALL = ['integrity.json', 'stream.jsonl', 'marks.jsonl', 'pending.json', 'config.json']
const integrity = createIntegrity(root, ['stream.jsonl', 'marks.jsonl'])
const has = (name) => process.argv.includes('--' + name)
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] || '') : fallback
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

function atomicWrite(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function lock(fn) {
  const dir = path.join(root, '.maintenance-lock')
  fs.mkdirSync(root, { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8')
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (probe) {
            if (probe.code === 'ESRCH') { fs.rmSync(dir, { recursive: true, force: true }); continue }
          }
        } else if (Date.now() - fs.statSync(dir).mtimeMs > 30000) {
          fs.rmSync(dir, { recursive: true, force: true }); continue
        }
      } catch {
        try { if (Date.now() - fs.statSync(dir).mtimeMs > 30000) { fs.rmSync(dir, { recursive: true, force: true }); continue } } catch {}
      }
      if (Date.now() - started > 10000) throw new Error('maintenance is busy')
      sleep(20)
    }
  }
  try { return fn() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function rowsFrom(dir) {
  return ['stream.jsonl', 'marks.jsonl'].flatMap((name) => scan(path.join(dir, name)).rows)
}

function collectHashes(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) out.add(value.sha256)
  for (const v of Object.values(value)) if (v && typeof v === 'object') collectHashes(v, out)
  return out
}

function verifyRoot() {
  let v
  try { v = integrity.verify() } catch (error) {
    return { status: 'BUSY', problems: [{ reason: error.message }], blobs: 0 }
  }
  const bv = verifyBlobs(root, rowsFrom(root))
  const problems = [...v.problems, ...bv.problems]
  return { ...v, status: problems.length ? 'BAD' : v.status, problems, blobs: bv.checked }
}

// 把当前完整的尾巴接纳成基线。钩子只在小库上顺手记基线；大库靠这里收口。
function syncBaseline() {
  try {
    const v = integrity.sync()
    return { ok: true, status: v.status, problems: v.problems.length }
  } catch (error) {
    return { ok: false, reason: error && error.message }
  }
}

function snapshotOnce() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d+)Z$/, '-$1')
  const target = path.join(snapshotsRoot, stamp)
  fs.mkdirSync(target, { recursive: true })
  try {
    for (const name of SMALL) {
      const from = path.join(root, name)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name))
    }
    const fromBlobs = path.join(root, 'blobs')
    const toBlobs = path.join(target, 'blobs')
    fs.mkdirSync(toBlobs, { recursive: true })
    let linked = 0
    let copied = 0
    if (fs.existsSync(fromBlobs)) {
      for (const name of fs.readdirSync(fromBlobs)) {
        try { fs.linkSync(path.join(fromBlobs, name), path.join(toBlobs, name)); linked += 1 } catch {
          try { fs.copyFileSync(path.join(fromBlobs, name), path.join(toBlobs, name)); copied += 1 } catch {}
        }
      }
    }
    const sv = createIntegrity(target, ['stream.jsonl', 'marks.jsonl']).verify()
    const bv = verifyBlobs(target, rowsFrom(target))
    if (sv.status === 'BAD' || bv.problems.length) throw new Error('snapshot verify failed')
    const manifest = {
      createdAt: new Date().toISOString(), root, name: stamp,
      blobs: { linked, copied }, verify: { status: sv.status, blobs: bv.checked },
    }
    atomicWrite(path.join(target, 'manifest.json'), manifest)
    return manifest
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    throw error
  }
}

function snapshot() {
  let last
  for (let i = 0; i < 3; i++) {
    try { return snapshotOnce() } catch (error) { last = error; sleep(80) }
  }
  throw last
}

function retention(keep = Number(arg('keep', 14))) {
  if (!fs.existsSync(snapshotsRoot)) return []
  const dirs = fs.readdirSync(snapshotsRoot).filter((n) => /^\d{8}-\d{6}(-\d+)?$/.test(n)).sort()
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of drop) fs.rmSync(path.join(snapshotsRoot, name), { recursive: true, force: true })
  return drop
}

function dirSize(dir) {
  let bytes = 0
  let files = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) { const sub = dirSize(p); bytes += sub.bytes; files += sub.files }
      else { try { bytes += fs.statSync(p).size; files += 1 } catch {} }
    }
  } catch {}
  return { bytes, files }
}

function report() {
  const stream = path.join(root, 'stream.jsonl')
  const rows = scan(stream).rows
  const byType = {}
  for (const r of rows) byType[r.type || 'unknown'] = (byType[r.type || 'unknown'] || 0) + 1
  return {
    root,
    stream: { bytes: fs.existsSync(stream) ? fs.statSync(stream).size : 0, records: rows.length, byType },
    marks: fs.existsSync(path.join(root, 'marks.jsonl')) ? fs.statSync(path.join(root, 'marks.jsonl')).size : 0,
    blobs: dirSize(path.join(root, 'blobs')),
    snapshots: dirSize(snapshotsRoot),
    sessions: fs.existsSync(path.join(root, 'sessions')) ? fs.readdirSync(path.join(root, 'sessions')).length : 0,
    pending: Object.keys(readJson(path.join(root, 'pending.json'), {})).length,
  }
}

function prune() {
  const apply = has('apply')
  const keepDays = Number(arg('keep-days', 30))
  const since = Date.now() - keepDays * 86400e3
  const scans = ['stream.jsonl', 'marks.jsonl'].map((name) => scan(path.join(root, name)))
  if (scans.some((s) => s.errors.length || s.partial)) {
    return { refused: true, reason: 'invalid or incomplete JSONL; prune aborted', checked: 0, candidates: [], deleted: 0 }
  }
  const refs = collectHashes(scans.flatMap((s) => s.rows))
  const blobs = path.join(root, 'blobs')
  if (!fs.existsSync(blobs)) return { checked: refs.size, keepDays, apply, candidates: [], deleted: 0 }
  const candidates = []
  for (const name of fs.readdirSync(blobs)) {
    if (refs.has(name)) continue
    const file = path.join(blobs, name)
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile() || stat.mtimeMs >= since) continue
    const row = { name, bytes: stat.size }
    if (apply) { try { fs.unlinkSync(file); row.deleted = true } catch {} }
    candidates.push(row)
  }
  return { checked: refs.size, keepDays, apply, candidates, deleted: candidates.filter((c) => c.deleted).length }
}

function due() {
  const interval = Number(arg('interval-hours', process.env.ZCODE_MEM_MAINTENANCE_INTERVAL_HOURS || 12))
  const last = readJson(maintenanceFile, {})
  if (!has('force') && last.lastRun && Date.now() - last.lastRun < interval * 3600e3) {
    return { skipped: true, reason: 'not due', lastRun: last.lastRun, intervalHours: interval }
  }
  return lock(() => {
    const again = readJson(maintenanceFile, {})
    if (!has('force') && again.lastRun && Date.now() - again.lastRun < interval * 3600e3) {
      return { skipped: true, reason: 'another instance did it', lastRun: again.lastRun }
    }
    const sync = syncBaseline()
    const v = verifyRoot()
    const snap = snapshot()
    const dropped = retention()
    const rep = report()
    const payload = {
      lastRun: Date.now(), root, intervalHours: interval,
      sync, verify: { status: v.status, problems: v.problems, blobs: v.blobs },
      snapshot: snap.name, snapshotsDropped: dropped,
      size: { streamBytes: rep.stream.bytes, records: rep.stream.records, blobs: rep.blobs, snapshots: rep.snapshots },
    }
    atomicWrite(maintenanceFile, payload)
    return payload
  })
}

try {
  if (has('due')) console.log(JSON.stringify(due(), null, 2))
  else if (has('verify')) {
    const v = verifyRoot()
    console.log(JSON.stringify(v, null, 2))
    if (v.status === 'BAD') process.exitCode = 1
  } else if (has('sync')) {
    const r = syncBaseline()
    console.log(JSON.stringify(r, null, 2))
    if (!r.ok) process.exitCode = 1
  } else if (has('backup')) console.log(JSON.stringify(lock(() => ({ snapshot: snapshot(), dropped: retention() })), null, 2))
  else if (has('prune')) console.log(JSON.stringify(prune(), null, 2))
  else if (has('report')) console.log(JSON.stringify(report(), null, 2))
  else console.log('用法: node tools/maintenance.mjs [--due|--verify|--sync|--backup|--prune|--report] [--apply] [--keep N] [--keep-days N] [--force]')
} catch (error) {
  console.error(error && error.message ? error.message : String(error))
  process.exitCode = 1
}
