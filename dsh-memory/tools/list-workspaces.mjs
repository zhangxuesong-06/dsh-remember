import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dir = path.join(os.homedir(), '.dsh', 'sessions')
const dec = (s) => s.replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
const out = []
for (const name of fs.readdirSync(dir)) {
  if (!name.startsWith('--')) continue
  const body = name.replace(/^--/, '').replace(/--$/, '')
  const parts = body.split('-').map(dec)
  if (parts.length < 2) continue
  const p = parts[0] + ':\\' + parts.slice(1).join('\\')
  let n = 0
  try { n = fs.readdirSync(path.join(dir, name)).length } catch {}
  out.push({ path: p, sessions: n, mtime: fs.statSync(path.join(dir, name)).mtimeMs })
}
out.sort((a, b) => b.mtime - a.mtime)
console.log('候选工作区（按最近活动排序）：')
for (const o of out) {
  console.log(`  ${o.path}   (${o.sessions} 个会话, ${new Date(o.mtime).toISOString().slice(0, 10)})`)
}
