// 常驻 MCP server（stdio）：五个记忆工具。
//
// 为什么检索不放在钩子里：钩子一次一进程，每次都要把整条流重新建索引；
// 这里常驻一个进程，每次调用前只按字节偏移把新追加的行读进来（syncTail）。
import { createInterface } from 'node:readline'
import { writeSync } from 'node:fs'
import { HOME, loadCfg, wsNameOf, wsOf } from '../lib/config.mjs'
import { Ledger } from '../lib/store.mjs'
import { recallBlock, ledgerQuotes, traceBlock } from '../lib/assemble.mjs'
import { serializeRange } from '../lib/mem-recall.mjs'
import { mark } from '../lib/journal.mjs'
import { readBlob } from '../lib/evidence.mjs'

const VERSION = '0.1.0'
const PROTOCOL = '2024-11-05'

let ledger = null
function db() {
  if (!ledger) ledger = new Ledger(HOME).open()
  else ledger.syncTail()
  return ledger
}

const TOOLS = [
  {
    name: 'recall',
    description: '按意思回看以前的事。返回段落标题、日期和原话摘录；要更完整就带 full。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回想的事，用你记得的字眼写。' },
        episode: { type: 'integer', description: '已知段号时直接取那一段。' },
        full: { type: 'boolean', description: 'true 时展开该段更多原文。' },
        passage: { type: 'boolean', description: '按原文窗口排名，返回紧凑摘录。' },
        compact: { type: 'boolean', description: '只返回限量摘录、角色和原文位置。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'trace',
    description: '按字核对「这句话到底说不说过」。返回确切出处（会话、行号）；说没有就是没有，不要拿相似段落顶上。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要一字不差核对的原话片段。' },
        max: { type: 'integer', description: '最多给几个例子，默认 3。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description: '显式记下一条：约定、偏好、结论。key 相同的后一条取代前一条（旧的仍留在账本里）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容。' },
        key: { type: 'string', description: '可选的归类键，如 constraint、preference。' },
        weight: { type: 'number', description: '分量，默认 1；重要的写大一点。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_stats',
    description: '库的体检数字：条数、段数、工作区、账本状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_read',
    description: '按段号或证据哈希回读原文/完整工具输出。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记录行号（从 0 开始）或 64 位 sha256。' },
        range: { type: 'string', description: '摘录的 UTF-16 start:end，原样回读。' },
      },
      required: ['id'],
    },
  },
]

function text(value, isError = false) {
  return { content: [{ type: 'text', text: String(value ?? '') }], ...(isError ? { isError: true } : {}) }
}

function callTool(name, args = {}) {
  const cfg = loadCfg()
  if (name === 'recall') {
    const query = String(args.query || '').trim()
    if (!query && args.episode === undefined) return text('recall 需要 query 或 episode。', true)
    if (query && !Number.isInteger(args.episode) && !args.full && (args.passage || args.compact)) {
      return text(ledgerQuotes(db(), query, { passages: args.passage, recency: cfg.recency }))
    }
    const out = recallBlock(db(), {
      query,
      episode: Number.isInteger(args.episode) ? args.episode : null,
      full: Boolean(args.full),
      maxChars: cfg.recallMaxChars,
    })
    return text(out || '没找到。换个你当时会用的词再试，或者用 trace 核对原话。')
  }
  if (name === 'trace') {
    const query = String(args.query || '').trim()
    if (!query) return text('trace 需要 query。', true)
    const out = traceBlock(db(), query, { maxExamples: Number(args.max) || 3 })
    return text(out || '库里没有这句话。')
  }
  if (name === 'remember') {
    const body = String(args.text || '').trim()
    if (!body) return text('remember 需要 text。', true)
    const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd()
    const rec = mark({ key: args.key || null, text: body, weight: Number(args.weight) || 1, ws: wsOf(cwd), wsName: wsNameOf(cwd) })
    return text(rec ? `记下了（${rec.id}）。` : '没记下。')
  }
  if (name === 'memory_stats') {
    const l = db()
    const s = l.stats()
    const ws = l.workspaces()
    const lines = [
      `目录：${s.dir}`,
      `记录 ${s.docs} 条（原话 ${s.traces} · 工具 ${s.acts}）· 段 ${s.episodes} · 笔记 ${s.marks} · 词 ${s.terms}`,
      `字节 ${s.bytes}`,
      ...(ws.length ? ['工作区：', ...ws.map((w) => `  · ${w.name}（${w.records} 条）${w.ws}`)] : []),
    ]
    return text(lines.join('\n'))
  }
  if (name === 'memory_read') {
    const id = String(args.id || '').trim()
    if (/^\d+$/.test(id)) {
      const rec = db().fullRecord(Number(id))
      if (rec && args.range !== undefined) return text(serializeRange(rec, id, args.range))
      return rec ? text(rec.text || '') : text('没有这一段。', true)
    }
    if (/^[a-f0-9]{64}$/.test(id)) {
      return text(readBlob(HOME, id).toString('utf8'))
    }
    return text('id 只能是段号或 64 位 sha256。', true)
  }
  return text('未知工具：' + name, true)
}

function handle(msg) {
  const { id, method, params } = msg || {}
  const reply = (result) => writeSync(1, JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  const fail = (code, message) => writeSync(1, JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'zcode-memory', version: VERSION },
        instructions: '这是跨会话的长期记忆库。记不清的事先用 trace 核对原话，再用 recall 展开。',
      })
    }
    if (method && method.startsWith('notifications/')) return
    if (method === 'ping') return reply({})
    if (method === 'tools/list') return reply({ tools: TOOLS })
    if (method === 'tools/call') {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      try { return reply(callTool(name, args)) } catch (e) {
        return reply(text(`工具失败：${e && e.message}`, true))
      }
    }
    if (method === 'resources/list') return reply({ resources: [] })
    if (method === 'prompts/list') return reply({ prompts: [] })
    return fail(-32601, 'Method not found: ' + method)
  } catch (e) {
    return fail(-32603, String(e && e.message))
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg = null
  try { msg = JSON.parse(line) } catch { return }
  handle(msg)
})
