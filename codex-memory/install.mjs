import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(here)
const defaultMarketplace = path.join(here, 'local-marketplace')
const pluginName = 'codex-memory'
const marketplaceName = 'local-agent-memory'
const files = [
  ['codex-memory/.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['codex-memory/hooks/hooks.json', 'hooks/hooks.json'],
  ['codex-memory/skills/codex-memory/SKILL.md', 'skills/codex-memory/SKILL.md'],
  'codex-memory/hook.mjs',
  'agent-memory/recall.mjs',
  'agent-memory/repo.mjs',
  'tools/mem-tokenize.mjs',
  'tools/mem-journal.mjs',
]

export function buildMarketplace(root = defaultMarketplace) {
  const plugin = path.join(root, 'plugins', pluginName)
  for (const file of files) {
    const [source, target] = Array.isArray(file) ? file : [file, file]
    const dest = path.join(plugin, target)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(repo, source), dest)
  }
  const manifest = path.join(root, '.agents', 'plugins', 'marketplace.json')
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, JSON.stringify({
    name: marketplaceName,
    plugins: [{
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }, null, 2) + '\n')
  return root
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && args[0] !== '--package-only')) {
    console.error('Usage: node codex-memory/install.mjs [--package-only]')
    process.exit(2)
  }
  const root = buildMarketplace()
  if (args[0] === '--package-only') {
    console.log(root)
  } else {
    for (const command of [['marketplace', 'add', root], ['add', `${pluginName}@${marketplaceName}`]]) {
      const result = spawnSync('codex', ['plugin', ...command], { stdio: 'inherit', windowsHide: true })
      if (result.error || result.status !== 0) {
        console.error(result.error?.message || `codex plugin ${command[0]} failed (${result.status})`)
        process.exit(result.status || 1)
      }
    }
  }
}
