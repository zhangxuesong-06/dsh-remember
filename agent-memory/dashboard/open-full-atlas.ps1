[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 7331,
    [switch]$PrintUrl
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port/?all=1"

function Test-AtlasReady {
    try {
        $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 -MaximumRedirection 0
        return $page.StatusCode -eq 200 -and $page.Content.Contains('id="full-map"')
    } catch {
        return $false
    }
}

try {
    if (-not (Test-AtlasReady)) {
        $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw '找不到 Node.js，请先安装并将 node.exe 加入 PATH。' }

        $entry = Join-Path $PSScriptRoot 'server.mjs'
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '找不到星图的 server.mjs。' }
        $three = Join-Path $PSScriptRoot 'node_modules/three/build/three.module.js'
        if (-not (Test-Path -LiteralPath $three -PathType Leaf)) {
            throw "缺少星图依赖。请在 PowerShell 执行 npm.cmd ci --prefix `"$PSScriptRoot`"。"
        }

        $arguments = '"{0}" --port={1}' -f $entry, $Port
        Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 200
            $ready = Test-AtlasReady
        } until ($ready -or [DateTime]::UtcNow -ge $deadline)

        if (-not $ready) {
            throw "端口 $Port 上的星图未能启动。请在 PowerShell 执行 node `"$entry`" --port=$Port 查看原因。"
        }
    }

    if ($PrintUrl) {
        $url
    } else {
        Start-Process -FilePath $url
    }
} catch {
    if ($PrintUrl) { throw }
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($_.Exception.Message, 0, '全量记忆星图', 16)
    exit 1
}
