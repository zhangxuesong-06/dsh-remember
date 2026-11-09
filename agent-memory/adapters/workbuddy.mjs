// WorkBuddy 适配器：每次 hook 起独立进程，前后配对必须落盘。
import path from 'node:path'

export const meta = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  capabilities: ['hook.stdin', 'hook.process', 'pending.file'],
  entry: 'workbuddy-memory/bin/mem.mjs',
}

export function plan({ repoRoot }) {
  return {
    harness: meta.id,
    adapter: path.join(repoRoot, 'workbuddy-memory'),
    command: [process.execPath, path.join(repoRoot, 'workbuddy-memory', 'install.mjs')],
    cwd: path.join(repoRoot, 'workbuddy-memory'),
    note: '复制脚本并挂 hook；settings.json 改前备份。装完要重开 WorkBuddy。',
    verify: ['node', '~/.workbuddy/skills/self-memory/bin/mem.mjs', 'health'],
  }
}
