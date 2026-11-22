import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { ...process.env, USERPROFILE: dir, HOME: dir, ZCODE_MARKET_HOME: path.join(dir, 'market') } }
}

function run(binary, args, env) {
  const result = spawnSync(binary, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
  return result.stdout
}

test('Windows DSH 安装复用发布清单，升级移除开发文件并保留现有配置', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir, env } = fixture(t)
  const dsh = path.join(dir, '.dsh')
  const profile = path.join(dsh, 'profiles', 'desktop')
  const installed = path.join(dsh, 'profiles', 'node_modules', 'dsh-memory')
  const config = path.join(dsh, 'dsh-memory', 'config.json')
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(installed, { recursive: true })
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["existing"]}}}')
  fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"dsh-memory"}')
  fs.writeFileSync(path.join(installed, 'selftest.mjs'), 'old test')
  fs.writeFileSync(config, '{"workspaces":[],"enabled":false}')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'dsh-memory/install.ps1')]
  run('powershell.exe', args, env)
  run('powershell.exe', args, env)
  const actual = fs.readdirSync(installed, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(installed, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  const listed = json(path.join(repo, 'dsh-memory/package.json')).files
  assert.deepEqual(actual.toSorted(), ['package.json', ...listed].toSorted())
  assert.ok(!actual.some((file) => /selftest|smoke|\.test\.|验-/.test(file)))
  assert.deepEqual(json(path.join(profile, 'package.json')).dsh.profile.bundles, ['existing', 'dsh-memory'])
  assert.deepEqual(json(config), { workspaces: [], enabled: false })
  assert.equal(typeof (await import(pathToFileURL(path.join(installed, 'index.js')))).apply, 'function')
})

test('独立包构建保护已经存在的无关目录', (t) => {
  const { dir, env } = fixture(t)
  const destination = path.join(dir, 'unrelated')
  fs.mkdirSync(destination)
  const original = path.join(destination, 'keep.txt')
  fs.writeFileSync(original, 'keep')
  const result = spawnSync(process.execPath,
    [path.join(repo, 'agent-memory/tools/build-package.mjs'), 'dsh', destination], { cwd: repo, env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(original, 'utf8'), 'keep')
})

test('ZCode 默认只安装记忆，保留已有市场和 Superpowers，并可独立加载核心', (t) => {
  const { dir, env } = fixture(t)
  const source = path.join(env.ZCODE_MARKET_HOME, 'plugins', 'superpowers')
  const cli = path.join(dir, '.zcode', 'cli')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(source, 'owned.txt'), 'keep')
  fs.writeFileSync(path.join(env.ZCODE_MARKET_HOME, 'marketplace.json'), JSON.stringify({
    name: 'hx-local', plugins: [{ name: 'superpowers', source: './plugins/superpowers', version: '1.0.0' }],
  }))
  fs.writeFileSync(path.join(cli, 'config.json'), '{"plugins":{"enabledPlugins":{"superpowers@hx-local":false}}}')
  run(process.execPath, [path.join(repo, 'agent-memory/tools/zcode-market.mjs')], env)
  const db = json(path.join(cli, 'plugins', 'installed_plugins.json'))
  assert.deepEqual(db.plugins.map((item) => item.id), ['zcode-memory@hx-local'])
  assert.deepEqual(json(path.join(cli, 'config.json')).plugins.enabledPlugins,
    { 'superpowers@hx-local': false, 'zcode-memory@hx-local': true })
  assert.equal(fs.readFileSync(path.join(source, 'owned.txt'), 'utf8'), 'keep')
  assert.deepEqual(json(path.join(env.ZCODE_MARKET_HOME, 'marketplace.json')).plugins.map((item) => item.name),
    ['superpowers', 'zcode-memory'])
  assert.equal(fs.existsSync(path.join(db.plugins[0].installPath, 'test.mjs')), false)
  const code = `import { tokenize } from ${JSON.stringify(pathToFileURL(path.join(db.plugins[0].installPath, 'lib', 'tokenize.mjs')).href)}; console.log(tokenize('check').length)`
  assert.equal(run(process.execPath, ['--input-type=module', '-e', code], env).trim(), '1')
})
