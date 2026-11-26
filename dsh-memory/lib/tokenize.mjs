// 中文按字二元组，英文、数字和点分版本号按词。
const ASCII_RE = /[a-z0-9_]+(?:\.[a-z0-9_]+)*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

// 带 v 和不带 v 的版本号使用同一规范词。
function normTerm(w) {
  if (w.length > 1 && w[0] === 'v' && /^\d[\d.]*$/.test(w.slice(1))) return w.slice(1)
  return w
}

// 高频虚词二元组：检索上没有区分度，占着 postings 只会拖慢速度
const STOP = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这么', '那么', '什么', '怎么',
  '就是', '还是', '也是', '只是', '但是', '可是', '因为', '所以', '如果', '然后',
  '可以', '没有', '不是', '一个', '这样', '那样', '这些', '那些', '自己', '已经',
  '现在', '时候', '一下', '一点', '应该', '需要', '可能', '觉得', '知道', '东西',
  '而且', '或者', '不过', '其实', '真的', '比较', '非常', '一定', '一样', '这里',
  '那里', '为什', '么样', '对的', '好的', '嗯嗯', '哈哈',
])

export function tokenize(text) {
  const out = []
  if (!text) return out
  const s = String(text).normalize('NFKC').toLowerCase()

  for (const m of s.matchAll(ASCII_RE)) {
    const w = normTerm(m[0])
    if (w.length >= 2 || /\d/.test(w)) out.push(w)
  }

  let run = ''
  const flush = () => {
    if (!run) return
    if (run.length === 1) {
      out.push(run)
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        const bg = run.slice(i, i + 2)
        if (!STOP.has(bg)) out.push(bg)
      }
    }
    run = ''
  }
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch
    else flush()
  }
  flush()
  return out
}
