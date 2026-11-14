// 中文 bigram + 英文词。纯函数，无副作用。
//
// 单独成文件是为了让跨库只读查询能复用同一套分词，又不必 import mem-core——
// mem-core 初始化时会碰目录和锁，不属于“只读聚合”的范围。
const CJK = /[\u4e00-\u9fff]+/g
const LATIN = /[a-zA-Z][a-zA-Z0-9_.\-]*/g

export function tok(s) {
  const o = []
  for (const m of String(s).matchAll(CJK)) {
    const r = m[0]
    if (r.length === 1) o.push(r)
    else for (let i = 0; i + 1 < r.length; i++) o.push(r.slice(i, i + 2))
  }
  for (const m of String(s).matchAll(LATIN)) o.push(m[0].toLowerCase())
  return o
}
