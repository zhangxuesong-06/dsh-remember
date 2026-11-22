import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildMarketplace } from './install.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('Codex 钩子保留原文、会话和轮次，共享检索可回查，重试幂等', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, AGENT_MEMORY_HOME: root, CODEX_MEMORY_HOME: path.join(root, 'codex') }
  const market = buildMarketplace(path.join(root, 'marketplace'))
  const plugin = path.join(market, 'plugins', 'codex-memory')
  const run = (entry, args, payload) => {
    const result = spawnSync(process.execPath, [path.resolve(plugin, entry), ...args], {
      env, encoding: 'utf8', input: payload && JSON.stringify(payload),
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    return result.stdout
  }
  const common = { session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd: root }
  const prompt = { ...common, hook_event_name: 'UserPromptSubmit', prompt: '  如何核对合成标定记录？\n' }
  const clue = '光谱暗电流基准已校准'
  const stop = {
    ...common, hook_event_name: 'Stop',
    last_assistant_message: `${'演练背景。'.repeat(3600)}\n    ${clue}。\n    保留原文。  `,
  }
  for (const event of [prompt, prompt, { ...stop, last_assistant_message: null }, stop, stop]) {
    assert.deepEqual(JSON.parse(run('codex-memory/hook.mjs', [], event)), {})
  }
  const stream = path.join(root, 'codex', 'stream.jsonl')
  const rows = fs.readFileSync(stream, 'utf8').trimEnd().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map((row) => [row.who, row.turnID, row.text]), [
    ['user', common.turn_id, prompt.prompt], ['assistant', common.turn_id, stop.last_assistant_message],
  ])
  assert.equal(JSON.parse(run('agent-memory/recall.mjs', ['show', 'codex:2', '--json'])).text, stop.last_assistant_message)
  const compact = run('agent-memory/recall.mjs', ['recall', clue, '--rank', 'passage', '--compact'])
  const [quote] = JSON.parse(compact)
  assert.equal(quote.ref, 'codex:2')
  assert.ok(quote.text.includes(clue))
  assert.ok(Buffer.byteLength(compact) <= 3072)
  assert.deepEqual(JSON.parse(run('agent-memory/recall.mjs', [
    'show', quote.ref, '--range', `${quote.start}:${quote.end}`, '--json',
  ])), quote)
  const coverage = JSON.parse(run(path.join(here, '../agent-memory/coverage.mjs'), ['--source', 'codex', '--json']))
  assert.equal(coverage[0].answered, 1)
})
