import { createHash } from 'node:crypto'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const mode = () => ['auto', 'manual'].includes(process.env.MEMORY_CASE_RECALL) ? process.env.MEMORY_CASE_RECALL : 'off'
export const key = (...fields) => JSON.stringify(fields)
export const referenceScope = (ledger, project) => digest(key(ledger, project)).slice(0, 32)
export const caseRef = ref => `case:${ref.scope}:${ref.stream === 'tools' ? 't' : 's'}:${ref.offset.toString(36)}:${ref.bytes.toString(36)}:${Buffer.from(ref.hash, 'hex').toString('base64url')}`

function clip(text, bytes) {
  let result = ''
  let size = 0
  for (const char of String(text ?? '')) {
    size += Buffer.byteLength(char)
    if (size > bytes) return result + '…'
    result += char
  }
  return result
}

export function projectCard(kind, group, events) {
  const ordered = [...events].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
  const last = ordered.at(-1)
  if (!last) return null
  const card = { schemaVersion: 1, id: digest(key(last.project, kind, group)), kind, status: 'observed',
    changedAt: last.ts, summary: '', evidence: [], anchors: [], keys: [] }
  if (kind === 'tool') {
    const result = ordered.find(e => e.kind === 'result')
    if (!result) return null
    const calls = ordered.filter(e => e.kind === 'call')
    const call = calls.length === 1 ? calls[0] : null
    const { tool, phase, path, error } = result.data
    card.summary = clip(`${tool || '工具'} · ${phase === 'error' ? '报错' : phase === 'completed' ? '调用已返回' : '状态未知'}`
      + (path ? ` · ${path}` : '') + (error ? `\n${error}` : ''), 765)
    card.evidence = [result.ref, ...(call ? [call.ref] : [])]
    card.anchors = [...new Set([path, tool].filter(Boolean))]
    return card
  }
  if (kind !== 'case') {
    card.summary = clip(last.data.text, 765)
    card.evidence = [last.ref]
    return card
  }
  const request = ordered.find(e => e.kind === 'request')
  const episode = ordered.findLast(e => e.kind === 'episode')
  const tests = ordered.filter(e => e.kind === 'test')
  if (!request || (!episode && !tests.length && !request.data.unpaired)) return null
  card.session = request.sid
  card.turn = request.turn
  card.summary = clip(request.data.text, 765)
  card.evidence = [request.ref, ...(episode ? [episode.ref] : [])]
  const pass = tests.at(-1)
  const failure = pass?.data.passed && tests.findLast(e => e.ts < pass.ts && !e.data.passed
    && e.data.path === pass.data.path && e.data.name === pass.data.name && e.data.sha === pass.data.sha)
  if (!failure) return card
  const { path, name, symbol } = pass.data
  card.status = 'verified'
  card.test = { path, name, symbol, sha: pass.data.sha }
  card.anchors = [path, name, symbol].filter(Boolean)
  card.keys = [key('test', path, name)]
  card.evidence = [request.ref, failure.ref, pass.ref]
  return card
}

export function renderCards(result, limit = 3) {
  if (result.state !== 'ready') return JSON.stringify({ state: result.state, cards: [] })
  const selected = []
  for (const { keys, session, turn, ...entry } of result.cards.slice(0, Math.max(1, Math.min(5, Number(limit) || 3)))) {
    const card = { ...entry, evidence: entry.evidence.map(ref => ({ ref: caseRef(ref), coverage: ref.coverage })) }
    const candidate = JSON.stringify({ state: 'ready', cards: [...selected, card] })
    if (Buffer.byteLength(candidate) <= 3072) selected.push(card)
  }
  return JSON.stringify({ state: 'ready', cards: selected })
}
