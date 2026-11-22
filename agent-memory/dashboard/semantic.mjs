import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const correction = /更正|纠正|勘误|撤回|不要|不得|切勿|禁止|\b(?:correction|erratum|retract|do not|don['’]t|must not|forbid|never)\b/iu
const real = /实车|真车|实际车辆|\b(?:real|physical) (?:vehicle|rover|robot)\b/iu
const simulated = /仿真|模拟运行|\b(?:simulator|simulation|simulated|gazebo)\b/iu
const direction = /(?:\bfrom\s+)?\b([a-z][\w]*)\s*(?:到|→|->|\bto\b)\s*([a-z][\w]*)\b/giu
const neighborLimit = 8
const minimumSimilarity = 0.78

function profile(record) {
  const text = record.text ?? ''
  return {
    record, correction: correction.test(text),
    real: real.test(text), simulated: simulated.test(text),
    directions: [...text.matchAll(direction)]
      .filter(([match, from, to]) => from.includes('_') || to.includes('_') || /[→]|->/.test(match))
      .map(([, from, to]) => [from.toLowerCase(), to.toLowerCase()]),
  }
}

function compatible(a, b) {
  const left = a.record
  const right = b.record
  if (left.ref === right.ref || left.kind === 'tool' || right.kind === 'tool') return false
  if (left.source === 'dsh' || right.source === 'dsh') {
    if (left.source !== right.source || !left.workspace || left.workspace !== right.workspace || left.store !== right.store) return false
  }
  if (a.correction || b.correction) return false
  if ((a.real && b.simulated) || (a.simulated && b.real)) return false
  return !a.directions.some(([from, to]) => b.directions.some(([start, end]) => from !== to && from === end && to === start))
}

export function cosine(left, right) {
  let dot = 0
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i]
  return Math.max(-1, Math.min(1, dot))
}

export function rankNeighbors(anchor, vector, records, vectors, profiles = records.map(profile), threshold = minimumSimilarity) {
  if (!vector) return []
  const origin = profile(anchor)
  const results = []
  for (const [index, candidate] of profiles.entries()) {
    if (!vectors[index] || !compatible(origin, candidate)) continue
    const score = cosine(vector, vectors[index])
    if (score >= threshold) results.push({ ref: candidate.record.ref, score })
  }
  return results.sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : 1)).slice(0, neighborLimit)
}

function normalize(values, dimension) {
  if (values?.length !== dimension || !values.every(Number.isFinite)) throw new Error('语义模型返回了无效向量')
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0))
  if (!Number.isFinite(norm) || norm === 0) throw new Error('语义模型返回了无效向量长度')
  return Float32Array.from(values, value => value / norm)
}

export class EmbeddingCache {
  #queue = Promise.resolve()
  #model
  #vectors = new Map()
  #directory
  constructor(model, cacheDir) {
    this.#model = model
    this.#directory = cacheDir && path.join(cacheDir, model.fingerprint)
  }

  get threshold() { return this.#model.threshold ?? minimumSimilarity }

  async #read(key) {
    if (!this.#directory) return null
    const dimension = this.#model.dimension
    try {
      const bytes = await fs.readFile(path.join(this.#directory, key + '.bin'))
      if (bytes.length !== dimension * 4) return null
      const values = Float32Array.from({ length: dimension }, (_, i) => bytes.readFloatLE(i * 4))
      const normSquared = values.reduce((sum, value) => sum + value ** 2, 0)
      return Math.abs(normSquared - 1) < 1e-4 ? values : null
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }

  async #write(key, vector) {
    if (!this.#directory) return
    const file = path.join(this.#directory, key + '.bin')
    const temporary = file + '.' + randomUUID() + '.tmp'
    const bytes = Buffer.alloc(vector.length * 4)
    vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
    try {
      await fs.writeFile(temporary, bytes, { mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  embed(texts) {
    const task = this.#queue.then(async () => {
      const keys = texts.map(text => createHash('sha256').update(text, 'utf16le').digest('hex'))
      const missing = new Map()
      keys.forEach((key, index) => {
        if (!this.#vectors.has(key)) missing.set(key, texts[index])
      })
      if (this.#directory) await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 })
      const entries = [...missing]
      for (let offset = 0; offset < entries.length; offset += 16) {
        const batch = entries.slice(offset, offset + 16)
        const saved = await Promise.all(batch.map(([key]) => this.#read(key)))
        const uncomputed = batch.filter((_, index) => !saved[index])
        if (uncomputed.length) {
          const computed = await this.#model.embed(uncomputed.map(([, text]) => text))
          if (computed.length !== uncomputed.length) throw new Error('语义模型返回了错误的向量数量')
          await Promise.all(uncomputed.map(async ([key], index) => {
            const vector = normalize(computed[index], this.#model.dimension)
            await this.#write(key, vector)
            this.#vectors.set(key, vector)
          }))
        }
        batch.forEach(([key], index) => { if (saved[index]) this.#vectors.set(key, saved[index]) })
      }
      const vectors = keys.map(key => this.#vectors.get(key))
      // Entries removed from the latest snapshot can still be reused through the disk cache.
      if (keys.length > 16) this.#vectors = new Map(keys.map((key, index) => [key, vectors[index]]))
      return vectors
    })
    this.#queue = task.catch(() => {})
    return task
  }
}

export async function buildSemanticIndex(records, cache) {
  const profiles = records.filter(record => record.kind !== 'tool' && record.text?.trim()).map(profile)
    .filter(item => !item.correction)
  const candidates = profiles.map(item => item.record)
  const vectors = await cache.embed(candidates.map(record => record.text))
  const indexes = new Map(candidates.map((record, index) => [record.ref, index]))
  return ref => {
    const index = indexes.get(ref)
    return index === undefined ? [] : rankNeighbors(candidates[index], vectors[index], candidates, vectors, profiles, cache.threshold)
  }
}
