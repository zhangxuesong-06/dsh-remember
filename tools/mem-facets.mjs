// mem-facets —— 从原文算 facet 标签，再统计成一张只读地图。
//
// 为什么不是树：一条记忆通常同时属于好几个主题，树只能挂一个枝。
// 所以这里用「多标签 facet」，地图是**从标签现算出来的视图**，删了不影响任何数据。
//
// 三层 facet：
//   domain  用途：build / research / study / chat
//   kind    性质：decision / error / plan / question / conclusion / note
//   entity  实体：文本里出现的技术词（英文标识符、反引号里的词）

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'not', 'you', 'are', 'was', 'were',
  'has', 'have', 'but', 'can', 'will', 'use', 'using', 'used', 'one', 'two', 'all', 'any',
  'out', 'get', 'set', 'new', 'old', 'src', 'lib', 'md', 'js', 'ts', 'py', 'json', 'yaml',
  'txt', 'true', 'false', 'null', 'undefined', 'function', 'return', 'const', 'let', 'var',
  'import', 'export', 'default', 'class', 'async', 'await', 'http', 'https', 'www', 'com',
  'org', 'github', 'com', 'then', 'than', 'when', 'what', 'which', 'how', 'why', 'who',
  'there', 'their', 'about', 'into', 'over', 'under', 'more', 'most', 'some', 'such',
  'only', 'also', 'just', 'like', 'make', 'made', 'need', 'want', 'here', 'where', 'very',
])

const DOMAIN = [
  ['build', /(代码|编译|报错|部署|配置|依赖|函数|接口|调试|安装|仓库|分支|提交|脚本|环境变量|端口|docker|git|npm|pip|python|node|异常|堆栈|插件|工具)/i],
  ['research', /(论文|文献|实验|假设|思路|研究|验证|综述|方法|结论|对比|基线|复现|数据集|arxiv|消融|评测)/i],
  ['study', /(复习|背|考试|知识点|搞懂|理解|笔记|练习|题目|错题|记忆曲线|回顾)/i],
]

const KIND = [
  ['decision', /(决定|就用|改成|换成|否掉|采用|定了|选了|结论是|不再|放弃|保留|定在)/],
  ['error', /(报错|失败|踩坑|崩|错误|挂了|不行|不通|异常|坏)/],
  ['plan', /(打算|下一步|待办|计划|准备|要做|接下来|还没做|TODO)/i],
  ['question', /(为什么|怎么|是不是|能不能|要不要|吗[?？]?$|[?？]$)/],
  ['conclusion', /(结论|所以|因此|说明|证明|本质|根因|关键在)/],
]

const LATIN = /[a-zA-Z][a-zA-Z0-9_.\-]{2,}/g
const QUOTED = /[`「『]([^`」』]{2,24})[`」』]/g

export function domainOf(text) {
  const s = String(text || '')
  for (const [name, re] of DOMAIN) if (re.test(s)) return name
  return 'chat'
}

export function kindsOf(text) {
  const s = String(text || '')
  const out = []
  for (const [name, re] of KIND) if (re.test(s)) out.push(name)
  return out.length ? out : ['note']
}

export function entitiesOf(text, vocab = []) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(QUOTED)) {
    const t = m[1].trim().toLowerCase()
    if (t.length >= 2) out.add(t)
  }
  for (const m of s.matchAll(LATIN)) {
    const t = m[0].toLowerCase().replace(/[.\-]+$/, '')
    if (t.length < 3 || STOP.has(t)) continue
    if (/^\d+$/.test(t)) continue
    out.add(t)
  }
  // 中文实体：正则认不出来，靠词表。
  // 词表由模型维护（alias 里的词会自动进来），代码只负责匹配——
  // 这样热路径上依然零模型调用，但「标定」「底盘」这些能被认出来。
  const lower = s.toLowerCase()
  for (const w of vocab) {
    if (!w || w.length < 2) continue
    if (lower.includes(w)) out.add(w)
  }
  return [...out].slice(0, 24)
}

export function facetsOf(text, vocab = []) {
  return { domain: domainOf(text), kinds: kindsOf(text), entities: entitiesOf(text, vocab) }
}

// ——— scope：`build/docker` 或 `domain=build,kind=error` ———
export function parseScope(scope) {
  const s = String(scope || '').trim()
  if (!s) return null
  const f = {}
  if (s.includes('=')) {
    for (const part of s.split(/[,，]/)) {
      const [k, v] = part.split('=').map((x) => x && x.trim())
      if (!k || !v) continue
      if (k === 'domain' || k === 'kind' || k === 'entity') f[k] = v.toLowerCase()
    }
  } else {
    const [a, b] = s.split('/').map((x) => x && x.trim())
    if (a) f.domain = a.toLowerCase()
    if (b) f.entity = b.toLowerCase()
  }
  return Object.keys(f).length ? f : null
}

export function matchScope(facets, filter) {
  if (!filter) return true
  if (filter.domain && facets.domain !== filter.domain) return false
  if (filter.kind && !facets.kinds.includes(filter.kind)) return false
  if (filter.entity && !facets.entities.includes(filter.entity)) return false
  return true
}

// ——— 地图：从 facet 统计出来，只读 ———
export function buildMap(docs, { minDocs = 2, maxEntities = 8, vocab = [] } = {}) {
  const byDomain = new Map()
  for (const d of docs) {
    const f = d.facets || facetsOf(d.text, vocab)
    let g = byDomain.get(f.domain)
    if (!g) { g = { count: 0, entities: new Map(), kinds: new Map(), recent: [] }; byDomain.set(f.domain, g) }
    g.count += 1
    for (const e of f.entities) g.entities.set(e, (g.entities.get(e) || 0) + 1)
    for (const k of f.kinds) g.kinds.set(k, (g.kinds.get(k) || 0) + 1)
    g.recent.push(d)
    if (g.recent.length > 3) g.recent.shift()
  }

  const lines = []
  const total = docs.length
  lines.push(`# 记忆地图 · ${total} 条\n`)
  const order = ['build', 'research', 'study', 'chat']
  const domains = [...byDomain.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  for (const dm of domains) {
    const g = byDomain.get(dm)
    lines.push(`## ${dm} (${g.count})`)
    const ents = [...g.entities.entries()].filter(([, n]) => n >= minDocs).sort((a, b) => b[1] - a[1]).slice(0, maxEntities)
    if (ents.length) lines.push('实体：' + ents.map(([e, n]) => `${e} ${n}`).join(' · '))
    const ks = [...g.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    if (ks.length) lines.push('性质：' + ks.map(([k, n]) => `${k} ${n}`).join(' · '))
    const recent = g.recent.slice(-2).map((d) => `#${d.seq} ${String(d.text).replace(/\s+/g, ' ').slice(0, 40)}`)
    if (recent.length) lines.push('最近：' + recent.join(' | '))
    lines.push('')
  }
  lines.push('用法：recall(query, scope="build/docker") 缩小范围。')
  return lines.join('\n')
}

// ——— 别名：模型可以维护的那部分 ———
// 它同时是中文实体词表：代码不会分词，但认得你给过的词。
export function vocabFromAliases(aliases) {
  const out = new Set()
  for (const [k, v] of Object.entries(aliases || {})) {
    if (k) out.add(String(k).toLowerCase())
    for (const x of (Array.isArray(v) ? v : [])) if (x) out.add(String(x).toLowerCase())
  }
  return [...out]
}

export function expandQuery(query, aliases) {
  const q = String(query || '')
  if (!aliases) return { extra: [], hit: [] }
  const extra = new Set()
  const hit = []
  const lower = q.toLowerCase()
  for (const [key, vals] of Object.entries(aliases)) {
    const group = [key, ...(Array.isArray(vals) ? vals : [])].map((x) => String(x).toLowerCase())
    const found = group.some((w) => w && lower.includes(w))
    if (!found) continue
    hit.push(key)
    for (const w of group) if (!lower.includes(w)) extra.add(w)
  }
  return { extra: [...extra], hit }
}
