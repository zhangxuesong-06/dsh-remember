// Opt-in integration probe. All model responses, commands and files are synthetic.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { caseSource, readCaseRef, runCaseSync, searchCases } from '../dsh-memory/lib/memory-case-index.mjs'

const executable = process.argv[2]
const compact = process.argv[3] === '--compact'
if (!executable || !path.isAbsolute(executable) || process.argv.length !== (compact ? 4 : 3)) {
  console.error('Usage: node agent-memory/probe-opencode-cases.mjs <absolute opencode CLI path> [--compact]')
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

const records = name => fs.readFileSync(path.join(ledger, `${name}.jsonl`), 'utf8').trimEnd().split('\n').map(JSON.parse)
const marker = 'probe-review.txt'
const compactCue = 'synthetic compaction marker'
const compactionLog = path.join(root, 'compaction.jsonl')
const fakeModel = 'probe/fixed'
let step
let actions = []
let sent = []
let providerError
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
    const action = tools.length > 0 ? actions[step++] : undefined
    if (tools.length > 0) sent.push(hint)
    const send = (delta, reason = null) => response.write('data: ' + JSON.stringify({
      id: `chatcmpl-probe-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixed',
      choices: [{ index: 0, delta, finish_reason: reason }],
    }) + '\n\n')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (action) {
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
      { cwd, env, timeout: 30_000, windowsHide: true })
    pending.child.stdin.end()
    await pending
  } catch (error) {
    const log = path.join(ledger, 'diag.log')
    const diagnostics = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
    throw providerError || new Error(`OpenCode stopped after ${step} model requests (${error.signal ?? error.code}):\n`
      + `${error.stderr || ''}\n${error.stdout || ''}\n${diagnostics}`)
  }
  if (providerError) throw providerError
  assert.equal(step, script.length + 1, 'Expected tool calls followed by one final model request')
  return sent
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
      { action: 'edit', resource: marker, effect: 'allow' }],
    providers: { probe: { name: 'Memory probe', package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-loopback' },
      models: { fixed: { name: 'Fixed probe', capabilities: { tools: true }, limit: { context: 32768, output: 8192 } } } } },
  }))
  write(testPath, `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport count from './count.mjs'\ntest('${testName}', () => assert.equal(count, 1))\n`)
  write('count.mjs', 'export default 2\n')
  const args = { command, workdir: cwd, timeout: 5000 }
  await session('Reproduce the synthetic export issue.', [['shell', args], ['shell', args, () => {
    // Change fixture data between runs while keeping the tested file byte-identical.
    write('count.mjs', 'export default 1\n')
  }]])
  assert.deepEqual(records('tools').flatMap(row => row.caseTest ? [row.caseTest.passed] : []), [false, true])
  const source = caseSource('opencode', ledger, cwd, { checkpointed: true })
  assert.equal(runCaseSync(source).state, 'ready')
  assert.ok(searchCases(source, { cue: testName }).cards.some(card => card.status === 'verified'))

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
} finally {
  server.closeAllConnections()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}
