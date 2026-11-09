// OpenCode 适配器：请求边界钩子，context 只改发出副本。
import path from 'node:path'

export const meta = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: ['session.hook', 'tool.transform', 'context.copy'],
  entry: 'plugin/self-memory/index.js',
}

export function plan({ repoRoot, home }) {
  return {
    harness: meta.id,
    adapter: path.join(repoRoot, 'plugin', 'self-memory'),
    action: 'update-opencode-config',
    config: path.join(home, '.config', 'opencode', 'opencode.json'),
    pluginPath: path.join(repoRoot, 'plugin', 'self-memory').replace(/\\/g, '/'),
    note: '把插件绝对路径加进全局 opencode.json 的 plugins；已有无关配置不动。',
    verify: ['node', 'tools/mem.mjs', 'health'],
  }
}
