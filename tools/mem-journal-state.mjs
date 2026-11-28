import fs from 'node:fs'
import path from 'node:path'

export function withMutableState({ root, append, rows, locked, atomicWrite }) {
  function updateJson(name, update) {
    if (!['pins.json', 'aliases.json', 'methods.json'].includes(name)) throw new Error('Unknown mutable state')
    return locked(() => {
      const file = path.join(root, name)
      const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
      const next = update(old)
      atomicWrite(file, next)
      return next
    })
  }
  return { root, append, rows, updateJson }
}
