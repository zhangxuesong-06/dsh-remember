// 工具调用的前后配对。
//
// ZCode 的 PreToolUse 和 PostToolUse 是两次独立进程，进程内的 Map 记不住任何事，
// 所以「调用前文件长什么样」必须落盘。键用 session + tool_use_id；6 小时后当废件清掉
// （用户中途关了会话、钩子崩了，都会留下只有 pre 没有 post 的条目）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { HOME, PENDING, diag } from './config.mjs'

const TTL = 6 * 60 * 60 * 1000

export function keyOf(sid, callId) {
  return `${sid || ''}|${callId || ''}`
}

export function readPending() {
  try {
    const value = JSON.parse(readFileSync(PENDING, 'utf8').replace(/^\uFEFF/, ''))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function writePending(map) {
  try {
    mkdirSync(HOME, { recursive: true })
    const now = Date.now()
    const clean = {}
    for (const [k, v] of Object.entries(map || {})) {
      if (v && typeof v.ts === 'number' && now - v.ts < TTL) clean[k] = v
    }
    const tmp = PENDING + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, JSON.stringify(clean), 'utf8')
    renameSync(tmp, PENDING)
    return true
  } catch (e) { diag('pending 写失败：' + (e && e.message)); return false }
}

export function putPending(sid, callId, value) {
  const map = readPending()
  map[keyOf(sid, callId)] = { ...value, ts: Date.now() }
  return writePending(map)
}

export function takePending(sid, callId) {
  const map = readPending()
  const key = keyOf(sid, callId)
  const value = map[key] || null
  if (value) { delete map[key]; writePending(map) }
  return value
}
