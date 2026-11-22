import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildPackage } from './tools/build-package.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const query = '稀土磁环 zirconium'
const original = `${'背景材料说明。'.repeat(500)}\r\n  🧲 ${query}\n    保留缩进。${'其他文字。'.repeat(90)}`

function run(args, env, input) {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, input, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function exercise(recall, wholeRecall, read, primaryRef) {
  const compact = recall(query)
  assert.ok(Buffer.byteLength(compact) <= 3072)
  const hits = JSON.parse(compact)
  assert.ok(hits.length >= 2 && hits.length <= 5)
  assert.equal(new Set(hits.map((hit) => hit.ref)).size, hits.length)
  const [hit] = hits
  assert.equal(hit.ref, primaryRef)
  assert.equal(hit.who, 'assistant')
  assert.ok(hit.start > 2000)
  assert.ok(hit.text.includes(`🧲 ${query}\n    保留缩进`))
  assert.ok(hit.end - hit.start <= 192)
  assert.equal(hit.text, original.slice(hit.start, hit.end))
  assert.deepEqual(JSON.parse(read(hit.ref, `${hit.start}:${hit.end}`)), hit)
  assert.ok(Array.isArray(JSON.parse(wholeRecall(query))))
}

test('四端 CLI 分段定位、紧凑摘录及原样回读，DSH 与 WorkBuddy 保留工作区边界', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-recall-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, DSH_MEMORY_HOME: path.join(dir, 'dsh'), OPENCODE_MEM_HOME: path.join(dir, 'oc'),
    WORKBUDDY_MEM_HOME: path.join(dir, 'wb'), ZCODE_MEM_HOME: path.join(dir, 'zc'), MEMORY_DISABLE_MAINTENANCE: '1' }
  const cwd = path.join(dir, 'workspace')
  const rows = [original, ...Array.from({ length: 8 }, (_, i) => `${'填充文字。'.repeat(70)} 稀土磁环 材料${i}\n${'界'.repeat(200)}`)]
    .map((text, i) => ({ text, who: 'me', sid: `session-${i}`, ws: 'project-a', ts: 1000, type: 'assistant/message' }))
  const write = (root, data) => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'stream.jsonl'), data.map((row) => JSON.stringify(row) + '\n').join(''))
  }
  const dsh = path.join(dir, 'dsh-package')
  const zcode = path.join(dir, 'zcode-package')
  buildPackage('dsh', dsh)
  buildPackage('zcode', zcode)
  run(['workbuddy-memory/install.mjs'], { ...env, HOME: dir, USERPROFILE: dir })
  const dshDir = (workspace) => run(['--input-type=module', '-e',
    `import { workspaceDir } from ${JSON.stringify(new URL('../dsh-memory/lib/config.mjs', import.meta.url).href)}; console.log(workspaceDir(process.argv[1]))`, workspace], env).trim()
  const outside = { ...rows[0], text: query, ws: 'project-b' }
  write(dshDir(cwd), rows)
  write(dshDir(path.join(dir, 'elsewhere')), [outside])
  write(env.ZCODE_MEM_HOME, rows)
  write(env.WORKBUDDY_MEM_HOME, [...rows, outside])
  write(env.OPENCODE_MEM_HOME, rows.map((row, i) => ({ ...row, seq: i + 1, id: `oc-${i}`, who: 'assistant', kind: 'message' })))

  for (const [entry, prefix, scope, ref] of [
    ['tools/mem.mjs', [], ['--ws', 'project-a'], '#1'],
    [path.join(dsh, 'cli.mjs'), [cwd], [], '0'],
    [path.join(dir, '.workbuddy', 'skills', 'self-memory', 'bin', 'mem.mjs'), [], ['--ws', 'project-a'], '0'],
    [path.join(zcode, 'bin', 'cli.mjs'), [], [], '0'],
  ]) {
    const cli = (command, ...args) => run([entry, command, ...prefix, ...args], env)
    exercise((query) => cli('recall', query, ...scope, '--rank', 'passage'),
      (query) => cli('recall', query, ...scope, '--compact'),
      (ref, range) => cli('show', ref, '--range', range), ref)
  }
  const opencode = run(['--input-type=module', '-'], env, `
    import assert from 'node:assert/strict'
    import { registerHooks } from 'node:module'
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@opencode/plugin') {
        return { url: 'data:text/javascript,export const Plugin={define:x=>x}', shortCircuit: true }
      }
      return next(specifier, context)
    } })
    const { default: plugin } = await import(${JSON.stringify(new URL('../plugin/self-memory/index.js', import.meta.url).href)})
    const tools = new Map()
    const hook = async () => ({ dispose() {} })
    const cleanup = await plugin.setup({ session: { hook }, tool: { hook,
      transform: (fn) => fn({ namespace() {}, add: (tool) => tools.set(tool.name, tool) }),
    } })
    assert.equal(typeof cleanup, 'function')
    const result = await tools.get('recall').execute({ query: ${JSON.stringify(query)}, passage: true })
    const [quote] = JSON.parse(result.content)
    const read = await tools.get('read').execute({ ref: quote.ref, range: quote.start + ':' + quote.end })
    assert.deepEqual(JSON.parse(read.content), quote)
    console.log(quote.ref)
    await cleanup()
  `)
  assert.equal(opencode.trim(), '#1')
  const rpc = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const response = run([path.join(zcode, 'bin', 'mcp.mjs')], env,
    [rpc(1, 'recall', { query, passage: true }), rpc(2, 'memory_read', { id: '0', range: '0:30' })].join('\n') + '\n')
    .trim().split('\n').map(JSON.parse)
  assert.equal(JSON.parse(response[0].result.content[0].text)[0].ref, '0')
  assert.equal(JSON.parse(response[1].result.content[0].text).text, original.slice(0, 30))
})
