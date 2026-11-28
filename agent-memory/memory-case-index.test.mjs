import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { caseSource, caseWatermark, readCaseRef, readEvidence, searchCases, syncCaseIndex } from '../dsh-memory/lib/memory-case-index.mjs'
import { openCodeTailPolicy } from '../dsh-memory/lib/memory-case-hint.mjs'
import { caseRef, digest } from '../dsh-memory/lib/memory-cards.mjs'
import { eventToRecords } from '../dsh-memory/lib/capture.mjs'
import { Ledger } from '../dsh-memory/lib/store.mjs'
import { createJournal } from '../tools/mem-journal.mjs'

function fullRanking(db, source) {
  const project = 'p' + digest(source.project).slice(0, 32)
  const match = cue => `project:${project} AND terms:(${cue.split(' ').map(word => 'x' + Buffer.from(word).toString('hex')).join(' OR ')})`
  const query = db.prepare(`SELECT card FROM card_fts JOIN cards ON cards.fts_id = card_fts.rowid
    WHERE card_fts MATCH ? ORDER BY bm25(card_fts), cards.rowid LIMIT ?`)
  return { match, rank: (cue, limit) => query.all(match(cue), limit).map(row => JSON.parse(row.card)) }
}

test('改写远离游标的旧前缀并追加后，索引拒绝推进', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-prefix-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'stream.jsonl')
  const row = (id, text) => JSON.stringify({ id, kind: 'decision', text, ws: root }) + '\n'
  const original = row('first', 'old rule') + row('second', 'x'.repeat(2048))
  fs.writeFileSync(file, original)
  const source = caseSource('opencode', root, root)
  assert.equal(syncCaseIndex(source).state, 'ready')
  fs.writeFileSync(file, original.replace('old rule', 'new rule') + row('third', 'append'))
  assert.equal(syncCaseIndex(source).state, 'stale')
  assert.equal(searchCases(source, { cue: 'old rule' }).state, 'stale')
  assert.equal(searchCases(source, { keys: [], watermark: caseWatermark(source) }).state, 'stale')
})

test('手动案例回查拒绝改过的旧前缀和能补齐既有结果的调用', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'case-pending-recall-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'tools.jsonl')
  const journal = createJournal(root)
  const source = caseSource('opencode', root, root, { tailPolicy: openCodeTailPolicy })
  const result = { id: 'result', phase: 'completed', tool: 'mem_recall', sid: 'old', callID: 'unpaired', ws: root }
  const recall = callID => journal.append('tools.jsonl', { ...result, id: callID, callID, phase: 'call' })
  const search = () => searchCases(source, { cue: 'recall', pendingRecall: true })
  fs.writeFileSync(file, JSON.stringify(result) + '\n')
  assert.equal(syncCaseIndex(source).state, 'ready')
  fs.writeFileSync(file, JSON.stringify({ ...result, tool: 'mem_xxxxxx' }) + '\n')
  recall('fresh')
  assert.equal(search().state, 'stale')
  assert.equal(syncCaseIndex(source, { rebuild: true }).state, 'ready')
  recall('unpaired')
  assert.equal(search().state, 'stale')
})

test('全量重建跨批次顺序读取，保留旧引用和后续增量校验', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-rebuild-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'stream.jsonl')
  const source = caseSource('codex', root, root)
  const row = (id, text) => JSON.stringify({ id, kind: 'decision', text, ws: root }) + '\n'
  const first = 'original exact\r\n  🙂'
  fs.writeFileSync(file, row('first', first))
  assert.equal(syncCaseIndex(source).state, 'ready')
  const ref = caseRef(searchCases(source, { cue: 'original' }).cards[0].evidence[0])
  const large = row('large', 'x'.repeat(600_000))
  fs.appendFileSync(file, '{invalid}\n' + large.repeat(6) + row('tail', 'tailword'))

  const open = fs.openSync
  const read = fs.readSync
  let inputFD, readBytes = 0, appendDuringRead = false
  const input = fs.realpathSync.native(file)
  const openMock = t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args)
    if (args[0] === input) inputFD = fd
    return fd
  })
  const readMock = t.mock.method(fs, 'readSync', (fd, ...args) => {
    const size = read(fd, ...args)
    if (fd === inputFD) {
      readBytes += size
      if (appendDuringRead) {
        appendDuringRead = false
        fs.appendFileSync(file, row('concurrent', 'concurrentword'))
      }
    }
    return size
  })
  try {
    const size = fs.statSync(file).size
    const result = syncCaseIndex(source, { rebuild: true })
    assert.equal(result.state, 'ready')
    assert.equal(result.pending, false)
    assert.equal(result.progress, size)
    assert.ok(readBytes >= size && readBytes < 2 * size, `read ${readBytes} bytes for a ${size}-byte stream`)
    assert.equal(result.gaps, 1)
    appendDuringRead = true
    assert.equal(syncCaseIndex(source, { rebuild: true }).state, 'unavailable')
    // The failed rebuild rolled back to the previous cursor and cards.
    const db = new DatabaseSync(path.join(root, 'memory-cases-codex-v3.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT offset FROM cursors WHERE stream = ?').get('stream').offset, size)
      assert.equal(db.prepare('SELECT count(*) AS count FROM cards').get().count, 3)
    } finally { db.close() }
  } finally {
    readMock.mock.restore()
    openMock.mock.restore()
  }
  assert.deepEqual(readCaseRef(source, ref), { state: 'exact', text: first })
  fs.appendFileSync(file, row('new', 'newword'))
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.equal(searchCases(source, { cue: 'tailword' }).cards[0].summary, 'tailword')
  assert.equal(searchCases(source, { cue: 'concurrentword' }).cards[0].summary, 'concurrentword')
  assert.equal(searchCases(source, { cue: 'newword' }).cards[0].summary, 'newword')
})

test('轮次超过保留上限后撤销旧案例的自动资格', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-overflow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stream = path.join(root, 'stream.jsonl'), tools = path.join(root, 'tools.jsonl')
  const row = fields => JSON.stringify({ ws: root, sid: 'old', turnID: 'turn', ...fields }) + '\n'
  const observation = (id, ts, passed) => row({ id, ts, phase: 'completed', caseTest: {
    path: 't.test.mjs', name: 'regression', passed, sha: 'a'.repeat(64),
  } })
  fs.writeFileSync(stream, row({ id: 'request', who: 'user', text: 'regression', ts: 1 }))
  fs.writeFileSync(tools, observation('fail', 2, false) + observation('pass', 3, true))
  const source = caseSource('opencode', root, root)
  const search = () => searchCases(source, { watermark: caseWatermark(source), keys: ['["test","t.test.mjs","regression"]'] }).cards
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.equal(search().length, 1)
  fs.appendFileSync(tools, Array.from({ length: 61 }, (_, i) => observation('pass-' + i, i + 4, true)).join(''))
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.equal(search().length, 1)
  fs.appendFileSync(tools, observation('late-fail', 65, false))
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.deepEqual(search(), [])
  assert.equal(searchCases(source, { cue: 'regression' }).cards.find(card => card.kind === 'case').status, 'observed')
})

test('增量跳过半行，限定项目，并逐字回读源记录', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = fs.mkdtempSync(path.join(base, 'project-'))
  const foreign = fs.mkdtempSync(path.join(base, 'foreign-'))
  const file = path.join(base, 'stream.jsonl')
  const body = '导出 export_id\r\n    🙂原文'
  const row = (id, ws) => JSON.stringify({ id, kind: 'decision', text: body, ws }) + '\n'
  fs.writeFileSync(file, row('foreign', foreign) + row('local', project).slice(0, -2))
  const source = caseSource('opencode', base, project)
  const query = { cue: 'export_id' }
  assert.equal(syncCaseIndex(source).pending, true)
  assert.deepEqual(searchCases(source, query).cards, [])
  fs.appendFileSync(file, '}\n')
  assert.equal(syncCaseIndex(source).pending, false)
  const [card] = searchCases(source, query).cards
  assert.equal(card.summary, body)
  assert.equal(readEvidence(source, card.evidence[0]).text, body)
  const ref = caseRef(card.evidence[0])
  assert.equal(readCaseRef(caseSource('opencode', base, foreign), ref).state, 'denied')
  fs.appendFileSync(file, JSON.stringify({ id: 'correction', kind: 'correction', text: '撤回', ws: project, supersedes: card.id }) + '\n')
  assert.equal(syncCaseIndex(source, { rebuild: true }).state, 'ready')
  assert.equal(searchCases(source, query).cards[0].status, 'superseded')
  assert.equal(readCaseRef(source, ref, `${body.indexOf('🙂')}:${body.length}`).text, '🙂原文')
  const index = fs.readdirSync(base).find(name => name.endsWith('.sqlite'))
  fs.unlinkSync(path.join(base, index))
  assert.deepEqual(readCaseRef(source, ref), { state: 'exact', text: body })
  assert.equal(syncCaseIndex(source).state, 'ready')
  const raw = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, raw.replace('🙂原文', '🙂异文').replace('🙂原文', '🙂异文'))
  assert.equal(readEvidence(source, card.evidence[0]).state, 'corrupt')
  assert.equal(searchCases(source, query).state, 'stale')
})

test('增量同步尚未处理完已落盘的纠正时，查询拒绝旧状态', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-pending-correction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'stream.jsonl')
  const source = caseSource('codex', root, root)
  const row = fields => JSON.stringify({ ws: root, ...fields }) + '\n'
  fs.writeFileSync(file, row({ id: 'old', kind: 'decision', text: 'legacy_export' }))
  assert.equal(syncCaseIndex(source).state, 'ready')
  const query = { cue: 'legacy_export' }
  const [original] = searchCases(source, query).cards
  const filler = row({ id: 'padding', text: 'x'.repeat(600_000) })
  fs.appendFileSync(file, filler.repeat(2) + row({ id: 'fix', kind: 'correction', text: '撤回', supersedes: original.id }))
  assert.equal(syncCaseIndex(source).pending, true)
  assert.equal(searchCases(source, query).state, 'stale')
  assert.equal(syncCaseIndex(source).pending, false)
  assert.equal(searchCases(source, query).cards[0].status, 'superseded')
  assert.equal(readCaseRef(source, caseRef(original.evidence[0])).text, 'legacy_export')
})

test('DSH 真实事件转换支持显式轮次，缺轮次的独立用户原话仍能查阅', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-dsh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const ledger = new Ledger(root, {}).open()
  const record = (seq, type, data) => {
    for (const row of eventToRecords({ seq, type, data }, { sid: 'synthetic' })) ledger.append({ ...row, sid: 'synthetic' })
  }
  const content = text => [{ type: 'text', text }]
  record(1, 'user/message', { source: { kind: 'user' }, content: content('无轮次 standalone_export') })
  record(2, 'user/message', { source: { kind: 'user' }, content: content('明确轮次 paired_export'), turn: 2 })
  record(3, 'assistant/message', { message: { content: content('只是助手陈述') }, turn: 2 })
  const source = caseSource('dsh', root, undefined, { singleProject: true })
  assert.equal(syncCaseIndex(source).state, 'ready')
  for (const [cue, count] of [['standalone_export', 1], ['paired_export', 2]]) {
    const [card] = searchCases(source, { cue }).cards
    assert.equal(card.status, 'observed')
    assert.equal(card.evidence.length, count)
    assert.equal(readCaseRef(source, caseRef(card.evidence[0])).text.includes(cue), true)
  }
  const foreignRoot = fs.mkdirSync(path.join(root, 'other-line'))
  const foreign = caseSource('dsh', foreignRoot, undefined, { singleProject: true })
  assert.equal(readCaseRef(foreign, caseRef(searchCases(source, { cue: 'paired_export' }).cards[0].evidence[0])).state, 'denied')
})

test('手动检索先按项目限定候选，BM25 排名和同分顺序可重复', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-rank-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const local = path.join(root, 'local')
  const foreign = path.join(root, 'foreign')
  fs.mkdirSync(local)
  fs.mkdirSync(foreign)
  const row = (id, ws, text) => JSON.stringify({ id, ws, text, kind: 'decision' })
  const lines = [
    ...Array.from({ length: 24 }, (_, i) => row(`foreign-${i}`, foreign, 'shared')),
    row('long', local, 'shared extra words in longer card'),
    row('both', local, 'shared rare_anchor'),
    row('first', local, 'shared'),
    row('second', local, 'shared'),
  ]
  fs.writeFileSync(path.join(root, 'stream.jsonl'), lines.join('\n') + '\n')
  const source = caseSource('opencode', root, local)
  assert.equal(syncCaseIndex(source).state, 'ready')
  const search = cue => searchCases(source, { cue }).cards
  assert.deepEqual(search('shared').map(card => card.evidence[0].id), ['first', 'second', 'both', 'long'])
  assert.equal(search('shared rare_anchor')[0].evidence[0].id, 'both')
  assert.equal(syncCaseIndex(source, { rebuild: true }).state, 'ready')
  assert.deepEqual(search('shared').map(card => card.evidence[0].id), ['first', 'second', 'both', 'long'])
})

test('按词数读取高频词，混合命中仍与完整 BM25 的结果一致', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-hot-rank-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = caseSource('codex', root, root)
  const append = (id, text, ws = root) => fs.appendFileSync(path.join(root, 'stream.jsonl'),
    JSON.stringify({ id, text, kind: 'decision', ws }) + '\n')
  append('updated', 'shared oldword')
  for (let i = 0; i < 120; i++) append(`card-${i}`, `shared dense ${'length '.repeat(i % 3)}${i}`)
  for (let i = 0; i < 10; i++) append(`short-${i}`, 'shared dense')
  append('long', 'shared unique with longer text')
  append('rare-full', 'shared dense unique with longer text')
  append('rare-alone', 'unique')
  for (let i = 0; i < 8; i++) append(`sparse-${i}`, 'dense sparse rare')
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'case-other-rank-'))
  t.after(() => fs.rmSync(other, { recursive: true, force: true }))
  for (let i = 0; i < 12; i++) append(`foreign-${i}`, 'shared dense sparse rare', other)
  fs.writeFileSync(path.join(root, 'memory-cases-codex-v2.sqlite'), 'old index stays available to old code')
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.equal(readCaseRef(source, caseRef(searchCases(source, { cue: 'oldword' }).cards[0].evidence[0])).text, 'shared oldword')
  const oldRef = caseRef(searchCases(source, { cue: 'oldword' }).cards[0].evidence[0])
  append('updated', 'shared replacement newer detail')
  assert.equal(syncCaseIndex(source).state, 'ready')
  assert.deepEqual(searchCases(source, { cue: 'oldword' }).cards, [])
  assert.equal(readCaseRef(source, oldRef).text, 'shared oldword')
  assert.equal(fs.readFileSync(path.join(root, 'memory-cases-codex-v2.sqlite'), 'utf8'), 'old index stays available to old code')
  const db = new DatabaseSync(path.join(root, 'memory-cases-codex-v3.sqlite'), { readOnly: true })
  try {
    const { match, rank } = fullRanking(db, source)
    const query = db.prepare('SELECT rowid, terms FROM card_fts WHERE card_fts MATCH ? ORDER BY rowid LIMIT 8')
    assert.ok(query.all(match('shared')).every(row => row.terms.split(' ').length === 2))
    for (const cue of ['shared', 'shared dense', 'shared unique', 'replacement', 'unmatched', 'shared unknown',
      'shared sparse', 'shared dense sparse rare', 'dense sparse', 'shared dense replacement', 'shared dense unique',
      'unique shared dense', 'shared sparse unique', 'shared unknown sparse', 'dense sparse rare', 'aax bbx ccx',
      'shared dense unindexed one_unknown', 'shared unindexed one_unknown two_unknown', 'shared foreign_only']) {
      for (const limit of [1, 3, 8]) {
        assert.deepEqual(searchCases(source, { cue, limit }).cards, rank(cue, limit), `${cue} (${limit})`)
      }
    }
  } finally { db.close() }
})

test('长证据默认限量，下一范围不切断 emoji', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-page-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = caseSource('codex', root, root)
  const body = 'export_id'.padEnd(11999, ' ') + '🙂'.padEnd(11999, ' ') + '🙂结尾'
  fs.writeFileSync(path.join(root, 'stream.jsonl'), JSON.stringify({ id: 'long', kind: 'decision', text: body, ws: root }) + '\n')
  assert.equal(syncCaseIndex(source).state, 'ready')
  const ref = caseRef(searchCases(source, { cue: 'export_id' }).cards[0].evidence[0])
  const page = readCaseRef(source, ref)
  assert.equal(page.text, body.slice(0, 11999))
  assert.equal(readCaseRef(source, ref, page.next).text, body.slice(11999, 23998))
  assert.equal(page.total, body.length)
})

test('项目内只有一个有效词时，长查询走同一条按长度读取的路径', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'case-missing-terms-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const foreign = path.join(root, 'foreign')
  fs.mkdirSync(foreign)
  const source = caseSource('codex', root, root)
  const rows = [
    { id: 'first', ws: root, text: 'shared' },
    { id: 'long', ws: root, text: 'shared with more words' },
    { id: 'other', ws: foreign, text: 'shared foreign_only' },
  ]
  fs.writeFileSync(path.join(root, 'stream.jsonl'),
    rows.map(row => JSON.stringify({ ...row, kind: 'decision' })).join('\n') + '\n')
  assert.equal(syncCaseIndex(source).state, 'ready')
  const expected = searchCases(source, { cue: 'shared' })
  const prepare = DatabaseSync.prototype.prepare
  const SQL = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    return prepare.call(this, sql)
  })
  assert.deepEqual(searchCases(source, { cue: 'shared foreign_only one_unknown two_unknown' }), expected)
  assert.ok(SQL.mock.calls.every(call => !call.arguments[0].includes('bm25(')))
})

test('四词完整共现不足时，候选分组仍保留完整 BM25 排序', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'case-four-terms-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = caseSource('codex', root, root)
  const rows = [
    ['triple', 'alpha beta gamma filler'],
    ['alpha-delta', 'alpha delta'],
    ['beta-delta', 'beta delta'],
    ['gamma-delta', 'gamma delta'],
  ]
  for (const pair of ['alpha beta', 'alpha gamma', 'beta gamma']) {
    for (let i = 0; i < 8; i++) rows.push([`${pair}-${i}`, pair])
  }
  for (let i = 0; i < 60; i++) rows.push([`delta-${i}`, 'delta'])
  fs.writeFileSync(path.join(root, 'stream.jsonl'),
    rows.map(([id, text]) => JSON.stringify({ id, kind: 'decision', ws: root, text })).join('\n') + '\n')
  assert.equal(syncCaseIndex(source).state, 'ready')
  const db = new DatabaseSync(path.join(root, 'memory-cases-codex-v3.sqlite'), { readOnly: true })
  try {
    const { rank } = fullRanking(db, source)
    for (const limit of [1, 3, 8]) {
      const cue = 'alpha beta gamma delta'
      const expected = rank(cue, limit)
      assert.equal(expected[0].summary, 'alpha beta gamma filler')
      assert.deepEqual(searchCases(source, { cue, limit }), { state: 'ready', cards: expected })
    }
  } finally { db.close() }
})

test('少数较长的四词全匹配不会触发高频候选全量评分', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-distant-cutoff-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = caseSource('codex', root, root)
  const rows = Array.from({ length: 200 }, () => 'alpha beta gamma')
  rows.push(...Array(3).fill('alpha beta gamma delta extra'))
  fs.writeFileSync(path.join(root, 'stream.jsonl'), rows.map((text, id) =>
    JSON.stringify({ id: String(id), kind: 'decision', ws: root, text })).join('\n') + '\n')
  assert.equal(syncCaseIndex(source).state, 'ready')
  const db = new DatabaseSync(path.join(root, 'memory-cases-codex-v3.sqlite'), { readOnly: true })
  try {
    const { rank } = fullRanking(db, source)
    const cue = 'alpha beta gamma delta'
    const expected = [1, 3, 8].map(limit => rank(cue, limit))
    const prepare = DatabaseSync.prototype.prepare
    const SQL = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      return prepare.call(this, sql)
    })
    for (const [i, limit] of [1, 3, 8].entries()) {
      assert.deepEqual(searchCases(source, { cue, limit }).cards, expected[i])
    }
    assert.ok(SQL.mock.calls.every(call => !call.arguments[0].includes('AND rowid<=?')))
  } finally { db.close() }
})

test('五端入口查询同一格式，跨端授权撤销立即生效', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-case-adapter-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = fs.mkdirSync(path.join(base, 'project'), { recursive: true })
  const sourcePath = relative => fileURLToPath(new URL('../' + relative, import.meta.url))
  const env = { ...process.env, MEMORY_CASE_RECALL: 'manual', MEMORY_CASE_SOURCES: '{}' }
  const read = (file, args, override = {}) => {
    const result = spawnSync(process.execPath, [sourcePath(file), ...args], { cwd: project, env: { ...env, ...override }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const query = '独立记录 export_id'
  for (const [adapter, file, variable] of [
    ['opencode', 'tools/mem.mjs', 'OPENCODE_MEM_HOME'],
    ['codex', 'agent-memory/recall.mjs', 'CODEX_MEMORY_HOME'],
    ['workbuddy', 'workbuddy-memory/bin/mem.mjs', 'WORKBUDDY_MEM_HOME'],
    ['zcode', 'zcode-memory/bin/cli.mjs', 'ZCODE_MEM_HOME'],
    ['dsh', 'dsh-memory/cli.mjs', 'DSH_MEMORY_HOME'],
  ]) {
    const root = fs.mkdirSync(path.join(base, adapter), { recursive: true })
    env[variable] = root
    const dsh = adapter === 'dsh'
    let ledger = root
    if (dsh) {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { workspaceDir } from ${JSON.stringify(new URL('../dsh-memory/lib/config.mjs', import.meta.url).href)}; console.log(workspaceDir(process.cwd()));`],
      { cwd: project, env, encoding: 'utf8' })
      assert.equal(probe.status, 0, probe.stderr)
      ledger = fs.mkdirSync(probe.stdout.trim(), { recursive: true })
    }
    const hooks = {
      workbuddy: ['workbuddy-memory/bin/mem.mjs', 'hook'],
      zcode: ['zcode-memory/bin/hook.mjs'],
      codex: ['codex-memory/hook.mjs'],
    }
    if (hooks[adapter]) {
      const [entry, ...args] = hooks[adapter]
      const events = [
        { hook_event_name: 'UserPromptSubmit', prompt: query },
        { hook_event_name: 'Stop', last_assistant_message: '观察记录' },
      ]
      for (const event of events) {
        const result = spawnSync(process.execPath, [sourcePath(entry), ...args], { cwd: project,
          env: { ...env, MEMORY_DISABLE_MAINTENANCE: '1', WORKBUDDY_DISABLE_MAINTENANCE: '1', ZCODE_DISABLE_MAINTENANCE: '1' },
          input: JSON.stringify({ ...event, cwd: project, session_id: 'fixture', turn_id: '1' }), encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      }
    } else {
      fs.writeFileSync(path.join(ledger, 'stream.jsonl'), JSON.stringify({ id: 'same', kind: 'decision', text: query, ws: project }) + '\n')
    }
    assert.equal(syncCaseIndex(caseSource(adapter, ledger, project, { singleProject: dsh })).state, 'ready', adapter)
    const command = dsh ? ['recall', project] : ['recall']
    const { cards } = read(file, [...command, 'export_id', '--cases'])
    assert.equal(cards[0].summary, query, adapter)
    const args = dsh ? ['show', project] : ['show']
    assert.equal(read(file, [...args, cards[0].evidence[0].ref]).text, query, adapter)
    if (adapter === 'opencode') {
      const allow = { MEMORY_CASE_SOURCES: JSON.stringify({ old: { adapter, root, project, fromProject: project } }) }
      const shared = 'agent-memory/recall.mjs'
      assert.equal(read(shared, ['recall', 'export_id', '--cases', '--source', 'old'], allow).cards[0].summary, query)
      assert.equal(read(shared, ['show', cards[0].evidence[0].ref, '--source', 'old'], allow).text, query)
      assert.equal(read(shared, ['show', cards[0].evidence[0].ref, '--source', 'old']).state, 'denied')
    }
  }
})
