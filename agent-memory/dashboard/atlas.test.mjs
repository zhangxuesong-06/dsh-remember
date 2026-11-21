import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAtlas, createAtlasStore, inferRelations } from './atlas.mjs'
import { angularDistance, clusterHits, glowAtAngle, orbitPoint, sphereRadius } from './sphere.mjs'

const row = (ref, text, extra = {}) => ({
  ref, text, source: ref.startsWith('dsh:') ? 'dsh' : 'codex', workspace: '', sid: null, line: 1, ...extra,
})
const fake = [
  row('dsh:robot:1', '实车激光雷达外参方向怎么定', { workspace:'robot', sid:'s', turn:0, line:1 }),
  row('dsh:robot:2', '实车外参 lidar 到 base_link，平移以米计', { workspace:'robot', sid:'s', turn:0, line:2 }),
  row('dsh:sim:2', '仿真外参 base_link 到 lidar，用来检查逆变换', { workspace:'sim', sid:'s', turn:0, line:2 }),
  row('codex:7', '长对话里也可能换到别的话题', { sid:'s', turn:0, line:7 }),
  row('codex:8', '缓存离线读写与本地文件保留期限', { sid:'s', turn:1, line:8 }),
]

test('same-turn evidence is scoped to the ledger; textual similarity is a separate signal', () => {
  const links = inferRelations(fake)
  const evidence = links.filter(edge => edge.kind === 'turn')
  assert.deepEqual(evidence.map(edge => [edge.source, edge.target]), [['dsh:robot:1','dsh:robot:2']])
  assert.ok(!links.some(edge => edge.evidence && edge.target === 'dsh:sim:2'))
  assert.ok(links.every(edge => edge.kind === 'turn' || !edge.evidence))
})

test('layout sticks to the sphere, ranks known neighbors ahead of a conflicting workspace, and anchors old points', () => {
  const previous = new Map()
  const built = buildAtlas(fake, previous)
  const a = built.positions.get('dsh:robot:1')
  const b = built.positions.get('dsh:robot:2')
  const c = built.positions.get('dsh:sim:2')
  assert.ok(angularDistance(a,b) < angularDistance(a,c))
  for (const position of built.positions.values()) assert.ok(Math.abs(Math.hypot(...position) - sphereRadius) < 1e-8)
  const replay = buildAtlas([...fake].reverse(), new Map())
  assert.deepEqual(built.positions, replay.positions)
  const next = buildAtlas([...fake, row('codex:9','离线读写缓存让数据可用')], built.positions)
  for (const [ref, position] of built.positions) assert.deepEqual(next.positions.get(ref), position)
})

test('cache keys distinguish physical records occupying a reused line', () => {
  const store = createAtlasStore()
  const first = store.snapshot(fake)
  const second = store.snapshot([...fake, row('codex:9','缓存试验')])
  assert.deepEqual(first.positions.get('codex:7'), second.positions.get('codex:7'))
  const changed = fake.map(record => record.ref === 'codex:7' ? { ...record, text: '已经换掉的原话' } : record)
  const third = store.snapshot(changed)
  assert.notDeepEqual(third.positions.get('codex:7'), first.positions.get('codex:7'))
})

test('antipodal motion stays outside the sphere and finishes on the target radial', () => {
  const distance = sphereRadius + 120
  const a = [0,0,distance], b = [0,0,-sphereRadius]
  for (let i=0;i<=10;i++) assert.ok(Math.hypot(...orbitPoint(a,b,distance,i/10)) > sphereRadius)
  assert.deepEqual(orbitPoint(a,b,distance,1),[0,0,-distance])
})

test('keyword hits cluster by angular distance and fade outward', () => {
  const points = new Map([['first',[0,0,1]],['other',[0,0,-1]],['near',[.2,0,1]],['far',[1,0,0]]])
  const groups = clusterHits([...points.keys()], points)
  assert.deepEqual(groups.map(group => group.refs), [['first','near'],['other'],['far']])
  assert.ok(glowAtAngle(0) > glowAtAngle(.55))
  assert.ok(glowAtAngle(.55) > glowAtAngle(1.04))
})

test('several strong hits in a compact region outrank a single top-ranked outlier', () => {
  const points = new Map([['outlier',[0,0,-1]],['two',[0,0,1]],['three',[.1,0,1]],['four',[0,.1,1]]])
  const regions = clusterHits([...points.keys()], points)
  assert.deepEqual(regions[0].refs,['two','three','four'])
  assert.equal(regions[0].center,'two')
})
test('a citation resolved by a later append creates evidence without relocating the summary', () => {
  const store = createAtlasStore()
  const summary = row('codex:1','摘录', { evidenceIds:['future'] })
  const first = store.snapshot([summary])
  const next = store.snapshot([{ ...summary, references:['codex:2'] }, row('codex:2','后来补录的原话')])
  assert.deepEqual(next.positions.get('codex:1'),first.positions.get('codex:1'))
  assert.deepEqual(next.relations.filter(edge=>edge.kind==='reference').map(edge=>edge.evidence),[['codex:1','codex:2']])
})

test('unverified textual suggestions do not move published neighborhoods', () => {
  const records = [row('codex:1','离线缓存文件保留期限'),row('codex:2','离线缓存文件保留期限')]
  const atlas = buildAtlas(records)
  assert.equal(atlas.relations[0].kind,'lexical')
  assert.deepEqual(atlas.positions,buildAtlas(records,new Map(),[]).positions)
})

test('the full view reserves out-of-sample points near known evidence without moving any snapshots', () => {
  const store = createAtlasStore()
  const pinned = store.snapshot([fake[0],fake[2]]).positions
  const full = store.reserveOverview(fake)
  assert.deepEqual(full.get(fake[0].ref),pinned.get(fake[0].ref))
  assert.deepEqual(full.get(fake[2].ref),pinned.get(fake[2].ref))
  assert.ok(angularDistance(full.get(fake[0].ref), full.get(fake[1].ref)) < .23)
  const opened = store.snapshot(fake).positions
  assert.deepEqual(opened,full)
})
