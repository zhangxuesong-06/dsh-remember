import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const shared = ['assemble', 'evidence-files', 'mem-recall', 'memory-cards', 'memory-case-index', 'retrieve', 'signal', 'tokenize']
  .map((name) => `lib/${name}.mjs`)

// Build beside the installed package so a failed copy leaves the previous version usable.
export function replacePackage(destination, populate) {
  const target = path.resolve(destination)
  const parent = path.dirname(target)
  if (target === parent) throw new Error('Cannot replace a filesystem root')
  fs.mkdirSync(parent, { recursive: true })
  const existing = fs.lstatSync(target, { throwIfNoEntry: false })
  const resolvedParent = fs.realpathSync(parent)
  const expected = path.join(resolvedParent, path.basename(target))
  if (existing && (!existing.isDirectory() || fs.realpathSync(target) !== expected)) {
    throw new Error(`Invalid installed package directory: ${target}`)
  }
  const staging = fs.mkdtempSync(path.join(resolvedParent, '.memory-package-'))
  const next = path.join(staging, 'next')
  const previous = path.join(staging, 'previous')
  let preserveBackup = false
  try {
    fs.mkdirSync(next)
    populate(next)
    if (existing) fs.renameSync(expected, previous)
    try {
      fs.renameSync(next, expected)
    } catch (error) {
      if (existing) {
        preserveBackup = true
        fs.renameSync(previous, expected)
        preserveBackup = false
      }
      throw error
    }
  } finally {
    if (!preserveBackup) fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function buildPackage(adapter, destination) {
  if (adapter !== 'dsh' && adapter !== 'zcode') throw new Error(`Unknown package: ${adapter}`)
  const src = path.join(repo, `${adapter}-memory`)
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  if (fs.existsSync(destination)) {
    const target = fs.realpathSync(destination)
    if (target === fs.realpathSync(src)) throw new Error(`Package output would replace its source: ${target}`)
    const previousManifest = path.join(target, 'package.json')
    if (fs.readdirSync(target).length && (!fs.existsSync(previousManifest)
      || JSON.parse(fs.readFileSync(previousManifest, 'utf8')).name !== manifest.name)) {
      throw new Error(`Package output would replace an unrelated directory: ${target}`)
    }
  }
  replacePackage(destination, (staging) => {
    for (const file of ['package.json', ...manifest.files]) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split('/').some((part) => part === '..')) {
        throw new Error(`Expected an explicit package file: ${file}`)
      }
      const canonical = adapter === 'zcode' && shared.includes(file) ? path.join(repo, 'dsh-memory') : src
      const target = path.join(staging, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(canonical, file), target)
    }
  })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [adapter, destination] = process.argv.slice(2)
  if (!destination) throw new Error('Usage: build-package.mjs <dsh|zcode> <destination>')
  buildPackage(adapter, destination)
}
