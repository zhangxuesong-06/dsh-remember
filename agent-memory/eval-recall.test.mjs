import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./eval-recall.mjs', import.meta.url))
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/recall-cases.json', import.meta.url), 'utf8'))

test('默认用五端合成流，排名与回读结果可复现', () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const first = run('--json')
  const second = run('--json')
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  const report = JSON.parse(first.stdout)
  assert.deepEqual(Object.keys(report.bySource), ['opencode', 'dsh', 'workbuddy', 'zcode', 'codex'])
  assert.equal(report.cases.length, 7)
  assert.ok(report.cases.every((item) => item.evidence))
  assert.equal(report.cases.find(({ id }) => id === 'cache-correction').evidence.who, 'user')
  assert.equal(report.cases.find(({ id }) => id === 'late-archive-answer').evidence.turn, 0)
  assert.equal(report.cases.find(({ id }) => id === 'robot-extrinsics').ref, 'dsh:robot:2')
  const missed = report.cases.find(({ id }) => id === 'archive-paraphrase')
  assert.equal(missed.rank, null)
  assert.equal(missed.evidence.ref, 'zcode:4')
  const check = run('--check')
  assert.equal(check.status, 0, check.stderr)
})

test('目标原话改变时报出题号和出处，同轮或同名记录不能替代', async () => {
  const { evaluateFixture, baselineDifferences } = await import('./eval-recall.mjs')
  const baseline = evaluateFixture(fixture)
  const changed = structuredClone(fixture)
  const rows = changed.streams.find(({ workspace }) => workspace === 'robot').rows
  rows[1].text = '实车外参的方向和单位仍待核对。'
  const report = evaluateFixture(changed)
  const target = report.cases.find(({ id }) => id === 'robot-extrinsics')
  assert.equal(target.evidence, null)
  assert.equal(target.rank, null)
  assert.ok(baselineDifferences(report, baseline).some((line) =>
    line.includes('robot-extrinsics') && line.includes('dsh:robot:2')))
})
