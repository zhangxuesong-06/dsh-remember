import createGraph from 'ngraph.graph'
import forceLayout from 'ngraph.forcelayout'
import { pointDistance, randomFrom } from './graph-data.mjs'

export const galaxyRadius = 360
const compare = (a, b) => a < b ? -1 : Number(a > b)

function turnKey(record) {
  const turn = record.turnID ?? record.turn
  if (!record.sid || !(typeof turn === 'string' && turn !== '' || Number.isSafeInteger(turn))) return null
  return JSON.stringify([record.store ?? [record.source, record.workspace], record.sid, turn])
}

export function indexRelations(input) {
  const records = [...input].sort((a, b) => compare(a.ref, b.ref))
  const byRef = new Map(records.map(record => [record.ref, record]))
  const turns = new Map()
  const turnByRef = new Map()
  const citations = new Map()
  const layoutEdges = []

  for (const record of records) {
    const key = turnKey(record)
    if (key) {
      if (!turns.has(key)) turns.set(key, [])
      const members = turns.get(key)
      if (members.length) layoutEdges.push([members[0], record.ref])
      members.push(record.ref)
      turnByRef.set(record.ref, members)
    }
    for (const target of new Set(record.references)) {
      if (target === record.ref || !byRef.has(target)) continue
      const edge = { source: record.ref, target, kind: 'reference', evidence: [record.ref, target] }
      layoutEdges.push(edge.evidence)
      for (const ref of edge.evidence) {
        if (!citations.has(ref)) citations.set(ref, [])
        citations.get(ref).push(edge)
      }
    }
  }

  return {
    layoutEdges,
    around(ref) {
      const edges = citations.get(ref) ?? []
      const sameTurn = (turnByRef.get(ref) ?? []).filter(other => other !== ref).map(other => {
        const evidence = [ref, other].sort(compare)
        return { source: evidence[0], target: evidence[1], kind: 'turn', evidence }
      })
      return [...edges, ...sameTurn]
    },
  }
}

function offset(random) {
  const z = random() * 2 - 1
  const angle = random() * Math.PI * 2
  const radial = Math.sqrt(1 - z * z)
  const distance = Math.cbrt(random())
  return [Math.cos(angle) * radial * distance, Math.sin(angle) * radial * distance, z * distance]
}

function regionCenter(ref, radius, occupied) {
  const random = randomFrom(ref)
  let best
  let clearance = -Infinity
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const point = offset(random).map((value, axis) => value * galaxyRadius * [1, .67, .86][axis])
    let gap = Infinity
    for (const region of occupied) {
      gap = Math.min(gap, pointDistance(point, region.center) - radius - region.radius)
      if (gap <= clearance) break
    }
    if (gap >= 8) return point
    if (gap > clearance) {
      clearance = gap
      best = point
    }
  }
  return best
}

// The same ngraph physics engine used by Code Galaxies through ngraph.offline.layout.
// Keep floating-point positions in memory for the dashboard's existing JSON API.
export function buildAtlas(records, edges) {
  const graph = createGraph()
  for (const ref of records.map(record => record.ref).sort(compare)) graph.addNode(ref)
  for (const [from, to] of edges) {
    if (!graph.hasNode(from) || !graph.hasNode(to)) continue
    if (!graph.hasLink(from, to) && !graph.hasLink(to, from)) graph.addLink(from, to)
  }

  const components = []
  const visited = new Set()
  graph.forEachNode(({ id }) => {
    if (visited.has(id)) return
    const members = [id]
    visited.add(id)
    for (let index = 0; index < members.length; index += 1) {
      graph.forEachLinkedNode(members[index], neighbor => {
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id)
          members.push(neighbor.id)
        }
      })
    }
    components.push(members.sort(compare))
  })
  components.sort((a, b) => b.length - a.length || compare(a[0], b[0]))

  const positions = new Map()
  const occupied = []
  for (const members of components) {
    const radius = members.length === 1 ? 0 : Math.min(105, 4.4 * Math.cbrt(members.length) + 4)
    const center = regionCenter(members[0], radius, occupied)
    if (!radius) {
      positions.set(members[0], center)
      continue
    }
    occupied.push({ center, radius })
    const component = createGraph()
    for (const ref of members) component.addNode(ref)
    for (const ref of members) {
      graph.forEachLinkedNode(ref, (neighbor, link) => {
        if (link.fromId === ref) component.addLink(ref, neighbor.id)
      }, true)
    }
    const layout = forceLayout(component, { dimensions: 3, springLength: 12 })
    const steps = members.length <= 12 ? 32 : 100
    for (let step = 0; step < steps; step += 1) layout.step()
    const local = members.map(ref => {
      const point = layout.getNodePosition(ref)
      return [point.x, point.y, point.z]
    })
    layout.dispose()
    const mean = [0, 1, 2].map(axis => local.reduce((sum, point) => sum + point[axis], 0) / local.length)
    const extent = local.reduce((max, point) => Math.max(max, pointDistance(point, mean)), 1)
    for (const [index, point] of local.entries()) {
      positions.set(members[index], point.map((value, axis) => center[axis] + (value - mean[axis]) * radius / extent))
    }
  }
  return positions
}
