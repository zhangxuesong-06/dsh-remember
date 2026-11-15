#!/usr/bin/env node
// 仅使用本仓库合成 fixture。复制 kgnav 五个源码文件到临时目录，隔绝其本机 data/。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--kgnav', '--python'].includes(key) || !value || options[key]) {
    throw new Error('用法: node agent-memory/test-kgnav.mjs --kgnav <源码目录> [--python python3]')
  }
  options[key] = value
}
if (!options['--kgnav']) throw new Error('必须显式指定 --kgnav <源码目录>；不会探测记忆库')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'method-kgnav-'))
const root = path.join(tmp, 'source')
const mem = path.join(root, 'opencode')
const kg = path.join(tmp, 'kgnav')
const out = path.join(tmp, 'export', 'methods.json')
const graph = path.join(tmp, 'graph.json')
const queries = path.join(tmp, 'queries.jsonl')
const tags = path.join(tmp, 'tags.json')
const env = {
  ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
  AGENT_MEMORY_HOME: root, OPENCODE_MEM_HOME: mem,
  DSH_HOME: path.join(root, 'dsh-home'), DSH_MEMORY_HOME: path.join(root, 'dsh'),
  WORKBUDDY_MEM_HOME: path.join(root, 'workbuddy'), ZCODE_MEM_HOME: path.join(root, 'zcode'),
  MEMORY_DISABLE_MAINTENANCE: '1',
}
const jsonFixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'))
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8')
function run(program, args) {
  const r = spawnSync(program, args, { cwd: kg, env, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `${r.error?.message || ''}\n${r.stderr}\n${r.stdout}`)
  return r.stdout
}
const python = (script, ...args) => run(options['--python'] || 'python', [path.join(kg, script), ...args])
const cli = (...args) => python('cli.py', '--graph', graph, '--no-log', ...args)
const snapshot = (dir) => {
  const hashes = {}
  function walk(base) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const file = path.join(base, e.name)
      if (e.isDirectory()) walk(file)
      else hashes[path.relative(dir, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  walk(dir)
  return hashes
}

try {
  fs.mkdirSync(mem, { recursive: true })
  fs.mkdirSync(path.join(kg, 'data'), { recursive: true })
  for (const name of ['cli.py', 'from_memory.py', 'graph.py', 'nav.py', 'querylog.py']) {
    fs.copyFileSync(path.join(path.resolve(options['--kgnav']), name), path.join(kg, name))
  }
  const catalog = jsonFixture('method-catalog.json')
  const records = jsonFixture('method-records.json')
  const noise = jsonFixture('method-nonmethods.json')
  put(path.join(root, 'methods.json'), catalog)
  put(path.join(root, 'aliases.json'), noise.aliases)
  put(path.join(root, 'assoc.json'), noise.assoc)
  fs.writeFileSync(path.join(mem, 'stream.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.writeFileSync(queries, noise.queries.map((q) => JSON.stringify(q)).join('\n') + '\n')
  put(tags, {}) // 显式空标签，不从 kgnav/data/tags.json 取任何本机断言。
  const before = snapshot(root)
  const queriesBefore = fs.readFileSync(queries)
  const codeBefore = snapshot(kg)

  console.log(run(process.execPath, [path.join(here, 'methods.mjs'), 'export', '--root', root, '--out', out]).trim())
  const exported = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(catalog).sort())
  assert.equal(exported.虚拟机, undefined)
  assert.equal(exported.PMI诱饵, undefined)
  console.log(python('from_memory.py', '--mem-home', mem, '--methods', out,
    '--queries', queries, '--tags', tags, '--no-window', '-o', graph).trim())
  const built = JSON.parse(fs.readFileSync(graph, 'utf8'))
  const hubs = built.nodes.filter((n) => n.id.startsWith('m'))
  assert.equal(hubs.length, 3)
  assert.equal(built.links.filter((e) => e.kind === 'method').length, 5)
  assert.equal(built.links.filter((e) => e.kind === 'cooccur').length, 1)
  assert.ok(built.links.every((e) => ['method', 'cooccur'].includes(e.kind)))
  assert.ok(built.nodes.every((n) => !n.tags?.length))
  assert.ok(built.links.filter((e) => e.kind === 'method').every((e) => e.quote?.includes('提到')))

  const about = cli('--about', 'r1')
  assert.match(about, /概念 · 1/)
  assert.match(about, /方法：手眼标定/)
  assert.match(about, /handeye/)
  assert.match(about, /另外 1 条也提到它/)
  assert.match(about, /合成项目乙/)
  assert.match(about, /共现 · 1/)
  assert.doesNotMatch(about, /近邻 ·|同标签/)
  console.log('\n[记录种子邻域]\n' + about.trim())

  const members = cli('--method', '手眼标定')
  assert.match(members, /2 条记录提到它/)
  assert.match(members, /r1\s/)
  assert.match(members, /r2\s/)
  console.log('\n[方法成员]\n' + members.trim())
  const route = cli('r1', 'r2', '--why')
  assert.match(route, /同方法/)
  assert.match(route, /handeye/)
  assert.match(route, /手眼标定/)
  const hub = hubs.find((n) => n.title === '方法：手眼标定')
  assert.match(cli('--about', hub.id), /合成项目乙/)
  assert.match(cli('--method', 'Dijkstra'), /1 条记录提到它/)
  assert.match(cli('--method', '幂等'), /2 条记录提到它/)
  assert.doesNotMatch(cli('--about', 'r1', '--no-method'), /方法：手眼标定|也提到它/)
  assert.doesNotMatch(cli('--about', 'r1', '--no-cooccur'), /共现 ·/)
  assert.match(cli('--method', '手眼标定', '--no-method'), /方法边被开关关掉了/)
  assert.match(cli('--concept', '虚拟机'), /没有唯一匹配的标签/)
  assert.deepEqual(snapshot(root), before, '合成源库必须逐文件字节不变')
  assert.deepEqual(fs.readFileSync(queries), queriesBefore)
  assert.deepEqual(snapshot(kg), codeBefore, '不写查询日志，不修改 kgnav 源码')
  console.log('\nPASS: 3 方法枢纽 / 5 方法边 / 1 独立共现边 / 0 标签 / 0 语义边；源文件 hash 不变。')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
