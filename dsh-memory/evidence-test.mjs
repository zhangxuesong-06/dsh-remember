// 证据层回归测试：不碰真实记忆，全部在临时目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Ledger } from './lib/store.mjs'
import { eventToRecords } from './lib/capture.mjs'
import { readBlob } from './lib/evidence.mjs'

const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const root = fs.mkdtempSync(path.join(base, 'dsh-evidence-'))
let n = 0
const pass = []
const check = (name, cond, extra = '') => {
  if (cond) pass.push(name)
  else { console.error('FAIL ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1 }
}
const fresh = () => new Ledger(path.join(root, 'case-' + (++n))).open()

try {
  // 1. 完整长文本
  {
    const l = fresh()
    const long = '头'.repeat(5000) + '中间必须保留' + '尾'.repeat(5000)
    l.append({ who: 'he', text: long, sid: 's' })
    l.seal(true)
    check('完整长文本保留中部', l.fullText(0).includes('中间必须保留'))
    check('正文带指纹', !!l.fullRecord(0).hash)
    l.close()
  }

  // 2. 来源事件去重，不同事件同文分别保留
  {
    const l = fresh()
    l.append({ who: 'he', text: '同一句话', eventKey: 's:1' })
    l.append({ who: 'he', text: '同一句话', eventKey: 's:1' })
    l.append({ who: 'he', text: '同一句话', eventKey: 's:2' })
    check('同一事件只落一条', l.docs.length === 2, 'docs=' + l.docs.length)
    l.close()
  }

  // 3. 工具前后版本与失败隔离
  {
    const l = fresh()
    const file = path.join(root, 'feature.js')
    fs.writeFileSync(file, 'version one')
    const pending = new Map()
    const ctx = { sid: 's', line: 's', root: l.dir, cwd: root, pending }
    const call = eventToRecords({ type: 'tool/call', seq: 1, time: Date.now(), data: { name: 'write', callId: 'c1', arguments: JSON.stringify({ path: file }) } }, ctx)
    for (const r of call) l.append(r)
    fs.writeFileSync(file, 'version two')
    const result = eventToRecords({ type: 'tool/result', seq: 2, time: Date.now(), data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'saved' }], isError: false } } }, ctx)
    for (const r of result) l.append(r)
    const artifact = l.rows().find((r) => r.type === 'artifact')
    check('成功写入生成产物记录', !!artifact)
    check('保存了前后两个版本', artifact && readBlob(l.dir, artifact.versions.before.sha256).toString() === 'version one'
      && readBlob(l.dir, artifact.versions.after.sha256).toString() === 'version two')
    check('完整结果可回读', l.rows().some((r) => r.evidence && readBlob(l.dir, r.evidence.sha256).toString() === 'saved'))
    check('账本校验通过', l.verify().status === 'OK', l.verify().status)
    l.close()
  }

  // 4. 篡改与截尾
  {
    const l = fresh()
    l.append({ who: 'he', text: 'first' })
    l.append({ who: 'me', text: 'second' })
    const bytes = fs.readFileSync(l.streamPath, 'utf8')
    fs.writeFileSync(l.streamPath, bytes.replace('first', 'fIrst'))
    check('改正文被检出', l.verify().status === 'BAD')
    fs.writeFileSync(l.streamPath, bytes.split('\n').slice(0, 1).join('\n') + '\n')
    check('删行被检出', l.verify().status === 'BAD')
    l.close()
  }

  // 5. 合法尾部需显式接纳
  {
    const l = fresh()
    l.append({ who: 'he', text: 'committed' })
    fs.appendFileSync(l.streamPath, JSON.stringify({ who: 'me', text: 'tail' }) + '\n')
    check('合法尾部显示 PENDING', l.verify().status === 'PENDING', l.verify().status)
    l.sync()
    check('接纳后 OK', l.verify().status === 'OK')
    l.close()
  }

  // 6. 重放补齐产物索引
  {
    const l = fresh()
    const file = path.join(root, 'replay.js')
    const before = { path: file, state: 'saved', sha256: 'a'.repeat(64) }
    const after = { path: file, state: 'saved', sha256: 'b'.repeat(64) }
    l.append({ who: 'act', type: 'tool/result', text: '写完了', tool: 'write', eventKey: 's:9',
      status: 'completed', files: [{ path: file, before, after }] })
    check('重放前没有产物', l.rows().filter((r) => r.type === 'artifact').length === 0)
    l.replay()
    l.replay()
    check('重放只补一条产物', l.rows().filter((r) => r.type === 'artifact').length === 1)
    l.close()
  }

  console.log(`\n${pass.length} passed, ${process.exitCode ? 'failures' : '0 failed'}`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
