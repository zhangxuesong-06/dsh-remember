#!/usr/bin/env node
// 通用维护：校验、快照、保留策略、无引用 blob 清理。
//
// 只由插件/软件触发，不依赖 Windows 计划任务：
//   node mem-maintenance.mjs --root ~/.opencode-mem --due
//   node mem-maintenance.mjs --root ~/.opencode-mem --backup
//   node mem-maintenance.mjs --root ~/.opencode-mem --verify
//   node mem-maintenance.mjs --root ~/.opencode-mem --prune [--apply]
//
// 设计取舍：
//   - JSONL 复制；blob 用硬链接（同盘），快照几乎不占额外空间。
//   - 原始账本永不自动删除；只清“未被任何记录引用且超过 N 天”的 blob。
//   - --due 有最小间隔，避免每个工作区实例都做一遍；多个实例靠锁和上次时间收敛。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJournal, scanFile } from './mem-journal.mjs'
import { verifyBlobs } from './mem-artifacts.mjs'

const SMALL = [
  'stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl',
  'integrity.json', 'pins.json', 'aliases.json', 'assoc.json',
  'config.json', 'pending.json', 'seqs.json', 'state.json',
]

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] || '') : fallback
}
const has = (name) => process.argv.includes('--' + name)
const root = path.resolve(arg('root', process.env.AGENT_MEMORY_ROOT
  || process.env.OPENCODE_MEM_HOME
  || path.join(os.homedir(), '.opencode-mem')))
const snapshotDir = path.join(root, 'snapshots')
const maintenanceFile = path.join(root, 'maintenance.json')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}
function atomicWrite(file, value) {
  const tmp = file + '.tmp-' + process.pid
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
        }
      } catch {}
      if (Date.now() - started > 10000) throw new Error('maintenance is busy')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function collectHashes(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) out.add(value.sha256)
  for (const v of Object.values(value)) if (v && typeof v === 'object') collectHashes(v, out)
  return out
}

function verifyRoot() {
  const journal = createJournal(root)
  let v
  try { v = journal.verify() } catch (error) {
    return { status: 'BUSY', problems: [{ reason: error.message }], blobs: 0 }
  }
  const rows = ['stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl']
    .flatMap((name) => scanFile(path.join(root, name)).rows)
  const bv = verifyBlobs(root, rows)
  const problems = [...v.problems, ...bv.problems]
  return { ...v, status: problems.length ? 'BAD' : v.status, problems, blobs: bv.checked }
}

function snapshotOnce() {
  if (!fs.existsSync(root)) throw new Error('memory root does not exist: ' + root)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d+)Z$/, '-$1')
  const target = path.join(snapshotDir, stamp)
  fs.mkdirSync(target, { recursive: true })
  try {
    // integrity.json 必须先复制：先拿旧检查点、再拿新数据，最多得到 PENDING；
    // 反过来会得到“检查点比数据新”，被误判成截断。
    const ordered = ['integrity.json', ...SMALL.filter((n) => n !== 'integrity.json')]
    for (const name of ordered) {
      const from = path.join(root, name)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name))
    }
    const fromBlobs = path.join(root, 'blobs')
    const toBlobs = path.join(target, 'blobs')
    fs.mkdirSync(toBlobs, { recursive: true })
    let linked = 0, copied = 0
    if (fs.existsSync(fromBlobs)) {
      for (const name of fs.readdirSync(fromBlobs)) {
        const from = path.join(fromBlobs, name)
        const to = path.join(toBlobs, name)
        try { fs.linkSync(from, to); linked += 1 } catch {
          try { fs.copyFileSync(from, to); copied += 1 } catch {}
        }
      }
    }
    const journal = createJournal(target)
    const v = journal.verify()
    const rows = ['stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl']
      .flatMap((name) => scanFile(path.join(target, name)).rows)
    const bv = verifyBlobs(target, rows)
    if (v.status === 'BAD' || bv.problems.length) {
      throw new Error('snapshot verify failed: ' + (v.problems[0]?.reason || bv.problems[0]?.reason || v.status))
    }
    const manifest = {
      createdAt: new Date().toISOString(), root, name: stamp,
      files: SMALL.filter((n) => fs.existsSync(path.join(target, n))),
      blobs: { linked, copied, total: linked + copied },
      verify: { status: v.status, blobs: bv.checked },
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
    try { return snapshotOnce() } catch (error) {
      last = error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)
    }
  }
  throw last
}

function retention(keep = Number(arg('keep', 14))) {
  if (!fs.existsSync(snapshotDir)) return []
  const dirs = fs.readdirSync(snapshotDir).filter((n) => /^\d{8}-\d{6}(-\d+)?$/.test(n)).sort()
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of drop) fs.rmSync(path.join(snapshotDir, name), { recursive: true, force: true })
  return drop
}

function prune() {
  const apply = has('apply')
  const keepDays = Number(arg('keep-days', 30))
  const since = Date.now() - keepDays * 86400e3
  const files = ['stream.jsonl', 'tools.jsonl', 'episodes.jsonl', 'marks.jsonl']
  const scans = files.map((name) => scanFile(path.join(root, name)))
  if (scans.some((s) => s.errors.length)) return { refused: true, reason: 'invalid JSONL; prune aborted', checked: 0, candidates: [], deleted: 0 }
  const rows = scans.flatMap((s) => s.rows)
  const refs = collectHashes(rows)
  const blobs = path.join(root, 'blobs')
  if (!fs.existsSync(blobs)) return { checked: 0, candidates: [], deleted: 0 }
  const candidates = []
  for (const name of fs.readdirSync(blobs)) {
    if (refs.has(name)) continue
    const file = path.join(blobs, name)
    const stat = fs.statSync(file)
    if (stat.mtimeMs >= since) continue
    candidates.push({ name, bytes: stat.size })
    if (apply) { fs.unlinkSync(file); candidates[candidates.length - 1].deleted = true }
  }
  return { checked: refs.size, keepDays, apply, candidates, deleted: candidates.filter((c) => c.deleted).length }
}

function due() {
  const interval = Number(arg('interval-hours', process.env.MEM_MAINTENANCE_INTERVAL_HOURS || 12))
  const last = readJson(maintenanceFile, {})
  if (!has('force') && last.lastRun && Date.now() - last.lastRun < interval * 3600e3) {
    return { skipped: true, reason: 'not due', lastRun: last.lastRun, intervalHours: interval }
  }
  return lock(() => {
    const again = readJson(maintenanceFile, {})
    if (!has('force') && again.lastRun && Date.now() - again.lastRun < interval * 3600e3) {
      return { skipped: true, reason: 'another instance did it', lastRun: again.lastRun }
    }
    const v = verifyRoot()
    const snap = snapshot()
    const dropped = retention()
    const report = {
      lastRun: Date.now(), root, intervalHours: interval,
      verify: { status: v.status, problems: v.problems, blobs: v.blobs },
      snapshot: snap.name, snapshotsDropped: dropped,
    }
    atomicWrite(maintenanceFile, report)
    return report
  })
}

function main() {
  if (has('due')) {
    const r = due()
    console.log(JSON.stringify(r, null, 2))
    return
  }
  if (has('verify')) {
    const v = verifyRoot()
    const last = readJson(maintenanceFile, {})
    atomicWrite(maintenanceFile, { ...last, lastRun: Date.now(), root, verify: { status: v.status, problems: v.problems, blobs: v.blobs } })
    console.log(JSON.stringify(v, null, 2))
    if (v.status === 'BAD') process.exitCode = 1
    return
  }
  if (has('backup')) {
    const r = lock(() => ({ snapshot: snapshot(), dropped: retention() }))
    console.log(JSON.stringify(r, null, 2))
    return
  }
  if (has('prune')) {
    console.log(JSON.stringify(prune(), null, 2))
    return
  }
  console.log('用法: node mem-maintenance.mjs --root <记忆目录> [--due|--verify|--backup|--prune] [--apply] [--keep N] [--keep-days N] [--force]')
}

main()
