import { buildGraph, randomFrom, sources } from './graph-data.mjs'
import { angularDistance, arcDirection, direction, glowAtAngle, orbitPoint, sphereRadius as R } from './sphere.mjs'

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
  for (let index = 0; index < 560; index += 1) {
    const x = random() * width
    const y = random() * height
    const size = .25 + random() ** 6 * 1.4
    ctx.globalAlpha = .10 + random() * .52
    ctx.fillStyle = index % 6 === 0 ? '#b6a8ed' : '#a5c0e7'
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fill()
  }
}

function createPointLayer(graph, host, select) {
  const dot = document.createElement('canvas')
  dot.width = dot.height = 24
  const ctx = dot.getContext('2d')
  const glow = ctx.createRadialGradient(12,12,0,12,12,12)
  glow.addColorStop(0,'#fff')
  glow.addColorStop(.38,'#fff')
  glow.addColorStop(1,'#ffffff00')
  ctx.fillStyle = glow
  ctx.fillRect(0,0,24,24)
  const material = new three.PointsMaterial({
    size:5, sizeAttenuation:false, map:new three.CanvasTexture(dot),
    transparent:true, opacity:.64, depthWrite:false, vertexColors:true,
  })
  const cloud = new three.Points(new three.BufferGeometry(),material)
  cloud.visible = false
  // Detail meshes use the engine's hit testing; the point layer is tested only on a click.
  cloud.raycast = () => {}
  graph.scene().add(cloud)
  let rows = []
  let pickable = []
  const tmp = new three.Vector3()

  graph.onBackgroundClick(event => {
    if (!pickable.length) return
    const rect = host.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    let closest
    let distance = 36
    let depth = 1
    const camera = graph.camera()
    for (const [ref,,position] of pickable) {
      tmp.set(...position).project(camera)
      if (tmp.z < -1 || tmp.z > 1) continue
      const dx = (tmp.x+1)*rect.width/2 - x
      const dy = (1-tmp.y)*rect.height/2 - y
      const squared = dx*dx + dy*dy
      if (squared < distance || (squared === distance && tmp.z < depth)) {
        closest = ref
        distance = squared
        depth = tmp.z
      }
    }
    if (closest) select(closest)
  })

  function update(byRef) {
    pickable = rows.filter(([ref])=>!byRef.has(ref))
    const positions = new Float32Array(pickable.length * 3)
    const colors = new Float32Array(positions.length)
    const color = new three.Color()
    let colorIndex = 0
    for (const [,source,coords] of pickable) {
      const i = colorIndex
      positions.set(coords,i)
      color.set(sources[source].color).toArray(colors,i)
      colorIndex += 3
    }
    const geometry = new three.BufferGeometry()
      .setAttribute('position',new three.BufferAttribute(positions,3))
      .setAttribute('color',new three.BufferAttribute(colors,3))
    cloud.geometry.dispose()
    cloud.geometry = geometry
    cloud.visible = Boolean(pickable.length)
  }
  return {
    update,
    set(points, byRef) { rows = points; update(byRef) },
    dim(focused) { material.opacity = focused ? .24 : .64 },
  }
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
  let matches = null
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
    .nodeLabel(() => '')
    .linkLabel(() => '')
    .nodeRelSize(2.82)
    .nodeOpacity(.98)
    .nodeResolution(12)
    .linkThreeObject(makeArc)
    .linkPositionUpdate(() => true)
    .cooldownTicks(0)
    .showPointerCursor(false)
    .onNodeHover(node => showHover(node?.id))
    .onNodeClick(node => select(node.id))

  const renderer = graph.renderer()
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const pointLayer = createPointLayer(graph,host,selectLightPoint)
  const controls = graph.controls()
  controls.minDistance = R + 65
  controls.maxDistance = 4700
  controls.enablePan = false

  function makeArc(edge) {
    const points = Array.from({ length: 21 }, (_,i) => new three.Vector3(...arcDirection(edge.start,edge.end,i/20).map(value => value * (R+1.5))))
    return new three.Line(new three.BufferGeometry().setFromPoints(points),
      new three.LineBasicMaterial({ color: edge.kind === 'reference' ? '#eacd94' : '#b1a5ff', transparent:true, opacity:.55 }))
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
    hovered = byRef.has(ref) ? ref : null
    host.classList.toggle('over-node', Boolean(hovered))
    syncRotation()
  }

  controls.addEventListener('start', () => {
    stopFlight()
    dragging = true
    host.classList.add('is-dragging')
    syncRotation()
  })
  controls.addEventListener('end', () => {
    dragging = false
    host.classList.remove('is-dragging')
    pauseFor(3500)
  })
  host.addEventListener('pointerleave', () => showHover(null))
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
    const dock = document.querySelector('.dock')
    const inset = matchMedia('(max-width: 760px)').matches ? 0 : 2 * (dock.offsetWidth + 38)
    const fit = Math.max(220, Math.min(host.clientHeight,host.clientWidth - inset))
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
    pointLayer.dim(Boolean(matches || selected))
    const center = byRef.get(selected)?.record.position
    const brightness = node => !matches ? 1 : matches.has(node.id)
      ? center ? glowAtAngle(angularDistance(center, node.record.position)) : .8 : .14
    graph.nodeVal(node => node.id === selected ? 14 : 1.35 + (matches?.has(node.id) ? 4 * brightness(node) : 0))
      .nodeColor(node => new three.Color(sources[node.record.source].color).multiplyScalar(brightness(node)).getStyle())
      .linkVisibility(edge => {
        const source = edge.source?.id ?? edge.source
        const target = edge.target?.id ?? edge.target
        return linksEnabled && (!selected || source === selected || target === selected)
      })
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
    setRecords(records, relations, hitRefs = null) {
      matches = hitRefs ? new Set(hitRefs) : null
      const data = buildGraph(records, relations)
      byRef = new Map(data.nodes.map(node => [node.id, node]))
      graph.graphData(data)
      pointLayer.update(byRef)
      style()
      showHover(hovered)
    },
    setOverviewPoints(points) { pointLayer.set(points,byRef) },
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
