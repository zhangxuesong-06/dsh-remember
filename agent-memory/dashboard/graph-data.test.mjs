import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph } from './graph-data.mjs'
import { canAutoRotate } from './graph-view.mjs'

test('renderer preserves published coordinates and only draws evidence links', () => {
  const a = { ref:'codex:1', position:[300,0,0] }
  const b = { ref:'codex:2', position:[0,300,0] }
  const data = buildGraph([a,b], [
    { kind:'lexical', source:a.ref, target:b.ref },
    { kind:'turn', source:b.ref, target:a.ref, evidence:[b.ref,a.ref] },
  ])
  assert.equal(data.nodes[0].fx, 300)
  assert.deepEqual(data.links.map(edge => [edge.start,edge.end]), [[b.position,a.position]])
})

test('automatic rotation yields to node focus, hover, manual activity and background tabs', () => {
  const scene = { enabled: true, hasRecords: true, selected: null, hovered: false, busy: false, hidden: false }
  assert.equal(canAutoRotate(scene), true)
  for (const state of [{ enabled: false }, { hasRecords: false }, { selected: 'codex:2' },
    { hovered: true }, { busy: true }, { hidden: true }]) {
    assert.equal(canAutoRotate({ ...scene, ...state }), false)
  }
})
