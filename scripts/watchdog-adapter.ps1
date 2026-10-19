# DSH Remote MCP 适配器守护：每 60 秒探一次 18080，进程/端口缺失就自动拉起
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog-adapter.ps1
# 说明：不注册 Windows 服务或计划任务（本机约束），进程随本终端/隐藏窗口存活；重启后需再运行一次（或跑 dshmcp.bat apply）。
[CmdletBinding()]
param(
  [int]$Port = 18080,
  [int]$IntervalSeconds = 60,
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
if (-not $LogPath) { $LogPath = Join-Path $ROOT 'logs\watchdog.log' }
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Log([string]$m) {
  $line = ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m)
  [IO.File]::AppendAllText($LogPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

function AdapterPids() {
  (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'remote\\server\.mjs' }).ProcessId
}

function PortListening() {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# 单实例锁：同一时间只允许一个 watchdog 动作（避免多实例同时拉起适配器）
$lockPath = Join-Path (Split-Path $LogPath) 'watchdog.lock'
try {
  $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  Log ('watchdog lock acquired: ' + $lockPath)
} catch {
  Write-Host 'another watchdog instance is already running; exiting'
  exit 0
}
Log ('watchdog start: port=' + $Port + ' interval=' + $IntervalSeconds + 's')
$restarts = 0
$heartbeat = Join-Path (Split-Path $LogPath) 'watchdog.heartbeat'
while ($true) {
  try {
    [IO.File]::WriteAllText($heartbeat, (Get-Date -Format o), (New-Object System.Text.UTF8Encoding($false)))
    $pids = @(AdapterPids)
    $listening = PortListening
    if ($pids.Count -eq 0 -or -not $listening) {
      Log ("DOWN detected (pids=$($pids.Count) listening=$listening) -> restarting")
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ROOT 'scripts\start-relay-adapter.ps1') -Port $Port 2>&1 | Out-Null
      $restarts++
      Start-Sleep -Seconds 5
      $pids2 = @(AdapterPids)
      Log ("restart attempt #$restarts result: pids=$($pids2.Count) listening=$(PortListening)")
    } else {
      Log ("OK pids=$($pids.Count) listening=$listening")
    }
  } catch {
    Log ("watchdog error: " + $_.Exception.Message)
  }
  Start-Sleep -Seconds $IntervalSeconds
}
