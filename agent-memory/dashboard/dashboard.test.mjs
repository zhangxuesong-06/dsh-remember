import assert from 'node:assert/strict'
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
    JSON.stringify({ who: 'user', type: 'user/message', sid: 'one', ts: 1000, text: '原始问题' }),
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

test('star map mixes adapter sources while searches can still reach older records outside the map', async t => {
  const { log, request } = await fixture(t)
  const recent = Array.from({ length: 410 }, (_, i) => JSON.stringify({
    who: 'user', type: 'user/message', sid: 'many', ts: 10000 + i, text: '较新的记录',
  })).join('\n')
  await fs.appendFile(log, recent + '\n')
  const response = await request('/api/records?scene=1')
  const { records, scene, total } = await response.json()
  assert.equal(records.length, 12)
  assert.equal(scene.length, 360)
  assert.ok(scene.some(row => row.ref === 'dsh:robot:1'))
  assert.ok(scene.some(row => row.ref === 'dsh:sim:1'))
  assert.ok(scene.every(row => !Object.hasOwn(row, 'text')))
  assert.ok(total > scene.length)
  assert.ok(!scene.some(row => row.ref === 'codex:3'))
  const atlas = await (await request('/api/atlas')).json()
  assert.equal(atlas.records.length, 360)
  assert.deepEqual(new Set(atlas.records.map(row => row.source)), new Set(['dsh', 'codex']))
  const allResponse = await request('/api/atlas/points')
  assert.equal(allResponse.status, 200)
  const { points } = await allResponse.json()
  assert.equal(points.length, total)
  assert.ok(points.every(point => point.length === 3 && point[2].length === 3))
  assert.ok(!points.some(([ref]) => ref === 'codex:6'))
  const byRef = new Map(points.map(([ref,,position]) => [ref,position]))
  for (const record of atlas.records) assert.deepEqual(byRef.get(record.ref), record.position)
  const focused = await (await request('/api/atlas?ref=codex:3')).json()
  assert.deepEqual(focused.records.find(row => row.ref === 'codex:3').position, byRef.get('codex:3'))
  const found = await (await request('/api/records?mode=trace&q=原始答复')).json()
  assert.deepEqual(found.records.map(row => row.ref), ['codex:3'])
  assert.equal(found.records[0].sid, 'one')
  assert.equal(found.records[0].line, 3)
  assert.equal((await request('/graph-data.mjs')).status, 200)
})

test('atlas returns a stable ball and supports canonical reference search', async t => {
  const { request } = await fixture(t)
  const first = await (await request('/api/atlas')).json()
  assert.ok(first.records.length > 0)
  assert.equal(first.basis, 'evidence')
  assert.equal(first.records.some(row => Object.hasOwn(row, 'text')), false)
  const tool = await (await request('/api/atlas?ref=codex:6')).json()
  assert.ok(tool.records.some(row => row.ref === 'codex:6'))
  for (const row of first.records) assert.deepEqual(tool.records.find(item => item.ref === row.ref).position, row.position)
  const result = await (await request('/api/records?q=codex:3&mode=trace')).json()
  assert.deepEqual(result.records.map(row => row.ref), ['codex:3'])
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
  const atlas = await (await request('/api/atlas')).json()
  const relations = atlas.relations.filter(edge => edge.kind==='reference')
  assert.deepEqual(relations.map(edge=>edge.target).sort(),['opencode:1','opencode:2'])
  const originals = await Promise.all(relations.flatMap(edge=>edge.evidence.map(async ref => {
    const response = await request('/api/record?ref='+ref)
    assert.equal(response.status,200)
    return (await response.json()).text
  })))
  assert.deepEqual(new Set(originals),new Set(['阶段摘要','任务原话','结果原话']))
})
