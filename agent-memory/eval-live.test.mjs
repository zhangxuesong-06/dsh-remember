import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLiveCases, splitLiveCases } from './eval-live.mjs'

test('真实评测只把有唯一提问的同库同会话同轮助手消息计为回答', () => {
  const make = (source, sid, line, who, turn, workspace = '') => ({
    source, store: `${source}/${workspace}`, workspace, sid, line, kind: 'message',
    who, turn, ts: line, text: who === 'user' ? '现场标定参数怎么核对和记录？' : '先备份现有变换矩阵再复测。',
  })
  const records = [
    make('dsh', 'same', 1, 'user', 0, 'car'),
    make('dsh', 'same', 2, 'assistant', 0, 'car'),
    make('dsh', 'same', 2, 'assistant', 0, 'sim'),
    make('dsh', 'other', 3, 'assistant', 0, 'car'),
    make('zcode', 'same', 1, 'user', 0),
    make('zcode', 'same', 2, 'user', 0),
    make('zcode', 'same', 3, 'assistant', 0),
    make('workbuddy', 'wb', 1, 'user', null),
    make('workbuddy', 'wb', 2, 'assistant', null),
  ]
  const { answers, clues } = buildLiveCases(records)
  assert.deepEqual(answers.map(({ input, refs }) => [input, [...refs]]), [
    ['dsh:car:1', ['dsh:car:2']],
  ])
  assert.ok(clues.some(({ refs }) => refs.has('workbuddy:2')))
  assert.ok(clues.every(({ query }) => !records.some(({ text }) => query === text)))
})

test('两类题共用会话划分，单个会话的样本数有限', () => {
  const older = { source: 'codex', session: 'older', ts: 1 }
  const newer = { source: 'codex', session: 'newer', ts: 2 }
  const answers = Array.from({ length: 16 }, (_, index) => ({ ...older, query: `题目 ${index}` }))
  const split = splitLiveCases({ answers, clues: [older, newer] })
  assert.equal(split.answers.tune.length, 12)
  assert.deepEqual(split.answers.holdout, [])
  assert.deepEqual(split.clues, { tune: [older], holdout: [newer] })
})
