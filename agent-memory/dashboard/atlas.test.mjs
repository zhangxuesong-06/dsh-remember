import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAtlas, indexRelations } from './atlas.mjs'
import { pointDistance } from './graph-data.mjs'

const row = (ref, extra = {}) => ({ ref, source: 'codex', store: 'codex', ...extra })

test('relation index uses scoped turns and preserves reciprocal citation direction', () => {
  const records = [
    row('codex:1', { sid: 's', turnID: 'a', references: ['codex:2', 'codex:1', 'missing'] }),
    row('codex:2', { sid: 's', turnID: 'a', references: ['codex:1'] }),
    row('codex:3', { store: 'another', sid: 's', turnID: 'a' }),
    row('codex:4', { sid: 's', turnID: 'b' }),
    row('codex:5', { sid: 's', turnID: 'a' }),
  ]
  const relations = indexRelations(records)
  assert.deepEqual(relations.around('codex:1').filter(edge => edge.kind === 'reference').map(edge => edge.evidence), [
    ['codex:1', 'codex:2'], ['codex:2', 'codex:1'],
  ])
  assert.deepEqual(relations.around('codex:5').map(edge => edge.evidence).sort(), [
    ['codex:1', 'codex:5'], ['codex:2', 'codex:5'],
  ])
  assert.deepEqual(relations.around('codex:3'), [])
  assert.deepEqual(relations.around('codex:4'), [])
})

test('evidence components form separated volumes and layout is independent of ledger traversal order', () => {
  const records = Array.from({ length: 120 }, (_, index) => row('codex:' + index, {
    sid: 's', turnID: String(Math.floor(index / 4)),
  }))
  records.push(row('codex:solo'))
  const first = buildAtlas(records, indexRelations(records).layoutEdges)
  const second = buildAtlas([...records].reverse(), indexRelations([...records].reverse()).layoutEdges)
  assert.deepEqual(first, second)
  assert.equal(first.size, records.length)
  assert.ok([...first.values()].flat().every(Number.isFinite))
  assert.equal(new Set([...first.values()].map(String)).size, records.length)
  assert.ok(new Set([...first.values()].map(point => Math.round(Math.hypot(...point)))).size > 25)
  const points = [0, 1, 2, 3].map(index => first.get('codex:' + index))
  const linked = points.map(point => pointDistance(points[0], point))
  const unrelated = records.slice(4, 120).map(record => pointDistance(points[0], first.get(record.ref)))
  assert.ok(Math.max(...linked) < Math.min(...unrelated))
})
