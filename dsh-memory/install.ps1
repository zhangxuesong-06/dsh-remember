param(
  [string]$Profile = 'desktop',
  [string]$Workspace = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$src     = $PSScriptRoot
$dsh     = Join-Path $env:USERPROFILE '.dsh'
$profDir = Join-Path $dsh "profiles\$Profile"
$pkgFile = Join-Path $profDir 'package.json'
$nmDir   = Join-Path $dsh 'profiles\node_modules'
$dest    = Join-Path $nmDir 'dsh-memory'
$dataDir = Join-Path $dsh 'dsh-memory'
$cfgFile = Join-Path $dataDir 'config.json'

Write-Host "== dsh-memory 安装 ==" -ForegroundColor Cyan
Write-Host "插件源 : $src"
Write-Host "profile: $profDir"
Write-Host "目标   : $dest"

if (-not (Test-Path $dsh))     { throw "找不到 $dsh —— 先启动一次 DSH 再装。" }
if (-not (Test-Path $profDir)) { throw "找不到 profile: $profDir（可选 desktop / web）" }
if (-not (Test-Path $pkgFile)) { throw "找不到 $pkgFile" }

if ($DryRun) {
  Write-Host "[DryRun] 不写任何文件。" -ForegroundColor Yellow
  Write-Host "[DryRun] 将复制到 $dest"
  Write-Host "[DryRun] 将把 dsh-memory 加进 $pkgFile 的 bundles"
  Write-Host "[DryRun] 将生成 $cfgFile"
  exit 0
}

# 1) 备份 profile
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$pkgFile.bak-$stamp"
Copy-Item $pkgFile $backup -Force
Write-Host "已备份 profile -> $backup"

# 2) 复制插件（零依赖，不需要 npm install）
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$exclude = @('.git', 'node_modules', '*.txt')
robocopy $src $dest /E /XD .git node_modules /XF 's2.txt' 's3.txt' 'smoke-out.txt' '_loadcheck.mjs' /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy exit $LASTEXITCODE）" }
Write-Host "插件已复制。"

# 3) 加进 bundles（幂等）
Push-Location $dest
$patch = Join-Path $dest 'tools\patch-profile.mjs'
node $patch $profDir 'dsh-memory'
Pop-Location

# 4) 生成 config
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
if (-not (Test-Path $cfgFile)) {
  $ws = @()
  if ($Workspace) { $ws = @($Workspace) }
  $cfg = [ordered]@{
    enabled         = $true
    workspaces      = $ws
    lines           = @()
    capture         = $true
    backfillOnMount = $true
    perTurnPriming  = $true
    anchor          = $true
    arrival         = $true
    facts           = $true
  }
  $json = $cfg | ConvertTo-Json -Depth 6
  # 必须写成不带 BOM 的 UTF-8：带 BOM 的 JSON 会让插件的 JSON.parse 直接抛。
  [System.IO.File]::WriteAllText($cfgFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已生成配置 -> $cfgFile"
} else {
  Write-Host "配置已存在，保留不动 -> $cfgFile"
}

Write-Host ""
Write-Host "装好了。还差两步：" -ForegroundColor Green
Write-Host "  1) 打开 $cfgFile，把 workspaces 填成你平时用的工作区绝对路径"
Write-Host "     例如:  `"D:\\deepseek harness`""
Write-Host "  2) 重启 DSH"
Write-Host ""
Write-Host "验证：新开一个会话问一句「看看记忆库现在什么样」，应当调用 memory_stats。"
Write-Host "日志：$dataDir\diag.log"
