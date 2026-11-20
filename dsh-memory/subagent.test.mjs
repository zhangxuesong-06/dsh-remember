// 子代理口径：任务提示标 meta，对话丢弃，只留工具/产物证据。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { isSubagent, filterSubagentRecords } from './lib/subagent.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-'))
process.env.DSH_HOME = root
process.env.DSH_MEMORY_HOME = path.join(root, 'dsh-memory')
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

test('两场主会话相同序号和同毫秒复用的输出都能回填，重复执行不增行', async () => {
  const cwd = 'D:\\parent-workspace'
  const { backfill } = await import('./lib/backfill.mjs')
  const { Ledger } = await import('./lib/store.mjs')
  for (const sid of ['parent-one', 'parent-two']) {
    const dir = path.join(root, 'sessions', 'parents', sid)
    fs.mkdirSync(dir, { recursive: true })
    const header = { type: 'session', id: sid, cwd, createdAt: 1000 }
    const events = ['result-one', 'result-two'].map((callId, index) => ({
      type: 'tool/result', seq: index + 1, time: 1001,
      data: { message: { toolCallId: callId, content: [{ type: 'text', text: 'same output' }] } },
    }))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'),
      pack([header, ...events, { type: 'padding', text: crypto.randomBytes(2048).toString('hex') }]))
  }
  const ledger = new Ledger(path.join(root, 'mem-parents')).open()
  const cfg = { includeArchived: true }
  assert.equal(backfill(ledger, cwd, cfg).added, 4)
  assert.equal(backfill(ledger, cwd, cfg).added, 0)
  assert.equal(ledger.rows().length, 4)
  ledger.close()
})

test('离线回填使用配置的群聊名并只导入指定身份线', async () => {
  const cwd = 'D:\\multi-workspace'
  const configRoot = path.join(root, 'dsh-memory')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.writeFileSync(path.join(configRoot, 'config.json'), JSON.stringify({
    lines: [
      { cwd, name: 'line-one', root: 'line-owned' },
      { cwd, name: 'line-two', root: 'line-other' },
    ],
    humanName: 'configured-human',
  }))
  for (const sid of ['line-owned', 'line-other', 'line-unregistered']) {
    const directory = path.join(root, 'sessions', 'multi', sid)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), pack([
      { type: 'session', id: sid, cwd, createdAt: 1000 },
      { type: 'user/message', seq: 1, time: 1001, data: {
        source: { kind: 'relay', items: [{ id: sid, from: 'configured-human', text: sid }] },
      } },
    ]))
  }
  const result = spawnSync(process.execPath, ['dsh-memory/cli.mjs', 'backfill', cwd], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HIPPO_LINE: 'line-one' }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const { workspaceDir } = await import('./lib/config.mjs')
  const { Ledger } = await import('./lib/store.mjs')
  const ledger = new Ledger(workspaceDir(cwd, 'line-one')).open()
  assert.deepEqual(ledger.rows().map((row) => row.sid), ['line-owned'])
  ledger.close()
})

test('事后回填保留当前文件快照，开始版本保留未知', async () => {
  const { backfill } = await import('./lib/backfill.mjs')
  const { readBlob } = await import('./lib/evidence.mjs')
  const { Ledger } = await import('./lib/store.mjs')
  const sid = 'child-artifact'
  const target = path.join(root, 'current.txt')
  fs.writeFileSync(target, 'current bytes')
  const directory = path.join(root, 'sessions', 'working', sid)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), pack([
    { type: 'session', id: sid, cwd: root, origin: 'subagent', parentSession: 'parent-artifact' },
    { type: 'tool/call', seq: 1, time: 1001, data: { name: 'write', callId: 'write-one', arguments: { path: target } } },
    { type: 'tool/result', seq: 2, time: 1002, data: { message: { toolCallId: 'write-one', content: [{ type: 'text', text: 'done' }] } } },
  ]))
  const ledger = new Ledger(path.join(root, 'mem-artifact')).open()
  assert.equal(backfill(ledger, root, { includeArchived: true }).subagentAdded, 3)
  const artifact = ledger.rows().find((row) => row.type === 'artifact')
  assert.equal(artifact.versions.before.state, 'unknown')
  assert.equal(readBlob(ledger.dir, artifact.versions.after.sha256).toString(), 'current bytes')
  ledger.close()
})

test('早期无会话前缀的事件键继续参与旧记录去重', async () => {
  const cwd = 'D:\\legacy-workspace'
  const sid = 'legacy-parent'
  const { backfill } = await import('./lib/backfill.mjs')
  const { Ledger } = await import('./lib/store.mjs')
  const directory = path.join(root, 'sessions', 'legacy', sid)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'session.jsonl.zstd'), pack([
    { type: 'session', id: sid, cwd, createdAt: 1000 },
    { type: 'assistant/message', seq: 1, time: 1001, data: { message: { content: [{ type: 'text', text: 'legacy reply' }] } } },
  ]))
  const ledger = new Ledger(path.join(root, 'mem-legacy')).open()
  ledger.append({ sid, who: 'me', type: 'assistant/message', ts: 1001, text: 'legacy reply', eventKey: ':1' })
  assert.equal(backfill(ledger, cwd, { includeArchived: true }).added, 0)
  assert.equal(ledger.rows().length, 1)
  ledger.close()
})
