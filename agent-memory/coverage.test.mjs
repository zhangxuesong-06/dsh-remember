import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
fs.mkdirSync(base, { recursive: true })
const tmp = fs.mkdtempSync(path.join(base, 'coverage-test-'))
const ocRoot = path.join(tmp, 'oc')
const dshHome = path.join(tmp, 'dsh')
const wbRoot = path.join(tmp, 'wb')
const zcRoot = path.join(tmp, 'zc')

process.env.OPENCODE_MEM_HOME = ocRoot
process.env.DSH_HOME = dshHome
process.env.WORKBUDDY_MEM_HOME = wbRoot
process.env.ZCODE_MEM_HOME = zcRoot

const cov = await import('./coverage.mjs')

const NOW = Date.now()

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function fixtures() {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  writeJsonl(path.join(ocRoot, 'stream.jsonl'), [
    { who: 'user', kind: 'message', sid: 's-oc', id: 'o1', ts: NOW - 3000, text: '第一问' },
    { who: 'assistant', kind: 'message', sid: 's-oc', id: 'o2', ts: NOW - 2000, text: '第一答' },
    { who: 'user', kind: 'message', sid: 's-oc', id: 'o3', ts: NOW - 1000, text: '第二问' },
    { who: 'assistant', kind: 'message', sid: 's-oc', id: 'o4', ts: NOW, text: '第二答' },
  ])
  writeJsonl(path.join(dshHome, 'dsh-memory', 'ws-a', 'stream.jsonl'), [
    { who: 'he', type: 'user/message', sid: 's-dsh', ts: NOW - 3000, text: '问一' },
    { who: 'me', type: 'assistant/message', sid: 's-dsh', ts: NOW - 2000, text: '答一' },
    { who: 'he', type: 'user/message', sid: 's-dsh', ts: NOW - 1000, text: '问二没答' },
  ])
  writeJsonl(path.join(wbRoot, 'stream.jsonl'), [
    { who: 'he', type: 'user/message', sid: 's-wb', ts: NOW - 1000, text: '问了没答' },
  ])
  writeJsonl(path.join(zcRoot, 'stream.jsonl'), [
    { who: 'me', type: 'assistant/message', sid: 's-zc', ts: NOW - 5000, text: '没有提问的回答' },
    { who: 'he', type: 'user/message', sid: 's-zc', turn: 't1', ts: NOW - 4000, text: '问一' },
    { who: 'act', type: 'tool/call', sid: 's-zc', turn: 't1', callId: 'c1', ts: NOW - 3900, text: '调 c1' },
    { who: 'act', type: 'tool/result', sid: 's-zc', turn: 't1', callId: 'c1', ts: NOW - 3800, text: 'c1 结果' },
    { who: 'act', type: 'tool/call', sid: 's-zc', turn: 't1', callId: 'c2', ts: NOW - 3700, text: '调 c2' },
    { who: 'me', type: 'assistant/message', sid: 's-zc', turn: 't1', ts: NOW - 3600, text: '答一' },
    { who: 'he', type: 'user/message', sid: 's-zc', turn: 't2', ts: NOW - 3000, text: '问二没答' },
    { who: 'act', type: 'tool/result', sid: 's-zc', turn: 't2', callId: 'c3', ts: NOW - 2900, text: '孤儿结果' },
    { who: 'he', type: 'user/message', sid: 's-zc', turn: 't3', ts: NOW - 2000, text: '问三' },
    { who: 'me', type: 'assistant/message', sid: 's-zc', turn: 't3', ts: NOW - 1000, text: '答三' },
  ])
}

beforeEach(fixtures)
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('四个来源都按「用户轮有没有回答」统计', () => {
  const rows = cov.coverage()
  const by = new Map(rows.map((r) => [r.source, r]))
  assert.deepEqual(rows.map((r) => r.source), ['opencode', 'dsh', 'workbuddy', 'zcode'])
  assert.equal(by.get('opencode').turns, 2)
  assert.equal(by.get('opencode').answered, 2)
  assert.equal(by.get('opencode').unanswered, 0)
  assert.equal(by.get('dsh').turns, 2)
  assert.equal(by.get('dsh').answered, 1)
  assert.equal(by.get('dsh').unanswered, 1)
  assert.equal(by.get('workbuddy').turns, 1)
  assert.equal(by.get('workbuddy').rate, 0)
  assert.equal(by.get('zcode').turns, 3)
  assert.equal(by.get('zcode').answered, 2)
  assert.equal(by.get('zcode').unanswered, 1)
  assert.equal(by.get('zcode').followup, 1)
  assert.equal(by.get('zcode').silent, 0, '后面还有回答，只是合并在后一轮')
  assert.equal(by.get('zcode').effective, 1)
  assert.equal(by.get('zcode').orphanAssistant, 1)
  assert.equal(by.get('dsh').silent, 1)
  assert.equal(by.get('dsh').followup, 0)
  assert.equal(by.get('workbuddy').silent, 1)
})

test('工具配对：调用缺结果、结果缺调用分别计数', () => {
  const zc = cov.coverage({ source: 'zcode' })[0]
  assert.equal(zc.tools.calls, 2)
  assert.equal(zc.tools.results, 2)
  assert.equal(zc.tools.noResult, 1)
  assert.equal(zc.tools.noCall, 1)
})

test('--source 与 since 过滤生效', () => {
  assert.equal(cov.coverage({ source: 'dsh' }).length, 1)
  assert.equal(cov.coverage({ source: 'dsh' })[0].source, 'dsh')
  const recent = cov.coverage({ since: NOW - 500 })[0]
  assert.equal(recent.source, 'opencode')
  assert.equal(recent.turns, 0, '时间窗内没有用户消息')
})

test('缺失轮带可回读的引用行号', () => {
  const zc = cov.coverage({ source: 'zcode' })[0]
  assert.equal(zc.worst.length, 1)
  assert.equal(zc.worst[0].missing, 1)
  assert.equal(zc.worst[0].firstMissing.line, 7)
})

test('format 输出表头与来源名', () => {
  const text = cov.format(cov.coverage())
  assert.match(text, /source\s+ok\s+sessions/)
  for (const name of ['opencode', 'dsh', 'workbuddy', 'zcode']) assert.ok(text.includes(name))
})
