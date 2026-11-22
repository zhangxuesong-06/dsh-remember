// Shared read-only recall over caller-selected records. No ledger or host dependencies.
const DAY = 864e5
const K1 = 1.25
const B = 0.72
const MIN_COVERAGE = 0.2
const PASSAGE_SIZE = 640
const PASSAGE_OVERLAP = 128
export const QUOTE_SIZE = 192
const COMPACT_HITS = 5
const COMPACT_BYTES = 3072

const SPEAKERS = { he: 'user', me: 'assistant', act: 'action', meta: 'meta' }
export const speakerOf = (who) => Object.hasOwn(SPEAKERS, who) ? SPEAKERS[who] : who || ''

function recency(ts, now, boost, halfLifeDays) {
  const days = Math.max(0, (now - (ts || now)) / DAY)
  return 1 + boost * Math.pow(0.5, days / halfLifeDays)
}

// 偏移与 String.slice 一致，窗口边界避开 UTF-16 代理对。
function boundary(text, offset) {
  const code = text.charCodeAt(offset)
  const previous = text.charCodeAt(offset - 1)
  return code >= 0xDC00 && code <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF ? offset - 1 : offset
}

function* windows(text, size, overlap) {
  for (let start = 0; start < text.length;) {
    const end = boundary(text, Math.min(text.length, start + size))
    yield { start, end }
    if (end === text.length) break
    start = boundary(text, end - overlap)
  }
}

export function createTextSearch(pool, { tokenize, passages, weight = () => 1, key }) {
  const windowsByIndex = passages ? pool.flatMap((record, parent) =>
    [...windows(record.text, PASSAGE_SIZE, PASSAGE_OVERLAP)]
      .filter(({ start, end }) => record.text.slice(start, end).trim())
      .map(({ start, end }) => ({ parent, start, end }))) : null
  const N = windowsByIndex?.length ?? pool.length
  const post = new Map()
  const dl = new Array(N)
  let total = 0
  for (let i = 0; i < N; i++) {
    const window = windowsByIndex?.[i]
    const text = window ? pool[window.parent].text.slice(window.start, window.end) : pool[i].text
    const t = tokenize(text)
    dl[i] = t.length
    total += t.length
    const tf = new Map()
    for (const x of t) tf.set(x, (tf.get(x) || 0) + 1)
    for (const [k, v] of tf) {
      let a = post.get(k)
      if (!a) { a = []; post.set(k, a) }
      a.push(i, v)
    }
  }
  const avg = total / N || 1

  return function search(query, { n = 8, now = Date.now(), rank = {}, exclude } = {}) {
    const qterms = [...new Set(tokenize(query))]
    const {
      minCoverage = MIN_COVERAGE, recencyBoost = 0.5, halfLifeDays = 3,
      coveragePower = 0, b = B, k1 = K1,
    } = rank
    const scores = new Map()
    const hitCount = new Map()
    for (const term of qterms) {
      const posting = post.get(term)
      if (!posting) continue
      const df = posting.length / 2
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (let index = 0; index < posting.length; index += 2) {
        const id = posting[index], frequency = posting[index + 1], length = dl[id] || 1
        const termScore = idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length / avg)))
        scores.set(id, (scores.get(id) || 0) + termScore)
        hitCount.set(id, (hitCount.get(id) || 0) + 1)
      }
    }

    const scored = []
    for (const [index, bm25] of scores) {
      const window = windowsByIndex?.[index]
      const parent = window?.parent ?? index
      const rec = pool[parent]
      const coverage = hitCount.get(index) / qterms.length
      if (coverage < minCoverage || exclude?.(rec)) continue
      const score = bm25 * recency(rec.ts, now, recencyBoost, halfLifeDays) * weight(rec) * coverage ** coveragePower
      scored.push({ parent, window, score, coverage })
    }
    scored.sort((left, right) => right.score - left.score)

    const seen = new Set()
    const seenParents = new Set()
    const out = []
    for (const { parent, window, score, coverage } of scored) {
      if (window) {
        if (seenParents.has(parent)) continue
        seenParents.add(parent)
      }
      const rec = pool[parent]
      const dedupe = key ? key(rec, passages) : parent
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const hit = { ...rec, score, coverage: +coverage.toFixed(2) }
      if (window) hit.passage = { start: window.start, end: window.end }
      out.push(hit)
      if (out.length >= n) break
    }
    return out
  }
}

function quoteRange(record, ref, start, end) {
  return { ref, who: speakerOf(record.who), start, end, text: record.text.slice(start, end) }
}

export function quoteFor(record, query, ref, tokenize) {
  const { text, passage } = record
  if (text.length <= QUOTE_SIZE) return quoteRange(record, ref, 0, text.length)

  // 短线索有逐字命中时优先围绕原话取上下文。
  const exact = query ? text.indexOf(query) : -1
  if (exact !== -1) {
    const margin = Math.max(0, Math.floor((QUOTE_SIZE - query.length) / 2))
    const start = boundary(text, Math.min(text.length - QUOTE_SIZE, Math.max(0, exact - margin)))
    const end = boundary(text, start + QUOTE_SIZE)
    // 调整代理对边界后仍让可放入的逐字命中保持完整。
    if (query.length <= QUOTE_SIZE && exact + query.length > end) {
      return quoteRange(record, ref, exact, boundary(text, Math.min(text.length, exact + QUOTE_SIZE)))
    }
    return quoteRange(record, ref, start, end)
  }

  const offset = passage?.start ?? 0
  const range = text.slice(offset, passage?.end)
  const terms = new Set(tokenize(query))
  let best = { start: 0, end: boundary(range, Math.min(range.length, QUOTE_SIZE)) }
  let bestScore = 0
  for (const window of windows(range, QUOTE_SIZE, 64)) {
    const matches = new Set(tokenize(range.slice(window.start, window.end)).filter((term) => terms.has(term)))
    if (matches.size > bestScore) {
      best = window
      bestScore = matches.size
    }
  }
  return quoteRange(record, ref, offset + best.start, offset + best.end)
}

export function compactQuotes(records, query, { n = 3, refOf, tokenize }) {
  const rows = []
  let bytes = 3 // [] and newline
  for (const record of records.slice(0, compactLimit(n))) {
    const row = JSON.stringify(quoteFor(record, query, refOf(record), tokenize))
    bytes += Buffer.byteLength(row) + Number(rows.length > 0)
    if (bytes > COMPACT_BYTES) break
    rows.push(row)
  }
  return `[${rows.join(',')}]`
}

function parseRange(value, text) {
  const match = /^(\d+):(\d+)$/.exec(value)
  if (!match) return null
  const start = Number(match[1]), end = Number(match[2])
  if (start >= end || end > text.length || boundary(text, start) !== start || boundary(text, end) !== end) return null
  return { start, end }
}

export function serializeRange(record, ref, range) {
  const row = { ...record, text: String(record.text ?? '') }
  const parsed = parseRange(range, row.text)
  if (!parsed) throw new RangeError('range 需要有效的原文位置 start:end。')
  return JSON.stringify(quoteRange(row, ref, parsed.start, parsed.end))
}

export function compactLimit(n) {
  return Math.max(1, Math.min(COMPACT_HITS, Math.trunc(Number(n)) || 3))
}

export function compactRecall(records, query, { tokenize, passages, n, refOf, weight }) {
  const search = createTextSearch(records, { tokenize, passages, weight })
  return compactQuotes(search(query, { n: compactLimit(n) }), query, { n, refOf, tokenize })
}

export function recallFlags(args) {
  const words = []
  let compact = false
  let passages = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--compact') compact = true
    else if (args[i] === '--rank') {
      if (args[++i] !== 'passage') throw new Error('--rank 需要 passage。')
      passages = true
    } else words.push(args[i])
  }
  return { words, compact, passages }
}
