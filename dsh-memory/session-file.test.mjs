import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-file-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))

const CWD = 'D:\\deepseek harness'

function pack(lines) {
  return zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8'))
}

function writeSession(id, { name = 'session.jsonl.zstd', cwd = CWD, depth = 0, createdAt = Date.now(), extra = [] } = {}) {
  const dir = path.join(root, '--D-deepseek~0020harness--', 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 0, id: 'session-' + id, createdAt, cwd, delegationDepth: depth }
  // 真实会话文件都大于 512 字节（listSessions 会跳过空会话）；这里补一段填充，
  // 让测试数据也超过阈值。
  fs.writeFileSync(path.join(dir, name), pack([header, ...extra, { type: 'padding', text: crypto.randomBytes(2048).toString('hex') }]))
  return dir
}

const { listSessions, listSubagentSessions, readSessionFile } = await import('./lib/session-file.mjs')

test('只有旧格式 session.jsonl.zstd 也能被发现', () => {
  const dir = writeSession('legacy-only', {
    extra: [{ type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '旧会话里的话' }] } }],
  })
  const list = listSessions(root, CWD)
  const hit = list.find((s) => s.id === 'session-legacy-only')
  assert.ok(hit, '旧格式会话应该被发现')
  assert.equal(hit.path, path.join(dir, 'session.jsonl.zstd'))
  assert.equal(hit.events[1].data.content[0].text, '旧会话里的话')
})

test('v4 和旧格式同时存在时优先 v4', () => {
  writeSession('both', { name: 'session.jsonl.zstd', createdAt: 100 })
  const dir = writeSession('both', { name: 'session.v4.jsonl.zstd', createdAt: 200 })
  const hit = listSessions(root, CWD).find((s) => s.id === 'session-both')
  assert.equal(hit.path, path.join(dir, 'session.v4.jsonl.zstd'))
})

test('cwd 不一致和子会话被跳过', () => {
  writeSession('other-cwd', { cwd: 'D:\\别的项目' })
  writeSession('child', { depth: 1 })
  const ids = listSessions(root, CWD).map((s) => s.id)
  assert.ok(!ids.includes('session-other-cwd'))
  assert.ok(!ids.includes('session-child'))
  const subs = listSubagentSessions(root, CWD).map((s) => s.id)
  assert.ok(subs.includes('session-child'))
  assert.ok(!subs.includes('session-other-cwd'))
})

test('小文件与坏文件不阻塞', () => {
  const dir = path.join(root, '--D-deepseek~0020harness--', 'session-tiny')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'not zstd')
  assert.doesNotThrow(() => listSessions(root, CWD))
  assert.equal(readSessionFile(path.join(dir, 'session.jsonl.zstd')), null)
})
