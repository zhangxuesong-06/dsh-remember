import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { plan, migrate } from './migrate.mjs'

const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const tmp = fs.mkdtempSync(path.join(base, 'migrate-test-'))
const repo = path.join(tmp, 'repo')
const legacyOc = path.join(tmp, 'legacy-oc')
const legacyDshHome = path.join(tmp, 'legacy-dsh-home')
const legacyDsh = path.join(legacyDshHome, 'dsh-memory')
const legacyWb = path.join(tmp, 'legacy-wb')

process.env.AGENT_MEMORY_HOME = repo
process.env.OPENCODE_MEM_HOME = legacyOc
process.env.DSH_HOME = legacyDshHome
process.env.WORKBUDDY_MEM_HOME = legacyWb

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function fixtures() {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  put(path.join(legacyOc, 'stream.jsonl'), jsonl([
    { who: 'user', kind: 'message', text: '旧库消息一', ts: 1 },
    { who: 'assistant', kind: 'message', text: '旧库消息二', ts: 2 },
  ]))
  put(path.join(legacyOc, 'tools.jsonl'), '{"phase":"call"}\n')
  put(path.join(legacyOc, 'integrity.json'), '{"stream.jsonl":"abc"}')
  put(path.join(legacyOc, 'assoc.json'), '{"derived":true}')
  put(path.join(legacyOc, 'runtime', 'bundle.js'), 'cache')
  put(path.join(legacyOc, 'snapshots', 's1.jsonl'), 'backup')
  put(path.join(legacyOc, 'blobs', 'aaa'), 'blob-a')

  put(path.join(legacyDsh, 'ws-a', 'stream.jsonl'), jsonl([
    { who: 'he', type: 'user/message', text: 'DSH 旧消息', ts: 3 },
  ]))
  put(path.join(legacyDsh, 'ws-a', 'blobs', 'bbb'), 'blob-b')
  put(path.join(legacyDsh, 'ws-a', 'snapshots', 's1.jsonl'), 'backup-dsh')

  put(path.join(legacyWb, 'stream.jsonl'), jsonl([
    { who: 'me', type: 'assistant/message', text: 'WB 旧消息', ts: 4 },
  ]))
  put(path.join(legacyWb, 'integrity.json'), '{"stream.jsonl":"def"}')
  put(path.join(legacyWb, 'index.db'), 'derived-db')
  put(path.join(legacyWb, 'snapshots', 's1.jsonl'), 'backup-wb')
}

beforeEach(fixtures)
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('dry-run 只出计划，不创建共享仓库', () => {
  const p = plan()
  assert.equal(p.shared, repo)
  assert.equal(p.exists, false)
  assert.deepEqual(p.items.map((i) => i.source), ['opencode', 'dsh', 'workbuddy'])
  assert.ok(p.items.every((i) => i.exists))
  assert.ok(p.items.every((i) => i.files > 0))
  assert.ok(p.skipped.includes('runtime'))
  const r = migrate({ apply: false })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(fs.existsSync(repo), false)
})

test('apply 复制三条流，跳过可重建目录，旧库不动', () => {
  const ocBefore = fs.readFileSync(path.join(legacyOc, 'stream.jsonl'))
  const dshBefore = fs.readFileSync(path.join(legacyDsh, 'ws-a', 'stream.jsonl'))
  const wbBefore = fs.readFileSync(path.join(legacyWb, 'stream.jsonl'))
  const r = migrate({ apply: true })
  assert.equal(r.ok, true, r.reason)
  assert.equal(fs.existsSync(path.join(repo, 'manifest.json')), true)
  assert.deepEqual(fs.readFileSync(path.join(repo, 'opencode', 'stream.jsonl')), ocBefore)
  assert.deepEqual(fs.readFileSync(path.join(repo, 'dsh', 'ws-a', 'stream.jsonl')), dshBefore)
  assert.deepEqual(fs.readFileSync(path.join(repo, 'workbuddy', 'stream.jsonl')), wbBefore)
  assert.equal(fs.existsSync(path.join(repo, 'opencode', 'blobs', 'aaa')), true)
  assert.equal(fs.existsSync(path.join(repo, 'opencode', 'runtime')), false)
  assert.equal(fs.existsSync(path.join(repo, 'opencode', 'snapshots')), false)
  assert.equal(fs.existsSync(path.join(repo, 'opencode', 'assoc.json')), false)
  assert.equal(fs.existsSync(path.join(repo, 'workbuddy', 'index.db')), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.streams.opencode.records, 2)
  assert.equal(manifest.streams.dsh.records, 1)
  assert.equal(manifest.streams.workbuddy.records, 1)
  assert.deepEqual(fs.readFileSync(path.join(legacyOc, 'stream.jsonl')), ocBefore)
  assert.deepEqual(fs.readFileSync(path.join(legacyDsh, 'ws-a', 'stream.jsonl')), dshBefore)
  assert.deepEqual(fs.readFileSync(path.join(legacyWb, 'stream.jsonl')), wbBefore)
})

test('共享仓库已存在时拒绝覆盖', () => {
  assert.equal(migrate({ apply: true }).ok, true)
  const again = migrate({ apply: true })
  assert.equal(again.ok, false)
  assert.match(again.reason, /已存在/)
})

test('缺失的库跳过，不阻塞其他流', () => {
  fs.rmSync(legacyWb, { recursive: true, force: true })
  const r = migrate({ apply: true })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.streams.workbuddy.records, 0)
  assert.equal(fs.existsSync(path.join(repo, 'workbuddy')), false)
  assert.equal(fs.existsSync(path.join(repo, 'opencode', 'stream.jsonl')), true)
})
