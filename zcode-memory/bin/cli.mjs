// 人工核对入口：不用开会话也能看库、验账、回读。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOME, loadCfg } from '../lib/config.mjs'
import { Ledger } from '../lib/store.mjs'
import { recallBlock, ledgerQuotes, traceBlock } from '../lib/assemble.mjs'
import { recallFlags, serializeRange } from '../lib/mem-recall.mjs'
import { readBlob } from '../lib/evidence.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const ledger = () => new Ledger(HOME).open()
const maintenance = (args) => {
  const script = fileURLToPath(new URL('../tools/maintenance.mjs', import.meta.url))
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: process.env })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  return res.status ?? 1
}
const backfill = (args) => {
  const script = fileURLToPath(new URL('../tools/backfill.mjs', import.meta.url))
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: process.env })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  return res.status ?? 1
}

function usage() {
  console.log(`用法：node bin/cli.mjs <命令>
  stats                库的体检数字
  health               一行体检（records/段/blob/账本状态）
  maint <参数>         转给 tools/maintenance.mjs（verify/sync/backup/prune/report/due）
  backfill [--db 路径] [--session sid] [--since 7d] [--dry-run]
                       从 ZCode 数据库回填缺失的助手回答（只读库、幂等）
  backfill --subagents [--session sid] [--dry-run]
                       回填子代理的工具/产物证据（任务提示标 meta，不写模型对话）
  workspaces           有哪些工作区
  verify               校验账本（OK / BAD，BAD 时退出码 1）
  sync                 把当前内容接纳为基线
  replay               从工具结果补写缺失的产物记录
  show <行号> [--range start:end]  回读记录原文
  read <sha256>        回读证据 blob
  recall <query> [--compact] [--rank passage]  按线索查
  trace <query>        按字核对`)
}

try {
  switch (cmd) {
    case 'stats': {
      const l = ledger()
      console.log(JSON.stringify(l.health(), null, 2))
      break
    }
    case 'health': {
      const l = ledger()
      const h = l.health()
      console.log(`ledger=${h.ledger} records=${h.docs} traces=${h.traces} acts=${h.acts} episodes=${h.episodes} blobs=${h.blobs} problems=${h.problems} bytes=${h.bytes}`)
      process.exitCode = h.ledger === 'OK' ? 0 : 1
      break
    }
    case 'maint': {
      // `maint report` 和 `maint --report` 都认；维护脚本只接受长参数。
      const args = rest.map((a) => (a.startsWith('-') ? a : '--' + a))
      process.exitCode = maintenance(args)
      break
    }
    case 'backfill': {
      process.exitCode = backfill(rest)
      break
    }
    case 'workspaces': {
      const ws = ledger().workspaces()
      if (!ws.length) console.log('（还没有记录）')
      for (const w of ws) console.log(`${w.name}\t${w.records} 条\t${w.ws}`)
      break
    }
    case 'verify': {
      const l = ledger()
      const v = l.verify()
      console.log(`ledger=${v.status} problems=${v.problems.length} blobs=${v.blobs} noHash=${v.noHash}`)
      for (const p of v.problems.slice(0, 10)) console.log('  ·', p.file || '', p.reason || '')
      process.exitCode = v.status === 'OK' ? 0 : 1
      break
    }
    case 'sync': {
      const v = ledger().sync()
      console.log(`ledger=${v.status} problems=${v.problems.length}`)
      process.exitCode = v.status === 'OK' ? 0 : 1
      break
    }
    case 'replay': {
      console.log('补写产物：' + ledger().replay())
      break
    }
    case 'show': {
      const id = Number(rest[0])
      if (!Number.isInteger(id)) throw new Error('show 需要记录行号')
      const db = ledger()
      if (rest[1] === '--range') {
        const rec = db.fullRecord(id)
        if (!rec) throw new Error('没有这条记录。')
        console.log(serializeRange(rec, String(id), rest[2]))
      } else console.log(db.fullText(id))
      break
    }
    case 'read': {
      const hash = String(rest[0] || '')
      process.stdout.write(readBlob(HOME, hash).toString('utf8'))
      break
    }
    case 'recall': {
      const { words, compact, passages } = recallFlags(rest)
      const query = words.join(' ').trim()
      if (!query) throw new Error('recall 需要一句话')
      const db = ledger()
      console.log(compact || passages ? ledgerQuotes(db, query, { passages, recency: loadCfg().recency }) : recallBlock(db, { query }) || '没找到。')
      break
    }
    case 'trace': {
      const query = rest.join(' ').trim()
      if (!query) throw new Error('trace 需要一句话')
      console.log(traceBlock(ledger(), query) || '库里没有这句话。')
      break
    }
    default:
      usage()
      process.exitCode = cmd ? 1 : 0
  }
} catch (e) {
  console.error(e && e.message ? e.message : String(e))
  process.exitCode = 1
}
