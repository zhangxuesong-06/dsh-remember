// 验「这个包能不能给别人」——脱敏四条，全过才算干净。
//
// 用法：
//   node tools/验-脱敏.mjs                 # 只跑通用规则（路径 / 文件类型 / 对人的称呼）
//   node tools/验-脱敏.mjs --deny <文件>    # 额外按一份禁词表查「私人名字」
//
// 为什么禁词要从外面读，而不是写在脚本里：
//   2026-10-31 踩过一次——第一版把真实名字（几个昵称、群名）直接写进了规则正则，
//   于是**检查器自己带了私货，还因为它跳过自己而永远 PASS**。
//   规则里出现真实名字，本身就是泄露。所以：脚本只放"形状"，真名字从 --deny 传。
//
// 为什么要有这个脚本：**"我觉得干净了"不是证据。** 别人拿到包，应该能自己重跑一遍、看到 PASS。

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

// 只跳这些：它们不是"我们的内容"，是工具链/版本库自己的东西。
const SKIP_DIRS = new Set(['node_modules', '.git', '.github'])
const SKIP_FILES = new Set(['.DS_Store'])

const args = process.argv.slice(2)
const denyIdx = args.indexOf('--deny')
const denyFile = denyIdx >= 0 ? args[denyIdx + 1] : null

// 禁词（私人名字）——从外部文件读，一行一个。没有就跳过这条。
let denyWords = []
if (denyFile) {
  if (!existsSync(denyFile)) { console.error(`找不到禁词表：${denyFile}`); process.exit(2) }
  denyWords = readFileSync(denyFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
}

// 判据
//   ① 不许有本机绝对路径（别人的机器上没有，且暴露目录结构）
//   ② 不许有私人名字（只在给了 --deny 时查）
//   ③ 不许有那个群里对人的具体称呼（它现在是配置项，不该出现在代码里）
//   ④ 不许有备份文件、记忆数据、会话日志、真实配置
//
// ① 用函数判断而不是裸正则：占位符 `D:\path\to\...` 是**允许**的。
const PLACEHOLDER_PREFIX = 'D:\\path\\'
const norm = (s) => s.replace(/\\+/g, '\\')
function pathHit(line) {
  const re = /[A-Za-z]:\\[^\s"'`]*/g
  let m
  while ((m = re.exec(line))) {
    if (norm(m[0]).toLowerCase().startsWith(norm(PLACEHOLDER_PREFIX).toLowerCase())) continue
    return true
  }
  return false
}

const RULES = [
  { id: '① 本机路径', test: pathHit, hint: '换成 D:\\path\\to\\workspace 这种占位符' },
]
// ⑤ 2026-11-01 补：词表和路径都查不出**形如**隐私的东西。真会话编号、真库目录的 hash 后缀，
// 名字脱了、hash 没脱，照样能对上别人的库。这条是 regex，不是词表。
// `session-0a1b2c3d` 是文档里的例子（selftest 依赖它），放行。
RULES.push({
  id: '⑤ 真会话编号 / 真库目录名',
  test: (line) => {
    if (/session-(?!0a1b2c3d)[0-9a-f]{8}/.test(line)) return true
    for (const m of line.matchAll(/[\u4e00-\u9fa5]{2,}-([0-9a-f]{8})\b/g)) {
      if (/[a-f]/.test(m[1])) return true      // 纯 8 位数字是日期（标定样本-20261101），不是 hash
    }
    return false
  },
  hint: '真 id / 库目录 hash 用 xxxxxxxx 遮掉（session-0a1b2c3d 是例子，允许）',
})
if (denyWords.length) {
  RULES.push({
    id: '② 禁词表',
    test: (line) => denyWords.some((w) => line.includes(w)),
    hint: `命中禁词表（${denyFile}）—— 私人名字、群名、对人的称呼都走这张表，规则里不写具体值`,
  })
}

const BAD_FILES = [
  { re: /\.bak(\.|$)/i, why: '备份文件（含历史私事）' },
  { re: /\.jsonl$/i, why: '会话/记忆日志（这是隐私，绝不出包）' },
  { re: /^记忆数据$/, why: '记忆数据目录' },
  { re: /^config\.json$/, why: '真实配置（含本机路径）' },
  { re: /^denylist.*\.txt$/, why: '禁词表本身（里面就是真名字）' },
]

const hits = []
const scanned = []
const skipped = []
const BIG = 2 * 1024 * 1024

function ext(f) { return (f.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase() }
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'txt', 'svg', 'html', 'css', 'ts', 'sh'])

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(ROOT, full).split(sep).join('/')
    if (SKIP_FILES.has(rel)) { skipped.push(`${rel}（系统文件）`); continue }
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) { skipped.push(`${rel}/（工具链/版本库）`); continue }
      for (const b of BAD_FILES) if (b.re.test(name)) hits.push({ rule: '④ 不该带的东西', file: rel, why: b.why })
      walk(full)
      continue
    }
    for (const b of BAD_FILES) if (b.re.test(name)) hits.push({ rule: '④ 不该带的东西', file: rel, why: b.why })
    // 无扩展名的文件也要扫（LICENSE、Makefile 这类）——它们同样是"我们的内容"。
    // 二进制靠 utf8 解码失败来兜底：读不了就算跳过，不算通过。
    if (!TEXT_EXT.has(ext(name)) && ext(name) !== '') { skipped.push(`${rel}（非文本类型）`); continue }
    if (st.size > BIG) { skipped.push(`${rel}（超过 2MB，没扫）`); continue }
    let text = ''
    try { text = readFileSync(full, 'utf8') } catch { skipped.push(`${rel}（读不了，按跳过算）`); continue }
    if (text.includes('\u0000')) { skipped.push(`${rel}（二进制内容）`); continue }
    scanned.push(rel)
    const lines = text.split('\n')
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        if (rule.test(lines[i])) {
          hits.push({ rule: rule.id, file: `${rel}:${i + 1}`, why: rule.hint, line: lines[i].trim().slice(0, 100) })
        }
      }
    }
  }
}

walk(ROOT)

const byRule = new Map()
for (const h of hits) {
  if (!byRule.has(h.rule)) byRule.set(h.rule, [])
  byRule.get(h.rule).push(h)
}

console.log(`扫了 ${scanned.length} 个文本文件，跳过 ${skipped.length} 个：`)
for (const s of skipped) console.log(`  跳过 ${s}`)
if (denyWords.length) console.log(`禁词表：${denyWords.length} 个词（${denyFile}）`)
console.log('')

const allRules = [...RULES.map((r) => r.id), '④ 不该带的东西']
let failed = 0
for (const id of allRules) {
  const list = byRule.get(id) || []
  if (!list.length) { console.log(`PASS  ${id}`); continue }
  failed++
  console.log(`FAIL  ${id}   ${list.length} 处`)
  for (const h of list.slice(0, 8)) console.log(`        ${h.file}  ${h.line || h.why}`)
  if (list.length > 8) console.log(`        …还有 ${list.length - 8} 处`)
}

console.log('')
if (failed) { console.log(`结果：${failed} 条不过。这个包还不能给别人。`); process.exit(1) }
console.log('结果：全部通过。')
