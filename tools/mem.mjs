#!/usr/bin/env node
// mem —— 记忆的 CLI。真正的读写在 tools/mem-core.mjs，插件用的是同一份。
//
//   node tools/mem.mjs add "文本" [--kind decision] [--ws 路径]
//   node tools/mem.mjs recall "一句话" [-n 5] [--scope build/docker]
//   node tools/mem.mjs trace "原话片段"
//   node tools/mem.mjs remember "…" [--key 名字]
//   node tools/mem.mjs map
//   node tools/mem.mjs alias <词> <同义词,同义词>
//   node tools/mem.mjs brief
//   node tools/mem.mjs stats
//   node tools/mem.mjs pin <key> "文本"

import { append, mark, recall, trace, map, stats, readAll, readPins, readMarks, setPin, addAlias, readAliases, dayOf, buildAssocIndex, assocNeighbors, readAssoc } from './mem-core.mjs'

const [cmd, ...rest] = process.argv.slice(2)

function parseArgs(args) {
  const flags = {}
  const words = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++ }
    else if (args[i] === '-n') { flags.n = args[i + 1]; i++ }
    else words.push(args[i])
  }
  return { text: words.join(' ').trim(), flags }
}

const fmt = (d) => {
  const tags = [d.kind !== 'message' ? `<${d.kind}>` : '', d.ws ? `[${d.ws.split(/[\\/]/).pop()}]` : '']
    .filter(Boolean).join(' ')
  return `#${d.seq} ${dayOf(d.ts)}${tags ? ' ' + tags : ''} ${d.text}`
}

if (cmd === 'add') {
  const { text, flags } = parseArgs(rest)
  if (!text) { console.error('要写点什么'); process.exit(2) }
  const r = append({ who: 'assistant', kind: flags.kind || 'note', text, ws: flags.ws || '', sid: flags.sid || 'cli' })
  console.log('+' + r.seq)
} else if (cmd === 'remember') {
  const { text, flags } = parseArgs(rest)
  if (!text) { console.error('要记什么'); process.exit(2) }
  mark(text, flags.key || null, flags.ws || '')
  console.log('记下了')
} else if (cmd === 'pin') {
  const key = rest[0]
  const text = rest.slice(1).join(' ').trim()
  if (!key || !text) { console.error('用法: pin <key> "文本"'); process.exit(2) }
  setPin(key, text)
  console.log('钉住: ' + key)
} else if (cmd === 'alias') {
  const term = rest[0]
  const syn = rest.slice(1).join(' ')
  if (!term || !syn) { console.error('用法: alias <词> <同义词,同义词>'); process.exit(2) }
  const r = addAlias(term, syn)
  console.log(`${r.key} → ${r.synonyms.join(', ')}`)
} else if (cmd === 'recall') {
  const { text, flags } = parseArgs(rest)
  if (!text) { console.error('要查什么'); process.exit(2) }
  const hits = recall(text, { n: Number(flags.n) || 5, ws: flags.ws || null, scope: flags.scope || null })
  if (hits.note) console.log(`（${hits.note}）`)
  if (hits.aliasHit && hits.aliasHit.length) console.log(`（别名命中：${hits.aliasHit.join(', ')}）`)
  if (hits.assocHit && hits.assocHit.length) console.log(`（联想命中：${hits.assocHit.join(', ')}）`)
  if (!hits.length) { console.log(`（没有相关的。库里 ${readAll().length} 条。）`); if (hits.hint) console.log(hits.hint); process.exit(0) }
  for (const h of hits) console.log(fmt(h) + `  ~${h.score.toFixed(2)}`)
} else if (cmd === 'trace') {
  const q = rest.join(' ')
  const hits = trace(q)
  if (!hits.length) { console.log('（按字没有这句。）'); process.exit(0) }
  for (const h of hits.slice(-10)) console.log(`${fmt(h)}  · ${h.attribution}`)
} else if (cmd === 'assoc') {
  const sub = rest[0]
  if (sub === 'build') {
    const m = buildAssocIndex()
    console.log(`联想图：${m.terms} 个词 · ${m.edges} 条边 · 基于 ${m.docCount} 条`)
  } else if (sub === 'show') {
    const term = String(rest[1] || '').toLowerCase()
    const nb = assocNeighbors(term)
    if (nb === null) { console.log('（还没有联想图，先跑 assoc build）'); process.exit(0) }
    if (!nb.length) { console.log(`（「${term}」没有联想词）`); process.exit(0) }
    console.log(`${term} →`)
    for (const [w, pmi, n] of nb) console.log(`  ${w}  pmi ${pmi} · 共现 ${n}`)
  } else {
    console.log('用法: assoc build | assoc show <词>')
  }
} else if (cmd === 'map') {
  console.log(map())
} else if (cmd === 'brief') {
  const docs = readAll()
  const pins = readPins()
  const marks = readMarks()
  const aliases = readAliases()
  const pinLines = Object.entries(pins)
  console.log(`# 记忆 · ${docs.length} 条 · ${pinLines.length} 钉住 · ${marks.length} 特意记下 · ${Object.keys(aliases).length} 别名\n`)
  if (pinLines.length) {
    console.log('## 钉住')
    for (const [k, v] of pinLines) console.log(`- ${k}: ${v.text}`)
    console.log('')
  }
  if (marks.length) {
    console.log('## 特意记下（最近 5）')
    for (const m of marks.slice(-5)) console.log(`- ${dayOf(m.ts)}${m.key ? ` (${m.key})` : ''} ${m.text}`)
    console.log('')
  }
  const recent = docs.slice(-8)
  if (recent.length) {
    console.log('## 最近 8 条')
    for (const d of recent) console.log('- ' + fmt(d).replace(/^#\d+\s/, ''))
  }
} else if (cmd === 'stats') {
  const s = stats()
  console.log(`条目 ${s.total} · ${(s.bytes / 1024).toFixed(1)} KB · ${s.marks} 记下 · ${s.pins} 钉住`)
  console.log('kind: ' + Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(' · '))
  const ws = Object.entries(s.byWs).filter(([k]) => k)
  if (ws.length) console.log('ws:   ' + ws.map(([k, v]) => `${k.split(/[\\/]/).pop()} ${v}`).join(' · '))
} else {
  console.log(`用法:
  node tools/mem.mjs add "文本" [--kind decision] [--ws 路径]
  node tools/mem.mjs recall "一句话" [-n 5] [--scope build/docker]
  node tools/mem.mjs trace "原话片段"
  node tools/mem.mjs remember "…" [--key 名字]
  node tools/mem.mjs map
  node tools/mem.mjs alias <词> <同义词,同义词>
  node tools/mem.mjs brief
  node tools/mem.mjs stats
  node tools/mem.mjs pin <key> "文本"`)
}
