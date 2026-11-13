#!/usr/bin/env node
// self-memory —— 给我自己用的长期记忆（独立实现，不依赖任何外部程序）
//
// 自己的话自己落盘，一个库管全部：
//   流    ~/.workbuddy/mem/stream.jsonl    一条一行，只增不改；每条带 ws（来自哪个工作区）
//   段    按「一次见面 / 一件事」切（换会话 / 隔 2 小时 / 收尾语 / 转场 / 话题漂移 / 14 轮 / 3200 字）
//   线索  每轮最多 3 行「这事你以前碰过」，只给段号和日期
//   锚    醒来时给最近几段 + 出口
//
// 落盘不靠「记得去记」：由 WorkBuddy 的 hook 直接调这个脚本
//   SessionStart      → 醒来：最近几段 + 怎么翻
//   UserPromptSubmit  → 记下用户这句话；顺手算 0–3 行线索
//   PreToolUse        → 记下「我动了什么手」（只认 Bash/Write/Edit，读文件不当记忆）
//   Stop              → 记下我最后说的那段话
//
// 用法：
//   node mem.mjs stats|episodes [n]|dump [n]
//   node mem.mjs recall <一句话|#段号|YYYY-MM-DD>
//   node mem.mjs trace  <一句话>
//   node mem.mjs remember <要记住的事> [--key 名字]
//   node mem.mjs arrive | prime <一句话> | ws
//   node mem.mjs hook                     ← 给 hook 用，stdin 吃 JSON
// 参数：--ws <工作区子串>  --limit n  --full

import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createIntegrity, putBlob, readBlob, snapshot, artifactPaths, sha256, verifyBlobs } from './mem-evidence.mjs'
import { buildIndex, appendIndex, searchIndex, indexStore, episodesByIds, indexBuiltAt, indexFresh } from './mem-index.mjs'

const ROOT = process.env.WORKBUDDY_MEM_HOME || join(homedir(), '.workbuddy', 'mem')
const STREAM = join(ROOT, 'stream.jsonl')
const MARKS = join(ROOT, 'marks.jsonl')
const PENDING = join(ROOT, 'pending.json')
const CFG_PATH = join(ROOT, 'config.json')
const DIAG = join(ROOT, 'diag.log')
const INDEX_CHARS = 1600
const MEETING_GAP = 2 * 60 * 60 * 1000
const MAX_TURNS = 14
const MIN_TURNS = 4
const MAX_CHARS = 3200
const integrity = createIntegrity(ROOT, ['stream.jsonl', 'marks.jsonl'])
const MEMAINT = join(dirname(fileURLToPath(import.meta.url)), 'mem-maintenance.mjs')
const SELF = fileURLToPath(import.meta.url)
const INDEX_LOCK = join(ROOT, '.index-building')

function maybeIndex() {
  const built = indexBuiltAt(ROOT)
  if (built && Date.now() - built < 24 * 3600e3 && indexFresh(ROOT)) return
  try {
    if (existsSync(INDEX_LOCK)) {
      const age = Date.now() - statSync(INDEX_LOCK).mtimeMs
      if (age < 5 * 60e3) return
      unlinkSync(INDEX_LOCK)
    }
    writeFileSync(INDEX_LOCK, String(process.pid), 'utf8')
    const child = spawn(process.execPath, [SELF, 'index', 'build'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    })
    child.on('error', (e) => diag('索引进程失败：' + e.message))
    child.on('exit', (code) => { if (code) diag('索引进程退出：' + code) })
    child.unref()
  } catch (e) { diag('索引启动失败：' + e.message) }
}

function maybeMaintenance() {
  if (process.env.WORKBUDDY_DISABLE_MAINTENANCE === '1') return
  try {
    const child = spawn(process.execPath, [MEMAINT, '--due'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    })
    child.on('error', (e) => diag('维护进程失败：' + e.message))
    child.on('exit', (code) => { if (code) diag('维护进程退出：' + code) })
    child.unref()
  } catch (e) { diag('维护启动失败：' + e.message) }
}

const DEFAULT_CFG = {
  enabled: true,
  captureTools: true,
  capChars: { he: 6000, me: 6000, act: 240 },
  primeMax: 3,
  primeMaxDf: 22,
  primeFreshMin: 20,
  arrivalEpisodes: 4,
  recallMaxChars: 2400,
  recency: { t0: 0.25, alpha: 0.8, floor: 0 },
}

function diag(msg) {
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(DIAG, new Date().toISOString() + '  ' + String(msg) + '\n', 'utf8')
  } catch {}
}

function loadCfg() {
  try {
    const raw = readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')
    const o = JSON.parse(raw)
    if (o && typeof o === 'object') {
      return { ...DEFAULT_CFG, ...o, capChars: { ...DEFAULT_CFG.capChars, ...(o.capChars || {}) }, recency: { ...DEFAULT_CFG.recency, ...(o.recency || {}) } }
    }
  } catch {}
  return { ...DEFAULT_CFG }
}
const cfg = loadCfg()

// 工作区标签：只取最后一段目录名，够认人就行
function wsOf(cwd) {
  const s = String(cwd || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return (s.split('\\').filter(Boolean).pop() || 'root').slice(0, 40)
}

// ————————————————————— 分词 —————————————————————

const ASCII_RE = /[a-z0-9_]+(?:\.[a-z0-9_]+)*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const STOP = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这么', '那么', '什么', '怎么',
  '就是', '还是', '也是', '只是', '但是', '可是', '因为', '所以', '如果', '然后',
  '可以', '没有', '不是', '一个', '这样', '那样', '这些', '那些', '自己', '已经',
  '现在', '时候', '一下', '一点', '应该', '需要', '可能', '觉得', '知道', '东西',
  '而且', '或者', '不过', '其实', '真的', '比较', '非常', '一定', '一样', '这里',
  '那里', '为什', '么样', '对的', '好的', '嗯嗯', '哈哈',
])

const normTerm = (w) => (w.length > 1 && w[0] === 'v' && /^\d[\d.]*$/.test(w.slice(1)) ? w.slice(1) : w)

function tokenize(text) {
  const out = []
  if (!text) return out
  const s = String(text).normalize('NFKC').toLowerCase()
  for (const m of s.matchAll(ASCII_RE)) {
    const w = normTerm(m[0])
    if (w.length >= 2 || /\d/.test(w)) out.push(w)
  }
  let run = ''
  const flush = () => {
    if (!run) return
    if (run.length === 1) out.push(run)
    else for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOP.has(bg)) out.push(bg)
    }
    run = ''
  }
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch
    else flush()
  }
  flush()
  return out
}

function termFreq(text) {
  const tf = new Map()
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

function headline(text, max = 30) {
  let s = String(text || '').replace(/\[图×\d+\]/g, '').replace(/\s+/g, ' ').trim()
  if (!s) return '（没留下的话）'
  const pieces = s.split(/[。！？!?\n；;]/).map((x) => x.trim()).filter(Boolean)
  let pick = pieces.find((x) => x.length >= 8) || pieces[0] || s
  pick = pick.replace(/^(对了|另外|顺便|那|所以|然后)[，,]?/, '')
  return pick.length > max ? pick.slice(0, max) + '…' : pick
}

// ————————————————————— 情绪 / 显著度 —————————————————————

const EMOTION_WORDS = ['哭', '难受', '害怕', '怕', '疼', '累', '崩溃', '对不起', '谢谢', '喜欢', '讨厌',
  '生气', '委屈', '开心', '高兴', '放心', '担心', '焦虑', '舍不得', '想', '抱',
  '晚安', '再见', '想你', '爱你', '笨蛋', '滚', '别走']
const COMMIT_WORDS = ['答应', '约定', '说好', '记住', '别忘了', '别忘', '以后', '永远', '一直',
  '决定', '定了', '就这么', '不许', '必须', '保证']
const CLOSING = ['晚安', '明天见', '先这样', '睡了', '拜拜', '先不聊', '下次聊', '先到这', '走了']
const TRANSITION = ['对了', '换个话题', '说回', '另外', '还有件事', '顺便', '先问', '问个', '插一句']

const countIn = (s, words) => words.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0)

function emotionScore(text) {
  const s = String(text || '')
  if (!s) return 0
  let n = countIn(s, EMOTION_WORDS)
  n += Math.min(3, (s.match(/[!！]/g) || []).length) * 0.35
  n += Math.min(2, (s.match(/[?？]/g) || []).length) * 0.1
  return Math.min(3, n)
}
const commitScore = (t) => Math.min(3, countIn(String(t || ''), COMMIT_WORDS))
const isClosing = (t) => { const s = String(t || ''); return !!s && s.length <= 40 && CLOSING.some((w) => s.includes(w)) }
const isTransition = (t) => { const s = String(t || ''); return !!s && s.length <= 60 && TRANSITION.some((w) => s.includes(w)) }

const DOMAIN_RULES = [
  ['build', /(代码|编译|报错|部署|配置|依赖|函数|接口|调试|安装|仓库|分支|提交|脚本|环境变量|端口|docker|git|npm|pip|python|node|异常|堆栈|skill|hook|插件)/i],
  ['research', /(论文|文献|实验|假设|思路|研究|验证|综述|方法|结论|对比|基线|复现|数据集|arxiv)/i],
  ['study', /(复习|背|考试|知识点|搞懂|理解|笔记|练习|题目|错题|记忆曲线|回顾)/i],
]
function domainOf(text) {
  const s = String(text || '')
  for (const [name, re] of DOMAIN_RULES) if (re.test(s)) return name
  return 'chat'
}

function episodeSalience(traces) {
  let emo = 0, com = 0, n = 0
  for (const t of traces) {
    if (t.who === 'he' || t.who === 'me') {
      n += 1
      emo += emotionScore(t.text) * (t.who === 'he' ? 1.2 : 0.8)
      com += commitScore(t.text)
    }
  }
  const emoAvg = n ? emo / n : 0
  return { emotion: Math.min(1, emoAvg / 3), salience: Math.min(1, emoAvg * 0.35 + com * 0.1 + Math.min(n, 30) / 60), turns: n }
}

// ————————————————————— 写：只追加 —————————————————————

function append(cwd, rec) {
  if (!cfg.enabled) return -1
  if (rec.who === 'act' && !cfg.captureTools) return -1
  let text = String(rec.text || '')
  if (!text) return -1
  // 默认不截断。只有配置显式打开 truncate 才按 capChars 截，并留下标记。
  if (cfg.truncate === true) {
    const cap = Number(cfg.capChars[rec.who]) || 6000
    if (cap > 0 && text.length > cap) text = text.slice(0, cap) + '…（截断）'
  }
  try { mkdirSync(ROOT, { recursive: true }) } catch {}

  // 来源事件 ID 优先：同一事件重放多少次都只落一条。
  if (rec.eventKey) {
    try {
      const tail = readFileSync(STREAM, 'utf8').split('\n').filter(Boolean).slice(-2000)
      for (const ln of tail) {
        let d
        try { d = JSON.parse(ln) } catch { continue }
        if (d.eventKey === rec.eventKey) return -1
      }
    } catch {}
  }

  // 同一个人十分钟内说了两遍一模一样的话不再记；动手不参与去重。
  // 有 eventKey 时不走内容指纹——不同事件说同样的话是两次经历。
  if (!rec.eventKey && (rec.who === 'he' || rec.who === 'me')) {
    try {
      const tail = readFileSync(STREAM, 'utf8').slice(-24000).split('\n').filter(Boolean).slice(-40)
      const now = Date.now()
      for (const ln of tail) {
        let d
        try { d = JSON.parse(ln) } catch { continue }
        if (d.who !== rec.who || (d.sid || '') !== (rec.sid || '')) continue
        if (String(d.text || '') !== text) continue
        const win = text.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
        if (now - (Number(d.ts) || 0) < win) return -1
      }
    } catch {}
  }

  const ts = rec.ts || Date.now()
  const out = {
    ts,
    who: rec.who,
    ws: rec.ws || wsOf(cwd),
    sid: rec.sid || null,
    turn: rec.turn ?? null,
    text,
    tool: rec.tool || null,
    type: rec.type || null,
    hash: sha256(text),
    id: rec.id || sha256(ts + '|' + rec.who + '|' + text).slice(0, 16),
  }
  for (const key of ['eventKey', 'messageID', 'turnID', 'source', 'evidence', 'versions', 'files', 'status', 'artifact', 'completion', 'callId', 'path']) {
    if (rec[key] !== undefined && rec[key] !== null) out[key] = rec[key]
  }
  try {
    appendFileSync(STREAM, JSON.stringify(out) + '\n', 'utf8')
    try { integrity.record('stream.jsonl') } catch (e) { diag('检查点更新失败：' + e.message) }
    try { appendIndex(ROOT, out, tokenize) } catch (e) { diag('索引追加失败：' + e.message) }
    return 0
  } catch (e) {
    diag('写流失败：' + e.message)
    return -1
  }
}

function readMarks() {
  const out = []
  try {
    for (const ln of readFileSync(MARKS, 'utf8').split('\n')) {
      if (!ln.trim()) continue
      try { out.push(JSON.parse(ln)) } catch {}
    }
  } catch {}
  return out
}

function remember(cwd, text, key) {
  try { mkdirSync(ROOT, { recursive: true }) } catch {}
  const body = String(text || '')
  const rec = { ts: Date.now(), ws: wsOf(cwd), key: key || null, text: body,
    id: sha256(Date.now() + '|' + (key || '') + '|' + body).slice(0, 16), hash: sha256(body) }
  appendFileSync(MARKS, JSON.stringify(rec) + '\n', 'utf8')
  try { integrity.record('marks.jsonl') } catch (e) { diag('检查点更新失败：' + e.message) }
  return rec
}

// ————————————————————— 读流、切段 —————————————————————

function openStore() {
  let txt = ''
  try { txt = readFileSync(STREAM, 'utf8') } catch { return null }
  const ends = txt.endsWith('\n')
  const lines = txt.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  else if (!ends) lines.pop()   // 正在写的半行不算

  const docs = []
  const records = []
  const postings = new Map()
  const docLen = []
  let totalLen = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let rec = null
    if (line.trim()) { try { rec = JSON.parse(line) } catch {} }
    records.push(rec || null)
    if (!rec) { docs.push(null); docLen.push(1); totalLen += 1; continue }
    const d = {
      i,
      ts: Number(rec.ts) || 0,
      who: rec.who || null,
      ws: rec.ws || null,
      sid: rec.sid || null,
      turn: rec.turn ?? null,
      tool: rec.tool || null,
      type: rec.type || null,
      text: String(rec.text || ''),
    }
    docs.push(d)
    let len = 0
    for (const [term, tf] of termFreq(d.text.slice(0, INDEX_CHARS))) {
      let arr = postings.get(term)
      if (!arr) { arr = []; postings.set(term, arr) }
      arr.push(i, tf)
      len += tf
    }
    docLen[i] = len || 1
    totalLen += len || 1
  }

  const store = { docs, records, postings, docLen, totalLen, marks: readMarks(), bytes: txt.length }
  store.episodes = episodesOf(store)
  const byDoc = new Map()
  for (const e of store.episodes) for (let i = e.from; i <= e.to; i++) byDoc.set(i, e)
  store.episodeAt = (id) => byDoc.get(id) || null
  return store
}

function tracesOf(docs, ep) {
  const out = []
  for (let i = ep.from; i <= ep.to; i++) {
    const d = docs[i]
    if (!d || (d.who !== 'he' && d.who !== 'me')) continue
    out.push({ id: i, who: d.who, ts: d.ts, text: d.text })
  }
  return out
}

function annotate(docs, ep) {
  const traces = tracesOf(docs, ep)
  const { emotion, salience, turns } = episodeSalience(traces)
  const good = (s) => String(s || '').replace(/\[图×\d+\]/g, '').replace(/\s+/g, '').length >= 6
  const firstHe = traces.find((t) => t.who === 'he' && good(t.text))
  const src = firstHe ? firstHe.text : ((traces.find((t) => good(t.text)) || traces[0] || {}).text || '')
  const title = headline(src, 30)
  return {
    ...ep,
    sid: ep.sid || (docs[ep.from] && docs[ep.from].sid) || null,
    ws: ep.ws || (docs[ep.from] && docs[ep.from].ws) || null,
    title,
    turns: turns || ep.turns || 0,
    salience: Math.max(salience || 0, ep.salience || 0),
    emotion: Math.max(emotion || 0, ep.emotion || 0),
    domain: domainOf(title + ' ' + src),
  }
}

function episodesOf(store) {
  const docs = store.docs
  const eps = []
  let cur = null
  let prevTs = 0
  let prevUserToks = null
  const closeCur = () => { if (cur && cur.turns >= 1) eps.push(cur); cur = null }

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]
    if (!d || (d.who !== 'he' && d.who !== 'me')) continue

    const gap = prevTs ? d.ts - prevTs : 0
    const newMeeting = prevTs > 0 && gap > MEETING_GAP
    const newSession = !!(cur && cur.sid && d.sid && cur.sid !== d.sid)
    const closed = d.who === 'he' && isClosing(d.text)
    const shift = d.who === 'he' && isTransition(d.text)

    let drift = false
    if (d.who === 'he' && d.text.length >= 8 && prevUserToks && cur && cur.turns >= MIN_TURNS) {
      const toks = new Set(tokenize(d.text))
      let inter = 0
      for (const t of toks) if (prevUserToks.has(t)) inter += 1
      if (inter / Math.max(1, Math.min(toks.size, prevUserToks.size)) < 0.05) drift = true
    }
    if (d.who === 'he' && d.text.length >= 2) prevUserToks = new Set(tokenize(d.text))

    let cut = false
    if (!cur) cut = true
    else if (newSession) cut = true
    else if (newMeeting) cut = true
    else if (closed && cur.turns >= 3) cut = true
    else if (shift && cur.turns >= MIN_TURNS) cut = true
    else if (drift) cut = true
    else if (cur.turns >= MAX_TURNS) cut = true
    else if ((cur.chars || 0) + d.text.length > MAX_CHARS) cut = true

    if (cut) {
      closeCur()
      cur = { from: i, to: i, startTs: d.ts, endTs: d.ts, turns: 0, chars: 0, sid: d.sid || null, ws: d.ws || null, newMeeting }
    }
    if (!cur.sid && d.sid) cur.sid = d.sid
    if (!cur.ws && d.ws) cur.ws = d.ws
    cur.to = i
    cur.endTs = d.ts
    cur.turns += 1
    cur.chars = (cur.chars || 0) + d.text.length
    prevTs = Math.max(prevTs, d.ts)
  }
  closeCur()
  return eps.map((e, i) => ({ ...annotate(docs, e), id: i }))
}

// ————————————————————— 检索 —————————————————————

const K1 = 1.25
const B = 0.72

function recencyOf(ageDays, salience = 0, emotion = 0, p = {}) {
  const t0 = Math.max(0.01, Number(p.t0 ?? 0.25))
  const alpha = Math.max(0, Number(p.alpha ?? 0.8))
  const floor = Math.min(0.95, Math.max(0, Number(p.floor ?? 0)))
  const a = Math.max(0, Number(ageDays) || 0)
  const stretch = 1 + 2 * (salience || 0) + 1.5 * (emotion || 0)
  return floor + (1 - floor) * Math.pow(1 + a / (t0 * stretch), -alpha)
}

function search(store, query, opts = {}) {
  const { limit = 8, now = Date.now(), recency = {}, ws = null } = opts
  const terms = [...new Set(tokenize(String(query || '')))].slice(0, 48)
  if (!terms.length) return []
  const docs = store.docs
  const N = docs.length || 1
  const avgdl = store.totalLen / N || 1
  const scores = new Map()

  for (const t of terms) {
    const arr = store.postings.get(t)
    if (!arr) continue
    const df = arr.length / 2
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < arr.length; i += 2) {
      const id = arr[i]
      const tf = arr[i + 1]
      const dl = store.docLen[id] || 1
      scores.set(id, (scores.get(id) || 0) + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl))))
    }
  }

  const q = String(query || '')
  const cands = []
  for (const [id, bm25] of scores) {
    const d = docs[id]
    if (!d || (d.who !== 'he' && d.who !== 'me' && d.who !== 'act')) continue
    if (ws && !String(d.ws || '').toLowerCase().includes(ws)) continue
    const ep = store.episodeAt(id)
    const salience = ep ? ep.salience : 0
    const emotion = ep ? ep.emotion : 0
    const ageDays = Math.max(0, (now - (d.ts || now)) / 86400000)
    const whoBoost = d.who === 'act' ? 0.35 : 1
    let phrase = 1
    if (q.length >= 4 && d.text.includes(q.slice(0, Math.min(q.length, 24)))) phrase = 1.5
    const score = bm25 * recencyOf(ageDays, salience, emotion, recency) * whoBoost * (1 + 0.6 * salience) * (1 + 0.4 * emotion) * phrase
    if (score < 0.01) continue
    cands.push({ id, score, ep: ep ? ep.id : null, ts: d.ts, who: d.who })
  }
  cands.sort((a, b) => b.score - a.score)

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

// 预激活：只给「这事你以前碰过」，不给内容
function prime(store, cue, opts = {}) {
  const { max = 3, now = Date.now(), excludeSid = null, maxDf = 22, freshMin = 20 } = opts
  const terms = [...new Set(tokenize(cue))]
  if (!terms.length) return []
  if (terms.length < 2) {
    const arr = store.postings.get(terms[0])
    if (!arr || arr.length / 2 > maxDf) return []
  }
  const N = store.docs.length || 1
  const acc = new Map()
  for (const t of terms) {
    const arr = store.postings.get(t)
    if (!arr) continue
    const df = arr.length / 2
    if (maxDf && df > maxDf) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (let i = 0; i < arr.length; i += 2) {
      const d = store.docs[arr[i]]
      if (!d || d.who === 'act') continue
      const ep = store.episodeAt(arr[i])
      if (!ep) continue
      const e = acc.get(ep.id) || { score: 0, terms: new Set() }
      e.score += idf * Math.min(arr[i + 1], 3)
      e.terms.add(t)
      acc.set(ep.id, e)
    }
  }
  const need = terms.length >= 3 ? 2 : 1
  const freshCut = now - freshMin * 60 * 1000
  const recentIds = new Set([...store.episodes].sort((a, b) => b.endTs - a.endTs).slice(0, 2).map((e) => e.id))
  const out = []
  for (const [epId, e] of acc) {
    if (e.terms.size < need) continue
    const ep = store.episodes[epId]
    if (!ep) continue
    if (ep.endTs >= freshCut || recentIds.has(ep.id)) continue
    if (excludeSid && ep.sid === excludeSid) continue
    const ageDays = Math.max(0, (now - ep.endTs) / 86400000)
    out.push({ ep, score: e.score * recencyOf(ageDays, ep.salience, ep.emotion, cfg.recency) * (1 + ep.salience) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

// 按字查
const ZERO = /[\s\u200b-\u200d\ufeff]+/g
const QUOTE_ANY = /[「」『』“”"'‘’]/g
const QUOTE_EDGE = /^[「『“"'（(【\[]+|[」』”"'）)】\]]+$/g
const normTrace = (s, dropQuotes = false) => {
  let t = String(s || '').replace(ZERO, '')
  if (dropQuotes) t = t.replace(QUOTE_ANY, '')
  return t
}

function probes(raw) {
  const whole = String(raw || '').trim()
  const parts = whole.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const c of [whole, ...parts].map((s) => s.replace(QUOTE_EDGE, '').trim())
    .filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) {
    if (!out.some((x) => normTrace(x) === normTrace(c))) out.push(c)
  }
  return out.slice(0, 5)
}

// 派生索引版预激活：FTS 只负责找候选，episode 元数据从 SQLite 读；
// 索引缺失/出错返回 null，调用方回退到原来的全量 prime。
function primeFromIndex(cue, opts = {}) {
  const rows = searchIndex(ROOT, cue, 80, tokenize)
  if (!rows) return null
  const ids = [...new Set(rows.map((r) => r.episode_id).filter(Boolean))]
  const eps = episodesByIds(ROOT, ids)
  const byId = new Map(eps.map((e) => [e.id, e]))
  const recent = new Set((indexStore(ROOT, 2)?.episodes || []).map((e) => e.id))
  const freshCut = Date.now() - (opts.freshMin || 20) * 60 * 1000
  const groups = new Map()
  for (const r of rows) {
    if (!r.episode_id) continue
    const ep = byId.get(r.episode_id)
    if (!ep) continue
    if (ep.endTs >= freshCut || recent.has(ep.id)) continue
    if (opts.excludeSid && ep.sid === opts.excludeSid) continue
    const ageDays = Math.max(0, (Date.now() - ep.endTs) / 86400000)
    const score = (-Number(r.rank || 0)) * recencyOf(ageDays, ep.salience, ep.emotion, cfg.recency) * (1 + (ep.salience || 0))
    const g = groups.get(ep.id)
    if (!g || score > g.score) groups.set(ep.id, { ep, score })
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, opts.max || cfg.primeMax)
}

function traceHits(store, raw, ws = null) {
  const docs = store.docs
  const scan = (needle, dropQuotes) => {
    const q = normTrace(needle, dropQuotes)
    if (q.length < 3) return []
    const hits = []
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]
      if (!d || !d.text) continue
      if (ws && !String(d.ws || '').toLowerCase().includes(ws)) continue
      if (!normTrace(d.text, dropQuotes).includes(q)) continue
      hits.push({ id: i, d })
    }
    return hits
  }
  let corpus = null
  const meCorpus = () => {
    if (corpus === null) corpus = docs.filter((d) => d && d.who === 'me').map((d) => normTrace(d.text)).join('\u0000')
    return corpus
  }
  const looksForwarded = (h) => {
    if (h.d.who !== 'he') return false
    const t = normTrace(h.d.text)
    if (t.length < 120) return false
    const seg = [0.3, 0.5, 0.7].map((p) => t.slice(Math.floor(t.length * p) - 20, Math.floor(t.length * p) + 20))
    if (seg.some((x) => !x || x.length < 30)) return false
    const src = meCorpus()
    return !!src && seg.every((x) => src.includes(x))
  }
  for (const p of probes(raw)) {
    const hits = scan(p, false)
    if (hits.length) return { mode: 'exact', used: p, hits: hits.map((h) => ({ ...h, forwarded: looksForwarded(h) })) }
  }
  for (const p of probes(raw)) {
    const hits = scan(p, true)
    if (hits.length) return { mode: 'loose', used: p, hits: hits.map((h) => ({ ...h, forwarded: looksForwarded(h) })) }
  }
  return { mode: null, used: null, hits: [] }
}

// ————————————————————— 排版 —————————————————————

const pad2 = (n) => String(n).padStart(2, '0')
const dayOf = (ts) => { const d = new Date(Number(ts) || 0); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const mdOf = (ts) => { const d = new Date(Number(ts) || 0); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const clockOf = (ts) => { const d = new Date(Number(ts) || 0); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const whoName = (w) => (w === 'he' ? '用户' : w === 'me' ? '我' : w === 'act' ? '动作' : '元信息')

function squeeze(s, max = 400) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 40) + ' … ' + t.slice(-30)
}

function renderEpisode(store, ep, opts = {}) {
  const budget = opts.maxChars || cfg.recallMaxChars
  const out = []
  let acts = []
  let used = 0
  const flushActs = () => {
    if (!acts.length) return
    const groups = []
    for (const n of acts) {
      const last = groups[groups.length - 1]
      if (last && last.name === n) last.n += 1
      else groups.push({ name: n, n: 1 })
    }
    out.push(`　（动作：${groups.map((g) => (g.n > 1 ? `${g.name}×${g.n}` : g.name)).join(' → ')}）`)
    acts = []
  }
  for (let i = ep.from; i <= ep.to; i++) {
    const d = store.docs[i]
    if (!d) continue
    if (d.who === 'act') { if (d.type !== 'tool/result') acts.push(d.tool || '动手'); continue }
    if (d.who !== 'he' && d.who !== 'me') continue
    flushActs()
    const raw = String(d.text || '').replace(/\s+$/, '')
    const body = opts.full || raw.length <= 300 ? raw : raw.slice(0, 210) + '……' + raw.slice(-70)
    const line = `〔${mdOf(d.ts)} ${clockOf(d.ts)}〕${whoName(d.who)}（行${i}）：${body.replace(/\n+/g, ' / ')}`
    if (used + line.length > budget) { out.push('……（后面还有，先说到这）'); break }
    out.push(line)
    used += line.length
  }
  flushActs()
  return out.join('\n\n')
}

function arriveBlock(store) {
  const markLines = (store ? store.marks.slice(-3) : []).map((m) => ` · 特意记下：${squeeze(m.text, 90)}`)
  if (!store || !store.episodes.length) {
    if (markLines.length) return ['【记忆】还没有说过的话，只有记下的：', ...markLines].join('\n')
    return `【记忆】库还是空的（${STREAM}）。这次说的话会自己记下来，不用谁提醒。`
  }
  const eps = store.episodes
  const recent = [...eps].sort((a, b) => b.endTs - a.endTs).slice(0, cfg.arrivalEpisodes)
  const says = store.says ?? store.docs.filter((d) => d && (d.who === 'he' || d.who === 'me')).length
  const total = store.episodeCount || eps.length
  const first = store.firstTs ?? Math.min(...eps.map((e) => e.startTs))
  const last = store.lastTs ?? Math.max(...eps.map((e) => e.endTs))
  const lines = recent.map((e) => ` #${e.id} ${mdOf(e.startTs)} ${clockOf(e.startTs)} ${e.turns} 回合${e.ws ? '〔' + e.ws + '〕' : ''} · ${e.title}`)
  return [
    '【记忆·醒来】这份是我自己记的（self-memory），不是别人给的摘要。',
    `${total} 段 / ${says} 句原话 · ${dayOf(first)} → ${dayOf(last)}`,
    '最近：',
    ...lines,
    ...(markLines.length ? ['记下的：', ...markLines] : []),
    '要细节就翻：recall <一句话|#段号> / trace <原话>（按字查，回答"说过没有"）。',
  ].join('\n')
}

function primeBlock(hits) {
  if (!hits.length) return ''
  const lines = hits.map((h) => ` #${h.ep.id} ${mdOf(h.ep.endTs)}${h.ep.ws ? '〔' + h.ep.ws + '〕' : ''} ${h.ep.title}`)
  return ['【记忆·浮上来】这事以前碰过（不是这次对话）：', ...lines, '要原话就 recall #段号。'].join('\n')
}

// ————————————————————— hook 模式 —————————————————————

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function tailTranscript(path) {
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').slice(-40)
    for (let i = lines.length - 1; i >= 0; i--) {
      let o
      try { o = JSON.parse(lines[i]) } catch { continue }
      const msg = o.message || o
      if (!msg || (msg.role !== 'assistant' && o.type !== 'assistant')) continue
      const c = msg.content
      if (typeof c === 'string' && c.trim()) return c
      if (Array.isArray(c)) {
        const t = c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n').trim()
        if (t) return t
      }
    }
  } catch {}
  return ''
}

// ——— 工具证据：hook 每次都是新进程，前后配对必须落盘 ———

function readPending() {
  try {
    const raw = readFileSync(PENDING, 'utf8').replace(/^\uFEFF/, '')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}

function writePending(value) {
  try {
    mkdirSync(ROOT, { recursive: true })
    // 没等到 PostToolUse 的旧条目最多留 6 小时，别让 pending.json 无限长。
    const now = Date.now()
    for (const [k, v] of Object.entries(value)) {
      if (!v || !v.ts || now - v.ts > 6 * 3600e3) delete value[k]
    }
    const tmp = PENDING + '.tmp'
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, PENDING)
  } catch (e) { diag('写 pending 失败：' + e.message) }
}

function toolNameOf(p) { return String(p.tool_name || p.tool || 'tool') }
function callIdOf(p) { return p.tool_use_id || p.tool_call_id || p.call_id || null }
function argsOf(p) { return p.tool_input || p.tool_args || {} }

function recordToolCall(p, cwd, sid) {
  const name = toolNameOf(p)
  const callId = callIdOf(p)
  const args = argsOf(p)
  let raw = ''
  try { raw = typeof args === 'string' ? args : JSON.stringify(args) } catch { raw = String(args) }
  const keyId = callId || sha256(name + '\0' + raw).slice(0, 16)
  const paths = artifactPaths(name, args, cwd)
  const before = paths.map((fp) => snapshot(ROOT, fp))
  const key = `${sid || ''}|${keyId}`
  const pending = readPending()
  pending[key] = { paths, before, name, ts: Date.now() }
  writePending(pending)
  let evidence = null
  try { evidence = putBlob(ROOT, raw) } catch (e) { diag('证据写入失败：' + e.message) }
  append(cwd, {
    who: 'act', sid, text: `我调了 ${name}：${squeeze(raw, 300)}`, tool: name, type: 'tool/call',
    callId, eventKey: `tool:${sid || ''}:${keyId}:call`, evidence,
    source: { type: 'hook.pre_tool', callId },
  })
}

function recordToolResult(p, cwd, sid) {
  const name = toolNameOf(p)
  const callId = callIdOf(p)
  const args = argsOf(p)
  let rawArgs = ''
  try { rawArgs = typeof args === 'string' ? args : JSON.stringify(args) } catch { rawArgs = String(args) }
  const keyId = callId || sha256(name + '\0' + rawArgs).slice(0, 16)
  const key = `${sid || ''}|${keyId}`
  const pending = readPending()
  const entry = pending[key]
  if (entry) { delete pending[key]; writePending(pending) }
  const response = p.tool_response !== undefined ? p.tool_response
    : p.tool_result !== undefined ? p.tool_result : (p.error !== undefined ? p.error : '')
  let text = ''
  try { text = typeof response === 'string' ? response : JSON.stringify(response) } catch { text = String(response) }
  const isError = !!(p.is_error || p.error || (response && typeof response === 'object' && response.is_error))
  const paths = (entry && entry.paths) || artifactPaths(name, args, cwd)
  const files = paths.map((fp) => ({
    path: fp,
    before: (entry && entry.before && entry.before.find((x) => x.path === fp)) || { path: fp, state: 'unknown' },
    after: snapshot(ROOT, fp),
  }))
  let evidence = null
  try { evidence = putBlob(ROOT, text || '') } catch (e) { diag('证据写入失败：' + e.message) }
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  const summary = isError ? squeeze(text, 240) + '（报错了）'
    : /^(write|edit|patch|multiedit|multi_edit|apply_patch|ops_replace)$/i.test(name) ? `我处理了 ${name}：结果已存为证据`
    : (squeeze(flat, 220) || '(无输出)')
  append(cwd, {
    who: 'act', sid, text: summary, tool: name, type: 'tool/result',
    callId, status: isError ? 'error' : 'completed', evidence, files,
    eventKey: `tool:${sid || ''}:${keyId}:result`,
    source: { type: 'hook.post_tool', callId },
  })
  if (!isError) {
    for (const file of files) {
      const { before, after } = file
      if (before && before.state === 'saved' && after.state === 'saved' && before.sha256 === after.sha256) continue
      if (after.state !== 'saved' && !(after.state === 'missing' && before && before.state === 'saved')) continue
      append(cwd, {
        who: 'act', sid, ws: wsOf(cwd), text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${name} 已完成；版本 ${after.sha256 || 'missing'}`,
        tool: name, type: 'artifact', artifact: true, path: file.path, versions: file,
        eventKey: `tool:${sid || ''}:${keyId}:artifact:${file.path}`,
        source: { type: 'hook.observation', callId },
      })
    }
  }
}

function replayArtifacts(store) {
  const keys = new Set(store.records.filter(Boolean).map((r) => r.eventKey).filter(Boolean))
  let added = 0
  for (const r of store.records) {
    if (!r || r.type !== 'tool/result' || r.status === 'error' || !Array.isArray(r.files)) continue
    for (const file of r.files) {
      const key = `${r.eventKey}:artifact:${file.path}`
      if (keys.has(key)) continue
      const before = file.before || { state: 'unknown' }
      const after = file.after || { state: 'unknown' }
      if (before.state === 'saved' && after.state === 'saved' && before.sha256 === after.sha256) continue
      if (after.state !== 'saved' && !(after.state === 'missing' && before.state === 'saved')) continue
      const ok = append(process.cwd(), {
        who: 'act', sid: r.sid, ws: r.ws, text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${r.tool} 已完成；版本 ${after.sha256 || 'missing'}`,
        tool: r.tool, type: 'artifact', artifact: true, path: file.path, versions: file,
        eventKey: key, source: { type: 'hook.observation', callId: r.callId, replayed: true },
      })
      if (ok === 0) { added += 1; keys.add(key) }
    }
  }
  return added
}

function writeOut(obj) {
  try { process.stdout.write(JSON.stringify(obj)) } catch {}
}

function runHook() {
  const raw = readStdin()
  let p = {}
  try { p = JSON.parse(raw) } catch { diag('hook 输入不是 JSON'); return }
  const ev = p.hook_event_name || ''
  const cwd = p.cwd || process.env.CODEBUDDY_PROJECT_DIR || process.cwd()
  const sid = p.session_id || null

  if (ev === 'SessionStart') {
    let store = null
    try {
      store = indexStore(ROOT, cfg.arrivalEpisodes)
      if (store) store.marks = readMarks()
    } catch {}
    writeOut({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: arriveBlock(store || openStore()) } })
    maybeIndex()
    maybeMaintenance()
    return
  }

  if (ev === 'UserPromptSubmit') {
    const prompt = String(p.prompt || '').trim()
    if (!prompt) return
    if (prompt.startsWith('/') && prompt.length < 40) return
    if (!tokenize(prompt).length) return
    const messageID = p.message_id || p.prompt_id || null
    append(cwd, {
      who: 'he', sid, text: prompt, type: 'user/message', messageID,
      eventKey: messageID ? `user:${sid || ''}:${messageID}` : null,
      source: { type: 'hook.user_prompt', messageID },
    })
    let hits = null
    try { hits = primeFromIndex(prompt, { max: cfg.primeMax, excludeSid: sid, freshMin: cfg.primeFreshMin }) } catch {}
    if (hits === null) {
      const store = openStore()
      if (!store) return
      hits = prime(store, prompt, { max: cfg.primeMax, excludeSid: sid, maxDf: cfg.primeMaxDf, freshMin: cfg.primeFreshMin })
    }
    const block = primeBlock(hits)
    if (block) writeOut({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block } })
    return
  }

  if (ev === 'PreToolUse') {
    recordToolCall(p, cwd, sid)
    return
  }

  if (ev === 'PostToolUse') {
    recordToolResult(p, cwd, sid)
    return
  }

  if (ev === 'Stop') {
    let text = String(p.last_assistant_message || '').trim()
    if (!text && p.transcript_path) text = tailTranscript(p.transcript_path)
    if (!text) return
    const messageID = p.message_id || p.assistant_message_id || null
    append(cwd, {
      who: 'me', sid, text, type: 'assistant/message', messageID,
      eventKey: messageID ? `assistant:${sid || ''}:${messageID}` : null,
      source: { type: 'hook.stop', messageID },
    })
    return
  }
}

// ————————————————————— CLI —————————————————————

const argv = process.argv.slice(2)
const flags = { full: false, limit: null, key: null, ws: null }
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--full') flags.full = true
  else if (a === '--limit') flags.limit = Number(argv[++i]) || null
  else if (a === '--key') flags.key = argv[++i] || null
  else if (a === '--ws') flags.ws = (argv[++i] || '').toLowerCase()
  else rest.push(a)
}

const [cmd, ...args] = rest
const here = process.cwd()

if (cmd === 'hook') {
  try { runHook() } catch (e) { diag('hook 异常：' + (e && e.stack ? e.stack : e)) }
  process.exit(0)
}

if (!cmd || cmd === '-h' || cmd === '--help') {
  console.log(`self-memory —— 我自己的长期记忆

  node mem.mjs stats                       规模 / 时间跨度 / 最近几段
  node mem.mjs episodes [n]                最近 n 段
  node mem.mjs recall <一句话|#段号|日期>   按意思回想 / 唤醒整段
  node mem.mjs trace  <一句话>             按字查：谁说的、第几行
  node mem.mjs remember <要记住的事>       特意记下（--key 名字）
  node mem.mjs arrive                      醒来块
  node mem.mjs ws                          各工作区各记了多少
  node mem.mjs dump [n]                    最近 n 条原始记录
  node mem.mjs show <行号|ID|证据哈希>      看完整原文 / 工具输出 / 文件版本
  node mem.mjs verify                      校验已接纳字节、正文指纹和证据
  node mem.mjs health                      一行体检
  node mem.mjs sync                        检查后接纳历史基线/合法尾部
  node mem.mjs replay                      从工具结果重建缺失的产物索引
  node mem.mjs maintenance --due            校验 + 快照（默认 12 小时一次）
  node mem.mjs maintenance --backup
  node mem.mjs maintenance --verify
  node mem.mjs maintenance --prune          默认只试算
  node mem.mjs index build                  重建派生检索索引（SQLite FTS）

  参数：--ws <工作区子串>  --limit n  --full
  数据：${STREAM}`)
  process.exit(0)
}

if (cmd === 'maintenance') {
  const r = spawnSync(process.execPath, [MEMAINT, ...args], { stdio: 'inherit', windowsHide: true, env: process.env })
  process.exit(r.status || 0)
}

if (cmd === 'index') {
  const store = openStore()
  if (!store) { console.log('（没有记忆流，先聊几句再建索引）'); process.exit(0) }
  const r = buildIndex(ROOT, store, tokenize)
  try { if (existsSync(INDEX_LOCK)) unlinkSync(INDEX_LOCK) } catch {}
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}

if (cmd === 'remember') {
  const text = args.join(' ').trim()
  if (!text) { console.log('要记什么？'); process.exit(1) }
  const rec = remember(here, text, flags.key)
  console.log(`记下了（${dayOf(rec.ts)} ${clockOf(rec.ts)}${rec.key ? ' 键=' + rec.key : ''}）：${text}`)
  process.exit(0)
}

const store = openStore()
if (!store) {
  console.log(`还没有记忆：${STREAM}\n（hook 生效后，第一句话开始就会自己落盘）`)
  process.exit(0)
}

// 工作区过滤
const keep = (d) => !flags.ws || String(d.ws || '').toLowerCase().includes(flags.ws)
const filteredEps = () => (flags.ws ? store.episodes.filter((e) => String(e.ws || '').toLowerCase().includes(flags.ws)) : store.episodes)

function ledgerHealth() {
  const v = integrity.verify()
  const rows = store.records.filter(Boolean)
  const blobs = verifyBlobs(ROOT, rows)
  const problems = [...v.problems, ...blobs.problems]
  return { status: problems.length ? 'BAD' : v.status, problems, blobs: blobs.checked,
    noHash: rows.filter((r) => !r.hash).length }
}

switch (cmd) {
  case 'stats': {
    const docs = store.docs.filter((d) => d && keep(d))
    const says = docs.filter((d) => d.who === 'he' || d.who === 'me')
    const acts = docs.filter((d) => d.who === 'act')
    const eps = filteredEps()
    let bytes = 0
    try { bytes = statSync(STREAM).size } catch {}
    console.log(`库：${STREAM}`)
    console.log(`记录 ${docs.length} 条（原话 ${says.length}，动作 ${acts.length}）· 段 ${eps.length} · 词 ${store.postings.size} · ${kb(bytes)} · 记下 ${store.marks.length}${flags.ws ? ` · 只看〔${flags.ws}〕` : ''}`)
    console.log(`账本 ${ledgerHealth().status}`)
    if (eps.length) console.log(`从 ${dayOf(Math.min(...eps.map((e) => e.startTs)))} 到 ${dayOf(Math.max(...eps.map((e) => e.endTs)))}`)
    for (const e of eps.slice(-(flags.limit || 6))) {
      console.log(` #${String(e.id).padStart(2)} ${dayOf(e.startTs)} ${clockOf(e.startTs)}  ${String(e.turns).padStart(2)} 回合  显著 ${e.salience.toFixed(2)}  ${String(e.domain).padEnd(8)} ${e.ws ? '〔' + e.ws + '〕' : ''}${e.title}`)
    }
    break
  }

  case 'verify': {
    const h = ledgerHealth()
    console.log(`ledger=${h.status} · 记录 ${store.records.length} · 证据 ${h.blobs} · 老记录无指纹 ${h.noHash} · 异常 ${h.problems.length}`)
    for (const p of h.problems.slice(0, 10)) console.log(JSON.stringify(p))
    if (h.status !== 'OK') process.exitCode = 1
    break
  }

  case 'health': {
    const h = ledgerHealth()
    let bytes = 0
    try { bytes = statSync(STREAM).size } catch {}
    console.log(`[memory] ${dayOf(Date.now())} 记录 ${store.records.length} · 原话 ${store.docs.filter((d) => d && (d.who === 'he' || d.who === 'me')).length} · 段 ${store.episodes.length} · ${kb(bytes)} · 记下 ${store.marks.length}`)
    console.log(`账本 ${h.status} · 异常 ${h.problems.length} · 证据 ${h.blobs} 个 · 老记录无指纹 ${h.noHash} · ${ROOT}`)
    if (h.status !== 'OK') process.exitCode = 1
    break
  }

  case 'sync': {
    const v = integrity.sync()
    console.log(`已接纳：ledger=${v.status} · 记录 ${store.records.length}`)
    break
  }

  case 'replay': {
    console.log(`重建 ${replayArtifacts(store)} 条产物索引（重复执行不会重复写）`)
    break
  }

  case 'show': {
    const ref = String(args[0] || '').replace(/^#/, '')
    if (!ref) { console.log('要给行号、记录 ID 或 64 位证据哈希'); break }
    if (/^[a-f0-9]{64}$/.test(ref)) {
      try { console.log(readBlob(ROOT, ref).toString('utf8')) } catch (e) { console.log('（证据读不出来：' + e.message + '）') }
      break
    }
    const rec = /^\d+$/.test(ref) ? store.records[Number(ref)] : store.records.find((r) => r && r.id === ref)
    if (!rec) { console.log('（没有这条记录）'); break }
    console.log(JSON.stringify({ ...rec, text: undefined }, null, 2))
    console.log(String(rec.text || ''))
    break
  }

  case 'ws': {
    const by = new Map()
    for (const d of store.docs) {
      if (!d || (d.who !== 'he' && d.who !== 'me')) continue
      const k = d.ws || '（未知）'
      const v = by.get(k) || { says: 0, last: 0 }
      v.says += 1
      v.last = Math.max(v.last, d.ts)
      by.set(k, v)
    }
    if (!by.size) { console.log('（还没有原话）'); break }
    for (const [k, v] of [...by].sort((a, b) => b[1].last - a[1].last)) {
      console.log(`${k.padEnd(28)} ${String(v.says).padStart(4)} 句 · 最后 ${dayOf(v.last)} ${clockOf(v.last)}`)
    }
    break
  }

  case 'episodes': {
    const n = Number(args[0]) || flags.limit || 20
    for (const e of filteredEps().slice(-n)) {
      console.log(`#${String(e.id).padStart(2)} ${dayOf(e.startTs)} ${clockOf(e.startTs)}–${clockOf(e.endTs)}  ${String(e.turns).padStart(2)} 回合  显著 ${e.salience.toFixed(2)}  ${String(e.domain).padEnd(8)} ${e.ws ? '〔' + e.ws + '〕' : ''}${e.title}`)
    }
    break
  }

  case 'recall': {
    const arg = args.join(' ').trim()
    if (!arg) { console.log('要给一句话、#段号 或日期'); break }

    if (/^#?\d+$/.test(arg)) {
      const ep = store.episodes[Number(arg.replace('#', ''))]
      if (!ep) { console.log(`没有 #${arg.replace('#', '')}（现在 0–${store.episodes.length - 1}）`); break }
      console.log(`#${ep.id} ${dayOf(ep.startTs)} ${clockOf(ep.startTs)}–${clockOf(ep.endTs)} · ${ep.turns} 回合 · 显著 ${ep.salience.toFixed(2)} · ${ep.domain}${ep.ws ? ' · 〔' + ep.ws + '〕' : ''}`)
      console.log(`会话 ${ep.sid || '?'} · 行 ${ep.from}–${ep.to}`)
      console.log('')
      console.log(renderEpisode(store, ep, { full: flags.full }))
      break
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const hit = filteredEps().filter((e) => dayOf(e.startTs) === arg || dayOf(e.endTs) === arg)
      if (!hit.length) { console.log(`（${arg} 那天没有记录）`); break }
      for (const ep of hit.slice(0, 3)) {
        console.log(`#${ep.id} ${dayOf(ep.startTs)} ${clockOf(ep.startTs)} · 显著 ${ep.salience.toFixed(2)} · ${ep.title}`)
        console.log(renderEpisode(store, ep))
        console.log('')
      }
      break
    }

    const hits = search(store, arg, { limit: flags.limit || 8, recency: cfg.recency, ws: flags.ws })
    if (!hits.length) { console.log('（想不起来：库里没有字面对得上的）'); break }

    const groups = new Map()
    for (const h of hits) {
      const k = h.ep === null ? 'x' + h.id : 'e' + h.ep
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(h)
    }
    const top = [...groups.values()].sort((a, b) => b[0].score - a[0].score).slice(0, flags.limit ? 1 : 3)
    console.log(`（命中 ${hits.length} 条，按段聚合；要全段：recall #段号）`)
    for (const g of top) {
      const first = g[0]
      const ep = first.ep === null ? null : store.episodes[first.ep]
      if (ep) console.log(`\n#${ep.id} ${dayOf(ep.startTs)} ${clockOf(ep.startTs)} · ${ep.turns} 回合 · 显著 ${ep.salience.toFixed(2)} · ${ep.domain}${ep.ws ? ' · 〔' + ep.ws + '〕' : ''} · ${ep.title}`)
      for (const h of g) {
        const d = store.docs[h.id]
        if (!d) continue
        const body = d.who === 'act'
          ? `〔${mdOf(d.ts)} ${clockOf(d.ts)}〕动作（行${h.id}）：${squeeze(d.tool || d.text, 160)}`
          : `〔${mdOf(d.ts)} ${clockOf(d.ts)}〕${whoName(d.who)}（行${h.id}）：${squeeze(d.text, flags.full ? 4000 : 400)}`
        console.log('  ' + body)
      }
      if (ep) {
        const total = tracesOf(store.docs, ep).length
        const shown = g.filter((h) => store.docs[h.id] && store.docs[h.id].who !== 'act').length
        if (total > shown) console.log(`  （这段共 ${total} 句原话，还有 ${total - shown} 句没展开：recall #${ep.id}）`)
      }
    }
    break
  }

  case 'trace': {
    const arg = args.join(' ').trim()
    if (!arg) { console.log('要给一句话'); break }
    if (normTrace(arg).length < 3) { console.log('按字查至少要 3 个字（两字的词没有区分度）'); break }
    const r = traceHits(store, arg, flags.ws)
    if (!r.mode) {
      console.log(`按字没查到「${arg}」——库里一字不差地没有这句。\n（要意思相近用 recall。）`)
      break
    }
    const kind = (h) => (h.d.who === 'he' ? (h.forwarded ? '用户贴回的（转发）' : '用户说的') : h.d.who === 'me' ? '我说的' : h.d.who === 'act' ? '只是操作' : '元信息')
    const by = {}
    for (const h of r.hits) by[kind(h)] = (by[kind(h)] || 0) + 1
    console.log(`按字查到 ${r.hits.length} 处（${r.mode === 'exact' ? '原样命中' : '去引号后命中'}）`)
    console.log('归属：' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · '))
    console.log('')
    for (const h of r.hits.slice(0, flags.limit || 20)) {
      const ep = store.episodeAt(h.id)
      console.log(`${String(h.id).padStart(4)} 行  ${dayOf(h.d.ts)} ${clockOf(h.d.ts)}  ${kind(h)}${ep ? ' #' + ep.id : ''}${h.d.ws ? ' 〔' + h.d.ws + '〕' : ''}`)
      console.log('       ' + squeeze(h.d.text, 300))
    }
    if (r.hits.length > (flags.limit || 20)) console.log(`（还有 ${r.hits.length - (flags.limit || 20)} 处，--limit 调节）`)
    break
  }

  case 'arrive': {
    console.log(arriveBlock(store))
    break
  }

  case 'prime': {
    const arg = args.join(' ').trim()
    console.log(primeBlock(prime(store, arg, { max: cfg.primeMax, maxDf: cfg.primeMaxDf })) || '（没有浮上来的）')
    break
  }

  case 'dump': {
    const n = Number(args[0]) || flags.limit || 15
    const docs = store.docs
    for (let i = Math.max(0, docs.length - n); i < docs.length; i++) {
      const d = docs[i]
      if (!d) continue
      console.log(`${String(i).padStart(4)} ${dayOf(d.ts)} ${clockOf(d.ts)} ${String(d.who || '-').padEnd(4)} ${d.ws ? '〔' + d.ws + '〕' : ''}${squeeze(d.text, 130)}`)
    }
    break
  }

  default:
    console.log(`不认识的命令：${cmd}（--help 看用法）`)
}
