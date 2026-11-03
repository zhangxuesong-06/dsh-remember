// 验-示例配置：`config.example.json` 里的每个字段，必须在 `lib/config.mjs` 里真的存在。
//
// 为什么要有这条：0.2.13.7 把 `halfLifeDays` 换成了 `recency: { t0, alpha, floor }`，
// **示例配置没跟着换**。于是别人装完照着示例去调 `halfLifeDays`，改半天没反应，
// 只会以为插件坏了；而真正该调的 `recency` 在示例里一个字都没有。
// 2026-11-01 在发布前被另一位维护者抓到（不然这一版就带着个死字段出去了）。
//
// 用法（在发布包目录里跑）：
//   node tools/验-示例配置.mjs

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EX = join(ROOT, 'config.example.json')
const CFG = join(ROOT, 'lib', 'config.mjs')

if (!existsSync(EX)) { console.log('（没有 config.example.json，跳过）'); process.exit(0) }
if (!existsSync(CFG)) { console.error('找不到 lib/config.mjs'); process.exit(2) }

const code = readFileSync(CFG, 'utf8')
const text = readFileSync(EX, 'utf8')

// 只取顶层字段；`_xxx说明` 这种说明字段不参与
const keys = [...text.matchAll(/^\s{2}"([A-Za-z][A-Za-z0-9]*)"/gm)].map((m) => m[1])

const dead = []
for (const k of keys) {
  if (k.startsWith('_')) continue
  if (!new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(code)) dead.push(k)
}

// 反向也查一次：代码里有、示例里完全没有的**重要**字段（不做强要求，只提示）
const known = ['recency']
const missing = known.filter((k) => !keys.includes(k))

console.log(`示例配置顶层字段：${keys.filter((k) => !k.startsWith('_')).length} 个`)
if (dead.length) {
  console.log('')
  for (const k of dead) console.log(`  ✗ 死字段：${k} —— 示例里有，代码里没有（改了不会有任何反应）`)
}
if (missing.length) {
  console.log('')
  for (const k of missing) console.log(`  ! 示例缺：${k} —— 代码里是活的，示例里没写，别人不知道有这个旋钮`)
}
if (!dead.length && !missing.length) { console.log('  ✓ 示例字段与代码一致'); process.exit(0) }
process.exit(1)
