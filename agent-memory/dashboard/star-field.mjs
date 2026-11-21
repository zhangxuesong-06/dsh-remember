import { randomFrom } from './graph-data.mjs'
import { angularDistance, glowAtAngle, sphereRadius } from './sphere.mjs'

const neighborhood = 42
const offsets = [-1, 0, 1]
const cellKey = (x, y, z) => `${x},${y},${z}`

export function buildStarField(records, overview) {
  const unique = new Map(overview.map(([ref, source, position]) => [ref, { ref, source, position }]))
  for (const { ref, source, position } of records) unique.set(ref, { ref, source, position })
  const stars = [...unique.values()]
  const cells = new Map()
  for (const star of stars) {
    const cell = star.position.map(value => Math.floor(value / neighborhood))
    const key = cellKey(...cell)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(star)
  }

  // A cap with this chord radius covers this fraction of the sphere. Only actual
  // concentrations above that baseline gain brighter halos as the data grows.
  const baseline = (stars.length - 1) * (neighborhood / (2 * sphereRadius)) ** 2
  for (const star of stars) {
    const [x, y, z] = star.position
    const [i, j, k] = star.position.map(value => Math.floor(value / neighborhood))
    let count = -1
    for (const dx of offsets) for (const dy of offsets) for (const dz of offsets) {
      const nearby = cells.get(cellKey(i + dx, j + dy, k + dz))
      if (!nearby) continue
      for (const { position: [a, b, c] } of nearby) {
        if ((a - x) ** 2 + (b - y) ** 2 + (c - z) ** 2 <= neighborhood ** 2) count++
      }
    }
    star.density = Math.max(0, Math.min(1, (count - baseline) / Math.max(4, baseline * 1.6)))
    star.spark = randomFrom(star.ref)()
  }
  return stars
}

export function starEmphasis(star, { selected, center, ranks, neighbors }) {
  if (star.ref === selected) return 1.4
  const rank = ranks.get(star.ref)
  if (rank !== undefined) {
    const distance = center ? angularDistance(center, star.position) : 0
    return (.20 + .74 * glowAtAngle(distance)) * (.68 + .32 / (1 + rank * .28))
  }
  return neighbors.has(star.ref) ? .21 : 0
}

export const starVertexShader = /* glsl */ `
  uniform float pixelRatio;
  uniform float ambient;
  attribute float spark;
  attribute float density;
  attribute float emphasis;
  varying vec3 starColor;
  varying vec3 haloColor;
  varying float intensity;
  varying float halo;

  void main() {
    vec4 viewPoint = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPoint;
    float facing = dot(normalize(position), normalize(cameraPosition - position));
    float front = smoothstep(-0.40, 0.88, facing);
    float zoom = clamp(pow(760.0 / max(1.0, -viewPoint.z), 0.37), 0.64, 1.72);
    float pin = smoothstep(1.0, 1.4, emphasis);
    float bright = pow(spark, 4.0);
    float region = density * front;
    float size = mix(2.45, 6.5, front) + bright * front * 3.3 + region * 4.6;
    gl_PointSize = pixelRatio * (size * zoom + emphasis * 9.0 + pin * 8.0);
    starColor = mix(vec3(0.63, 0.74, 0.94), color, mix(0.06, 0.57, front) + min(emphasis, 1.0) * 0.18);
    starColor = mix(starColor, vec3(0.92, 0.95, 1.0), pin * 0.90);
    haloColor = mix(starColor, color, 0.69);
    intensity = (mix(0.22, 1.0, front) * (0.68 + 0.27 * bright + 0.14 * region)) * ambient;
    intensity = max(intensity, min(1.0, emphasis + 0.17) * mix(0.46, 1.0, front) * smoothstep(0.0, 0.21, emphasis));
    halo = (0.10 + region * 0.23 + bright * front * 0.16 + emphasis * 0.27) * intensity;
  }
`

export const starFragmentShader = /* glsl */ `
  varying vec3 starColor;
  varying vec3 haloColor;
  varying float intensity;
  varying float halo;

  void main() {
    float distance = length(gl_PointCoord * 2.0 - 1.0);
    float core = exp(-distance * distance * 31.0) * intensity;
    float glow = exp(-distance * distance * 5.6) * halo * (1.0 - smoothstep(0.73, 1.0, distance));
    float light = max(core + glow, 0.0001);
    gl_FragColor = vec4((starColor * core + haloColor * glow) / light, min(light, 1.0));
    #include <colorspace_fragment>
  }
`
