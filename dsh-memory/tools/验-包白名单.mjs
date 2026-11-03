// 验-包白名单：包目录里的每个文件，都要有**明确去路**——要么被 `files[]` 覆盖，要么按设计豁免（并且印出来）。
//
// 为什么要有这条：`files` 是 npm 发布的白名单，**不在名单里的文件装不上**。
// 2026-11-01 发布前发现：`config.example.json` 在包里但没进白名单——用 npm 装的人拿不到示例配置。
//
// 2026-11-01 第二轮修正（被第二把尺子拆穿）：
//   初版把 `tools/` 写进 SKIP，然后打印「✓ 白名单覆盖包内全部文件」。
//   数字没错，**结论是豁免出来的**：27 个文件里只有 24 个在覆盖范围，却说「全部」。
//   这跟「真会话 id 因为长得正常而过了四道检查」是同一个口子：**豁免和例外，都是让东西溜过去的地方。**
//   现在改成三栏：覆盖 / 按设计豁免（逐个印出来，带理由）/ 漏。**只有「漏」是红的。**
//
// 用法（在发布包目录里跑）：
//   node tools/验-包白名单.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'package.json')
if (!existsSync(PKG)) { console.error('找不到 package.json'); process.exit(2) }

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const files = pkg.files || []

// 按设计不进包的，每条都要有理由；**没理由的豁免不许写**
const EXEMPT = [
  { re: /^tools\//, why: '维护者工具（验-脱敏要读包外的禁词表，给用户是死文件）' },
  { re: /^package\.json$/, why: 'npm 强制打包，不用列进 files[]' },
  { re: /\.bak$/i, why: '备份文件' },
  { re: /^denylist.*\.txt$/i, why: '真名字表，绝不能进包' },
  { re: /^\./, why: '隐藏文件' },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(relative(ROOT, p).split(sep).join('/'))
  }
  return out
}

const covered = (f) => files.some((pat) => {
  if (pat.endsWith('/*.mjs')) return f.startsWith(pat.slice(0, -6)) && f.endsWith('.mjs')
  if (pat.endsWith('/*.json')) return f.startsWith(pat.slice(0, -7)) && f.endsWith('.json')
  return f === pat
})
const exemptOf = (f) => EXEMPT.find((e) => e.re.test(f))

const all = walk(ROOT)
const hit = []
const exempt = []
const miss = []
for (const f of all) {
  const ex = exemptOf(f)
  if (ex) { exempt.push({ f, why: ex.why }); continue }
  if (covered(f)) hit.push(f)
  else miss.push(f)
}

console.log(`包内 ${all.length} 个文件 · files[] ${files.length} 条`)
console.log(`  覆盖   ${hit.length}`)
console.log(`  豁免   ${exempt.length}`)
for (const e of exempt) console.log(`         - ${e.f}  （${e.why}）`)
console.log(`  漏     ${miss.length}`)

if (miss.length) {
  console.log('')
  for (const f of miss) console.log(`  ✗ 白名单外：${f} —— 在包里，但 npm 发布时会被漏掉，也没有豁免理由`)
  process.exit(1)
}
if (!hit.length) {
  console.log('')
  console.log('  ✗ 一个都没覆盖上，files[] 可能写错了')
  process.exit(1)
}
console.log('')
console.log(`  ✓ 覆盖 ${hit.length} · 豁免 ${exempt.length}（已逐条印出理由）· 漏 0`)
