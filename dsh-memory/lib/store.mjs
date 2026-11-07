// 记忆的存储层：一条只增不改的「流」，加一份可以从流重建的索引。
//
// 为什么是「一条流」：
//   人回忆时会改写细节，但**证据不会凭空出现**。这套系统里，发生过的事只有一份原始记录
//   （stream.jsonl，只追加，永不改写）；所有摘要、标题、显著度都是**派生**的，
//   删掉重算不会丢东西。之前那套失败就失败在这里——摘要替掉了原话，
//   表情从 151 个掉到 68 个，身份跟着变淡。
//
// 为什么索引可以重建：
//   索引坏了、版本升了、想改排序——把 state.json 删掉重算就行，数据不受影响。

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  openSync, readSync, closeSync, statSync, renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { termFreq, headline, tokenize } from './tokenize.mjs'
import { episodeSalience, isClosing, isTransition, domainOf } from './signal.mjs'
import { createIntegrity, sha256, verifyBlobs, scan } from './evidence.mjs'

// 切段规则一改就得加这个号：让旧索引作废，重新切一遍。
// 第 4 版：段带上了 sid（哪场对话），预激活才能排除「当前这场」。
// 第 5 版：分词改了（带点的数字串整体成词），旧索引里的词是切碎的，必须重算。
// 第 6 版：分词又改了（v0.2.13.6 ≡ 0.2.13.6，全角先 NFKC），
//         postings 本来就是每次启动从 stream 重算的，但旧 state 里的段还是按老词切的，
//         一起作废，省得「一半新一半旧」。
const STATE_VERSION = 6
// 内存里只留够检索用的前缀，全文按偏移回读
const INDEX_CHARS = 1600

export class Ledger {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.meetingGapMs = opts.meetingGapMs ?? 2 * 60 * 60 * 1000
    this.maxTurnsPerEpisode = opts.maxTurnsPerEpisode ?? 14
    this.minTurnsPerEpisode = opts.minTurnsPerEpisode ?? 4
    // 一段太长了就切：回忆一次能摊开的量，大概就是几千字。
    // 光按「轮」切不够——同样 14 轮，聊天是 14 句，干活是 14 大段。
    this.maxCharsPerEpisode = opts.maxCharsPerEpisode ?? 3200

    this.streamPath = join(dir, 'stream.jsonl')
    this.statePath = join(dir, 'state.json')
    this.marksPath = join(dir, 'marks.jsonl')
    // 序号账本单独放：它是「事实」不是缓存。
    // 混在 state.json 里的话，索引一作废、序号也跟着忘，回填就会把旧会话重倒一遍。
    this.seqsPath = join(dir, 'seqs.json')
    this.integrity = createIntegrity(dir, ['stream.jsonl', 'marks.jsonl'])
    this._eventKeys = new Set()

    this.docs = []            // 按行号索引
    this.postings = new Map() // term -> [docId, tf, docId, tf, ...]
    this.docLen = []
    this.totalLen = 0
    this.episodes = []
    this.marks = []
    this.meta = {}            // 别处要持久化的小东西（比如冻结下来的身份锚）
    this.seqs = {}            // sid -> 已收到最大的事件序号（实时收的和回填的去重）
    this._recent = new Map()  // 内容指纹 -> 时间（换插件、重开、多个实例抢写时兜底去重）
    this.bytes = 0
    this._fd = null
    this._dirty = false
  }

  // ——— 打开 ———
  open() {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.streamPath)) writeFileSync(this.streamPath, '', 'utf8')
    this._loadMarks()

    const onDisk = statSync(this.streamPath).size
    let state = null
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (raw && raw.v === STATE_VERSION) state = raw
    } catch {}

    const usable = !!state && state.streamBytes === onDisk
    if (usable) {
      this.episodes = state.episodes || []
      this.meta = state.meta || {}
    }
    // meta 跟「state 里的段落在磁盘上还对不对得上」没关系，别跟着一起丢。
    // 踩过的：只要流比上次保存时长了一点（几乎每次开会话都长），usable 就是 false，
    // 于是 meta.anchor 被当成过期数据扔掉，回头 saveState 又把空的写回去——
    // 结果是锚**每次都重算**，日志里一直显示「新算」，而设计上它该被沿用。
    if (state && state.meta) this.meta = state.meta
    this._loadSeqs(state)

    this._scanStream()
    this.bytes = onDisk
    if (!usable) this.seal(true)
    return this
  }

  _loadMarks() {
    this.marks = []
    try {
      const txt = readFileSync(this.marksPath, 'utf8')
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        try { this.marks.push(JSON.parse(line)) } catch {}
      }
    } catch {}
  }

  _loadSeqs(state) {
    this.seqs = {}
    try {
      const j = JSON.parse(readFileSync(this.seqsPath, 'utf8'))
      if (j && typeof j === 'object') this.seqs = j
    } catch {}
    if (!Object.keys(this.seqs).length && state && state.seqs) this.seqs = state.seqs
  }

  _saveSeqs() {
    const tmp = this.seqsPath + '.tmp'
    try {
      // 和盘上已有的合并（每个 sid 取大的），不要整份覆盖。
      // 换文件、两个实例并行、或者一边回填一边实时写的时候，各自只知道见过的那几个 sid；
      // 直接覆盖会把别人记的序号抹掉，下一轮回填就整段重倒——这正是 seqs 单独成文件要防的事。
      let disk = {}
      try { disk = JSON.parse(readFileSync(this.seqsPath, 'utf8')) || {} } catch {}
      for (const [sid, seq] of Object.entries(this.seqs)) {
        if (typeof seq === 'number' && !(typeof disk[sid] === 'number' && disk[sid] >= seq)) disk[sid] = seq
      }
      this.seqs = disk
      writeFileSync(tmp, JSON.stringify(this.seqs), 'utf8')
      renameSync(tmp, this.seqsPath)
    } catch {}
  }

  _scanStream() {
    this.docs = []
    this.postings = new Map()
    this.docLen = []
    this.totalLen = 0
    let buf
    try { buf = readFileSync(this.streamPath) } catch { buf = Buffer.alloc(0) }
    let off = 0
    while (off < buf.length) {
      const nl = buf.indexOf(10, off)
      if (nl === -1) break
      const start = off
      const bytes = nl - start + 1
      const line = buf.subarray(start, nl).toString('utf8')
      off = nl + 1
      if (!line.trim()) { this.docs.push(null); continue }
      let d
      try { d = JSON.parse(line) } catch { this.docs.push(null); continue }
      if (d && d.eventKey) this._eventKeys.add(d.eventKey)
      this._indexDoc(d, start, bytes)
    }
    // 拿流尾巴把「最近说过什么」预热一遍：
    // 插件重装那一刻会有两个实例并行，新实例如果从空的去重表开始，
    // 它一开库就把旧会话重倒一遍，于是同一句话进两次。
    const tail = Math.max(0, this.docs.length - 300)
    for (let i = tail; i < this.docs.length; i++) {
      const d = this.docs[i]
      if (!d || !d.text) continue
      if (d.who !== 'he' && d.who !== 'me') continue
      const text = d.text
      this._recent.set(`${d.who}|${d.sid || ''}|${text.length}|${text.slice(0, 48)}|${text.slice(-24)}`, Date.now())
    }
  }

  _indexDoc(d, off, bytes) {
    const id = this.docs.length
    const text = String(d.text || '').slice(0, INDEX_CHARS)
    this.docs.push({
      who: d.who || null, ts: d.ts || 0, sid: d.sid || null,
      turn: d.turn ?? null, tool: d.tool || null, text, off, bytes, type: d.type || null,
      id: d.id || null, eventKey: d.eventKey || null, messageID: d.messageID || null,
      turnID: d.turnID || null, hash: d.hash || null, evidence: d.evidence || null,
      versions: d.versions || null, status: d.status || null, artifact: !!d.artifact,
    })
    let len = 0
    for (const [term, tf] of termFreq(text)) {
      let arr = this.postings.get(term)
      if (!arr) { arr = []; this.postings.set(term, arr) }
      arr.push(id, tf)
      len += tf
    }
    this.docLen[id] = len || 1
    this.totalLen += len || 1
    return id
  }

  // ——— 写入：只追加 ———
  //
  // opts.dedupe=false 用于**回填**：回填是一口气把几年的记录写进来，
  // 写进来的时刻全都一样，于是「十分钟内说过两遍」这种判断会误伤——
  // 同一句「晚安」隔了三天说两次，在回填里就变成「刚才说过」，被吞掉。
  // 回填本来就有 seq 去重，不需要这一层。
  append(rec, opts = {}) {
    const text = String(rec.text || '')
    if (!text) return -1
    // 来源事件 ID 优先：同一事件重放多少次都只落一条。
    if (rec.eventKey && this._eventKeys.has(rec.eventKey)) return -1

    // 只有「说的话」才去重，动手不去重。
    // 同一句工具调用重复出现，多半是真的又跑了一遍（重试、复测）——
    // 那是经历，删掉就是让记忆说谎。
    const speech = rec.who === 'he' || rec.who === 'me'
    const dedupe = opts.dedupe !== false && !rec.eventKey
    const fp = speech && dedupe
      ? `${rec.who}|${rec.sid || ''}|${text.length}|${text.slice(0, 48)}|${text.slice(-24)}`
      : null
    const winMs = text.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
    if (fp) {
      const at = this._recent.get(fp)
      const now = Date.now()
      if (at && now - at < winMs) return -1
    }

    const d = {
      ts: rec.ts || Date.now(),
      who: rec.who || null,
      sid: rec.sid || null,
      turn: rec.turn ?? null,
      text,
      tool: rec.tool || null,
      type: rec.type || null,
      hash: sha256(text),
    }
    for (const key of ['id', 'eventKey', 'messageID', 'turnID', 'source', 'evidence', 'versions', 'files', 'status', 'artifact', 'completion', 'callId', 'path']) {
      if (rec[key] !== undefined && rec[key] !== null) d[key] = rec[key]
    }
    const line = JSON.stringify(d)
    const bytes = Buffer.byteLength(line, 'utf8') + 1

    // 别的会话可能也在写同一个流：发现对不上就整个重新对齐。
    // 注意要连段一起重切——文档下标变了，旧段的位置就全错位了。
    let onDisk = 0
    try { onDisk = statSync(this.streamPath).size } catch {}
    if (onDisk !== this.bytes) {
      this.bytes = onDisk
      this._scanStream()
      this.episodes = []
      this.seal(true)
    }

    const off = this.bytes
    appendFileSync(this.streamPath, line + '\n', 'utf8')
    this.bytes += bytes
    if (d.eventKey) this._eventKeys.add(d.eventKey)
    const id = this._indexDoc(d, off, bytes)
    // 记「写进来的时刻」，不是事件本身的时刻。
    // 用事件时间会失效：重装时回填的旧事件，时间戳是几小时前的，
    // 一比较就永远「不算重复」。
    if (fp) this._recent.set(fp, Date.now())
    if (this._recent.size > 4000) {
      const cut = Date.now() - 10 * 60 * 1000
      for (const [k, v] of this._recent) if (v < cut) this._recent.delete(k)
      if (this._recent.size > 6000) this._recent.clear()
    }
    try { this.integrity.record('stream.jsonl') } catch (e) { this._lastIntegrityError = e && e.message }
    this._dirty = true
    return id
  }

  // ——— 全文回读（索引里只留前缀）———
  fullText(id) {
    const d = this.docs[id]
    if (!d) return ''
    if (d.text.length < INDEX_CHARS) return d.text
    try {
      if (this._fd === null) this._fd = openSync(this.streamPath, 'r')
      const buf = Buffer.alloc(d.bytes)
      readSync(this._fd, buf, 0, d.bytes, d.off)
      const rec = JSON.parse(buf.toString('utf8'))
      return String(rec.text || '')
    } catch { return d.text }
  }

  // 完整记录（含来源、证据哈希、前后版本）。索引里只有前缀，正文按偏移回读。
  fullRecord(id) {
    const d = this.docs[id]
    if (!d) return null
    try {
      if (this._fd === null) this._fd = openSync(this.streamPath, 'r')
      const buf = Buffer.alloc(d.bytes)
      readSync(this._fd, buf, 0, d.bytes, d.off)
      return JSON.parse(buf.toString('utf8'))
    } catch { return { ...d } }
  }

  rows() {
    return scan(this.streamPath).rows
  }

  // 校验已接纳字节、正文指纹和证据 blob。OK 不证明内容真实或基线之前没丢过。
  verify() {
    let result
    try { result = this.integrity.verify() } catch (e) {
      result = { ok: false, status: 'BUSY', problems: [{ reason: e.message }], files: {} }
    }
    const rows = this.rows()
    const blobs = verifyBlobs(this.dir, rows)
    const problems = [...result.problems, ...blobs.problems]
    return { ...result, ok: result.ok && !problems.length,
      status: problems.length ? 'BAD' : result.status, problems, blobs: blobs.checked,
      noHash: rows.filter((r) => !r.hash).length }
  }

  sync() {
    return this.integrity.sync()
  }

  health() {
    const s = this.stats()
    const v = this.verify()
    return { ...s, ledger: v.status, problems: v.problems.length, blobs: v.blobs, noHash: v.noHash }
  }

  // 从已落盘的工具结果重建缺失的产物索引。重复执行不会重复写。
  replay() {
    const rows = this.rows()
    const keys = new Set(rows.map((r) => r.eventKey).filter(Boolean))
    let added = 0
    for (const r of rows) {
      if (r.type !== 'tool/result' || r.status === 'error' || !Array.isArray(r.files)) continue
      for (const file of r.files) {
        const key = `${r.eventKey}:artifact:${file.path}`
        if (keys.has(key)) continue
        const before = file.before || { state: 'unknown' }
        const after = file.after || { state: 'unknown' }
        if (before.state === 'saved' && after.state === 'saved' && before.sha256 === after.sha256) continue
        if (after.state !== 'saved' && !(after.state === 'missing' && before.state === 'saved')) continue
        const id = this.append({
          who: 'act', ts: r.ts, text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${r.tool} 已完成；版本 ${after.sha256 || 'missing'}`,
          tool: r.tool, type: 'artifact', artifact: true, path: file.path, versions: file,
          eventKey: key, source: { type: 'tool.observation', callID: r.callId, replayed: true },
        })
        if (id >= 0) { added += 1; keys.add(key) }
      }
    }
    return added
  }

  // ——— 切段 ———
  // 只重算尾巴：已经封好的段不动。否则每次醒来编号全变，回忆就串了。
  seal(saveNow = false) {
    const rescanFrom = this.episodes.length ? this.episodes[this.episodes.length - 1].from : 0
    const kept = this.episodes.slice(0, Math.max(0, this.episodes.length - 1))

    const tail = []
    let cur = null
    let prevTs = 0
    let prevUserToks = null

    const closeCur = () => {
      // 一轮也算一段。以前卡在 2 轮，于是「最后他问了一句、我还没回」这种
      // 正好在最边上的内容，流里有、却既不能被回忆也不能被预激活——
      // 而那恰恰是最该记得住的一句。
      if (cur && cur.turns >= 1) tail.push(cur)
      cur = null
    }

    for (let i = rescanFrom; i < this.docs.length; i++) {
      const d = this.docs[i]
      if (!d) continue
      if (d.who !== 'he' && d.who !== 'me') continue

      const gap = prevTs ? d.ts - prevTs : 0
      const newMeeting = prevTs > 0 && gap > this.meetingGapMs
      // 换了一场对话 = 换了一次见面。哪怕只隔了十秒。
      const newSession = !!(cur && cur.sid && d.sid && cur.sid !== d.sid)
      const closed = d.who === 'he' && isClosing(d.text)
      const shift = d.who === 'he' && isTransition(d.text)

      // 换了个话题：他这句和前一句说的几乎是两批字
      let drift = false
      if (d.who === 'he' && d.text.length >= 8 && prevUserToks && cur && cur.turns >= this.minTurnsPerEpisode) {
        const toks = new Set(tokenize(d.text))
        let inter = 0
        for (const t of toks) if (prevUserToks.has(t)) inter += 1
        const ratio = inter / Math.max(1, Math.min(toks.size, prevUserToks.size))
        if (ratio < 0.05) drift = true
      }
      if (d.who === 'he' && d.text.length >= 2) prevUserToks = new Set(tokenize(d.text))

      let cut = false
      if (!cur) cut = true
      else if (newSession) cut = true
      else if (newMeeting) cut = true
      else if (closed && cur.turns >= 3) cut = true
      else if (shift && cur.turns >= this.minTurnsPerEpisode) cut = true
      else if (drift) cut = true
      else if (cur.turns >= this.maxTurnsPerEpisode) cut = true
      else if ((cur.chars || 0) + d.text.length > this.maxCharsPerEpisode) cut = true

      if (cut) {
        closeCur()
        cur = { from: i, to: i, kind: 'episode', startTs: d.ts, endTs: d.ts, turns: 0, chars: 0, sid: d.sid || null, newMeeting }
      }
      if (!cur.sid && d.sid) cur.sid = d.sid
      cur.to = i
      cur.endTs = d.ts
      cur.turns += 1
      cur.chars = (cur.chars || 0) + d.text.length
      // 时间戳可能倒序（补写的旧记录），别让 prevTs 往回跳，否则下一次间隔算成负数
      prevTs = Math.max(prevTs, d.ts)
    }
    closeCur()

    // 只有尾巴那几段要重算统计；已经封好的段原样留下，只重新编号。
    // （以前是把所有段都 _annotate 一遍，每次 turn/end 都要把整条线的原文再扫一次，
    //   会话一长就越来越慢——这是那种平时看不出来、越用越卡的 bug。）
    const annotated = tail.map((e) => this._annotate(e))
    this.episodes = kept.concat(annotated).map((e, i) => (e.id === i ? e : { ...e, id: i }))
    if (saveNow || this._dirty) this.saveState()
    return this.episodes.length
  }

  _annotate(ep) {
    const traces = this.tracesOf(ep)
    const { emotion, salience, turns } = episodeSalience(traces)
    // 标题取「他说的第一句像样的话」——只有图、只有占位符的跳过
    const good = (s) => String(s || '').replace(/\[图×\d+\]/g, '').replace(/\s+/g, '').length >= 6
    const firstHe = traces.find((t) => t.who === 'he' && good(t.text))
    const src = firstHe ? firstHe.text : ((traces.find((t) => good(t.text)) || traces[0] || {}).text || '')
    return {
      ...ep,
      from: ep.from,
      to: ep.to,
      kind: 'episode',
      startTs: ep.startTs,
      endTs: ep.endTs,
      newMeeting: !!ep.newMeeting,
      sid: ep.sid || (this.docs[ep.from] && this.docs[ep.from].sid) || null,
      chars: ep.chars || 0,
      title: ep.title || headline(src, 30),
      turns: turns || ep.turns || 0,
      salience: Math.max(salience || 0, ep.salience || 0),
      emotion: Math.max(emotion || 0, ep.emotion || 0),
      rehearsals: ep.rehearsals || 0,
      lastHit: ep.lastHit || 0,
      // 用途分类：只用标题 + 用户第一句话判，避免把助手的解释也算进去。
      // 这是索引层字段，重算安全（改规则后重建 state.json 即可）。
      domain: ep.domain || domainOf((ep.title || '') + ' ' + src),
    }
  }

  tracesOf(ep, limit = Infinity) {
    const out = []
    for (let i = ep.from; i <= ep.to && out.length < limit; i++) {
      const d = this.docs[i]
      if (!d) continue
      if (d.who !== 'he' && d.who !== 'me') continue
      out.push({ id: i, who: d.who, ts: d.ts, text: d.text })
    }
    return out
  }

  episodeAt(docId) {
    for (let i = this.episodes.length - 1; i >= 0; i--) {
      const e = this.episodes[i]
      if (docId >= e.from && docId <= e.to) return e
    }
    return null
  }

  // ——— 显式记下 ———
  mark({ key, text, weight = 1 }) {
    const body = String(text || '')
    const rec = { ts: Date.now(), key: key || null, text: body, weight,
      id: sha256(Date.now() + '|' + (key || '') + '|' + body).slice(0, 16), hash: sha256(body) }
    appendFileSync(this.marksPath, JSON.stringify(rec) + '\n', 'utf8')
    this.marks.push(rec)
    try { this.integrity.record('marks.jsonl') } catch (e) { this._lastIntegrityError = e && e.message }
    this.saveState()
    return rec
  }

  // 同一个 key 只认最新的（旧的留着，标成被取代——像人改主意，但旧的那句话还在）
  facts() {
    const byKey = new Map()
    const loose = []
    for (const m of this.marks) {
      if (!m.key) { loose.push(m); continue }
      const prev = byKey.get(m.key)
      byKey.set(m.key, { ...m, supersedes: prev ? prev.text : null })
    }
    return [...byKey.values(), ...loose]
  }

  saveState() {
    const tmp = this.statePath + '.tmp'
    const payload = {
      v: STATE_VERSION,
      savedAt: Date.now(),
      streamBytes: this.bytes,
      episodes: this.episodes,
      meta: this.meta,
      seqs: this.seqs,
      marks: this.marks.length,
    }
    try {
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this.statePath)
      this._dirty = false
    } catch (e) {
      this._lastSaveError = e && e.message
    }
    if (this._seqsDirty) { this._saveSeqs(); this._seqsDirty = false }
  }

  // 已经收到过的序号：实时监听和回填会撞车，靠这个去重
  seenSeq(sid, seq) {
    if (typeof seq !== 'number') return false
    const prev = this.seqs[sid]
    return typeof prev === 'number' && seq <= prev
  }

  noteSeq(sid, seq) {
    if (typeof seq !== 'number') return
    const prev = this.seqs[sid]
    if (typeof prev !== 'number' || seq > prev) {
      this.seqs[sid] = seq
      this._seqsDirty = true
      // 每 20 条刷一次盘：这个文件很小，但「忘了序号」的代价是把旧会话重倒一遍
      this._seqsN = (this._seqsN || 0) + 1
      if (this._seqsN % 20 === 0) this._saveSeqs()
    }
  }

  stats() {
    let traces = 0
    let acts = 0
    for (const d of this.docs) {
      if (!d) continue
      if (d.who === 'he' || d.who === 'me') traces += 1
      else if (d.who === 'act') acts += 1
    }
    return {
      dir: this.dir,
      bytes: this.bytes,
      docs: this.docs.length,
      traces,
      acts,
      episodes: this.episodes.length,
      terms: this.postings.size,
      marks: this.marks.length,
    }
  }

  close() {
    if (this._seqsDirty) { this._saveSeqs(); this._seqsDirty = false }
    if (this._fd !== null) { try { closeSync(this._fd) } catch {}; this._fd = null }
  }
}
