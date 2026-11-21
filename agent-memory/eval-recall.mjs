// 固定的五端召回题使用临时账本，查询与回读沿用正式入口。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseRef, readAt, recall, refOf } from './recall.mjs'

const SOURCES = ['opencode', 'dsh', 'workbuddy', 'zcode', 'codex']
const K = 8

export function writeStreams(root, streams) {
  for (const { source, workspace, rows } of streams) {
    if (!SOURCES.includes(source)) throw new Error(`未知来源 ${source}`)
    if (source === 'dsh' && !/^[a-z0-9_-]+$/i.test(workspace ?? '')) {
      throw new Error(`无效的合成 DSH 工作区 ${workspace}`)
    }
    const dir = source === 'dsh' ? path.join(root, source, workspace) : path.join(root, source)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }
}

function identity(record) {
  return {
    ref: refOf(record), who: record.who, sid: record.sid,
    turnID: record.turnID, turn: record.turn,
  }
}

function scoreCase({ id, query, ref, who, sid, turnID, turn, text }, now) {
  const { source, line, workspace } = parseRef(ref)
  const original = readAt(source, line, workspace)
  const verified = original?.text === text && original.who === who && original.sid === sid
    && (turnID === undefined || original.turnID === turnID)
    && (turn === undefined || original.turn === turn)
  const hits = recall(query, { now, n: K }).map(identity)
  const position = hits.findIndex((hit) => hit.ref === ref)
  return {
    id, query, ref, evidence: verified ? { ...identity(original), text: original.text } : null,
    rank: verified && position !== -1 ? position + 1 : null, hits,
  }
}

function metrics(cases) {
  if (!cases.length) return { n: 0, hit3: null, mrr: null }
  const ranks = cases.flatMap(({ rank }) => rank === null ? [] : [rank])
  return {
    n: cases.length,
    hit3: +(ranks.filter((rank) => rank <= 3).length / cases.length).toFixed(3),
    mrr: +(ranks.reduce((sum, rank) => sum + 1 / rank, 0) / cases.length).toFixed(3),
  }
}

export function evaluateFixture(fixture) {
  const now = Date.parse(fixture.now)
  if (!Number.isFinite(now)) throw new Error('评测需要固定且有效的时间')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-recall-eval-'))
  const overrides = { AGENT_MEMORY_HOME: root, CODEX_MEMORY_HOME: path.join(root, 'codex') }
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]])
  try {
    writeStreams(root, fixture.streams)
    Object.assign(process.env, overrides)
    const cases = fixture.cases.map((item) => scoreCase(item, now))
    return {
      now: fixture.now, k: K, all: metrics(cases),
      bySource: Object.fromEntries(SOURCES.map((source) => [
        source, metrics(cases.filter(({ ref }) => ref.startsWith(source + ':'))),
      ])),
      cases,
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export function baselineDifferences(report, baseline) {
  const { cases, ...summary } = report
  const { cases: expected, ...previous } = baseline
  const before = new Map(expected.map((item) => [item.id, item]))
  const changes = []
  for (const item of cases) {
    const old = before.get(item.id)
    if (!item.evidence) changes.push(`${item.id} (${item.ref}) 原话或归属核对失败`)
    else if (!old) changes.push(`${item.id} (${item.ref}) 新增题目`)
    else if (JSON.stringify(item) !== JSON.stringify(old)) {
      changes.push(`${item.id} (${item.ref}) 排名 ${old.rank ?? '未命中'} → ${item.rank ?? '未命中'}，题目或结果有变化`)
    }
    before.delete(item.id)
  }
  for (const { id, ref } of before.values()) changes.push(`${id} (${ref}) 题目缺失`)
  if (JSON.stringify(summary) !== JSON.stringify(previous)) changes.push('评测汇总有变化')
  return changes
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
}

function main(args) {
  if (args.some((arg) => !['--json', '--check'].includes(arg))) {
    console.error('用法：node agent-memory/eval-recall.mjs [--json] [--check]')
    return 2
  }
  const report = evaluateFixture(readFixture('recall-cases'))
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    for (const [source, { n, hit3, mrr }] of Object.entries({ all: report.all, ...report.bySource })) {
      console.log(`${source.padEnd(10)} 题数 ${n}  Hit@3 ${hit3 ?? '-'}  MRR@8 ${mrr ?? '-'}`)
    }
    for (const { id, ref, rank, evidence, hits } of report.cases) {
      const result = evidence ? (rank ?? '未命中') : '原话回读失败'
      console.log(`${id} (${ref})  ${result}  [${hits.map((hit) => `${hit.ref}/${hit.who}`).join(', ')}]`)
    }
  }
  if (!args.includes('--check')) return 0
  const changes = baselineDifferences(report, readFixture('recall-baseline'))
  if (changes.length) {
    for (const change of changes) console.error(change)
    return 1
  }
  if (!args.includes('--json')) console.log('与固定基线一致，所有目标均能按引用回读。')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
