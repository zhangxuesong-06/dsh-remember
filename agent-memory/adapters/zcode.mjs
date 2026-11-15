// ZCode 适配器：插件（skills + hooks + MCP）形态，写入共享库 ~/.agent-memory/zcode。
//
// 与 WorkBuddy 同属「每次钩子起独立进程」，但多了常驻 stdio MCP 做检索；
// 安装不是复制脚本，而是生成一个本地插件市场再在客户端里安装。
import path from 'node:path'

export const meta = {
  id: 'zcode',
  label: 'ZCode',
  capabilities: ['hook.stdin', 'hook.process', 'mcp.stdio', 'pending.file'],
  entry: 'zcode-memory/bin/hook.mjs',
}

export function plan({ repoRoot }) {
  return {
    harness: meta.id,
    adapter: path.join(repoRoot, 'zcode-memory'),
    command: [process.execPath, path.join(repoRoot, 'agent-memory', 'tools', 'zcode-market.mjs')],
    cwd: repoRoot,
    note: '生成 ~/.zcode/local-marketplace（superpowers + zcode-memory）并注册到用户配置；'
      + '之后在 Settings → Plugin Management → Discover 里安装 zcode-memory，完全退出并重启 ZCode。',
    verify: ['node', path.join(repoRoot, 'zcode-memory', 'bin', 'cli.mjs'), 'verify'],
  }
}
