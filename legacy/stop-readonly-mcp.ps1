# P3-0 · 停止只读 MCP 端点（控制面 + 身份校验式兜底）
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DSH  = Join-Path $ROOT 'dsh'
$ENDPOINT = Join-Path $ROOT 'logs\mcp-endpoint.json'
$KILL = Join-Path $DSH 'gateway\proc-kill.mjs'


if (-not (Test-Path $ENDPOINT)) { Write-Host "未找到 mcp-endpoint.json（可能已停止）" -ForegroundColor Yellow; exit 0 }
$info = Get-Content $ENDPOINT -Raw | ConvertFrom-Json
Write-Host ("endpoint: {0} (port={1})" -f $info.url, $info.port) -ForegroundColor Cyan

try {
  $boot = (Invoke-RestMethod -Uri $info.health -TimeoutSec 3).boot_id
  if ($boot) {
    Invoke-RestMethod -Uri ($info.health -replace '/health$', '/_control/shutdown') -Method Post -Headers @{ 'x-p2a-boot' = $boot } -TimeoutSec 5 | Out-Null
    Write-Host "已请求优雅关闭" -ForegroundColor Green
    Start-Sleep -Seconds 2
  }
} catch { Write-Host "控制面不可用，改身份校验式结束" -ForegroundColor Yellow }

$id = $info.gateway_identity
if ($id -and $id.pid) {
  $out = & node $KILL --pid $id.pid --creation $id.creation --fp $id.fp --exe $id.exe 2>&1
  try { $v = $out | ConvertFrom-Json } catch { $v = @{ killed = $false; reason = 'unparsable' } }
  if ($v.killed) { Write-Host "已按身份校验结束 pid=$($id.pid)" -ForegroundColor Green }
  else { Write-Host "拒绝清理（$($v.reason)）—— 身份不符或 PID 已复用" -ForegroundColor Yellow }
}
Remove-Item $ENDPOINT -ErrorAction SilentlyContinue
Write-Host ("端口 {0} 监听：" -f $info.port) -NoNewline
((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $info.port } | Measure-Object).Count)
