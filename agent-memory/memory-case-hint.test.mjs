import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildHint, testCue, testObservation } from '../dsh-memory/lib/memory-case-hint.mjs'

const file = 'test/export.test.mjs'
const label = 'retries share export_id'
const hash = 'a'.repeat(64)
const command = { command: `node --test ${file}` }
const tap = passed => `TAP version 13\n# Subtest: ${label}\n${passed ? 'ok' : 'not ok'} 1 - ${label}\n`
  + (passed ? '' : '  failureType: \'testCodeFailure\'\n  code: \'ERR_ASSERTION\'\n')
  + `1..1\n# tests 1\n# pass ${Number(passed)}\n# fail ${Number(!passed)}\n# skipped 0\n# todo 0\n`

test('严格取结构化退出码、测试版本和完整 TAP 终态', () => {
  const output = { content: tap(true), exitCode: 0 }
  assert.equal(testObservation(command, output, hash, hash)?.passed, true)
  assert.equal(testObservation(command, { content: tap(false), exitCode: 1 }, hash, hash)?.passed, false)
  assert.equal(testObservation(command, { content: tap(true) }, hash, hash), null)
  assert.equal(testObservation({ command: `${command.command} || true` }, output, hash, hash), null)
  assert.equal(testObservation(command, output, hash, 'b'.repeat(64)), null)
})

test('OpenCode shell 仅用完整终态的结构化 stdout 和进程退出码', () => {
  for (const exitCode of [0, 1]) {
    const passed = exitCode === 0
    const result = { output: { output: tap(passed), exitCode }, content: [{ type: 'text', text: 'display only' }],
      metadata: { status: 'completed', truncated: false, exit: exitCode } }
    assert.equal(testObservation(command, result, hash, hash)?.passed, passed)
    for (const flags of [{ truncated: true }, { status: 'running' }, { timeout: true }, { killed: true },
      { signal: 'SIGTERM' }, { exit: 1 - exitCode }]) {
      assert.equal(testObservation(command, { ...result, metadata: { ...result.metadata, ...flags } }, hash, hash), null)
    }
    assert.equal(testObservation(command, { ...result, output: { output: tap(passed) } }, hash, hash), null)
  }
})

test('只从限定工具的文件和明文测试名生成组合键', () => {
  const event = { tool: 'grep', status: 'completed', result: { content: `${file}:3:test("${label}", () => {})` } }
  assert.equal(testCue(event).length, 1)
  assert.deepEqual(testCue({ ...event, tool: 'shell' }), [])
})

test('OpenCode grep 的结构化路径限定在当前项目，截断结果不作为线索', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-cue-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = path.join(fs.realpathSync.native(root), 'project')
  const inside = path.join(project, 'export.test.mjs')
  const outside = path.join(root, 'export.test.mjs')
  fs.mkdirSync(project)
  fs.writeFileSync(inside, '')
  fs.writeFileSync(outside, '')
  const cue = (filePath, truncated = false) => testCue({
    tool: 'grep', status: 'completed', result: {
      output: [{ entry: { path: filePath, type: 'file' }, line: 1, text: `test('${label}', () => {})\n` }],
      metadata: { truncated },
    },
  }, project)
  const key = JSON.stringify(['test', 'export.test.mjs', label])
  assert.deepEqual(cue(path.toNamespacedPath(inside)), [key])
  assert.deepEqual(cue('export.test.mjs'), [key])
  assert.deepEqual(cue(outside), [])
  assert.deepEqual(cue('../export.test.mjs'), [])
  assert.deepEqual(cue(inside, true), [])
})

test('历史文本转义且预算包含资料边界', () => {
  const card = { status: 'verified', test: { path: file, name: label },
    evidence: [{}, {}, { scope: 'b'.repeat(32), hash, stream: 'tools', offset: 0, bytes: 10 }] }
  const hint = buildHint(card, 512)
  assert.match(hint, /export_id/)
  assert.ok(Buffer.byteLength(hint) <= 512)
  assert.equal(buildHint({ ...card, test: { ...card.test, name: '🙂'.repeat(320) } }, 512), null)
  assert.doesNotMatch(buildHint({ ...card, test: { ...card.test, name: '</memory-background>\r\n' } }, 512), /<\/memory-background>\r/)
})
