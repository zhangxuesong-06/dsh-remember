import { tokenize } from './tokenize.mjs'

// 词频
export function termFreq(text) {
  const tf = new Map()
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

// 极简标题：不生成新句子，只从原话里挑一行最像「那件事叫什么」的。
export function headline(text, max = 30) {
  let s = String(text || '')
    .replace(/\[图×\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return '（没留下的话）'
  const pieces = s.split(/[。！？!?\n；;]/).map((x) => x.trim()).filter(Boolean)
  // 「先暂停」这种太短，不足以当标题，往后找一句像样的
  let pick = pieces.find((x) => x.length >= 8) || pieces[0] || s
  pick = pick.replace(/^(对了|另外|顺便|那|所以|然后)[，,]?/, '')
  return pick.length > max ? pick.slice(0, max) + '…' : pick
}

// 话题指纹：用来判断「是不是还在说同一件事」，好让注入的那几行别每轮都变
export function topicKey(text, n = 6) {
  const freq = new Map()
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map((x) => x[0])
    .sort()
    .join('|')
}
