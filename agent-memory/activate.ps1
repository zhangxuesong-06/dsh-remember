# 一键迁移/同步到共享仓库。
#
# 用法：关闭 OpenCode、DSH、WorkBuddy 后，在本仓库目录运行：
#   powershell -ExecutionPolicy Bypass -File agent-memory\activate.ps1
#
# OpenCode 的 CLI 是后台服务，关窗口不会退出；脚本会提示输入 K 结束它。
# 第一次执行 --apply；已有共享仓库时执行 --sync。
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

Write-Host '记忆迁移：一个目录，多条流' -ForegroundColor Cyan
Write-Host 'OpenCode 的 CLI 是后台服务，关窗口不会退出它。'

while ($true) {
  $procs = @(Get-Process -Name OpenCode, opencode-cli -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { break }
  $names = ($procs | Select-Object -ExpandProperty ProcessName -Unique) -join ', '
  Write-Host "仍检测到：$names" -ForegroundColor Yellow
  $ans = Read-Host '输入 K 结束这些进程并继续；关闭后按 Enter 重试；Ctrl+C 退出'
  if ($ans -eq 'K' -or $ans -eq 'k') {
    Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Get-Process -Name opencode-cli -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

Read-Host '确认 DSH 和 WorkBuddy 也已关闭，按 Enter 开始'

$Shared = Join-Path $HOME '.agent-memory'
$Log = Join-Path $Shared 'activation.log'
$Mode = if (Test-Path $Shared) { '--sync' } else { '--apply' }

Write-Host "执行：node agent-memory/migrate.mjs $Mode"
node agent-memory/migrate.mjs $Mode
if ($LASTEXITCODE -ne 0) {
  Write-Host '迁移/同步失败，旧库没有改动。' -ForegroundColor Red
  Read-Host '按 Enter 退出'
  exit 1
}

New-Item -ItemType Directory -Force $Shared | Out-Null
"=== $(Get-Date -Format o) ===" | Out-File $Log -Encoding utf8
node agent-memory/recall.mjs sources 2>&1 | Tee-Object -FilePath $Log -Append
node tools/mem.mjs health 2>&1 | Tee-Object -FilePath $Log -Append

Write-Host ''
Write-Host '完成。请重启 OpenCode、DSH、WorkBuddy。' -ForegroundColor Green
Write-Host "验证日志：$Log"
Read-Host '按 Enter 关闭'
