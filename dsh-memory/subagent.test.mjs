// 子代理口径：任务提示标 meta，对话丢弃，只留工具/产物证据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { isSubagent, filterSubagentRecords } from './lib/subagent.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-'))
process.env.DSH_HOME = root
after(() => fs.rmSync(root, { recursive: true, force: true }))

const CWD = 'D:\\ws'

test('isSubagent 认深度和 origin', () => {
  assert.equal(isSubagent({ delegationDepth: 1 }), true)
  assert.equal(isSubagent({ origin: 'subagent' }), true)
  assert.equal(isSubagent({ delegationDepth: 0, origin: 'user' }), false)
  assert.equal(isSubagent(null), false)
})

test('过滤：任务提示转 meta，助手对话丢弃，工具/产物保留', () => {
  const recs = [
    { type: 'user/message', who: 'he', text: '你是一个审查员', eventKey: 'u1' },
    { type: 'assistant/message', who: 'me', text: '好的', eventKey: 'a1' },
    { type: 'tool/call', who: 'act', text: '我调了 Bash', eventKey: 't1' },
    { type: 'tool/result', who: 'act', text: 'out', eventKey: 't2' },
    { type: 'artifact', who: 'act', text: '写入 a', eventKey: 't3' },
    { type: 'session/title', who: 'meta', text: '标题', eventKey: 's1' },
  ]
  const seen = new Set()
  const out = filterSubagentRecords(recs, { sid: 'child-1', header: { parentSession: 'session-p', delegationDepth: 1 }, seenTask: seen })
  assert.deepEqual(out.map((r) => r.type), ['subagent/task', 'tool/call', 'tool/result', 'artifact'])
  assert.equal(out[0].who, 'meta')
  assert.ok(out[0].text.startsWith('子代理任务：'))
  assert.equal(out[0].source.parentSession, 'session-p')
  assert.ok(out[1].source.subagent)
  // 同一场第二条用户消息不再写任务
  const more = filterSubagentRecords([{ type: 'user/message', who: 'he', text: '继续', eventKey: 'u2' }], { sid: 'child-1', header: { delegationDepth: 1 }, seenTask: seen })
  assert.equal(more.length, 0)
})

function pack(lines) {
  return zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8'))
}

function writeChild() {
  const dir = path.join(root, 'sessions', '--D-ws--', 'child-abc')
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: 'child-abc', createdAt: 1000, cwd: CWD, parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 }
  const events = [
    { type: 'user/message', seq: 1, time: 1001, data: { content: [{ type: 'text', text: '你是审查员' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 1002, data: { message: { id: 'm1', content: [{ type: 'text', text: '好的' }] }, turn: 1 } },
    { type: 'tool/call', seq: 3, time: 1003, data: { name: 'Bash', callId: 'c1', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, time: 1004, data: { message: { toolCallId: 'c1', toolName: 'Bash', content: [{ type: 'text', text: 'a.txt' }] } } },
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), pack([header, ...events, { type: 'padding', text: crypto.randomBytes(2048).toString('hex') }]))
}

test('回填子代理：只落证据链，重复执行不增行', async () => {
  writeChild()
  const { backfill } = await import('./lib/backfill.mjs')
  const { Ledger } = await import('./lib/store.mjs')
  const ledger = new Ledger(path.join(root, 'mem')).open()
  const cfg = { workspaces: [CWD], backfillOnMount: false, backfillSubagents: true, includeArchived: true }
  const first = backfill(ledger, CWD, cfg, null)
  assert.equal(first.subagents, 1)
  assert.equal(first.subagentAdded, 3)
  const rows = ledger.rows()
  assert.equal(rows.filter((r) => r.type === 'subagent/task').length, 1)
  assert.equal(rows.filter((r) => r.type === 'tool/call').length, 1)
  assert.equal(rows.filter((r) => r.type === 'tool/result').length, 1)
  assert.equal(rows.filter((r) => r.type === 'user/message' || r.type === 'assistant/message').length, 0)
  const second = backfill(ledger, CWD, cfg, null)
  assert.equal(second.subagentAdded, 0)
  ledger.close()
})
