import { readFileSync } from 'node:fs'
import { tok } from '../../tools/mem-tokenize.mjs'
import { buildSemanticIndex, cosine, EmbeddingCache } from './semantic.mjs'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
}

// Match the retired sphere's TF-IDF weighting, minimum shared terms and union of top-3 edges.
function lexicalNeighbors(records) {
  const documents = records.map(record => tok(record.text.slice(0, 6400)))
  const frequencies = new Map()
  for (const tokens of documents) {
    for (const token of new Set(tokens)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  const vectors = documents.map(tokens => {
    const counts = new Map()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    const weights = [...counts].map(([token, count]) => [token,
      (1 + Math.log(count)) * (1 + Math.log((documents.length + 1) / (frequencies.get(token) + 1)))])
    const norm = Math.hypot(...weights.map(([, weight]) => weight)) || 1
    return new Map(weights.map(([token, weight]) => [token, weight / norm]))
  })
  const candidates = records.map(() => [])
  for (const [i, left] of vectors.entries()) {
    for (let j = i + 1; j < vectors.length; j++) {
      let score = 0
      let terms = 0
      for (const [token, weight] of left) {
        if (!vectors[j].has(token)) continue
        score += weight * vectors[j].get(token)
        terms++
      }
      if (score < 0.13 || (terms < 2 && score < 0.3)) continue
      const differentDshWorkspace = records[i].source === 'dsh' && records[j].source === 'dsh'
        && records[i].workspace !== records[j].workspace
      const edge = { i, j, score: Math.min(0.7, score) * (differentDshWorkspace ? 0.45 : 1) }
      candidates[i].push(edge)
      candidates[j].push(edge)
    }
  }
  const result = new Map()
  for (const neighbors of candidates) {
    neighbors.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j)
    for (const { i, j, score } of neighbors.slice(0, 3)) result.set(`${i}/${j}`, score)
  }
  return (i, j) => result.get(`${Math.min(i, j)}/${Math.max(i, j)}`) ?? 0
}

// Explicitly unrelated controls, shared by all comparison runs and scored against every anchor.
const controls = [
  '食谱最后撒上烤芝麻和葱花。',
  'An incoming monsoon is pushing sailboats back to shore.',
  '这支乐团在巡演中加演了两首曲子。',
  'Los elefantes se desplazan en manadas durante la estación seca.',
  '市美术馆展出了一批十八世纪的肖像。',
  'A violet orchid has flowered in the greenhouse.',
]

async function compare(suite, cache) {
  const records = suite.flatMap(([, category, ...texts], index) => texts.map((text, slot) => {
    const source = category === 'dsh' ? 'dsh' : slot === 1 ? 'opencode' : 'codex'
    const workspace = source === 'dsh' ? (slot === 2 ? 'other' : 'lab') : ''
    const line = index * 3 + slot + 1
    return {
      text, source, workspace, store: `${source}/${workspace}`, kind: 'message',
      sid: source === 'dsh' && slot === 2 ? `${index}/0` : `${index}/${slot}`,
      ref: workspace ? `${source}:${workspace}:${line}` : `${source}:${line}`,
    }
  }))
  records.push(...controls.map((text, index) => ({
    ref: `workbuddy:${index + 1}`, source: 'workbuddy', text, kind: 'message',
  })))
  const lexical = lexicalNeighbors(records.slice(0, suite.length * 3))
  const ranked = await buildSemanticIndex(records, cache)
  const vectors = await cache.embed(records.map(record => record.text))
  const counts = { total: suite.length, lexical: 0, embeddingOnly: 0, semantic: 0, identityErrors: 0, correctionErrors: 0, directionErrors: 0 }
  let unrelatedErrors = 0
  const cases = suite.map(([id, category], index) => {
    const i = index * 3
    const order = ranked(records[i].ref).map(item => item.ref)
    unrelatedErrors += Number(order.some(ref => ref.startsWith('workbuddy:')))
    const positive = order.indexOf(records[i + 1].ref)
    const negative = order.indexOf(records[i + 2].ref)
    const listedBothWays = negative >= 0 || ranked(records[i + 2].ref).some(item => item.ref === records[i].ref)
    if (category === 'dsh' && listedBothWays) counts.identityErrors++
    if (category === 'correction' && listedBothWays) counts.correctionErrors++
    if (category === 'direction' && listedBothWays) counts.directionErrors++
    const lexicalScores = [lexical(i, i + 1), lexical(i, i + 2)]
    const embeddingScores = [cosine(vectors[i], vectors[i + 1]), cosine(vectors[i], vectors[i + 2])]
    const pass = positive >= 0 && (negative < 0 || positive < negative)
    counts.lexical += Number(lexicalScores[0] > lexicalScores[1])
    counts.embeddingOnly += Number(embeddingScores[0] > embeddingScores[1])
    counts.semantic += Number(pass)
    return {
      id, category, pass, lexicalScores, embeddingScores,
      positiveRank: positive + 1 || null, negativeRank: negative + 1 || null,
    }
  })
  return { ...counts, unrelatedErrors, cases }
}

export async function evaluateSemantic(model) {
  const categories = { 'reverse-correction': 'correction', 'sim-extrinsics': 'direction' }
  const cache = new EmbeddingCache(model)
  const previous = await compare(fixture('atlas-cases').map(([id, ...texts]) => [id, categories[id] ?? 'paraphrase', ...texts]), cache)
  const calibration = await compare(fixture('atlas-calibration'), cache)
  const holdout = await compare(fixture('atlas-holdout'), cache)
  const passed = holdout.total >= 20 && holdout.semantic / holdout.total >= 0.9
    && holdout.unrelatedErrors === 0
    && holdout.semantic > holdout.lexical && previous.semantic >= previous.lexical
    && [holdout, calibration, previous].every(result => result.identityErrors + result.correctionErrors + result.directionErrors === 0)
  return { passed, model: model.fingerprint, previous, calibration, holdout }
}
