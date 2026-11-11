#!/usr/bin/env node
// WorkBuddy 维护：校验、快照、保留、无引用 blob 清理。
// 由 SessionStart hook 以 --due 触发；不注册系统计划任务。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIntegrity, scan, verifyBlobs } from './mem-evidence.mjs'

const root = path.resolve(process.env.WORKBUDDY_MEM_HOME || path.join(os.homedir(), '.workbuddy', 'mem'))
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
  try { v = integrity.verify() } catch (error) { return { status: 'BUSY', problems: [{ reason: error.message }], blobs: 0 } }
  const bv = verifyBlobs(root, rowsFrom(root))
  const problems = [...v.problems, ...bv.problems]
  return { ...v, status: problems.length ? 'BAD' : v.status, problems, blobs: bv.checked }
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
    let linked = 0, copied = 0
    if (fs.existsSync(fromBlobs)) {
      for (const name of fs.readdirSync(fromBlobs)) {
        try { fs.linkSync(path.join(fromBlobs, name), path.join(toBlobs, name)); linked++ } catch {
          try { fs.copyFileSync(path.join(fromBlobs, name), path.join(toBlobs, name)); copied++ } catch {}
        }
      }
    }
    const sv = createIntegrity(target, ['stream.jsonl', 'marks.jsonl']).verify()
    const bv = verifyBlobs(target, rowsFrom(target))
    if (sv.status === 'BAD' || bv.problems.length) throw new Error('snapshot verify failed')
    const manifest = { createdAt: new Date().toISOString(), root, name: stamp, blobs: { linked, copied }, verify: { status: sv.status, blobs: bv.checked } }
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
function prune() {
  const apply = has('apply')
  const keepDays = Number(arg('keep-days', 30))
  const since = Date.now() - keepDays * 86400e3
  const scans = ['stream.jsonl', 'marks.jsonl'].map((name) => scan(path.join(root, name)))
  if (scans.some((s) => s.errors.length)) return { refused: true, reason: 'invalid JSONL; prune aborted', checked: 0, candidates: [], deleted: 0 }
  const refs = collectHashes(scans.flatMap((s) => s.rows))
  const blobs = path.join(root, 'blobs')
  if (!fs.existsSync(blobs)) return { checked: refs.size, candidates: [], deleted: 0 }
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
  const interval = Number(arg('interval-hours', process.env.WORKBUDDY_MAINTENANCE_INTERVAL_HOURS || 12))
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
    const report = { lastRun: Date.now(), root, intervalHours: interval, verify: { status: v.status, problems: v.problems, blobs: v.blobs }, snapshot: snap.name, snapshotsDropped: dropped }
    atomicWrite(maintenanceFile, report)
    return report
  })
}

if (has('due')) console.log(JSON.stringify(due(), null, 2))
else if (has('verify')) {
  const v = verifyRoot()
  console.log(JSON.stringify(v, null, 2))
  if (v.status === 'BAD') process.exitCode = 1
}
else if (has('backup')) console.log(JSON.stringify(lock(() => ({ snapshot: snapshot(), dropped: retention() })), null, 2))
else if (has('prune')) console.log(JSON.stringify(prune(), null, 2))
else console.log('用法: node mem-maintenance.mjs [--due|--verify|--backup|--prune] [--apply] [--keep N] [--keep-days N]')
