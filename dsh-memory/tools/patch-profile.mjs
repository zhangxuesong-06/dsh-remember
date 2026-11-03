// 往 profile 的 package.json 里加一条 bundle（幂等）。
// 用法: node patch-profile.mjs <profileDir> <bundleName> [--remove]
import fs from 'node:fs'
import path from 'node:path'

const [profileDir, bundle, flag] = process.argv.slice(2)
if (!profileDir || !bundle) {
  console.error('usage: node patch-profile.mjs <profileDir> <bundleName> [--remove]')
  process.exit(2)
}
const file = path.join(profileDir, 'package.json')
// 去掉 BOM：PowerShell 写出来的 UTF-8 常常带 BOM，JSON.parse 会直接抛。
const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
const pkg = JSON.parse(raw)

pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const list = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
const has = list.includes(bundle)

let next = list
if (flag === '--remove') {
  next = list.filter((x) => x !== bundle)
} else if (!has) {
  next = [...list, bundle]
}

if (String(next) === String(list)) {
  console.log('unchanged')
  process.exit(0)
}

pkg.dsh.profile.bundles = next
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(flag === '--remove' ? 'removed' : 'added')
