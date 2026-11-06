// self-memory —— 给 OpenCode 用的长期记忆。
//
// 和 dsh-memory 一个思路，但落点不同：
//   记录不靠模型自觉 —— 挂 session 钩子，用户消息和助手消息都自动落盘。
//   摘要只当索引 —— 醒来块只给标题和日期，细节用 mem_recall 翻原话。
//   全局一个库 —— 换文件夹不等于换一个人，ws 只用来过滤。
//
// 数据在 ~/.opencode-mem/。工具是 mem_recall / mem_trace / mem_remember。

import { Plugin } from '@opencode/plugin'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.resolve(HERE, '../../tools/mem-core.mjs')

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
    const { append, recall, trace, mark, readAll, readPins, diag, dayOf, map, addAlias, appendTool } = core
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
        if (s.recent.size > 5000) s.recent.delete(s.recent.values().next().value)
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
          if (s.recent.size > 5000) s.recent.delete(s.recent.values().next().value)
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

    // ——— ③b 工具调用：只收集，不进检索 ———
    // 现在不做任何过滤和聚合——先攒四天，看清楚里面有什么再决定。
    // fileOp 先打个标，方便以后切分（海马体的做法是直接丢掉文件操作）。
    //
    // 注：这里自己写文件，不走 core.appendTool——ESM 的模块缓存在服务进程里，
    // 插件重载不会重新 import 依赖，core 的新导出拿不到。等下次重启服务再收敛。
    const FILE_OPS = new Set([
      'read', 'write', 'edit', 'patch', 'multiedit', 'multi_edit',
      'grep', 'glob', 'list', 'ls', 'rg', 'str_replace_editor',
    ])
    const TOOLS_FILE = path.join(core.ROOT, 'tools.jsonl')
    const clipJson = (v, max = 300) => {
      let s = ''
      try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { s = String(v) }
      if (!s) return ''
      return s.length > max ? s.slice(0, max) + '…' : s
    }
    const writeTool = (rec) => {
      try {
        fs.mkdirSync(core.ROOT, { recursive: true })
        const row = {
          ts: rec.ts || Date.now(),
          ws: rec.ws || '',
          sid: rec.sid || '',
          tool: String(rec.tool || '?').slice(0, 40),
          phase: rec.phase || 'call',
          fileOp: !!rec.fileOp,
        }
        if (rec.args) row.args = String(rec.args).slice(0, 300)
        if (rec.error) row.error = String(rec.error).slice(0, 300)
        fs.appendFileSync(TOOLS_FILE, JSON.stringify(row) + '\n', 'utf8')
      } catch (err) { diag('写 tools.jsonl 失败：' + (err && err.message)) }
    }

    try {
      await ctx.tool.hook('execute.before', safe((e) => {
        const tool = String(e.tool || e.name || '?')
        writeTool({
          ws, sid: e.sessionID || '', tool, phase: 'call',
          fileOp: FILE_OPS.has(tool),
          args: clipJson(e.input !== undefined ? e.input : e.args),
        })
      }))
      await ctx.tool.hook('execute.after', safe((e) => {
        if (e.status !== 'error') return
        const tool = String(e.tool || e.name || '?')
        const msg = e.error && (e.error.message || e.error)
        writeTool({
          ws, sid: e.sessionID || '', tool, phase: 'error',
          fileOp: FILE_OPS.has(tool),
          error: clipJson(msg),
        })
      }))
    } catch (e) { diag('挂 tool 钩子失败：' + (e && e.message)) }

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
              scope: { type: 'string', description: '缩小范围：build / research / study，或 build/docker 这种「域/实体」' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          execute: async (input) => {
            const hits = recall(String(input.query || ''), {
              n: Number(input.n) || 5,
              scope: input.scope ? String(input.scope) : null,
            })
            if (!hits.length) {
              return { content: '（没有相关的。库里有 ' + readAll().length + ' 条。）' + (hits.hint ? '\n' + hits.hint : '') }
            }
            const head = []
            if (hits.note) head.push(`（${hits.note}）`)
            if (hits.aliasHit && hits.aliasHit.length) head.push(`（别名命中：${hits.aliasHit.join(', ')}）`)
            if (hits.assocHit && hits.assocHit.length) head.push(`（联想命中：${hits.assocHit.join(', ')}）`)
            return {
              content: [...head, ...hits.map((h) => `#${h.seq} ${dayOf(h.ts)} [${shortWs(h.ws)}] ${h.text}`)].join('\n\n'),
            }
          },
        })

        editor.add({
          name: 'map',
          description: '记忆地图：库里有哪些主题、各多少条、最近在聊什么。不知道该往哪找时先调它，再用 recall 带 scope 缩小范围。',
          input: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          execute: async () => ({ content: map() }),
        })

        editor.add({
          name: 'alias',
          description: '给一个词加同义词，让 recall 能跨过词面差异（比如 vmware = 虚拟机 = vm）。别名加错了只是某次召回差一点，不会影响别的。',
          input: {
            type: 'object',
            properties: {
              term: { type: 'string', description: '主词' },
              synonyms: { type: 'string', description: '同义词，逗号分隔' },
            },
            required: ['term', 'synonyms'],
            additionalProperties: false,
          },
          execute: async (input) => {
            const r = addAlias(String(input.term || ''), String(input.synonyms || ''))
            if (!r) return { content: '（没加，词是空的。）' }
            return { content: `${r.key} → ${r.synonyms.join(', ')}` }
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
