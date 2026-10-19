# 由 DSH 启动器（E:\Code\DSH\launcher\DeepSeek-Harness.ps1）在 DSH 启动成功后调用：
# 等 relay 的 descriptor / token 就绪，然后拉起「relay 适配器 + watchdog」
[CmdletBinding()]
param(
  [int]$Port = 18080,
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$LOG = Join-Path $ROOT 'logs\launcher-hook.log'
$DESC = 'D:\Program Files\DSH\plugins\dsh-relay\web\relay-endpoint.json'
New-Item -ItemType Directory -Force -Path (Split-Path $LOG) | Out-Null

function Log([string]$m) {
  [IO.File]::AppendAllText($LOG, ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ready: ' + $m + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Log 'hook start, waiting for relay token'

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $DESC) {
    try {
      $d = Get-Content $DESC -Raw | ConvertFrom-Json
      if ($d.mcpUrl -and $d.tokenFilePath -and (Test-Path $d.tokenFilePath)) { $ready = $true; break }
    } catch { }
  }
  Start-Sleep -Milliseconds 800
}

if (-not $ready) {
  Log 'relay token not ready in time, abort (adapter not started)'
  exit 1
}
Log ('relay ready: ' + $d.mcpUrl)

$out = Join-Path $ROOT 'logs\launcher-bringup.out'
$err = Join-Path $ROOT 'logs\launcher-bringup.err'
$p = Start-Process powershell.exe -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $ROOT 'scripts\bring-up-relay.ps1'),'-Port',"$Port",'-SkipIfHealthy'
)
[void]$p.WaitForExit(180000)

$listen = [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
$wd = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^powershell' -and $_.CommandLine -match 'watchdog-adapter\.ps1'
}).Count
Log ("done: listen=$listen watchdog=$wd exit=$($p.ExitCode)")
if (Test-Path $err) { Get-Content $err -ErrorAction SilentlyContinue | Select-Object -Last 3 | ForEach-Object { Log ('  ! ' + $_) } }
