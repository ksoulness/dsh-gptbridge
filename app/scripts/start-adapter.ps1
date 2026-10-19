# dsh-gptbridge · 本地启动（阶段 1/2：仅 127.0.0.1，动态端口）
#
# 用法：
#   .\start-local.ps1 -UpstreamUrl http://127.0.0.1:14583/mcp
#   .\start-local.ps1 -UpstreamUrl ... -Exposed dsh_health,dsh_git_status   # 第二次审批后逐步开放
#
# 要求：先运行 .\init-auth.ps1 生成 config\secrets\*（不写 Git、不进日志）

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$UpstreamUrl,
  [string]$Exposed = 'dsh_health',
  [int]$Port = 0,
  [string[]]$UpstreamHeader = @(),
  [string]$UpstreamTokenFile = '',
  [string]$LogsDir = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$SERVER = Join-Path $ROOT 'server.mjs'
$ENDPOINT = Join-Path $ROOT 'logs\endpoint.json'
$KILL = [IO.Path]::GetFullPath((Join-Path $ROOT '..\legacy\gateway\proc-kill.mjs'))
$RUNINFO = Join-Path $ROOT 'logs\run.json'

function Fail([string]$m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m) { Write-Host "OK  : $m" -ForegroundColor Green }

if (-not (Test-Path (Join-Path $ROOT 'config\secrets\pepper.txt'))) { Fail "缺少 config\secrets\pepper.txt，请先运行 scripts\init-auth.ps1" }
if ($UpstreamUrl -notmatch '^http://(127\.0\.0\.1|localhost):\d+/.+mcp$') { Fail "上游必须是回环 MCP：$UpstreamUrl" }
if (-not $LogsDir) { $LogsDir = Join-Path $ROOT 'logs' }
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$hdrArgs = @()
foreach ($h in @($UpstreamHeader)) { if ($h) { $hdrArgs += @('--upstream-header', $h) } }
if ($UpstreamTokenFile) { $hdrArgs += @('--upstream-token-file', $UpstreamTokenFile) }
$argList = @($SERVER, '--port', $Port, '--upstream', $UpstreamUrl, '--exposed', $Exposed) + $hdrArgs + @(
  '--config', (Join-Path $ROOT 'config\config.json'),
  '--secrets-dir', (Join-Path $ROOT 'config\secrets'), '--state-dir', (Join-Path $ROOT 'state'),
  '--logs-dir', $LogsDir, '--endpoint-file', $ENDPOINT)

$proc = Start-Process -FilePath 'node' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogsDir 'service.out.log') -RedirectStandardError (Join-Path $LogsDir 'service.err.log') `
  -ArgumentList $argList
$actual = 0
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 150
  if ($proc.HasExited) { break }
  $out = Get-Content (Join-Path $LogsDir 'service.out.log') -Raw -ErrorAction SilentlyContinue
  if ($out -match 'REMOTE_MCP_LISTEN 127\.0\.0\.1:(\d+)') { $actual = [int]$Matches[1]; break }
}
if ($actual -eq 0) {
  Get-Content (Join-Path $LogsDir 'service.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Fail "服务未报告监听端口"
}

$id = (& node $KILL --capture --pid $proc.Id 2>$null | ConvertFrom-Json)
@{ pid = $proc.Id; identity = $id; upstream = $UpstreamUrl; port = $actual; exposed = $Exposed; started_at = (Get-Date).ToString('o') } |
  ConvertTo-Json -Depth 5 | ForEach-Object { [IO.File]::WriteAllText($RUNINFO, $_, (New-Object System.Text.UTF8Encoding($false))) }

Ok "本地服务：http://127.0.0.1:$actual/mcp（issuer 同源）"
Ok "开放工具：$Exposed（白名单之外一律拒绝）"
Ok "运行信息：$RUNINFO（无密钥）"
if ($SelfTest) { return }
Write-Host "  状态：.\status.ps1   停止：.\stop.ps1" -ForegroundColor Cyan
