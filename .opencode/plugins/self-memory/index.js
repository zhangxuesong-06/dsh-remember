// self-memory —— 给 OpenCode 用的长期记忆。
//
// 和 dsh-memory 一个思路，但落点不同：
//   记录不靠模型自觉 —— 挂 session 钩子，用户消息和助手消息都自动落盘。
//   摘要只当索引 —— 醒来块只给标题和日期，细节用 mem_recall 翻原话。
//   全局一个库 —— 换文件夹不等于换一个人，ws 只用来过滤。
//
// 数据在 ~/.opencode-mem/。工具是 mem_recall / mem_trace / mem_remember。

import { Plugin } from '@opencode/plugin'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.resolve(HERE, '../../../tools/mem-core.mjs')

// 每个会话的临时状态。插件重启就丢，没关系——丢的只是去重表。
const S = new Map()
const st = (sid) => {
  let s = S.get(sid)
  if (!s) {
    s = { wake: false, cue: '', primeKey: '', recent: new Set(), lastPrimeAt: 0 }
    S.set(sid, s)
  }
  return s
}

const shortWs = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''

function textOf(m) {
  if (!m) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const parts = []
    for (const b of c) {
      if (!b) continue
      if (typeof b === 'string') parts.push(b)
      else if (b.type === 'text' && b.text) parts.push(b.text)
    }
    return parts.join('\n')
  }
  return ''
}

export default Plugin.define({
  id: 'self-memory',
  async setup(ctx) {
    let core
    try {
      core = await import(CORE)
    } catch (e) {
      console.error('[self-memory] 载入 mem-core 失败：' + (e && e.message))
      return
    }
    const { append, recall, trace, mark, readAll, readPins, diag, dayOf } = core
    const ws = ctx.location && ctx.location.directory ? ctx.location.directory : ''
    diag(`plugin 载入 · ws=${ws}`)

    const safe = (fn) => async (e) => {
      try { await fn(e) } catch (err) { diag('hook 出错：' + (err && err.message)) }
    }

    // ——— ① 用户消息：一进来就落盘 ———
    try {
      await ctx.session.hook('prompt', safe((e) => {
        const text = String((e.prompt && e.prompt.text) || '').trim()
        if (!text) return
        const s = st(e.sessionID)
        const key = 'u:' + text.slice(0, 80)
        // prompt 钩子不是 exactly-once：重试会再跑一遍。短时间内同样的字只记一次。
        if (s.recent.has(key)) return
        s.recent.add(key)
        if (s.recent.size > 50) s.recent.delete(s.recent.values().next().value)
        s.cue = text
        append({ who: 'user', kind: 'message', text, ws, sid: e.sessionID })
      }))
    } catch (e) { diag('挂 prompt 失败：' + (e && e.message)) }

    // ——— ② 每次模型调用前：补记助手消息 + 注入 ———
    try {
      await ctx.session.hook('context', safe((e) => {
        if (e.kind && e.kind !== 'primary') return
        const sid = e.sessionID
        const s = st(sid)

        // 补记助手消息（按内容 hash 去重）
        // 只记助手，不记 tool 结果——读文件、跑命令的输出是噪声，
        // 而且它们本来就在会话记录里。助手的话才是「我说过什么」。
        for (const m of e.messages || []) {
          const role = m.role || m.type
          if (role !== 'assistant') continue
          const raw = textOf(m).trim()
          if (!raw) continue
          // 代码块占比过高 = 工具输出/长回答，不是判断。压到 400 字。
          const fence = (raw.match(/```/g) || []).length
          const isCodey = fence >= 2 && raw.length > 1200
          const text = isCodey ? raw.slice(0, 400) : raw.slice(0, 800)
          const key = 'a:' + text.slice(0, 80)
          if (s.recent.has(key)) continue
          s.recent.add(key)
          if (s.recent.size > 50) s.recent.delete(s.recent.values().next().value)
          append({ who: 'assistant', kind: 'message', text, ws, sid })
        }

        // 醒来块：整场只给一次
        if (!s.wake) {
          const block = wakeBlock(readPins, readAll, dayOf)
          if (block) {
            e.system.push({ type: 'text', text: block })
            s.wake = true
            diag(`醒来块 ${String(sid).slice(0, 8)}：${block.length}B`)
          }
        }

        // 预激活：这一句碰到了哪些旧事。cue 变了才重算。
        const cue = s.cue
        if (!cue) return
        const key = cue.slice(0, 40)
        if (key === s.primeKey) return
        s.primeKey = key
        const hits = recall(cue, { n: 3 })
          .filter((h) => !(h.sid === sid && Date.now() - h.ts < 6 * 3600e3))
        if (!hits.length) return
        const lines = hits.map((h) => `· #${h.seq} ${dayOf(h.ts)}${h.kind && h.kind !== 'message' ? ' ' + h.kind : ''} ${String(h.text).replace(/\s+/g, ' ').slice(0, 48)}`)
        const text = `【这事以前碰过】\n${lines.join('\n')}`
        e.system.push({ type: 'text', text })
        s.lastPrimeAt = Date.now()
        diag(`预激活 ${String(sid).slice(0, 8)}：${hits.length} 行 · cue=${cue.replace(/\s+/g, ' ').slice(0, 30)}`)
      }))
    } catch (e) { diag('挂 context 失败：' + (e && e.message)) }

    // ——— ③ 压缩：记一笔，下次说「你丢过东西」 ———
    try {
      await ctx.session.hook('compaction', safe((e) => {
        append({ who: 'system', kind: 'compaction', text: '上下文被压缩了一次', ws, sid: e.sessionID })
      }))
    } catch (e) { diag('挂 compaction 失败：' + (e && e.message)) }

    // ——— ④ 工具 ———
    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: 'mem', description: '长期记忆：翻原话、按字核对归属、特意记下' })

        editor.add({
          name: 'recall',
          description: '按一句话/一个处境，翻出以前的原话。返回的是原文，不是摘要。想不起来就是没记住，别拿相似的东西凑。',
          input: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '线索：一句话、一个名字、现在的处境' },
              n: { type: 'number', description: '要几条，默认 5' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          execute: async (input) => {
            const hits = recall(String(input.query || ''), { n: Number(input.n) || 5 })
            if (!hits.length) return { content: '（没有相关的。库里有 ' + readAll().length + ' 条。）' }
            return {
              content: hits.map((h) => `#${h.seq} ${dayOf(h.ts)} [${shortWs(h.ws)}] ${h.text}`).join('\n\n'),
            }
          },
        })

        editor.add({
          name: 'trace',
          description: '按字查：这句话到底在不在、是谁说的。结果分「他说的 / 我说的 / 工具」。承诺和归属只认这个，不认 recall。',
          input: {
            type: 'object',
            properties: { query: { type: 'string', description: '要一字不差查找的片段' } },
            required: ['query'],
            additionalProperties: false,
          },
          execute: async (input) => {
            const hits = trace(String(input.query || ''))
            if (!hits.length) return { content: '（按字没有这句。没说过就是没说过。）' }
            return {
              content: hits.slice(-10).map((h) => `#${h.seq} ${dayOf(h.ts)} · ${h.attribution} · ${h.text}`).join('\n\n'),
            }
          },
        })

        editor.add({
          name: 'remember',
          description: '特意记下一件不想让它变淡的事：答应过的事、用户的稳定信息、某个决定。同一件会变的事用同一个 key。',
          input: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              key: { type: 'string', description: '同一件持续的事用同一个 key' },
            },
            required: ['text'],
            additionalProperties: false,
          },
          execute: async (input) => {
            mark(String(input.text || ''), input.key ? String(input.key) : null, ws)
            return { content: '记下了。' }
          },
        })
      })
    } catch (e) { diag('注册工具失败：' + (e && e.message)) }

    return () => diag('plugin 卸载')
  },
})

function wakeBlock(readPins, readAll, dayOf) {
  const pins = readPins()
  const docs = readAll()
  const pinLines = Object.entries(pins).slice(0, 6).map(([k, v]) => `- ${k}: ${v.text}`)
  const notable = docs.filter((d) => d.kind && d.kind !== 'message' && d.kind !== 'compaction').slice(-6)
  const noteLines = notable.map((d) => `- ${dayOf(d.ts)} <${d.kind}> ${String(d.text).replace(/\s+/g, ' ').slice(0, 60)}`)
  if (!pinLines.length && !noteLines.length) return ''
  return [
    '【记忆 · 醒来块】',
    pinLines.length ? '钉住：\n' + pinLines.join('\n') : '',
    noteLines.length ? '最近做过：\n' + noteLines.join('\n') : '',
    '细节用 mem_recall 翻原话；归属用 mem_trace 按字核对。',
  ].filter(Boolean).join('\n\n')
}
