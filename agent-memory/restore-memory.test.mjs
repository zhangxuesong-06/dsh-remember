import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createJournal, sha256 } from '../tools/mem-journal.mjs'
import { putBlob } from '../tools/mem-artifacts.mjs'
import { Ledger } from '../dsh-memory/lib/store.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cue = 'synthetic_restore_export'
const question = `${cue}\r\n  用户原话 🙂`
const answer = '开头\r\n'.repeat(2100) + '  中间保留 🙂\r\n' + '末尾\r\n'.repeat(1900)
const artifactBefore = '合成文件旧版\r\n'
const artifactAfter = '合成文件新版 🙂\r\n'
const resultText = '合成工具结果\r\n  完整输出 🙂'
const hashes = [artifactBefore, artifactAfter, resultText].map(sha256)
const orphan = sha256('快照中尚未被引用的证据')

function run(script, args, { cwd, env, status = 0 } = {}) {
  const command = script ? [path.join(repo, script), ...args] : args
  const result = spawnSync(process.execPath, command, {
    cwd, env: { ...process.env, MEMORY_CASE_RECALL: 'manual', MEMORY_CASE_RESTORE: '', MEMORY_DISABLE_MAINTENANCE: '1',
      HIPPO_LINE: '', ...env }, encoding: 'utf8', windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, status, result.stderr + result.stdout)
  return result.stdout + (status ? result.stderr : '')
}

function fingerprint(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(root, file), sha256(fs.readFileSync(file))]
    }))
}

function seed(adapter, root, project) {
  fs.mkdirSync(root, { recursive: true })
  const legacy = { id: 'legacy-record', who: adapter === 'dsh' ? 'he' : 'user', seq: 7,
    text: '保留旧格式原文', sid: 'legacy', ws: project }
  fs.writeFileSync(path.join(root, 'stream.jsonl'), JSON.stringify(legacy) + '\r\n')
  const file = path.join(project, 'nonexistent-output.txt')
  const versions = { path: file, before: { state: 'saved', ...putBlob(root, artifactBefore) },
    after: { state: 'saved', ...putBlob(root, artifactAfter) } }
  const evidence = putBlob(root, resultText)
  assert.equal(putBlob(root, '快照中尚未被引用的证据').sha256, orphan)
  const scope = { sid: 'restore-session', turnID: 'restore-turn', ws: project }
  const episode = { ...scope, id: 'observation', kind: 'episode', type: 'episode',
    text: '合成派生任务观察', source: { type: 'derived.observation' } }
  if (adapter === 'opencode') {
    const journal = createJournal(root)
    journal.sync()
    journal.append('stream.jsonl', { ...scope, id: 'user-record', kind: 'message', who: 'user', text: question })
    journal.append('stream.jsonl', { ...scope, id: 'assistant-record', kind: 'message', who: 'assistant', text: answer })
    journal.append('episodes.jsonl', { ...episode, who: 'system', requestID: 'user-record', answerIDs: ['assistant-record'] })
    journal.append('stream.jsonl', { ...episode, id: 'episode-projection', who: 'system', eventKey: 'episode:observation' })
    journal.append('tools.jsonl', { ...scope, id: 'write-result', phase: 'completed', callID: 'write-call',
      tool: 'write', files: [versions], output: evidence })
  } else {
    const ledger = new Ledger(root).open()
    ledger.sync()
    ledger.append({ ...scope, id: 'user-record', type: 'user/message', who: 'he', text: question })
    ledger.append({ ...scope, id: 'assistant-record', type: 'assistant/message', who: 'me', text: answer })
    ledger.append({ ...episode, who: 'act' })
    ledger.append({ ...scope, id: 'write-result', type: 'tool/result', who: 'act', text: '已返回',
      eventKey: 'write-completed', status: 'completed', callId: 'write-call', tool: 'write', files: [versions], evidence })
    ledger.noteSeq(scope.sid, 4)
    ledger.close()
  }
}

function caseToken(output) {
  const token = output.match(/case:[a-f0-9]{32}:[st]:[\w-]+:[\w-]+:[\w-]+/)?.[0]
  assert.ok(token, output)
  return token
}

for (const adapter of ['opencode', 'dsh']) {
  test(`${adapter} 快照脱离原库后，原引用、正文、角色与证据可回读`, async t => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'memory-recovery-'))
    t.after(() => fs.rmSync(base, { recursive: true, force: true }))
    const project = path.join(base, 'synthetic project')
    const sourceHome = path.join(base, 'source')
    const output = path.join(base, 'restored copies')
    fs.mkdirSync(project)
    fs.mkdirSync(output)
    const dsh = adapter === 'dsh'
    const config = new URL('../dsh-memory/lib/config.mjs', import.meta.url).href
    const sourceRoot = dsh
      ? run(null, ['--input-type=module', '-e',
        `import { workspaceDir } from ${JSON.stringify(config)}; console.log(workspaceDir(process.argv[1]))`, project],
      { env: { DSH_MEMORY_HOME: path.join(sourceHome, 'dsh') } }).trim()
      : path.join(sourceHome, 'opencode')
    const ledgerName = path.basename(sourceRoot)
    const cli = (home, cmd, args = [], extraEnv = {}) => {
      const env = { AGENT_MEMORY_HOME: home, OPENCODE_MEM_HOME: path.join(home, 'opencode'),
        CODEX_MEMORY_HOME: path.join(home, 'codex'), DSH_HOME: path.join(home, 'dsh-host'),
        DSH_MEMORY_HOME: path.join(home, 'dsh'), ...extraEnv }
      return run(dsh ? 'dsh-memory/cli.mjs' : 'tools/mem.mjs', [cmd, ...(dsh ? [project] : []), ...args], { cwd: project, env })
    }
    const index = (home, root, env) => JSON.parse(dsh ? cli(home, 'case-index-rebuild', [], env)
      : run('tools/mem-maintenance.mjs', ['--root', root, '--case-index-rebuild'], { cwd: project, env }))
    const readonly = (home, ref) => JSON.parse(run('agent-memory/recall.mjs', ['show', ref, '--json'], {
      cwd: project, env: { AGENT_MEMORY_HOME: home, CODEX_MEMORY_HOME: path.join(home, 'codex') },
    }))
    const originalRefs = Array.from({ length: dsh ? 5 : 4 }, (_, i) => dsh ? `dsh:${ledgerName}:${i + 1}` : `opencode:${i + 1}`)
    const checkOriginalRows = home => originalRefs.map(ref => {
      const { store, ...record } = readonly(home, ref)
      assert.ok(store.startsWith(home + path.sep))
      return record
    })

    seed(adapter, sourceRoot, project)
    assert.equal(index(sourceHome, sourceRoot).state, 'ready')
    const originalCase = caseToken(cli(sourceHome, 'recall', [cue, '--cases']))
    const originalEvidence = caseToken(cli(sourceHome, 'recall', ['write', '--cases']))
    const expectedRows = checkOriginalRows(sourceHome)
    assert.deepEqual(expectedRows.slice(0, 3).map(({ who, text }) => [who, text]), [
      ['user', '保留旧格式原文'], ['user', question], ['assistant', answer],
    ])
    assert.deepEqual(JSON.parse(cli(sourceHome, 'show', [originalEvidence])), { state: 'exact', text: resultText })

    const snapshotResult = JSON.parse(run(dsh ? 'dsh-memory/tools/maintenance.mjs' : 'tools/mem-maintenance.mjs',
      [dsh ? '--dir' : '--root', sourceRoot, '--backup'],
      { cwd: project, env: { DSH_MEMORY_HOME: path.join(sourceHome, 'dsh') } }))
    const snapshot = path.join(sourceRoot, 'snapshots', (dsh ? snapshotResult[0] : snapshotResult).snapshot.name)
    const archive = path.join(base, 'detached snapshot')
    fs.cpSync(snapshot, archive, { recursive: true })
    const sourceBefore = fingerprint(sourceHome)
    const retired = path.join(base, 'offline source')
    fs.renameSync(sourceHome, retired)
    assert.equal(fs.existsSync(sourceRoot), false)
    const archiveBefore = fingerprint(archive)
    const restore = (input, status = 0) => run('agent-memory/restore-memory.mjs',
      ['--adapter', adapter, '--snapshot', input, '--output', output], { cwd: project, status })

    const first = JSON.parse(restore(archive))
    const second = JSON.parse(restore(archive))
    assert.notEqual(first.root, second.root)
    assert.equal(first.verification.blobs, 4)
    assert.equal(first.verification.records, dsh ? 5 : 6)
    assert.deepEqual(fingerprint(first.root), fingerprint(second.root))
    if (dsh) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.ledger, 'seqs.json'), 'utf8')), { 'restore-session': 4 })
    const oldArchive = path.join(base, 'legacy snapshot manifest')
    fs.cpSync(archive, oldArchive, { recursive: true })
    const oldManifestFile = path.join(oldArchive, 'manifest.json')
    const oldManifest = JSON.parse(fs.readFileSync(oldManifestFile, 'utf8'))
    delete oldManifest.caseRoot
    delete oldManifest.blobHashes
    if (dsh) delete oldManifest.files
    fs.writeFileSync(oldManifestFile, JSON.stringify(oldManifest))
    const legacy = JSON.parse(restore(oldArchive))
    assert.deepEqual(fingerprint(first.root), fingerprint(legacy.root))
    assert.equal(fs.readdirSync(first.ledger).some(name => name.endsWith('.sqlite')), false)
    const recoveryEnv = { MEMORY_CASE_RESTORE: '1' }
    assert.deepEqual(checkOriginalRows(first.root), expectedRows)
    assert.deepEqual(JSON.parse(cli(first.root, 'show', [originalCase])), { state: 'denied' })
    assert.deepEqual(JSON.parse(cli(first.root, 'show', [originalCase], recoveryEnv)), { state: 'exact', text: question })
    assert.deepEqual(JSON.parse(cli(first.root, 'show', [originalEvidence], recoveryEnv)), { state: 'exact', text: resultText })
    const native = dsh ? '2' : '#9'
    for (const ref of [native, 'assistant-record']) {
      assert.deepEqual(JSON.parse(cli(first.root, 'show', [ref, '--range', `0:${answer.length}`])).text, answer)
    }
    const stream = path.join(first.ledger, 'stream.jsonl')
    const originalBytes = fs.readFileSync(stream)
    assert.deepEqual(originalBytes, fs.readFileSync(path.join(archive, 'stream.jsonl')))
    assert.equal(index(first.root, first.ledger, recoveryEnv).state, 'ready')
    assert.deepEqual(fs.readFileSync(stream), originalBytes)
    assert.equal(caseToken(cli(first.root, 'recall', [cue, '--cases'], recoveryEnv)), originalCase)
    assert.equal(caseToken(cli(first.root, 'recall', ['write', '--cases'], recoveryEnv)), originalEvidence)
    for (const copy of [first, second]) {
      const row = { kind: 'decision', who: 'user', id: 'copy-local', ws: project, text: 'copy_local_decision' }
      if (dsh) {
        const ledger = new Ledger(copy.ledger).open()
        ledger.append({ ...row, type: row.kind, ts: 1700000000000 })
        ledger.close()
      } else createJournal(copy.ledger).append('stream.jsonl', { ...row, ts: 1700000000000 })
      assert.equal(index(copy.root, copy.ledger, recoveryEnv).state, 'ready')
    }
    const localRef = caseToken(cli(first.root, 'recall', ['copy_local_decision', '--cases'], recoveryEnv))
    assert.deepEqual(JSON.parse(cli(second.root, 'show', [localRef], recoveryEnv)), { state: 'denied' })

    const preReplayBytes = fs.readFileSync(stream)
    cli(first.root, 'replay')
    const afterReplay = fs.readFileSync(stream)
    assert.deepEqual(afterReplay.subarray(0, preReplayBytes.length), preReplayBytes)
    const added = afterReplay.subarray(preReplayBytes.length).toString('utf8').trim().split('\n').map(JSON.parse)
    assert.equal(added.length, 1)
    assert.equal(added[0].kind || added[0].type, 'artifact')
    assert.deepEqual([added[0].versions.before.sha256, added[0].versions.after.sha256], hashes.slice(0, 2))
    assert.match(cli(first.root, 'verify'), /ledger=OK/)
    if (dsh) {
      const state = JSON.parse(fs.readFileSync(path.join(first.ledger, 'state.json'), 'utf8'))
      assert.equal(state.streamBytes, afterReplay.length)
    }
    const replayed = fingerprint(first.ledger)
    cli(first.root, 'replay')
    assert.deepEqual(fingerprint(first.ledger), replayed)
    assert.deepEqual(checkOriginalRows(first.root), expectedRows)
    assert.equal(index(first.root, first.ledger, recoveryEnv).state, 'ready')
    assert.equal(caseToken(cli(first.root, 'recall', [cue, '--cases'], recoveryEnv)), originalCase)
    for (const [i, body] of [artifactBefore, artifactAfter, resultText].entries()) {
      assert.deepEqual(fs.readFileSync(path.join(first.ledger, 'blobs', hashes[i])), Buffer.from(body))
      assert.ok(cli(first.root, 'show', [hashes[i]]).includes(body))
    }

    for (const [name, mutate, error] of [
      ['missing-blob', folder => fs.unlinkSync(path.join(folder, 'blobs', hashes[0])), /MISSING_BLOB.*[a-f0-9]{64}/],
      ['missing-unreferenced-blob', folder => fs.unlinkSync(path.join(folder, 'blobs', orphan)), new RegExp(`MISSING_BLOB.*${orphan}`)],
      ['corrupt-blob', folder => fs.writeFileSync(path.join(folder, 'blobs', hashes[1]), 'wrong bytes'), /CORRUPT_BLOB.*[a-f0-9]{64}/],
      ['corrupt-stream', folder => {
        const file = path.join(folder, 'stream.jsonl')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('保留旧格式原文', '改动旧格式原文'))
      }, /CORRUPT_SNAPSHOT.*stream\.jsonl.*checkpointed bytes/],
      ['missing-checkpoint', folder => fs.unlinkSync(path.join(folder, 'integrity.json')), /CORRUPT_SNAPSHOT.*integrity\.json/],
      ['invalid-checkpoint-shape', folder => {
        const file = path.join(folder, 'integrity.json')
        const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'))
        checkpoint.files['stream.jsonl'] = { bytes: 'invalid', records: 0, sha256: sha256('') }
        fs.writeFileSync(file, JSON.stringify(checkpoint))
      }, /CORRUPT_SNAPSHOT.*integrity\.json/],
      ['uncheckpointed-tail', folder => fs.appendFileSync(path.join(folder, 'stream.jsonl'),
        JSON.stringify({ text: '尚未接纳的合成记录' }) + '\n'), /UNVERIFIED_SNAPSHOT.*PENDING/],
    ]) {
      await t.test(name, () => {
        const damaged = path.join(base, name)
        fs.cpSync(archive, damaged, { recursive: true })
        mutate(damaged)
        const before = fingerprint(damaged)
        const destinations = fs.readdirSync(output).sort()
        assert.match(restore(damaged, 1), error)
        assert.deepEqual(fs.readdirSync(output).sort(), destinations)
        assert.deepEqual(fingerprint(damaged), before)
      })
    }
    const insideSnapshot = run('agent-memory/restore-memory.mjs',
      ['--adapter', adapter, '--snapshot', archive, '--output', archive], { cwd: project, status: 1 })
    assert.match(insideSnapshot, /INVALID_OUTPUT/)
    if (process.platform === 'win32') {
      const aliasFolder = path.join(base, 'windows alias snapshot')
      fs.cpSync(archive, aliasFolder, { recursive: true })
      const file = path.join(aliasFolder, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      delete manifest.caseRoot
      manifest[dsh ? 'dir' : 'root'] = path.toNamespacedPath(retired)
      fs.writeFileSync(file, JSON.stringify(manifest))
      const insideSource = run('agent-memory/restore-memory.mjs',
        ['--adapter', adapter, '--snapshot', aliasFolder, '--output', retired], { cwd: project, status: 1 })
      assert.match(insideSource, /INVALID_OUTPUT/)
    }
    if (dsh) {
      await t.test('invalid-derived-state', () => {
        const damaged = path.join(base, 'damaged state')
        fs.cpSync(archive, damaged, { recursive: true })
        const file = path.join(damaged, 'state.json')
        const state = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({ ...state, episodes: { length: 1 } }))
        assert.match(restore(damaged, 1), /CORRUPT_SNAPSHOT.*state\.json/)
      })
    } else {
      await t.test('checkpointed-legacy-eof', () => {
        const input = path.join(base, 'legacy eof')
        fs.cpSync(archive, input, { recursive: true })
        const body = 'checkpointed_eof_decision'
        const file = path.join(input, 'stream.jsonl')
        fs.appendFileSync(file, JSON.stringify({ ws: project, kind: 'decision', id: 'legacy-eof', text: body }))
        createJournal(input).sync()
        const restored = JSON.parse(restore(input))
        const before = fs.readFileSync(path.join(restored.ledger, 'stream.jsonl'))
        const rebuilt = index(restored.root, restored.ledger, recoveryEnv)
        assert.equal(rebuilt.state, 'ready')
        assert.equal(rebuilt.pending, false)
        const ref = caseToken(cli(restored.root, 'recall', [body, '--cases'], recoveryEnv))
        assert.deepEqual(JSON.parse(cli(restored.root, 'show', [ref], recoveryEnv)), { state: 'exact', text: body })
        assert.deepEqual(fs.readFileSync(path.join(restored.ledger, 'stream.jsonl')), before)
      })
    }
    assert.deepEqual(fingerprint(archive), archiveBefore)
    assert.deepEqual(fingerprint(retired), sourceBefore)
    assert.equal(fs.existsSync(sourceRoot), false)
  })
}
