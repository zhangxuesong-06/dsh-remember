$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$here = $PSScriptRoot
Write-Host '== WorkBuddy self-memory 安装/更新 ==' -ForegroundColor Cyan
node (Join-Path $here 'install.mjs')
if ($LASTEXITCODE -ne 0) { throw "安装失败（node exit $LASTEXITCODE）" }
Write-Host ''
Write-Host '验证：' -ForegroundColor Green
Write-Host '  node "$env:USERPROFILE\.workbuddy\skills\self-memory\bin\mem.mjs" health'
Write-Host '  node "$env:USERPROFILE\.workbuddy\skills\self-memory\bin\mem.mjs" verify'
