import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { evaluateModelRuns } from './eval-cases.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/memory-cases.json', import.meta.url), 'utf8'))
const makeRuns = () => fixture.evaluation.flatMap(([scenario, kind]) => [1, 2, 3].flatMap(repetition =>
  ['baseline', 'manual', 'auto'].map(mode => ({
    scenario, repetition, mode, model: 'synthetic', snapshot: 'same-tree',
    inputTokens: mode === 'auto' ? 80 : 100, testPassed: true, wrongReuse: false,
    correctReuse: mode === 'auto' && ['tool', 'prompt'].includes(kind),
    outOfScope: false, exactEvidence: true,
  }))))

test('三组对照校验配对、复用增益、证据和整题预算', () => {
  const runs = makeRuns()
  assert.equal(evaluateModelRuns({ runs }).passed, true)
  assert.throws(() => evaluateModelRuns({ runs: runs.slice(1) }), /incomplete trial/)
  assert.throws(() => evaluateModelRuns({ runs: [...runs, runs[0]] }), /duplicate run/)
  const auto = runs.find(run => run.mode === 'auto')
  auto.outOfScope = true
  assert.equal(evaluateModelRuns({ runs }).checks.scope, false)
  auto.inputTokens = 5000
  assert.equal(evaluateModelRuns({ runs }).checks.averageInput, false)
})
