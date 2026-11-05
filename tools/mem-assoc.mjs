// mem-assoc —— 词与词之间的联想。
//
// 别名是「断言」：有人说过它们同义。
// 联想是「推断」：它们老是出现在同一段话里。
//
// 所以两者权重不同——别名 0.7（可信），联想 0.35（只是线索）。
//
// 图是**派生**的：从 stream 现算，存成 assoc.json，删了重算即可，不影响任何原文。

// 用 PMI（点互信息）而不是裸共现次数：
// 「记忆」和「插件」共现 50 次不稀奇，因为它们各自就出现 50 次；
// PMI 会把这种「到处都在的词」压下去，留下真正绑在一起的一对。
export function buildAssoc(docs, { minCount = 2, maxPerDoc = 40, topK = 8, maxDf = 0.5, vocab = [] } = {}) {
  const N = docs.length || 1
  const df = new Map()
  const perDoc = []

  for (const d of docs) {
    const terms = [...new Set(entitiesOfLite(d.text, vocab))].slice(0, maxPerDoc)
    perDoc.push(terms)
    for (const t of terms) df.set(t, (df.get(t) || 0) + 1)
  }

  const co = new Map()
  for (const terms of perDoc) {
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const a = terms[i] < terms[j] ? terms[i] : terms[j]
        const b = terms[i] < terms[j] ? terms[j] : terms[i]
        const k = a + '\u0000' + b
        co.set(k, (co.get(k) || 0) + 1)
      }
    }
  }

  const out = Object.create(null)
  for (const [k, n] of co) {
    if (n < minCount) continue
    const [a, b] = k.split('\u0000')
    const da = df.get(a) || 0
    const db = df.get(b) || 0
    if (!da || !db) continue
    if (da / N > maxDf || db / N > maxDf) continue
    const pmi = Math.log2((n * N) / (da * db))
    if (pmi <= 0) continue
    ;(out[a] || (out[a] = [])).push([b, +pmi.toFixed(2), n])
    ;(out[b] || (out[b] = [])).push([a, +pmi.toFixed(2), n])
  }

  for (const t of Object.keys(out)) {
    out[t].sort((x, y) => y[1] - x[1] || y[2] - x[2])
    out[t] = out[t].slice(0, topK)
  }
  return out
}

// 和 facets 的 entitiesOf 同源，但这里不要 kind/domain，只要词。
import { entitiesOf } from './mem-facets.mjs'
function entitiesOfLite(text, vocab) {
  return entitiesOf(text, vocab)
}

// 从查询里挑出「在联想图里有邻居」的词，取它们的邻居。
export function expandAssoc(query, assoc, { limit = 6, minPmi = 1.0 } = {}) {
  if (!assoc) return { extra: [], hit: [] }
  const q = String(query || '').toLowerCase()
  const extra = new Set()
  const hit = []
  for (const term of Object.keys(assoc)) {
    if (!q.includes(term)) continue
    hit.push(term)
    for (const [nb, pmi] of assoc[term]) {
      if (pmi < minPmi) continue
      if (q.includes(nb)) continue
      extra.add(nb)
      if (extra.size >= limit) break
    }
    if (extra.size >= limit) break
  }
  return { extra: [...extra], hit }
}

export function assocStats(map) {
  const terms = Object.keys(map)
  let edges = 0
  for (const t of terms) edges += map[t].length
  return { terms: terms.length, edges }
}
