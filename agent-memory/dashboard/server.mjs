import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { coverage } from '../coverage.mjs'
import { writeStreams } from '../eval-recall.mjs'
import { loadAll, parseRef, readAt, recall, refOf, trace } from '../recall.mjs'
import { repoRoot, streams } from '../repo.mjs'
import { buildAtlas, galaxyRadius, indexRelations, keepPublishedPositions } from './atlas.mjs'
import { buildSemanticIndex, EmbeddingCache } from './semantic.mjs'
import { randomFrom } from './graph-data.mjs'
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
  ['/gaia-star-shaders.mjs', ['gaia-star-shaders.mjs', 'text/javascript']],
  ['/gaia-sky-MPL-2.0.txt', ['gaia-sky-MPL-2.0.txt', 'text/plain']],
])
const recallLimit = 100
const neighborhoodLimit = 12
const sampledLimit = 360

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function response(res, status, data, type = 'application/json', headers = {}) {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(type === 'application/json' ? JSON.stringify(data) : data)
}

function acceptsGzip(header) {
  const encodings = new Map()
  for (const entry of (header ?? '').toLowerCase().split(',')) {
    const [name, parameter] = entry.split(';').map((part) => part.trim())
    const quality = parameter === undefined ? 1 : Number(/^q\s*=\s*(.+)$/.exec(parameter)?.[1])
    if (quality >= 0 && quality <= 1) encodings.set(name, quality)
  }
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0
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
    ...(query && params.get('highlights') === '1' ? { highlights: records.slice(0, recallLimit).map(refOf) } : {}),
    mode: reference ? 'reference' : query ? mode : 'browse',
    total: records.length, atRecallLimit: !!query && mode === 'recall' && records.length === recallLimit,
    records: records.slice(offset, offset + limit).map(record => projectRecord(record)), unavailable,
  }
}

function sampleAtlas(records, points) {
  const groups = new Map()
  for (const record of [...records].sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    if (!groups.has(record.source)) groups.set(record.source, [])
    groups.get(record.source).push(record.ref)
  }
  const sample = []
  for (let i = 0; sample.length < Math.min(sampledLimit, records.length); i++) {
    for (const group of groups.values()) {
      if (group[i]) sample.push(points.get(group[i]))
      if (sample.length === sampledLimit) break
    }
  }
  return sample
}

function readPublishedPositions(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state.schema !== 1 || !Array.isArray(state.positions)) return new Map()
    return new Map(state.positions.filter(row => Array.isArray(row) && typeof row[0] === 'string'
      && typeof row[1]?.digest === 'string' && Array.isArray(row[1].point)
      && row[1].point.length === 3 && row[1].point.every(Number.isFinite)))
  } catch {
    return new Map()
  }
}

function savePublishedPositions(file, positions) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, positions: [...positions] }), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } catch {
    // The star map still works on a read-only installation. Its in-memory anchor map remains available.
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}

function createAtlasReader(positionFile) {
  let priorStamp
  let index
  let relations
  let positions
  let publishedState
  let overviewPoints
  let samplePoints
  let revision = 0

  function reload() {
    const stamp = JSON.stringify(streams().list.map(entry => {
      const stat = fs.statSync(entry.path, { throwIfNoEntry: false })
      return [entry.path, stat?.size, stat?.mtimeMs, stat?.ctimeMs]
    }))
    if (stamp === priorStamp) return
    const { records } = loadAll({ withTools: true, withProvenance: true })
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
      record.references = references.filter(Boolean)
    }
    index = new Map(entries.map(record => [record.ref, record]))
    relations = indexRelations(entries)
    const browsable = entries.filter(record => record.kind !== 'tool')
    const { layoutEdges } = indexRelations(browsable)
    publishedState ??= readPublishedPositions(positionFile)
    const keys = new Map(browsable.map(record => [record.ref, fingerprint(record)]))
    const published = new Map()
    for (const [ref, digest] of keys) {
      const entry = publishedState.get(ref)
      if (entry?.digest === digest) published.set(ref, entry.point)
    }
    if (published.size === keys.size) positions = published
    else positions = keepPublishedPositions(buildAtlas(browsable, layoutEdges), published, layoutEdges)
    if (published.size !== keys.size || publishedState.size !== keys.size) {
      publishedState = new Map([...keys].map(([ref, digest]) => [ref, { digest, point: positions.get(ref) }]))
      savePublishedPositions(positionFile, publishedState)
    }
    const pointsByRef = new Map(browsable.map(record => [record.ref, [record.ref, record.source, positions.get(record.ref)]]))
    overviewPoints = [...pointsByRef.values()]
    samplePoints = sampleAtlas(browsable, pointsByRef)
    priorStamp = stamp
    revision += 1
  }

  function positionFor(ref) {
    if (positions.has(ref)) return positions.get(ref)
    const near = relations.around(ref)
      .map(edge => positions.get(edge.source === ref ? edge.target : edge.source)).find(Boolean)
    const random = randomFrom(ref)
    return (near ?? [0, 0, 0]).map(value => value + (random() - .5) * (near ? 20 : galaxyRadius))
  }

  function read(params, pointsOnly = false) {
    const refs = [...new Set(params.getAll('ref'))]
    if (refs.length > 50) throw new RequestError(400, '星图补入引用过多')
    for (const ref of refs) recordRef(ref)
    reload()
    if (pointsOnly) return { points: params.get('view') === '360' ? samplePoints : overviewPoints, revision }
    const edges = new Map()
    const shown = new Set(refs.filter(ref => index.has(ref)))
    if (params.get('neighbors') !== '0') {
      for (const ref of refs) {
        for (const edge of relations.around(ref).slice(0, neighborhoodLimit)) {
          edges.set(JSON.stringify([edge.kind, ...edge.evidence]), edge)
          shown.add(edge.source)
          shown.add(edge.target)
        }
      }
    }
    return {
      records: [...shown].map(ref => ({ ...projectRecord(index.get(ref)), position: positionFor(ref) })),
      relations: [...edges.values()], revision,
    }
  }

  return { read, snapshot() { reload(); return { records: index, revision } } }
}

function createSemanticReader(atlas, cache) {
  let pending
  return async ref => {
    if (!cache) return { status: 'disabled', neighbors: [] }
    recordRef(ref)
    const { records, revision } = atlas.snapshot()
    const record = records.get(ref)
    if (!record) throw new RequestError(404, '原记录不存在')
    if (record.kind === 'tool') return { status: 'ready', revision, neighbors: [] }
    if (!pending || pending.revision < revision) {
      if (pending?.building) return { status: 'updating', revision, neighbors: [] }
      const job = { revision, building: true, build: buildSemanticIndex([...records.values()], cache) }
      pending = job
      job.build.then(() => { job.building = false }, () => { if (pending === job) pending = undefined })
    }
    const rank = await pending.build
    return {
      status: 'ready', revision,
      neighbors: rank(ref).map(({ ref, score }) => ({
        ...projectRecord(records.get(ref)), score, kind: 'semantic-inference',
      })),
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

export function createDashboard({ demo = false, now, semanticCache } = {}) {
  const directory = path.join(repoRoot(), 'dashboard')
  const file = path.join(directory, 'favorites.json')
  const atlas = createAtlasReader(path.join(directory, 'galaxy-positions.json'))
  const readSemantic = createSemanticReader(atlas, semanticCache)
  const assets = new Map([...staticFiles].map(([route, [name, type]]) => [
    route, { body: fs.readFileSync(new URL(name, import.meta.url)), type },
  ]))
  const threeAssets = [
    ['three.module.js', 'build/three.module.js'],
    ['three.core.js', 'build/three.core.js'],
    ['OrbitControls.js', 'examples/jsm/controls/OrbitControls.js'],
  ]
  for (const [name, relative] of threeAssets) {
    const source = fs.readFileSync(new URL('node_modules/three/' + relative, import.meta.url), 'utf8')
    const body = name === 'OrbitControls.js' ? source.replace("from 'three'", "from './three.module.js'") : source
    assets.set('/vendor/' + name, { body, gzip: gzipSync(body), type: 'text/javascript' })
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
        if (asset.gzip) {
          const headers = { Vary: 'Accept-Encoding' }
          if (acceptsGzip(req.headers['accept-encoding'])) {
            return response(res, 200, asset.gzip, asset.type, { ...headers, 'Content-Encoding': 'gzip' })
          }
          return response(res, 200, asset.body, asset.type, headers)
        }
        return response(res, 200, asset.body, asset.type)
      }
      if (method === 'GET' && url.pathname === '/api/overview') {
        return response(res, 200, { demo, checkedAt: Date.now(), streams: overview() })
      }
      if (method === 'GET' && url.pathname === '/api/records') {
        return response(res, 200, { ...listRecords(params, file, now), demo, semanticEnabled: Boolean(semanticCache) })
      }
      if (method === 'GET' && url.pathname === '/api/atlas/points') {
        return response(res, 200, atlas.read(params, true))
      }
      if (method === 'GET' && url.pathname === '/api/atlas') {
        return response(res, 200, atlas.read(params))
      }
      if (method === 'GET' && url.pathname === '/api/atlas/semantic') {
        try {
          return response(res, 200, await readSemantic(params.get('ref')))
        } catch (error) {
          if (error instanceof RequestError) throw error
          throw new RequestError(503, '语义近邻暂不可用，请检查本地模型和向量缓存')
        }
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

async function main(args) {
  const demo = args.includes('--demo')
  const portOption = args.find(arg => arg.startsWith('--port='))
  const modelOption = args.find(arg => arg.startsWith('--semantic-model='))
  const check = args.includes('--check-semantic')
  const port = portOption ? Number(portOption.slice(7) || NaN) : demo ? 7332 : 7331
  if (args.includes('--help')) {
    console.log('用法：node agent-memory/dashboard/server.mjs [--demo] [--port=7331] [--semantic-model=模型目录 [--check-semantic]]')
    return
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (check && !modelOption)
    || args.some(arg => !['--demo', '--check-semantic', portOption, modelOption].includes(arg))) {
    console.error('参数无效。使用 --help 查看用法。')
    process.exitCode = 1
    return
  }
  let model
  if (modelOption) {
    const [{ loadLocalModel }, { evaluateSemantic }] = await Promise.all([
      import('./semantic/model.mjs'), import('./eval-semantic.mjs'),
    ])
    const directory = modelOption.slice('--semantic-model='.length)
    if (!directory) throw new Error('请提供本地模型目录')
    model = await loadLocalModel(directory)
    const evaluation = await evaluateSemantic(model)
    if (check) console.log(JSON.stringify(evaluation, null, 2))
    if (!evaluation.passed) throw new Error(`合成验收未通过（留出 ${evaluation.holdout.semantic}/${evaluation.holdout.total}），语义近邻未启用`)
    if (check) return
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
  const semanticCache = model && new EmbeddingCache(model, path.join(repoRoot(), 'dashboard', 'embedding-cache'))
  const server = createDashboard({ demo, now, semanticCache })
  server.once('error', error => {
    console.error(`工作台启动失败（${error.code || error.name}）。可用 --port 指定端口。`)
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    console.log(`${demo ? '合成演示' : '记忆工作台'} http://${host}:${server.address().port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
