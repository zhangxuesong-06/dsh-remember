#!/usr/bin/env node
// mem —— 记忆的 CLI。真正的读写在 tools/mem-core.mjs，插件用的是同一份。
//
//   node tools/mem.mjs add "文本" [--kind decision] [--ws 路径]
//   node tools/mem.mjs recall "一句话" [-n 5]
//   node tools/mem.mjs trace "原话片段"
//   node tools/mem.mjs remember "…" [--key 名字]
//   node tools/mem.mjs brief
//   node tools/mem.mjs stats
//   node tools/mem.mjs pin <key> "文本"

import { append, mark, recall, trace, stats, readAll, readPins, readMarks, setPin, dayOf } from './mem-core.mjs'

const [cmd, ...rest] = process.argv.slice(2)

function parseArgs(args) {
  const flags = {}
  const words = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++ }
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
} else if (cmd === 'recall') {
  const nIdx = rest.indexOf('-n')
  const n = nIdx >= 0 ? Number(rest[nIdx + 1]) || 5 : 5
  const wsIdx = rest.indexOf('--ws')
  const ws = wsIdx >= 0 ? rest[wsIdx + 1] : null
  const q = rest.filter((_, i) => i !== nIdx && i !== nIdx + 1 && i !== wsIdx && i !== wsIdx + 1).join(' ')
  const hits = recall(q, { n, ws })
  if (!hits.length) { console.log(`（没有相关的。库里 ${readAll().length} 条。）`); process.exit(0) }
  for (const h of hits) console.log(fmt(h) + `  ~${h.score.toFixed(2)}`)
} else if (cmd === 'trace') {
  const q = rest.join(' ')
  const hits = trace(q)
  if (!hits.length) { console.log('（按字没有这句。）'); process.exit(0) }
  for (const h of hits.slice(-10)) console.log(`${fmt(h)}  · ${h.attribution}`)
} else if (cmd === 'brief') {
  const docs = readAll()
  const pins = readPins()
  const marks = readMarks()
  const pinLines = Object.entries(pins)
  console.log(`# 记忆 · ${docs.length} 条 · ${pinLines.length} 钉住 · ${marks.length} 特意记下\n`)
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
  node tools/mem.mjs recall "一句话" [-n 5]
  node tools/mem.mjs trace "原话片段"
  node tools/mem.mjs remember "…" [--key 名字]
  node tools/mem.mjs brief
  node tools/mem.mjs stats
  node tools/mem.mjs pin <key> "文本"`)
}
