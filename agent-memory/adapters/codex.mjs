import path from 'node:path'

export const meta = {
  id: 'codex',
  label: 'Codex',
  capabilities: ['hook.stdin', 'hook.process', 'skill'],
  entry: 'codex-memory/hook.mjs',
}

export function plan({ repoRoot }) {
  const adapter = path.join(repoRoot, 'codex-memory')
  return {
    harness: meta.id,
    adapter,
    command: [process.execPath, path.join(adapter, 'install.mjs')],
    cwd: repoRoot,
    note: '安装本地 codex-memory 插件。启动新会话后在 Codex 的 Hooks 页面审阅钩子。',
    verify: [process.execPath, path.join(repoRoot, 'agent-memory', 'coverage.mjs'), '--source', 'codex'],
  }
}
