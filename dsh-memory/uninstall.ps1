param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$dsh     = Join-Path $env:USERPROFILE '.dsh'
$profDir = Join-Path $dsh "profiles\$Profile"
$dest    = Join-Path $dsh 'profiles\node_modules\dsh-memory'

Write-Host "== 卸载 dsh-memory ==" -ForegroundColor Cyan

if (Test-Path $profDir) {
  $patch = Join-Path $PSScriptRoot 'tools\patch-profile.mjs'
  if (Test-Path $patch) { node $patch $profDir 'dsh-memory' --remove }
}

if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
  Write-Host "已删除插件目录。"
}

Write-Host ""
Write-Host "记忆数据保留在 $dsh\dsh-memory （想彻底删就手动删这个目录）。"
Write-Host "重启 DSH 生效。"
