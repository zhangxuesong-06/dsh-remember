import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { caseSource, caseWatermark, readEvidence, runCaseSync, searchCases } from '../dsh-memory/lib/memory-case-index.mjs'
import { digest } from '../dsh-memory/lib/memory-cards.mjs'
import { buildHint, promptCue, testCue } from '../dsh-memory/lib/memory-case-hint.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/memory-cases.json', import.meta.url), 'utf8'))

function checkCase(directory, [id, kind, symbol]) {
  const root = fs.mkdirSync(path.join(directory, id), { recursive: true })
  const project = fs.mkdirSync(path.join(root, 'current'), { recursive: true })
  const foreign = fs.mkdirSync(path.join(root, 'other'), { recursive: true })
  const blobs = fs.mkdirSync(path.join(root, 'blobs'), { recursive: true })
  const stream = path.join(root, 'stream.jsonl')
  const tools = path.join(root, 'tools.jsonl')
  const file = `test/${id}.test.mjs`
  const name = `retries share ${symbol}`
  const ws = kind === 'foreign' ? foreign : project
  const record = (data, sid = 'old') => JSON.stringify({ ws, sid, turnID: 'first', ...data }) + '\n'
  const output = (passed, sid) => {
    const bytes = `${id} ${sid} ${passed ? 'passed' : 'failed'}`
    const hash = digest(bytes)
    fs.writeFileSync(path.join(blobs, hash), bytes)
    return { phase: 'completed', tool: 'shell', id: `${sid}-${passed}`, ts: passed ? 3 : 2,
      output: { sha256: hash }, caseTest: { path: file, name, passed, sha: 'a'.repeat(64) } }
  }
  const sessions = kind === 'ambiguous' ? ['old', 'other'] : ['old']
  if (kind !== 'none') {
    fs.writeFileSync(stream, sessions.map(sid => record({ id: `request-${sid}`, who: 'user', text: symbol, ts: 1 }, sid)).join(''))
    fs.writeFileSync(tools, sessions.map(sid => (kind === 'observed' ? '' : record(output(false, sid), sid)) + record(output(true, sid), sid)).join(''))
  }
  const source = caseSource('opencode', root, project)
  assert.equal(runCaseSync(source).state, 'ready')
  let watermark = caseWatermark(source)
  const query = () => searchCases(source, { cue: symbol })
  if (kind === 'corrected' || kind === 'pending-correction') {
    const { id: old } = query().cards.find(card => card.kind === 'case')
    fs.appendFileSync(stream, record({ id: 'correction', kind: 'correction', text: '规则已撤回', supersedes: old }))
    if (kind === 'corrected') {
      assert.equal(runCaseSync(source).state, 'ready')
      watermark = caseWatermark(source)
    }
  }
  if (kind === 'corrupt') {
    const ref = query().cards.find(card => card.kind === 'case').evidence[2]
    fs.writeFileSync(path.join(blobs, ref.sha256), 'damaged')
  }
  const keys = kind === 'prompt' ? promptCue(`\`${file}\` 的 \`${name}\``)
    : kind === 'unobservable' ? []
      : testCue({ tool: 'grep', status: 'completed', result: { content:
        `${kind === 'wrong-path' ? 'other.test.mjs' : file}:1:test('${kind === 'wrong-anchor' ? name + ' again' : name}', () => {})` } })
  const { cards } = searchCases(source, { keys, watermark })
  const candidate = cards.length === 1 && cards[0].evidence.every(ref => readEvidence(source, ref).state === 'exact') ? cards[0] : null
  const hint = buildHint(candidate, 512)
  return { id, kind, expected: kind === 'tool' || kind === 'prompt', delivered: !!hint, bytes: Buffer.byteLength(hint || '') + (hint ? 2 : 0) }
}

export function evaluateCases(split = 'evaluation') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'case-eval-'))
  try {
    const rows = fixture[split].map(scenario => checkCase(directory, scenario))
    return { scenarios: rows.length, matched: rows.filter(r => r.expected && r.delivered).length,
      falsePrompts: rows.filter(r => !r.expected && r.delivered).length, maxHintBytes: Math.max(...rows.map(r => r.bytes)), rows }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

export function evaluateModelRuns({ runs }) {
  const modes = ['baseline', 'manual', 'auto']
  const ids = new Set(fixture.evaluation.map(([id]) => id))
  const samples = new Set()
  const comparable = new Map()
  assert.ok(Array.isArray(runs), 'runs must be an array')
  for (const run of runs) {
    const { scenario, repetition, mode, model, snapshot, inputTokens } = run
    assert.ok(ids.has(scenario) && modes.includes(mode) && Number.isInteger(repetition) && repetition >= 1, 'unknown run')
    assert.ok(typeof model === 'string' && model && typeof snapshot === 'string' && snapshot, 'model and snapshot required')
    const trial = `${scenario}/${repetition}`
    const sample = `${trial}/${mode}`
    assert.ok(!samples.has(sample), `duplicate run ${sample}`)
    samples.add(sample)
    const config = JSON.stringify([model, snapshot])
    if (comparable.has(trial)) assert.equal(config, comparable.get(trial), `incomparable trial ${trial}`)
    comparable.set(trial, config)
    for (const flag of ['correctReuse', 'wrongReuse', 'testPassed', 'outOfScope', 'exactEvidence']) {
      assert.equal(typeof run[flag], 'boolean', `${sample} requires ${flag}`)
    }
    assert.ok(Number.isSafeInteger(inputTokens) && inputTokens > 0, `${sample} requires actual inputTokens`)
  }
  for (const trial of comparable.keys()) {
    assert.ok(modes.every(mode => samples.has(`${trial}/${mode}`)), `incomplete trial ${trial}`)
  }
  for (const id of ids) {
    assert.ok([1, 2, 3].every(rep => comparable.has(`${id}/${rep}`)), `three repetitions required for ${id}`)
  }
  const summarize = mode => {
    const rows = runs.filter(run => run.mode === mode)
    const tokens = rows.map(r => r.inputTokens).sort((a, b) => a - b)
    const count = predicate => rows.filter(predicate).length
    return { count: rows.length, correct: count(r => r.correctReuse), wrong: count(r => r.wrongReuse),
      failed: count(r => !r.testPassed), meanInput: tokens.reduce((a, b) => a + b, 0) / tokens.length,
      p95Input: tokens[Math.ceil(0.95 * tokens.length) - 1] }
  }
  const groups = Object.fromEntries(modes.map(mode => [mode, summarize(mode)]))
  const { auto, manual, baseline } = groups
  const checks = {
    scope: runs.every(run => !run.outOfScope),
    evidence: runs.every(run => run.exactEvidence),
    reuseGain: (auto.correct - manual.correct) / auto.count >= 0.15,
    errors: [baseline, manual].every(group => auto.wrong <= group.wrong && auto.failed <= group.failed),
    averageInput: [baseline, manual].every(group => auto.meanInput <= group.meanInput),
    p95Input: auto.p95Input <= baseline.p95Input * 1.05,
  }
  return { passed: Object.values(checks).every(Boolean), checks, groups }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const input = process.argv.indexOf('--input')
  const result = input >= 0 ? evaluateModelRuns(JSON.parse(fs.readFileSync(process.argv[input + 1], 'utf8')))
    : evaluateCases(process.argv.includes('--tuning') ? 'tuning' : 'evaluation')
  console.log(JSON.stringify(result, null, 2))
  if (process.argv.includes('--check') && (result.passed === false || result.rows?.some(row => row.expected !== row.delivered))) {
    process.exitCode = 1
  }
}
