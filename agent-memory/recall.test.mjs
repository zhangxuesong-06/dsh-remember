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
fs.mkdirSync(base, { recursive: true })
const tmp = fs.mkdtempSync(path.join(base, 'cross-test-'))
const ocRoot = path.join(tmp, 'oc')
const dshHome = path.join(tmp, 'dsh')
const wbRoot = path.join(tmp, 'wb')
const dshStore = path.join(dshHome, 'dsh-memory', 'ws-alpha')
const zcRoot = path.join(tmp, 'zc')

process.env.OPENCODE_MEM_HOME = ocRoot
process.env.DSH_HOME = dshHome
process.env.WORKBUDDY_MEM_HOME = wbRoot
process.env.ZCODE_MEM_HOME = zcRoot
process.env.CODEX_MEMORY_HOME = path.join(tmp, 'codex')

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
  writeJsonl(path.join(zcRoot, 'stream.jsonl'), [
    { who: 'he', type: 'user/message', ws: 'c:\\users\\huawei\\desktop\\work\\记忆', wsName: '记忆', sid: 's-zc', turn: 1, ts: NOW - 1 * DAY, text: '给 ZCode 装一个共享记忆插件。' },
    { who: 'me', type: 'assistant/message', ws: 'c:\\users\\huawei\\desktop\\work\\记忆', wsName: '记忆', sid: 's-zc', turn: 1, ts: NOW - 1 * DAY + 1000, text: 'ZCode 用钩子加 MCP，数据写 ~/.agent-memory/zcode。' },
    { who: 'meta', type: 'session/title', ws: 'c:\\users\\huawei\\desktop\\work\\记忆', wsName: '记忆', sid: 's-zc', ts: NOW - 1 * DAY + 2000, text: '这个对话叫「ZCode 共享记忆」' },
  ])
}

beforeEach(fixtures)
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('四个来源都能读，he/me/act/meta 归一化正确，工具行默认不收', () => {
  const { records, stores } = cross.loadAll()
  assert.deepEqual(stores.map((s) => s.source), ['opencode', 'dsh', 'workbuddy', 'zcode', 'codex'])
  assert.equal(stores.find((s) => s.source === 'dsh').workspaces, 1)
  const dsh = records.filter((r) => r.source === 'dsh')
  assert.equal(dsh.find((r) => r.who === 'user').line, 1)
  assert.equal(dsh.find((r) => r.who === 'assistant').line, 2)
  assert.equal(dsh.find((r) => r.who === 'meta').kind, 'note')
  const zc = records.filter((r) => r.source === 'zcode')
  assert.equal(zc.find((r) => r.who === 'user').workspace, 'c:\\users\\huawei\\desktop\\work\\记忆')
  assert.equal(zc.find((r) => r.who === 'meta').kind, 'note')
  assert.equal(records.filter((r) => r.kind === 'tool').length, 0)
  assert.equal(records.length, 14)
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

test('复用检索索引可替换排序参数，并在去重前排除已知输入', () => {
  const query = 'quiz-bank.json 不存在词'
  const search = cross.createRecallSearch(cross.loadAll(), { source: 'workbuddy' })
  assert.deepEqual(search(query, { now: NOW }), cross.recall(query, { source: 'workbuddy', now: NOW }))
  const hits = search(query, { n: 1, now: NOW, exclude: (record) => record.line !== 2 })
  assert.equal(hits[0].who, 'assistant')
  assert.equal(cross.refOf(hits[0]), 'workbuddy:2')
  assert.deepEqual(search(query, { rank: { minCoverage: 1 } }), [])
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

test('坏行与空行之后仍用物理行号引用原文', () => {
  const stream = path.join(ocRoot, 'stream.jsonl')
  const text = '合成证据原话'
  fs.writeFileSync(stream, `\n坏行\n${JSON.stringify({ who: 'user', text })}\n`)
  const [hit] = cross.trace(text)
  assert.equal(cross.refOf(hit), 'opencode:3')
  assert.equal(cross.readAt('opencode', 3).text, text)
})

test('缺失的库也会出现在 sources 里', () => {
  fs.rmSync(dshHome, { recursive: true, force: true })
  const list = cross.sources()
  assert.equal(list.length, 5)
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
  writeJsonl(path.join(repo, 'zcode', 'stream.jsonl'), [
    { who: 'me', type: 'assistant/message', ws: 'c:\\work\\记忆', sid: 's-zc', ts: NOW - 500, text: '共享仓库标记 在 ZCode 里。' },
  ])
  writeJsonl(path.join(repo, 'codex', 'stream.jsonl'), [
    { who: 'assistant', type: 'assistant/message', sid: 's-codex', ts: NOW - 3000, text: '共享仓库标记 在 Codex 里。' },
  ])
  const prev = process.env.AGENT_MEMORY_HOME
  const previousCodex = process.env.CODEX_MEMORY_HOME
  process.env.AGENT_MEMORY_HOME = repo
  delete process.env.CODEX_MEMORY_HOME
  try {
    const list = cross.sources()
    assert.equal(list.length, 5)
    assert.ok(list.every((s) => s.exists))
    assert.ok(list.find((s) => s.source === 'opencode').path.startsWith(repo))
    const hits = cross.recall('共享仓库标记')
    assert.equal(hits.length, 5)
    assert.equal(hits[0].source, 'dsh')
  } finally {
    process.env.CODEX_MEMORY_HOME = previousCodex
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

test('CLI 可选长文排序，引用仍回到同一条原话', () => {
  const cli = path.join(here, 'recall.mjs')
  const run = (...args) => spawnSync(process.execPath, [cli, 'recall', ...args], { encoding: 'utf8' })
  const result = run('缓存方案', '--source', 'opencode', '--rank', 'long-text', '--json')
  assert.equal(result.status, 0, result.stderr)
  const { hits } = JSON.parse(result.stdout)
  assert.ok(hits.length > 1)
  for (const hit of hits) assert.equal(cross.readAt(hit.source, hit.line).text, hit.text)
  const defaultResult = run('缓存方案', '--source', 'opencode', '--rank', 'default', '--json')
  assert.equal(defaultResult.status, 0, defaultResult.stderr)
  const defaultScores = new Map(JSON.parse(defaultResult.stdout).hits.map((hit) => [hit.line, hit.score]))
  assert.ok(hits.some((hit) => Math.abs(hit.score - defaultScores.get(hit.line)) > 0.001))
  assert.equal(run('缓存方案', '--rank', 'unknown').status, 2)
  assert.equal(run('缓存方案', '--rank').status, 2)
})

test('分段排名提升长回复，保留记录引用并按父记录去重', () => {
  const query = '冷机校准脉冲确认'
  const prefix = '平时监控窗口无异常。'.repeat(90)
  const original = `${prefix}${query}。\n  原话有缩进。🌌${prefix}${query}。`
  writeJsonl(path.join(ocRoot, 'stream.jsonl'), [
    { who: 'assistant', sid: 'match', ts: NOW, text: original },
    { who: 'assistant', sid: 'partial', ts: NOW, text: '冷机校准常规备注。' },
    { who: 'assistant', sid: 'different-ending', ts: NOW, text: `${prefix}另一个记录：${query}。` },
    { who: 'assistant', sid: 'duplicate', ts: NOW, text: original },
  ])
  assert.equal(cross.recall(query, { n: 1, now: NOW })[0].sid, 'partial')
  const options = { passages: true, now: NOW, source: 'opencode' }
  const hits = cross.recall(query, options)
  assert.equal(hits[0].sid, 'match')
  assert.deepEqual(hits.map(cross.refOf).toSorted(), ['opencode:1', 'opencode:2', 'opencode:3'])
  assert.equal(hits[0].text, original)
  assert.ok(original.slice(hits[0].passage.start, hits[0].passage.end).includes(query))
  const quote = cross.quoteFor(hits[0], '脉冲确认 冷机校准')
  assert.ok(quote.text.includes(query))
  assert.equal(quote.text, original.slice(quote.start, quote.end))
  assert.deepEqual(cross.recall(query, { ...options, exclude: (hit) => hit.text === original }).map(cross.refOf).toSorted(), ['opencode:2', 'opencode:3'])
})

test('模型用摘录限制条数和序列化字节，引用可按偏移逐字回读', () => {
  const query = '冷机校准脉冲确认'
  const original = `${'演练背景。'.repeat(250)}\n    🌌${query}\n    确认下一步。${'界'.repeat(230)}`
  writeJsonl(path.join(dshStore, 'stream.jsonl'), Array.from({ length: 16 }, (_, i) => ({
    who: 'me', type: 'assistant/message', sid: `run-${i}`, ts: NOW + i, text: `${original}${i}`,
  })))
  const run = (...args) => spawnSync(process.execPath, [path.join(here, 'recall.mjs'), ...args], { encoding: 'utf8' })
  for (const args of [['recall', query], ['recall', query, '--rank', 'passage'], ['trace', query]]) {
    const result = run(...args, '--compact', '-n', '1000')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(Buffer.byteLength(result.stdout) <= 3072)
    const hits = JSON.parse(result.stdout)
    assert.ok(hits.length >= 1 && hits.length <= 5)
    for (const hit of hits) {
      assert.match(hit.ref, /^dsh:ws-alpha:\d+$/)
      assert.equal(hit.who, 'assistant')
      assert.ok(hit.text.length <= 192 && hit.text.isWellFormed())
      assert.ok(hit.text.includes(`🌌${query}\n    确认`))
      assert.equal(hit.text, original.slice(hit.start, hit.end))
    }
    const { ref, start, end, text } = hits[0]
    const reread = run('show', ref, '--range', `${start}:${end}`, '--json')
    assert.equal(reread.status, 0, reread.stderr)
    assert.equal(JSON.parse(reread.stdout).text, text)
  }
  const broken = original.indexOf('🌌') + 1
  for (const range of ['-1:12', '1:1', '12:1', '1:99999', `${broken}:${broken + 2}`]) {
    assert.equal(run('show', 'dsh:ws-alpha:1', '--range', range, '--json').status, 2)
  }
})
