import { buildGraph, randomFrom, sources } from './graph-data.mjs'
import { arcDirection, direction, orbitPoint, sphereRadius as R } from './sphere.mjs'
import { buildStarField, starEmphasis, starVertexShader, starFragmentShader } from './star-field.mjs'

const three = typeof window !== 'undefined' && window.ForceGraph3D
  ? await import('/vendor/three.module.js').catch(() => null) : null

function paintSky(canvas) {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return
  const ratio = Math.min(devicePixelRatio, 2)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  const random = randomFrom('quiet-sky')
  for (let index = 0; index < 128; index += 1) {
    const x = random() * width
    const y = random() * height
    const size = .25 + random() ** 6 * .62
    ctx.globalAlpha = .08 + random() * .28
    ctx.fillStyle = '#a5b4cf'
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fill()
  }
}

function createPointLayer(graph, host) {
  const uniforms = { ambient: { value: 1 }, pixelRatio: { value: graph.renderer().getPixelRatio() } }
  const material = new three.ShaderMaterial({
    uniforms, vertexShader: starVertexShader, fragmentShader: starFragmentShader,
    transparent: true, depthWrite: false, blending: three.AdditiveBlending, vertexColors: true,
  })
  const cloud = new three.Points(new three.BufferGeometry(), material)
  cloud.visible = false
  cloud.raycast = () => {}
  graph.scene().add(cloud)
  let stars = []
  const projected = new three.Vector3()
  const radial = new three.Vector3()

  function pick(event) {
    if (!stars.length) return null
    const rect = host.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const camera = graph.camera()
    const view = radial.copy(camera.position).normalize()
    const emphasis = cloud.geometry.getAttribute('emphasis')
    let closest = null
    let best = Infinity
    for (let i = 0; i < stars.length; i++) {
      const { ref, position } = stars[i]
      projected.set(...position).project(camera)
      if (Math.abs(projected.z) > 1) continue
      const dx = (projected.x + 1) * rect.width / 2 - x
      const dy = (1 - projected.y) * rect.height / 2 - y
      const squared = dx * dx + dy * dy
      const limit = 5 + 3 * emphasis.getX(i)
      if (squared > limit * limit) continue
      const facing = (position[0] * view.x + position[1] * view.y + position[2] * view.z) / R
      // Favor visible front stars when projections almost overlap.
      const rank = squared + 8 * (1 - facing)
      if (rank < best) {
        best = rank
        closest = ref
      }
    }
    return closest
  }

  function set(records, overview) {
    stars = buildStarField(records, overview)
    const positions = new Float32Array(stars.length * 3)
    const colors = new Float32Array(positions.length)
    const palette = Object.fromEntries(Object.entries(sources).map(([source, { color }]) => [source, new three.Color(color)]))
    stars.forEach(({ source, position }, i) => {
      positions.set(position, i * 3)
      palette[source].toArray(colors, i * 3)
    })
    const geometry = new three.BufferGeometry()
      .setAttribute('position', new three.BufferAttribute(positions, 3))
      .setAttribute('color', new three.BufferAttribute(colors, 3))
      .setAttribute('spark', new three.Float32BufferAttribute(stars.map(star => star.spark), 1))
      .setAttribute('density', new three.Float32BufferAttribute(stars.map(star => star.density), 1))
      .setAttribute('emphasis', new three.BufferAttribute(new Float32Array(stars.length), 1).setUsage(three.DynamicDrawUsage))
    cloud.geometry.dispose()
    cloud.geometry = geometry
    cloud.visible = Boolean(stars.length)
  }

  function style(focus) {
    uniforms.ambient.value = focus.selected || focus.ranks.size ? .32 : 1
    if (!stars.length) return
    const attribute = cloud.geometry.getAttribute('emphasis')
    stars.forEach((star, i) => attribute.setX(i, starEmphasis(star, focus)))
    attribute.needsUpdate = true
  }

  return { set, style, pick }
}

export function canAutoRotate({ enabled, hasRecords, selected, hovered, busy, hidden }) {
  return enabled && hasRecords && !selected && !hovered && !busy && !hidden
}

export function createGraph(host, background, marker, rotation, select, selectLightPoint) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const duration = () => reduced.matches ? 0 : 720
  function bootstrap() {
    paintSky(background)
  }
  new ResizeObserver(bootstrap).observe(background)
  if (!three || !window.ForceGraph3D) return null
  const contextProbe = document.createElement('canvas').getContext('webgl2')
  if (!contextProbe) return null
  contextProbe.getExtension('WEBGL_lose_context')?.loseContext()
  let graph
  try {
    graph = new window.ForceGraph3D(host, { controlType: 'orbit', rendererConfig: { antialias: true, alpha: true } })
  } catch {
    return null
  }

  let byRef = new Map()
  let selected = null
  let ranks = new Map()
  let records = []
  let overview = []
  let evidence = new Map()
  let drawnEdges
  let markerFrame = 0
  let flight = 0
  let linksEnabled = true

  let hovered = null
  let dragging = false
  let quietTimer
  let rotationOverride

  graph.backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .enableNodeDrag(false)
    .nodeVisibility(false)
    .cooldownTicks(0)
    .showPointerCursor(false)

  const renderer = graph.renderer()
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const pointLayer = createPointLayer(graph, host)
  const evidenceLayer = new three.Group()
  evidenceLayer.name = 'memory-evidence'
  graph.scene().add(evidenceLayer)
  graph.onBackgroundClick(event => {
    const ref = pointLayer.pick(event)
    if (ref) (byRef.has(ref) ? select : selectLightPoint)(ref)
  })
  const controls = graph.controls()
  controls.minDistance = R + 65
  controls.maxDistance = 4700
  controls.enablePan = false

  function makeArc(edge) {
    const points = Array.from({ length: 21 }, (_,i) => new three.Vector3(...arcDirection(edge.start,edge.end,i/20).map(value => value * (R+1.5))))
    const line = new three.Line(new three.BufferGeometry().setFromPoints(points),
      new three.LineBasicMaterial({ color: edge.kind === 'reference' ? '#eacd94' : '#a1b4df', transparent:true, opacity:.46, depthWrite:false }))
    line.raycast = () => {}
    return line
  }
  // OrbitControls expresses speed in rotations per minute.
  controls.autoRotateSpeed = .24

  function syncRotation() {
    const enabled = rotationOverride ?? !reduced.matches
    rotation.checked = enabled
    controls.autoRotate = canAutoRotate({
      enabled, hasRecords: byRef.size > 0, selected, hovered: Boolean(hovered),
      busy: dragging || flight !== 0 || quietTimer !== undefined, hidden: document.hidden,
    })
  }

  function pauseFor(ms) {
    clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      quietTimer = undefined
      syncRotation()
    }, ms)
    syncRotation()
  }

  function showHover(ref) {
    if (ref === hovered) return
    hovered = ref
    host.classList.toggle('over-node', Boolean(hovered))
    syncRotation()
  }

  controls.addEventListener('start', () => {
    stopFlight()
    dragging = true
    showHover(null)
    host.classList.add('is-dragging')
    syncRotation()
  })
  controls.addEventListener('end', () => {
    dragging = false
    host.classList.remove('is-dragging')
    pauseFor(3500)
  })
  let hoverFrame = 0
  let pointer
  host.addEventListener('pointermove', event => {
    if (dragging || event.pointerType === 'touch') return
    pointer = event
    if (hoverFrame) return
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0
      showHover(dragging ? null : pointLayer.pick(pointer))
    })
  })
  host.addEventListener('pointerleave', () => {
    cancelAnimationFrame(hoverFrame)
    hoverFrame = 0
    showHover(null)
  })
  rotation.addEventListener('change', () => {
    rotationOverride = rotation.checked
    syncRotation()
  })
  reduced.addEventListener('change', syncRotation)
  document.addEventListener('visibilitychange', syncRotation)
  syncRotation()

  function assignCamera(position) {
    const camera = graph.camera()
    camera.position.set(...position)
    controls.target.set(0,0,0)
    controls.update()
  }

  function stopFlight() {
    cancelAnimationFrame(flight)
    flight = 0
  }

  function orbitTo(target, distance, ms) {
    stopFlight()
    const from = graph.camera().position.toArray()
    if (!ms) {
      assignCamera(orbitPoint(from,target,distance,1))
      syncRotation()
      return
    }
    const start = performance.now()
    function frame(now) {
      const t = Math.max(0, Math.min(1, (now - start)/ms))
      assignCamera(orbitPoint(from,target,distance,t*t*(3-2*t)))
      flight = t < 1 ? requestAnimationFrame(frame) : 0
      if (!flight) syncRotation()
    }
    flight = requestAnimationFrame(frame)
    syncRotation()
  }

  function reset(ms = duration()) {
    const fit = Math.max(220, Math.min(host.clientHeight, host.clientWidth - 36))
    const distance = Math.min(4250, Math.max(825, 780 * host.clientHeight / fit))
    orbitTo([.08,.12,1],distance,ms)
  }

  function resize() {
    graph.width(Math.max(host.clientWidth, 1)).height(Math.max(host.clientHeight, 1))
    if (!selected && !flight) reset(0)
  }
  new ResizeObserver(resize).observe(host)
  resize()

  function style() {
    const center = byRef.get(selected)?.record.position
    const edges = evidence.get(selected)
    const neighbors = new Set(edges?.map(edge => edge.source === selected ? edge.target : edge.source))
    pointLayer.style({ selected, center, ranks, neighbors })
    const visible = linksEnabled ? edges : undefined
    if (visible === drawnEdges) return
    for (const line of evidenceLayer.children) {
      line.geometry.dispose()
      line.material.dispose()
    }
    evidenceLayer.clear()
    for (const edge of visible ?? []) evidenceLayer.add(makeArc(edge))
    drawnEdges = visible
  }

  function moveMarker() {
    markerFrame = 0
    const node = byRef.get(selected)
    if (!node) {
      marker.hidden = true
      return
    }
    const position = graph.graph2ScreenCoords(node.x, node.y, node.z)
    const camera = graph.camera()
    const facing = camera.position.dot(new three.Vector3(node.x,node.y,node.z)) > R * R
    const onScreen = facing && position.x > 15 && position.y > 15
      && position.x < host.clientWidth - 15 && position.y < host.clientHeight - 15
    marker.hidden = !onScreen
    if (onScreen) {
      marker.style.left = position.x + 'px'
      marker.style.top = position.y + 'px'
    }
    markerFrame = requestAnimationFrame(moveMarker)
  }

  return {
    setRecords(nextRecords, relations, hitRefs) {
      ranks = new Map((hitRefs ?? []).map((ref, i) => [ref, i]))
      records = nextRecords
      const data = buildGraph(records, relations)
      evidence = new Map()
      for (const edge of data.links) for (const ref of [edge.source, edge.target]) {
        if (!evidence.has(ref)) evidence.set(ref, [])
        evidence.get(ref).push(edge)
      }
      byRef = new Map(data.nodes.map(node => [node.id, node]))
      graph.graphData({ nodes: data.nodes, links: [] })
      pointLayer.set(records, overview)
      style()
      syncRotation()
    },
    setOverviewPoints(points) {
      overview = points
      pointLayer.set(records, overview)
      style()
    },
    focus(ref, wide = false) {
      const node = byRef.get(ref)
      if (!node) return
      selected = ref
      syncRotation()
      style()
      orbitTo(node.record.position, R + (wide ? 445 : 224), duration())
      marker.dataset.ref = ref
      if (!markerFrame) markerFrame = requestAnimationFrame(moveMarker)
    },
    reset() {
      selected = null
      marker.hidden = true
      delete marker.dataset.ref
      style()
      pauseFor(duration())
      reset()
    },
    zoom(factor) {
      pauseFor(3500)
      const position = graph.camera().position.toArray()
      const distance = Math.min(4700, Math.max(R+65,Math.hypot(...position)/factor))
      orbitTo(direction(position),distance,0)
    },
    links(visible) { linksEnabled = visible; style() },
  }
}
