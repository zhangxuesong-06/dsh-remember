// 检索：按「像不像 + 多近 + 多重 + 提过几次」排序。
//
// 这不是数据库查询，是在模拟「什么会忽然浮上来」：
//   · BM25 —— 字面上有多像（线索命中）
//   · 衰减 —— 多久没提起了（但有地板，老事不是搜不到，只是要更强的线索）
//   · 显著度 / 情绪 —— 越重的事越难忘，而且衰减得更慢（闪光灯记忆）
//   · 复述 —— 被想起过的事更容易再被想起（提取练习）
//   · 去重 —— 同一段里不要连着捞五条，那样只是把那段原文贴一遍

import { tokenize } from './tokenize.mjs'

const K1 = 1.25
const B = 0.72

// ——— 时间：一个函数，三条路径共用 ———
//
// 形状是幂律，不是指数。单一半衰的意思是「每天掉一样的比例」，
// 于是「今天 vs 三天前」和「三个月 vs 四个月」掉得一样多 —— 跟人的感觉正好相反。
// 幂律自带这个不对称：近期陡、远期平；老事不会归零，只是要更强的线索才浮得上来。
// （Wixted & Ebbesen 1991：保持量的曲线是 power function，不是 exponential。）
//
// 三个参数进 config：
//   t0    「拐点」（天）：比它近的还几乎不动，比它远的开始明显掉
//   alpha 尾巴厚度：越大掉得越快
//   floor 地板：只用来拖住「归零」，不是拿来当排序主力的
//
// salience/情绪把时间轴整体拉长（stretch）——重的事烂得慢，像闪光灯记忆。
// 这一项以前**只有兜底路径有、召回主路径没有**，于是「你特意记下的重事，
// 在主路径上和一句『嗯嗯』烂得一样快」。现在三条路径共用这一个函数。
export function recencyOf(ageDays, salience = 0, emotion = 0, params = {}) {
  // 这三个默认值和 config.mjs 的 DEFAULT_CFG.recency 必须是同一组数，
  // 不然「没传参数」的调用会悄悄用一组早就过期的值 —— 这正是上一版
  // 主路径和兜底路径各写一份算法、最后谁也不知道实际在用哪种的翻版。
  const t0 = Math.max(0.01, Number(params.t0 ?? 0.25))
  const alpha = Math.max(0, Number(params.alpha ?? 0.8))
  const floor = Math.min(0.95, Math.max(0, Number(params.floor ?? 0.03)))
  const a = Math.max(0, Number(ageDays) || 0)
  const stretch = 1 + 2 * (salience || 0) + 1.5 * (emotion || 0)
  return floor + (1 - floor) * Math.pow(1 + a / (t0 * stretch), -alpha)
}

export function search(ledger, query, opts = {}) {
  const {
    limit = 8,
    now = Date.now(),
    includeActs = true,
    episode = null,
    minScore = 0.01,
    recency: recParams = {},
  } = opts

  const q = String(query || '')
  const terms = [...new Set(tokenize(q))].slice(0, 48)
  if (!terms.length && episode === null) return []

  const N = ledger.docs.length || 1
  const avgdl = ledger.totalLen / N || 1
  const scores = new Map() // docId -> {bm25, hit}

  for (const t of terms) {
    const arr = ledger.postings.get(t)
    if (!arr) continue
    const df = arr.length / 2
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < arr.length; i += 2) {
      const id = arr[i]
      const tf = arr[i + 1]
      const dl = ledger.docLen[id] || 1
      const part = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl)))
      const cur = scores.get(id) || { bm25: 0, hit: 0 }
      cur.bm25 += part
      cur.hit += 1
      scores.set(id, cur)
    }
  }

  const cands = []
  for (const [id, s] of scores) {
    const d = ledger.docs[id]
    if (!d) continue
    if (!includeActs && d.who === 'act') continue
    if (d.who !== 'he' && d.who !== 'me' && d.who !== 'act') continue
    if (episode !== null) {
      const e = ledger.episodeAt(id)
      if (!e || e.id !== episode) continue
    }

    const ep = ledger.episodeAt(id)
    const salience = ep ? ep.salience : 0
    const emotion = ep ? ep.emotion : 0
    const rehearsals = ep ? ep.rehearsals : 0

    const ageDays = Math.max(0, (now - (d.ts || now)) / 86400000)
    const recency = recencyOf(ageDays, salience, emotion, recParams)
    const rehearse = 1 + 0.18 * Math.log(1 + rehearsals)
    const whoBoost = d.who === 'act' ? 0.35 : 1

    // 原句里真的出现了这段字（四个字以上才算）
    let phrase = 1
    if (q.length >= 4 && d.text.includes(q.slice(0, Math.min(q.length, 24)))) phrase = 1.5

    const score = s.bm25 * recency * rehearse * whoBoost * (1 + 0.6 * salience) * (1 + 0.4 * emotion) * phrase
    if (score < minScore) continue
    cands.push({ id, score, bm25: s.bm25, recency, salience, emotion, ep: ep ? ep.id : null, who: d.who, ts: d.ts })
  }

  cands.sort((a, b) => b.score - a.score)

  // 同一段最多出两条：人是「想起那件事」，不是「背下那一段」
  const perEp = new Map()
  const picked = []
  for (const c of cands) {
    const k = c.ep === null ? 'x' + c.id : 'e' + c.ep
    const n = perEp.get(k) || 0
    if (n >= 2) continue
    perEp.set(k, n + 1)
    picked.push(c)
    if (picked.length >= limit) break
  }
  return picked
}

// 预激活：只给「有事」这个感觉，不给内容。
// 类似你听见一个词，忽然觉得「这事以前聊过」，但还没想起来是什么。
//
// 宁可不浮，也别乱浮：一个字撞上就冒出来，那是噪声，不是记忆。
// 所以按「段」聚合，而且要求至少两个字都对上。
export function priming(ledger, cue, opts = {}) {
  const { max = 3, now = Date.now(), excludeSid = null } = opts
  const recParams = opts.recency || {}
  // 0.2.13：分数不到不浮；已经提过的段不浮
  const minScore = Number(opts.minScore ?? 0)
  const minIdf = Number(opts.minIdf ?? 0)
  const maxDf = Number(opts.maxDf ?? 0)   // 只认「不那么常见的词」当证据：今天/这个 这种不算
  const excludeIds = opts.excludeIds || null
  const terms = [...new Set(tokenize(cue))]
  // 只有一个词时，过去一律不浮；0.2.13 起允许——但那个词必须是「不常见」的（df ≤ maxDf），
  // 否则「你好」这种两个字就能把所有旧事翻出来。
  if (terms.length < 2) {
    const only = terms[0]
    const a0 = only ? ledger.postings.get(only) : null
    if (!a0 || !maxDf || a0.length / 2 > maxDf) return []
  }

  const N = ledger.docs.length || 1
  const acc = new Map() // epId -> { score, terms:Set }
  for (const t of terms) {
    const arr = ledger.postings.get(t)
    if (!arr) continue
    const df = arr.length / 2
    if (maxDf && df > maxDf) continue   // 「今天/这个」这种遍地都是的词，不当证据
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < arr.length; i += 2) {
      const d = ledger.docs[arr[i]]
      if (!d || d.who === 'act') continue
      const ep = ledger.episodeAt(arr[i])
      if (!ep) continue
      let e = acc.get(ep.id)
      if (!e) { e = { score: 0, terms: new Set(), maxIdf: 0 }; acc.set(ep.id, e) }
      e.score += idf * Math.min(arr[i + 1], 3)
      if (idf > e.maxIdf) e.maxIdf = idf
      e.terms.add(t)
    }
  }

  const need = terms.length >= 3 ? 2 : 1
  const freshCut = now - 20 * 60 * 1000
  const recentIds = new Set(
    [...ledger.episodes].sort((a, b) => b.endTs - a.endTs).slice(0, 2).map((e) => e.id),
  )

  const out = []
  for (const [epId, e] of acc) {
    if (e.terms.size < need) continue
    const ep = ledger.episodes[epId]
    if (!ep) continue
    if (ep.endTs >= freshCut || recentIds.has(ep.id)) continue
    // 已经提过的段：不再浮（0.2.13 去重闸）
    if (excludeIds && excludeIds.has(ep.id)) continue
    // **正在说的这场对话不算「忽然想起」**——它本来就在眼前。
    // 不排掉的话，聊到一半它会对自己刚刚说过的话「忽然浮起来」。
    if (excludeSid && ep.sid === excludeSid) continue
    const ageDays = Math.max(0, (now - ep.endTs) / 86400000)
    // 段级用 endTs：一段从「开始聊」到「最后一句」可能跨好几个小时，
    // 用 endTs 算「多久没提起」，比用 startTs 更贴近人说的「上次」。
    const recency = recencyOf(ageDays, ep.salience, ep.emotion, recParams)
    const score = e.score * recency * (1 + ep.salience)
    if (score < minScore) continue
    // 「今天/这个/一下」这类常见词不能当证据：至少要有一个中频以上的词对上
    if (minIdf && (e.maxIdf || 0) < minIdf) continue
    out.push({ ep, score })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

// 唤醒一段：按原文给，不做总结。
//
// 顺序永远是时间顺序——这一点很重要。人回忆一件事的时候，记得住「先说了什么、
// 然后我去干了什么、干完又说了什么」。把它按相关度重排，就变成了资料片。
export function episodeText(ledger, epId, opts = {}) {
  const { maxChars = 2200, focus = '', from = 'head' } = opts
  const ep = ledger.episodes[epId]
  if (!ep) return null

  const items = []
  let run = []
  let actCount = 0
  const flush = () => {
    if (!run.length) return
    const groups = []
    for (const n of run) {
      const last = groups[groups.length - 1]
      if (last && last.name === n) last.n += 1
      else groups.push({ name: n, n: 1 })
    }
    items.push({ kind: 'act', text: groups.map((g) => (g.n > 1 ? `${g.name}×${g.n}` : g.name)).join(' → ') })
    run = []
  }

  for (let i = ep.from; i <= ep.to; i++) {
    const d = ledger.docs[i]
    if (!d) continue
    if (d.who === 'act') {
      // 查到的内容留在索引里供检索，但摆出来的时候只算「动手」——
      // 不然一段里会被「我调了 X / 查到 Y」重复算两遍。
      if (d.type === 'tool/result') continue
      run.push(d.tool || '动手')
      actCount += 1
      continue
    }
    if (d.who !== 'he' && d.who !== 'me') continue
    flush()
    items.push({ kind: 'say', who: d.who, id: i, ts: d.ts, text: ledger.fullText(i) })
  }

  flush()

  const says = items.filter((x) => x.kind === 'say').length

  // 0.2.13.7 · 去掉「纪要腔」（用户 2026-10-31 定的第①条）：
  // 以前每条写成 `**他**：…` / `**我**：…`，原话是真的，可读起来像**第三方给你念会议纪要**。
  // 现在用「你/我」+ 时间打头，谁说的仍然清楚，但不再是旁人的口吻。
  const clockOfTs = (ts) => {
    const d = new Date(Number(ts) || 0)
    if (!Number.isFinite(d.getTime()) || !ts) return ''
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

  const rendered = items.map((it) => {
    if (it.kind === 'act') return { line: `　（我动手：${it.text}）`, say: false, text: it.text }
    const who = it.who === 'he' ? '你说的' : '我说的'
    const raw = String(it.text || '').replace(/\s+$/, '')
    // 保头保尾：语气通常在结尾，可开头那句才是「这件事从哪起」
    // full=true 时不截：认领「要全文」的那一声请求。
    const body = (opts.full || raw.length <= 300) ? raw : raw.slice(0, 210) + '……' + raw.slice(-70)
    const at = clockOfTs(it.ts)
    return { line: `${at ? `〔${at}〕` : ''}${who}：${body.replace(/\n+/g, ' / ')}`, say: true, text: it.text }
  })

  const takeHead = (arr, budget) => {
    const out = []
    let used = 0
    let shown = 0
    for (const r of arr) {
      if (used + r.line.length > budget) { out.push('……（后面还有，先说到这）'); break }
      out.push(r.line)
      used += r.line.length
      if (r.say) shown += 1
    }
    return { out, shown }
  }

  const takeTail = (arr, budget) => {
    const out = []
    let used = 0
    let shown = 0
    for (let i = arr.length - 1; i >= 0; i--) {
      const r = arr[i]
      if (used + r.line.length > budget) { out.unshift('……（前面还有，先说这些）'); break }
      out.unshift(r.line)
      used += r.line.length
      if (r.say) shown += 1
    }
    return { out, shown }
  }

  // 按线索回忆的时候，不从头放——那等于把整段倒一遍，真正相关的那几句被挤到后面还看不见。
  // 人也不是从头背的：先想起最贴切的那一下，再往前一点、往后一点。
  let startAt = 0
  let bestEnd = rendered.length
  if (focus) {
    const terms = new Set(tokenize(focus))
    let best = 0
    let bestScore = 0
    rendered.forEach((r, idx) => {
      if (!r.say) return
      let n = 0
      for (const t of tokenize(r.text)) if (terms.has(t)) n += 1
      if (n > bestScore) { bestScore = n; best = idx }
    })
    if (bestScore > 0) {
      startAt = Math.max(0, best - 3)
      bestEnd = Math.min(rendered.length, best + 4)
    }
  }

  let out
  let shown
  if (startAt > 0) {
    // 命中点前后各放几行：只放往后，会变成「半句话」；只放往前，等于没找到重点
    const slice = rendered.slice(startAt, Math.min(rendered.length, bestEnd))
    const r = takeHead(slice, maxChars)
    out = r.out
    shown = r.shown
    const skipped = rendered.slice(0, startAt).filter((x) => x.say).length
    if (skipped > 0) out.unshift(`（前面还有 ${skipped} 句，没展开）`)
    const after = rendered.slice(Math.min(rendered.length, bestEnd)).filter((x) => x.say).length
    if (after > 0 && !out[out.length - 1].startsWith('……')) out.push(`（后面还有 ${after} 句，没展开）`)
  } else if (from === 'tail') {
    const r = takeTail(rendered, maxChars)
    out = r.out
    shown = r.shown
  } else {
    const r = takeHead(rendered, maxChars)
    out = r.out
    shown = r.shown
  }

  return { ep, text: out.join('\n\n'), shown, total: says, acts: actCount }
}

// ——— 按字查：「这句话到底在不在这条线上」 ———
//
// 和 search 的分工，一句话：search 回答「有没有像的」，这里回答「有没有这句」。
// 混用会出事——拿相似度去回答「他说过这句话吗」，就是在用「像」冒充「是」。
//
// 判据只有一条：**一字不差**（空格、零宽字符不算字）。
// 查不到就是查不到，不返回「最像的几条」——给了台阶，就会顺着台阶滑下去。
const ZERO = /[\s\u200b-\u200d\ufeff]+/g
const QUOTE_ANY = /[「」『』“”"'‘’]/g
const QUOTE_EDGE = /^[「『“"'（(【\[]+|[」』”"'）)】\]]+$/g

function normTrace(s, dropQuotes = false) {
  let t = String(s || '').replace(ZERO, '')
  if (dropQuotes) t = t.replace(QUOTE_ANY, '')
  return t
}

// 长贴文（一整段、好几行）不该整段去撞：拆成句子，从最长的往下试。
function probes(raw) {
  const whole = String(raw || '').trim()
  const parts = whole.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const c of [whole, ...parts]
    .map((s) => s.replace(QUOTE_EDGE, '').trim())
    .filter((s) => s.length >= 3)
    .sort((a, b) => b.length - a.length)) {
    if (!out.some((x) => normTrace(x) === normTrace(c))) out.push(c)
  }
  return out.slice(0, 5)
}

export function traceHits(ledger, raw) {
  const scan = (needle, dropQuotes) => {
    const q = normTrace(needle, dropQuotes)
    if (q.length < 3) return []
    const hits = []
    for (let i = 0; i < ledger.docs.length; i++) {
      const d = ledger.docs[i]
      if (!d || !d.text) continue
      const full = ledger.fullText(i)   // 超过索引长度的会回读原文
      if (!full || !normTrace(full, dropQuotes).includes(q)) continue
      hits.push({ id: i, d, text: full })
    }
    return hits
  }

  // 一条记录是不是「有人说过的话」。
  // 这一条很要命：我上次验证「他说过你说好送我笔记本吗」，翻出来的全是我
  // 自己打出去的命令（`node cli.mjs recall ... "你说好送我笔记本"`）——
  // 那是**手上的操作**，不是谁说的话。把它算成「说过」，就会得出完全相反的结论。
  let corpus = null
  const meCorpus = () => {
    if (corpus === null) {
      corpus = ledger.docs
        .filter((d) => d && d.who === 'me')
        .map((d) => normTrace(d.text))
        .join('\u0000')
    }
    return corpus
  }
  // 「他说的」也可能是他转发我的原话（他会把我的回答贴回来让我看）。
  // 判据保守：长消息 + 中间三段 40 字都能在我自己说过的话里找到 → 当转发处理。
  const looksForwarded = (h) => {
    if (h.d.who !== 'he') return false
    const t = normTrace(h.text)
    if (t.length < 120) return false
    const [a, b, c] = [0.3, 0.5, 0.7].map((p) => t.slice(Math.floor(t.length * p) - 20, Math.floor(t.length * p) + 20))
    if (!a || !b || !c || a.length < 30 || b.length < 30 || c.length < 30) return false
    const src = meCorpus()
    if (!src) return false
    return src.includes(a) && src.includes(b) && src.includes(c)
  }

  const tag = (hits) => {
    for (const h of hits) {
      h.speech = h.d.who === 'he' || h.d.who === 'me'
      h.forwarded = h.speech && looksForwarded(h)
    }
    return hits
  }

  for (const p of probes(raw)) {
    const hits = scan(p, false)
    if (hits.length) return { mode: 'exact', used: p, hits: tag(hits) }
  }
  // 原样没对上，去掉引号再试一次。对上了也要如实说：正文一致，标点不是当时的。
  for (const p of probes(raw)) {
    const hits = scan(p, true)
    if (hits.length) return { mode: 'loose', used: p, hits: tag(hits) }
  }
  return { mode: null, used: null, hits: [] }
}
