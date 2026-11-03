// 把记忆库现状打成一个文件，方便拿去分析。
// 只输出索引和统计，不输出原话全文——隐私留在本机。
//
// 用法:
//   node tools/snapshot.mjs
//   node tools/snapshot.mjs --dir "C:\Users\me\.dsh\dsh-memory\xxx-hash"
import fs from 'node:fs'
import path from 'node:path'
import { HOME, DIAG } from '../lib/config.mjs'
import { Ledger } from '../lib/store.mjs'

const argDir = (() => {
  const i = process.argv.indexOf('--dir')
  return i > 0 ? process.argv[i + 1] : null
})()

function listLedgerDirs(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    try {
      if (!fs.statSync(p).isDirectory()) continue
      if (fs.existsSync(path.join(p, 'stream.jsonl'))) out.push(p)
    } catch {}
  }
  return out
}

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-n)
  } catch { return [] }
}

const dirs = argDir ? [argDir] : listLedgerDirs(HOME)
const report = { generatedAt: new Date().toISOString(), home: HOME, stores: [] }

for (const dir of dirs) {
  let l
  try { l = new Ledger(dir, {}).open() } catch (e) {
    report.stores.push({ dir, error: String(e && e.message) })
    continue
  }
  const s = l.stats()
  const eps = (l.episodes || []).map((e) => ({
    id: e.id,
    date: new Date(e.startTs).toISOString().slice(0, 10),
    domain: e.domain || 'chat',
    title: String(e.title || '').slice(0, 60),
    turns: e.turns || 0,
    chars: e.chars || 0,
    salience: +(e.salience || 0).toFixed(2),
    emotion: +(e.emotion || 0).toFixed(2),
    rehearsals: e.rehearsals || 0,
    lastHit: e.lastHit ? new Date(e.lastHit).toISOString().slice(0, 10) : null,
  }))
  const byDomain = {}
  for (const e of eps) byDomain[e.domain] = (byDomain[e.domain] || 0) + 1
  const recalled = eps.filter((e) => e.lastHit).length
  report.stores.push({
    dir, stats: s, byDomain,
    recalledEpisodes: recalled,
    episodes: eps,
  })
}

report.diagTail = tail(DIAG, 300)

const outFile = path.join(process.cwd(), `snapshot-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')

// 人看的摘要
const lines = ['# 记忆库快照', '']
for (const st of report.stores) {
  if (st.error) { lines.push(`- ${st.dir} → 打不开: ${st.error}`); continue }
  const s = st.stats
  lines.push(`## ${path.basename(st.dir)}`)
  lines.push(`- 记录 ${s.traces} 句 · ${s.episodes} 段 · ${(s.bytes / 1048576).toFixed(2)} MB`)
  lines.push(`- 被回想过的段：${st.recalledEpisodes} / ${s.episodes}`)
  lines.push(`- 用途：${Object.entries(st.byDomain).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`)
  const top = [...st.episodes].sort((a, b) => b.rehearsals - a.rehearsals).slice(0, 5)
  if (top.length) {
    lines.push('- 最常被想起：')
    for (const e of top) lines.push(`  - #${e.id} ${e.date} ${e.title} · 回想 ${e.rehearsals} 次`)
  }
  lines.push('')
}
lines.push(`diag 最后 5 行：`)
for (const x of report.diagTail.slice(-5)) lines.push(`  ${x}`)

const mdFile = outFile.replace(/\.json$/, '.md')
fs.writeFileSync(mdFile, lines.join('\n'), 'utf8')
console.log('写出：')
console.log('  ' + outFile)
console.log('  ' + mdFile)
