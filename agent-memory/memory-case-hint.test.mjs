import assert from 'node:assert/strict'
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

test('只从限定工具的文件和明文测试名生成组合键', () => {
  const event = { tool: 'grep', status: 'completed', result: { content: `${file}:3:test("${label}", () => {})` } }
  assert.equal(testCue(event).length, 1)
  assert.deepEqual(testCue({ ...event, tool: 'shell' }), [])
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
