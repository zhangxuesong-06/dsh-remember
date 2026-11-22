import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { once } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createDashboard } from './server.mjs'

const original = '原始答复\n  保留缩进 <script>原话</script>  '

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-dashboard-test-'))
  const before = Object.fromEntries(['AGENT_MEMORY_HOME', 'CODEX_MEMORY_HOME'].map(key => [key, process.env[key]]))
  process.env.AGENT_MEMORY_HOME = root
  process.env.CODEX_MEMORY_HOME = path.join(root, 'codex')
  const log = path.join(root, 'codex', 'stream.jsonl')
  await fs.mkdir(path.dirname(log))
  await fs.writeFile(log, [
    JSON.stringify({ who: 'user', type: 'user/message', sid: 'one', turn: 0, ts: 1000, text: '原始问题' }),
    '',
    JSON.stringify({ who: 'assistant', type: 'assistant/message', sid: 'one', ts: 1001, turn: 0, text: original }),
    'malformed',
    JSON.stringify({ who: 'user', type: 'user/message', sid: 'two', ts: 1002, text: '一条尚无回复的问题' }),
    JSON.stringify({ who: 'act', type: 'tool/result', sid: 'one', ts: 1003, text: '原始工具' }),
  ].join('\n') + '\n')
  for (const workspace of ['sim', 'robot']) {
    const dir = path.join(root, 'dsh', workspace)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'stream.jsonl'), JSON.stringify({ who: 'me', type: 'assistant/message', text: workspace }) + '\n')
  }
  const server = createDashboard()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}`
  return { log, url, request: (route, opts) => fetch(url + route, opts), root }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('vendor assets compress when accepted without changing their JavaScript', async t => {
  const { url } = await fixture(t)
  const read = (encoding) => new Promise((resolve, reject) => {
    http.get(url + '/vendor/three.core.js', { headers: { 'Accept-Encoding': encoding } }, async res => {
      try {
        const parts = []
        for await (const chunk of res) parts.push(chunk)
        resolve({ headers: res.headers, data: Buffer.concat(parts) })
      } catch (error) { reject(error) }
    }).on('error', reject)
  })
  const raw = await read('gzip;q=0, *;q=0.5')
  const zipped = await read('br, gzip')
  assert.equal(raw.headers['content-encoding'], undefined)
  assert.equal(zipped.headers['content-encoding'], 'gzip')
  assert.equal(zipped.headers.vary, 'Accept-Encoding')
  assert.ok(zipped.data.length < raw.data.length / 2)
  assert.deepEqual(gunzipSync(zipped.data), raw.data)
})

test('dashboard lists five sources and preserves physical references in coverage and recall', async t => {
  const { request } = await fixture(t)
  const overviewResponse = await request('/api/overview')
  assert.match(overviewResponse.headers.get('cache-control'), /no-store/)
  const overview = await overviewResponse.json()
  assert.equal(new Set(overview.streams.map(row => row.source)).size, 5)
  const codex = overview.streams.find(row => row.source === 'codex')
  assert.equal(codex.skipped, 1)
  assert.equal(codex.answered, 1)
  assert.equal(codex.turns, 2)
  assert.equal(codex.gaps[0].ref, 'codex:5')
  assert.equal(codex.path, undefined)
  const trace = await (await request('/api/records?source=codex&q=原始&mode=trace&limit=1')).json()
  assert.equal(trace.total, 2)
  assert.deepEqual(trace.records.map(row => row.ref), ['codex:3'])
  const page = await (await request('/api/records?source=codex&q=原始&mode=trace&limit=1&offset=1')).json()
  assert.equal(page.records[0].ref, 'codex:1')
  const recall = await (await request('/api/records?source=codex&q=原始答复&mode=recall')).json()
  assert.equal(recall.records[0].ref, 'codex:3')
  const details = await (await request('/api/record?ref=codex%3A3')).json()
  assert.equal(details.text, original)
  assert.equal(details.turn, 0)
  const tool = await (await request('/api/records?source=codex&q=原始工具&mode=trace&tools=1')).json()
  assert.equal(tool.records[0].ref, 'codex:6')
  assert.equal((await request('/api/record?ref=dsh:1')).status, 400)
  const dsh = await (await request('/api/record?ref=dsh:robot:1')).json()
  assert.equal(dsh.text, 'robot')
})

test('favorites persist refs only, preserve the original ledger and reject a changed source record', async t => {
  const { request, log, url, root } = await fixture(t)
  const bytes = await fs.readFile(log)
  const seen = await (await request('/api/record?ref=codex:3')).json()
  const edit = (ref, saved, revision = seen.revision) => request('/api/favorites', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-dashboard': '1', origin: url },
    body: JSON.stringify({ ref, saved, revision }),
  })
  assert.equal((await edit('codex:3', true)).status, 200)
  assert.equal((await edit('codex:3', true)).status, 200)
  const saved = await (await request('/api/records?favorites=1')).json()
  assert.deepEqual(saved.records.map(row => row.ref), ['codex:3'])
  assert.equal(digest(await fs.readFile(log)), digest(bytes))
  const sidecar = await fs.readFile(path.join(root, 'dashboard', 'favorites.json'), 'utf8')
  assert.doesNotMatch(sidecar, /原始答复/)
  await fs.writeFile(log, bytes.toString().replace('原始答复', '新的正文'))
  assert.equal((await edit('codex:3', true)).status, 409)
  const changed = await (await request('/api/records?favorites=1')).json()
  assert.deepEqual(changed.unavailable, ['codex:3'])
  assert.equal(changed.records.length, 0)
  assert.equal((await edit('codex:3', false)).status, 200)
  const after = await (await request('/api/records?favorites=1')).json()
  assert.equal(after.unavailable.length, 0)
})

test('rejects cross-origin or invalid input and serves only known assets', async t => {
  const { request, url } = await fixture(t)
  assert.equal((await request('/api/records', { headers: { origin: 'https://elsewhere.invalid' } })).status, 403)
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${url}/api/records`, { headers: { host: 'elsewhere.invalid' } }, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(foreignHostStatus, 403)
  assert.equal((await request('/api/favorites', { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await request('/api/favorites', { method: 'POST', headers: { origin: url, 'x-memory-dashboard': '1', 'content-type': 'application/json' }, body: 'bad' })).status, 400)
  assert.equal((await request('/api/records?limit=-1')).status, 400)
  assert.equal((await request('/api/record?ref=codex:0')).status, 400)
  assert.equal((await request('/api/record?ref=codex:92')).status, 404)
  assert.equal((await request('/HANDOFF.md')).status, 404)
  assert.equal((await request('/')).status, 200)
})

test('full map includes every browsable reference and sends only lightweight positions', async t => {
  const { log, request } = await fixture(t)
  const recent = Array.from({ length: 410 }, (_, i) => JSON.stringify({
    who: 'user', type: 'user/message', sid: 'many', ts: 10000 + i, text: '较新的记录',
  })).join('\n')
  await fs.appendFile(log, recent + '\n')
  const { total } = await (await request('/api/records')).json()
  const { points } = await (await request('/api/atlas/points')).json()
  assert.equal(points.length, total)
  assert.ok(points.every(([ref, source, position]) => ref && source && position.length === 3))
  assert.ok(!points.some(([ref]) => ref === 'codex:6'))
  const byRef = new Map(points.map(([ref,,position]) => [ref,position]))
  assert.ok(byRef.has('dsh:robot:1') && byRef.has('dsh:sim:1') && byRef.has('codex:3'))
  const scene = await (await request('/api/atlas?ref=codex:3')).json()
  assert.equal(scene.records.length, 2)
  assert.deepEqual(scene.records.find(row => row.ref === 'codex:3').position, byRef.get('codex:3'))
  assert.deepEqual(scene.relations.map(edge => edge.evidence), [['codex:1', 'codex:3']])
  assert.ok(scene.records.every(row => !Object.hasOwn(row, 'text')))
  const hits = await (await request('/api/records?mode=trace&q=较新的记录&limit=1&highlights=1')).json()
  assert.equal(hits.records.length, 1)
  assert.equal(hits.highlights.length, 100)
  assert.equal(hits.highlights[0], hits.records[0].ref)
  assert.equal((await request('/graph-data.mjs')).status, 200)
  assert.equal((await request('/gaia-star-shaders.mjs')).status, 200)
  assert.equal((await request('/vendor/OrbitControls.js')).status, 200)
  assert.equal((await request('/vendor/3d-force-graph.js')).status, 404)
})

test('tool points can be promoted on demand with canonical reference search', async t => {
  const { request } = await fixture(t)
  const tool = await (await request('/api/atlas?ref=codex:6')).json()
  assert.ok(tool.records.some(row => row.ref === 'codex:6' && row.position.every(Number.isFinite)))
  const result = await (await request('/api/records?q=codex:3&mode=trace&highlights=1')).json()
  assert.deepEqual(result.records.map(row => row.ref), ['codex:3'])
  assert.deepEqual(result.highlights, ['codex:3'])
  assert.equal((await request('/api/atlas?ref=dsh:2')).status, 400)
})
test('derived summary links its stored IDs to physical records and leaves other sessions alone', async t => {
  const { request, root } = await fixture(t)
  const dir = path.join(root,'opencode')
  await fs.mkdir(dir)
  const records = [
    { id:'user-id', seq:4, sid:'one', who:'user', kind:'message', text:'任务原话' },
    { id:'answer-id', seq:8, sid:'one', who:'assistant', kind:'message', text:'结果原话' },
    { id:'other-id', seq:9, sid:'other', who:'user', kind:'message', text:'另一会话' },
    { sid:'one', who:'system', kind:'episode', text:'阶段摘要', requestSeq:4,
      sourceIDs:['answer-id','other-id','missing-id'], source:{type:'derived.observation'} },
  ]
  await fs.writeFile(path.join(dir,'stream.jsonl'),records.map(record => JSON.stringify(record)).join('\n'))
  const atlas = await (await request('/api/atlas?ref=opencode:4')).json()
  const relations = atlas.relations.filter(edge => edge.kind==='reference')
  assert.deepEqual(relations.map(edge=>edge.target).sort(),['opencode:1','opencode:2'])
  const originals = await Promise.all(relations.flatMap(edge=>edge.evidence.map(async ref => {
    const response = await request('/api/record?ref='+ref)
    assert.equal(response.status,200)
    return (await response.json()).text
  })))
  assert.deepEqual(new Set(originals),new Set(['阶段摘要','任务原话','结果原话']))
})
