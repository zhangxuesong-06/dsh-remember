// WorkBuddy 适配器自测：只碰临时目录，不读不写真实记忆库。
// 覆盖：工具证据配对、轻工具截断、子智能体、专家引用、维护/快照、清理不误删。
// 输出 ASCII PASS/FAIL，方便在 GBK 控制台看。
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, 'bin', 'mem.mjs')
const MAINT = join(here, 'bin', 'mem-maintenance.mjs')
const root = mkdtempSync(join(tmpdir(), 'wb-mem-test-'))
const env = { ...process.env, WORKBUDDY_MEM_HOME: root, WORKBUDDY_DISABLE_MAINTENANCE: '1' }

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log('PASS ' + name) }
  else { fail += 1; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}
const hook = (payload) => {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(payload), env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('hook exit ' + r.status + ': ' + r.stderr)
  return r.stdout || ''
}
const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: here })
const records = () => readFileSync(join(root, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byType = (type) => records().filter((r) => r.type === type)

const SID = 'sess-test-1'
const base = { session_id: SID, cwd: root, transcript_path: join(root, 'no-transcript.jsonl') }

try {
  // 1. 普通工具：调用 + 结果，结果进证据
  // 故意带上 agent_type=cli —— 这是 harness 的通用负载，不是子智能体
  hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'c1', agent_type: 'cli', tool_input: { command: 'echo hello-evidence' } })
  hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c1', agent_type: 'cli', tool_response: 'hello-evidence-42' })
  const bashResult = records().find((r) => r.type === 'tool/result' && r.callId === 'c1')
  check('Bash 结果落库并配对', !!bashResult && bashResult.linked === true, JSON.stringify(bashResult && bashResult.status))
  check('Bash 结果有证据对象', !!(bashResult && bashResult.evidence && /^[a-f0-9]{64}$/.test(bashResult.evidence.sha256)))
  const bashCall = records().find((r) => r.type === 'tool/call' && r.callId === 'c1')
  check('普通工具不误标成子智能体', !!bashCall && !bashCall.agent && !bashCall.expert, JSON.stringify(bashCall && bashCall.agent))
  check('没有凭空生出子智能体记录', byType('agent/start').length === 0)
  const shown = cli(['show', bashResult.evidence.sha256])
  check('证据可按哈希回读', shown.stdout.includes('hello-evidence-42'), shown.stderr)

  // 2. 子智能体：派出 + 回来，都带结构化字段
  hook({
    ...base, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'c2',
    tool_input: { subagent_type: 'explore', description: '查记忆库结构', prompt: '请只读检查记忆库与适配器' },
  })
  hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Task', tool_use_id: 'c2', tool_response: '子智能体结论：结构正常' })
  const start = byType('agent/start').find((r) => r.callId === 'c2')
  const end = byType('agent/end').find((r) => r.callId === 'c2')
  check('子智能体派出被记录', !!start && start.agent && start.agent.type === 'explore', JSON.stringify(start && start.agent))
  check('子智能体任务描述被记录', !!start && String(start.agent.description || '').includes('查记忆库结构'))
  check('子智能体提示原文存证据', !!(start && start.evidence && /^[a-f0-9]{64}$/.test(start.evidence.sha256)))
  check('子智能体完成被记录', !!end && end.status === 'completed' && Number.isFinite(end.durationMs), JSON.stringify(end && end.status))
  check('子智能体结果存证据', !!(end && end.evidence && /^[a-f0-9]{64}$/.test(end.evidence.sha256)))
  check('PostToolUse 未重复提供参数时，子智能体身份沿用调用证据', end?.agent?.type === 'explore')

  const artifact = join(root, 'generated.txt')
  hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'write', tool_input: { file_path: artifact } })
  writeFileSync(artifact, 'synthetic artifact', 'utf8')
  hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'write', tool_response: 'saved' })
  check('实时捕获一条产物', byType('artifact').filter((row) => row.path === artifact).length === 1)
  cli(['replay'])
  check('重放不为同一产物再造索引', byType('artifact').filter((row) => row.path === artifact).length === 1)

  // 3. 专家 / 专家团队
  hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'search_plugins', tool_use_id: 'c3', tool_input: { type: 'expert', query: '投资' } })
  hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'suggest_plugin_install', tool_use_id: 'c4', tool_input: { type: 'expert', pluginId1: 'ExpertValuation' } })
  const experts = byType('expert/reference')
  check('专家引用被记录', experts.length >= 1, 'count=' + experts.length)
  check('专家 ID 可追溯', experts.some((r) => r.expert && String(r.expert.id || '').includes('ExpertValuation')))

  // 4. 轻工具：大结果不落全文，但仍有摘要
  const big = 'x'.repeat(400 * 1024)
  hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'c5', tool_input: { file_path: 'big.txt' } })
  hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'c5', tool_response: big })
  const readResult = records().find((r) => r.type === 'tool/result' && r.callId === 'c5')
  check('轻工具大结果不存全文', !!readResult && !readResult.evidence, JSON.stringify(readResult && readResult.evidence))
  check('轻工具摘要标注未存全文', !!readResult && /未存全文/.test(readResult.text), readResult && readResult.text)

  // 5. 子会话收尾
  hook({ ...base, hook_event_name: 'SubagentStop', agent_name: 'explore', tool_use_id: 'c2', last_assistant_message: '收尾报告：一切正常' })
  check('子会话收尾报告被记录', byType('agent/report').length >= 1)

  // 6. 维护：验证 + 快照（落在同一个根）
  const due = spawnSync(process.execPath, [MAINT, '--due', '--force', '--root', root], { env, encoding: 'utf8' })
  check('maintenance --due 成功', due.status === 0, due.stderr)
  const maintState = JSON.parse(readFileSync(join(root, 'maintenance.json'), 'utf8'))
  check('维护根与库一致', String(maintState.root).toLowerCase() === root.toLowerCase(), maintState.root)
  check('维护验账通过', maintState.verify && maintState.verify.status === 'OK', JSON.stringify(maintState.verify))
  const snaps = existsSync(join(root, 'snapshots')) ? readdirSync(join(root, 'snapshots')) : []
  check('快照已生成', snaps.length === 1, JSON.stringify(snaps))
  const manifest = snaps.length ? JSON.parse(readFileSync(join(root, 'snapshots', snaps[0], 'manifest.json'), 'utf8')) : {}
  check('快照记录条数与字节', !!(manifest.stream && manifest.stream.records > 0 && manifest.stream.bytes > 0), JSON.stringify(manifest.stream))
  check('快照内含 stream 副本', snaps.length ? existsSync(join(root, 'snapshots', snaps[0], 'stream.jsonl')) : false)

  // 7. 清理不误删：只被 evidence 引用的 blob 必须留下
  const prune = spawnSync(process.execPath, [MAINT, '--prune', '--apply', '--root', root], { env, encoding: 'utf8' })
  check('prune 可执行', prune.status === 0, prune.stderr)
  check('被引用的证据未被清理', existsSync(join(root, 'blobs', bashResult.evidence.sha256)))

  // 8. 体检
  const health = cli(['health'])
  check('health 退出码 0', health.status === 0, health.stdout + health.stderr)
  check('health 报出子智能体数量', /子智能体\s*[1-9]/.test(health.stdout), health.stdout)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(`RESULT pass=${pass} fail=${fail} root=${root} (已清理)`)
if (fail) process.exitCode = 1
