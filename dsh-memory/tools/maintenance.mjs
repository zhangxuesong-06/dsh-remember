// DSH 维护：校验、快照、保留、无引用 blob 清理。
// 由插件在会话挂载时以 --due 触发，不注册系统计划任务。
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from '../lib/config.mjs'
import { Ledger } from '../lib/store.mjs'
import { verifyBlobs } from '../lib/evidence.mjs'

const root = process.env.DSH_MEMORY_HOME || HOME
const snapshotsRoot = path.join(root, 'snapshots')
const maintenanceFile = path.join(root, 'maintenance.json')
const SMALL = ['integrity.json', 'state.json', 'seqs.json', 'stream.jsonl', 'marks.jsonl']
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] || '') : fallback
}
const has = (name) => process.argv.includes('--' + name)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}
function atomicWrite(file, value) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
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
        }
      } catch {}
      if (Date.now() - started > 10000) throw new Error('maintenance is busy')
      sleep(20)
    }
  }
  try { return fn() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function ledgerDirs() {
  const one = arg('dir')
  if (one) return [path.resolve(one)]
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).map((n) => path.join(root, n)).filter((p) => {
    try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'stream.jsonl')) } catch { return false }
  })
}

function collectHashes(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) out.add(value.sha256)
  for (const v of Object.values(value)) if (v && typeof v === 'object') collectHashes(v, out)
  return out
}

function verifyDir(dir) {
  let l
  try { l = new Ledger(dir, {}).open() } catch (error) { return { dir, status: 'OPEN_FAILED', problems: [{ reason: error.message }] } }
  try {
    const v = l.verify()
    return { dir, status: v.status, problems: v.problems, blobs: v.blobs, noHash: v.noHash }
  } finally { l.close() }
}

function snapshotDir(dir) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d+)Z$/, '-$1')
  const target = path.join(dir, 'snapshots', stamp)
  fs.mkdirSync(target, { recursive: true })
  try {
    for (const name of SMALL) {
      const from = path.join(dir, name)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name))
    }
    const fromBlobs = path.join(dir, 'blobs')
    const toBlobs = path.join(target, 'blobs')
    fs.mkdirSync(toBlobs, { recursive: true })
    let linked = 0, copied = 0
    if (fs.existsSync(fromBlobs)) {
      for (const name of fs.readdirSync(fromBlobs)) {
        const from = path.join(fromBlobs, name)
        const to = path.join(toBlobs, name)
        try { fs.linkSync(from, to); linked++ } catch { try { fs.copyFileSync(from, to); copied++ } catch {} }
      }
    }
    const v = verifyDir(target)
    if (v.status === 'BAD' || v.status === 'OPEN_FAILED') throw new Error('snapshot verify failed: ' + JSON.stringify(v.problems))
    const manifest = { createdAt: new Date().toISOString(), dir, name: stamp, blobs: { linked, copied }, verify: v }
    atomicWrite(path.join(target, 'manifest.json'), manifest)
    return manifest
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    throw error
  }
}

function retention(dir, keep = Number(arg('keep', 14))) {
  const snapshots = path.join(dir, 'snapshots')
  if (!fs.existsSync(snapshots)) return []
  const dirs = fs.readdirSync(snapshots).filter((n) => /^\d{8}-\d{6}(-\d+)?$/.test(n)).sort()
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of drop) fs.rmSync(path.join(snapshots, name), { recursive: true, force: true })
  return drop
}

function pruneDir(dir) {
  const apply = has('apply')
  const keepDays = Number(arg('keep-days', 30))
  const since = Date.now() - keepDays * 86400e3
  const rows = []
  let invalid = false
  for (const name of ['stream.jsonl', 'marks.jsonl']) {
    try {
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { invalid = true }
      }
    } catch {}
  }
  if (invalid) return { dir, refused: true, reason: 'invalid JSONL; prune aborted', checked: 0, candidates: [], deleted: 0 }
  const refs = collectHashes(rows)
  const blobs = path.join(dir, 'blobs')
  if (!fs.existsSync(blobs)) return { dir, checked: refs.size, candidates: [], deleted: 0 }
  const candidates = []
  for (const name of fs.readdirSync(blobs)) {
    if (refs.has(name)) continue
    const file = path.join(blobs, name)
    const stat = fs.statSync(file)
    if (stat.mtimeMs >= since) continue
    candidates.push({ name, bytes: stat.size })
    if (apply) { fs.unlinkSync(file); candidates[candidates.length - 1].deleted = true }
  }
  return { dir, checked: refs.size, keepDays, apply, candidates, deleted: candidates.filter((c) => c.deleted).length }
}

function due() {
  const interval = Number(arg('interval-hours', process.env.DSH_MAINTENANCE_INTERVAL_HOURS || 12))
  const last = readJson(maintenanceFile, {})
  if (!has('force') && last.lastRun && Date.now() - last.lastRun < interval * 3600e3) {
    return { skipped: true, reason: 'not due', lastRun: last.lastRun, intervalHours: interval }
  }
  return lock(() => {
    const again = readJson(maintenanceFile, {})
    if (!has('force') && again.lastRun && Date.now() - again.lastRun < interval * 3600e3) {
      return { skipped: true, reason: 'another instance did it', lastRun: again.lastRun }
    }
    const dirs = ledgerDirs()
    const verify = dirs.map(verifyDir)
    const snapshots = []
    const dropped = []
    for (const dir of dirs) {
      try { snapshots.push(snapshotDir(dir)); dropped.push(...retention(dir)) } catch (error) { snapshots.push({ dir, error: error.message }) }
    }
    const report = { lastRun: Date.now(), root, intervalHours: interval, verify, snapshots, snapshotsDropped: dropped }
    atomicWrite(maintenanceFile, report)
    return report
  })
}

if (has('due')) console.log(JSON.stringify(due(), null, 2))
else if (has('verify')) {
  const r = ledgerDirs().map(verifyDir)
  console.log(JSON.stringify(r, null, 2))
  if (r.some((x) => x.status === 'BAD' || x.status === 'OPEN_FAILED')) process.exitCode = 1
}
else if (has('backup')) console.log(JSON.stringify(lock(() => ledgerDirs().map((d) => ({ dir: d, snapshot: snapshotDir(d), dropped: retention(d) }))), null, 2))
else if (has('prune')) console.log(JSON.stringify(ledgerDirs().map(pruneDir), null, 2))
else console.log('用法: node tools/maintenance.mjs [--due|--verify|--backup|--prune] [--dir <库目录>] [--apply] [--keep N] [--keep-days N]')
