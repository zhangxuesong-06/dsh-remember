import { sources } from './graph-data.mjs'
import { createGraph } from './graph-view.mjs'

const $ = id => document.getElementById(id)
const roles = { user: '用户', assistant: '助手', action: '工具', meta: '派生记录' }
const kinds = { message: '对话', tool: '工具', artifact: '产物', decision: '决定', finding: '发现', todo: '待办', data: '数据', note: '笔记', episode: '会话摘要' }
const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const pageSize = 8
const pages = { results: 0, saved: 0 }
let tab = 'results'
let filters = new URLSearchParams()
let requestId = 0
let detailId = 0
let selected
let detail
let graph
try { graph = await createGraph($('graph'), $('marker'), $('rotation'), select) }
catch (error) { console.error('记忆星图初始化失败', error) }
const points = new Map()
let overviewRevision
let pendingGalaxy
let loadedMode
let activeHighlights = []
let semanticEnabled = false
const fullMap = $('full-map')
fullMap.checked = new URLSearchParams(location.search).get('all') !== '0'

for (const [id, source] of Object.entries(sources)) {
  $('source').append(new Option(source.label, id))
  const item = element('span', source.label)
  item.dataset.source = id
  $('legend').append(item)
}
for (const id of ['zoom-in', 'zoom-out', 'reset', 'rotation', 'links', 'full-map', 'focus']) $(id).disabled = !graph

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function message(id, text) {
  $(id).textContent = text || ''
  $(id).hidden = !text
}

async function api(route, options) {
  const res = await fetch(route, options)
  const payload = await res.json()
  if (!res.ok) throw new Error(payload.error || '请求失败')
  return payload
}

function save(ref, saved, revision) {
  return api('/api/favorites', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Memory-Dashboard': '1' },
    body: JSON.stringify({ ref, saved, revision }),
  })
}

function recordClass(record) {
  return [sources[record.source]?.label, record.source === 'dsh' && record.workspace, roles[record.who] || kinds[record.kind] || record.kind]
    .filter(Boolean).join(' · ')
}

function recordItem(record) {
  const li = element('li')
  const option = element('button', undefined, 'record')
  option.type = 'button'
  option.dataset.ref = record.ref
  option.setAttribute('aria-pressed', String(record.ref === selected))
  const top = element('span', undefined, 'record-top')
  const source = element('span', recordClass(record), 'record-source')
  source.dataset.source = record.source
  top.append(source, element('span', dateLabel(record.ts)))
  option.append(top, element('span', record.preview, 'preview'), element('span', record.ref, 'reference'))
  option.addEventListener('click', () => select(record.ref))
  li.append(option)
  return li
}

function unavailableItem(ref) {
  const li = element('li', undefined, 'unavailable')
  const button = element('button', '移除收藏')
  button.type = 'button'
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      await save(ref, false)
      await refresh()
    } catch (error) {
      message('message', error.message)
      button.disabled = false
    }
  })
  li.append(element('span', '原记录发生变化或无法读取 · ' + ref), button)
  return li
}

function dateLabel(ts) {
  return ts && Number.isFinite(new Date(ts).getTime()) ? date.format(ts) : ''
}

function showPoints() {
  graph?.setPoints([...points.values()])
  $('scene-count').textContent = (fullMap.checked ? '全量 · ' : '360 点视图 · ') + points.size + ' 颗记忆星点'
  message('map-message', points.size ? '' : '暂无可显示的记忆。')
}

function loadGalaxy() {
  if (!graph) {
    $('scene-count').hidden = true
    message('map-message', '当前浏览器无法加载三维视图，仍可以检索和管理记忆。')
    return
  }
  const mode = fullMap.checked ? 'all' : '360'
  if (pendingGalaxy?.mode === mode) return pendingGalaxy.request
  const load = { mode }
  pendingGalaxy = load
  load.request = api('/api/atlas/points?view=' + mode).then(snapshot => {
    if (pendingGalaxy !== load || (snapshot.revision === overviewRevision && loadedMode === mode)) return
    loadedMode = mode
    points.clear()
    for (const point of snapshot.points) points.set(point[0], point)
    overviewRevision = snapshot.revision
    showPoints()
    if (selected && points.has(selected)) focus(selected)
    else graph.reset(false)
  }).catch(error => {
    if (pendingGalaxy === load) message('map-message', error.message)
  }).finally(() => { if (pendingGalaxy === load) pendingGalaxy = undefined })
  return load.request
}

async function readNeighborhood(params) {
  const route = '/api/atlas?' + params
  const snapshot = await api(route)
  if (!graph || snapshot.revision === overviewRevision) return snapshot
  await loadGalaxy()
  if (snapshot.revision === overviewRevision) return snapshot
  const latest = await api(route)
  return latest.revision === overviewRevision ? latest : null
}

function includeRecords(records) {
  if (!graph) return
  let changed = false
  for (const { ref, source, position } of records) {
    if (points.has(ref)) continue
    points.set(ref, [ref, source, position])
    changed = true
  }
  if (changed) showPoints()
}

async function includeHighlights() {
  if (!graph) return
  const highlights = activeHighlights
  const missing = highlights.filter(ref => !points.has(ref))
  const batches = [missing.slice(0, 50), missing.slice(50, 100)].filter(batch => batch.length)
  const additions = await Promise.all(batches.map(batch => {
    const refs = new URLSearchParams({ neighbors: '0' })
    for (const ref of batch) refs.append('ref', ref)
    return readNeighborhood(refs)
  }))
  if (highlights !== activeHighlights) return
  includeRecords(additions.filter(addition => addition?.revision === overviewRevision).flatMap(addition => addition.records))
}

function render(data) {
  const query = filters.get('q')
  const inResults = tab === 'results'
  $('results-label').textContent = query ? '搜索结果' : '近期记忆'
  $('items').replaceChildren(
    ...data.records.map(recordItem),
    ...data.unavailable.map(unavailableItem),
  )
  if (!$('items').childElementCount) {
    const text = inResults ? (query ? '没有匹配的记忆。' : '这个来源还没有可浏览的记忆。') : '打开一条记忆即可收藏。'
    $('items').append(element('li', text, 'empty'))
  }
  $('count').textContent = data.atRecallLimit ? '前 ' + data.total + ' 条' : data.total + ' 条'
  const pageCount = Math.max(1, Math.ceil(data.total / pageSize))
  $('pages').hidden = pageCount <= 1
  $('previous').disabled = !pages[tab]
  $('next').disabled = pages[tab] + 1 >= pageCount
  $('page').textContent = (pages[tab] + 1) + ' / ' + pageCount
  $('demo-label').hidden = !data.demo
  semanticEnabled = data.semanticEnabled

  activeHighlights = inResults ? data.highlights ?? [] : []
  graph?.highlights(activeHighlights)
}

async function refresh({ first = false } = {}) {
  const request = ++requestId
  const priorDetail = detailId
  const current = tab
  const params = current === 'saved' ? new URLSearchParams({ favorites: '1' }) : new URLSearchParams(filters)
  params.set('limit', pageSize)
  if (current === 'results' && params.get('q')) params.set('highlights', '1')
  params.set('offset', pages[current] * pageSize)
  message('message', '')
  $('refresh').disabled = true
  try {
    const data = await api('/api/records?' + params)
    if (request !== requestId) return
    const maxPage = Math.max(0, Math.ceil(data.total / pageSize) - 1)
    if (pages[current] > maxPage) {
      pages[current] = maxPage
      await refresh({ first })
      return
    }
    render(data)
    if (graph && (params.get('tools') === '1' || !fullMap.checked)) await includeHighlights()
    if (request !== requestId) return
    if (first && priorDetail === detailId && data.records.length) select(data.records[0].ref, data.mode === 'recall')
  } catch (error) {
    if (request === requestId) message('message', error.message)
  } finally {
    if (request === requestId) $('refresh').disabled = false
  }
}

function focus(ref, wide) {
  graph?.focus(ref, wide)
  const box = $('graph').getBoundingClientRect()
  if (graph && matchMedia('(max-width: 760px)').matches && (box.top + box.height / 2 < 0 || box.top + box.height / 2 > innerHeight)) {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    $('graph').scrollIntoView({ block: 'center', behavior })
  }
}

function renderRelated(ref, relations, records) {
  const index = new Map(records.map(record => [record.ref, record]))
  $('related').hidden = !relations.length
  $('related-items').replaceChildren(...relations.map(edge => {
    const other = edge.source === ref ? edge.target : edge.source
    const label = edge.kind === 'reference' ? edge.source === ref ? '引用原话' : '被引用' : '同一轮次'
    const button = element('button', undefined, 'relation')
    button.type = 'button'
    button.append(element('span', label + ' · ' + other), element('span', index.get(other)?.preview || other, 'preview'))
    button.addEventListener('click', () => select(other))
    const item = element('li')
    item.append(button)
    return item
  }))
}

function closeDetail() {
  detailId += 1
  detail = undefined
  selected = undefined
  $('details').hidden = true
  for (const button of $('items').querySelectorAll('[aria-pressed]')) button.setAttribute('aria-pressed', 'false')
  graph?.reset()
}

function showRecord(record) {
  detail = record
  $('detail-source').textContent = recordClass(record)
  $('original').textContent = record.text
  $('original').scrollTop = 0
  $('favorite').textContent = record.saved ? '取消收藏' : '收藏'
  $('favorite').disabled = false
  $('copy').disabled = false
  const fields = [
    ['引用', record.ref], ['会话', record.sid], ['时间', dateLabel(record.ts)],
    ['轮次', record.turnID ?? record.turn], ['工具', record.tool],
  ]
  $('metadata').replaceChildren(...fields.flatMap(([label, value]) => value != null && value !== ''
    ? [element('dt', label), element('dd', value)] : []))
}

async function select(ref, wide = false) {
  const request = ++detailId
  selected = ref
  detail = undefined
  for (const button of $('items').querySelectorAll('[data-ref]')) {
    button.setAttribute('aria-pressed', String(button.dataset.ref === ref))
  }
  $('details').hidden = false
  $('detail-source').textContent = ref
  $('original').textContent = ''
  $('metadata').replaceChildren()
  $('favorite').disabled = true
  $('copy').disabled = true
  message('detail-message', '正在读取原话…')
  $('details').parentElement.scrollTop = 0
  renderRelated(ref, [], [])
  $('semantic').hidden = true
  message('semantic-status', '')
  $('semantic-items').replaceChildren()
  graph?.neighbors([])
  if (points.has(ref)) focus(ref, wide)
  const params = new URLSearchParams({ ref })
  const original = api('/api/record?' + params).then(data => {
    if (request !== detailId) return
    showRecord(data)
    message('detail-message', '')
  }).catch(error => {
    if (request === detailId) message('detail-message', error.message)
  })
  const neighborhood = readNeighborhood(params).then(snapshot => {
    if (request !== detailId || !snapshot || graph && snapshot.revision !== overviewRevision) return
    includeRecords(snapshot.records)
    if (!snapshot.records.some(record => record.ref === ref)) return
    graph?.neighbors(snapshot.relations)
    renderRelated(ref, snapshot.relations, snapshot.records)
    if (graph && points.has(ref)) focus(ref, wide)
  }).catch(error => {
    if (request === detailId) message('message', '证据关系加载失败 · ' + error.message)
  })
  if (semanticEnabled) {
    message('semantic-status', '正在计算语义近邻…')
    $('semantic').hidden = false
  }
  const semantic = semanticEnabled && api('/api/atlas/semantic?' + params).then(async snapshot => {
    if (request !== detailId) return
    if (snapshot.status === 'updating') {
      message('semantic-status', '账本有新记录。可重新打开此条记忆以检查语义近邻。')
      $('semantic').hidden = false
      return
    }
    await neighborhood
    if (request !== detailId) return
    const results = snapshot.status === 'ready' && (!graph || snapshot.revision === overviewRevision) ? snapshot.neighbors : []
    message('semantic-status', '')
    $('semantic').hidden = !results.length
    $('semantic-items').replaceChildren(...results.map(record => {
      const button = element('button', undefined, 'relation')
      button.type = 'button'
      button.append(element('span', `${record.ref} · 余弦 ${record.score.toFixed(2)}`), element('span', record.preview, 'preview'))
      button.addEventListener('click', () => select(record.ref))
      const item = element('li')
      item.append(button)
      return item
    }))
  }).catch(error => {
    if (request === detailId) message('semantic-status', error.message)
  })
  await Promise.all([original, neighborhood, semantic])
}

function setTab(next) {
  tab = next
  $('results-tab').setAttribute('aria-pressed', String(next === 'results'))
  $('saved-tab').setAttribute('aria-pressed', String(next === 'saved'))
}

$('results-tab').addEventListener('click', () => { setTab('results'); refresh() })
$('saved-tab').addEventListener('click', () => { setTab('saved'); refresh() })
$('search').addEventListener('submit', event => {
  event.preventDefault()
  setTab('results')
  const mode = $('mode').value
  const query = $('query').value
  filters = new URLSearchParams({ q: mode === 'trace' ? query : query.trim(), mode, source: $('source').value })
  if ($('tools').checked) filters.set('tools', '1')
  pages.results = 0
  closeDetail()
  activeHighlights = []
  graph?.highlights([])
  refresh({ first: Boolean(filters.get('q')) })
})
$('previous').addEventListener('click', () => { pages[tab] -= 1; refresh() })
$('next').addEventListener('click', () => { pages[tab] += 1; refresh() })
$('refresh').addEventListener('click', async () => {
  await Promise.all([refresh(), loadGalaxy()])
  if (selected) select(selected)
})
$('zoom-in').addEventListener('click', () => graph?.zoom(1.23))
$('zoom-out').addEventListener('click', () => graph?.zoom(1 / 1.23))
$('reset').addEventListener('click', () => { activeHighlights = []; graph?.highlights([]); closeDetail() })
fullMap.addEventListener('change', async () => {
  const priorDetail = detailId
  await loadGalaxy()
  try { await includeHighlights() } catch (error) { message('map-message', error.message) }
  if (priorDetail === detailId && selected) select(selected)
})
$('links').addEventListener('change', event => graph?.links(event.target.checked))
$('close-detail').addEventListener('click', closeDetail)
$('focus').addEventListener('click', () => { if (selected) focus(selected) })
$('favorite').addEventListener('click', async () => {
  const record = detail
  if (!record) return
  $('favorite').disabled = true
  try {
    record.saved = (await save(record.ref, !record.saved, record.revision)).saved
    if (detail === record) {
      $('favorite').textContent = record.saved ? '取消收藏' : '收藏'
      message('detail-message', record.saved ? '已收藏。' : '已取消收藏。')
    }
    if (tab === 'saved') await refresh()
  } catch (error) {
    if (detail === record) message('detail-message', error.message)
  } finally {
    if (detail === record) $('favorite').disabled = false
  }
})
$('copy').addEventListener('click', async () => {
  const record = detail
  if (!record) return
  try {
    await navigator.clipboard.writeText(record.ref)
    if (detail === record) message('detail-message', '引用已复制。')
  } catch {
    if (detail === record) message('detail-message', '剪贴板不可用，可以选中引用复制。')
  }
})
refresh()
loadGalaxy()
