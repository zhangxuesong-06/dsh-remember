import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { coverage } from '../coverage.mjs'
import { writeStreams } from '../eval-recall.mjs'
import { loadAll, parseRef, readAt, recall, refOf, trace } from '../recall.mjs'
import { repoRoot, streams } from '../repo.mjs'
import { createAtlasStore } from './atlas.mjs'
import { sha256 } from '../../tools/mem-journal.mjs'

const host = '127.0.0.1'
const sources = new Set(['opencode', 'dsh', 'workbuddy', 'zcode', 'codex'])
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/orbit-cursor.svg', ['orbit-cursor.svg', 'image/svg+xml']],
  ['/node-cursor.svg', ['node-cursor.svg', 'image/svg+xml']],
  ['/drag-cursor.svg', ['drag-cursor.svg', 'image/svg+xml']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/graph-data.mjs', ['graph-data.mjs', 'text/javascript']],
  ['/graph-view.mjs', ['graph-view.mjs', 'text/javascript']],
  ['/sphere.mjs', ['sphere.mjs', 'text/javascript']],
])
const recallLimit = 100
const sceneLimit = 360

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function response(res, status, data, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    // Allow only the pinned graph bundle's generated stylesheets, including the empty style elements at creation.
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-yfc2FhpkFR0EAy3T+zDsaAFGXSP9B3ELNvaJKDzNhkk=' 'sha256-0/4q5IwejFb2zgHlQwwtwmGHS8ZbXE1kmz/TkRFlZ7M=' 'sha256-9xjtvxMT1ApHlgn9ohbh2FNfvK5Tqtzy94BjfXBeMSY=' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(type === 'application/json' ? JSON.stringify(data) : data)
}

function recordRef(ref) {
  const info = typeof ref === 'string' && parseRef(ref)
  if (!info || !sources.has(info.source) || !Number.isSafeInteger(info.line) || info.line < 1
    || (info.source === 'dsh') !== Boolean(info.workspace) || refOf(info) !== ref) {
    throw new RequestError(400, '引用格式无效')
  }
  return info
}

function getRecord(ref) {
  const { source, workspace, line } = recordRef(ref)
  const record = readAt(source, line, workspace)
  if (!record || refOf(record) !== ref) throw new RequestError(404, '此引用目前无法回读')
  return record
}

function projectRecord(record, full = false) {
  const { source, workspace, who, kind, ts, line, sid, turnID, turn, messageID, text, tool, coverage: termCoverage } = record
  const ref = refOf(record)
  if (full) return { ref, source, workspace, who, kind, ts, line, sid, turnID, turn, messageID, text, tool }
  const preview = text.length > 180 ? text.slice(0, 180) + '…' : text
  return { ref, source, workspace, who, kind, ts, sid, line, preview, termCoverage }
}

function fingerprint(record) {
  return sha256(JSON.stringify([path.resolve(record.store), projectRecord(record, true)]))
}

function readFavorites(file) {
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid favorites file')
  for (const entry of value.entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[1])) {
      throw new Error('Invalid favorite entry')
    }
  }
  return new Map(value.entries)
}

function writeFavorites(file, favorites) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: [...favorites] }, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function numberParam(params, key, fallback, min, max) {
  const raw = params.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError(400, '分页参数无效')
  }
  return value
}

function overview() {
  return coverage().map(({ path: _path, worst, worstSilent, ...row }) => ({
    ...row,
    gaps: worstSilent.flatMap(item => item.first ? [{
      ref: refOf({ ...row, line: item.first.line }), sid: item.sid, count: item.silentCount,
    }] : []),
  }))
}

function recent({ source, withTools }) {
  return loadAll({ withTools }).records.filter(record => !source || record.source === source)
    .sort((a, b) => b.ts - a.ts || b.line - a.line)
}

function sceneSample(records, project = projectRecord) {
  const bySource = new Map()
  for (const record of records) {
    let group = bySource.get(record.source)
    if (!group) {
      group = []
      bySource.set(record.source, group)
    }
    if (group.length < sceneLimit) group.push(record)
  }
  const sample = []
  for (let index = 0; sample.length < Math.min(records.length, sceneLimit); index += 1) {
    for (const group of bySource.values()) {
      if (group[index]) sample.push(project(group[index]))
      if (sample.length === sceneLimit) break
    }
  }
  return sample
}

function listRecords(params, file, now) {
  const query = params.get('q') ?? ''
  const source = params.get('source') || null
  const mode = params.get('mode') || 'recall'
  const withTools = params.get('tools') === '1'
  const limit = numberParam(params, 'limit', 12, 1, 50)
  const offset = numberParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
  if (query.length > 300 || (source && !sources.has(source)) || !['recall', 'trace'].includes(mode)) {
    throw new RequestError(400, '查询参数无效')
  }

  const candidate = query.trim()
  let reference = false
  if (candidate.includes(':')) {
    try { recordRef(candidate); reference = true } catch {}
  }
  let records
  let unavailable = []
  if (params.get('favorites') === '1') {
    const favorites = readFavorites(file)
    const byRef = new Map(favorites.size ? recent({ withTools: true }).map(record => [refOf(record), record]) : [])
    records = []
    for (const [ref, expected] of [...favorites].reverse()) {
      const record = byRef.get(ref)
      if (record && fingerprint(record) === expected) records.push(record)
      else unavailable.push(ref)
    }
  } else if (reference) {
    try { records = [getRecord(query.trim())] } catch (error) {
      if (error.status === 400 || error.status === 404) records = []
      else throw error
    }
    if (source) records = records.filter(record => record.source === source)
  } else if (query && mode === 'recall') {
    records = recall(query, { n: recallLimit, source, withTools, now })
  } else if (query) {
    records = trace(query, { source, withTools })
  } else {
    records = recent({ source, withTools })
  }
  return {
    ...(params.get('scene') === '1' && !query ? { scene: sceneSample(records) } : {}),
    mode: reference ? 'reference' : query ? mode : 'browse',
    total: records.length, atRecallLimit: !!query && mode === 'recall' && records.length === recallLimit,
    records: records.slice(offset, offset + limit).map(record => projectRecord(record)), unavailable,
  }
}

function createAtlasReader(file) {
  const store = createAtlasStore(file)
  let priorStamp
  let all = new Map()
  let base = []
  let browsable = []
  let overviewPoints
  return (params, pointsOnly = false) => {
    const refs = [...new Set(params.getAll('ref'))]
    if (refs.length > 50) throw new RequestError(400, '星图补入引用过多')
    for (const ref of refs) recordRef(ref)
    const stamp = JSON.stringify(streams().list.map(entry => {
      try {
        const stat = fs.statSync(entry.path, { throwIfNoEntry: false })
        return [entry.path, stat?.size, stat?.mtimeMs, stat?.ctimeMs]
      } catch { return [entry.path] }
    }))
    if (stamp !== priorStamp) {
      const { records } = loadAll({ withTools: true, withProvenance: true })
      records.sort((a,b) => b.ts - a.ts || b.line - a.line)
      const entries = records.map(record => ({ ...record, ref: refOf(record) }))
      const identity = (record, id) => JSON.stringify([record.store, record.sid, id])
      const byId = new Map()
      const bySeq = new Map()
      for (const record of entries) {
        if (!record.sid || record.source !== 'opencode') continue
        if (record.id) byId.set(identity(record, record.id), record.ref)
        if (record.seq != null) bySeq.set(identity(record, record.seq), record.ref)
      }
      for (const record of entries) {
        if (!record.evidenceIds) continue
        const references = record.evidenceIds.map(id => byId.get(identity(record, id)))
        if (record.requestSeq != null) references.push(bySeq.get(identity(record, record.requestSeq)))
        record.references = [...new Set(references.filter(Boolean))]
      }
      all = new Map(entries.map(record => [record.ref, record]))
      browsable = entries.filter(record => record.kind !== 'tool')
      base = sceneSample(browsable, record => record.ref)
      overviewPoints = undefined
      // Establish the same initial geometry regardless of the first search.
      store.snapshot(base.map(ref => all.get(ref)))
      priorStamp = stamp
    }
    if (pointsOnly) {
      if (!overviewPoints) {
        const positions = store.reserveOverview(browsable)
        overviewPoints = browsable.map(record => [record.ref,record.source,positions.get(record.ref)])
      }
      return { points: overviewPoints }
    }
    const linked = refs.flatMap(ref => all.get(ref)?.references ?? []).slice(0,24)
    const active = [...new Set([...base, ...refs, ...linked])].filter(ref => all.has(ref)).map(ref => all.get(ref))
    const { positions, relations } = store.snapshot(active)
    return {
      records: active.map(record => ({ ...projectRecord(record), position: positions.get(record.ref) })),
      basis: 'evidence', relations,
    }
  }
}

async function parseBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size <= 4096) chunks.push(chunk)
  }
  if (size > 4096) throw new RequestError(413, '请求过大')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, '请求格式无效')
  }
}

export function createDashboard({ demo = false, now } = {}) {
  const file = path.join(repoRoot(), 'dashboard', 'favorites.json')
  const readAtlas = createAtlasReader(path.join(path.dirname(file), 'atlas-positions.json'))
  const assets = new Map([...staticFiles].map(([route, [name, type]]) => [
    route, { body: fs.readFileSync(new URL(name, import.meta.url)), type },
  ]))
  const vendor = new URL('node_modules/3d-force-graph/dist/3d-force-graph.min.js', import.meta.url)
  if (fs.existsSync(vendor)) assets.set('/vendor/3d-force-graph.js', { body: fs.readFileSync(vendor), type: 'text/javascript' })
  for (const name of ['three.module.js', 'three.core.js']) {
    const asset = new URL('node_modules/three/build/' + name, import.meta.url)
    if (fs.existsSync(asset)) assets.set('/vendor/' + name, { body: fs.readFileSync(asset), type: 'text/javascript' })
  }
  const server = http.createServer(async (req, res) => {
    const origin = `http://${host}:${server.address().port}`
    const method = req.method
    try {
      const fetchSite = req.headers['sec-fetch-site']
      if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)
        || (fetchSite && !['none', 'same-origin'].includes(fetchSite))) {
        throw new RequestError(403, '请从本机工作台访问')
      }
      const url = new URL(req.url, origin)
      const params = url.searchParams
      if (url.origin !== origin) throw new RequestError(403, '请从本机工作台访问')
      if (method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname)
        return response(res, 200, asset.body, asset.type)
      }
      if (method === 'GET' && url.pathname === '/api/overview') {
        return response(res, 200, { demo, checkedAt: Date.now(), streams: overview() })
      }
      if (method === 'GET' && url.pathname === '/api/records') {
        return response(res, 200, { ...listRecords(params, file, now), demo })
      }
      if (method === 'GET' && url.pathname === '/api/atlas/points') {
        return response(res, 200, readAtlas(params, true))
      }
      if (method === 'GET' && url.pathname === '/api/atlas') {
        return response(res, 200, readAtlas(params))
      }
      if (method === 'GET' && url.pathname === '/api/record') {
        const record = getRecord(params.get('ref'))
        const result = projectRecord(record, true)
        result.revision = fingerprint(record)
        result.saved = readFavorites(file).get(result.ref) === result.revision
        return response(res, 200, result)
      }
      if (method === 'POST' && url.pathname === '/api/favorites') {
        if (req.headers.origin !== origin || req.headers['x-memory-dashboard'] !== '1'
          || req.headers['content-type']?.split(';')[0] !== 'application/json') {
          throw new RequestError(403, '请从本机工作台管理收藏')
        }
        const { ref, saved, revision } = (await parseBody(req)) ?? {}
        recordRef(ref)
        if (typeof saved !== 'boolean') throw new RequestError(400, '收藏状态无效')
        const favorites = readFavorites(file)
        if (saved) {
          const current = fingerprint(getRecord(ref))
          if (current !== revision) throw new RequestError(409, '记录已变化，请重新打开原文再收藏')
          favorites.set(ref, current)
        } else {
          favorites.delete(ref)
        }
        writeFavorites(file, favorites)
        return response(res, 200, { saved })
      }
      throw new RequestError(404, '页面不存在')
    } catch (error) {
      if (!res.destroyed) {
        if (error instanceof RequestError) response(res, error.status, { error: error.message })
        else response(res, 500, { error: '无法完成操作，请检查账本或收藏文件的访问权限和格式' })
      }
    }
  })
  return server
}

function main(args) {
  const demo = args.includes('--demo')
  const portOption = args.find(arg => arg.startsWith('--port='))
  const port = portOption ? Number(portOption.slice(7) || NaN) : demo ? 7332 : 7331
  if (args.includes('--help')) {
    console.log('用法：node agent-memory/dashboard/server.mjs [--demo] [--port=7331]')
    return
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || args.some(arg => arg !== '--demo' && arg !== portOption)) {
    console.error('参数无效。使用 --help 查看用法。')
    process.exitCode = 1
    return
  }
  let now
  if (demo) {
    const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/recall-cases.json', import.meta.url), 'utf8'))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-dashboard-demo-'))
    process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0))
    process.env.AGENT_MEMORY_HOME = root
    process.env.CODEX_MEMORY_HOME = path.join(root, 'codex')
    now = Date.parse(fixture.now)
    const codex = fixture.streams.find(stream => stream.source === 'codex')
    codex.rows.push({
      who: 'user', type: 'user/message', sid: 'pending-demo',
      ts: now, text: '标定记录的验收截图放到哪个目录？',
    })
    writeStreams(root, fixture.streams.map(stream => ({
      ...stream,
      rows: stream.rows.map((row, index) => ({ ts: now - 3600_000 + index * 60_000, ...row })),
    })))
  }
  const server = createDashboard({ demo, now })
  server.once('error', error => {
    console.error(`工作台启动失败（${error.code || error.name}）。可用 --port 指定端口。`)
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    console.log(`${demo ? '合成演示' : '记忆工作台'} http://${host}:${server.address().port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
