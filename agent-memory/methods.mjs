#!/usr/bin/env node
// 显式方法词表。此入口不导入检索层，不读 stream/aliases/assoc，也不识别原文里的方法。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { repoRoot } from './repo.mjs'
import { createJournal } from '../tools/mem-journal.mjs'

const usage = `用法:
  node agent-memory/methods.mjs set <方法名> [别名 ...] [--root <目录>]
  node agent-memory/methods.mjs remove <方法名> [--root <目录>]
  node agent-memory/methods.mjs list [--root <目录>]
  node agent-memory/methods.mjs export --out <文件> [--root <目录>]
--root 默认 AGENT_MEMORY_HOME 或 ~/.agent-memory；只访问 methods.json。
set 替换一组；仅登记经明确选择的方法，普通同义词继续用 aliases.json。
export 输出到源根目录外，供 kgnav 的 --methods 使用。`

function methodName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('_')) {
    throw new Error('方法名必须是非空文本，且不能以下划线开头')
  }
  return value.trim()
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('方法词表必须是 JSON 对象')
  const result = Object.create(null)
  const names = new Set()
  for (const key of Object.keys(raw).sort()) {
    const name = methodName(key)
    const folded = name.toLowerCase()
    if (names.has(folded)) throw new Error('方法名存在大小写或空白重复，请先合并')
    names.add(folded)
    if (!Array.isArray(raw[key])) throw new Error('每个方法的别名必须是文本数组')
    const seen = new Set()
    result[name] = [name, ...raw[key]].filter((term) => {
      if (typeof term !== 'string' || !term.trim()) throw new Error('别名必须是非空文本')
      const id = term.trim().toLowerCase()
      if (seen.has(id)) return false
      seen.add(id)
      return true
    }).map((term) => term.trim())
  }
  return result
}

export function readMethods(root = repoRoot()) {
  const text = fs.readFileSync(path.join(root, 'methods.json'), 'utf8').replace(/^\uFEFF/, '')
  let raw
  try { raw = JSON.parse(text) } catch { throw new Error('方法词表不是有效 JSON；未修改源文件') }
  return normalize(raw)
}

export function setMethod(root, name, aliases = []) {
  const canonical = methodName(name)
  // 在创建目录或锁之前验证本次输入。
  const value = normalize({ [canonical]: aliases })[canonical]
  return createJournal(root).updateJson('methods.json', (raw) => {
    const methods = normalize(raw)
    const key = Object.keys(methods).find((k) => k.toLowerCase() === canonical.toLowerCase()) || canonical
    methods[key] = value
    return normalize(methods)
  })
}

export function removeMethod(root, name) {
  const canonical = methodName(name)
  // 不让拼错路径的 remove 悄悄创建空表。
  readMethods(root)
  return createJournal(root).updateJson('methods.json', (raw) => {
    const methods = normalize(raw)
    const key = Object.keys(methods).find((k) => k.toLowerCase() === canonical.toLowerCase())
    if (!key) throw new Error('没有这个方法；用 list 查看已登记项')
    delete methods[key]
    return methods
  })
}

// 输出目录可能尚未存在；解析已有祖先以防通过目录链接绕过源目录保护。
function physical(file) {
  const absolute = path.resolve(file)
  try { return fs.realpathSync(absolute) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(physical(parent), path.basename(absolute))
  }
}

export function exportMethods(root, out) {
  const methods = readMethods(root)
  const target = path.resolve(out)
  const inside = (base, file) => {
    const relative = path.relative(base, file)
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  }
  // rename 写的是原始路径本身；既保护源目录内的链接，也保护库外指回源目录的链接。
  if (inside(path.resolve(root), target) || inside(physical(root), physical(target))) {
    throw new Error('输出必须在源根目录外，不能覆盖方法表或记忆库文件')
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp-' + randomUUID()
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(methods, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, target)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return methods
}

export function main(argv = process.argv.slice(2)) {
  const flags = {}, words = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0 }
    if (arg === '--root' || arg === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--') || flags[arg]) throw new Error('选项缺值或重复')
      flags[arg] = argv[++i]
    } else if (arg.startsWith('-')) throw new Error('未知选项；用 --help 查看用法')
    else words.push(arg)
  }
  const [cmd, ...args] = words
  const root = flags['--root'] || repoRoot()
  if (cmd === 'set' && args.length && !flags['--out']) {
    setMethod(root, args[0], args.slice(1))
    console.log('已更新显式方法词表')
  } else if (cmd === 'remove' && args.length === 1 && !flags['--out']) {
    removeMethod(root, args[0])
    console.log('已移除方法')
  } else if (cmd === 'list' && !args.length && !flags['--out']) {
    console.log(JSON.stringify(readMethods(root), null, 2))
  } else if (cmd === 'export' && !args.length && flags['--out']) {
    const methods = exportMethods(root, flags['--out'])
    console.log(`已导出 ${Object.keys(methods).length} 个方法（词面索引，不是标签或语义断言）`)
  } else throw new Error(usage)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() } catch (error) {
    // JSON 解析错误可能包含文件内容，不把它回显到日志。
    console.error(error instanceof SyntaxError ? '方法词表不是有效 JSON；未修改源文件' : error.message)
    process.exitCode = 2
  }
}
