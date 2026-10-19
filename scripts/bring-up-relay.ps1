# 一键拉起：指向 DSH Relay 的适配器（18080） + 守护 watchdog
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bring-up-relay.ps1 [-Port 18080]
[CmdletBinding()]
param(
  [int]$Port = 18080,
  [int]$IntervalSeconds = 60,
  [switch]$SkipIfHealthy
)
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$STOP      = Join-Path $ROOT 'app\scripts\stop-adapter.ps1'
$ADAPTER   = Join-Path $ROOT 'scripts\start-relay-adapter.ps1'
$WATCHDOG  = Join-Path $ROOT 'scripts\watchdog-adapter.ps1'
$HEARTBEAT = Join-Path $ROOT 'logs\watchdog.heartbeat'

function WatchdogProcs {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -match '^powershell' -and $_.CommandLine -match 'watchdog-adapter\.ps1'
    })
}

$alreadyUp = $false
if ($SkipIfHealthy) {
  $livePids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'remote\\server\.mjs' })
  $liveListen = [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $alreadyUp = ($livePids.Count -ge 1) -and $liveListen
}

if ($alreadyUp) {
  Write-Host '== 1-2/4 适配器已在运行，跳过重启（-SkipIfHealthy） ==' -ForegroundColor Green
} else {
  Write-Host '== 1/4 停止旧适配器 ==' -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $STOP 2>&1 | Out-Null
  Start-Sleep -Milliseconds 900

  Write-Host '== 2/4 启动 relay 适配器（独立窗口） ==' -ForegroundColor Cyan
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$ADAPTER,'-Port',"$Port"
  ) | Out-Null
}

Write-Host '== 2/4 启动 relay 适配器（独立窗口） ==' -ForegroundColor Cyan
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',$ADAPTER,'-Port',"$Port"
) | Out-Null

$listen = $false
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 700
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $listen = $true; break }
}
if ($listen) { Write-Host ("   适配器 LISTEN 127.0.0.1:{0}" -f $Port) -ForegroundColor Green }
else { Write-Host '   适配器启动失败，查看 logs\relay-adapter*.log' -ForegroundColor Red }

Write-Host '== 3/4 守护 watchdog ==' -ForegroundColor Cyan
$procs = WatchdogProcs
$hbAge = -1
if (Test-Path $HEARTBEAT) { $hbAge = ((Get-Date) - (Get-Item $HEARTBEAT).LastWriteTime).TotalSeconds }
if (($procs.Count -ge 1) -and ($hbAge -ge 0) -and ($hbAge -lt 150)) {
  Write-Host ("   watchdog 已在运行（pid={0}，心跳 {1:N0}s 前），跳过" -f ($procs[0].ProcessId), $hbAge) -ForegroundColor Green
} else {
  $wdOut = Join-Path $ROOT 'logs\watchdog-stdout.log'
  $wdErr = Join-Path $ROOT 'logs\watchdog-stderr.log'
  Start-Process powershell.exe -WindowStyle Hidden -RedirectStandardOutput $wdOut -RedirectStandardError $wdErr -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$WATCHDOG,'-Port',"$Port",'-IntervalSeconds',"$IntervalSeconds"
  ) | Out-Null
  $ok = $false
  for ($k = 0; $k -lt 12; $k++) { Start-Sleep -Milliseconds 700; if (Test-Path $HEARTBEAT) { $ok = $true; break } }
  if ($ok) { Write-Host '   watchdog 已启动（logs\watchdog.log）' -ForegroundColor Green }
  else {
    Write-Host '   watchdog 启动未确认，错误输出：' -ForegroundColor Red
    Get-Content $wdErr -ErrorAction SilentlyContinue | Select-Object -Last 5 | ForEach-Object { Write-Host ("     " + $_) -ForegroundColor Red }
  }
}

Write-Host '== 4/4 状态 ==' -ForegroundColor Cyan
$nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'remote\\server\.mjs' })
Write-Host ("   适配器进程: {0}   端口 {1} 监听: {2}" -f $nodeProcs.Count, $Port, [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue))
if (Test-Path $HEARTBEAT) { Write-Host ("   watchdog 心跳: {0}" -f (Get-Item $HEARTBEAT).LastWriteTime.ToString('HH:mm:ss')) }
$ep = Join-Path $ROOT 'app\logs\endpoint.json'
if (Test-Path $ep) {
  try { $o = Get-Content $ep -Raw | ConvertFrom-Json; Write-Host ("   工具数: {0}" -f @($o.exposedTools).Count) } catch { }
}
if (-not $listen) { exit 1 }