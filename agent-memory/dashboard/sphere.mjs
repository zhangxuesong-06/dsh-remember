export const sphereRadius = 300
const zero = [0, 0, 1]

export function direction(point) {
  const length = Math.hypot(...point)
  return length ? point.map(value => value / length) : [...zero]
}

export function dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
}

export function angularDistance(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(direction(a), direction(b)))))
}

export function arcDirection(start, end, t) {
  const a = direction(start)
  const b = direction(end)
  if (t <= 0) return a
  if (t >= 1) return b
  const cosine = Math.max(-1, Math.min(1, dot(a, b)))
  let tangent = b.map((value, index) => value - a[index] * cosine)
  if (Math.hypot(...tangent) < 1e-10) {
    if (cosine > 0) return a
    const axis = Math.abs(a[0]) < .8 ? [1,0,0] : [0,1,0]
    tangent = axis.map((value, index) => value - a[index] * dot(a, axis))
  }
  const angle = Math.acos(cosine) * t
  const perpendicular = direction(tangent)
  return direction(a.map((value, index) => value * Math.cos(angle) + perpendicular[index] * Math.sin(angle)))
}

export function orbitPoint(start, target, distance, t) {
  const fromDistance = Math.max(sphereRadius + 1, Math.hypot(...start))
  const radius = fromDistance + (Math.max(distance, sphereRadius + 1) - fromDistance) * t
  return arcDirection(start, target, t).map(component => (component || 0) * radius)
}

export function glowAtAngle(angle) {
  const falloff = Math.max(0, 1 - angle / 1.15)
  return .25 + .75 * falloff ** 1.5
}

// Use actual hits as centers. A broad query can have several independent regions.
export function clusterHits(refs, positions) {
  const groups = []
  for (const ref of refs) {
    const position = positions.get(ref)
    if (!position) continue
    const group = groups.find(cluster => angularDistance(position, positions.get(cluster.center)) <= .66)
    if (group) group.refs.push(ref)
    else groups.push({ center: ref, refs: [ref] })
  }
  const order = new Map(refs.map((ref, i) => [ref,i]))
  const score = ref => 1 / (1 + order.get(ref) * .42)
  const strength = group => group.refs.reduce((sum, ref) => sum + score(ref), 0)
  for (const group of groups) {
    const distance = a => group.refs.reduce((sum,b) => sum + angularDistance(positions.get(a),positions.get(b))*score(b),0)
    group.center = group.refs.reduce((best,ref) => distance(ref) < distance(best) ? ref : best)
  }
  return groups.sort((a,b) => strength(b)-strength(a))
}
