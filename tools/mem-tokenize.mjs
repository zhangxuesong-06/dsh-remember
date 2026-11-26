// 原文召回分词，由 OpenCode 和跨库只读查询共享。
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
