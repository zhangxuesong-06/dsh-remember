import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { forceSimulation, forceLink, forceCollide, forceManyBody, forceRadial } from 'd3-force-3d'
import { tok } from '../../tools/mem-tokenize.mjs'
import { sha256 } from '../../tools/mem-journal.mjs'
import { randomFrom } from './graph-data.mjs'
import { direction, sphereRadius as R } from './sphere.mjs'

const version = 2
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function vectors(records) {
  const documents = records.map(record => tok(record.text.slice(0, 6400)))
  const df = new Map()
  for (const tokens of documents) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return documents.map(tokens => {
    const counts = new Map()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    const vector = [...counts].map(([token, count]) => [token, (1 + Math.log(count)) * (1 + Math.log((documents.length + 1) / (df.get(token) + 1)))])
    const norm = Math.sqrt(vector.reduce((sum, [, weight]) => sum + weight ** 2, 0)) || 1
    return new Map(vector.map(([token, weight]) => [token, weight / norm]))
  })
}

function textScore(a, b) {
  const shared = []
  let weight = 0
  for (const [token, x] of a) {
    const product = x * (b.get(token) ?? 0)
    if (product) {
      weight += product
      shared.push([token, product])
    }
  }
  shared.sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
  return { weight, terms: shared.slice(0, 3).map(([token]) => token) }
}

function turnKey(record) {
  const turn = record.turnID ?? record.turn
  return record.sid && (typeof turn === 'string' && turn !== '' || Number.isSafeInteger(turn))
    ? JSON.stringify([record.source, record.source === 'dsh' ? record.workspace : '', record.sid, turn]) : null
}

export function inferRelations(input) {
  const records = [...input].sort((a, b) => compare(a.ref, b.ref))
  const index = new Map(records.map(record => [record.ref, record]))
  const texts = vectors(records)
  const turns = records.map(turnKey)
  const evidence = new Map()
  const lexical = records.map(() => [])
  const key = (a, b) => JSON.stringify([a,b].sort(compare))
  for (let i = 0; i < records.length; i++) {
    const source = records[i].ref
    for (let j = i + 1; j < records.length; j++) {
      const target = records[j].ref
      if (turns[i] && turns[i] === turns[j]) {
        evidence.set(key(source, target), { source, target, kind: 'turn', weight: 1, evidence: [source, target] })
        continue
      }
      // Tool blobs produce noisy lexical coincidences, but explicit turn links above still apply.
      if (records[i].kind === 'tool' || records[j].kind === 'tool') continue
      const { weight, terms } = textScore(texts[i], texts[j])
      if (weight < .13 || (terms.length < 2 && weight < .3)) continue
      const differentDshWorkspace = records[i].source === 'dsh' && records[j].source === 'dsh'
        && records[i].workspace !== records[j].workspace
      const edge = { source, target, kind: 'lexical', weight: Math.min(.7, weight) * (differentDshWorkspace ? .45 : 1), terms }
      lexical[i].push(edge)
      lexical[j].push(edge)
    }
  }
  for (const record of records) {
    for (const ref of record.references ?? []) {
      if (ref === record.ref || !index.has(ref)) continue
      const edge = { source: record.ref, target: ref, kind: 'reference', weight: 1, evidence: [record.ref, ref] }
      evidence.set(key(record.ref, ref), edge)
    }
  }

  const selected = new Map(evidence)
  for (const neighbors of lexical) {
    neighbors.sort((a, b) => b.weight - a.weight || compare(a.source, b.source) || compare(a.target, b.target))
    for (const edge of neighbors.slice(0, 3)) {
      const pair = key(edge.source, edge.target)
      if (!selected.has(pair)) selected.set(pair, edge)
    }
  }
  return [...selected.values()]
}

function seededPoint(ref) {
  const random = randomFrom(sha256(ref))
  const angle = random() * Math.PI * 2
  const z = random() * 2 - 1
  const radial = Math.sqrt(1-z*z)
  return [R * radial * Math.cos(angle), R * radial * Math.sin(angle), R*z]
}

export function buildAtlas(records, previous = new Map(), relations = inferRelations(records), { includeLexical = false } = {}) {
  const linked = includeLexical ? relations : relations.filter(edge => edge.evidence)
  const neighbors = new Map()
  for (const edge of linked) {
    for (const [from,to] of [[edge.source,edge.target],[edge.target,edge.source]]) {
      if (!previous.has(to)) continue
      if (!neighbors.has(from) || edge.weight > neighbors.get(from).weight) neighbors.set(from, { to, weight: edge.weight })
    }
  }
  const nodes = [...records].sort((a,b) => compare(a.ref,b.ref)).map(record => {
    const fixed = previous.get(record.ref)
    const seed = seededPoint(record.ref)
    const near = previous.get(neighbors.get(record.ref)?.to)
    const [x,y,z] = fixed ?? (near ? direction(near.map((v,i) => v + .13 * seed[i])).map(v => v*R) : seed)
    return { id: record.ref, x, y, z, ...(fixed ? { fx:x, fy:y, fz:z } : {}) }
  })
  if (nodes.some(node => node.fx === undefined)) {
    const links = linked.map(edge => ({ ...edge }))
    const force = forceSimulation(nodes, 3).stop().alphaDecay(.04)
      .force('link', forceLink(links).id(node => node.id)
        .distance(edge => 44 + (1-edge.weight) * 141).strength(edge => edge.kind === 'lexical' ? edge.weight * .85 : .92))
      .force('space', forceManyBody().strength(-26))
      .force('collision', forceCollide(12))
      .force('surface', forceRadial(R,0,0,0).strength(.8))
    for (let i = 0; i < 96; i++) {
      force.tick()
      for (const node of nodes) {
        if (node.fx !== undefined) continue
        const [x,y,z] = direction([node.x,node.y,node.z]).map(value => value * R)
        Object.assign(node, { x,y,z })
      }
    }
  }
  return { positions: new Map(nodes.map(({ id,x,y,z }) => [id,[x,y,z]])), relations }
}

function readPositions(file) {
  if (!file) return new Map()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version === version && Array.isArray(data.positions)) {
      return new Map(data.positions.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string'
        && Array.isArray(entry[1]) && entry[1].length === 3 && entry[1].every(Number.isFinite)
        && Math.abs(Math.hypot(...entry[1]) - R) < 1e-5))
    }
  } catch {}
  return new Map()
}

function persist(file, positions) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify({ version, positions: [...positions] }), { flag: 'wx' })
    fs.renameSync(temp, file)
  } catch {
    // A read-only home can still view the atlas and keep positions during this process.
    try { fs.rmSync(temp, { force: true }) } catch {}
  }
}

function positionKey(record) {
  return sha256(JSON.stringify([
    record.ref, record.store, record.sid, record.turnID, record.turn, record.id, record.ts, record.text, record.evidenceIds, record.requestSeq,
  ]))
}

function placeOverview(records, fixed) {
  const centers = new Map()
  for (const record of records) {
    const key = turnKey(record)
    if (key && fixed.has(record.ref) && !centers.has(key)) centers.set(key, fixed.get(record.ref))
  }
  const positions = new Map(fixed)
  for (const record of records) {
    if (fixed.has(record.ref)) continue
    const seed = seededPoint(record.ref)
    const key = turnKey(record)
    const reference = record.references?.find(ref => fixed.has(ref))
    const center = fixed.get(reference) ?? (key ? centers.get(key) ?? seededPoint(key) : null)
    positions.set(record.ref, center ? direction(center.map((value,i) => value + .18 * seed[i])).map(value => value * R) : seed)
  }
  // A newly included summary can also use a source point that was added in this pass.
  for (const record of records) {
    if (fixed.has(record.ref) || turnKey(record)) continue
    const ref = record.references?.find(value => positions.has(value))
    if (!ref || ref === record.ref) continue
    const seed = seededPoint(record.ref)
    positions.set(record.ref,direction(positions.get(ref).map((value,i) => value + .15 * seed[i])).map(value => value * R))
  }
  return positions
}

export function createAtlasStore(file) {
  const saved = readPositions(file)
  let lastKey
  let last
  function known(keys) {
    return new Map(keys.flatMap(([ref,hash]) => saved.has(hash) ? [[ref,saved.get(hash)]] : []))
  }
  function save(keys, positions, pinned) {
    if (pinned.size === keys.length) return
    for (const [ref,hash] of keys) {
      if (!pinned.has(ref)) saved.set(hash,positions.get(ref))
    }
    if (file) persist(file,saved)
  }
  return {
    reserveOverview(records) {
      const keys = records.map(record => [record.ref,positionKey(record)])
      const pinned = known(keys)
      const positions = placeOverview(records,pinned)
      save(keys,positions,pinned)
      return positions
    },
    snapshot(records) {
      const keys = records.map(record => [record.ref,positionKey(record)])
      const key = JSON.stringify(records.map((record,i) => [keys[i],record.references]))
      if (key === lastKey) return last
      const previous = known(keys)
      last = buildAtlas(records, previous)
      lastKey = key
      save(keys,last.positions,previous)
      return last
    },
  }
}
