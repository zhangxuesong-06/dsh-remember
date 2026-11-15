// 分词：中文按「字二元组」，英文/数字按词。
//
// 为什么不用词表：这份东西要在任何一台机器上都能跑，不该依赖一个 900KB 的词典文件。
// 而且中文检索里，二元组的召回率基本能追平词典分词——「记忆」「系统」这种词，
// 「记忆系统」拆成 记忆/忆系/系统 之后仍然能被「记忆」和「系统」两边同时命中。
// 代价是会有少量噪声，靠 idf 和后面的排序压下去。

// 0.2.15：带点的数字串**整体**成一个词。
// 以前 "0.2.14" 被拆成 ["0","2","14"]，其中 0 和 2 在全库 8110 条记录里各出现 1500+ 次，
// 等于两个纯噪声词占了权重；真正的区分度「14」只能靠 197 条记录撑。
// 现在 0.2.14 / 0.2.10 各是一个词，版本号之间不会再互相冒充。
// 尾巴上的句号不会被吞（点后面必须还有一个字母或数字）。
const ASCII_RE = /[a-z0-9_]+(?:\.[a-z0-9_]+)*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

// ——— 规范形（0.2.13.7）———
//
// 一个词在索引里长什么样，得由**一个地方**定：写入和查询走同一个函数。
// 教训：`v0.2.13.6` 那次，分词把字母也吃进词里，于是文档里写 `v0.2.13.6`、
// 人查询打 `0.2.13.6`，两边是两个词 —— 修好的「版本号召得回」换一版又漏一半。
// 所以凡是同一个东西的几种写法，都在这里并成一个：
//   · 前导 v + 数字点串 → 去 v（v0.2.13.6 ≡ 0.2.13.6）
//   · 全角字母数字 → 半角（NFKC，在 tokenize 入口做）
// 代价说清楚：单独搜字母 v 时，搜不到 `v0.2.13.6` 里的那个 v。
// 这个代价是划算的 —— 那个 v 本来就不是内容。
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
  '那里', '怎么', '为什', '么样', '对的', '好的', '嗯嗯', '哈哈',
])

export function tokenize(text) {
  const out = []
  if (!text) return out
  // NFKC：全角字母/数字先变半角，`ｖ０.２.１４` 和 `v0.2.14` 才落到同一个词上。
  // 兼容汉字也会被规范成标准汉字，这正好是想要的：两种写法本来就是同一个字。
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
