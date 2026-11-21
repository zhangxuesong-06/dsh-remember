import fs from 'node:fs'
import { angularDistance } from './sphere.mjs'
import { buildAtlas, inferRelations } from './atlas.mjs'
import { randomFrom } from './graph-data.mjs'

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/atlas-cases.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
const permutations = 5
const summary = { cases: cases.length, permutations, lexicalOrder: 0, sphereOrder: 0, layoutWithoutRelations: 0 }

function recordsFor(seed) {
  const random = randomFrom('atlas-eval-' + seed)
  const ids = Array.from({ length:cases.length*3 }, (_,i) => 1+i)
  for (let i=ids.length-1;i>0;i--) {
    const j = Math.floor(random() * (i+1))
    ;[ids[i],ids[j]] = [ids[j],ids[i]]
  }
  return cases.flatMap(([id,...texts], i) => texts.map((text,j) => ({
    ref:'codex:' + ids[i*3+j], text, source:'codex', kind:'message', line:ids[i*3+j],
  })))
}

for (let seed=0;seed<permutations;seed++) {
  const records = recordsFor(seed)
  const { positions, relations } = buildAtlas(records, new Map(), inferRelations(records), { includeLexical: true })
  const baseline = buildAtlas(records,new Map(),[]).positions
  const weights = new Map(relations.map(edge => [[edge.source,edge.target].sort().join('|'),edge.weight]))
  const affinity = (anchor,ref) => weights.get([anchor,ref].sort().join('|')) ?? 0
  const order = (points,a,b,c) => angularDistance(points.get(a),points.get(b)) < angularDistance(points.get(a),points.get(c))
  for (let i=0;i<cases.length;i++) {
    const [a,b,c] = records.slice(i*3,i*3+3).map(record=>record.ref)
    const positive = affinity(a,b)
    const distractor = affinity(a,c)
    summary.lexicalOrder += Number(positive > distractor)
    summary.sphereOrder += Number(order(positions,a,b,c))
    summary.layoutWithoutRelations += Number(order(baseline,a,b,c))
    if (!seed) console.log(cases[i][0],positive.toFixed(3),distractor.toFixed(3),order(positions,a,b,c)?'near':'miss')
  }
}
console.log(JSON.stringify(summary))
