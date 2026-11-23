import { createCapture } from './mem-capture.mjs'
import { injectBackground, injectBlock, excerpt, memoryPage } from './mem-context.mjs'
import { caseSource, caseWatermark, searchCases, readEvidence, readCaseRef, startCaseSync } from './memory-case-index.mjs'
import { mode, renderCards } from './memory-cards.mjs'
import { buildHint, promptCue, testCue } from './memory-case-hint.mjs'
import { sha256 } from './mem-journal.mjs'
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function currentRegression(project, test) {
  try {
    const file = path.join(project, test.path)
    if (realpathSync.native(file) !== file) return false
    const stat = statSync(file)
    return stat.isFile() && stat.size <= 256 * 1024 && sha256(readFileSync(file)) === test.sha
  } catch { return false }
}

export async function setupMemory(ctx, core) {
  const ws = ctx.location?.directory || ''
  const cases = mode()
  const source = cases === 'off' ? null : caseSource('opencode', core.ROOT, ws, { checkpointed: true })
  const atProjectRoot = source?.project && source.project === realpathSync.native(ws)
  const auto = cases === 'auto' && atProjectRoot
  const capture = createCapture(core, ws, { caseTests: !!atProjectRoot })
  let timer, worker, syncRequested = false, closed = false
  const scheduleSync = () => {
    if (!source || closed || process.env.MEMORY_DISABLE_MAINTENANCE === '1') return
    syncRequested = true
    if (worker || timer) return
    timer = setTimeout(() => {
      timer = undefined
      syncRequested = false
      worker = startCaseSync('opencode', core.ROOT)
      worker?.on('close', () => {
        worker = undefined
        if (syncRequested) scheduleSync()
      })
    }, 200)
    timer.unref()
  }
  // 维护只由插件触发：--due 有 12 小时最小间隔，多工作区实例靠锁和 lastRun 收敛。
  // 不注册 Windows 计划任务；进程退出后不补跑，下次打开 harness 再说。
  try {
    if (process.env.MEMORY_DISABLE_MAINTENANCE !== '1') {
      const script = fileURLToPath(new URL('./mem-maintenance.mjs', import.meta.url))
      const base = (process.execPath || '').split(/[\\/]/).pop() || ''
      const node = /^node(\.exe)?$/i.test(base) ? process.execPath : (process.env.OPENCODE_NODE || 'node')
      const child = spawn(node, [script, '--root', core.ROOT, '--due'], {
        detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
      })
      child.on('error', (error) => core.diag('维护进程失败：' + error.message))
      child.on('exit', (code) => { if (code) core.diag('维护进程退出：' + code) })
      child.unref()
    }
  } catch (error) { core.diag('维护启动失败：' + error.message) }
  const states = new Map()
  const state = (sid) => {
    if (!states.has(sid)) states.set(sid, { cue: '', wake: '', prime: '', hits: [], hitsCue: '', turn: 0, wakeTurn: -1,
      lastBlockKey: '', lastInjectedAt: 0, compactPending: false, compactIds: new Set(), promptID: null })
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
    if (!e.messageID || e.messageID !== s.promptID) {
      s.turn += 1
      s.promptID = e.messageID
      s.hitsCue = ''
      s.lastBlockKey = ''
      s.compactPending = false
      if (auto) {
        s.caseTurn = { watermark: caseWatermark(source), initial: promptCue(text), observed: [], delivered: false,
          checkedTool: false, bytes: 0 }
      }
    }
    // prompt 钩子是用户消息被接纳的唯一可靠时点。不能只靠 inbox 事件：
    // 实测同一会话里直接提交的提示不一定再发 enqueued，漏了就永远缺这一句。
    if (text) capture.user(e.sessionID, e.messageID, text)
    scheduleSync()
  })
  await hook(ctx.session, 'context', async (e) => {
    const sid = e.sessionID, s = state(sid)
    // Read visible canonical text before editing the outgoing copy, including interrupted replies.
    await persisted(sid)
    if (auto && s.caseTurn) {
      const turn = s.caseTurn
      const pick = keys => {
        if (!keys.length) return null
        const { cards } = searchCases(source, { keys, watermark: turn.watermark, current: { sid, turn: s.promptID } })
        const old = cards.filter(card => card.session !== sid || card.turn !== s.promptID)
        return old.length === 1 ? old[0] : null
      }
      let card = null
      if (!turn.delivered && !turn.mutationStarted) {
        card = pick(turn.initial)
        turn.initial = []
        if (!card && turn.observed.length && !turn.checkedTool) {
          turn.checkedTool = true
          card = pick(turn.observed)
        }
      } else if (turn.delivered && turn.compactPending) {
        const prior = pick(turn.card.keys)
        if (prior?.id === turn.card.id) card = prior
      }
      if (card && currentRegression(source.project, card.test)
        && card.evidence.every(ref => readEvidence(source, ref).state === 'exact')) {
        const hint = buildHint(card, Math.min(512, 1536 - turn.bytes))
        if (hint && injectBlock(e, hint, { systemFallback: false })) {
          turn.delivered = true
          turn.card = card
          turn.bytes += Buffer.byteLength(hint) + 2
          turn.compactPending = false
        }
      }
    }
    const hasMemoryTools = (event) => {
      if (!event.tools) return true
      const keys = Object.keys(event.tools)
      if (!keys.length) return false
      if (keys.some((k) => /(^|[._])mem([._]|$)/.test(k))) return true
      // Code Mode：mem 工具挂在 execute 里，不会以 mem_* 直接出现。
      if (keys.some((k) => /^(execute|code|run|tool)$/i.test(k))) return true
      return false
    }
    const toolHint = hasMemoryTools(e)
      ? '细节用 mem_read 按编号读取；归属用 mem_trace 核对。'
      : '（当前模型没有记忆工具；编号只作线索，细节可让用户用 CLI 查。）'
    if (s.wakeTurn !== s.turn) {
      s.wakeTurn = s.turn
      const pins = Object.entries(core.readPins()).slice(0, 4)
        .map(([k, v]) => `${k}: ${JSON.stringify(excerpt(v.text, 160))}`)
      const notable = (auto ? [] : core.readAll()).filter((r) => r.ws === ws && r.kind !== 'message' && r.kind !== 'compaction').slice(-2)
        .map((r) => `#${r.seq} <${r.kind}> ${JSON.stringify(excerpt(r.text, 90))}`)
      s.wake = [...pins, ...notable].join('\n')
    }

    if (s.hitsCue !== s.cue) {
      s.hitsCue = s.cue
      s.hits = s.cue && !auto
        ? core.recall(excerpt(s.cue, 1000), { n: 12 }).filter((h) => h.sid !== sid).slice(0, 3)
        : []
      s.prime = s.hits.map((h) => `#${h.seq} ${core.dayOf(h.ts)} <${h.kind}> ${JSON.stringify(excerpt(h.text, 120))}`).join('\n')
    }
    const blockKey = JSON.stringify([s.turn, s.cue, s.hits.map((h) => h.seq)])
    const repeat = !s.compactPending && blockKey === s.lastBlockKey && Date.now() - s.lastInjectedAt < 10 * 60e3
    const text = [s.wake, s.prime, toolHint].filter(Boolean).join('\n')
    if (s.wake || s.prime) {
      // 同一回合的工具续调不再重发整段背景：首轮给全量，后续只给一个指针。
      // 模型仍可用 mem_read 取细节；这比每次重读 900+ 字省很多 token。
      const compact = repeat && process.env.MEMORY_COMPACT_REPEAT !== '0'
        ? `【记忆】本轮已给：${s.hits.length ? s.hits.map((h) => '#' + h.seq).join(' ') : '钉住事实'}${hasMemoryTools(e) ? '（细节用 mem_read）' : '（当前模型无记忆工具；细节可让用户用 CLI 查）'}`
        : null
      const where = injectBackground(e, (compact || text).slice(0, compact ? 240 : 1600))
      s.compactPending = false
      s.lastBlockKey = blockKey
      s.lastInjectedAt = Date.now()
      core.diag(`预激活 ${String(sid).slice(0, 8)} → ${where} · ${compact ? 'compact' : 'full'} · ${(compact || text).length} chars · tools=${hasMemoryTools(e) ? 'yes' : 'no'}`)
    }
  })
  await hook(ctx.session, 'compaction', async (e) => {
    await persisted(e.sessionID)
    const s = state(e.sessionID)
    const id = e.compactionID ?? e.id
    if (e.cancelled === true) {
      if (s.pendingCompactionID === id) {
        s.compactPending = false
        if (s.caseTurn) s.caseTurn.compactPending = false
      }
      return
    }
    if (id != null) {
      if (s.compactIds.has(id)) return
      s.compactIds.add(id)
      if (s.compactIds.size > 32) s.compactIds.delete(s.compactIds.values().next().value)
    }
    s.compactPending = true
    if (s.caseTurn?.delivered) s.caseTurn.compactPending = true
    s.pendingCompactionID = id
    core.append({ who: 'system', kind: 'compaction', text: '发起上下文压缩请求（完成状态待事件确认）', ws, sid: e.sessionID })
  })
  await hook(ctx.tool, 'execute.before', (event) => {
    const turn = cases === 'auto' && state(event.sessionID).caseTurn
    // Only known read-only tools can establish a lead before the first possible write.
    if (turn && !/^(?:[\w-]+[._])?(?:read|grep|rg|glob|list|ls)$/i.test(event.tool)) turn.mutationStarted = true
    return capture.before(event)
  })
  await hook(ctx.tool, 'execute.after', (event) => {
    const row = capture.after(event)
    const turn = cases === 'auto' && state(event.sessionID).caseTurn
    if (row && turn && !turn.mutationStarted && !turn.delivered && !turn.checkedTool) {
      turn.observed = [...new Set([...turn.observed, ...testCue(event)])].slice(0, 4)
    }
    scheduleSync()
    return row
  })
  await hook(ctx.session, 'experimental.idle', async (e) => {
    await persisted(e.sessionID)
    capture.finish(e.sessionID, e.background?.length ? 'background-pending' : 'completed')
    scheduleSync()
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
        scheduleSync()
      }
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) await consume(event)
      } catch (error) { if (!controller.signal.aborted) core.diag('事件流中断：' + error.message) }
    })()
  }
  await registerMemoryTools(ctx, core, ws, source)
  try { capture.replay() } catch (error) { core.diag('重放失败：' + error.message) }
  core.diag(`plugin v2 载入 · ws=${ws}`)
  scheduleSync()
  return async () => {
    closed = true
    clearTimeout(timer)
    controller.abort()
    for (const h of hooks) await h?.dispose?.()
    core.diag('plugin v2 卸载')
  }
}

async function registerMemoryTools(ctx, core, ws, source) {
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: 'mem', description: '本地长期记忆：查原话、任务、产物和执行证据' })
    const add = (name, description, properties, required, execute) => editor.add({
      name, description, options: { namespace: 'mem', codemode: true },
      input: { type: 'object', properties, required, additionalProperties: false }, execute,
    })
    add('read', '按编号/ID读取记忆原文，或按 blob 哈希读取本地工具结果/文件版本。长文本分段读取。', {
      ref: { type: 'string', description: '记录编号、记录 ID 或 64 位 blob 哈希' },
      offset: { type: 'number' }, limit: { type: 'number' },
      range: { type: 'string', description: '摘录的 UTF-16 start:end，原样回读。' },
    }, ['ref'], async (input) => {
      if (source && input.ref.startsWith('case:')) return { content: JSON.stringify(readCaseRef(source, input.ref, input.range)) }
      let row = core.getRecord(input.ref)
      if (!row && /^[a-f0-9]{64}$/.test(input.ref)) row = { id: input.ref, text: core.evidence(input.ref).toString('utf8') }
      return { content: memoryPage(row, input) }
    })
    add('recall', '按线索查旧事。返回带来源的原文摘录；详情用 read，不能把相似命中当事实。', {
      query: { type: 'string' }, n: { type: 'number' }, scope: { type: 'string' },
      passage: { type: 'boolean', description: '按原文窗口排名，返回紧凑摘录。' },
      compact: { type: 'boolean', description: '只返回限量摘录、角色和原文位置。' },
      ...(source ? { cases: { type: 'boolean', description: '查当前项目的短条目和证据引用。' } } : {}),
    }, ['query'], async (input) => {
      if (source && input.cases) return { content: renderCards(searchCases(source, { cue: input.query }), input.n) }
      if (input.passage || input.compact) {
        return { content: core.recallQuotes(input.query, { n: input.n, scope: input.scope, passages: input.passage }) }
      }
      const hits = core.recall(input.query, { n: Math.max(1, Math.min(10, Number(input.n) || 5)), scope: input.scope || null })
      return { content: hits.length ? hits.map((h) => `#${h.seq} ${core.dayOf(h.ts)} <${h.kind}> [${h.who}]\n${excerpt(h.text, 420)}\n来源：${JSON.stringify(h.source || { sid: h.sid, legacy: true })}`).join('\n\n')
        + '\n\n（这里只给摘录；要完整原文用 mem_read #编号。）'
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
