// 把「发生过的事」翻译成记忆里的一行。
//
// 会话事件长什么样、我们只关心哪几种，都在这里定。
// 关键取舍：**工具调用也要记**。那不是噪声——「我上次是这么查的」「这条命令报错了」
// 是经历的一部分。人回忆一件事的时候，记得住自己当时做了什么。

import { artifactPaths, putBlob, snapshot } from './evidence.mjs'

// 日志出口。capture 是**纯函数模块**，自己不写文件——写日志的路径、轮转、格式都在
// index.js 那边有一套了，这里再实现一遍就是两套。index.js 挂载时把 diag() 传进来。
// 默认什么都不记，所以单测里不需要 mock 也能跑。
let _log = () => {}
export function setCaptureLog(fn) { _log = typeof fn === 'function' ? fn : () => {} }

// 群里「人」的显示名。必须和 dsh-relay 的 HUMAN 常量一致（那边也有一个同样的显示名）。
// 改名的代价：群里的消息会在记忆里被当成「鱼说的」，trace 就再也查不到他说过什么——
// 这个名字写错不会报错，只会安静地少记，所以两边要同步改。
//
// 原来这里写死 '用户'：那是**功能耦合**，不是文案。群消息靠这个名字分「人说的」和
// 「别的 bot 说的」，名字对不上，人就永远进不了记忆。对外发布后别人的「人」不叫这个
// 名字，所以改成配置项：index.js 挂载（含重读配置）时用 config.humanName 调 setCaptureHuman()。
// 兜底值取中性的 'human'——代码里不许出现具体称呼，那属于用户配置。
let _humanName = 'human'
export function setCaptureHuman(name) {
  _humanName = String(name || 'human').trim() || 'human'
}

// ——— 群消息的进程内去重（2026-10-30，另一位维护者指出来的真实风险）———
// 为什么需要：gid 不落库（store 只留七个字段），所以「同一条群消息被投两次」只剩
// store 那层的 10 分钟内容指纹挡着。隔十几分钟又投一次，指纹窗口早过了，
// 记忆里就会多出一条一模一样的 he——预激活端出来就是两行重复的「你说过」。
// 键用 (消息原始 ts, 正文前 40 字)：同一个人在同一毫秒说同一句话，现实里不会发生。
// 代价：这是**进程内**的，重启就清空。它是一道补丁，不是根治——根治要靠 gid 落库，
// 那要动存储层，观察期不动。
const _relaySeen = new Set()
const RELAY_SEEN_MAX = 2000

function seenRelay(key) {
  if (_relaySeen.has(key)) return true
  _relaySeen.add(key)
  if (_relaySeen.size > RELAY_SEEN_MAX) {
    // 满了就丢掉最早的一半（Set 保插入序）：群消息一天几十条，这个容量够撑很久
    let drop = _relaySeen.size - Math.floor(RELAY_SEEN_MAX * 0.7)
    for (const k of _relaySeen) { if (drop-- <= 0) break; _relaySeen.delete(k) }
  }
  return false
}

// 这些工具的结果就是文件内容本身，记了只会污染记忆
//
// 2026-10-26 补的：`ops_grep`（dsh-ops 的 rust 搜索工具）返回的也是文件内容，
// 一个都没拦。顺手把同类的一起补上——`grep` / `glob` / `rg` 的结果都是「文件里有什么」，
// 不是「我做过什么」。文件内容随时能重读；记忆只留「我查过这件事」。
const FILE_OPS = new Set([
  'write', 'edit', 'read', 'ops_replace', 'ops_inspect_local_file', 'ops_glob', 'ops_grep',
  'grep', 'glob', 'rg',
  'todo_write', 'todo_read', 'multi_edit', 'str_replace_editor',
])

// 工具的「调用」和「结果」是两个事件，结果里不带工具名，只能自己记一下
const callNames = new Map()

// 完整保存可见文本；只有病态大的输入才截断，并留下明确标记。
const MAX_TEXT = 2 * 1024 * 1024

function fullText(s) {
  const t = String(s || '')
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…（超长截断）' : t
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw || '{}')) } catch { return {} }
}

function eventId(ctx, event) {
  if (typeof event.seq === 'number') return `${ctx.lineKey || ctx.sid || ''}:${event.seq}`
  return `${ctx.lineKey || ctx.sid || ''}:${event.type}:${event.time || ''}`
}

function noteCall(callId, name) {
  if (!callId) return
  callNames.set(callId, name)
  if (callNames.size > 500) {
    const drop = callNames.size - 400
    let i = 0
    for (const k of callNames.keys()) { if (i++ >= drop) break; callNames.delete(k) }
  }
}

function nameOfCall(callId) {
  return callNames.get(callId) || ''
}

const NOISE_PREFIX = [
  'Current runtime context.',
  'The approval policy changed',
  'Time sampled while preparing',
]

export function isNoise(text) {
  const s = String(text || '').trim()
  if (!s) return true
  return NOISE_PREFIX.some((p) => s.startsWith(p))
}

function blocksText(content) {
  if (!Array.isArray(content)) return { text: '', images: 0 }
  let images = 0
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'image') images += 1
  }
  return { text: parts.join('\n').trim(), images }
}

function clip(s, n) {
  const t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 一个会话事件 → 0..n 条记忆记录
// ctx.sid：这条事件属于哪个会话。**去重键必须带它**，否则同一个 host 进程里
// 所有线共用一个 Set，第一条线记完，别的线全被判「重复」——2026-10-31 实测踩到：
// 「重启完成」只进了另一条线，另一位维护者那条什么都没记。
export function eventToRecords(event, ctx) {
  if (!event || !event.type) return []
  const ts = event.time || Date.now()
  // 去重键里的「线身份」：**优先用线名**，没有才退回会话 id。
  // 为什么不能用 sid 当键（2026-10-31 另一位维护者点出来的）：sid 是会话 id，
  // 同一条线开个新会话，键就变了——同一批群消息会在同一条线里再记一遍。
  // 那条线的库是同一个，结果就是预激活里端出两条一模一样的话。
  const lineKey = String((ctx && (ctx.line || ctx.sid)) || '')
  const baseKey = eventId(ctx || {}, event)
  const out = []
  const data = event.data || {}
  const sourceOf = (type) => ({ type, seq: event.seq ?? null, sid: (ctx && ctx.sid) || null })

  switch (event.type) {
    case 'user/message': {
      const src = data.source && data.source.kind
      // ——— 群叫醒（source.kind === 'relay'）———
      // 2026-10-30 修的：以前这里 `if (src !== 'user') return []` 把 relay 整条丢掉了，
      // 于是「群里说的话」一条都进不了记忆。这一条线当时实测：he 停在 08:42:16Z，
      // 之后群里 5 条全没进库，而他自己在那 5 条里问过「记忆系统更新了，都同步上了吗」——
      // trace 查这句话只查到我自己命令的回声。
      //
      // 为什么不能直接把正文当他的话记：relay 的正文是**给人看的叫醒文**，
      // 开头是 300+ 字群公告，中间混着别的鱼的发言。整条记下来 = 把公告写进记忆。
      //
      // 所以只认 relay 附在 source.items 里的结构化原文（relay 侧 2026-10-30 加）：
      //   · 只取 from === 用户 的——别的鱼的话记成 he 会让 trace 把鱼的话当成他说过的话
      //   · 鱼的发言留在群日志里，要用就 group_inbox 取，不进记忆（v1 定死）
      //   · 没有 items（老版本 relay / 老 wake）就不记：宁可缺，也不掺假
      if (src === 'relay') {
        const items = Array.isArray(data.source.items) ? data.source.items : []
        const out2 = []
        const rejects = []
        const ids = []
        let mine = 0, skipped = 0, dups = 0
        for (const it of items) {
          if (!it || !it.from) { rejects.push('拒收 (无from) 字段不全'); continue }
          if (it.from !== _humanName) { skipped += 1; continue }
          mine += 1
          // 约定：id / from / text 三样齐全才记。
          // 缺 id 就记下来的话，这条永远没法跟 group 日志对账、也没法去重——
          // 看着是记了，其实是个孤儿。
          if (!it.id || !it.text) {
            rejects.push(`拒收 ${it.id || '(无id)'} 缺${!it.id ? 'id' : 'text'}`)
            continue
          }
          const body = String(it.text || '').trim()
          if (!body || isNoise(body)) { rejects.push(`拒收 ${it.id} 空或噪声`); continue }
          // 同一条消息被投第二次：直接跳过，不记、也不进 gid 日志（它已经记过了）
          // 键里缺 ts 时退回唤醒体的 event.time，**不能用 0**——0 是所有缺 ts 的消息
          // 共享的同一个键，会把「同前缀、都没 ts」的两条不同消息判成重复，安静地丢一条。
          if (seenRelay(`${lineKey}|${Number(it.ts) || ts}|${body.slice(0, 40)}`)) { dups += 1; continue }
          // gid 现在会随记录落库（store 保留 source 字段），重放和验收都能对上。
          out2.push({
            who: 'he', ts: Number(it.ts) || ts, text: fullText(body), turn: null, type: event.type,
            messageID: it.id, eventKey: `${lineKey}:relay:${it.id}`,
            source: { type: 'user/message', kind: 'relay', gid: it.id, channel: it.channel || null },
          })
          ids.push(it.id)
        }
        // 验收取数面（2026-10-30 和维护者、另一个工作区定死的）：
        //   「装上去到底修没修好」必须能从日志一眼判出来，不能靠猜。
        //   最后一行带 gid 列表（relay 最多带 3 条，所以最多 3 个），
        //   验收的人拿它回 messages.jsonl 查即可，不必改存储层。
        //   **每行带 sid**（2026-10-31 另一位维护者要求的）：四条线的日志原来长得一模一样，
        //   「哪行是哪条线打的」分不出来——上一个 bug 就是在这个盲区里发生的。
        if (items.length || out2.length) {
          // 标签优先写线名（人看得懂），没有线名才写会话 id 前 8 位
          const tag = (ctx && ctx.line) ? `line=${ctx.line}` : (lineKey ? `sid=${lineKey.slice(0, 8)}` : 'line=?')
          _log(`[${tag}] items 收到 ${items.length} 条 · ${_humanName} ${mine} 条 · 记了 ${out2.length} 条 · 跳过(非${_humanName}) ${skipped} 条 · 拒收 ${rejects.length} 条${dups ? ` · 重复 ${dups} 条` : ''}`)
          for (const r of rejects.slice(0, 5)) _log(`[${tag}]   ` + r)
          if (rejects.length > 5) _log(`[${tag}]   其余 ${rejects.length - 5} 条拒收略`)
          if (ids.length) _log(`[${tag}]   记下 gid：${ids.join(',')}`)
        }
        return out2
      }
      const { text, images } = blocksText(data.content)
      if (src !== 'user') return []
      // 只发图、没打字的消息是**内容**，不是噪声。
      // （这里踩过一次：isNoise('') 返回 true，于是整条线的第一张图被丢了，
      //   「初见」就从我那句开始，看着像他一句话没说。）
      if (text && isNoise(text)) return []
      const body = images ? `${text ? text + ' ' : ''}[图×${images}]` : text
      if (!body) return []
      out.push({
        who: 'he', ts, text: fullText(body), turn: null, type: event.type,
        messageID: (data.message && data.message.id) || data.messageID || null,
        eventKey: baseKey, source: sourceOf('user/message'),
      })
      return out
    }

    case 'assistant/message': {
      const msg = data.message || {}
      const { text } = blocksText(msg.content)
      if (!text) return []
      out.push({
        who: 'me', ts, text: fullText(text), turn: data.turn ?? null, type: event.type,
        messageID: msg.id || data.messageID || null,
        turnID: data.turn !== undefined && data.turn !== null ? String(data.turn) : null,
        eventKey: baseKey, source: sourceOf('assistant/message'),
      })
      return out
    }

    case 'tool/call': {
      const name = data.name || '?'
      noteCall(data.callId, name)
      const raw = String(data.arguments || '')
      const args = parseArgs(raw)
      const paths = ctx && ctx.root ? artifactPaths(name, args, ctx.cwd) : []
      const before = paths.map((p) => snapshot(ctx.root, p))
      if (ctx && ctx.pending && data.callId) ctx.pending.set(data.callId, { paths, before, name, ts })
      let evidence = null
      try { if (ctx && ctx.root) evidence = putBlob(ctx.root, raw) } catch (e) { _log('证据写入失败：' + e.message) }
      const summary = clip(raw.replace(/\s+/g, ' '), 300)
      out.push({
        who: 'act', ts, text: `我调了 ${name}：${summary}`, tool: name, turn: data.turn ?? null,
        type: event.type, callId: data.callId || null, eventKey: baseKey, evidence,
        source: sourceOf('tool/call'),
      })
      return out
    }

    // 工具结果：**只看它「查到了什么」**，不看它「写了什么」。
    // 文件内容不进检索（随时能重读，而且会把流撑成垃圾场），
    // 但搜索/命令/网页这类结果里，往往就是「我上次查到的东西」——那得留。
    // 完整结果一律进 blobs/，需要时按哈希回读；索引里只留摘要。
    case 'tool/result': {
      const msg = data.message || {}
      const { text } = blocksText(msg.content)
      const callId = msg.toolCallId || data.callId || null
      const tool = String(data.name || msg.toolName || (callId ? nameOfCall(callId) : '') || '')
      const pending = callId && ctx && ctx.pending ? ctx.pending.get(callId) : null
      if (callId && ctx && ctx.pending) ctx.pending.delete(callId)
      const paths = (pending && pending.paths) || (ctx && ctx.root ? artifactPaths(tool, data.input, ctx.cwd) : [])
      const files = paths.map((p) => ({
        path: p,
        before: (pending && pending.before && pending.before.find((x) => x.path === p)) || { path: p, state: 'unknown' },
        after: ctx && ctx.root ? snapshot(ctx.root, p) : { path: p, state: 'unknown' },
      }))
      let evidence = null
      try { if (ctx && ctx.root) evidence = putBlob(ctx.root, text || '') } catch (e) { _log('证据写入失败：' + e.message) }
      const body = text || '(无输出)'
      let summary
      if (msg.isError) summary = clip(body, 240) + '（报错了）'
      else if (FILE_OPS.has(tool)) summary = `我处理了 ${tool}：结果已存为证据`
      else summary = clip(body.replace(/\s+/g, ' ').trim(), 220)
      if (!summary) return []
      out.push({
        who: 'act', ts, text: summary, tool, turn: data.turn ?? null, type: event.type,
        callId, status: msg.isError ? 'error' : 'completed', evidence, files,
        eventKey: baseKey, source: sourceOf('tool/result'),
      })
      if (!msg.isError) {
        for (const file of files) {
          const { before, after } = file
          if (before && before.state === 'saved' && after.state === 'saved' && before.sha256 === after.sha256) continue
          if (after.state !== 'saved' && !(after.state === 'missing' && before && before.state === 'saved')) continue
          out.push({
            who: 'act', ts, text: `${after.state === 'missing' ? '删除' : '写入'} ${file.path}；工具 ${tool} 已完成；版本 ${after.sha256 || 'missing'}`,
            tool, turn: data.turn ?? null, type: 'artifact', artifact: true, path: file.path, versions: file,
            eventKey: `${baseKey}:artifact:${file.path}`,
            source: { type: 'tool.observation', callId, toolEventID: baseKey },
          })
        }
      }
      return out
    }

    case 'session/title': {
      if (!data.title) return []
      out.push({
        who: 'meta', ts, text: `这个对话叫「${data.title}」`, type: event.type,
        eventKey: baseKey, source: sourceOf('session/title'),
      })
      return out
    }

    default:
      return []
  }
}

// 事件里带的序号：用来去重（实时收的和回填的可能是同一件事）
export function eventKey(event) {
  if (!event) return null
  return typeof event.seq === 'number' ? event.seq : null
}
