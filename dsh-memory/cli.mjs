#!/usr/bin/env node
// 离线命令行：不装插件也能先把记忆跑通、看清楚。
//
//   node cli.mjs stats   <工作区目录>
//   node cli.mjs backfill<工作区目录>
//   node cli.mjs episodes<工作区目录> [条数]
//   node cli.mjs recall  <工作区目录> <一句话|日期|#编号>
//   node cli.mjs trace   <工作区目录> <一句话>        按字查：谁说的、哪一场、第几行
//   node cli.mjs prime   <工作区目录> <一句话>
//   node cli.mjs anchor  <工作区目录>
//   node cli.mjs arrive  <工作区目录>
//   node cli.mjs dump    <工作区目录> [n]     看最近 n 条原始记录
//   node cli.mjs audit   <工作区目录>         体检：每个会话多带多少运行时上下文、压缩过几次
//   node cli.mjs lines   [add <线名> <工作区> <会话id> | join <线名> <会话id>]

import { Ledger } from './lib/store.mjs'
import { workspaceDir, loadCfg, DEFAULT_CFG, saveCfg } from './lib/config.mjs'
import { backfill } from './lib/backfill.mjs'
import { anchorBlock, primingBlock, recallBlock, traceBlock, arrivalBlock, dayOf } from './lib/assemble.mjs'
import { search, priming } from './lib/retrieve.mjs'

const [cmd, cwd, ...rest] = process.argv.slice(2)
if (!cmd || !cwd) {
  console.log('用法：node cli.mjs <stats|backfill|episodes|recall|trace|prime|anchor|arrive|dump|audit|lines> <工作区目录> [...]')
  process.exit(1)
}

const cfg = { ...DEFAULT_CFG, ...loadCfg(), workspaces: [cwd] }
// 多线文件夹：用 HIPPO_LINE=<线名> 指定看哪条
const lineName = process.env.HIPPO_LINE || null
const dir = workspaceDir(cwd, lineName)
// lines 子命令自己会开库；别为它凭空造一个空库出来
const ledger = cmd === 'lines' ? null : new Ledger(dir, { meetingGapMs: cfg.meetingGapMs }).open()

const arg = rest.join(' ')

function kb(n) { return (n / 1024).toFixed(1) + ' KB' }

// ——— 多线的登记表 ———
// 注意：这一段自己退场（process.exit），不落到下面的 switch 里
if (cmd === 'lines') {
  const real = loadCfg()
  const lines = Array.isArray(real.lines) ? real.lines : []
  const sub = rest[0]

  if (!sub) {
    if (!lines.length) {
      console.log('（没有多线文件夹：现在每个工作区就是一条线）')
      process.exit(0)
    }
    for (const l of lines) {
      const d = workspaceDir(l.cwd, l.name)
      const lg = new Ledger(d, {}).open()
      const s = lg.stats()
      console.log(`# ${l.name}   ${l.cwd}`)
      console.log(`   根 ${l.root || '（没设）'} · 成员 ${(l.members || []).length} 个 · ${s.episodes} 段 / ${s.traces} 句 / ${kb(s.bytes)}`)
      for (const m of l.members || []) console.log(`     · ${m}`)
      lg.close()
    }
    process.exit(0)
  }

  if (sub === 'add' || sub === 'join') {
    const name = rest[1]
    const sid = sub === 'add' ? rest[3] : rest[2]
    const where = sub === 'add' ? rest[2] : cwd
    if (!name || !sid) {
      console.log(`用法：node cli.mjs lines ${sub} <线名> ${sub === 'add' ? '<工作区> ' : ''}<会话id>`)
      process.exit(1)
    }
    const list = Array.isArray(real.lines) ? real.lines : []
    let line = list.find((x) => x.name === name)
    if (!line) {
      line = { name, cwd: where, root: sub === 'add' ? sid : undefined, members: [] }
      list.push(line)
    }
    line.members = Array.isArray(line.members) ? line.members : []
    if (!line.members.includes(sid) && line.root !== sid) line.members.push(sid)
    real.lines = list
    // 一旦某文件夹进了 lines，就不要再把它留在 workspaces 里（否则两套语义打起来）
    real.workspaces = (real.workspaces || []).filter((w) => String(w).toLowerCase() !== String(line.cwd).toLowerCase())
    console.log(saveCfg(real) ? `写好了：线「${name}」现在有 ${line.members.length + (line.root ? 1 : 0)} 个会话。配置热读，几秒后生效。` : '写配置失败')
    process.exit(0)
  }

  console.log('用法：node cli.mjs lines [add <线名> <工作区> <会话id> | join <线名> <会话id>]')
  process.exit(0)
}

switch (cmd) {
  case 'stats': {
    const s = ledger.stats()
    console.log('库：' + s.dir)
    console.log(`记录 ${s.docs} 条（原话 ${s.traces}，动作 ${s.acts}）· 段 ${s.episodes} · 词 ${s.terms} · ${kb(s.bytes)} · 特意记下 ${s.marks}`)
    if (ledger.episodes.length) {
      const a = ledger.episodes[0]
      const b = ledger.episodes[ledger.episodes.length - 1]
      console.log(`从 ${dayOf(a.startTs)} 到 ${dayOf(b.endTs)}`)
    }
    break
  }

  case 'backfill': {
    const r = backfill(ledger, cwd, cfg)
    ledger.seal(true)
    console.log(`回填：${r.sessions} 份会话，${r.added} 条记录`)
    console.log(`现在：${ledger.episodes.length} 段，${ledger.stats().traces} 句原话`)
    break
  }

  case 'episodes': {
    const n = Number(rest[0]) || 20
    for (const e of ledger.episodes.slice(-n)) {
      const emo = e.emotion > 0.3 ? ' ★' : ''
      console.log(`#${String(e.id).padStart(3)} ${dayOf(e.startTs)}  ${String(e.turns).padStart(3)} 回合  显著 ${e.salience.toFixed(2)}  情绪 ${e.emotion.toFixed(2)}${emo}  ${e.title}`)
    }
    break
  }

  case 'recall': {
    if (!arg) { console.log('要给一句话或日期'); break }
    if (/^#?\d+$/.test(arg)) {
      const block = recallBlock(ledger, { episode: Number(arg.replace('#', '')), maxChars: cfg.recallMaxChars })
      console.log(block || '（没有这一段）')
      break
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const hit = ledger.episodes.filter((e) => dayOf(e.startTs) === arg || dayOf(e.endTs) === arg)
      if (!hit.length) { console.log('（那天没有记录）'); break }
      console.log(recallBlock(ledger, { episode: hit[0].id, maxChars: cfg.recallMaxChars }))
      break
    }
    const block = recallBlock(ledger, { query: arg, maxChars: cfg.recallMaxChars })
    if (block) { console.log(block); break }
    const hits = search(ledger, arg, { limit: 6, recency: cfg.recency })
    if (!hits.length) { console.log('（想不起来）'); break }
    console.log('【零碎想起】')
    for (const h of hits) {
      const d = ledger.docs[h.id]
      const who = d.who === 'he' ? '他' : d.who === 'me' ? '我' : '做'
      console.log(`${dayOf(d.ts)} ${who}：${ledger.fullText(h.id).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    break
  }

  case 'trace': {
    // 按字查，不按意思查。和 recall 摆在一起用：
    // recall 回答「有没有像的」，trace 回答「有没有这句」。
    if (!arg) { console.log('要给一句话'); break }
    console.log(traceBlock(ledger, arg, { sid: null }))
    break
  }

  case 'prime': {
    const block = primingBlock(ledger, arg, cfg)
    console.log(block || '（没有浮起来的东西）')
    console.log('--- ' + Buffer.byteLength(block, 'utf8') + ' B')
    break
  }

  case 'anchor': {
    const block = anchorBlock(ledger, cfg)
    console.log(block || '（还没有能当锚的话）')
    console.log('--- ' + Buffer.byteLength(block, 'utf8') + ' B')
    break
  }

  case 'arrive': {
    const block = arrivalBlock(ledger, cfg)
    console.log(block || '（空的：还没记忆）')
    console.log('--- ' + Buffer.byteLength(block, 'utf8') + ' B')
    break
  }

  case 'dump': {
    const n = Number(rest[0]) || 15
    const start = Math.max(0, ledger.docs.length - n)
    for (let i = start; i < ledger.docs.length; i++) {
      const d = ledger.docs[i]
      if (!d) continue
      console.log(`${String(i).padStart(4)} ${dayOf(d.ts)} ${(d.who || '-').padEnd(4)} ${d.text.replace(/\s+/g, ' ').slice(0, 130)}`)
    }
    break
  }

  // 体检：这条线上每个会话「多带了多少运行时上下文」「压缩接过几次」。
  // 这两个数是那轮评审的核心指控，也是最容易被自己骗过去的地方——
  // 别靠感觉，量。
  case 'audit': {
    const { listSessions } = await import('./lib/session-file.mjs')
    const { SESSIONS_DIR } = await import('./lib/config.mjs')
    const MARK = /Current runtime context|你说过的话|忽然浮起来|我记下的|你刚来到另一个|刚压掉了/
    const sessions = listSessions(SESSIONS_DIR, cwd)
    if (!sessions.length) { console.log('（这个工作区没有会话）'); break }

    let allRt = 0
    let allRtBytes = 0
    let allTurns = 0
    let allPrunes = 0
    let allShadowed = 0
    console.log('会话                        回合  运行时上下文        压缩   压掉')
    for (const s of sessions) {
      let rt = 0
      let rtBytes = 0
      let prunes = 0
      let shadowed = 0
      let turns = 0
      for (const ev of s.events) {
        if (ev.type === 'turn/start') turns += 1
        if (String(ev.type).startsWith('compaction/')) {
          prunes += 1
          shadowed += Number(ev.data && ev.data.shadowedTokenCount) || 0
        }
        if (ev.type !== 'user/message') continue
        const t = JSON.stringify(ev.data || {})
        if (MARK.test(t)) { rt += 1; rtBytes += t.length }
      }
      allRt += rt; allRtBytes += rtBytes; allTurns += turns
      allPrunes += prunes; allShadowed += shadowed
      const per = turns ? (rtBytes / 1024 / turns).toFixed(2) : '0'
      console.log(
        s.id.slice(0, 26).padEnd(28),
        String(turns).padStart(4),
        `${String(rt).padStart(3)} 份 / ${(rtBytes / 1024).toFixed(0).padStart(4)} KB`.padEnd(20),
        String(prunes).padStart(4),
        `${shadowed} tok`,
      )
      console.log(''.padEnd(28) + '  平均每回合多带 ' + per + ' KB')
    }
    console.log('—'.repeat(72))
    const per = allTurns ? (allRtBytes / 1024 / allTurns).toFixed(2) : '0'
    console.log(`合计：${allTurns} 回合 · ${allRt} 份运行时上下文 / ${(allRtBytes / 1024).toFixed(0)} KB · 平均每回合 ${per} KB`)
    console.log(`压缩：${allPrunes} 次，共压掉约 ${Math.round(allShadowed / 1000)}k token`)
    console.log(allPrunes
      ? '（有压缩发生 → 去 diag.log 里搜「压缩 」，看插件有没有接住）'
      : '（这个工作区还没压过；真正的触发点多半是 tool-result pruner，不是 1M 上限）')
    break
  }

  // 清掉「同一个人短时间内说了两遍一模一样的话」——插件重装时会撞出来。
  // **只动他/我说的话**：动手（工具调用）重复多半是真的又跑了一遍，删了就是篡改记忆。
  // 这是唯一一次改写流的机会，所以先备份，再顺手让索引作废重建。
  case 'dedup': {
    const { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = join(dir, 'stream.jsonl')
    if (!existsSync(p)) { console.log('（没有流）'); break }
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const seen = new Map()
    const keep = []
    let removed = 0
    for (const ln of lines) {
      let d
      try { d = JSON.parse(ln) } catch { keep.push(ln); continue }
      if (d.who !== 'he' && d.who !== 'me') { keep.push(ln); continue }
      const t = String(d.text || '')
      const fp = `${d.who}|${d.sid || ''}|${t.length}|${t.slice(0, 48)}|${t.slice(-24)}`
      const win = t.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
      const prev = seen.get(fp)
      if (prev !== undefined && Math.abs((d.ts || 0) - prev) < win) { removed += 1; continue }
      seen.set(fp, d.ts || 0)
      keep.push(ln)
    }
    if (!removed) { console.log('没有重复，不用动'); break }
    copyFileSync(p, p + '.bak')
    writeFileSync(p, keep.join('\n') + '\n', 'utf8')
    const sp = join(dir, 'state.json')
    if (existsSync(sp)) unlinkSync(sp)
    console.log(`去掉 ${removed} 条重复的「他/我」发言（备份在 stream.jsonl.bak）。动手记录一条没动。索引会在下次打开时重建。`)
    break
  }

  default:
    console.log('不认识的命令：' + cmd)
}

if (ledger) ledger.close()
