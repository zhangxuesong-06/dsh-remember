import { canAutoRotate, randomFrom, sources, starEmphasis } from './graph-data.mjs'
import { starFragmentShader, starVertexShader } from './gaia-star-shaders.mjs'

export function createGraph(host, marker, rotation, choose) {
  if (!document.createElement('canvas').getContext('webgl2')) return null
  return initGraph(host, marker, rotation, choose)
}

async function initGraph(host, marker, rotation, choose) {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('/vendor/three.module.js'), import('/vendor/OrbitControls.js'),
  ])
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  host.append(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 2, 12000)
  camera.position.set(280, 180, 950)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.rotateSpeed = .58
  controls.zoomSpeed = .75
  controls.autoRotateSpeed = .20
  controls.minDistance = 30
  controls.maxDistance = 4500
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  rotation.checked = !reduced.matches
  reduced.addEventListener('change', ({ matches }) => { if (matches) rotation.checked = false })

  const material = new THREE.ShaderMaterial({
    vertexShader: starVertexShader, fragmentShader: starFragmentShader,
    uniforms: { viewport: { value: new THREE.Vector2(1, 1) } },
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, premultipliedAlpha: true, toneMapped: false,
  })
  const lineMaterial = new THREE.LineBasicMaterial({ color: '#8eabdf', transparent: true, opacity: .42, depthWrite: false })
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial)
  line.frustumCulled = false
  scene.add(line)
  const bounds = new THREE.Sphere()
  const skyCenter = new THREE.Vector3()
  const projected = new THREE.Vector3()
  const overviewDirection = new THREE.Vector3(.22, .36, 1).normalize()
  let stars = new Map()
  let cloud
  let selected
  let ranks = new Map()
  let related = []
  let linesEnabled = true
  let hovered
  let moving
  let start
  let interacting = false
  let lastInput = -Infinity
  let previousFrame

  function resize() {
    const { clientWidth: width, clientHeight: height } = host
    if (!width || !height) return
    renderer.setSize(width, height)
    material.uniforms.viewport.value.set(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)
  resize()

  function updateLines() {
    const coordinates = []
    const emitted = new Set()
    if (selected && linesEnabled) {
      for (const edge of related) {
        const other = edge.source === selected ? edge.target : edge.source
        if (!stars.has(other) || emitted.has(other)) continue
        emitted.add(other)
        coordinates.push(...stars.get(selected).position, ...stars.get(other).position)
      }
    }
    line.geometry.dispose()
    line.geometry = new THREE.BufferGeometry()
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3))
  }

  function restyle() {
    if (!cloud) return
    const emphasis = cloud.geometry.getAttribute('emphasis')
    const center = stars.get(selected)?.position ?? stars.get(ranks.keys().next().value)?.position
    const neighbors = new Set(related.map(edge => edge.source === selected ? edge.target : edge.source))
    for (const star of stars.values()) emphasis.setX(star.index, starEmphasis(star.ref, star.position, { selected, center, ranks, neighbors }))
    emphasis.needsUpdate = true
    updateLines()
  }

  function setPoints(points) {
    stars = new Map(points.map(([ref, source, position], index) => [ref, { ref, source, position, index, center: new THREE.Vector3(...position) }]))
    if (!stars.has(selected)) selected = undefined
    if (!stars.has(hovered)) setHover(undefined)
    if (cloud) {
      scene.remove(cloud)
      cloud.geometry.dispose()
    }
    const plane = new THREE.PlaneGeometry()
    const geometry = new THREE.InstancedBufferGeometry().copy(plane)
    plane.dispose()
    geometry.instanceCount = stars.size
    const positions = new Float32Array(stars.size * 3)
    const colors = new Float32Array(stars.size * 3)
    const sizes = new Float32Array(stars.size)
    const color = new THREE.Color()
    for (const star of stars.values()) {
      positions.set(star.position, star.index * 3)
      const random = randomFrom(star.ref)()
      sizes[star.index] = 3.2 + 7.3 * random ** 2.4 + (random > .988 ? 6 : 0)
      color.set(sources[star.source]?.color ?? '#b3c5e8').convertLinearToSRGB().toArray(colors, star.index * 3)
    }
    geometry.setAttribute('starPosition', new THREE.InstancedBufferAttribute(positions, 3))
    geometry.setAttribute('starColor', new THREE.InstancedBufferAttribute(colors, 3))
    geometry.setAttribute('starSize', new THREE.InstancedBufferAttribute(sizes, 1))
    geometry.setAttribute('emphasis', new THREE.InstancedBufferAttribute(new Float32Array(stars.size), 1))
    cloud = new THREE.Mesh(geometry, material)
    cloud.frustumCulled = false
    scene.add(cloud)
    restyle()
  }

  function moveCamera(target, destination, animate = true) {
    if (!animate || reduced.matches) {
      moving = undefined
      camera.position.copy(destination)
      controls.target.copy(target)
      controls.update()
      return
    }
    moving = {
      startTime: performance.now(), startPosition: camera.position.clone(), startTarget: controls.target.clone(),
      destination, target,
    }
  }

  function reset(animate = true) {
    selected = undefined
    related = []
    setHover(undefined)
    restyle()
    if (stars.size) {
      const box = new THREE.Box3()
      for (const star of stars.values()) box.expandByPoint(star.center)
      box.getBoundingSphere(bounds)
      skyCenter.copy(bounds.center)
      const halfFov = Math.atan(Math.tan(Math.PI / 8) * Math.min(camera.aspect, 1))
      let radius = 90
      for (const star of stars.values()) radius = Math.max(radius, star.center.distanceTo(skyCenter))
      const distance = radius / Math.sin(halfFov) * 1.12
      moveCamera(skyCenter.clone(), skyCenter.clone().addScaledVector(overviewDirection, distance), animate)
    }
  }

  function focus(ref, wide = false) {
    const star = stars.get(ref)
    if (!star) return
    const direction = camera.position.clone().sub(controls.target).normalize()
    selected = ref
    setHover(undefined)
    restyle()
    const distance = wide ? 270 : 105
    moveCamera(star.center, star.center.clone().addScaledVector(direction, distance))
  }

  function setHover(ref) {
    hovered = ref
    host.classList.toggle('over-node', Boolean(ref))
  }

  function pick(event) {
    const box = renderer.domElement.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    let bestDistance = 49
    let bestZ = Infinity
    let bestRef
    for (const star of stars.values()) {
      projected.copy(star.center).project(camera)
      if (projected.z < -1 || projected.z >= 1) continue
      const dx = (projected.x + 1) * box.width * .5 - x
      const dy = (1 - projected.y) * box.height * .5 - y
      const distance = dx * dx + dy * dy
      if (distance < bestDistance || distance === bestDistance && projected.z < bestZ) {
        bestDistance = distance
        bestZ = projected.z
        bestRef = star.ref
      }
    }
    return bestRef
  }

  controls.addEventListener('start', () => {
    interacting = true
    moving = undefined
  })
  controls.addEventListener('end', () => {
    interacting = false
    lastInput = performance.now()
    host.classList.remove('is-dragging')
  })
  renderer.domElement.addEventListener('pointerdown', event => {
    if (event.isPrimary && event.button === 0) start = [event.clientX, event.clientY]
    else start = undefined
  })
  renderer.domElement.addEventListener('pointermove', event => {
    if (start && Math.hypot(start[0] - event.clientX, start[1] - event.clientY) > 5) {
      start = undefined
      setHover(undefined)
      host.classList.add('is-dragging')
    }
    if (!moving && !interacting && event.pointerType === 'mouse') setHover(pick(event))
  })
  renderer.domElement.addEventListener('pointerup', event => {
    if (!event.isPrimary || event.button !== 0) return
    if (start && Math.hypot(start[0] - event.clientX, start[1] - event.clientY) <= 5) {
      const ref = pick(event)
      if (ref) choose(ref)
    }
    start = undefined
  })
  renderer.domElement.addEventListener('pointercancel', () => { start = undefined })
  renderer.domElement.addEventListener('pointerleave', () => setHover(undefined))

  renderer.setAnimationLoop(now => {
    const seconds = previousFrame === undefined ? 0 : Math.min(.05, (now - previousFrame) / 1000)
    previousFrame = now
    if (moving) {
      const t = Math.min(1, Math.max(0, (now - moving.startTime) / 580))
      const eased = t * t * (3 - 2 * t)
      camera.position.lerpVectors(moving.startPosition, moving.destination, eased)
      controls.target.lerpVectors(moving.startTarget, moving.target, eased)
      if (t === 1) moving = undefined
    }
    controls.autoRotate = canAutoRotate({
      enabled: rotation.checked && !reduced.matches, hasRecords: stars.size > 0, selected, hovered,
      busy: Boolean(moving) || interacting || now - lastInput < 1700, hidden: document.hidden,
    })
    controls.update(seconds)
    camera.updateMatrixWorld()
    const star = stars.get(selected)
    if (star) projected.copy(star.center).project(camera)
    marker.hidden = !star || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) >= 1
    if (!marker.hidden) {
      marker.style.left = `${(projected.x + 1) * host.clientWidth / 2}px`
      marker.style.top = `${(1 - projected.y) * host.clientHeight / 2}px`
    }
    renderer.render(scene, camera)
  })

  return {
    setPoints, focus, reset,
    highlights(refs) { ranks = new Map(refs.map((ref, i) => [ref, i])); restyle() },
    neighbors(edges) { related = edges; restyle() },
    links(enabled) { linesEnabled = enabled; updateLines() },
    zoom(factor) {
      const direction = camera.position.clone().sub(controls.target)
      const distance = THREE.MathUtils.clamp(direction.length() / factor, controls.minDistance, controls.maxDistance)
      moveCamera(controls.target.clone(), controls.target.clone().add(direction.setLength(distance)))
    },
  }
}
