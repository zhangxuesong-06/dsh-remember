import { sources } from './graph-data.mjs'
import { createGraph } from './graph-view.mjs'
import { clusterHits } from './sphere.mjs'

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
const graph = createGraph($('graph'), $('sky'), $('marker'), $('rotation'), select, selectLightPoint)
let overviewPoints = []
let overviewRequest = 0

for (const [id, source] of Object.entries(sources)) {
  $('source').append(new Option(source.label, id))
  const item = element('span', source.label)
  item.dataset.source = id
  $('legend').append(item)
}
for (const id of ['zoom-in', 'zoom-out', 'reset', 'rotation', 'links', 'focus', 'all-points']) $(id).disabled = !graph

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

let visible = new Map()
let relations = []

function updateSceneCount() {
  const additional = overviewPoints.filter(([ref]) => !visible.has(ref)).length
  $('scene-count').textContent = (visible.size + additional) + ' 颗记忆星点'
}

async function refreshOverview() {
  const request = ++overviewRequest
  if (!graph || !$('all-points').checked) {
    $('all-points').parentElement.title = ''
    overviewPoints = []
    graph?.setOverviewPoints(overviewPoints)
    updateSceneCount()
    return
  }
  $('all-points').parentElement.title = '正在加载全部记忆星点'
  try {
    const {points} = await api('/api/atlas/points')
    if (request !== overviewRequest) return
    overviewPoints = points
    graph.setOverviewPoints(points)
    updateSceneCount()
  } catch (error) {
    if (request !== overviewRequest) return
    $('all-points').checked = false
    await refreshOverview()
    message('message',error.message)
  } finally {
    if (request === overviewRequest || !$('all-points').checked) $('all-points').parentElement.title = ''
  }
}

function selectLightPoint(ref) {
  $('query').value = ref
  $('source').value = ''
  $('search').requestSubmit()
}

function render(data, atlas, first) {
  const query = filters.get('q')
  const inResults = tab === 'results'
  const recent = inResults && !query
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

  visible = new Map(atlas.records.map(record => [record.ref,record]))
  relations = atlas.relations
  const highlights = recent ? null : data.records.map(record => record.ref)
  const positions = new Map(atlas.records.map(record => [record.ref,record.position]))
  const groups = data.mode === 'recall' ? clusterHits(highlights ?? [], positions) : []
  graph?.setRecords(atlas.records, relations, highlights)
  updateSceneCount()
  $('basis').hidden = !visible.size
  message('map-message', !graph ? '当前浏览器无法加载三维视图，可以继续从右侧检索和管理。'
    : !visible.size ? '暂无可显示的记忆。' : '')
  $('clusters').hidden = groups.length <= 1
  $('clusters').replaceChildren(...groups.map((group, index) => {
    const btn = element('button', '星区 ' + (index+1) + ' · ' + group.refs.length + ' 条')
    btn.type = 'button'
    btn.title = visible.get(group.center)?.preview ?? ''
    btn.addEventListener('click', () => select(group.center, true))
    return btn
  }))
  if (first && (data.mode === 'recall' || data.total === 1) && data.records.length) {
    select(groups[0]?.center ?? data.records[0].ref, data.mode === 'recall')
  } else if (!visible.has(selected)) {
    selected = undefined
    closeDetail()
    graph?.reset()
  } else if (detail) {
    renderRelated(detail.ref)
  }
}

async function refresh({ first = false } = {}) {
  const request = ++requestId
  const current = tab
  const params = current === 'saved' ? new URLSearchParams({ favorites: '1' }) : new URLSearchParams(filters)
  params.set('limit', pageSize)
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
    const atlasParams = new URLSearchParams()
    for (const record of data.records) atlasParams.append('ref',record.ref)
    const atlas = await api('/api/atlas?' + atlasParams)
    if (request === requestId) render(data,atlas,first)
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

function renderRelated(ref) {
  const near = relations.filter(edge => edge.source === ref || edge.target === ref)
    .sort((a,b) => Number(Boolean(b.evidence)) - Number(Boolean(a.evidence)) || b.weight - a.weight)
    .slice(0,6)
  $('related').hidden = !near.length
  $('related-items').replaceChildren(...near.map(edge => {
    const other = edge.source === ref ? edge.target : edge.source
    const label = edge.kind === 'reference' ? edge.source === ref ? '引用原话' : '被引用'
      : edge.kind === 'turn' ? '同一轮次' : '词面相近'
    const button = element('button', undefined, 'relation')
    button.type = 'button'
    button.append(element('span', label + ' · ' + other), element('span', visible.get(other)?.preview || other, 'preview'))
    if (edge.terms?.length) button.title = '共同词片段 ' + edge.terms.join('、')
    button.addEventListener('click', () => select(other))
    const item = element('li')
    item.append(button)
    return item
  }))
}

function closeDetail() {
  detailId += 1
  detail = undefined
  $('details').hidden = true
}

function showRecord(record) {
  detail = record
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
  const record = visible.get(ref)
  if (!record) return
  const request = ++detailId
  selected = ref
  detail = undefined
  for (const button of $('items').querySelectorAll('[data-ref]')) {
    button.setAttribute('aria-pressed', String(button.dataset.ref === ref))
  }
  $('details').hidden = false
  $('detail-source').textContent = recordClass(record)
  $('original').textContent = ''
  $('metadata').replaceChildren()
  $('favorite').disabled = true
  $('copy').disabled = true
  message('detail-message', '正在读取原话…')
  $('details').parentElement.scrollTop = 0
  renderRelated(ref)
  focus(ref, wide)
  try {
    const data = await api('/api/record?' + new URLSearchParams({ ref }))
    if (request !== detailId) return
    showRecord(data)
    message('detail-message', '')
  } catch (error) {
    if (request === detailId) message('detail-message', error.message)
  }
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
  selected = undefined
  refresh({ first: Boolean(filters.get('q')) })
})
$('previous').addEventListener('click', () => { pages[tab] -= 1; refresh() })
$('next').addEventListener('click', () => { pages[tab] += 1; refresh() })
$('refresh').addEventListener('click', () => {
  refresh()
  if ($('all-points').checked) refreshOverview()
})
$('all-points').addEventListener('change', refreshOverview)
$('zoom-in').addEventListener('click', () => graph?.zoom(1.23))
$('zoom-out').addEventListener('click', () => graph?.zoom(1 / 1.23))
$('reset').addEventListener('click', () => graph?.reset())
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
if (graph && new URLSearchParams(location.search).get('all') === '1') {
  $('all-points').checked = true
  refreshOverview()
}
