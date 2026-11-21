import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph } from './graph-data.mjs'
import { canAutoRotate } from './graph-view.mjs'
import { buildStarField, starEmphasis } from './star-field.mjs'

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

test('the star field preserves each unique position across the full view and search details', () => {
  const full = [['codex:1','codex',[300,0,0]], ['codex:2','codex',[0,300,0]]]
  const recent = { ref:'codex:2', source:'codex', position:full[1][2] }
  const promoted = { ref:'codex:1', source:'codex', position:full[0][2] }
  const overview = buildStarField([recent],full)
  const focused = buildStarField([recent,promoted],full)
  assert.equal(overview.length,2)
  assert.deepEqual(focused,overview)
  assert.deepEqual(overview.map(row=>row.position), full.map(row=>row[2]))
})

test('star density emphasizes a packed neighborhood while leaving isolated stars sparse', () => {
  const nearby = Array.from({length:12}, (_,index) => {
    const angle = index / 160
    return [`codex:${index+1}`,'codex',[300 * Math.sin(angle),0,300 * Math.cos(angle)]]
  })
  const stars = buildStarField([], [...nearby,['codex:99','codex',[0,0,-300]]])
  assert.ok(stars[0].density > .85)
  assert.equal(stars.at(-1).density,0)
  assert.deepEqual(stars[0].position,nearby[0][2])
})

test('star highlights fall off with angle and rank, with a separate level for direct evidence', () => {
  const focus = { selected:'first', center:[0,0,300], ranks:new Map([['close',0],['lower',5],['far',1]]), neighbors:new Set(['evidence']) }
  const level = (ref,position) => starEmphasis({ref,position},focus)
  assert.ok(level('first',focus.center) > level('close',focus.center))
  assert.ok(level('close',focus.center) > level('lower',focus.center))
  assert.ok(level('lower',focus.center) > level('far',[0,0,-300]))
  assert.ok(level('evidence',focus.center) > level('unrelated',focus.center))
})
