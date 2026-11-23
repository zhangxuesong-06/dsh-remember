import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCard } from '../dsh-memory/lib/memory-cards.mjs'

const event = (kind, data, id = kind) => ({ kind, data, id, project: '/project', sid: 's', turn: 't', ts: 1,
  ref: { id, stream: 'stream', field: 'text' } })
const testRun = (id, passed, sha = 'a'.repeat(64)) => event('test', {
  path: 'test/export.test.mjs', name: 'retries share export_id', symbol: 'export_id', passed, sha,
}, id)

test('案例要求同一测试文件版本中的断言失败和后续通过', () => {
  const request = event('request', { text: '导出断了再点别多一份' })
  const failure = testRun('fail', false)
  const pass = { ...testRun('pass', true), ts: 2 }
  const project = (...events) => projectCard('case', 'turn', events)
  assert.equal(project(request, pass).status, 'observed')
  assert.equal(project(request, failure, { ...testRun('pass', true, 'b'.repeat(64)), ts: 2 }).status, 'observed')
  assert.equal(project(request, failure, pass).status, 'verified')
  assert.deepEqual(project(pass, request, failure), project(request, failure, pass))
  assert.deepEqual(project(request, failure, pass).evidence.map(r => r.id), ['request', 'fail', 'pass'])
})

test('迟到调用只补齐工具观察，调用完成不构成测试通过', () => {
  const result = event('result', { tool: 'Write', phase: 'completed', path: 'test/export.test.mjs' })
  const call = event('call', { tool: 'Write', path: 'test/export.test.mjs' })
  const partial = projectCard('tool', 'result', [result])
  const complete = projectCard('tool', 'result', [call, result])
  assert.equal(complete.id, partial.id)
  assert.equal(complete.status, 'observed')
  assert.equal(complete.evidence.length, 2)
})
