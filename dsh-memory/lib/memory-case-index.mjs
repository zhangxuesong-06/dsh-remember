import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { debuglog } from 'node:util'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tokenize } from './tokenize.mjs'
import { digest, key, projectCard, mode, referenceScope, renderCards } from './memory-cards.mjs'

const require = createRequire(import.meta.url)
const debug = debuglog('memory-cases')
const BATCH = 1024 * 1024
const VERSION = 3
const CARD_ROWID_SPAN = 2 ** 40
export const RESTORE_ORIGIN_FILE = 'restore-origin.json'
const unavailable = () => ({ state: 'unavailable', cards: [] })
const stale = () => ({ state: 'stale', cards: [] })
const real = value => fs.realpathSync.native(value)

export function caseProject(cwd) {
  const origin = real(cwd)
  for (let dir = origin; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    if (path.dirname(dir) === dir) return origin
  }
}

export function caseSource(adapter, root, cwd, { singleProject = false, checkpointed = false } = {}) {
  const origin = restoreOrigin(adapter, root)
  let project
  try {
    if (singleProject) project = origin?.originalRoot || real(root)
    else if (cwd && path.isAbsolute(cwd)) project = caseProject(cwd)
  } catch {}
  const streams = adapter === 'opencode' ? ['stream', 'tools'] : ['stream']
  return { adapter, root, project, singleProject, streams, checkpointed, origin }
}

function restoreOrigin(adapter, root) {
  if (process.env.MEMORY_CASE_RESTORE !== '1' || !['opencode', 'dsh'].includes(adapter)) return null
  try {
    const file = path.join(root, RESTORE_ORIGIN_FILE)
    if (!fs.lstatSync(file).isFile()) return null
    const origin = JSON.parse(fs.readFileSync(file, 'utf8'))
    const valid = stream => Number.isSafeInteger(origin.streamBytes?.[stream]) && origin.streamBytes[stream] >= 0
    if (origin?.adapter === adapter && typeof origin.originalRoot === 'string' && path.isAbsolute(origin.originalRoot)
      && valid('stream') && (adapter !== 'opencode' || valid('tools'))) return origin
  } catch {}
  return null
}

function sourceRoot(source) {
  return real(source.root)
}

function scopeAt(source, project, stream, end, root) {
  const origin = source.origin
  if (origin && end <= origin.streamBytes[stream]) {
    return referenceScope(digest(key(source.adapter, origin.originalRoot)), project)
  }
  const localRoot = root || source.localRoot || sourceRoot(source)
  return referenceScope(source.ledger || digest(key(source.adapter, localRoot)), source.singleProject ? localRoot : project)
}

function restoredEnd(source, stream, offset) {
  return source.adapter === 'opencode' && source.origin?.streamBytes[stream] === offset
}

function open(source, readOnly) {
  const root = sourceRoot(source)
  const name = source.origin ? `r${VERSION}-${digest(key(source.origin)).slice(0, 12)}.sqlite` : `memory-cases-${source.adapter}-v${VERSION}.sqlite`
  const file = path.join(root, name)
  if (fs.existsSync(file) && real(file) !== file) throw new Error('Index path redirected')
  const db = process.versions.bun
    ? new (require('bun:sqlite').Database)(file, { readonly: readOnly })
    : new (require('node:sqlite').DatabaseSync)(file, { readOnly })
  db.exec('PRAGMA busy_timeout=0')
  return db
}

function streamFile(source, stream) {
  if (!source.streams.includes(stream)) throw new Error('Unknown source stream')
  const file = path.join(sourceRoot(source), stream + '.jsonl')
  if (real(file) !== file) throw new Error('Source path redirected')
  return file
}

function read(fd, offset, bytes) {
  const buffer = Buffer.allocUnsafe(bytes)
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, bytes, offset))
}

function hashPrefix(fd, offset) {
  const hash = createHash('sha256')
  for (let start = 0; start < offset;) {
    const bytes = read(fd, start, Math.min(64 * 1024, offset - start))
    if (!bytes.length) throw new Error('Stale source')
    hash.update(bytes)
    start += bytes.length
  }
  return hash
}

function statID(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` }

function scopeOf(source, row) {
  if (source.singleProject) return source.project
  const workspace = row.workspace ?? row.ws
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return null
  if (source.projects?.has(workspace)) return source.projects.get(workspace)
  let project = null
  try { project = caseProject(workspace) } catch {}
  if (source.projects && source.projects.size < 128) source.projects.set(workspace, project)
  return project
}

function mapRow(source, row, stream, offset, hash, bytes) {
  const project = scopeOf(source, row)
  if (!project) return null
  const sid = row.sid || ''
  const turn = row.turnID ?? row.turn
  const type = row.kind || row.type
  const id = String(row.id || row.eventKey || row.seq || `${offset}:${hash}`)
  const ref = { scope: scopeAt(source, project, stream, offset + bytes), stream, id,
    field: 'text', coverage: row.coverage === 'sample' || row.completion === 'preview' ? 'sample' : 'full', hash, offset, bytes }
  const event = { project, sid, turn: turn == null ? null : String(turn), id, ref, ts: Number(row.ts) || 0 }
  if (stream === 'tools' || type === 'tool/call' || type === 'tool/result') {
    const phase = row.phase || row.status
    const kind = phase === 'call' || type === 'tool/call' ? 'call' : 'result'
    const evidence = (kind === 'call' ? row.input : row.output) || row.evidence
    if (evidence?.sha256) Object.assign(ref, { field: 'blob', sha256: evidence.sha256 })
    else ref.coverage = 'sample'
    return { ...event, kind, data: { call: row.callID || row.callId, origin: row.callEventID, tool: row.tool,
      phase, path: row.files?.[0]?.path, error: row.error, test: source.adapter === 'opencode' ? row.caseTest : null } }
  }
  if (type === 'episode') return { ...event, kind: 'episode', data: {} }
  if (['decision', 'constraint', 'correction', 'withdrawal'].includes(type)) {
    return { ...event, kind: type === 'withdrawal' ? 'correction' : type, data: { text: row.text, supersedes: row.supersedes } }
  }
  if (row.who === 'user' || row.who === 'he') {
    if (row.source?.type === 'derived.observation') return null
    const request = { ...event, kind: 'request', data: { text: row.text } }
    if (sid && turn != null) return request
    if (sid && ['user/message', 'hook.user_prompt'].includes(row.source?.type)) {
      return { ...request, turn: key('unpaired-user', id), data: { text: row.text, unpaired: true } }
    }
  }
  if (source.adapter !== 'opencode' && ['assistant', 'me'].includes(row.who) && sid && turn != null) {
    return { ...event, kind: 'episode', data: {} }
  }
  return null
}

const terms = text => [...new Set(tokenize(String(text).slice(0, 2048)))].slice(0, 64)
const encoded = word => 'x' + Buffer.from(word).toString('hex')
const projectTerm = project => 'p' + digest(project).slice(0, 32)

function saveCard(prepare, project, card) {
  if (!card) return
  const suppressed = prepare('SELECT 1 FROM corrections WHERE project=? AND id=?').get(project, card.id)
  if (suppressed) {
    card.status = 'superseded'
    card.keys = []
  }
  const words = terms(`${card.summary} ${card.anchors.join(' ')}`)
  const { rowid, fts_id } = prepare(`INSERT INTO cards(id,project,card) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET card=excluded.card RETURNING rowid,fts_id`)
    .get(card.id, project, JSON.stringify(card))
  if (rowid >= CARD_ROWID_SPAN) throw new Error('Case index rowid exceeds its range')
  const ftsID = words.length * CARD_ROWID_SPAN + rowid
  if (fts_id !== null) prepare('DELETE FROM card_fts WHERE rowid=?').run(fts_id)
  prepare('INSERT INTO card_fts(rowid,project,terms) VALUES (?,?,?)').run(ftsID, projectTerm(project), words.map(encoded).join(' '))
  prepare('UPDATE cards SET fts_id=? WHERE rowid=?').run(ftsID, rowid)
  prepare('DELETE FROM auto_keys WHERE project=? AND id=?').run(project, card.id)
  const auto = prepare('INSERT INTO auto_keys VALUES (?,?,?)')
  for (const value of card.keys) auto.run(project, value, card.id)
}

function applyRow(prepare, event) {
  if (!event) return
  const project = event.project
  const { kind, id, sid, turn, data } = event
  if (kind === 'decision' || kind === 'constraint' || kind === 'correction') {
    if (kind === 'correction' && typeof data.supersedes === 'string') {
      prepare('INSERT OR IGNORE INTO corrections VALUES (?,?)').run(project, data.supersedes)
      const old = prepare('SELECT card FROM cards WHERE id=? AND project=?').get(data.supersedes, project)
      if (old) saveCard(prepare, project, JSON.parse(old.card))
    }
    saveCard(prepare, project, projectCard(kind, id, [event]))
    return
  }
  const put = prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)')
  const values = prepare('SELECT event FROM events WHERE project=? AND group_id=? ORDER BY ts DESC, id DESC LIMIT 65')
  const groupEvents = group => values.all(project, group).map(row => JSON.parse(row.event))
  if (kind === 'call' || kind === 'result') {
    const group = key('tool', sid, sid && data.call ? data.call : id)
    put.run(project, group, id, event.ts, JSON.stringify(event))
    const events = groupEvents(group)
    if (events.length <= 64) {
      const results = events.filter(row => row.kind === 'result')
      const calls = events.filter(row => row.kind === 'call')
      for (const result of results) {
        const matching = result.data.origin ? calls.filter(call => call.id === result.data.origin) : calls
        saveCard(prepare, project, projectCard('tool', result.id, [...matching, result]))
      }
    }
    if (!data.test || kind !== 'result') return
    event = { ...event, kind: 'test', data: data.test }
  }
  if (!sid || turn == null) return
  const group = key('case', sid, turn)
  const { kind: eventKind } = event
  if (!['request', 'episode', 'test'].includes(eventKind)) return
  if (event.kind === 'request' && typeof event.data.text === 'string') {
    event.data.text = event.data.text.slice(0, 2048)
  }
  put.run(project, group, id, event.ts, JSON.stringify(event))
  const events = groupEvents(group)
  if (events.length > 64) {
    const previous = prepare('SELECT card FROM cards WHERE id=? AND project=?').get(digest(key(project, 'case', group)), project)
    if (previous) {
      const card = JSON.parse(previous.card)
      if (card.status === 'verified') {
        const { test, ...observed } = card
        saveCard(prepare, project, { ...observed, status: 'observed', keys: [], evidence: card.evidence.slice(0, 1) })
      }
    }
    return
  }
  saveCard(prepare, project, projectCard('case', group, events))
}

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursors (stream TEXT PRIMARY KEY, identity TEXT, offset INTEGER,
      size INTEGER, mtime REAL, ctime REAL, prefix TEXT, skipping INTEGER, gaps INTEGER);
    CREATE TABLE IF NOT EXISTS events (project TEXT, group_id TEXT, id TEXT, ts INTEGER, event TEXT,
      PRIMARY KEY(project,group_id,id));
    CREATE INDEX IF NOT EXISTS events_recent ON events(project,group_id,ts DESC,id DESC);
    CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, project TEXT, card TEXT, fts_id INTEGER);
    CREATE TABLE IF NOT EXISTS corrections (project TEXT, id TEXT, PRIMARY KEY(project,id));
    CREATE TABLE IF NOT EXISTS auto_keys (project TEXT, key TEXT, id TEXT, PRIMARY KEY(project,key,id)) WITHOUT ROWID;
    CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(project, terms);
  `)
}

function syncStream(source, prepare, stream, budget) {
  let fd
  try { fd = fs.openSync(streamFile(source, stream), 'r') } catch (error) {
    if (error.code === 'ENOENT' && !prepare('SELECT 1 FROM cursors WHERE stream=?').get(stream)) return { used: 0, pending: false }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    const prior = prepare('SELECT * FROM cursors WHERE stream=?').get(stream)
    let offset = prior?.offset || 0
    let skipping = prior?.skipping || 0
    let gaps = prior?.gaps || 0
    if (prior && (prior.identity !== statID(stat) || stat.size < prior.size
      || (stat.size === prior.size && (stat.mtimeMs !== prior.mtime || stat.ctimeMs !== prior.ctime)))) throw new Error('Stale source')
    if (stat.size === offset || budget === 0) return { used: 0, pending: stat.size > offset, gaps }
    const prefix = hashPrefix(fd, offset)
    if (prior && prefix.copy().digest('hex') !== prior.prefix) throw new Error('Stale source')
    const bytes = read(fd, offset, Math.min(stat.size - offset, budget))
    let start = 0
    const allowEnd = offset + bytes.length === stat.size && restoredEnd(source, stream, stat.size)
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      if (newline === -1 && !allowEnd) break
      const end = newline === -1 ? bytes.length : newline
      const rowBytes = bytes.subarray(start, end)
      if (!skipping && rowBytes.toString('utf8').trim()) {
        let row
        try { row = JSON.parse(rowBytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { gaps++ }
        if (row && typeof row === 'object') applyRow(prepare, mapRow(source, row, stream, offset + start, digest(rowBytes), rowBytes.length))
      }
      skipping = 0
      start = newline === -1 ? end : end + 1
    }
    if (start === 0 && (skipping || bytes.length === BATCH)) {
      if (!skipping) gaps++
      skipping = 1
      start = bytes.length
    }
    offset += start
    prefix.update(bytes.subarray(0, start))
    const current = fs.fstatSync(fd)
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) {
      throw new Error('Source changed during indexing')
    }
    prepare('INSERT OR REPLACE INTO cursors VALUES (?,?,?,?,?,?,?,?,?)')
      .run(stream, statID(stat), offset, stat.size, stat.mtimeMs, stat.ctimeMs, prefix.digest('hex'), skipping, gaps)
    return { used: bytes.length, progress: start, pending: stat.size > offset || !!skipping, gaps }
  } finally { fs.closeSync(fd) }
}

export function syncCaseIndex(source, { rebuild = false } = {}) {
  let db
  try {
    const localRoot = sourceRoot(source)
    source = { ...source, localRoot, projects: new Map(), ledger: digest(key(source.adapter, localRoot)) }
    db = open(source, false)
    db.exec('BEGIN IMMEDIATE')
    initialize(db)
    const statements = new Map()
    const prepare = sql => {
      if (!statements.has(sql)) statements.set(sql, db.prepare(sql))
      return statements.get(sql)
    }
    if (rebuild) db.exec('DELETE FROM cursors; DELETE FROM events; DELETE FROM cards; DELETE FROM corrections; DELETE FROM auto_keys; DELETE FROM card_fts')
    let budget = BATCH
    let pending = false
    let gaps = 0
    let consumed = 0
    let progress = 0
    for (const stream of source.streams) {
      let result
      do {
        result = syncStream(source, prepare, stream, budget)
        consumed += result.used
        progress += result.progress || 0
        if (!rebuild) budget -= result.used
        else if (result.pending && !result.progress) throw new Error('Incomplete source during rebuild')
      } while (rebuild && result.pending && result.progress)
      pending ||= result.pending
      gaps += result.gaps || 0
    }
    db.exec('COMMIT')
    return { state: 'ready', pending, gaps, consumed, progress }
  } catch (error) {
    debug('sync failed: %s', error.message)
    return { state: error.message === 'Stale source' || error.code === 'ENOENT' ? 'stale' : 'unavailable' }
  } finally { db?.close() }
}

export function caseWatermark(source) {
  return Object.fromEntries(source.streams.map(stream => {
    try { return [stream, fs.statSync(streamFile(source, stream)).size] }
    catch (error) { return [stream, error.code === 'ENOENT' ? 0 : Infinity] }
  }))
}

function fresh(source, db, watermark, current) {
  const checkpoint = watermark && source.checkpointed
    ? JSON.parse(fs.readFileSync(path.join(sourceRoot(source), 'integrity.json'), 'utf8')).files : null
  for (const stream of source.streams) {
    const prior = db.prepare('SELECT * FROM cursors WHERE stream=?').get(stream)
    if (watermark && ((prior?.offset || 0) < watermark[stream] || prior?.gaps)) return false
    let fd
    try {
      fd = fs.openSync(streamFile(source, stream), 'r')
      const stat = fs.fstatSync(fd)
      if (prior && (statID(stat) !== prior.identity || stat.size < prior.size
        || (stat.size === prior.size && (stat.mtimeMs !== prior.mtime || stat.ctimeMs !== prior.ctime)))) return false
      if (!watermark && stat.size > (prior?.size || 0)) return false
      if (checkpoint && stat.size) {
        const saved = checkpoint[stream + '.jsonl']
        if (saved?.bytes !== stat.size || saved.identity !== statID(stat)
          || saved.mtime !== stat.mtimeMs || saved.ctime !== stat.ctimeMs) return false
      }
      if (watermark && stat.size > (prior?.offset || 0)) {
        const offset = prior?.offset || 0
        if (stat.size - offset > 16 * 1024) return false
        const tail = read(fd, offset, stat.size - offset)
        if (tail.at(-1) !== 10) return false
        for (const line of tail.toString('utf8').split('\n')) {
          if (!line.trim()) continue
          const row = JSON.parse(line)
          if (['correction', 'withdrawal'].includes(row.kind || row.type)) return false
          if (stream === 'tools' && row.caseTest
            && (row.sid !== current?.sid || (row.turnID ?? row.turn) !== current?.turn)) return false
        }
      }
    } catch (error) {
      if (prior || error.code !== 'ENOENT') return false
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  return true
}

export function searchCases(source, { cue = '', keys = [], watermark, current, limit = 8 } = {}) {
  if (!source.project) return unavailable()
  const count = Math.max(1, Math.min(8, Number(limit) || 8))
  let db
  try {
    db = open(source, true)
    if (!fresh(source, db, watermark, current)) return stale()
    if (watermark) {
      const lookup = db.prepare('SELECT id FROM auto_keys WHERE project=? AND key=? LIMIT 9')
      const ids = new Set(keys.slice(0, 4).flatMap(value => lookup.all(source.project, value).map(row => row.id)))
      if (ids.size > 8) return { state: 'ready', cards: [] }
      const get = db.prepare('SELECT card FROM cards WHERE project=? AND id=?')
      return { state: 'ready', cards: [...ids].map(id => JSON.parse(get.get(source.project, id).card)) }
    }
    let words = terms(cue).slice(0, 16).map(encoded)
    const project = projectTerm(source.project)
    const match = expression => `project:${project} AND terms:(${expression})`
    const byLength = 'FROM card_fts WHERE card_fts MATCH ? ORDER BY rowid LIMIT ?'
    // A term with no scoped hit contributes zero to SQLite's BM25 for this project.
    // Check it only when the full match cannot fill the requested result count.
    let cutoff
    let nth
    if (words.length > 1) {
      db.exec('BEGIN')
      nth = db.prepare(`SELECT rowid ${byLength} OFFSET ?`)
      cutoff = nth.get(match(words.join(' AND ')), 1, count - 1)
      if (!cutoff) {
        const present = words.filter(word => nth.get(match(word), 1, 0))
        if (present.length > 1 && present.length < words.length) {
          cutoff = nth.get(match(present.join(' AND ')), 1, count - 1)
        }
        words = present
      }
    }
    if (!words.length) return { state: 'ready', cards: [] }
    const score = 'SELECT rowid, bm25(card_fts) AS score FROM card_fts WHERE card_fts MATCH ?'
    const rank = `score, rowid % ${CARD_ROWID_SPAN}`
    let hits = `SELECT rowid, rowid AS score ${byLength}`
    const any = match(words.join(' OR '))
    let args = [any, count]
    if (words.length > 1) {
      const full = match(words.join(' AND '))
      if (words.length <= 4 && !cutoff) {
        let matches
        if (words.length === 2) {
          const [a, b] = words
          matches = [full, match(`${a} NOT ${b}`), match(`${b} NOT ${a}`)]
        } else {
          // A top-N card is among the N shortest hits for all of its matching
          // terms. Cards shorter than it with those terms already outrank it.
          const groups = new Set()
          const shortest = db.prepare(`SELECT terms ${byLength}`)
          for (let mask = 1; mask < (1 << words.length); mask++) {
            const bits = mask.toString(2).split('0').join('').length
            if (bits > 2) continue
            const subset = words.filter((_, index) => mask & (1 << index))
            for (const { terms: text } of shortest.all(match(subset.join(' AND ')), count)) {
              const present = text.split(' ')
              groups.add(match(words.filter(word => present.includes(word)).join(' AND ')))
            }
          }
          if (!groups.size) return { state: 'ready', cards: [] }
          matches = [...groups]
        }
        // BM25 for a subset only weakens a card's score. Keep its best score
        // if it appears in more than one group.
        const group = `SELECT * FROM (${score} ORDER BY rowid LIMIT ?)`
        hits = `SELECT rowid, min(score) AS score FROM (${matches.map(() => group).join(' UNION ALL ')})
          GROUP BY rowid ORDER BY ${rank} LIMIT ?`
        args = [...matches.flatMap(expression => [expression, count]), count]
      } else if (!cutoff || nth.get(any, 1, count - 1).rowid !== cutoff.rowid) {
        // The Nth full match caps the candidates. Matching boundaries need no scoring.
        hits = `${score}${cutoff ? ' AND rowid<=?' : ''} ORDER BY ${rank} LIMIT ?`
        args = [any, ...(cutoff ? [cutoff.rowid] : []), count]
      }
    }
    const rows = db.prepare(`SELECT cards.card FROM (${hits}) AS hits
      JOIN cards ON cards.rowid=hits.rowid % ${CARD_ROWID_SPAN} AND cards.project=?
      ORDER BY hits.score, hits.rowid % ${CARD_ROWID_SPAN}`).all(...args, source.project)
    return { state: 'ready', cards: rows.map(row => JSON.parse(row.card)) }
  } catch { return unavailable() }
  finally { db?.close() }
}

export function readEvidence(source, ref, range) {
  if (!source.project || !ref || !source.streams.includes(ref.stream)
    || !Number.isSafeInteger(ref.offset) || ref.offset < 0) return { state: 'denied' }
  let fd
  try {
    const root = sourceRoot(source)
    const size = ref.bytes
    if (!Number.isSafeInteger(size) || size < 1 || size >= BATCH) return { state: 'missing' }
    const end = ref.offset + size
    if (ref.scope !== scopeAt(source, source.project, ref.stream, end, root)) return { state: 'denied' }
    fd = fs.openSync(streamFile(source, ref.stream), 'r')
    if (ref.offset && read(fd, ref.offset - 1, 1)[0] !== 10) return { state: 'corrupt' }
    const bytes = read(fd, ref.offset, size + 1)
    const atRestoredEnd = bytes.length === size && restoredEnd(source, ref.stream, end)
    if (!atRestoredEnd && (bytes.length !== size + 1 || bytes[size] !== 10)) return { state: 'missing' }
    const line = bytes.subarray(0, size)
    const row = JSON.parse(line.toString('utf8').replace(/^\uFEFF/, ''))
    if (scopeOf(source, row) !== source.project) return { state: 'denied' }
    if (digest(line) !== ref.hash) return { state: 'corrupt' }
    const event = mapRow(source, row, ref.stream, ref.offset, ref.hash, size)
    if (!event || ref.id !== undefined && (event.id !== ref.id || event.ref.sha256 !== ref.sha256
      || event.ref.field !== ref.field)) return { state: 'corrupt' }
    let text
    const { field, sha256 } = event.ref
    if (field === 'blob') {
      if (!/^[a-f0-9]{64}$/.test(sha256)) return { state: 'corrupt' }
      const file = path.join(root, 'blobs', sha256)
      if (real(file) !== file || fs.statSync(file).size > BATCH) return { state: 'missing' }
      const blob = fs.readFileSync(file)
      if (digest(blob) !== sha256) return { state: 'corrupt' }
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob) }
      catch { return { state: 'missing' } }
    } else {
      text = row.text
    }
    if (typeof text !== 'string') return { state: 'missing' }
    if (range) {
      const [start, stop] = range
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop <= start || stop > text.length
        || [start, stop].some(i => /[\uDC00-\uDFFF]/.test(text[i] || ''))) return { state: 'missing' }
      text = text.slice(start, stop)
    }
    return { state: event.ref.coverage === 'sample' ? 'sample' : 'exact', text }
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'corrupt' }
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function readCaseRef(source, value, range) {
  const token = typeof value === 'string' && /^case:([a-f0-9]{32}):([st]):([a-z0-9]{1,11}):([a-z0-9]{1,4}):([\w-]{43})$/.exec(value)
  if (!source.project || !token) return { state: 'denied' }
  const [, scope, stream, offset, bytes, hash] = token
  const ref = { scope, stream: stream === 't' ? 'tools' : 'stream', offset: parseInt(offset, 36), bytes: parseInt(bytes, 36),
    hash: Buffer.from(hash, 'base64url').toString('hex') }
  const match = typeof range === 'string' && range.match(/^(\d+):(\d+)$/)
  if (range !== undefined && !match) return { state: 'denied' }
  const result = readEvidence(source, ref, match ? [Number(match[1]), Number(match[2])] : undefined)
  if (match || !result.text || result.text.length <= 12000) return result
  const boundary = offset => offset - Number(/[\uDC00-\uDFFF]/.test(result.text[offset] || ''))
  const end = boundary(12000)
  return { ...result, text: result.text.slice(0, end),
    next: `${end}:${boundary(Math.min(end + 12000, result.text.length))}`, total: result.text.length }
}

export function runCaseSync(source, rebuild = false, batches = 8) {
  let result
  for (let i = 0; i < batches; i++) {
    result = syncCaseIndex(source, { rebuild: rebuild && i === 0 })
    if (!result.pending || !result.progress) break
  }
  return result
}

export function caseResult(source, cue, limit) {
  return renderCards(mode() === 'off' ? { state: 'unavailable' } : searchCases(source, { cue }), limit)
}

export function caseRead(source, ref, range) {
  return JSON.stringify(mode() === 'off' ? { state: 'denied' } : readCaseRef(source, ref, range))
}

export function caseCommand(source, command, args) {
  if (command === 'recall' && args.includes('--cases')) return caseResult(source, args.filter(arg => arg !== '--cases').join(' '))
  if (['read', 'show'].includes(command) && args[0]?.startsWith('case:')) {
    const range = args.indexOf('--range')
    return caseRead(source, args[0], range < 0 ? undefined : args[range + 1] ?? '')
  }
  if (command === 'case-index-sync' || command === 'case-index-rebuild') {
    const result = runCaseSync(source, command === 'case-index-rebuild')
    if (result.state !== 'ready') process.exitCode = 1
    return JSON.stringify(result)
  }
  return null
}

export function startCaseSync(adapter, root) {
  if (mode() === 'off' || process.env.MEMORY_DISABLE_MAINTENANCE === '1') return
  const node = /[\\/]node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : process.env.OPENCODE_NODE || 'node'
  const child = spawn(node, [fileURLToPath(import.meta.url), '--sync', adapter, root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.on('error', error => debug('worker: %s', error.message))
  child.unref()
  return child
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === '--sync') {
  const [, , , adapter, root] = process.argv
  if (['opencode', 'dsh', 'workbuddy', 'zcode', 'codex'].includes(adapter) && root && path.isAbsolute(root)) {
    runCaseSync(caseSource(adapter, root, undefined, { singleProject: adapter === 'dsh' }))
  }
}
