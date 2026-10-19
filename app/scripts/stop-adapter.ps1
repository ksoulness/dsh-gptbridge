# dsh-gptbridge · 停止（身份校验式：只停本工程启动且身份可确认的进程）
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$RUNINFO = Join-Path $ROOT 'logs\run.json'
$ENDPOINT = Join-Path $ROOT 'logs\endpoint.json'
$KILL = [IO.Path]::GetFullPath((Join-Path $ROOT '..\legacy\gateway\proc-kill.mjs'))

if (-not (Test-Path $RUNINFO)) { Write-Host "未找到 logs\run.json（可能未启动）" -ForegroundColor Yellow; exit 0 }
$run = Get-Content $RUNINFO -Raw | ConvertFrom-Json
Write-Host ("service: pid={0} port={1} upstream={2}" -f $run.pid, $run.port, $run.upstream) -ForegroundColor Cyan

$id = $run.identity
if ($id -and $id.pid) {
  $out = & node $KILL --pid $id.pid --creation $id.creation --fp $id.fp --exe $id.exe 2>&1
  try { $v = $out | ConvertFrom-Json } catch { $v = @{ killed = $false; reason = 'unparsable' } }
  if ($v.killed) { Write-Host "已按身份校验结束（pid=$($id.pid)，$($v.reason)）" -ForegroundColor Green }
  else { Write-Host "拒绝清理（$($v.reason)）—— 身份不符或 PID 已复用，未终止任何进程" -ForegroundColor Yellow }
} else { Write-Host "无身份记录，跳过终止" -ForegroundColor Yellow }

Remove-Item $RUNINFO, $ENDPOINT -ErrorAction SilentlyContinue
Write-Host "=== 剩余核验 ===" -ForegroundColor Cyan
Write-Host ("  本工程 node 进程：{0}" -f ((Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'dsh-gptbridge[\\/]server\.mjs' } | Measure-Object).Count))
Write-Host "  生产服务未触碰（DSH Web / Codex / cloudflared / another-project）"
