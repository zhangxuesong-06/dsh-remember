// DSH 适配器：常驻 session/event，按工作区/线隔离。
import path from 'node:path'

export const meta = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  capabilities: ['session.event', 'systemPrompt.section', 'tools.register'],
  entry: 'dsh-memory/index.js',
}

export function plan({ repoRoot, workspace = '' }) {
  return {
    harness: meta.id,
    adapter: path.join(repoRoot, 'dsh-memory'),
    command: ['powershell', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'dsh-memory', 'install.ps1'),
      ...(workspace ? ['-Workspace', workspace] : [])],
    cwd: path.join(repoRoot, 'dsh-memory'),
    note: '复制插件到 ~/.dsh/profiles/node_modules/dsh-memory；配置已存在时保留不动。装完要重启 DSH。',
    verify: ['node', '~/.dsh/profiles/node_modules/dsh-memory/cli.mjs', 'health', '<工作区>'],
  }
}
