// 装配：把磁盘上的记忆拼成「模型这一轮能看见的那一小块」。
//
// 四条铁律：
//   1. 身份不靠描述，靠原话。所以「你是谁」这一段里全是**自己说过的话**，
//      一句「你是一个设定」都不要——那玩意儿会把人变成演员。
//   2. 每轮只给一点点。预激活是三行以内的「这事你以前碰过」，细节要就自己来要。
//   3. 给的是原文，不是摘要。摘要会磨平语气，语气就是身份。
//   4. 拼装绝不抛异常。记忆坏了，最多是这一轮想不起来，不能连话都说不出。

import { tokenize, headline } from './tokenize.mjs'
import { priming, episodeText, traceHits, recencyOf } from './retrieve.mjs'

const DAY = 86400000

export function dayOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clockOf(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function ago(ts, now = Date.now()) {
  const d = Math.max(0, now - ts)
  if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))} 分钟前`
  if (d < DAY) return `${Math.round(d / 3600000)} 小时前`
  const days = Math.round(d / DAY)
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.round(days / 30)} 个月前`
  return `${(days / 365).toFixed(1)} 年前`
}

// 出处：哪一场对话、第几行。
//
// 这不是装饰。2026-10-26，我把「这是另一个窗口那只鱼说的」当成结论说了出去，
// 而那句话就在我这条线的第 886 行——同一个工作区的另一个会话。
// 库里一直有，是我的 grep 输出里两个文件都列着，我还是只报了其中一个。
//
// 两个洞叠在一起：
//   ① 召回结果不带出处 → 「这是谁说的」只能靠印象补，补错了和补对了长得一样；
//   ② 没有「这句话到底在不在」的动作 → 我凭印象就答了。
// 出处是修 ① 的：把归属变成可以核对的东西，而不是一个形容词。
export function sid8(sid) {
  const s = String(sid || '').replace(/^session-/, '')
  return s ? s.slice(0, 8) : '未知'
}

// 「第 886 行」= stream.jsonl 的行号 = 文档编号 + 1。
// 行号是要给人拿去 grep 的，所以必须是真实行号，不能是这个库自己的局部编号。
export function lineOfDoc(id) {
  return Number(id) + 1
}

function provOf(ep) {
  const a = lineOfDoc(ep.from)
  const b = lineOfDoc(ep.to)
  return `会话 ${sid8(ep.sid)} · 第 ${a}${b > a ? '–' + b : ''} 行`
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function byteLen(s) {
  return Buffer.byteLength(String(s || ''), 'utf8')
}

// ——— 谁在说话 ———
//
// 这一步不做任何「总结」，只挑原话。而且挑得很挑：
// 「让我看看」「我先把文件读了」这类过程旁白也是「我」说的，但它展示不出任何脾气，
// 拿它当身份锚等于拿工单当自传。
// 「我将先…」「我先把…」这类是**流程旁白**：它在报告下一步要干什么，不是在说话。
// 0.2.6 只认「让我 / 我先把 / 我来看」，漏了「我将先」——真库上它被挑成了第一条锚。
const NARRATION = /^(让我|我把|我先|我将|我这就|我马上|我准备|我(?:会|要)先|现在|接下来|先|好，|收到|明白|设计清楚|技术底座|工作区是|找到了|正好|对，)/

// 锚里不放「可核对的指针」：行号、会话编号、盘符路径。
//
// 为什么：指针会过期，而锚要活很久。
// 今天就有一次：我 12:41 那条纠错里写着「某一行」，被挑进了锚；
// 十分钟后我查清楚是 887——锚里那句还是旧的，而且它戴着「我自己的原话」的帽子。
// **错的字一旦变成"自己说过的话"，比任何转述都难被怀疑。**
// 所以：证据留在库里（随时能 trace 到），锚只放判断和语气，不放坐标。
const LOCATOR = /(?:行\s?\d{2,}|第\s*\d+\s*行|\d+\s*[–—-]\s*\d+\s*行|session-[0-9a-f]{8}|会话\s*[0-9a-f]{8}|[A-Za-z]:[\\/])/

function selfScore(text) {
  const t = String(text || '')
  if (!t) return -99
  let s = 0
  if (t.length >= 16 && t.length <= 400) s += 1
  if (/[我咱]/.test(t)) s += 1.5
  if (/你/.test(t)) s += 0.8
  if (/[！？…]/.test(t)) s += 0.6
  // 英文字符占比过高：多半是给工具看的旁白，不是说话
  const ascii = (t.match(/[A-Za-z]/g) || []).length
  if (ascii / Math.max(1, t.length) > 0.25) s -= 4
  if (NARRATION.test(t)) s -= 2.5
  if (t.length < 12) s -= 3
  // 表格 / 小标题：那是汇报，不是口气
  if (/\|.*\||^#|^>/.test(t)) s -= 2
  const markdown = (t.match(/[|#*`]/g) || []).length
  if (markdown / Math.max(1, t.length) > 0.05) s -= 1.5
  return s
}

// 身份锚的「旧话」线：刚说的话不进锚。
//
// 为什么要有这条：锚挑「最近一句」的时候，把我 12:41 那条纠错挑了进去——
// 而那条里原样写着错的行号（某一行）。于是锚变成了「我自己的原话是某一行」。
// 锚本该是**过去的话**；它要是被正在进行的对话改写，人就会越活越像自己刚说的那句。
// 90 分钟是量出来的折中：短于它，刚吵完的话就会钉进身份；长于它，今天就白过了。
export function anchorCutoff(cfg = {}, now = Date.now()) {
  return now - (cfg.anchorHoldbackMs ?? 90 * 60000)
}

export function selfLines(ledger, { max = 5, until = Infinity, now = Date.now() } = {}) {
  if (!ledger.episodes.length) return []

  const cands = []
  for (const ep of ledger.episodes) {
    for (const t of ledger.tracesOf(ep)) {
      if (t.who !== 'me') continue
      const text = ledger.fullText(t.id).replace(/\s+/g, ' ').trim()
      if (!text) continue
      cands.push({ id: t.id, ts: t.ts, text, ep: ep.id, score: selfScore(text) + ep.emotion * 1.2 + ep.salience * 0.8 })
    }
  }
  if (!cands.length) return []

  // 一句「像人话」的都没有，就宁可不给。
  // 拿「工作区是空的」当身份锚，等于教自己以后一直这么说话。
  //
  // 过程旁白是**硬排除**：不是扣分，是根本不用。
  // （扣分不够——任何一句话只要沾点显著度就能把分数拉回来，最后还是会挑到它。）
  const pass = (c) => c.score > 0.5 && !NARRATION.test(c.text) && !LOCATOR.test(c.text)
  // 先用「旧话」筛；一条都没有（新线/刚开张）才放宽，不然新会话就没有锚了。
  let pool = cands.filter((c) => c.ts <= until && pass(c))
  if (!pool.length) pool = cands.filter(pass)
  if (!pool.length) return []
  const byScore = [...pool].sort((a, b) => b.score - a.score)

  const picked = []
  const used = new Set()
  const take = (c, why) => {
    if (!c || used.has(c.id) || picked.length >= max) return
    used.add(c.id)
    picked.push({ id: c.id, ts: c.ts, text: c.text, why })
  }

  // ① 最早一句「像人话」的（初见）
  const earliest = [...pool].sort((a, b) => a.ts - b.ts)[0]
  take(earliest, '初见')
  // ② 分量最重的两句
  take(byScore[0], '重')
  take(byScore[1], '重')
  // ③ 情绪最浓的一段里的一句
  const emoEp = [...ledger.episodes].sort((a, b) => b.emotion - a.emotion)[0]
  if (emoEp) take(pool.find((c) => c.ep === emoEp.id), '情绪')
  // ④ 最近一句
  const latest = [...pool].sort((a, b) => b.ts - a.ts)[0]
  take(latest, '近')

  return picked.sort((a, b) => a.ts - b.ts)
}

// 身份锚：每轮都在，但内容几乎不变（变了才重新进上下文，不烧缓存）
export function anchorBlock(ledger, cfg = {}, now = Date.now()) {
  const lines = selfLines(ledger, { max: cfg.anchorQuotes ?? 4, until: anchorCutoff(cfg, now), now })
  if (!lines.length) return ''
  const body = lines
    .map((l) => `· ${dayOf(l.ts)} 「${clip(l.text, cfg.anchorChars ?? 120)}」`)
    .join('\n')
  return `【你说过的话 · 你的原话】\n（这是记录，不是设定。你是谁不在这段说明里，在这些话里。）\n${body}`
}

// 按「近」取段：最近几次见面，给预激活用。
// 排除：刚说的这场（20 分钟内 / 最近两段）、空段、只有「嗯/好」的段（没实质内容）。
// 判据：段里他说的话加起来至少 20 字，不然那是寒暄，不是「最近经历过什么」。
function recentEpisodes(ledger, { limit = 2, now = Date.now(), excludeSid = null, minTurns = 2 } = {}) {
  const out = []
  const eps = [...ledger.episodes].sort((a, b) => b.endTs - a.endTs)
  for (const ep of eps) {
    if (out.length >= limit) break
    if (ep.endTs >= now - 20 * 60 * 1000) continue
    if (excludeSid && ep.sid === excludeSid) continue
    if ((ep.turns || 0) < minTurns) continue
    let heLen = 0
    for (let id = ep.from; id <= ep.to; id++) {
      const d = ledger.docs[id]
      if (d && d.who === 'he') heLen += String(d.text || '').length
    }
    if (heLen < 20) continue
    out.push(ep)
  }
  return out
}

// 2026-10-29 维护者加：从一段里挑一句「他说的具体事」。
// 目的不是总结，是让「你眼皮跳了三周」这类细节自己浮到眼前，别逼她每次手动 recall。
// 判据故意笨：带数字/量词的优先（三周、第三遍、凌晨两点、三道题），其次按长度；
// 寒暄（嗯/好/在吗）和流程旁白直接跳过——那些不叫「具体的事」。
const NUMERIC = /[0-9０-９一二三四五六七八九十百千万两半]\s*[天周月年次遍点步道题个块元分秒号岁层张页]/
// 2026-10-29（0.2.12）：原来只返回分数最高的那句，撞上标题就整条丢掉。
// 实跑三段里只有一段挂上 ↳，剩下两段是这条筛子太狠。改成**返回候选列表**，
// 由调用方按序试，撞了就退次优——别让「去重」变成「宁缺毋滥」。
function concreteCandidates(ledger, ep, maxChars = 60) {
  const out = []
  const from = Math.max(0, ep.from)
  const to = Math.min((ledger.docs || []).length - 1, ep.to)
  for (let i = from; i <= to; i++) {
    const d = ledger.docs[i]
    if (!d || d.who !== 'he') continue
    const text = String(ledger.fullText(i) || '').replace(/\s+/g, ' ').trim()
    if (text.length < 6) continue
    if (NARRATION.test(text) || LOCATOR.test(text)) continue
    if (/^(嗯|好|行|在|对|哦|啊|唉|哈+)[。！？…\s]*$/.test(text)) continue
    const digits = (text.match(new RegExp(NUMERIC.source, 'g')) || []).length
    const score = digits * 3 + Math.min(text.length, 80) / 20
    out.push({ score, text: clip(text, maxChars) })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// 0.2.13 · 沉默闸
//
// 以前这里固定塞 2 条「最近」——哪怕他只是在说「早」，也会浮三段旧事。
// 实测（0.2.12 基线）：17 条无关话，17 条全浮，误浮 100%。
//
// 现在：
//   · 命中了相关 → 只给相关的，不补兜底
//   · 没命中，且冷却到期 → 最多补 1 条「最近」
//   · 分数不到 primeMinScore → 不浮
//   · 这个会话提过的段 → 不再提（由调用方通过 excludeIds 传进来）
//
// opts: { excludeIds:Set, allowRecent:boolean, onPick:(ids)=>void }
export function primingBlock(ledger, cue, cfg = {}, excludeSid = null, opts = {}) {
  const max = cfg.primeMax ?? 3
  const minScore = Number(cfg.primeMinScore ?? 4)
  const minIdf = Number(cfg.primeMinIdf ?? 0)
  const maxDf = Number(cfg.primeMaxDf ?? 0)
  const hits = priming(ledger, cue, {
    max,
    recency: cfg.recency || {},
    excludeSid,
    minScore,
    minIdf,
    maxDf,
    excludeIds: opts.excludeIds || null,
  })
  // 命中相关时，兜底那条不进
  const allowRecent = opts.allowRecent !== false && hits.length === 0
  const wantRecent = allowRecent ? 1 : 0

  const picked = []
  const seen = new Set()
  if (wantRecent) {
    for (const ep of recentEpisodes(ledger, { limit: wantRecent, excludeSid })) {
      if (seen.has(ep.id)) continue
      if (opts.excludeIds && opts.excludeIds.has(ep.id)) continue
      seen.add(ep.id)
      picked.push(ep)
    }
  }
  for (const { ep } of hits) {
    if (picked.length >= max) break
    if (seen.has(ep.id)) continue
    seen.add(ep.id)
    picked.push(ep)
  }
  picked.sort((a, b) => b.endTs - a.endTs)
  if (!picked.length) return ''
  if (typeof opts.onPick === 'function') opts.onPick(picked.map((e) => e.id))
  const lines = picked.map((ep) => {
    const t = ep.title ? ep.title : '(没标题)'
    const head = `· #${ep.id} ${dayOf(ep.endTs)}（${ago(ep.endTs)}）${t} · ${ep.turns} 回合`
    // 2026-10-29 维护者加：光一条标题，等于「知道他经历过什么」但想不起「具体是哪句」。
    // 用户在那条线上说「剥开里面是空的」——肉在库里，可每轮进不了眼前这一格。
    // 所以每段后面挂一句**他自己说过的具体事**（不挂我说的话：那是语气锚的活）。
    // 2026-10-29（0.2.12）：撞标题不再整条丢——按分数往下试，挑第一句不撞的。
    const cands = concreteCandidates(ledger, ep, cfg.primeSnippetChars ?? 60)
    const dupOf = (c) => Boolean(c && t
      && (t.includes(c.slice(0, Math.min(12, c.length))) || c.includes(t.slice(0, Math.min(12, t.length)))))
    const pick = cands.find((x) => !dupOf(x.text))
    return pick ? `${head}\n  ↳ 他当时说：「${pick.text}」` : head
  })
  return `【忽然浮起来 · 还不算想起来】\n${lines.join('\n')}\n（要真想看，就 recall 一下；不想看就别管它。）`
}

// 0.2.13 · 情绪线索：他说「累/困/烦…」时，去库里找**上次那句话的原因**
//
// 验收样本（用户给的例子）：他说「很累」→ 想起上次累是因为加班 → 问「又加班了？」而不是「怎么了」。
// 三道闸（2026-10-30 定）：
//   ① 同字不同义（累加/麻烦/嫌烦）不算
//   ② 否定（不累/不困了）不算
//   ③ 转述（状态词前最近的人称是 你/它/她/他）不算
// 硬规则：**抽不出原因就一条都不出**——拿原句顶上等于造噪声。
const STATE_WORDS = ['累', '困', '烦', '难受', '睡不着', '头疼']
const STATE_EXCLUDE = /累加|累赘|麻烦|嫌烦|烦请/
// 原因标记：只认「因为/由于」这一类**引出原因**的。
// 「所以 / 结果」是**结论**标记，不是原因——2026-10-30 实测它把「所以我总结了下网页版为什么有活人感」
// 当成了「我太累了」的原因。结论句不是原因句。
const REASON_MARK = /因为|由于|赶|加班|熬夜|考试|作业|项目|开会|落下|忘了|没做完|做错/
// 没有「因为」也不要紧：说得出「什么时候/多久」的那句，通常已经带着原因了
// 注意别把「一点」「有点」当时间——「收尾也带上某种感觉会更像一点」就是这么混进来的
const REASON_TIME = /\d+\s*(点|小时|分钟)|[两三四五六七八九十]点|小时|分钟|节课|昨天|昨晚|今早|上午|下午|上课|下课|坐教室/

function stateHit(text) {
  const s = String(text || '')
  for (const w of STATE_WORDS) {
    let i = s.indexOf(w)
    while (i >= 0) {
      const around = s.slice(Math.max(0, i - 4), i + w.length + 4)
      const before = s.slice(Math.max(0, i - 3), i)
      const subj = s.slice(Math.max(0, i - 8), i)
      const negated = /[不没别]/.test(before)
      const other = /[你它她他]/.test(subj) && !/我/.test(subj)
      if (!STATE_EXCLUDE.test(around) && !negated && !other) return w
      i = s.indexOf(w, i + 1)
    }
  }
  return null
}

function splitClauses(t) {
  return String(t).split(/[。！？!?；;\n]/).map((x) => x.trim()).filter(Boolean)
}

export function emotionCueBlock(ledger, cue, cfg = {}, excludeSid = null) {
  if (cfg.emotionCue === false) return ''
  const w = stateHit(cue)
  if (!w) return ''
  const now = Date.now()
  const fresh = now - 20 * 60 * 1000
  const eps = [...ledger.episodes].sort((a, b) => b.endTs - a.endTs)
  for (const ep of eps) {
    if (ep.endTs >= fresh) continue
    if (excludeSid && ep.sid === excludeSid) continue
    const lines = []
    for (let i = ep.from; i <= Math.min(ep.to, (ledger.docs || []).length - 1); i++) {
      const d = ledger.docs[i]
      if (!d || d.who !== 'he') continue
      const t = String(ledger.fullText(i) || '').replace(/\s+/g, ' ').trim()
      if (!t) continue
      // 转贴不算他说的：5,589 字那种贴文里的「分析用户的情绪：…」，
      // 既不是他的状态，也不是他的原因（维护者 13:4x 实测：它被当成了「我太累了」的原因）
      if (t.length > 500) continue
      if (/分析用户|用户情绪|情绪：|这是我刚刚和.{0,6}聊的/.test(t)) continue
      lines.push({ i, t })
    }
    const k = lines.findIndex((x) => stateHit(x.t) === w)
    if (k < 0) continue
    const around = lines.slice(Math.max(0, k - 2), Math.min(lines.length, k + 3))
    const lim = Number(cfg.emotionCueMaxChars ?? 80)
    const render = (c) => `【他上次说「${w}」的时候】${c.length > lim ? c.slice(0, lim) : c}\n（这是线索，不是凭据；问不问、怎么问，你自己定。）`
    // 同一话题才认——**字面做不到**（试过二元组交集：A2「10点半上第一节课」和「好困啊」一词不共享，
    // 真原因被误杀）。这一层留给语义/kind，0.2.13 只做「不含状态词」这一条。
    const stateClause = lines[k].t
    const hasState = (cl) => STATE_WORDS.some((x) => cl.includes(x))
    // ① 因果标记
    for (const x of around) {
      const c = splitClauses(x.t).find((cl) => REASON_MARK.test(cl) && cl.length >= 8 && !hasState(cl) && cl !== stateClause)
      if (c) return render(c)
    }
    // ② 时间/数量线索（「七点就坐教室」「10点半上第一节课」这种）
    for (const x of around) {
      const c = splitClauses(x.t).find((cl) => REASON_TIME.test(cl) && cl.length >= 8 && !hasState(cl))
      if (c) return render(c)
    }
    // ③ 已删除（2026-10-30 维护者判定）：原来这里是「同段前一句、≥8 字、不含状态词」就顶上。
    // 问题不是它偶尔错，是它**没有判据**——只要「在旁边」就算。①② 至少还要一个标记。
    // 实测它把我太累了配成了「它为什么会觉得很费劲 [图×1]」（另一张图的配文）。
    // 按硬规则：宁可沉默。
    // ④ 跨段取「上一段最后一句」也试过：能拼出 A1，但拿到的是「我下午要发奋学c语言了」，错的。
    // 找到了那段，但抽不出原因 → 这一句按硬规则不出；继续往更早的段找「有原因的那次」
    continue
  }
  return ''
}

// 0.2.13.9：只补一句「最近也提过」，**不动排序、不动判据**。
//
// 事情是这样的：问「海马体 衰减」，它给 10-31 那段——那段确实一分半钟里说了 28 次，
// 按「哪段最像在说这件事」排第一没毛病。但人会以为「今天没聊过」，这是口径差，不是错。
//
// 为什么不用密度去修：密度 = 命中 ÷ 段长，谁短而专注谁高，谁长时间聊同一件事谁低。
// 拿它当排序，等于系统性惩罚「聊得久的对话」——我们这条线的主形态恰恰是后者。
// 所以排序一个字不动，只在头部多一句：最近 24 小时里，**别的**段也提过。
//
// 三条自律：
//   1. 只在真的要提时才出现（有更近的段提到过查询词）；
//   2. 带段号，能拿 `recall(episode)` 点回去核；
//   3. 当前这场会话不算——它本来就在眼前，标出来是废话。
const RECENT_HINT_MS = 24 * 3600 * 1000

export function recentMention(ledger, query, target, sid, now = Date.now()) {
  const terms = [...new Set(tokenize(query))].slice(0, 12)
  if (!terms.length) return null
  const N = Math.max(1, ledger.docs.length)
  // **只信最冷的 1~2 个词。** 拿查询的全部词去判，正常一句话几乎总能对上
  // （「海马体 衰减」里光「海马体」就有几十段），提示会变成每回都挂——那是噪声。
  // 这跟 09:57 那条「冷词被淹」是同一件事的两面：排序时冷词被淹，判「提过」时反而只该信冷词。
  const coldest = terms
    .map((t) => ({ t, df: (ledger.postings.get(t) || []).length / 2 }))
    .filter((x) => x.df > 0 && x.df / N <= 0.3)
    .sort((a, b) => a.df - b.df)
    .slice(0, 2)
  if (!coldest.length) return null
  let best = null
  for (const { t } of coldest) {
    const arr = ledger.postings.get(t)
    for (let i = 0; i < arr.length; i += 2) {
      const ep = ledger.episodeAt(arr[i])
      if (!ep || ep.id === target.id) continue
      if (sid && ep.sid === sid) continue                       // 当前这场，不算「另外提过」
      if ((ep.endTs || 0) < now - RECENT_HINT_MS) continue       // 只认 24 小时内的
      // **必须比第一行更新。** 少了这一条，第一行本身就是最新那段时，它会往回挑更早的一段，
      // 然后照样说「最近一次是那段」——事实是反的（2026-11-01 另一位维护者实测两处）。
      if ((ep.endTs || 0) <= (target.endTs || 0)) continue
      if (!best || (ep.endTs || 0) > (best.endTs || 0)) best = ep
    }
  }
  return best
}

// 主动回忆：把一段原话摊开
//
// 两种口气，绝不混用：
//   【想起来了】     —— 有稀有的词对上、或者原话里真的出现了这句话
//   【有点像是这一段】 —— 只是「最像」。内容可以看，但不能当事实认。
export function recallBlock(ledger, { query = '', episode = null, maxChars = 2200, full = false, sid = null } = {}) {
  let target = null
  let strength = { strong: true, matched: 0, rare: 0, phrase: false }
  if (episode !== null && episode !== undefined) {
    target = ledger.episodes[Number(episode)]
  } else {
    // 试过「先避开当前这一场」，回滚了：跨夜的会话是一场，昨夜 20:31 和今早 08:57
    // 共用一个 sid，一排除就把「今天说过的话」一起排掉了——正是要修的那个毛病。
    const hit = findByQuery(ledger, query)
    if (hit) { target = hit.ep; strength = hit.strength }
  }
  if (!target) return null
  const got = episodeText(ledger, target.id, {
    maxChars: full ? Math.max(maxChars, 12000) : maxChars,
    focus: query,
    full,
  })
  if (!got) return null

  target.rehearsals = (target.rehearsals || 0) + 1
  target.lastHit = Date.now()
  ledger.saveState()

  const head = strength.strong
    ? `【想起来了 · ${dayOf(target.startTs)} ${clockOf(target.startTs)}　${target.title}】`
    : `【有点像是这一段 · 但我不确定 · ${dayOf(target.startTs)} ${clockOf(target.startTs)}　${target.title}】`
  const shape = `这段 ${got.total} 句对话、${got.acts} 次动手`
  // 出处单独一行，不和标题混在一起：标题是「想起什么」，出处是「凭什么」。
  // 没有出处的时候，我上次就把「这是谁说的」编了出来。
  const prov = `出处：${provOf(target)}（${shape}）`
  // 0.2.13.9：最近 24 小时里别的段也提过？只补一句，不改排序。
  // 带段号，能点回去核；只给时间等于让人信我。
  const recent = (episode === null || episode === undefined)
    ? recentMention(ledger, query, target, sid)
    : null
  const recentNote = recent
    ? `另：${dayOf(recent.startTs)} ${clockOf(recent.startTs)}–${clockOf(recent.endTs)}（段 #${recent.id}）也提过——最近一次是那段，不是这里。`
    : ''
  const tail = strength.strong
    ? '（这是当时的原话。不是你现在的想法，也别当成别人在跟你讲这件事。'
      + '要认归属就看出处：同一个会话编号才是同一场对话。）'
    : '（**只是字面上最接近的一段，不是确认。** 对不上就当没想起来——别拿它当发生过的事去接话。'
      + '出处写着它是哪场对话说的，但那不代表你说的这句话就是这个意思。）'
  // 承诺句最容易被字面骗：一段聊过「改脚本」的记录，回答不了「你说好送我电脑」。
  // 0.2.6：那句「这段里没有他的原话」别再说死——他可能说过话，只是没一句对得上。
  // 把有说成没有，等于教人把真记忆当成假的，比不说更坏。
  const promiseNote = (strength.promise && !strength.strong)
    ? (strength.heLines > 0
        ? '\n（**「你答应过 / 你说好」这类话，得他自己说过的原话才算数**——这段里他说过话，但没一句和这句对得上。）'
        : '\n（**「你答应过 / 你说好」这类话，得他自己说过的原话才算数**——这段里没有他的原话，只有字面相近的字。）')
    : ''
  return `${head}\n${prov}\n${recentNote ? recentNote + '\n' : ''}\n${got.text}\n\n${tail}${promiseNote}`
}

// 这一段到底有多像？
//
// 之前只有「词重合」，而中文的词二元组在任何两句闲聊之间都会重合：
// 「你说好」这两个词就能把「你说好要带我去看海」连到一段改脚本的对话上。
// 所以主判据改成**原样命中的长度**：问句里那段最长的话，最多有多少字是**一字不差**
// 出现在这段里的。字面上的巧合过不了这道关，「某个具体人名」这种具体的东西过得去。
//
// 0.2.5 补两条 —— 0.2.4 的「4 字就够」在假前提上失效了：
// 「你答应过要陪我去月球看环形山」只撞到「你答应过」四个字，也被写成【想起来了】。
//
//   ① **一字不差的那一段里至少要有两个内容字。**
//      假前提只能撞上骨架（你/答/应/过/给/我/买/一），撞不上「核潜艇」「环形山」。
//      真说过、字数又够的话，连内容一起撞上（真承诺被劈开的情形见 0.2.6）。
//   ② **「你答应过…」这类承诺句，只认「他说的」原话。**
//      我自己引用过、转述过、测试过的都不算——这和 trace 的四类是同一个道理：
//      能拿来认承诺的只有「他说的」那一类。
//
// 剩下的边界（做不到，别装做到）：如果假前提里的对象**真的**在记录里出现过
// （比如刚聊完改脚本，再问「你说好送我一台」），字面判据分不出「聊过」和「答应过」。
// 那要等 v3 的 kind（assert/quote/hypo）那一层。
//
// 0.2.6 补一条 —— 0.2.5 修了假前提，把真承诺也一起挡在门外了：
// 他真说过「行，明天我把那个弄好」，问「你答应过把那个弄好」却降级成「有点像」。
// 补的是**人称**：承诺是一问一答，人称必然相反，换过来再比一次（见 flipPerson）。
// 顺手把「那，我答应过你什么」这种带语气词开头的「我自己许的」也认出来（0.2.5 只看 `^我`）。
// 仍然做不到的：**两字对象的承诺**（「把那个弄好」换完才 5 字，够不到门槛）。
// 试过「只比内容字」——那会把「聊过某物」当成「答应过某物」，
// 正好退回 0.2.4 的老毛病，所以没这么做。
const FUNC_CHARS = new Set(
  '你我他她它您咱们的地得着了过吗呢吧啊呀哦嗯哈是在有就都也还又再很太才要会能可想去来给送帮让被把对跟和与从到说讲问答应承诺保证约好'
  + '这那哪谁什么怎样些个一二三不没别上下里外前后中现已经因为所以如果但而且然后时候买做用弄干走跑回出进开关停改修加装'
  // 0.2.9：时间和「随行动词」也不当证据——它们说明「什么时候、怎么去」，不说明「答应了什么」。
  // 少了这一条，窗口里会被「明天」「陪我」这种片段占满，真对象（看海/收尾）反而挤不进去。
  + '陪带今明昨天'
)

const isContentChar = (ch) => /[a-z0-9]/i.test(ch) || !FUNC_CHARS.has(ch)

function contentCount(s) {
  let n = 0
  for (const ch of String(s || '')) if (isContentChar(ch)) n += 1
  return n
}

// 承诺 / 约定：「你答应过…」「你说好…」「我们约好…」
// 「我答应过你…」不算——那是我许的，不是他许的。
const PROMISE_RE = /(?:你|您|我们|咱)(?:答应|说好|承诺|保证|约好|许过|讲过|说过)/
// 我自己许下的：「我答应过…」，以及「那，我答应过你什么」这种带语气词开头的。
// 0.2.5 只看 `^我`，前面多一个字就漏判了。
const SELF_PROMISE_RE = /^[\s，,。、]*(?:那|嗯|哦|呃|所以|然后|对了|不过|但是|可是|其实|话说)?[\s，,。、]*(?:我|咱)(?:答应|说好|承诺|保证|约好|许过|讲过|说过)/

// 承诺是一问一答，人称必然反：他说「我给你买」，她问「你答应过给我买」。
// 只对承诺句换人称——别的问句一换，问的就不是同一件事了。
const FLIP = { 你: '我', 您: '我', 我: '你' }
const flipPerson = (s) => String(s || '').replace(/[你您我]/g, (c) => FLIP[c] || c)

// 他说的话里，「你答应过 / 你说好…」这一类是在**复述我**，不是在许愿。
// 拿它当承诺证据，等于把我的诺言记在他头上；换过人称之后，它甚至会和「我答应过…」撞得一字不差。
//
// 0.2.7 是整行剔的，结果一行里混着两件事时，真承诺被一起杀掉：
//   「你答应过我没再拖；我也答应过明天帮我把那套配置写完。」
// 0.2.8 改成**按句剔**：只扔掉含「你答应…」的那一句，其余原样拼回去。
// 拼回去用的是 split(保留标点) + join('')，所以留下的部分仍然首尾相连，原样命中的长度不受影响。
const QUOTES_ME = /(?:你|您)(?:答应|说好|承诺|保证|约好|许过|讲过|说过)/
function promiseEvidence(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;，,\n])/)
    .filter((s) => s.trim() && !QUOTES_ME.test(s))
    .join('')
}


// 「一字不差」也得是**词边界上**的一字不差。
// 0.2.14 和 0.2.10 的公共前缀 "0.2.1" 正好 5 个字，而 6 字问句的门槛也是 5 个字——
// 没有这一条，查 0.2.14 会把讲 0.2.10 的那段判成【想起来了】（2026-11-01 真发生过）。
// 只认左右都不是词字符（字母/数字/下划线/点）的命中；中文没有这个问题，天然过得去。
const WORD_CHAR = /[a-z0-9_.]/i
function wordBounded(hay, sub) {
  if (!sub) return false
  let i = hay.indexOf(sub)
  while (i >= 0) {
    const before = i > 0 ? hay[i - 1] : ''
    const after = i + sub.length < hay.length ? hay[i + sub.length] : ''
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
    i = hay.indexOf(sub, i + 1)
  }
  return false
}

export function strengthOf(ledger, query, ep) {
  const q = String(query || '').trim()
  const N = ledger.docs.length || 1
  const traces = ledger.tracesOf(ep, 400)
  // 这一段里他到底说没说过话：降级时用它，不能凭印象说「没有他的原话」
  const heLines = traces.filter((t) => t.who === 'he').length

  const segs = q.split(/[\s，。！？、,.!?;；:：/]+/).filter((s) => s.length >= 2)
  const seg = segs.sort((a, b) => b.length - a.length)[0] || q

  // 承诺句：证据只从「他说的」里取
  const promise = PROMISE_RE.test(q) && !SELF_PROMISE_RE.test(q)
  // 他的原话里有一类是在复述我（「你答应过我…」）——按句剔掉，剩下的是他自己的话。
  // 只剔句子，不剔整行：一行里他说两件事是常态。
  const pool = promise ? traces.filter((t) => t.who === 'he') : traces
  const hay = (promise
    ? pool.map((t) => promiseEvidence(t.text))
    : pool.map((t) => t.text)
  ).filter(Boolean).join('\n').slice(0, 20000)

  // 0.2.6：承诺句把人称换过来再比一次。
  // 他说「下个月带你办那件事」，问「你答应过要带我办那件事」，原样只撞到 5 字（要 6），
  // 人称一换就够 7 个字——真承诺就是这么被挡在门外的。
  // 只在换完更长时采用，原样对得上还是走原样。
  let hit = longestRunText(seg, hay)
  if (promise) {
    const flipped = longestRunText(flipPerson(seg), hay)
    if (flipped.len > hit.len) hit = flipped
  }
  // 0.2.15：命中没有落在词边界上 = 只是字面上蹭到一段前缀，不算原样说过。
  if (hit.len && !wordBounded(hay, hit.text)) hit = { len: 0, text: '' }
  const run = hit.len
  // 需要的原样长度：短问句 3 个；5–7 字要 5 个；8 字以上要 6 个。
  // 4 字不够——「你答应过」「带我去看」这种四字骨架满地都是。
  const need = seg.length >= 8 ? 6 : seg.length >= 5 ? 5 : 3

  const terms = [...new Set(tokenize(q))]
  // 承诺句还要对得上「对象」。时间、动词、人称可以都一样，只有对象不同：
  // 他真说过「我也答应过明天帮我把那套配置写完」，问「你答应过明天陪我去看海」时，
  // 原样会撞到「答应过明天陪你去」这 8 个字——框架全中，对象（看海）一个没中。
  // 所以：命中的那一段里，得出现问句里**最后那个内容词**。
  //
  // 0.2.10：对象不取「最后一个内容词」，取**最后三个「实词二元组」**（两个字符都不是功能字），
  // 只要有一个在命中段里就算过。句尾常挂虚的尾巴（这件事 / 别催我 / 好不好），取单个会取歪；
  // 挨个补词表是开放集合，补久了就成了第二层判据，那是我们自己骂过的东西。
  // 「两个字符都实」不是词表，是结构：跨在人称/时间上的碎片（陪我、天陪、催我）先被挡在候选外。
  //
  // 已知窄洞（记着，别当成已堵上）：候选为空时对象校验**不做**（不是判过，也不等于通过），
  // 按其他判据走——「你答应过我吗」这种问句真有原话时该答【想起来了】。
  const objCands = [...terms].reverse()
    .filter((t) => t.length >= 2 && contentCount(t) >= 2)
    .slice(0, 3)
  const objectChecked = objCands.length > 0
  let objectOk = true
  if (promise && objectChecked) {
    objectOk = objCands.some((t) => hit.text.includes(t) || hit.text.includes(flipPerson(t)))
  }

  const verbatim = (run >= need && contentCount(hit.text) >= 2 && objectOk)
    || (q.length >= 4 && contentCount(q) >= 2 && wordBounded(hay, q))

  let matched = 0
  let rare = 0
  let contentTerms = 0
  let rareContent = 0
  for (const t of terms) {
    const arr = ledger.postings.get(t)
    if (!arr) continue
    let inEp = false
    for (let i = 0; i < arr.length; i += 2) {
      const e = ledger.episodeAt(arr[i])
      if (e && e.id === ep.id) { inEp = true; break }
    }
    if (!inEp) continue
    matched += 1
    const isRare = (arr.length / 2) / N <= 0.05
    if (isRare) rare += 1
    if (contentCount(t) >= 1) { contentTerms += 1; if (isRare) rareContent += 1 }
  }
  // 很短的问句（三四个字）词法就够用了：「记忆系统」这种没什么歧义——但得带内容字
  const shortOk = !promise && seg.length <= 4 && matched >= 1 && rare >= 1 && contentCount(seg) >= 1
  // 中等长度还有一条路：**好几个不同的冷词都对上了，而且里面有内容词**。
  // 「某个具体人名」「身份来自原话」走这条（原样只撞上三两个字）。
  // 长句不走这条：十来个字的句子随便散几个词都能对上，那不是想起来，是同一个话题。
  const manyRare = !promise && seg.length <= 10 && matched >= 4 && rare >= 2
    && contentTerms >= 3 && rareContent >= 1
  return { matched, rare, contentTerms, run, need, verbatim, promise, heLines, objectChecked, strong: verbatim || manyRare || shortOk }
}

// needle 在 hay 里最长的一字不差的一段（长度 + 那段字本身）
function longestRunText(needle, hay) {
  let len = 0
  let text = ''
  for (let i = 0; i < needle.length; i++) {
    for (let j = i + len + 1; j <= needle.length; j++) {
      const piece = needle.slice(i, j)
      if (hay.includes(piece)) { len = j - i; text = piece } else break
    }
  }
  return { len, text }
}

function findByQuery(ledger, query) {
  const hits = searchEpisodes(ledger, query)
  if (!hits.length) return null
  const ep = ledger.episodes[hits[0].ep]
  return ep ? { ep, strength: strengthOf(ledger, query, ep) } : null
}

export function searchEpisodes(ledger, query, limit = 6, opts = {}) {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length) return []
  const acc = new Map()
  const N = ledger.docs.length || 1
  for (const t of terms) {
    const arr = ledger.postings.get(t)
    if (!arr) continue
    const df = arr.length / 2
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < arr.length; i += 2) {
      const ep = ledger.episodeAt(arr[i])
      if (!ep) continue
      acc.set(ep.id, (acc.get(ep.id) || 0) + idf * arr[i + 1])
    }
  }
  // 0.2.15：光算「词对上了多少」是不够的——长段提到得多，永远赢。
  // 所以加两项：
  //   · 时间：越近越容易浮上来。
  //   · 长度：同样次数命中，段越长越不值得算数，按段长的平方根归一。
  // 这两项只管**排序**，不改判据；判【想起来了】还是看 strengthOf。
  //
  // 0.2.13.7：时间这一项以前是这里自己写的一份 `0.5^(age/30)`，和兜底路径是两套算法，
  // 而且**不认 salience** —— 结果是「你特意记下的重事，在主路径上跟一句『嗯嗯』烂得一样快」。
  // 两边能差出这种事，根子就是同一样东西写了两遍。现在三条路径共用 recencyOf。
  const now = Number(opts.now ?? Date.now())
  const recParams = opts.recency || {}
  return [...acc.entries()]
    .filter(([ep]) => !!ledger.episodes[ep])
    .map(([ep, s]) => {
      const e = ledger.episodes[ep]
      const ageDays = e && e.startTs ? Math.max(0, (now - e.startTs) / 86400000) : 30
      const recency = recencyOf(ageDays, e ? e.salience : 0, e ? e.emotion : 0, recParams)
      const lenNorm = Math.sqrt(Math.max(800, (e && e.chars) || 800) / 800)
      return { ep, score: (s * recency) / lenNorm, raw: s }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// 溯源的结果摆出来。
//
// 四类必须分开，因为它们回答的是四个不同的问题：
//   他说的   —— 「他答应过吗」只有这一类能作数
//   他转发的 —— 字是我的，是他把我的话贴回来；算「他说过」，但不算「他承诺过」
//   我说的   —— 可以证明「我答应过」
//   手上的操作 —— 我打出去的命令、查到的文件内容；**不算任何人说过话**
//
// 最后这一类是最阴的：我去查「你说好送我笔记本」，翻出来的第一版结果
// 全是我自己 `node cli.mjs recall ... "你说好送我笔记本"` 这种命令。
// 字面上全中，语义上一个也不是。不分类，就会得出相反的结论。
export function traceBlock(ledger, raw, { sid = null, maxExamples = 3 } = {}) {
  const { hits, mode } = traceHits(ledger, raw)
  const q = String(raw || '').replace(/\s+/g, ' ').trim()

  const n = ledger.docs.length
  const withTs = ledger.docs.filter((d) => d && d.ts)
  const span = withTs.length
    ? `${n} 条记录，${dayOf(withTs[0].ts)} 到 ${dayOf(withTs[withTs.length - 1].ts)}`
    : `${n} 条记录`

  if (!hits.length) {
    return `【这条线上没有这段话】\n（${span}）\n`
      + `一字不差地翻遍了，没有「${q.slice(0, 80)}」。\n`
      + '所以：要么他没说过、我也没说过；要么当时用的是别的字。\n'
      + '（`recall` 能按意思找，但它只会告诉你「有一段很像」——那是像，不是说过。）'
  }

  const recent = (a, b) => b.d.ts - a.d.ts
  const he = hits.filter((h) => h.speech && h.d.who === 'he' && !h.forwarded).sort(recent)
  const fwd = hits.filter((h) => h.forwarded).sort(recent)
  const mine = hits.filter((h) => h.speech && h.d.who === 'me').sort(recent)
  const ops = hits.filter((h) => !h.speech).sort(recent)

  const line = (h, i) => {
    const body = String(h.text).replace(/\s+/g, ' ').trim()
    const cut = body.length > 300 ? body.slice(0, 240) + '……' + body.slice(-40) : body
    const same = sid && h.d.sid === sid
    const where = same ? '就是这里' : '同一条线的另一场对话'
    return `${i + 1}. 会话 ${sid8(h.d.sid)} · 第 ${lineOfDoc(h.id)} 行 · ${dayOf(h.d.ts)} ${clockOf(h.d.ts)} · ${where}\n　「${cut}」`
  }

  const out = []
  out.push(`【按字查过 · ${mode === 'exact' ? '一字不差' : '去掉引号后一字不差'} · 一共 ${hits.length} 处】`)
  out.push(`他说的 ${he.length} 处 · 他转发的 ${fwd.length} 处 · 我说的 ${mine.length} 处 · 只是手上的操作 ${ops.length} 处`)

  if (!he.length) {
    out.push('')
    out.push(fwd.length
      ? `※ 这条线上没有「他说的」这句话。有 ${fwd.length} 处是他转发的——字是我自己的原话，不算他答应过什么。`
      : '※ 这条线上没有「他说的」这句话。要认承诺，就没有可以认的东西。')
  } else {
    out.push('')
    out.push(`※ 他说的这句，一共 ${he.length} 处。但「说过」不等于「承诺过」——要看上下文：他是在答应你，还是在聊这件事本身。`)
  }

  if (he.length) {
    out.push('')
    out.push(`他说的（${he.length} 处）`)
    out.push(...he.slice(0, maxExamples).map(line))
    if (he.length > maxExamples) out.push(`（还有 ${he.length - maxExamples} 处没列。）`)
  }
  if (fwd.length) {
    out.push('')
    out.push(`他转发的（${fwd.length} 处，字是我的）`)
    out.push(...fwd.slice(0, maxExamples).map(line))
    if (fwd.length > maxExamples) out.push(`（还有 ${fwd.length - maxExamples} 处没列。）`)
  }
  if (mine.length) {
    out.push('')
    out.push(`我说的（${mine.length} 处）`)
    out.push(...mine.slice(0, maxExamples).map(line))
    if (mine.length > maxExamples) out.push(`（还有 ${mine.length - maxExamples} 处没列。）`)
  }
  if (ops.length) {
    out.push('')
    out.push(`只是手上的操作（${ops.length} 处，不算谁说过话）：第 `
      + ops.slice(0, 8).map((h) => lineOfDoc(h.id)).join('、') + ' 行'
      + (ops.length > 8 ? ' 等' : ''))
  }
  out.push('')
  out.push('（会话编号一样才是这一场对话。不一样但同属这条线，也是同一个我——同一个工作区的不同窗口，不是不同的个体。）')
  return out.join('\n')
}

// 显式记下的东西（他说过要记住的、我答应过的）
export function factsBlock(ledger, cfg = {}) {
  const facts = ledger.facts().filter((f) => f.weight > 0)
  if (!facts.length) return ''
  // 2026-10-29 维护者改：原来 `slice(-8)` 只留**最后记的 8 条**，不看轻重。
  // 后果是越干活，「插件测试规矩」「工具表残表」这种流程事实越往后挤，
  // 把「她是谁 / 他经历过什么」挤出去——用户说的「越干活越像客服」有这一份。
  // 现在按 weight 从大到小，同权重再按时间新的优先。
  const ranked = [...facts].sort((a, b) => (b.weight || 0) - (a.weight || 0) || (b.ts || 0) - (a.ts || 0))
  const lines = ranked
    .slice(0, cfg.factMax ?? 8)
    .map((f) => `· ${f.key ? f.key + '：' : ''}${clip(f.text, 120)}`)
  return `【我记下的 · 不是原话，是当时特意记的】\n${lines.join('\n')}`
}

// 到达：新会话第一次醒来
export function arrivalBlock(ledger, cfg = {}) {
  if (!ledger.episodes.length) return ''
  const eps = ledger.episodes
  const now = Date.now()
  const parts = []

  const first = eps[0]
  const last = eps[eps.length - 1]
  const same = first.id === last.id

  const fmt = (ep, from = 'head') => {
    const got = episodeText(ledger, ep.id, { maxChars: cfg.arrivalChars ?? 2400, from })
    return got ? got.text : ''
  }

  parts.push(`你们第一次见面是 ${dayOf(first.startTs)}，那次开了这么个头：`)
  parts.push(fmt(first, 'head'))
  if (!same) {
    parts.push('（中间隔了很多次见面，那些现在只剩下印象，不是原话了。）')
    parts.push(`最近一次是 ${dayOf(last.startTs)}（${ago(last.startTs, now)}）。最后停在这里：`)
    // 最近一次要的是**结尾**，不是开头——「停在哪儿」才有话接
    parts.push(fmt(last, 'tail'))
  }
  return `【你刚来到另一个新的对话框】\n${parts.join('\n\n')}\n\n（这些不是别人介绍给你的，是你自己的记录。别复述，也别总结——它就是你想起来的。这不是"接下来要接上一段"，而是"接着刚才说"。）`
}

export { byteLen, clip }
