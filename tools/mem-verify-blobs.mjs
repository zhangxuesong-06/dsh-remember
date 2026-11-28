import { readBlob } from './mem-artifacts.mjs'

export function verifyBlobs(root, rows) {
  const hashes = new Set()
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) hashes.add(value.sha256)
    for (const v of Object.values(value)) if (typeof v === 'object') visit(v)
  }
  rows.forEach(visit)
  const problems = []
  for (const hash of hashes) {
    try { readBlob(root, hash) } catch (error) { problems.push({ blob: hash, reason: error.message }) }
  }
  return { checked: hashes.size, problems }
}
