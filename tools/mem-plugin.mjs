import { createCapture } from './mem-capture.mjs'
import { injectBackground, excerpt, memoryPage } from './mem-context.mjs'

export async function setupMemory(ctx, core) {
  const ws = ctx.location?.directory || ''
  const capture = createCapture(core, ws)
  const states = new Map()
  const state = (sid) => {
    if (!states.has(sid)) states.set(sid, { cue: '', wake: '', key: '', prime: '' })
    return states.get(sid)
  }
  const safe = (fn) => async (e) => {
    try { return await fn(e) } catch (error) { core.diag('hook 出错：' + error.message) }
  }
  const hooks = []
  const hook = async (domain, name, fn) => {
    try { hooks.push(await domain.hook(name, safe(fn))) } catch (error) { core.diag(`挂 ${name} 失败：${error.message}`) }
  }
  const persisted = async (sid) => {
    const value = await ctx.session.context({ sessionID: sid })
    const rows = Array.isArray(value) ? value : value?.data || []
    const s = state(sid)
    if (!s.captureShape) {
      s.captureShape = true
      const parts = rows.filter((r) => r.type === 'assistant').flatMap((r) => r.content || []).filter((p) => p.type === 'text')
      core.diag(`capture shape ${JSON.stringify({ messages: rows.length, textParts: parts.length, sample: parts.slice(0, 2).map((p) => ({ keys: Object.keys(p), textType: typeof p.text, textLength: p.text?.length })) })}`)
    }
    capture.messages(sid, rows)
    const user = [...rows].reverse().find((r) => r.type === 'user')
    if (user) s.cue = user.text
    else if (!s.cue) s.cue = core.readAll().filter((r) => r.sid === sid && r.who === 'user').at(-1)?.text || ''
  }
  await hook(ctx.session, 'prompt', (e) => {
    const text = String(e.prompt?.text || '').trim()
    const s = state(e.sessionID)
    s.cue = text
    // prompt 钩子是用户消息被接纳的唯一可靠时点。不能只靠 inbox 事件：
    // 实测同一会话里直接提交的提示不一定再发 enqueued，漏了就永远缺这一句。
    if (text) capture.user(e.sessionID, e.messageID, text)
  })
  await hook(ctx.session, 'context', async (e) => {
    const sid = e.sessionID, s = state(sid)
    // Read visible canonical text before editing the outgoing copy, including interrupted replies.
    await persisted(sid)
    const pins = Object.entries(core.readPins()).slice(0, 6)
      .map(([k, v]) => `${k}: ${JSON.stringify(excerpt(v.text, 240))}`)
    const notable = core.readAll().filter((r) => r.ws === ws && r.kind !== 'message' && r.kind !== 'compaction').slice(-4)
      .map((r) => `#${r.seq} <${r.kind}> ${JSON.stringify(excerpt(r.text, 120))}`)
    s.wake = [...pins, ...notable].join('\n')
    const key = JSON.stringify([s.cue, core.readAll().at(-1)?.id])
    if (s.key !== key) {
      s.key = key
      const hits = core.recall(excerpt(s.cue, 1000), { n: 12 }).filter((h) => h.sid !== sid).slice(0, 3)
      s.prime = hits.map((h) => `#${h.seq} ${core.dayOf(h.ts)} <${h.kind}> ${JSON.stringify(excerpt(h.text, 160))}`).join('\n')
    }
    const text = [s.wake, s.prime, '细节用 mem_read 按编号读取；归属用 mem_trace 核对。'].filter(Boolean).join('\n')
    if (s.wake || s.prime) {
      const where = injectBackground(e, text.slice(0, 2400))
      core.diag(`预激活 ${String(sid).slice(0, 8)} → ${where} · ${text.length} chars`)
    }
  })
  await hook(ctx.session, 'compaction', async (e) => {
    await persisted(e.sessionID)
    core.append({ who: 'system', kind: 'compaction', text: '发起上下文压缩请求（完成状态待事件确认）', ws, sid: e.sessionID })
  })
  await hook(ctx.tool, 'execute.before', capture.before)
  await hook(ctx.tool, 'execute.after', capture.after)
  await hook(ctx.session, 'experimental.idle', async (e) => {
    await persisted(e.sessionID)
    capture.finish(e.sessionID, e.background?.length ? 'background-pending' : 'completed')
  })
  const controller = new AbortController()
  if (ctx.event?.subscribe) {
    const types = ['session.inbox.enqueued', 'session.text.ended', 'session.execution.succeeded',
      'session.execution.failed', 'session.execution.interrupted']
    const consume = safe(async (event) => {
      const d = event.data, sid = d?.sessionID
      if (!sid) return
      const normalize = (p) => String(p).replaceAll('\\', '/').toLowerCase()
      if (event.location?.directory ? normalize(event.location.directory) !== normalize(ws) : !states.has(sid)) return
      if (event.type === 'session.inbox.enqueued' && d.item?.type === 'user') {
        capture.user(sid, d.inboxID, d.item.payload.text, event.created)
        state(sid).cue = d.item.payload.text
      } else if (event.type === 'session.text.ended') {
        capture.assistant(sid, d.assistantMessageID, d.ordinal, d.text, event.created)
      } else if (event.type.startsWith('session.execution.')) {
        await persisted(sid)
        capture.finish(sid, event.type.split('.').at(-1))
      }
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) await consume(event)
      } catch (error) { if (!controller.signal.aborted) core.diag('事件流中断：' + error.message) }
    })()
  }
  await registerMemoryTools(ctx, core, ws)
  try { capture.replay() } catch (error) { core.diag('重放失败：' + error.message) }
  core.diag(`plugin v2 载入 · ws=${ws}`)
  return async () => {
    controller.abort()
    for (const h of hooks) await h?.dispose?.()
    core.diag('plugin v2 卸载')
  }
}

async function registerMemoryTools(ctx, core, ws) {
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: 'mem', description: '本地长期记忆：查原话、任务、产物和执行证据' })
    const add = (name, description, properties, required, execute) => editor.add({
      name, description, options: { namespace: 'mem', codemode: true },
      input: { type: 'object', properties, required, additionalProperties: false }, execute,
    })
    add('read', '按编号/ID读取记忆原文，或按 blob 哈希读取本地工具结果/文件版本。长文本分段读取。', {
      ref: { type: 'string', description: '记录编号、记录 ID 或 64 位 blob 哈希' },
      offset: { type: 'number' }, limit: { type: 'number' },
    }, ['ref'], async (input) => {
      let row = core.getRecord(input.ref)
      if (!row && /^[a-f0-9]{64}$/.test(input.ref)) row = { id: input.ref, text: core.evidence(input.ref).toString('utf8') }
      return { content: memoryPage(row, input) }
    })
    add('recall', '按线索查旧事。返回带来源的原文摘录；详情用 read，不能把相似命中当事实。', {
      query: { type: 'string' }, n: { type: 'number' }, scope: { type: 'string' },
    }, ['query'], async (input) => {
      const hits = core.recall(input.query, { n: Math.max(1, Math.min(10, Number(input.n) || 5)), scope: input.scope || null })
      return { content: hits.length ? hits.map((h) => `#${h.seq} ${core.dayOf(h.ts)} <${h.kind}> [${h.who}]\n${excerpt(h.text, 1600)}\n来源：${JSON.stringify(h.source || { sid: h.sid, legacy: true })}`).join('\n\n')
        : '（没有相关记录。）' + (hits.hint || '') }
    })
    add('trace', '按字核对原话和归属；系统派生记录不算助手说过的话。', {
      query: { type: 'string' },
    }, ['query'], async (input) => {
      const hits = core.trace(input.query).slice(-10)
      return { content: hits.length ? hits.map((h) => `#${h.seq} ${h.attribution}\n${h.text.slice(Math.max(0, h.text.indexOf(input.query) - 80), Math.max(0, h.text.indexOf(input.query) - 80) + 1200)}`).join('\n\n') : '（按字没有这句。）' }
    })
    add('map', '记忆地图：有哪些主题、各多少条。', {}, [], async () => ({ content: core.map() }))
    add('alias', '给主词添加逗号分隔的同义词。', {
      term: { type: 'string' }, synonyms: { type: 'string' },
    }, ['term', 'synonyms'], async (input) => ({ content: JSON.stringify(core.addAlias(input.term, input.synonyms)) }))
    add('remember', '显式记下一条判断或稳定信息；自动记录仍保存原始证据。', {
      text: { type: 'string' }, key: { type: 'string' },
    }, ['text'], async (input) => {
      core.mark(input.text, input.key || null, ws)
      return { content: '记下了。' }
    })
  })
}
