import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportMethods } from './methods.mjs'

const cli = fileURLToPath(new URL('./methods.mjs', import.meta.url))

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'method-test-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const root = path.join(tmp, 'memory')
  fs.mkdirSync(root)
  const catalog = path.join(root, 'methods.json')
  const out = path.join(tmp, 'exports', 'methods.json')
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AGENT_MEMORY_HOME: path.join(tmp, 'unused') },
  })
  const ok = (...args) => {
    const r = run(...args)
    assert.equal(r.status, 0, r.stderr || r.stdout)
    return r.stdout
  }
  return { root, catalog, out, run, ok }
}

test('显式方法新增；导出包含规范名和别名，去空白与大小写重复', (t) => {
  const f = fixture(t)
  f.ok('set', ' 手眼标定 ', ' handeye ', 'HANDEYE', 'calibrateHandEye')
  f.ok('set', 'Dijkstra')
  f.ok('export', '--out', f.out)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')), {
    Dijkstra: ['Dijkstra'], 手眼标定: ['手眼标定', 'handeye', 'calibrateHandEye'],
  })
})

test('替换移除过期别名；删除移除方法；名称匹配不区分大小写', (t) => {
  const f = fixture(t)
  f.ok('set', 'Dijkstra', 'shortest path')
  f.ok('set', 'DIJKSTRA', '最短路')
  assert.deepEqual(JSON.parse(f.ok('list')), { Dijkstra: ['Dijkstra', '最短路'] })
  f.ok('remove', 'dijkstra')
  f.ok('export', '--out', f.out)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')), {})
})

test('只读导出稳定；不读取普通同义词、PMI 或原文；不写锁/索引/日志', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等', 'idempotent')
  for (const name of ['stream.jsonl', 'tools.jsonl', 'aliases.json', 'assoc.json']) {
    fs.writeFileSync(path.join(f.root, name), 'SYNTHETIC_PRIVATE_CANARY not valid JSON')
  }
  const before = Object.fromEntries(fs.readdirSync(f.root).map((n) => [n, fs.readFileSync(path.join(f.root, n))]))
  f.ok('export', '--out', f.out)
  const bytes = fs.readFileSync(f.out)
  f.ok('export', '--out', f.out)
  assert.deepEqual(fs.readFileSync(f.out), bytes)
  assert.doesNotMatch(bytes.toString(), /CANARY|aliases|assoc/)
  assert.deepEqual(fs.readdirSync(f.root).sort(), Object.keys(before).sort())
  for (const [name, data] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(f.root, name)), data)
})

test('缺失源表明确失败，不创建目录或覆盖已有导出', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.dirname(f.out))
  fs.writeFileSync(f.out, 'KEEP')
  assert.equal(f.run('export', '--out', f.out).status, 2)
  assert.equal(fs.readFileSync(f.out, 'utf8'), 'KEEP')
  assert.deepEqual(fs.readdirSync(f.root), [])
})

for (const invalid of ['{broken', 'null', '[]', '{"x":"not-array"}', '{"x":[2]}', '{"_hidden":[]}', '{"x":[""]}', '{"X":[],"x":[]}']) {
  test(`非法词表失败且不覆盖源表或输出: ${invalid}`, (t) => {
    const f = fixture(t)
    fs.writeFileSync(f.catalog, invalid)
    fs.mkdirSync(path.dirname(f.out))
    fs.writeFileSync(f.out, 'KEEP')
    const r = f.run('export', '--out', f.out)
    assert.equal(r.status, 2)
    assert.equal(fs.readFileSync(f.out, 'utf8'), 'KEEP')
    assert.equal(f.run('set', 'new').status, 2)
    assert.equal(fs.readFileSync(f.catalog, 'utf8'), invalid)
  })
}

test('BOM 输入可读；非 ASCII 和带空格别名保留', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.catalog, '\uFEFF{"手眼标定":["hand eye"]}')
  f.ok('export', '--out', f.out)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out, 'utf8')), { 手眼标定: ['手眼标定', 'hand eye'] })
})

test('拒绝覆盖源根目录中的文件，不改源表', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  const before = fs.readFileSync(f.catalog)
  for (const out of [f.catalog, path.join(f.root, 'aliases.json'), path.join(f.root, 'nested', 'out.json')]) {
    assert.equal(f.run('export', '--out', out).status, 2)
  }
  assert.deepEqual(fs.readFileSync(f.catalog), before)
})

test('显式共享根目录默认值生效，不探测或创建其它记忆库', (t) => {
  const f = fixture(t)
  const r = spawnSync(process.execPath, [cli, 'set', '双向搜索', 'bidirectional'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_MEMORY_HOME: f.root },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(f.ok('list')), { 双向搜索: ['双向搜索', 'bidirectional'] })
})

test('导出路径经目录链接回到源根时仍拒绝', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  const linked = path.join(path.dirname(f.root), 'linked-source')
  fs.symlinkSync(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(f.run('export', '--out', path.join(linked, 'nested', 'out.json')).status, 2)
  assert.equal(fs.existsSync(path.join(f.root, 'nested')), false)
})

test('导出实际只读取方法表，不读取任何邻近文件', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  const original = fs.readFileSync
  const reads = []
  fs.readFileSync = function (file, ...args) {
    reads.push(path.resolve(String(file)))
    return original.call(this, file, ...args)
  }
  try { exportMethods(f.root, f.out) } finally { fs.readFileSync = original }
  assert.deepEqual(reads, [path.resolve(f.catalog)])
})

test('并发登记独立方法不丢更新，沿用 journal 锁', async (t) => {
  const f = fixture(t)
  await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'set', `方法${i}`, `alias-${i}`, '--root', f.root], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
  })))
  assert.equal(Object.keys(JSON.parse(f.ok('list'))).length, 6)
})

test('目标不能写入时保留源表并清理临时输出', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  fs.mkdirSync(f.out, { recursive: true }) // 目标是目录，rename 必须失败。
  const before = fs.readFileSync(f.catalog)
  assert.equal(f.run('export', '--out', f.out).status, 2)
  assert.deepEqual(fs.readFileSync(f.catalog), before)
  assert.deepEqual(fs.readdirSync(path.dirname(f.out)), ['methods.json'])
})

test('源目录内的向外目录链接也不能用作导出路径', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  const external = path.join(path.dirname(f.root), 'external')
  fs.mkdirSync(external)
  const link = path.join(f.root, 'redirect')
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  const before = fs.readFileSync(f.catalog)
  assert.equal(f.run('export', '--out', path.join(link, 'methods.json')).status, 2)
  assert.deepEqual(fs.readFileSync(f.catalog), before)
  assert.equal(fs.existsSync(path.join(external, 'methods.json')), false)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('源文件指向库外时也不能被导出替换', (t) => {
  const f = fixture(t)
  f.ok('set', '幂等')
  const external = path.join(path.dirname(f.root), 'synthetic-stream.jsonl')
  fs.writeFileSync(external, 'SYNTHETIC_SOURCE_MUST_STAY')
  const link = path.join(f.root, 'stream.jsonl')
  try { fs.symlinkSync(external, link, 'file') } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('当前系统不允许文件符号链接；同一词面路径保护由向外目录 junction 测试覆盖')
      return
    }
    throw error
  }
  assert.equal(f.run('export', '--out', link).status, 2)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(external, 'utf8'), 'SYNTHETIC_SOURCE_MUST_STAY')
})

for (const args of [[], ['unknown'], ['set'], ['set', '_meta'], ['set', 'x', '--bad'], ['export'], ['export', '--out'], ['remove'], ['list', 'extra']]) {
  test(`错误命令非零退出且不写源表: ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t)
    assert.equal(f.run(...args).status, 2)
    assert.equal(fs.existsSync(f.catalog), false)
  })
}
