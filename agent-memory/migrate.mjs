// 把三个旧库复制进一个共享仓库：~/.agent-memory/{opencode,dsh,workbuddy}
//
// 原则：
//   - 只复制，不移动；旧目录原样保留，随时可回退；
//   - 默认 dry-run，显式 --apply 才写；
//   - 先写 staging 目录，校验通过后原子改名；
//   - runtime / snapshots / 派生索引不搬，它们可重建。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { paths } from './repo.mjs'

const SKIP_DIRS = new Set(['runtime', 'snapshots'])
const SKIP_FILES = new Set(['assoc.json', 'index.db'])

function skipped(name) {
  return SKIP_DIRS.has(name) || SKIP_FILES.has(name)
}

function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, ent.name) : ent.name
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(path.join(dir, ent.name), r)
      } else {
        if (SKIP_FILES.has(ent.name)) continue
        const st = fs.statSync(path.join(dir, ent.name))
        out.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  walk(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function fingerprint(files) {
  const h = crypto.createHash('sha256')
  for (const f of files) {
    h.update(f.rel).update('\0').update(String(f.size)).update('\0').update(String(Math.round(f.mtimeMs))).update('\n')
  }
  return h.digest('hex')
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (p) => !skipped(path.basename(p)),
  })
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

function streamStats(root, source) {
  if (source !== 'dsh') {
    const file = path.join(root, 'stream.jsonl')
    return { records: countLines(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 }
  }
  let records = 0, bytes = 0, workspaces = 0
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  for (const name of dirs) {
    const file = path.join(root, name, 'stream.jsonl')
    if (!fs.existsSync(file)) continue
    workspaces += 1
    records += countLines(file)
    bytes += fs.statSync(file).size
  }
  return { records, bytes, workspaces }
}

export function plan() {
  const p = paths()
  const items = ['opencode', 'dsh', 'workbuddy'].map((source) => {
    const from = p.legacy[source]
    const to = p.shared[source]
    const files = listFiles(from)
    return {
      source,
      from,
      to,
      exists: fs.existsSync(from),
      files: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
      fingerprint: fingerprint(files),
    }
  })
  return { shared: p.shared.root, exists: fs.existsSync(p.shared.root), items, skipped: [...SKIP_DIRS, ...SKIP_FILES] }
}

export function migrate({ apply = false } = {}) {
  const p = paths()
  if (fs.existsSync(p.shared.root)) {
    return { ok: false, reason: `共享仓库已存在：${p.shared.root}`, shared: p.shared.root }
  }
  const p0 = plan()
  if (!apply) return { ok: true, dryRun: true, ...p0 }

  const staging = `${p.shared.root}.loading-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const streams = {}
  try {
    for (const item of p0.items) {
      if (!item.exists) {
        streams[item.source] = { records: 0, bytes: 0 }
        continue
      }
      const before = fingerprint(listFiles(item.from))
      copyTree(item.from, path.join(staging, item.source))
      const after = fingerprint(listFiles(item.from))
      if (before !== after) throw new Error(`${item.source} 在复制过程中发生变化；请关闭对应 harness 后重试`)
      const copied = listFiles(path.join(staging, item.source))
      if (copied.length !== item.files) throw new Error(`${item.source} 文件数不一致：${copied.length} != ${item.files}`)
      for (const f of copied) {
        const size = fs.statSync(path.join(staging, item.source, f.rel)).size
        if (size !== f.size) throw new Error(`${item.source} 文件大小不一致：${f.rel}`)
      }
      streams[item.source] = streamStats(path.join(staging, item.source), item.source)
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      layout: {
        opencode: 'opencode/stream.jsonl',
        dsh: 'dsh',
        workbuddy: 'workbuddy/stream.jsonl',
      },
      streams,
      legacy: p.legacy,
      skipped: [...SKIP_DIRS, ...SKIP_FILES],
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    fs.renameSync(staging, p.shared.root)
    return { ok: true, dryRun: false, shared: p.shared.root, streams, manifest }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: error.message }
  }
}

function readBytes(file) {
  try { return fs.readFileSync(file) } catch { return null }
}

function jsonlPrefix(buf) {
  if (!buf || !buf.length) return Buffer.alloc(0)
  if (buf[buf.length - 1] === 0x0a) return buf
  const cut = buf.lastIndexOf(0x0a)
  return cut >= 0 ? buf.subarray(0, cut + 1) : Buffer.alloc(0)
}

function copyAtomic(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.sync-${process.pid}-${Math.random().toString(16).slice(2)}`
  fs.copyFileSync(src, tmp)
  try {
    fs.renameSync(tmp, dst)
  } catch {
    fs.rmSync(dst, { force: true })
    fs.renameSync(tmp, dst)
  }
}

function syncStream(src, dst, trim = false) {
  const a = trim ? jsonlPrefix(readBytes(src)) : readBytes(src)
  const b = readBytes(dst)
  if (a === null) return { ok: true, missing: true }
  if (!b) { copyAtomic(src, dst); return { ok: true, copied: true } }
  if (a.equals(b)) return { ok: true }
  if (b.length <= a.length && a.subarray(0, b.length).equals(b)) {
    copyAtomic(src, dst)
    return { ok: true, copied: true }
  }
  if (a.length <= b.length && b.subarray(0, a.length).equals(a)) return { ok: true, ahead: true }
  return { ok: false, reason: '流已分叉' }
}

function mirrorFiles(srcRoot, dstRoot) {
  if (!fs.existsSync(srcRoot)) return
  for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      mirrorFiles(path.join(srcRoot, ent.name), path.join(dstRoot, ent.name))
      continue
    }
    if (ent.name === 'stream.jsonl' || SKIP_FILES.has(ent.name)) continue
    const src = path.join(srcRoot, ent.name)
    const dst = path.join(dstRoot, ent.name)
    let st; try { st = fs.statSync(src) } catch { continue }
    let dt = null; try { dt = fs.statSync(dst) } catch {}
    if (!dt || dt.size !== st.size || dt.mtimeMs < st.mtimeMs) copyAtomic(src, dst)
  }
}

// 增量同步：共享仓库已经存在时，把旧库新增的尾部接上。
// 只有共享流是旧库的前缀时才继续；两边都长出新内容就拒绝，避免猜。
export function sync() {
  const p = paths()
  if (!fs.existsSync(p.shared.root)) return { ok: false, reason: '共享仓库不存在，请先 --apply' }
  const results = []
  try {
    for (const source of ['opencode', 'dsh', 'workbuddy']) {
      const from = p.legacy[source]
      const to = p.shared[source]
      if (!fs.existsSync(from)) { results.push({ source, skipped: true }); continue }
      if (source === 'dsh') {
        let dirs = []
        try { dirs = fs.readdirSync(from, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
        for (const ws of dirs) {
          const srcStream = path.join(from, ws, 'stream.jsonl')
          if (!fs.existsSync(srcStream)) continue
          const r = syncStream(srcStream, path.join(to, ws, 'stream.jsonl'), true)
          if (!r.ok) return { ok: false, reason: `dsh/${ws}：${r.reason}` }
          mirrorFiles(path.join(from, ws), path.join(to, ws))
        }
      } else {
        const r = syncStream(path.join(from, 'stream.jsonl'), path.join(to, 'stream.jsonl'), true)
        if (!r.ok) return { ok: false, reason: `${source}：${r.reason}` }
        mirrorFiles(from, to)
      }
      results.push({ source, ...streamStats(to, source) })
    }
    const manifestPath = path.join(p.shared.root, 'manifest.json')
    let manifest = {}
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch {}
    manifest.version = manifest.version || 1
    manifest.syncedAt = new Date().toISOString()
    manifest.streams = Object.fromEntries(results.filter((r) => !r.skipped).map((r) => [r.source, {
      records: r.records, bytes: r.bytes, ...(r.workspaces ? { workspaces: r.workspaces } : {}),
    }]))
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, synced: true, shared: p.shared.root, streams: manifest.streams }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}
function printPlan(p) {
  console.log(`共享仓库：${p.shared}${p.exists ? '（已存在）' : ''}`)
  for (const item of p.items) {
    const mb = (item.bytes / 1048576).toFixed(1)
    console.log(`${item.source.padEnd(9)} ${item.exists ? 'ok     ' : 'missing'} files=${String(item.files).padEnd(5)} ${mb} MB  ${item.from}`)
  }
  console.log(`跳过（可重建）：${p.skipped.join(' / ')}`)
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const apply = process.argv.includes('--apply')
  const doSync = process.argv.includes('--sync')
  const json = process.argv.includes('--json')
  if (doSync) {
    const r = sync()
    if (json) console.log(JSON.stringify(r, null, 2))
    else if (r.ok) {
      console.log(`已同步到 ${r.shared}`)
      for (const [source, s] of Object.entries(r.streams)) {
        console.log(`  ${source.padEnd(9)} records=${s.records}${s.workspaces ? ` workspaces=${s.workspaces}` : ''}`)
      }
    } else {
      console.error('同步失败：' + r.reason)
      process.exitCode = 1
    }
    process.exit(process.exitCode || 0)
  }
  if (!apply) {
    const p = plan()
    if (json) console.log(JSON.stringify(p, null, 2))
    else {
      printPlan(p)
      console.log('\n这是 dry-run。关闭三个 harness 后，用 --apply 执行复制。')
    }
  } else {
    const r = migrate({ apply: true })
    if (json) console.log(JSON.stringify(r, null, 2))
    else if (r.ok) {
      console.log(`已复制到 ${r.shared}`)
      for (const [source, s] of Object.entries(r.streams)) {
        console.log(`  ${source.padEnd(9)} records=${s.records}${s.workspaces ? ` workspaces=${s.workspaces}` : ''}`)
      }
      console.log('\n旧目录未改动。重启三个 harness 后生效；需要回退时删掉共享目录即可。')
    } else {
      console.error('迁移失败：' + r.reason)
      process.exitCode = 1
    }
  }
}
