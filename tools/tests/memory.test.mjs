import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createCapture } from '../mem-capture.mjs'
import { snapshot, readBlob, artifactPaths } from '../mem-artifacts.mjs'
import { injectBackground } from '../mem-context.mjs'
import { setupMemory } from '../mem-plugin.mjs'

const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir()
const root = fs.mkdtempSync(path.join(base, 'memory-test-'))
process.env.OPENCODE_MEM_HOME = root
const core = await import('../mem-core.mjs')
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root) })
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('完整保存长回答中部和尾部；相同开头不合并；来源事件重放幂等', () => {
  const c = createCapture(core, root)
  const long = '开头'.repeat(3000) + '中部必须保留' + '末尾'.repeat(3000)
  c.user('s', 'u1', '继续', 1)
  c.user('s', 'u2', '继续', 2)
  const a = c.assistant('s', 'a1', 0, long, 3)
  c.assistant('s', 'a1', 0, long, 3)
  c.assistant('s', 'a2', 0, long + '另一种实现', 4)
  assert.equal(core.readAll().length, 4)
  assert.equal(core.getRecord(a.seq).text, long)
  assert.equal(core.trace('中部必须保留').length, 2)
  assert.equal(core.verify().status, 'OK')
})

test('同一消息的 observed/final 同文只留一条；recall 视图去重', () => {
  const c = createCapture(core, root)
  c.user('s', 'u', '问', 1)
  c.assistant('s', 'm1', 0, '同一段最终回答', 2, null, 'observed')
  c.assistant('s', 'm1', 0, '同一段最终回答', 3, null, 'text-ended')
  assert.equal(core.trace('同一段最终回答').length, 1)
  core.append({ who: 'assistant', kind: 'message', sid: 's', messageID: 'm2', ordinal: 0, text: '重复视图测试内容足够长，用来验证派生去重。' })
  core.append({ who: 'assistant', kind: 'message', sid: 's', messageID: 'm2', ordinal: 0, text: '重复视图测试内容足够长，用来验证派生去重。' })
  const hits = core.recall('重复视图测试内容', { n: 5 })
  assert.equal(hits.filter((h) => h.text.includes('重复视图测试内容')).length, 1)
})

test('默认回忆不把 episode 摘要排到原话前面', () => {
  core.append({ who: 'assistant', kind: 'message', text: '缓存方案用本地文件，这是当时的原话。' })
  core.append({ who: 'system', kind: 'episode', text: '任务摘录：缓存方案用本地文件。' })
  const hits = core.recall('缓存方案 本地文件', { n: 5 })
  assert.ok(hits.length >= 1)
  assert.notEqual(hits[0].kind, 'episode')
})

test('成功写入关联前后版本；失败写入只有错误证据', () => {
  const c = createCapture(core, root), file = path.join(root, 'feature.js')
  fs.writeFileSync(file, 'version one')
  c.user('s', 'u', '实现缓存功能', 1)
  const e = { sessionID: 's', id: 'call', messageID: 'a', tool: 'edit', input: { path: file } }
  c.before(e)
  assert.equal(core.readAll().filter((r) => r.kind === 'artifact').length, 0)
  fs.writeFileSync(file, 'version two')
  c.after({ ...e, status: 'completed', result: { content: 'done' } })
  c.after({ ...e, status: 'completed', result: { content: 'done' } })
  const artifacts = core.readAll().filter((r) => r.kind === 'artifact')
  assert.equal(artifacts.length, 1)
  assert.equal(readBlob(root, artifacts[0].versions.before.sha256).toString(), 'version one')
  assert.equal(readBlob(root, artifacts[0].versions.after.sha256).toString(), 'version two')
  c.before({ ...e, id: 'failed' })
  c.after({ ...e, id: 'failed', status: 'error', error: new Error('permission denied') })
  assert.equal(core.readAll().filter((r) => r.kind === 'artifact').length, 1)
  assert.equal(core.readTools().filter((r) => r.phase === 'error').length, 1)
  assert.match(core.readTools().find((r) => r.phase === 'error').error, /permission denied/)
  assert.equal(core.verify().status, 'OK')
})

test('投影中断后从持久化结果恢复，不重复记产物；任务摘要链接事实和完整回答', () => {
  let fail = true
  const c = createCapture({ ...core, append: (r) => {
    if (r.kind === 'artifact' && fail) { fail = false; throw new Error('simulated interruption') }
    return core.append(r)
  } }, root)
  c.user('s', 'u', '实现缓存', 1)
  const file = path.join(root, 'cache.js')
  const e = { sessionID: 's', id: 'call', tool: 'write', input: { path: file } }
  c.before(e)
  fs.writeFileSync(file, 'cache implementation')
  assert.throws(() => c.after({ ...e, status: 'completed', result: { content: 'saved' } }), /simulated/)
  c.replay(); c.replay()
  assert.equal(core.readAll().filter((r) => r.kind === 'artifact').length, 1)
  const answer = c.assistant('s', 'a', 0, '选择这个方案的原因是本地运行；实现细节在 cache.js。', 3)
  const episode = c.finish('s')
  c.finish('s'); c.replay()
  assert.equal(core.readAll().filter((r) => r.kind === 'episode').length, 1)
  assert.ok(episode.answerIDs.includes(answer.id))
  assert.equal(episode.source.inferredReason, false)
  assert.notEqual(core.trace('选择这个方案')[1]?.attribution, '我说的')
})

for (const change of ['text', 'metadata', 'delete', 'reorder', 'tail', 'invalid']) {
  test(`检查点检测 ${change} 损坏；不接纳坏字节`, () => {
    core.append({ text: 'first', who: 'user' })
    core.append({ text: 'second', who: 'assistant' })
    const file = core.STREAM
    const bytes = fs.readFileSync(file, 'utf8'), lines = bytes.trimEnd().split('\n')
    const changed = change === 'text' ? bytes.replace('first', 'fIrst')
      : change === 'metadata' ? bytes.replace('"who":"user"', '"who":"evil"')
      : change === 'delete' ? lines[1] + '\n'
      : change === 'reorder' ? lines.reverse().join('\n') + '\n'
      : change === 'tail' ? lines[0] + '\n' : bytes + '{broken'
    fs.writeFileSync(file, changed)
    assert.equal(core.verify().status, 'BAD')
    assert.throws(() => core.syncIntegrity(), /Integrity failure/)
    assert.throws(() => core.append({ text: 'third' }), /Integrity failure/)
    assert.equal(fs.readFileSync(file, 'utf8'), changed)
  })
}

test('合法但未提交的尾部需显式接纳；保留原始字节', () => {
  core.append({ text: 'committed' })
  fs.appendFileSync(core.STREAM, JSON.stringify({ text: 'crash tail' }) + '\n')
  const bytes = fs.readFileSync(core.STREAM)
  assert.equal(core.verify().status, 'PENDING')
  assert.throws(() => core.append({ text: 'next' }), /Uncheckpointed tail/)
  core.syncIntegrity()
  assert.equal(core.verify().status, 'OK')
  assert.deepEqual(fs.readFileSync(core.STREAM), bytes)
})

test('老账本接纳只建立当前基线，不冒充历史校验；compact 禁止改写', () => {
  const bytes = Buffer.from(JSON.stringify({ seq: 7, text: 'legacy' }) + '\n')
  fs.writeFileSync(core.STREAM, bytes)
  assert.equal(core.verify().status, 'UNTRACKED')
  core.syncIntegrity()
  assert.equal(core.verify().noHash, 1)
  assert.deepEqual(fs.readFileSync(core.STREAM), bytes)
  assert.throws(() => core.compact({ apply: true }), /只追加/)
})

test('丢失或损坏的文件版本可检测，大文件快照明确标记跳过', () => {
  const file = path.join(root, 'data.txt')
  fs.writeFileSync(file, 'saved evidence')
  const version = snapshot(root, file)
  core.append({ text: 'artifact', versions: { after: version } })
  assert.equal(snapshot(root, file, 1).state, 'oversize')
  fs.writeFileSync(path.join(root, 'blobs', version.sha256), 'broken')
  assert.equal(core.verify().status, 'BAD')
})

test('同义词单独命中可召回；patch 的增删改和移动路径都能识别', () => {
  core.append({ text: 'vmware implementation' })
  core.addAlias('vmware', '虚拟机')
  assert.ok(core.recall('虚拟机').some((r) => r.text === 'vmware implementation'))
  assert.equal(artifactPaths('functions.apply_patch', { patchText: '*** Add File: a\n*** Update File: b\n*** Move to: c\n*** Delete File: d\n' }, root).length, 4)
})

test('多个进程并发追加无丢失，来源 ID 去重也跨进程有效', async () => {
  const moduleURL = new URL('../mem-journal.mjs', import.meta.url).href
  await Promise.all([0, 1, 2, 3].map((worker) => new Promise((resolve, reject) => {
    const script = `import {createJournal} from ${JSON.stringify(moduleURL)}; const j=createJournal(${JSON.stringify(root)}); for(let i=0;i<10;i++)j.append('stream.jsonl',{text:'worker '+${worker}+' '+i},{dedupeKey:${JSON.stringify(worker + ':')}+i});j.append('stream.jsonl',{text:'shared'},{dedupeKey:'shared'});`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true })
    let errors = ''
    child.stderr.on('data', (b) => { errors += b })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)))
  })))
  const rows = core.readAll()
  assert.equal(rows.length, 41)
  assert.equal(new Set(rows.map((r) => r.seq)).size, 41)
  assert.equal(core.verify().status, 'OK')
})

for (const content of ['original', [{ type: 'text', text: 'original' }, { type: 'image', image: 'example' }]]) {
  test(`背景注入不改原始消息，重复调用不会堆叠：${typeof content}`, () => {
    const original = [{ role: 'user', content }], copy = structuredClone(original)
    const e = { messages: original, system: [] }
    injectBackground(e, 'historical evidence')
    injectBackground(e, 'historical evidence')
    assert.deepEqual(original, copy)
    assert.equal((JSON.stringify(e.messages).match(/<memory-background>/g) || []).length, 1)
  })
}

test('插件在文本结束时保存最后回答；续调每次注入，持久历史没有注入内容', async () => {
  const hooks = {}, tools = []
  let finished
  const consumed = new Promise((resolve) => { finished = resolve })
  const canonical = [{ id: 'u', type: 'user', text: '保存最后回答', time: { created: 1 } }]
  const ctx = {
    location: { directory: root },
    session: { hook: async (name, fn) => { hooks[name] = fn; return { dispose() {} } }, context: async () => canonical },
    tool: { hook: async (name, fn) => { hooks[name] = fn; return { dispose() {} } },
      transform: async (fn) => fn({ namespace() {}, add(t) { tools.push(t) } }) },
    event: { async *subscribe() {
      yield { type: 'session.text.ended', location: { directory: root }, created: 2,
        data: { sessionID: 's', assistantMessageID: 'a', ordinal: 0, text: '最后回答含实现细节' } }
      yield { type: 'session.text.ended', location: { directory: root + '-other' }, created: 3,
        data: { sessionID: 's', assistantMessageID: 'foreign', ordinal: 0, text: '别的工作区' } }
      finished()
    } },
  }
  core.setPin('test', 'memory anchor')
  const cleanup = await setupMemory(ctx, core)
  await hooks.prompt({ sessionID: 's', messageID: 'u-new', prompt: { text: '新会话第一句' } })
  await hooks.prompt({ sessionID: 's', messageID: 'u-new', prompt: { text: '新会话第一句' } })
  assert.equal(core.trace('新会话第一句').length, 1)
  await consumed
  assert.equal(core.trace('最后回答含实现细节').length, 1)
  assert.equal(core.trace('别的工作区').length, 0)
  for (let i = 0; i < 2; i++) {
    const e = { sessionID: 's', messages: [{ role: 'user', content: '保存最后回答' }], system: [] }
    await hooks.context(e)
    assert.match(e.messages[0].content, /memory-background/)
  }
  assert.ok(core.readAll().every((r) => !r.text.includes('memory-background')))
  const read = tools.find((t) => t.name === 'read')
  const row = core.readAll().find((r) => r.who === 'assistant')
  assert.match((await read.execute({ ref: String(row.seq) })).content, /最后回答含实现细节/)
  await cleanup()
})

test('工具长输出完整保留；缺少 before 时明确标记未配对', () => {
  const c = createCapture(core, root)
  const output = 'head'.repeat(2000) + 'MIDDLE_EVIDENCE' + 'tail'.repeat(2000)
  const result = c.after({ sessionID: 's', id: 'unpaired', tool: 'shell', status: 'completed', result: { content: output } })
  assert.equal(result.paired, false)
  assert.equal(JSON.parse(core.evidence(result.output.sha256)).content, output)
  assert.equal(core.verify().status, 'OK')
})

test('拒绝解锁活进程；非法可变状态不会被空对象覆盖', () => {
  const lock = path.join(root, '.journal-lock')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }))
  assert.throws(() => core.unlockJournal(), /still alive/)
  assert.ok(fs.existsSync(lock))
  fs.rmSync(lock, { recursive: true })
  fs.writeFileSync(core.ALIASES, '{broken')
  assert.throws(() => core.addAlias('a', 'b'))
  assert.equal(fs.readFileSync(core.ALIASES, 'utf8'), '{broken')
})

test('上下文压缩后仍能关联已有用户记录，派生记录不能冒充方案原因', () => {
  const user = core.append({ who: 'user', sid: 's', text: '实现功能' })
  const c = createCapture(core, root)
  const a = c.assistant('s', 'a', 0, '使用哈希是因为需要核对版本。', 3)
  assert.equal(a.turnID, user.id)
  const episode = c.finish('s')
  assert.equal(episode.requestID, user.id)
  assert.equal(episode.source.inferredReason, false)
})

test('verify 不抢写锁；死亡进程留下的锁可自动回收', () => {
  core.append({ text: 'lock test' })
  const lock = path.join(root, '.journal-lock')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999 }))
  // 读校验不应该碰写锁，也不应该把锁当成损坏。
  assert.equal(core.verify().status, 'OK')
  assert.ok(fs.existsSync(lock))
  // 写操作发现 owner 已死，自己回收后继续，而不是等满超时。
  const row = core.append({ text: 'after stale lock' })
  assert.ok(row && row.seq > 0)
  assert.equal(fs.existsSync(lock), false)
})

test('中断回复保留已观察到的可见文本，排除隐藏推理', () => {
  const c = createCapture(core, root)
  c.messages('s', [{ type: 'assistant', id: 'interrupted', time: { created: 1 },
    content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '可见的未完成实现细节' }] }])
  const row = core.readAll()[0]
  assert.equal(row.text, '可见的未完成实现细节')
  assert.equal(row.completion, 'observed')
  assert.equal(core.trace('private reasoning').length, 0)
})
