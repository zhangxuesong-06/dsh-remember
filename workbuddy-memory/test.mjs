// WorkBuddy hook 回归测试：每次 hook 都是独立进程，全部用临时库。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { putBlob } from './bin/mem-evidence.mjs'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const mem = process.env.WORKBUDDY_TEST_BIN || path.join(here, 'bin', 'mem.mjs')
const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const root = fs.mkdtempSync(path.join(base, 'wb-memory-'))
const env = { ...process.env, WORKBUDDY_MEM_HOME: root, WORKBUDDY_DISABLE_MAINTENANCE: '1' }
let pass = 0
const check = (name, cond, extra = '') => {
  if (cond) pass += 1
  else { console.error('FAIL ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1 }
}
const run = (cmd, payload) => spawnSync(process.execPath, [mem, ...cmd], {
  input: payload === undefined ? '' : JSON.stringify(payload),
  env, encoding: 'utf8', windowsHide: true,
})
const hook = (event, payload) => run(['hook'], { hook_event_name: event, cwd: root, session_id: 's1', ...payload })
const rows = () => fs.readFileSync(path.join(root, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

try {
  // 1. 长回答完整保存；同一消息 ID 不重复
  const long = '开头'.repeat(4000) + '中间必须保留' + '结尾'.repeat(4000)
  hook('Stop', { message_id: 'a1', last_assistant_message: long })
  hook('Stop', { message_id: 'a1', last_assistant_message: long })
  const saved = rows().filter((r) => r.type === 'assistant/message')
  check('长回答只记一条', saved.length === 1, 'count=' + saved.length)
  check('长回答中部保留', saved[0] && saved[0].text.includes('中间必须保留'))
  check('回答带来源 ID', saved[0] && saved[0].eventKey === 'assistant:s1:a1')

  // 2. 用户消息与线索
  hook('UserPromptSubmit', { prompt: '继续做缓存功能', message_id: 'u1' })
  check('用户消息落盘', rows().some((r) => r.type === 'user/message' && r.text === '继续做缓存功能'))

  // 3. 工具前后版本
  const file = path.join(root, 'cache.js')
  fs.writeFileSync(file, 'version one')
  hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'c1', tool_input: { path: file } })
  fs.writeFileSync(file, 'version two')
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'c1', tool_input: { path: file }, tool_response: 'saved' })
  const artifact = rows().find((r) => r.type === 'artifact')
  check('成功写入生成产物', !!artifact)
  const readBlob = (hash) => fs.readFileSync(path.join(root, 'blobs', hash)).toString('utf8')
  check('保存前后版本', artifact && readBlob(artifact.versions.before.sha256) === 'version one'
    && readBlob(artifact.versions.after.sha256) === 'version two')
  check('工具完整结果可回读', rows().some((r) => r.evidence && readBlob(r.evidence.sha256) === 'saved'))

  // 4. 失败不生成产物
  const bad = path.join(root, 'bad.js')
  hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'c2', tool_input: { path: bad } })
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'c2', tool_input: { path: bad }, is_error: true, tool_response: 'permission denied' })
  check('失败结果标 error', rows().some((r) => r.type === 'tool/result' && r.status === 'error'))
  check('失败不生成产物', rows().filter((r) => r.type === 'artifact' && r.path === bad).length === 0)

  // 5. 校验与篡改
  const v1 = run(['verify'])
  check('账本 OK', v1.status === 0 && /ledger=OK/.test(v1.stdout), v1.stdout)
  const stream = path.join(root, 'stream.jsonl')
  const original = fs.readFileSync(stream, 'utf8')
  fs.writeFileSync(stream, original.replace('继续做缓存功能', '继续做缓存XX'))
  const v2 = run(['verify'])
  check('篡改被检出', v2.status === 1 && /BAD/.test(v2.stdout), v2.stdout)
  fs.writeFileSync(stream, original)

  // 6. 重放补齐产物
  const replayFile = path.join(root, 'replay.js')
  const replayBefore = putBlob(root, 'replay before').sha256
  const replayAfter = putBlob(root, 'replay after').sha256
  fs.appendFileSync(stream, JSON.stringify({
    ts: Date.now(), who: 'act', type: 'tool/result', text: '写完了', tool: 'Write', eventKey: 'tool:s1:r1:result',
    status: 'completed', files: [{ path: replayFile, before: { state: 'saved', sha256: replayBefore }, after: { state: 'saved', sha256: replayAfter } }],
  }) + '\n')
  run(['replay'])
  run(['replay'])
  check('重放只补一条产物', rows().filter((r) => r.type === 'artifact' && r.path === replayFile).length === 1)

  // 7. show 能读完整原文
  const shown = run(['show', '0'])
  check('show 能回读原文', shown.status === 0 && shown.stdout.includes('中间必须保留'))

  // 8. 维护 CLI 能校验同一个库
  const maint = spawnSync(process.execPath, [path.join(path.dirname(mem), 'mem-maintenance.mjs'), '--verify'], {
    env, encoding: 'utf8', windowsHide: true,
  })
  check('维护 verify 能跑', maint.status === 0 && /"status": "OK"/.test(maint.stdout), maint.stdout.slice(0, 120))

  // 9. 派生索引能构建且可重复构建
  const idx = run(['index', 'build'])
  check('索引构建能跑', idx.status === 0 && /"ok":true/.test(idx.stdout), idx.stdout.slice(0, 120))
  const idx2 = run(['index', 'build'])
  check('索引可重复构建', idx2.status === 0 && /"ok":true/.test(idx2.stdout), idx2.stdout.slice(0, 120))

  console.log(`\n${pass} passed, ${process.exitCode ? 'failures' : '0 failed'}`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
