import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EmbeddingCache, rankNeighbors } from './semantic.mjs'

test('cache deduplicates exact text across records and restarts, scoped to model bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-semantic-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const model = { fingerprint: 'a'.repeat(64), dimension: 2, embed: async texts => {
    calls.push(texts)
    return texts.map(() => [3, 4])
  } }
  const cache = new EmbeddingCache(model, dir)
  const [a, b] = await Promise.all([cache.embed(['same', 'same']), cache.embed(['same', 'same\n'])])
  assert.deepEqual(a[0], a[1])
  assert.deepEqual(a[1], b[0])
  assert.deepEqual(calls.flat(), ['same', 'same\n'])
  assert.deepEqual((await new EmbeddingCache(model, dir).embed(['same']))[0], a[0])
  const file = createHash('sha256').update('same', 'utf16le').digest('hex') + '.bin'
  assert.match(file, /^[a-f0-9]{64}\.bin$/)
  await fs.writeFile(path.join(dir, model.fingerprint, file), 'corrupt')
  const cacheAfterCorruption = new EmbeddingCache(model, dir)
  await cacheAfterCorruption.embed(['same', 'same\n'])
  assert.equal(calls.flat().length, 3)
  await new EmbeddingCache({ ...model, fingerprint: 'b'.repeat(64) }, dir).embed(['same'])
  assert.equal(calls.flat().length, 4)
})

test('same cosine cannot override identity, corrections, opposite scope, direction or tool exclusions', () => {
  const make = (ref, text, extra = {}) => ({ ref, text, source: 'dsh', workspace: 'alpha', store: 'one', kind: 'message', ...extra })
  const records = [
    make('a', '实车 lidar_frame 到 base_frame 的变换'),
    make('b', '实际车辆的雷达转换到基座坐标'),
    make('c', '更正：实车 lidar_frame 到 base_frame 的变换'),
    make('d', '仿真 lidar_frame 到 base_frame 的变换'),
    make('e', '实车 base_frame 到 lidar_frame 的变换'),
    make('f', '实车 lidar_frame 到 base_frame 的变换', { workspace: 'beta', store: 'two' }),
    make('g', '实车 lidar_frame 到 base_frame 的变换', { workspace: '' }),
    make('h', '实车 lidar_frame 到 base_frame 的变换', { source: 'codex' }),
    make('i', '实车 lidar_frame 到 base_frame 的变换', { kind: 'tool' }),
  ]
  const vectors = records.map(() => [1, 0])
  assert.deepEqual(rankNeighbors(records[0], vectors[0], records, vectors), [{ ref: 'b', score: 1 }])
})



test('blocks reversed transforms when only one endpoint has an underscore', () => {
  const records = ['实车 lidar 到 base_link', '实车 base_link 到 lidar']
    .map((text, index) => ({ ref: `codex:${index + 1}`, kind: 'message', source: 'codex', text }))
  assert.deepEqual(rankNeighbors(records[0], [1, 0], records, [[1, 0], [1, 0]]), [])
})
