// OpenCode entrypoint. Capture and retrieval stay testable without a running server.
// Runtime generation 24: explicit runtime allowlist; cross-harness query moved out of the plugin.
import { Plugin } from '@opencode/plugin'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS = path.resolve(HERE, '../../tools')

export default Plugin.define({
  id: 'self-memory',
  async setup(ctx) {
    try {
      // Real versioned paths also refresh transitive imports. URL query strings alone
      // do not reliably invalidate the desktop server's transformed module cache.
      // Explicit allowlist: only modules the plugin runtime actually imports or spawns.
      // CLI/tools live elsewhere and must not be copied into the runtime bundle.
      const RUNTIME = [
        'mem-core.mjs', 'mem-journal.mjs', 'mem-artifacts.mjs', 'mem-facets.mjs', 'mem-assoc.mjs',
        'mem-tokenize.mjs', 'mem-recall.mjs', 'mem-capture.mjs', 'mem-context.mjs', 'mem-plugin.mjs', 'mem-maintenance.mjs',
      ]
      const shared = ['memory-cards.mjs', 'memory-case-index.mjs', 'memory-case-hint.mjs', 'tokenize.mjs']
      const names = [...RUNTIME, ...shared].sort()
      for (const name of RUNTIME) {
        if (!fs.existsSync(path.join(TOOLS, name))) throw new Error('Runtime module missing: ' + name)
      }
      const unlisted = fs.readdirSync(TOOLS).filter((n) => /^mem-.*\.mjs$/.test(n) && !RUNTIME.includes(n))
      if (unlisted.length) throw new Error('Runtime module not listed: ' + unlisted.join(', '))
      const files = names.map((name) => [name, fs.readFileSync(name === 'mem-recall.mjs' || shared.includes(name)
        ? path.resolve(TOOLS, '../dsh-memory/lib', name) : path.join(TOOLS, name))])
      const digest = createHash('sha256')
      for (const [name, bytes] of files) digest.update(name).update('\0').update(bytes).update('\0')
      const version = digest.digest('hex')
      const cache = path.join(process.env.OPENCODE_MEM_HOME || path.join(os.homedir(), '.opencode-mem'), 'runtime')
      const bundle = path.join(cache, version)
      fs.mkdirSync(cache, { recursive: true })
      if (!fs.existsSync(bundle)) {
        const staging = fs.mkdtempSync(path.join(cache, 'loading-'))
        try {
          for (const [name, bytes] of files) fs.writeFileSync(path.join(staging, name), bytes)
          try { fs.renameSync(staging, bundle) } catch (error) { if (!fs.existsSync(bundle)) throw error }
        } finally { fs.rmSync(staging, { recursive: true, force: true }) }
      }
      for (const [name, bytes] of files) {
        if (!fs.readFileSync(path.join(bundle, name)).equals(bytes)) throw new Error('Runtime bundle differs: ' + name)
      }
      const core = await import(pathToFileURL(path.join(bundle, 'mem-core.mjs')).href)
      const { setupMemory } = await import(pathToFileURL(path.join(bundle, 'mem-plugin.mjs')).href)
      return await setupMemory(ctx, core)
    } catch (error) {
      console.error('[self-memory] 载入失败：' + error.message)
    }
  },
})
