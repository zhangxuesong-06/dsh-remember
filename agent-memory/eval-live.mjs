import { pathToFileURL } from 'node:url'
import { tok } from '../tools/mem-tokenize.mjs'
import { createRecallSearch, loadAll, LONG_TEXT_RANK, quoteFor, refOf } from './recall.mjs'

const LIMIT = 8
const PER_SESSION = 12
const VARIANTS = {
  baseline: {},
  'coverage-0.12': { minCoverage: 0.12 },
  'coverage-0.16': { minCoverage: 0.16 },
  'coverage-0.25': { minCoverage: 0.25 },
  'coverage-weight': { coveragePower: 0.5 },
  'length-0.45': LONG_TEXT_RANK,
  'length-0.90': { b: 0.9 },
  'recency-0.15': { recencyBoost: 0.15 },
  'coverage-length': { ...LONG_TEXT_RANK, minCoverage: 0.16 },
}

function turnOf(record) {
  if (record.turnID || record.turn != null) return String(record.turnID ?? record.turn)
  return record.source === 'opencode' && record.who === 'user' ? record.messageID : null
}

function shortClue(record) {
  const lines = record.text.split(/[。！？；\n]/u).map((line) => line.trim())
  const line = lines.find((part) => part.length >= 12 && new Set(tok(part)).size >= 6)
  if (!line) return null
  const size = Math.min(48, Math.floor(line.length * 0.7))
  const start = Math.floor((line.length - size) * (record.line % 3) / 2)
  const clue = line.slice(start, start + size).trim()
  const terms = new Set(tok(clue))
  if (terms.size < 4 || terms.size >= new Set(tok(record.text)).size) return null
  return clue
}

export function buildLiveCases(records) {
  const turns = new Map()
  const clues = []
  const laterClues = []
  for (const record of records) {
    if (!record.sid || record.kind !== 'message' || !['user', 'assistant'].includes(record.who)) continue
    const session = JSON.stringify([record.source, record.store, record.sid])
    const ref = refOf(record)
    const turn = turnOf(record)
    if (turn != null) {
      const key = JSON.stringify([session, turn])
      const group = turns.get(key) ?? { prompts: [], replies: [] }
      group[record.who === 'user' ? 'prompts' : 'replies'].push(record)
      turns.set(key, group)
    }
    const query = shortClue(record)
    if (query) {
      const clue = { source: record.source, session, ts: record.ts, query, refs: new Set([ref]) }
      clues.push(clue)
      if (record.text.length >= 1280) {
        const later = [...record.text.slice(Math.floor(record.text.length / 2)).matchAll(/[^\r\n。！？；]+/gu)]
          .sort((left, right) => Math.abs(left.index - record.text.length / 4) - Math.abs(right.index - record.text.length / 4))
          .map(([line]) => line.trim().slice(0, 48).trim())
          .find((part) => part.length >= 12 && new Set(tok(part)).size >= 6 && record.text.indexOf(part) >= 640)
        if (later) laterClues.push({ ...clue, query: later })
      }
    }
  }

  const answers = []
  for (const { prompts, replies } of turns.values()) {
    if (prompts.length !== 1 || !replies.length) continue
    const [prompt] = prompts
    const query = prompt.text.trim()
    if (query.length < 10 || query.length > 500 || new Set(tok(query)).size < 5) continue
    answers.push({
      source: prompt.source, session: JSON.stringify([prompt.source, prompt.store, prompt.sid]),
      ts: prompt.ts, query, input: refOf(prompt), refs: new Set(replies.map(refOf)),
    })
  }
  return { answers, clues, laterClues }
}

export function splitLiveCases(cases) {
  const firstBySession = new Map()
  for (const item of Object.values(cases).flat()) {
    const first = firstBySession.get(item.session)
    if (!first || item.ts < first.ts) firstBySession.set(item.session, item)
  }
  const perSource = Map.groupBy([...firstBySession.values()].sort((left, right) => left.ts - right.ts),
    (item) => item.source)
  const holdout = new Set()
  for (const group of perSource.values()) {
    const split = Math.max(1, Math.floor(group.length * 0.7))
    for (const item of group.slice(split)) holdout.add(item.session)
  }

  return Object.fromEntries(Object.entries(cases).map(([name, rows]) => {
    const groups = { tune: [], holdout: [] }
    const perSession = Map.groupBy(rows.toSorted((left, right) => left.ts - right.ts), (item) => item.session)
    for (const [session, items] of perSession) {
      const output = holdout.has(session) ? groups.holdout : groups.tune
      const length = Math.min(items.length, PER_SESSION)
      for (let index = 0; index < length; index++) {
        output.push(items[Math.floor((index + 0.5) * items.length / length)])
      }
    }
    return [name, groups]
  }))
}

function evaluate(search, cases, now, rank, trackQuotes) {
  const results = cases.map(({ query, refs, source, input }) => {
    const hits = search(query, {
      n: LIMIT, now, rank,
      exclude: input ? (record) => record.who === 'user' &&
        (refOf(record) === input || record.text.trim() === query) : undefined,
    })
    const position = hits.findIndex((record) => refs.has(refOf(record))) + 1
    const quoteHit = trackQuotes && position > 0 && quoteFor(hits[position - 1], query).text.includes(query)
    return { source, position, quoteHit, empty: !hits.length }
  })
  const summary = (rows) => {
    if (!rows.length) return { n: 0 }
    const rate = (value) => +(value / rows.length).toFixed(3)
    return {
      n: rows.length, hit1: rate(rows.filter(({ position }) => position === 1).length),
      hit3: rate(rows.filter(({ position }) => position > 0 && position <= 3).length),
      hit8: rate(rows.filter(({ position }) => position > 0).length),
      mrr: rate(rows.reduce((sum, { position }) => sum + (position ? 1 / position : 0), 0)),
      empty: rows.filter((row) => row.empty).length,
      ...(trackQuotes ? { quoteAt8: rate(rows.filter((row) => row.quoteHit).length) } : {}),
    }
  }
  return {
    all: summary(results),
    bySource: Object.fromEntries([...Map.groupBy(results, (row) => row.source)]
      .map(([source, rows]) => [source, summary(rows)])),
  }
}

function main(args) {
  const now = args.length === 2 && args[0] === '--at' ? Date.parse(args[1]) : args.length ? NaN : Date.now()
  if (!Number.isFinite(now)) {
    console.error('用法：node agent-memory/eval-live.mjs [--at <ISO 时间>]')
    return 2
  }
  const library = loadAll()
  const search = createRecallSearch(library)
  const passageSearch = createRecallSearch(library, { passages: true })
  const cases = Object.entries(splitLiveCases(buildLiveCases(library.records)))
  if (cases.every(([, { tune, holdout }]) => !tune.length && !holdout.length)) {
    console.error('当前账本没有可评测的消息。')
    return 1
  }
  const variants = Object.fromEntries(Object.entries({ ...VARIANTS, passage: {} }).map(([variant, rank]) => [
    variant, Object.fromEntries(cases.map(([name, groups]) => [
      name, Object.fromEntries(Object.entries(groups).map(([split, rows]) => [
        split, evaluate(variant === 'passage' ? passageSearch : search, rows, now, rank, name !== 'answers'),
      ])),
    ])),
  ]))
  console.log(JSON.stringify({
    at: new Date(now).toISOString(),
    records: Object.fromEntries(library.stores.map(({ source, records }) => [source, records])),
    indexedRecords: library.records.length,
    variants,
  }, null, 2))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
