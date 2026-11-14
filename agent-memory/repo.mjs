// 记忆仓库的位置解析：一个根目录，多条按来源分开的 append-only 流。
//
// 共享布局：
//   ~/.agent-memory/
//     manifest.json
//     opencode/stream.jsonl
//     dsh/<工作区>/stream.jsonl
//     workbuddy/stream.jsonl
//
// 迁移完成前仍回退到旧布局（~/.opencode-mem、~/.dsh/dsh-memory、~/.workbuddy/mem）。
// 显式 env 覆盖始终优先，测试和特殊安装都靠它。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function repoRoot() {
  return process.env.AGENT_MEMORY_HOME || path.join(os.homedir(), '.agent-memory')
}

export function paths() {
  const home = os.homedir()
  const shared = repoRoot()
  return {
    shared: {
      root: shared,
      opencode: path.join(shared, 'opencode'),
      dsh: path.join(shared, 'dsh'),
      workbuddy: path.join(shared, 'workbuddy'),
      manifest: path.join(shared, 'manifest.json'),
    },
    legacy: {
      opencode: process.env.OPENCODE_MEM_HOME || path.join(home, '.opencode-mem'),
      dsh: path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'dsh-memory'),
      workbuddy: process.env.WORKBUDDY_MEM_HOME || path.join(home, '.workbuddy', 'mem'),
    },
  }
}

function sharedStarted(p) {
  return fs.existsSync(path.join(p.opencode, 'stream.jsonl'))
    || fs.existsSync(path.join(p.workbuddy, 'stream.jsonl'))
    || fs.existsSync(p.dsh)
}

export function layout() {
  const p = paths()
  const shared = !!process.env.AGENT_MEMORY_HOME || sharedStarted(p.shared)
  const base = shared ? p.shared : p.legacy
  return {
    shared,
    root: shared ? p.shared.root : null,
    opencode: base.opencode,
    dsh: base.dsh,
    workbuddy: base.workbuddy,
    manifest: p.shared.manifest,
  }
}

export function streams() {
  const l = layout()
  const list = [
    { source: 'opencode', path: path.join(l.opencode, 'stream.jsonl'), workspace: null },
    { source: 'workbuddy', path: path.join(l.workbuddy, 'stream.jsonl'), workspace: null },
  ]
  let dirs = []
  try { dirs = fs.readdirSync(l.dsh, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  for (const name of dirs.sort()) {
    const file = path.join(l.dsh, name, 'stream.jsonl')
    if (fs.existsSync(file)) list.push({ source: 'dsh', path: file, workspace: name })
  }
  // 没有工作区时也保留一条 DSH 记录，sources 才能明确显示 missing。
  if (!list.some((s) => s.source === 'dsh')) list.push({ source: 'dsh', path: path.join(l.dsh, 'stream.jsonl'), workspace: null })
  return { layout: l, list }
}
