// 每条会话的跨进程状态：钩子一次一进程，锚指纹、已展示过的段、沉默闸计数得落盘。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS, diag } from './config.mjs'

const EMPTY = { titleWritten: false, shownIds: [], idleTurns: 0, lastCue: '', compacted: false }

function safeSid(sid) {
  return String(sid || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

export function sessPath(sid) {
  return join(SESSIONS, safeSid(sid) + '.json')
}

export function loadSession(sid) {
  try {
    const value = JSON.parse(readFileSync(sessPath(sid), 'utf8').replace(/^\uFEFF/, ''))
    if (value && typeof value === 'object') return { ...EMPTY, ...value }
  } catch {}
  return { ...EMPTY, shownIds: [] }
}

export function saveSession(sid, state) {
  try {
    mkdirSync(SESSIONS, { recursive: true })
    const file = sessPath(sid)
    const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, JSON.stringify({ ...EMPTY, ...state }), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) { diag('sessions 写失败：' + (e && e.message)); return false }
}
