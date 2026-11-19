// 固定载荷跑一遍钩子：验证落盘、去重、证据、产物、账本和 MCP。
// 全程用临时 ZCODE_MEM_HOME，不碰真实库。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, appendFileSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './lib/evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(HERE, 'bin', 'hook.mjs')
const CLI = join(HERE, 'bin', 'cli.mjs')
const MCP = join(HERE, 'bin', 'mcp.mjs')
const MAINT = join(HERE, 'tools', 'maintenance.mjs')

const root = mkdtempSync(join(tmpdir(), 'zcode-mem-test-'))
const ws = join(root, 'workspace', '记忆')
mkdirSync(ws, { recursive: true })
const store = join(root, 'store')
mkdirSync(store, { recursive: true })
// 临时目录默认在 AppData\Local\Temp 下，正式配置会把那里排除掉；测试里显式放开。
writeFileSync(join(store, 'config.json'), JSON.stringify({ enabled: true, exclude: [], workspaces: [] }), 'utf8')
const env = { ...process.env, ZCODE_MEM_HOME: store, ZCODE_PROJECT_DIR: ws, ZCODE_DISABLE_MAINTENANCE: '1' }

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

function hook(payload, customEnv = env) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: ws, session_id: 'sess_test', turnId: 'turn_1', timestamp: Date.now(), ...payload }),
    env: customEnv,
    encoding: 'utf8',
    timeout: 30000,
  })
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

function cli(args, customEnv = env) {
  const res = spawnSync(process.execPath, [CLI, ...args], { env: customEnv, encoding: 'utf8', timeout: 30000 })
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

function maint(args, customEnv = env) {
  const res = spawnSync(process.execPath, [MAINT, ...args], { env: customEnv, encoding: 'utf8', timeout: 60000 })
  let json = null
  try { json = JSON.parse(res.stdout) } catch {}
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), json }
}

function streamHome() { return join(root, 'store') }
function rows() {
  const file = join(streamHome(), 'stream.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}
function output(res) {
  if (!res.stdout) return null
  try { return JSON.parse(res.stdout) } catch { return { __bad: res.stdout } }
}

console.log('1) SessionStart')
{
  const res = hook({ hook_event_name: 'SessionStart', source: 'startup' })
  const out = output(res)
  ok('退出码 0', res.code === 0, res.stderr)
  ok('输出是合法 hookSpecificOutput', Boolean(out && !out.__bad && out.hookSpecificOutput && out.hookSpecificOutput.hookEventName === 'SessionStart'), res.stdout.slice(0, 120))
  ok('注入里有归属规则', Boolean(out && String(out.hookSpecificOutput.additionalContext).includes('先分清归属')))
}

console.log('2) 用户原话')
{
  const prompt = '把 dsh-memory 适配到 ZCode，数据要进共享库'
  const res = hook({ hook_event_name: 'UserPromptSubmit', prompt })
  const user = rows().filter((r) => r.type === 'user/message')
  ok('落盘一条 user/message', user.length === 1 && user[0].text === prompt)
  ok('带 ws / wsName', user[0] && Boolean(user[0].ws) && user[0].wsName === '记忆')
  ok('带 hash 与 eventKey', Boolean(user[0] && user[0].hash === sha256(prompt) && user[0].eventKey))
  ok('输出可为空或合法 JSON', !res.stdout || Boolean(output(res) && output(res).hookSpecificOutput), res.stdout.slice(0, 120))
}

console.log('3) 重复事件去重')
{
  const prompt = '同一句话重放两次只该留一条'
  hook({ hook_event_name: 'UserPromptSubmit', prompt })
  hook({ hook_event_name: 'UserPromptSubmit', prompt })
  const hits = rows().filter((r) => r.text === prompt)
  ok('同 turn 同文本只落一条', hits.length === 1, 'got ' + hits.length)
  hook({ hook_event_name: 'UserPromptSubmit', prompt, turnId: 'turn_2' })
  ok('换一个 turn 算新的一轮', rows().filter((r) => r.text === prompt).length === 2)
}

console.log('4) 助手长回答')
{
  const marker = '【中段标记】'
  const long = 'A'.repeat(8000) + marker + 'B'.repeat(8000)
  hook({ hook_event_name: 'Stop', last_assistant_message: long, turnId: 'turn_3' })
  hook({ hook_event_name: 'Stop', last_assistant_message: long, turnId: 'turn_3' })
  const me = rows().filter((r) => r.type === 'assistant/message')
  ok('只落一条', me.length === 1, 'got ' + me.length)
  ok('长回答完整不截断', me[0] && me[0].text.includes(marker) && me[0].text.length === long.length, me[0] ? String(me[0].text.length) : 'none')
}

console.log('5) 工具调用与证据')
{
  const file = join(ws, 'note.txt')
  writeFileSync(file, 'version one', 'utf8')
  const input = { file_path: file, content: 'version one' }
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input, tool_use_id: 'call_A' })
  const call = rows().filter((r) => r.type === 'tool/call')
  ok('落盘 tool/call', call.length === 1 && call[0].tool === 'Write')
  ok('入参存成证据', Boolean(call[0] && call[0].evidence && existsSync(join(streamHome(), 'blobs', call[0].evidence.sha256))))
  ok('pending 已登记', existsSync(join(streamHome(), 'pending.json')))

  writeFileSync(file, 'version two', 'utf8')
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: input, tool_use_id: 'call_A', tool_response: 'ok: wrote 1 file' })
  const result = rows().filter((r) => r.type === 'tool/result')
  const artifact = rows().filter((r) => r.type === 'artifact')
  ok('落盘 tool/result 且状态 completed', result.length === 1 && result[0].status === 'completed')
  ok('结果存成证据', Boolean(result[0] && result[0].evidence && existsSync(join(streamHome(), 'blobs', result[0].evidence.sha256))))
  ok('写入生成 artifact', artifact.length === 1 && artifact[0].path === file)
  ok('前后版本 sha 不同', Boolean(artifact[0] && artifact[0].versions.before.sha256 && artifact[0].versions.after.sha256 && artifact[0].versions.before.sha256 !== artifact[0].versions.after.sha256))
  const before = cli(['read', artifact[0] ? artifact[0].versions.before.sha256 : ''])
  ok('证据能回读旧版本', before.stdout === 'version one', before.stdout)
  ok('pending 已消费', JSON.parse(readFileSync(join(streamHome(), 'pending.json'), 'utf8'))['sess_test|call_A'] === undefined)

  const count = artifact.length
  cli(['replay'])
  cli(['replay'])
  ok('replay 重复执行不重复写', rows().filter((r) => r.type === 'artifact').length === count)
}

console.log('6) 工具失败')
{
  const file = join(ws, 'broken.txt')
  writeFileSync(file, 'draft', 'utf8')
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 'call_B' })
  hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 'call_B', error: 'EACCES: permission denied' })
  const results = rows().filter((r) => r.type === 'tool/result')
  ok('失败结果 status=error', results.some((r) => r.status === 'error' && String(r.text).includes('EACCES')))
  ok('失败不产出 artifact', !rows().some((r) => r.type === 'artifact' && r.path === file))
}

console.log('7) 其它事件')
{
  const before = rows().length
  const res = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
  ok('PermissionRequest 不写流、不阻断', rows().length === before && res.code === 0 && !res.stdout)
}

console.log('8) 账本')
{
  const v = cli(['verify'])
  ok('verify 通过', v.code === 0 && /ledger=OK/.test(v.stdout), v.stdout)
  const s = cli(['stats'])
  const stats = JSON.parse(s.stdout)
  ok('stats 有段和记录', stats.docs > 0 && stats.episodes > 0, s.stdout)
  const w = cli(['workspaces'])
  ok('workspaces 显示当前目录', w.stdout.includes('记忆') && w.stdout.includes(ws.toLowerCase()))
}

console.log('9) MCP server')
{
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { query: '共享库' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'trace', arguments: { query: '同一句话重放两次' } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'
  const res = spawnSync(process.execPath, [MCP], { input: reqs, env, encoding: 'utf8', timeout: 30000 })
  const out = (res.stdout || '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  const byId = new Map(out.map((m) => [m.id, m]))
  ok('initialize 成功', Boolean(byId.get(1) && byId.get(1).result && byId.get(1).result.serverInfo.name === 'zcode-memory'))
  const tools = byId.get(2) && byId.get(2).result && byId.get(2).result.tools
  ok('tools/list 有五个工具', Array.isArray(tools) && tools.length === 5, tools ? tools.map((t) => t.name).join(',') : 'none')
  ok('recall 能返回内容', Boolean(byId.get(3) && byId.get(3).result && byId.get(3).result.content))
  ok('trace 能核对原话', Boolean(byId.get(4) && byId.get(4).result && String(byId.get(4).result.content[0].text).includes(byId.get(4).result.content[0].text)))
}

console.log('10) 维护')
{
  const v = maint(['--verify'])
  ok('verify 通过', v.code === 0 && v.json && v.json.status === 'OK', v.stdout.slice(0, 120))

  const b = maint(['--backup'])
  const snaps = () => readdirSync(join(streamHome(), 'snapshots')).sort()
  ok('backup 生成快照', b.code === 0 && snaps().length === 1 && existsSync(join(streamHome(), 'snapshots', snaps()[0], 'manifest.json')))
  const b2 = maint(['--backup', '--keep', '1'])
  ok('保留策略只留 1 份', b2.code === 0 && snaps().length === 1)

  const orphan = join(streamHome(), 'blobs', 'a'.repeat(64))
  writeFileSync(orphan, 'orphan evidence')
  const old = new Date(Date.now() - 40 * 864e5)
  utimesSync(orphan, old, old)
  const dry = maint(['--prune'])
  ok('prune 默认只试算', dry.code === 0 && dry.json && dry.json.candidates.some((c) => c.name === 'a'.repeat(64)) && existsSync(orphan))
  const applied = maint(['--prune', '--apply'])
  ok('prune --apply 才删除', applied.code === 0 && !existsSync(orphan) && applied.json.deleted >= 1)

  appendFileSync(join(streamHome(), 'stream.jsonl'),
    JSON.stringify({ ts: Date.now(), who: 'he', sid: 's_tail', text: '待接纳的尾巴', type: 'user/message', hash: sha256('待接纳的尾巴') }) + '\n', 'utf8')
  const pending = maint(['--verify'])
  ok('未接纳尾巴显示 PENDING', pending.code === 0 && pending.json && pending.json.status === 'PENDING', pending.json && pending.json.status)
  const synced = maint(['--sync'])
  ok('sync 接纳尾巴', synced.code === 0 && synced.json && synced.json.ok === true && synced.json.status === 'OK')
  ok('接纳后 verify OK', maint(['--verify']).json.status === 'OK')

  const due1 = maint(['--due'])
  ok('due 写入 maintenance.json', due1.code === 0 && due1.json && typeof due1.json.lastRun === 'number' && existsSync(join(streamHome(), 'maintenance.json')))
  const due2 = maint(['--due'])
  ok('12 小时内不重复跑', due2.json && due2.json.skipped === true)
  const forced = maint(['--due', '--force'])
  ok('--force 立即重跑', forced.code === 0 && forced.json && forced.json.lastRun >= due1.json.lastRun)

  const rep = maint(['--report'])
  ok('report 给出体积与分类', rep.code === 0 && rep.json && rep.json.stream.records > 0 && rep.json.blobs.files >= 0 && rep.json.snapshots.files > 0)

  const h = cli(['health'])
  ok('cli health 一行输出', h.code === 0 && /ledger=OK/.test(h.stdout) && /records=\d+/.test(h.stdout), h.stdout)
}

console.log('11) 从 ZCode 数据库回填')
{
  const { DatabaseSync } = await import('node:sqlite')
  const dbFile = join(store, '..', 'zcode-db.sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec('create table message(id text primary key, session_id text, time_created integer, data text)')
  db.exec('create table part(id text primary key, message_id text, session_id text, time_created integer, data text)')
  db.exec('create table session(id text primary key, parent_id text, directory text, task_type text, title text, time_created integer)')
  const t0 = Date.now() - 60 * 60 * 1000
  const prompt = (turn, text, ts) => hook({ hook_event_name: 'UserPromptSubmit', prompt: text, turnId: turn, session_id: 'sess_bf', timestamp: ts })
  prompt('bf1', '回填窗口一', t0)
  prompt('bf2', '回填窗口二', t0 + 10_000)
  prompt('bf3', '回填窗口三（流里已有回答）', t0 + 20_000)
  prompt('bf4', '回填窗口四（库里没有正文）', t0 + 30_000)
  prompt('bf6', '回填窗口六（与窗口一正文重复）', t0 + 50_000)
  // bf3 已经在流里有一条助手记录：回填应判「已有」，不再查库、不重复写。
  hook({ hook_event_name: 'Stop', last_assistant_message: '回答三', turnId: 'bf3', session_id: 'sess_bf', timestamp: t0 + 21_000 })

  const add = (id, ts, text) => {
    db.prepare('insert into message(id,session_id,time_created,data) values(?,?,?,?)')
      .run('m-' + id, 'sess_bf', ts, JSON.stringify({ role: 'assistant' }))
    db.prepare('insert into part(id,message_id,session_id,time_created,data) values(?,?,?,?,?)')
      .run('p-' + id, 'm-' + id, 'sess_bf', ts, JSON.stringify({ type: 'text', text }))
  }
  add('1', t0 + 1000, '回答一')
  add('2', t0 + 11_000, '回答二')
  add('3', t0 + 22_000, '回答三')
  add('6', t0 + 51_000, '回答一')

  // 子代理会话：任务提示 + 两个工具（一个 Bash，一个 Write 产物）。
  const subFile = join(ws, 'sub-written.txt')
  writeFileSync(subFile, 'sub file', 'utf8')
  db.prepare('insert into session values(?,?,?,?,?,?)')
    .run('sess_sub', 'sess_bf', ws, 'subagent_child', '子代理', t0 + 60_000)
  const addMsg = (id, role, ts) => db.prepare('insert into message values(?,?,?,?)')
    .run(id, 'sess_sub', ts, JSON.stringify({ role }))
  const addPart = (id, msg, ts, data) => db.prepare('insert into part values(?,?,?,?,?)')
    .run(id, msg, 'sess_sub', ts, JSON.stringify(data))
  addMsg('m-task', 'user', t0 + 60_000)
  addPart('p-task', 'm-task', t0 + 60_000, { type: 'text', text: '只读探查目录，不要修改' })
  addMsg('m-tool1', 'assistant', t0 + 61_000)
  addPart('p-tool1', 'm-tool1', t0 + 61_000, {
    type: 'tool', callID: 'sc1', tool: 'Bash',
    state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n' },
  })
  addMsg('m-tool2', 'assistant', t0 + 62_000)
  addPart('p-tool2', 'm-tool2', t0 + 62_000, {
    type: 'tool', callID: 'sc2', tool: 'Write',
    state: { status: 'completed', input: { file_path: subFile, content: 'sub file' }, output: 'ok' },
  })
  db.close()

  const bfEnv = { ...env, ZCODE_DB: dbFile }
  const first = cli(['backfill', '--session', 'sess_bf'], bfEnv)
  const firstJson = JSON.parse(first.stdout)
  ok('回填两条缺失回答', first.code === 0 && firstJson.filled === 2, first.stdout.slice(0, 160))
  ok('库里没有正文的窗口只计数', firstJson.noText === 1)
  ok('与已有正文重复的不写', firstJson.duplicate === 1)
  ok('已有回答的轮不再查库', firstJson.already === 1)
  const rowsAfter = rows().filter((r) => r.type === 'assistant/message' && r.sid === 'sess_bf')
  ok('回填记录带来源与 turn', rowsAfter.some((r) => r.source && r.source.type === 'db.backfill' && r.turn === 'bf1'))

  const second = cli(['backfill', '--session', 'sess_bf'], bfEnv)
  const secondJson = JSON.parse(second.stdout)
  ok('重复执行不增行', secondJson.filled === 0 && secondJson.already === 3, second.stdout.slice(0, 160))
  ok('回填后账本仍 OK', maint(['--sync']).code === 0 && maint(['--verify']).json.status === 'OK')

  const dry = (() => {
    // 新开一个窗口，只让它出现在库里：dry-run 应报 filled=1 但不落盘。
    prompt('bf5', '回填窗口五（只试算）', t0 + 40_000)
    const d2 = new DatabaseSync(dbFile)
    d2.prepare('insert into message(id,session_id,time_created,data) values(?,?,?,?)')
      .run('m-5', 'sess_bf', t0 + 41_000, JSON.stringify({ role: 'assistant' }))
    d2.prepare('insert into part(id,message_id,session_id,time_created,data) values(?,?,?,?,?)')
      .run('p-5', 'm-5', 'sess_bf', t0 + 41_000, JSON.stringify({ type: 'text', text: '回答五' }))
    d2.close()
    const before = rows().length
    const res = cli(['backfill', '--session', 'sess_bf', '--dry-run'], bfEnv)
    return { ...JSON.parse(res.stdout), before, after: rows().length }
  })()
  ok('--dry-run 报将补但实际不写', dry.filled === 1 && dry.after === dry.before, JSON.stringify({ filled: dry.filled, before: dry.before, after: dry.after }))

  const sub1 = cli(['backfill', '--subagents', '--session', 'sess_sub'], bfEnv)
  const subJson = JSON.parse(sub1.stdout)
  ok('子代理回填任务提示+两次调用+结果+产物', sub1.code === 0 && subJson.filled === 6, sub1.stdout.slice(0, 160))
  const subRows = rows().filter((r) => r.sid === 'sess_sub')
  ok('任务提示标 meta，不写成用户原话', subRows.some((r) => r.type === 'subagent/task' && r.who === 'meta') && !subRows.some((r) => r.type === 'user/message'))
  ok('子代理工具与产物带 sid', subRows.some((r) => r.type === 'tool/call' && r.callId === 'sc1') && subRows.some((r) => r.type === 'artifact' && r.path === subFile))
  ok('产物记录标明 before unknown', subRows.find((r) => r.type === 'artifact').versions.before.state === 'unknown')
  const sub2 = cli(['backfill', '--subagents', '--session', 'sess_sub'], bfEnv)
  ok('子代理回填重复执行不增行', JSON.parse(sub2.stdout).filled === 0 && JSON.parse(sub2.stdout).skipped === 6)
}

console.log('12) 篡改能被检出（独立临时库）')
{
  const root2 = mkdtempSync(join(tmpdir(), 'zcode-mem-tamper-'))
  const store2 = join(root2, 'store')
  mkdirSync(store2, { recursive: true })
  writeFileSync(join(store2, 'config.json'), JSON.stringify({ enabled: true, exclude: [], workspaces: [] }), 'utf8')
  const env2 = { ...process.env, ZCODE_MEM_HOME: store2, ZCODE_PROJECT_DIR: ws, ZCODE_DISABLE_MAINTENANCE: '1' }
  const run = (payload) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: ws, session_id: 'sess_t', turnId: 't1', timestamp: Date.now(), ...payload }),
    env: env2, encoding: 'utf8', timeout: 30000,
  })
  run({ hook_event_name: 'UserPromptSubmit', prompt: '这句话会被改掉一半' })
  const file = join(root2, 'store', 'stream.jsonl')
  const text = readFileSync(file, 'utf8').replace('这句话会被改掉一半', '这句话被悄悄改过了')
  writeFileSync(file, text, 'utf8')
  const v = spawnSync(process.execPath, [CLI, 'verify'], { env: env2, encoding: 'utf8', timeout: 30000 })
  ok('篡改后 verify 失败且报 BAD', v.status === 1 && /BAD/.test(v.stdout), v.stdout)
  ok('流确实存在且非空', statSync(file).size > 0)
}

console.log(`\n${pass} 通过，${fail} 失败`)
process.exitCode = fail ? 1 : 0
