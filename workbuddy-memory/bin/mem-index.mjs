// WorkBuddy 派生检索索引：SQLite FTS5 只做索引，stream.jsonl 仍是唯一真相。
// 索引缺失/损坏时调用方回退到原来的全量读取，不阻塞记录。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let DatabaseSync = null
try { ({ DatabaseSync } = require('node:sqlite')) } catch {}

const INDEX = (root) => path.join(root, 'index.db')
export function indexExists(root) {
  return !!DatabaseSync && fs.existsSync(INDEX(root))
}

export function indexFresh(root) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root))) return false
  const db = open(root)
  if (!db) return false
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='bytes'").get()
    const size = fs.statSync(path.join(root, 'stream.jsonl')).size
    return Number(row?.value || -1) === size
  } catch { return false } finally { db.close() }
}

export function indexBuiltAt(root) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root))) return 0
  const db = open(root)
  if (!db) return 0
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='builtAt'").get()
    return Number(row?.value || 0)
  } catch { return 0 } finally { db.close() }
}

function open(root) {
  if (!DatabaseSync) return null
  try {
    const db = new DatabaseSync(INDEX(root))
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=3000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY, ts INTEGER, who TEXT, ws TEXT, sid TEXT,
        type TEXT, tool TEXT, episode_id INTEGER, text TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(tokens, content='');
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY, from_line INTEGER, to_line INTEGER,
        start_ts INTEGER, end_ts INTEGER, turns INTEGER, chars INTEGER,
        sid TEXT, ws TEXT, title TEXT, salience REAL, emotion REAL, domain TEXT
      );
    `)
    return db
  } catch { return null }
}

function tokensOf(text, tokenize) {
  return [...new Set(tokenize(text))].slice(0, 200).join(' ')
}

export function buildIndex(root, store, tokenize) {
  if (!DatabaseSync) return { ok: false, reason: 'node:sqlite unavailable' }
  const db = open(root)
  if (!db) return { ok: false, reason: 'index open failed' }
  try {
    db.exec('BEGIN')
    db.exec('DELETE FROM docs; DELETE FROM episodes; DELETE FROM meta')
    db.exec(`DROP TABLE IF EXISTS docs_fts; CREATE VIRTUAL TABLE docs_fts USING fts5(tokens, content='')`)
    const insertDoc = db.prepare('INSERT INTO docs (id,ts,who,ws,sid,type,tool,episode_id,text) VALUES (?,?,?,?,?,?,?,?,?)')
    const insertFts = db.prepare('INSERT INTO docs_fts (rowid,tokens) VALUES (?,?)')
    const insertEp = db.prepare(`INSERT INTO episodes
      (id,from_line,to_line,start_ts,end_ts,turns,chars,sid,ws,title,salience,emotion,domain)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (let i = 0; i < store.docs.length; i++) {
      const d = store.docs[i]
      if (!d) continue
      const ep = store.episodeAt ? store.episodeAt(i) : null
      insertDoc.run(i, d.ts || 0, d.who || '', d.ws || '', d.sid || '', d.type || '', d.tool || '', ep ? ep.id : 0, String(d.text || ''))
      insertFts.run(i, tokensOf(d.text, tokenize))
    }
    for (const e of store.episodes || []) {
      insertEp.run(e.id, e.from, e.to, e.startTs, e.endTs, e.turns || 0, e.chars || 0,
        e.sid || '', e.ws || '', e.title || '', e.salience || 0, e.emotion || 0, e.domain || '')
    }
    const bytes = (() => { try { return fs.statSync(path.join(root, 'stream.jsonl')).size } catch { return 0 } })()
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('lines', String(store.docs.length))
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('bytes', String(bytes))
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('builtAt', String(Date.now()))
    db.exec('COMMIT')
    return { ok: true, docs: store.docs.length, episodes: (store.episodes || []).length, bytes }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    return { ok: false, reason: error.message }
  } finally { db.close() }
}

export function appendIndex(root, row, tokenize) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root))) return false
  if (fs.existsSync(path.join(root, '.index-building'))) return false
  const db = open(root)
  if (!db) return false
  try {
    const get = db.prepare('SELECT value FROM meta WHERE key=?')
    const lines = Number(get.get('lines')?.value || 0)
    const beforeBytes = Number(get.get('bytes')?.value || 0)
    const size = (() => { try { return fs.statSync(path.join(root, 'stream.jsonl')).size } catch { return 0 } })()
    const lineBytes = Buffer.byteLength(JSON.stringify(row) + '\n')
    // 索引和流必须只差这一行；多行/少行说明索引已过期，交给重建，不在这里猜。
    if (size - beforeBytes !== lineBytes && size - beforeBytes !== lineBytes + 1) return false
    const last = db.prepare('SELECT id FROM episodes ORDER BY id DESC LIMIT 1').get()
    const episodeId = last ? Number(last.id) : 0
    db.prepare('INSERT INTO docs (id,ts,who,ws,sid,type,tool,episode_id,text) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(lines, row.ts || 0, row.who || '', row.ws || '', row.sid || '', row.type || '', row.tool || '', episodeId, String(row.text || ''))
    db.prepare('INSERT INTO docs_fts (rowid,tokens) VALUES (?,?)').run(lines, tokensOf(row.text, tokenize))
    if (episodeId) {
      if (row.who === 'he' || row.who === 'me') {
        db.prepare('UPDATE episodes SET end_ts=?, turns=turns+1, chars=chars+? WHERE id=?')
          .run(row.ts || 0, String(row.text || '').length, episodeId)
      } else {
        db.prepare('UPDATE episodes SET end_ts=? WHERE id=?').run(row.ts || 0, episodeId)
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('lines', String(lines + 1))
    const bytes = (() => { try { return fs.statSync(path.join(root, 'stream.jsonl')).size } catch { return 0 } })()
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('bytes', String(bytes))
    return true
  } catch { return false } finally { db.close() }
}

function ftsQuery(cue, tokenize) {
  const terms = [...new Set(tokenize(cue))].slice(0, 32)
  if (!terms.length) return null
  return terms.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ')
}

export function searchIndex(root, cue, limit, tokenize) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root)) || !indexFresh(root)) return null
  const match = ftsQuery(cue, tokenize)
  if (!match) return []
  const db = open(root)
  if (!db) return null
  try {
    return db.prepare(`SELECT d.id,d.ts,d.who,d.ws,d.sid,d.type,d.tool,d.episode_id,d.text,bm25(docs_fts) AS rank
      FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid
      WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit)
  } catch { return null } finally { db.close() }
}

export function episodesByIds(root, ids) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root)) || !ids.length) return []
  const db = open(root)
  if (!db) return []
  try {
    const marks = ids.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM episodes WHERE id IN (${marks})`).all(...ids)
      .map((e) => ({
        id: e.id, from: e.from_line, to: e.to_line, startTs: e.start_ts, endTs: e.end_ts,
        turns: e.turns, chars: e.chars, sid: e.sid, ws: e.ws, title: e.title,
        salience: e.salience, emotion: e.emotion, domain: e.domain,
      }))
  } catch { return [] } finally { db.close() }
}

export function indexStore(root, limit = 8) {
  if (!DatabaseSync || !fs.existsSync(INDEX(root)) || !indexFresh(root)) return null
  const db = open(root)
  if (!db) return null
  try {
    const episodes = db.prepare('SELECT * FROM episodes ORDER BY end_ts DESC LIMIT ?').all(limit)
      .map((e) => ({
        id: e.id, from: e.from_line, to: e.to_line, startTs: e.start_ts, endTs: e.end_ts,
        turns: e.turns, chars: e.chars, sid: e.sid, ws: e.ws, title: e.title,
        salience: e.salience, emotion: e.emotion, domain: e.domain,
      }))
    const says = Number(db.prepare("SELECT COUNT(*) AS n FROM docs WHERE who IN ('he','me')").get()?.n || 0)
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM episodes').get()?.n || 0)
    const span = db.prepare('SELECT MIN(start_ts) AS first, MAX(end_ts) AS last FROM episodes').get() || {}
    return { episodes, says, episodeCount: count, firstTs: span.first, lastTs: span.last, marks: [], docs: [], _index: true }
  } catch { return null } finally { db.close() }
}
