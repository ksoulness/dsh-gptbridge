# 由 DSH 启动器在 DSH 关闭后调用：停掉 watchdog + relay 适配器
[CmdletBinding()]
param([int]$Port = 18080)
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$LOG = Join-Path $ROOT 'logs\launcher-hook.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LOG) | Out-Null

function Log([string]$m) {
  [IO.File]::AppendAllText($LOG, ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] stop: ' + $m + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Log 'hook start'

# 1) 先停 watchdog（否则它会把刚停掉的适配器又拉起来）
$wd = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^powershell' -and $_.CommandLine -match 'watchdog-adapter\.ps1'
} | ForEach-Object { $_.ProcessId })
foreach ($wp in $wd) { & cmd.exe /c "taskkill /PID $wp /T /F >nul 2>&1" }
Log ("watchdog stopped: " + $(if ($wd) { ($wd -join ',') } else { 'none' }))
Start-Sleep -Milliseconds 600

# 2) 停适配器（身份校验式，不会误杀别的东西）
$stopScript = Join-Path $ROOT 'app\scripts\stop-adapter.ps1'
Log ("stopScript=" + $stopScript + " exists=" + (Test-Path -LiteralPath ([string]$stopScript)))
if (Test-Path -LiteralPath ([string]$stopScript)) {
  $p = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$stopScript)
  [void]$p.WaitForExit(60000)
}

# 3) 结果
$listen = [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
$adapter = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'remote\\server\.mjs' }).Count
Log ("done: adapter=$adapter listen=$listen")
