import { caseRef, key } from './memory-cards.mjs'

const TEST_PATH = /^[\w./-]+\.(?:c|m)?js$/
const SAFE_PATH = file => TEST_PATH.test(file || '') && !file.startsWith('/') && !file.split('/').includes('..')
const TEST_NAME = /^.{1,150}$/u
const GUARD = '历史资料，仅供核对。'
const line = value => String(value).replace(/[<>\r\n\u0000-\u001f\u007f]/g, char => JSON.stringify(char).slice(1, -1)
  .replace('<', '\\u003c').replace('>', '\\u003e'))

export function tapPath(tool, input) {
  if (!/^(?:(?:[\w-]+[._])?)(?:shell|bash|powershell)$/i.test(tool)) return null
  const match = /^node(?:\.exe)? --test(?: --test-reporter=tap)? ([\w./-]+)$/.exec(input?.command || '')
  return SAFE_PATH(match?.[1]) ? match[1] : null
}

export function testObservation(input, output, beforeHash, afterHash) {
  const path = tapPath('shell', input)
  const { content, exitCode } = output || {}
  if (!path || !/^[a-f0-9]{64}$/.test(beforeHash || '') || beforeHash !== afterHash
    || typeof content !== 'string' || content.length > 16000 || ![0, 1].includes(exitCode)) return null
  const normalized = content.replaceAll('\r\n', '\n')
  const tests = [...normalized.matchAll(/^(ok|not ok) 1 - (.+)$/gm)]
  if (tests.length !== 1 || !/^TAP version 13\n/.test(normalized) || !/^1\.\.1$/m.test(normalized)
    || !/^# tests 1$/m.test(normalized) || !/^# skipped 0$/m.test(normalized) || !/^# todo 0$/m.test(normalized)) return null
  const [, status, name] = tests[0]
  if (!TEST_NAME.test(name) || /\s#\s*(SKIP|TODO)\b/i.test(name)) return null
  const passed = status === 'ok' && exitCode === 0 && /^# pass 1$/m.test(normalized) && /^# fail 0$/m.test(normalized)
  const failed = status === 'not ok' && exitCode === 1 && /^# pass 0$/m.test(normalized)
    && /^# fail 1$/m.test(normalized) && /^\s+code: ['"]?ERR_ASSERTION['"]?\s*$/m.test(normalized)
  return passed || failed ? { path, name, passed, sha: beforeHash } : null
}

export function testCue(event) {
  if (!/^(?:[\w-]+[._])?(?:grep|rg|read)$/i.test(event.tool) || event.status !== 'completed') return []
  const text = typeof event.result === 'string' ? event.result : event.result?.content
  if (typeof text !== 'string') return []
  const found = new Set()
  const pattern = /^([\w./-]+):\d+:\s*(?:test|it)\((['"])([^'"\r\n]+)\2/gm
  for (const [, file, , name] of text.slice(0, 8192).matchAll(pattern)) {
    if (SAFE_PATH(file) && TEST_NAME.test(name)) found.add(key('test', file, name))
    if (found.size === 4) break
  }
  return [...found]
}

export function promptCue(text) {
  const match = String(text).slice(0, 1600).match(/`([\w./-]+\.(?:c|m)?js)`[^`\r\n]{0,24}`([^`\r\n]{1,150})`/u)
  return match && SAFE_PATH(match[1]) ? [key('test', match[1], match[2])] : []
}

export function buildHint(card, maxBytes) {
  if (card?.status !== 'verified' || !card.test || !card.evidence[2]) return null
  const ref = card.evidence[2]
  const message = `<memory-case>\n${GUARD}\n历史回归已通过：${line(card.test.name)}\n`
    + `适用范围：${line(card.test.path)} 中该测试覆盖的条件\n`
    + `证据：${caseRef(ref)}\n`
    + '先核对当前入口是否仍受该回归覆盖。\n</memory-case>'
  return Buffer.byteLength(message) + 2 <= maxBytes ? message : null
}
