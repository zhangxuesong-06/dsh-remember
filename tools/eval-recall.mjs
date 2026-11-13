// 真实数据评测：查询用用户原话，目标用那次回答。
//
// 为什么这样测：真实使用里不会拿记忆原文当查询，而是问一句新问题，
// 希望把「当时怎么回答的」捞回来。所以判定是「top-k 里有没有那一轮的回答」，
// 而不是「有没有包含查询词」——后者只能证明 BM25 在工作。
//
// 只读 stream.jsonl；不写账本。派生索引（assoc）可能被重建，属于可删缓存。
//
//   node tools/eval-recall.mjs              基线
//   node tools/eval-recall.mjs --grid       对比几组打分参数
//   node tools/eval-recall.mjs --json       机器可读
import { pathToFileURL } from 'node:url'
import { readAll, recall, tok } from './mem-core.mjs'

const K = 8
const DAY = 864e5

export function buildCases(rows) {
  const answers = new Map()
  for (const r of rows) {
    if (r.who !== 'assistant' || r.kind !== 'message' || !r.turnID) continue
    const a = answers.get(r.turnID) || []
    a.push(r)
    answers.set(r.turnID, a)
  }
  const cases = []
  for (const u of rows) {
    if (u.who !== 'user' || u.kind !== 'message' || !u.messageID) continue
    const text = String(u.text || '').trim()
    if (text.length < 10) continue
    if (text.startsWith('/') && text.length < 40) continue
    if (new Set(tok(text)).size < 3) continue
    const ans = answers.get(u.messageID)
    if (!ans || !ans.length) continue
    cases.push({
      seq: u.seq, ts: u.ts || 0, turnID: u.messageID,
      query: text, answerSeqs: new Set(ans.map((r) => r.seq)),
      answerLen: ans.reduce((s, r) => s + String(r.text).length, 0) / ans.length,
    })
  }
  return cases
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

export function evaluate(cases, rank = {}, now = Date.now(), search = recall) {
  const rows = []
  const recentCut = now - 3 * DAY
  for (const c of cases) {
    const t0 = performance.now()
    const res = search(c.query, { n: K, rank, now })
    const ms = performance.now() - t0
    // 查询本身就是一条记录；真实场景里不会命中自己，先排除。
    const out = res.filter((r) => r.messageID !== c.turnID)
    const pos = out.findIndex((r) => c.answerSeqs.has(r.seq) || r.turnID === c.turnID)
    rows.push({
      seq: c.seq, old: c.ts < recentCut, pos, ms,
      chars: out.reduce((s, r) => s + String(r.text).length, 0),
      dup: out.length - new Set(out.map((r) => r.messageID || r.seq)).size,
      turns: new Set(out.map((r) => r.turnID || r.sid || r.seq)).size,
      empty: out.length === 0,
    })
  }
  const stat = (list) => {
    const n = list.length || 1
    const hit = (k) => list.filter((r) => r.pos >= 0 && r.pos < k).length / n
    const lats = list.map((r) => r.ms).sort((a, b) => a - b)
    return {
      n: list.length,
      hit1: +hit(1).toFixed(3),
      hit3: +hit(3).toFixed(3),
      hit8: +hit(8).toFixed(3),
      mrr: +(list.reduce((s, r) => s + (r.pos >= 0 ? 1 / (r.pos + 1) : 0), 0) / n).toFixed(3),
      empty: list.filter((r) => r.empty).length,
      chars: Math.round(list.reduce((s, r) => s + r.chars, 0) / n),
      dup: +(list.reduce((s, r) => s + r.dup, 0) / n).toFixed(2),
      turns: +(list.reduce((s, r) => s + r.turns, 0) / n).toFixed(2),
      p50: +pct(lats, 0.5).toFixed(1),
      p95: +pct(lats, 0.95).toFixed(1),
    }
  }
  return {
    all: stat(rows),
    recent: stat(rows.filter((r) => !r.old)),
    old: stat(rows.filter((r) => r.old)),
  }
}

const VARIANTS = [
  ['default', {}],
  ['decay(旧)', { recency: { mode: 'decay' } }],
  ['flat', { recency: { mode: 'decay', floor: 1 } }],
  ['cov=.25', { minCoverage: 0.25 }],
  ['cov=.3', { minCoverage: 0.3 }],
  ['decay+cov.3', { recency: { mode: 'decay' }, minCoverage: 0.3 }],
]

function table(results) {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('variant', 18), pad('hit@1', 7), pad('hit@3', 7), pad('hit@8', 7), pad('MRR', 6),
    pad('chars', 7), pad('turns', 6), pad('empty', 6), pad('p50ms', 7), pad('old@8', 7), pad('new@8', 7))
  for (const [name, r] of results) {
    const a = r.all
    console.log(pad(name, 18), pad(a.hit1, 7), pad(a.hit3, 7), pad(a.hit8, 7), pad(a.mrr, 6),
      pad(a.chars, 7), pad(a.turns, 6), pad(a.empty, 6), pad(a.p50, 7), pad(r.old.hit8, 7), pad(r.recent.hit8, 7))
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const grid = args.includes('--grid')
  const rows = readAll()
  const cases = buildCases(rows)
  if (!cases.length) {
    console.log('没有可评测的「提问 → 回答」配对；先聊几句再来。')
    process.exit(0)
  }
  // 预热一次：第一次调用要建倒排索引，不该算进单次延迟。
  recall(cases[0].query, { n: K })
  const now = Date.now()

  if (grid) {
    const results = VARIANTS.map(([name, rank]) => [name, evaluate(cases, rank, now)])
    if (json) console.log(JSON.stringify(Object.fromEntries(results), null, 2))
    else {
      console.log(`样本 ${cases.length} 条｜K=${K}｜目标=该轮回答\n`)
      table(results)
    }
  } else {
    const r = evaluate(cases, {}, now)
    if (json) console.log(JSON.stringify({ cases: cases.length, ...r }, null, 2))
    else {
      console.log(`样本 ${cases.length} 条｜K=${K}｜目标=该轮回答\n`)
      console.log(`hit@1 ${r.all.hit1}  hit@3 ${r.all.hit3}  hit@8 ${r.all.hit8}  MRR ${r.all.mrr}`)
      console.log(`每次 top-8 ${r.all.chars} 字符 · ${r.all.turns} 个不同轮次 · 重复 ${r.all.dup}`)
      console.log(`老记录 hit@8 ${r.old.hit8}（${r.old.n} 条）· 近三天 hit@8 ${r.recent.hit8}（${r.recent.n} 条）`)
      console.log(`延迟 p50 ${r.all.p50}ms  p95 ${r.all.p95}ms`)
    }
  }
}
