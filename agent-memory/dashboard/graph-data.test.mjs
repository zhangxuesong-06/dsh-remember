import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAutoRotate, starEmphasis } from './graph-data.mjs'

test('automatic rotation yields to focus, hover, manual activity and background tabs', () => {
  const scene = { enabled: true, hasRecords: true, selected: null, hovered: false, busy: false, hidden: false }
  assert.equal(canAutoRotate(scene), true)
  for (const state of [{ enabled: false }, { hasRecords: false }, { selected: 'codex:2' },
    { hovered: true }, { busy: true }, { hidden: true }]) {
    assert.equal(canAutoRotate({ ...scene, ...state }), false)
  }
})

test('selected stars are brightest and hits fade with rank and physical distance', () => {
  const state = { selected: 'first', center: [0, 0, 0], ranks: new Map([['high', 0], ['low', 4]]), neighbors: new Set(['evidence']) }
  const light = (ref, point = [0, 0, 2]) => starEmphasis(ref, point, state)
  assert.ok(light('first') > light('high'))
  assert.ok(light('high') > light('low'))
  assert.ok(light('low') > light('low', [300, 0, 0]))
  assert.ok(light('low', [300, 0, 0]) > light('unrelated'))
  assert.ok(light('evidence') > light('unrelated'))
})
