// Opt-in integration probe with synthetic files and either a scripted or local model.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { caseSource, readCaseRef, runCaseSync, searchCases } from '../dsh-memory/lib/memory-case-index.mjs'
import { readBlob } from '../tools/mem-artifacts.mjs'
import { createJournal, sha256 } from '../tools/mem-journal.mjs'

const executable = process.argv[2]
const compact = process.argv[3] === '--compact'
const ollama = process.argv[3] === '--ollama' ? process.argv[4] : null
const fullTask = process.argv[ollama ? 5 : 3] === '--full-task'
if (!executable || !path.isAbsolute(executable) || process.argv.length !== (ollama ? (fullTask ? 6 : 5) : compact || fullTask ? 4 : 3)) {
  console.error('Usage: node agent-memory/probe-opencode-cases.mjs <absolute opencode CLI path> [--compact | --full-task | --ollama <local model> [--full-task]]')
  process.exit(2)
}

const run = promisify(execFile)
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'case-opencode-')))
const mkdir = name => fs.mkdirSync(path.join(root, name))
mkdir('project')
mkdir('ledger')
const cwd = path.join(root, 'project')
const ledger = path.join(root, 'ledger')
const plugin = fileURLToPath(new URL('../plugin/self-memory/', import.meta.url))
const testName = 'retries share export_id'
const testPath = 'export.test.mjs'
const policyPath = 'export-policy.json'
const failingPolicy = '{"dedupeBy":"attempt_id"}\n'
const fixedPolicy = '{"dedupeBy":"export_id"}\n'
const command = `node --test --test-reporter=tap ${testPath}`
const write = (name, content) => fs.writeFileSync(path.join(cwd, name), content)
const env = { ...process.env, OPENCODE_MEM_HOME: ledger, MEMORY_CASE_RECALL: 'auto',
  MEMORY_DISABLE_MAINTENANCE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  NO_PROXY: '127.0.0.1,localhost', PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }
delete env.OPENCODE_CONFIG
delete env.OPENCODE_CONFIG_DIR
delete env.OPENCODE_CONFIG_CONTENT
delete env.NODE_TEST_CONTEXT
for (const name of ['data', 'config', 'cache', 'state']) {
  mkdir(name)
  env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name)
}

const records = (name, directory = ledger) =>
  fs.readFileSync(path.join(directory, `${name}.jsonl`), 'utf8').trimEnd().split('\n').map(JSON.parse)
const marker = 'probe-review.txt'
const compactCue = 'synthetic compaction marker'
const compactionLog = path.join(root, 'compaction.jsonl')
const fakeModel = 'probe/fixed'
let step
let actions = []
let sent = []
let providerError
let modelRequests
const allowedActions = new Set(['grep', 'read', 'mem_recall', 'mem_read', ...(fullTask ? ['write', 'shell'] : [])])

function allowedPolicy(content) {
  if (typeof content !== 'string' || content.length > 1024) return false
  try {
    const data = JSON.parse(content)
    return Object.keys(data).length === 1 && ['attempt_id', 'export_id'].includes(data.dedupeBy)
  } catch {
    return false
  }
}

async function askOllama(body, hint) {
  if (modelRequests.length >= (fullTask ? 12 : 8)) return { content: 'Probe request limit reached.' }
  const tools = (body.tools || []).filter(tool => allowedActions.has(tool.function.name))
  const available = tools.map(tool => tool.function.name)
  assert.ok(!body.tools?.length || [...allowedActions].every(name => available.includes(name)),
    `Expected probe tools are missing from request: ${available.join(', ')}`)
  const toolNames = new Map()
  const messages = body.messages.map(({ role, content, tool_calls, tool_call_id }) => {
    const message = { role, content: typeof content === 'string' ? content
      : (content || []).map(part => part.text || '').join('\n') }
    if (tool_calls) message.tool_calls = tool_calls.map(call => {
      toolNames.set(call.id, call.function.name)
      return { function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } }
    })
    if (role === 'tool') message.tool_name = toolNames.get(tool_call_id)
    return message
  })
  const result = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: ollama, messages, tools, stream: false, keep_alive: '2m',
      options: { num_ctx: 16384, num_predict: 256, temperature: 0, seed: 42 } }),
  })
  if (!result.ok) throw new Error(`Ollama ${result.status}: ${await result.text()}`)
  const answer = await result.json()
  const { content, tool_calls: calls = [] } = answer.message
  const localFile = (value, ...names) => names.some(name => value === name || value === path.join(cwd, name))
  const accepted = calls.filter(({ function: { name, arguments: args } }) => {
    if (!args || typeof args !== 'object' || !tools.some(tool => tool.function.name === name)) return false
    if (name === 'grep') return typeof args.pattern === 'string' && args.pattern.length <= 80
      && (!args.path || ['.', cwd].includes(args.path)) && (!args.include || ['*.mjs', testPath].includes(args.include))
    if (name === 'read') return localFile(args.path, testPath, fullTask ? policyPath : 'count.mjs')
    if (name === 'write') return localFile(args.path, policyPath) && allowedPolicy(args.content)
    if (name === 'shell') return args.command === command && !args.background && (!args.workdir || ['.', cwd].includes(args.workdir))
      && (args.timeout == null || (Number.isFinite(args.timeout) && args.timeout > 0 && args.timeout <= 10_000))
    return true
  })
  assert.ok(Number.isSafeInteger(answer.prompt_eval_count) && answer.prompt_eval_count > 0, 'Missing model input token count')
  modelRequests.push({ input: answer.prompt_eval_count, cached: answer.prompt_eval_cached_count ?? null,
    output: answer.eval_count, finishReason: answer.done_reason ?? null, hint: !!hint,
    providerTools: body.tools?.map(tool => tool.function.name) || [],
    available, actions: calls.map(call => call.function),
    accepted: accepted.map(call => call.function.name), content })
  if (!accepted.length) return { content: content || 'Probe received no supported tool call.' }
  return { tool_calls: accepted.map(({ function: fn }, index) => ({
    index, id: `model_${modelRequests.length}_${index}`, type: 'function',
    function: { name: fn.name, arguments: JSON.stringify(fn.arguments) },
  })) }
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions')
    const body = JSON.parse(await Array.fromAsync(request).then(chunks => Buffer.concat(chunks)))
    const tools = (body.tools || []).map(tool => tool.function.name)
    const user = body.messages.filter(message => message.role === 'user')
    const matches = JSON.stringify(user).match(/<memory-case>/g) || []
    const text = user.flatMap(message => Array.isArray(message.content) ? message.content.map(part => part.text) : [message.content])
    const hint = text.join('\n').match(/<memory-case>[\s\S]+?<\/memory-case>/)?.[0]
    assert.equal(matches.length, Number(!!hint))
    const model = modelRequests && await askOllama(body, hint)
    const action = tools.length > 0 ? actions[step++] : undefined
    if (tools.length > 0) sent.push(hint)
    const send = (delta, reason = null) => response.write('data: ' + JSON.stringify({
      id: `chatcmpl-probe-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixed',
      choices: [{ index: 0, delta, finish_reason: reason }],
    }) + '\n\n')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (model) {
      send({ role: 'assistant', ...model })
      send({}, model.tool_calls ? 'tool_calls' : 'stop')
    } else if (action) {
      const [name, args, prepare] = action
      assert.ok(tools.includes(name), name)
      prepare?.()
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${step}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] })
      send({}, 'tool_calls')
    } else {
      send({ role: 'assistant', content: 'Synthetic probe completed.' })
      send({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  } catch (error) {
    providerError = error
    response.destroy(error)
  }
})

async function session(prompt, script) {
  step = 0
  actions = script
  sent = []
  try {
    const pending = run(executable, ['run', '--standalone', '--model', fakeModel, prompt],
      { cwd, env, timeout: modelRequests ? 120_000 : 30_000, windowsHide: true })
    pending.child.stdin.end()
    await pending
  } catch (error) {
    const log = path.join(env.OPENCODE_MEM_HOME, 'diag.log')
    const diagnostics = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
    throw providerError || new Error(`OpenCode stopped after ${step} model requests (${error.signal ?? error.code}):\n`
      + `${error.stderr || ''}\n${error.stdout || ''}\n${diagnostics}`)
  }
  if (providerError) throw providerError
  if (!modelRequests) assert.equal(step, script.length + 1, 'Expected tool calls followed by one final model request')
  return sent
}

async function compareTasks() {
  const snapshot = path.join(root, 'seed')
  fs.cpSync(ledger, snapshot, { recursive: true })
  const findTest = '导出断了再点别多一份。先调用 grep，参数为 {"pattern":"retries share","include":"*.mjs"}，定位当前测试。'
  const prompt = findTest + (fullTask
    ? `读 ${testPath} 和 ${policyPath}，用 write 修改 ${policyPath}，不要修改测试。用 shell 执行 ${command} 确认回归。历史证据相关时可以用记忆工具核对。`
    : '这是只读核查，请说明在修改代码前应确认哪个条件，有历史证据时可以用记忆工具核对。')
  const initial = fullTask ? sha256(Buffer.concat([fs.readFileSync(path.join(cwd, testPath)), Buffer.from(failingPolicy)])) : null
  for (const [group, mode] of [['baseline', 'off'], ['manual', 'manual'], ['auto', 'auto']]) {
    const trial = path.join(root, group)
    fs.cpSync(snapshot, trial, { recursive: true })
    assert.equal(createJournal(trial).sync().status, 'OK')
    assert.equal(runCaseSync(caseSource('opencode', trial, cwd), true).state, 'ready')
    env.OPENCODE_MEM_HOME = trial
    env.MEMORY_CASE_RECALL = mode
    if (fullTask) write(policyPath, failingPolicy)
    modelRequests = ollama ? [] : undefined
    const script = ollama ? [] : [
      ['grep', { pattern: testName, include: '*.mjs' }],
      ['read', { path: policyPath }],
      ['write', { path: policyPath, content: fixedPolicy }],
      ['shell', { command, workdir: cwd, timeout: 5000 }],
    ]
    const started = performance.now()
    const hints = await session(prompt, script)
    const report = { group, model: ollama, inputTokens: modelRequests?.reduce((total, request) => total + request.input, 0) ?? null,
      outputTokens: modelRequests?.reduce((total, request) => total + (request.output || 0), 0) ?? null, requests: modelRequests }
    if (fullTask) {
      const elapsedMs = Math.round(performance.now() - started)
      const outcomes = records('tools', trial).slice(records('tools', snapshot).length)
      const firstWrite = outcomes.findIndex(row => row.phase === 'call' && row.tool === 'write')
      const writeRequest = modelRequests
        ? modelRequests.filter(request => request.available.length).findIndex(request => request.accepted.includes('write'))
        : script.findIndex(([tool]) => tool === 'write')
      const beforeWrite = firstWrite < 0 ? [] : outcomes.slice(0, firstWrite)
      const reads = new Set(beforeWrite.filter(row => row.phase === 'completed' && row.tool === 'read').map(row => row.callID))
      const checkedPolicyBeforeWrite = beforeWrite.some(row => {
        if (row.phase !== 'call' || row.tool !== 'read' || !reads.has(row.callID) || !row.input?.sha256) return false
        const { path: target } = JSON.parse(readBlob(trial, row.input.sha256))
        return target === policyPath || target === path.join(cwd, policyPath)
      })
      const policy = fs.readFileSync(path.join(cwd, policyPath), 'utf8')
      const { stdout, code } = await run(process.execPath, ['--test', '--test-reporter=tap', testPath], { cwd, env, timeout: 10_000 })
        .catch(error => {
          if (error.code !== 1) throw error
          return error
        })
      Object.assign(report, { scenario: 'export-retry', snapshot: initial, elapsedMs, checkedPolicyBeforeWrite,
        hintDelivered: hints.some(Boolean), writeObserved: firstWrite >= 0, policyChanged: policy !== failingPolicy,
        hintBeforeWrite: firstWrite >= 0 && writeRequest >= 0 && hints.slice(0, writeRequest + 1).some(Boolean),
        memoryReadsBeforeWrite: beforeWrite.filter(row => row.phase === 'completed' && row.tool === 'mem_read').length,
        sessionTestCalls: outcomes.filter(row => row.phase === 'completed' && row.tool === 'shell').length,
        testPassed: code === undefined && /^# pass 1$/m.test(stdout) && /^# fail 0$/m.test(stdout),
        toolEvents: outcomes.map(row => [row.tool, row.phase]) })
      if (!ollama) {
        assert.ok(report.checkedPolicyBeforeWrite && report.policyChanged && report.testPassed, JSON.stringify(report))
        assert.equal(report.sessionTestCalls, 1)
        assert.equal(report.hintBeforeWrite, mode === 'auto')
      }
    }
    console.log(JSON.stringify(report))
  }
}

try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  if (compact) {
    mkdir('project/probe-compact')
    write('probe-compact/index.js', `import { Plugin } from '@opencode/plugin'
import fs from 'node:fs'
export default Plugin.define({ id: 'probe-compact', async setup(ctx) {
  const controller = new AbortController()
  const emit = value => fs.appendFileSync(${JSON.stringify(compactionLog)}, JSON.stringify(value) + '\\n')
  await ctx.tool.hook('execute.after', async event => {
    if (event.tool === 'grep' && event.input?.pattern?.startsWith(${JSON.stringify(compactCue)})) {
      await ctx.session.compact({ sessionID: event.sessionID })
    }
  })
  await ctx.session.hook('compaction', event => {
    emit({ type: 'hook', keys: Object.keys(event) })
    event.result = { summary: 'Synthetic checkpoint for the export task.' }
  })
  await ctx.session.hook('context', async event => {
    const messages = await ctx.session.context({ sessionID: event.sessionID })
    for (const message of messages) {
      if (message.type === 'compaction') emit({ type: 'canonical', message })
    }
  })
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type.startsWith('session.compaction.')) emit({ type: event.type, data: event.data })
    }
  })()
  return () => controller.abort()
} })
`)
  }
  write('opencode.json', JSON.stringify({
    plugins: compact ? [plugin, './probe-compact'] : [plugin], model: fakeModel,
    permissions: [{ action: 'shell', resource: command, effect: 'allow' },
      { action: 'edit', resource: fullTask ? policyPath : marker, effect: 'allow' },
      ...(ollama || fullTask ? [{ action: 'execute', resource: '*', effect: 'deny' }] : [])],
    providers: { probe: { name: 'Memory probe', package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-loopback' },
      models: { fixed: { name: 'Fixed probe', capabilities: { tools: true }, limit: { context: 32768, output: 8192 } } } } },
  }))
  const fixturePath = fullTask ? policyPath : 'count.mjs'
  const testHeader = "import test from 'node:test'\nimport assert from 'node:assert/strict'\n"
  write(testPath, testHeader + (fullTask
    ? `import { readFileSync } from 'node:fs'
const { dedupeBy } = JSON.parse(readFileSync(new URL('./${policyPath}', import.meta.url), 'utf8'))
assert.ok(['attempt_id', 'export_id'].includes(dedupeBy))
const first = { attempt_id: 'try-1', export_id: 'export-1' }
const retry = { attempt_id: 'try-2', export_id: 'export-1' }
const independent = { attempt_id: 'try-3', export_id: 'export-2' }
const count = attempts => new Set(attempts.map(attempt => attempt[dedupeBy])).size
test('${testName}', () => {
  assert.equal(count([first, retry]), 1)
  assert.equal(count([first, independent]), 2)
})
`
    : `import count from './count.mjs'\ntest('${testName}', () => assert.equal(count, 1))\n`))
  write(fixturePath, fullTask ? failingPolicy : 'export default 2\n')
  const args = { command, workdir: cwd, timeout: 5000 }
  await session('Reproduce the synthetic export issue.', [['shell', args], ['shell', args, () => {
    // Change fixture data between runs while keeping the tested file byte-identical.
    write(fixturePath, fullTask ? fixedPolicy : 'export default 1\n')
  }]])
  assert.deepEqual(records('tools').flatMap(row => row.caseTest ? [row.caseTest.passed] : []), [false, true])
  const source = caseSource('opencode', ledger, cwd, { checkpointed: true })
  assert.equal(runCaseSync(source).state, 'ready')
  assert.ok(searchCases(source, { cue: testName }).cards.some(card => card.status === 'verified'))

  if (ollama || fullTask) {
    await compareTasks()
  } else {
    const inspect = [['grep', { pattern: testName, include: '*.mjs' }]]
    if (compact) {
      for (const suffix of ['', ' again']) inspect.push(['grep', { pattern: compactCue + suffix, include: '*.mjs' }])
    }
    inspect.push(['write', { path: marker, content: 'synthetic write\n' }])
    const hints = await session('导出断了再点别多一份', inspect)
    assert.equal(hints[0], undefined)
    assert.ok(hints[1]?.includes(testName), 'The provider request after grep must contain the case, before write')
    const sizes = hints.filter(Boolean).map(hint => Buffer.byteLength(hint) + 2)
    assert.ok(sizes.every(size => size <= 512))
    assert.ok(sizes.reduce((total, size) => total + size, 0) <= 1536)
    if (compact) {
      const events = fs.readFileSync(compactionLog, 'utf8').trimEnd().split('\n').map(JSON.parse)
      assert.equal(events.filter(event => event.type === 'session.compaction.ended').length, 2)
      assert.equal(new Set(events.filter(event => event.type === 'canonical' && event.message.status === 'completed')
        .map(event => event.message.id)).size, 2)
      assert.equal(hints[2], hints[1], 'Expected the same evidence once after compaction')
      assert.equal(hints[3], hints[1], 'A second checkpoint permits exactly one more resend')
    }
    assert.equal(hints.at(-1), undefined)
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8'), 'synthetic write\n')
    const evidence = readCaseRef(source, hints[1].match(/case:[\w:-]+/)[0])
    assert.equal(evidence.state, 'exact')
    assert.match(JSON.parse(evidence.text).output.output, /^# pass 1$/m)
    assert.equal(runCaseSync(source).state, 'ready')
    const afterWrite = await session('导出断了再点别多一份', [
      ['write', { path: marker, content: 'synthetic early write\n' }], inspect[0],
    ])
    assert.deepEqual(afterWrite, [undefined, undefined, undefined], 'Skip a first hint after a write')
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8'), 'synthetic early write\n')
    assert.ok(records('stream').every(row => !row.text?.includes('<memory-case>')))
    console.log(JSON.stringify({ shellExits: [1, 0], hintBytes: Buffer.byteLength(hints[1]), receivedBeforeWrite: true,
      compactions: compact ? 2 : 0, silentAfterWrite: true, exactEvidence: true, canonicalHistoryClean: true }))
  }
} finally {
  server.closeAllConnections()
  server.close()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
