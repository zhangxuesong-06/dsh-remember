import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const tmp = fs.mkdtempSync(path.join(base, 'cross-test-'))
const ocRoot = path.join(tmp, 'oc')
const dshHome = path.join(tmp, 'dsh')
const wbRoot = path.join(tmp, 'wb')
const dshStore = path.join(dshHome, 'dsh-memory', 'ws-alpha')

process.env.OPENCODE_MEM_HOME = ocRoot
process.env.DSH_HOME = dshHome
process.env.WORKBUDDY_MEM_HOME = wbRoot

const cross = await import('./recall.mjs')

const DAY = 864e5
const NOW = Date.now()

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function fixtures() {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  writeJsonl(path.join(ocRoot, 'stream.jsonl'), [
    { who: 'user', kind: 'message', ws: 'C:\\work\\记忆', sid: 's-oc', messageID: 'u1', id: 'oc1', seq: 1, ts: NOW - 2 * DAY, text: '缓存方案用本地文件还是 Redis，先定一下。' },
    { who: 'assistant', kind: 'message', ws: 'C:\\work\\记忆', sid: 's-oc', messageID: 'a1', id: 'oc2', seq: 2, ts: NOW - 2 * DAY + 1000, text: '缓存方案用本地文件，不用 Redis。这是当时的结论。' },
    { who: 'system', kind: 'episode', ws: 'C:\\work\\记忆', sid: 's-oc', id: 'oc3', seq: 3, ts: NOW - 2 * DAY + 2000, text: '任务摘录：缓存方案用本地文件。' },
    { who: 'system', kind: 'artifact', ws: 'C:\\work\\记忆', sid: 's-oc', id: 'oc4', seq: 4, ts: NOW - 2 * DAY + 3000, text: '写入 C:\\work\\cache.mjs；工具 edit 已完成' },
  ])
  writeJsonl(path.join(dshStore, 'stream.jsonl'), [
    { who: 'he', type: 'user/message', sid: 's-dsh', messageID: 'd1', ts: NOW - 5 * DAY, text: 'kgnav 孤岛怎么归因？' },
    { who: 'me', type: 'assistant/message', sid: 's-dsh', messageID: 'd2', ts: NOW - 5 * DAY + 1000, text: 'kgnav 孤岛归因：271 个里有 270 个来自旧记录。' },
    { who: 'meta', type: 'session/title', sid: 's-dsh', ts: NOW - 5 * DAY + 2000, text: 'kgnav 孤岛排查' },
    { who: 'me', type: 'artifact', sid: 's-dsh', ts: NOW - 5 * DAY + 3000, text: '写入 D:\\kgnav\\report.md；工具 edit 已完成' },
    { who: 'act', type: 'tool/call', sid: 's-dsh', tool: 'Bash', ts: NOW - 5 * DAY + 4000, text: 'rg "孤岛" kgnav' },
  ])
  writeJsonl(path.join(wbRoot, 'stream.jsonl'), [
    { who: 'he', type: 'user/message', ws: '2026-11-12-21-33', sid: 's-wb', messageID: 'w1', id: 'wb1', ts: NOW - 3 * DAY, text: '题库优先读当前工作区的 quiz-bank.json。' },
    { who: 'me', type: 'assistant/message', ws: '2026-11-12-21-33', sid: 's-wb', messageID: 'w2', id: 'wb2', ts: NOW - 3 * DAY + 1000, text: '题库优先读 quiz-bank.json，读不到再回退。' },
    { who: 'me', type: 'artifact', ws: '2026-11-12-21-33', sid: 's-wb', ts: NOW - 3 * DAY + 2000, text: '写入 quiz-bank.json；工具 write 已完成' },
    { who: 'act', type: 'tool/call', ws: '2026-11-12-21-33', sid: 's-wb', tool: 'Bash', ts: NOW - 3 * DAY + 3000, text: 'cat quiz-bank.json' },
  ])
}

beforeEach(fixtures)
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('三个库都能读，he/me/act/meta 归一化正确，工具行默认不收', () => {
  const { records, stores } = cross.loadAll()
  assert.deepEqual(stores.map((s) => s.source), ['opencode', 'dsh', 'workbuddy'])
  assert.equal(stores.find((s) => s.source === 'dsh').workspaces, 1)
  const dsh = records.filter((r) => r.source === 'dsh')
  assert.equal(dsh.find((r) => r.who === 'user').line, 1)
  assert.equal(dsh.find((r) => r.who === 'assistant').line, 2)
  assert.equal(dsh.find((r) => r.who === 'meta').kind, 'note')
  assert.equal(records.filter((r) => r.kind === 'tool').length, 0)
  assert.equal(records.length, 11)
  assert.ok(records.every((r) => r.text && r.line >= 1))
})

test('--with-tools 才收工具行', () => {
  assert.equal(cross.loadAll({ withTools: true }).records.filter((r) => r.kind === 'tool').length, 2)
})

test('跨库召回保留来源标签，稀有词压过常见词', () => {
  const hits = cross.recall('kgnav 孤岛')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].source, 'dsh')
  assert.ok(hits.slice(0, 2).some((h) => h.line === 2), '问题或回答都该在 top-2')
  const wb = cross.recall('quiz-bank.json')
  assert.equal(wb[0].source, 'workbuddy')
  const oc = cross.recall('缓存方案 本地文件')
  assert.equal(oc[0].source, 'opencode')
})

test('--source / --since / --ws 过滤生效', () => {
  assert.equal(cross.recall('quiz-bank.json', { source: 'workbuddy' })[0].source, 'workbuddy')
  assert.equal(cross.recall('quiz-bank.json', { source: 'dsh' }).length, 0)
  assert.equal(cross.recall('quiz-bank.json', { since: NOW - 2 * DAY }).length, 0)
  assert.ok(cross.recall('quiz-bank.json', { ws: '2026-11-12' }).length > 0)
  assert.equal(cross.recall('quiz-bank.json', { ws: '不存在的目录' }).length, 0)
})

test('工具行默认搜不到，--with-tools 能搜到', () => {
  assert.equal(cross.recall('cat').length, 0)
  assert.ok(cross.recall('cat', { withTools: true }).length > 0)
})

test('按行号回读原文', () => {
  const rec = cross.readAt('dsh', 2)
  assert.ok(rec.text.includes('271 个里有 270 个'))
  assert.equal(rec.source, 'dsh')
  assert.equal(rec.workspace, 'ws-alpha')
  assert.equal(cross.readAt('dsh', 999), null)
  assert.equal(cross.readAt('nope', 1), null)
})

test('trace 按字跨库命中', () => {
  const hits = cross.trace('271 个里有 270 个')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].source, 'dsh')
  assert.equal(cross.trace('根本不存在的原话').length, 0)
})

test('同一段正文的旧重复只占一个位置', () => {
  fs.appendFileSync(path.join(ocRoot, 'stream.jsonl'), JSON.stringify({
    who: 'assistant', kind: 'message', ws: 'C:\\work\\记忆', sid: 's-oc', messageID: 'a-dup', id: 'oc-dup', seq: 99,
    ts: NOW - 2 * DAY + 1500, text: '缓存方案用本地文件，不用 Redis。这是当时的结论。',
  }) + '\n', 'utf8')
  const hits = cross.recall('缓存方案 本地文件', { n: 8 })
  assert.equal(hits.filter((h) => h.text === '缓存方案用本地文件，不用 Redis。这是当时的结论。').length, 1)
})

test('只读：运行前后文件哈希和目录列表不变', () => {
  const files = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk(tmp)
  const before = new Map(files.map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))
  cross.loadAll()
  cross.loadAll({ withTools: true })
  cross.recall('kgnav 孤岛')
  cross.trace('271 个里有 270 个')
  cross.readAt('opencode', 1)
  cross.sources()
  const after = []
  const walkAfter = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walkAfter(p)
      else after.push(p)
    }
  }
  walkAfter(tmp)
  for (const [f, hash] of before) {
    assert.equal(fs.existsSync(f), true, `文件被删除：${f}`)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), hash, `文件被改写：${f}`)
  }
  assert.deepEqual(after.sort(), [...before.keys()].sort())
})

test('库缺失和坏行不阻塞其他库', () => {
  fs.rmSync(path.join(wbRoot, 'stream.jsonl'))
  fs.appendFileSync(path.join(dshStore, 'stream.jsonl'), 'not json\n', 'utf8')
  const { records, stores } = cross.loadAll()
  assert.equal(stores.find((s) => s.source === 'workbuddy').exists, false)
  assert.equal(stores.find((s) => s.source === 'dsh').skipped, 1)
  assert.ok(records.some((r) => r.source === 'opencode'))
  assert.ok(cross.recall('缓存方案').length > 0)
})

test('缺失的库也会出现在 sources 里', () => {
  fs.rmSync(dshHome, { recursive: true, force: true })
  const list = cross.sources()
  assert.equal(list.length, 3)
  assert.equal(list.find((s) => s.source === 'dsh').exists, false)
})

test('共享仓库布局：一个根目录多条流', () => {
  const repo = path.join(tmp, 'agent-memory')
  writeJsonl(path.join(repo, 'opencode', 'stream.jsonl'), [
    { who: 'assistant', kind: 'message', sid: 's-oc', id: 'so1', ts: NOW - 1000, text: '共享仓库标记 在 OpenCode 里。' },
  ])
  writeJsonl(path.join(repo, 'dsh', 'ws-beta', 'stream.jsonl'), [
    { who: 'me', type: 'assistant/message', sid: 's-dsh', ts: NOW, text: '共享仓库标记 在 DSH 里。' },
  ])
  writeJsonl(path.join(repo, 'workbuddy', 'stream.jsonl'), [
    { who: 'me', type: 'assistant/message', sid: 's-wb', ts: NOW - 2000, text: '共享仓库标记 在 WorkBuddy 里。' },
  ])
  const prev = process.env.AGENT_MEMORY_HOME
  process.env.AGENT_MEMORY_HOME = repo
  try {
    const list = cross.sources()
    assert.equal(list.length, 3)
    assert.ok(list.every((s) => s.exists))
    assert.ok(list.find((s) => s.source === 'opencode').path.startsWith(repo))
    const hits = cross.recall('共享仓库标记')
    assert.equal(hits.length, 3)
    assert.equal(hits[0].source, 'dsh')
  } finally {
    if (prev === undefined) delete process.env.AGENT_MEMORY_HOME
    else process.env.AGENT_MEMORY_HOME = prev
  }
})

test('CLI --json 可解析，人类输出带来源', () => {
  const cli = path.join(here, 'recall.mjs')
  const env = { ...process.env }
  const json = spawnSync(process.execPath, [cli, 'recall', 'kgnav', '--json'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(json.status, 0, json.stderr)
  const out = JSON.parse(json.stdout)
  assert.equal(out.hits[0].source, 'dsh')
  const human = spawnSync(process.execPath, [cli, 'recall', 'kgnav'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, /dsh/)
  const show = spawnSync(process.execPath, [cli, 'show', 'dsh:2'], { env, encoding: 'utf8', windowsHide: true })
  assert.equal(show.status, 0, show.stderr)
  assert.match(show.stdout, /271 个里有 270 个/)
})
