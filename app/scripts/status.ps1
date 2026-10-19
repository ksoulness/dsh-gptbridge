# dsh-gptbridge · 状态检查（只读）
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$ENDPOINT = Join-Path $ROOT 'logs\endpoint.json'
$RUNINFO = Join-Path $ROOT 'logs\run.json'

Write-Host "=== dsh-gptbridge 状态 ===" -ForegroundColor Cyan
if (-not (Test-Path $ENDPOINT)) { Write-Host "未运行（无 logs\endpoint.json）" -ForegroundColor Yellow }
else {
  $ep = Get-Content $ENDPOINT -Raw | ConvertFrom-Json
  Write-Host ("  MCP     : {0}" -f $ep.url)
  Write-Host ("  issuer  : {0}" -f $ep.issuer)
  Write-Host ("  port    : {0}  boot={1}" -f $ep.port, $ep.boot)
  Write-Host ("  开放工具: {0}" -f ($ep.exposedTools -join ','))
  Write-Host ("  模式    : {0}  publicUrl={1}" -f $ep.mode, $(if ($ep.publicUrl) { $ep.publicUrl } else { '（未配置，公网部署前必须设置）' }))
  Write-Host ("  Host白名单: {0}" -f (($ep.allowHosts ?? @()) -join ','))
  try { $h = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $ep.port) -TimeoutSec 4; Write-Host ("  /health : ok={0} mode={1}" -f $h.ok, $h.mode) -ForegroundColor Green } catch { Write-Host "  /health : 不可达" -ForegroundColor Red }
  try {
    $meta = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/.well-known/oauth-authorization-server" -f $ep.port) -TimeoutSec 4
    Write-Host ("  OAuth   : issuer={0} pkce={1} scopes={2}" -f $meta.issuer, ($meta.code_challenge_methods_supported -join ','), ($meta.scopes_supported -join ','))
  } catch { Write-Host "  OAuth   : metadata 不可达" -ForegroundColor Red }
}
if (Test-Path $RUNINFO) {
  $run = Get-Content $RUNINFO -Raw | ConvertFrom-Json
  Write-Host ("  进程    : pid={0} creation={1}" -f $run.pid, $run.identity.creation)
  Write-Host ("  上游    : {0}" -f $run.upstream)
}

Write-Host "=== 凭据与磁盘保护（只读检查） ===" -ForegroundColor Cyan
$sec = Join-Path $ROOT 'config\secrets'
if (Test-Path $sec) { (icacls $sec 2>&1 | Select-Object -First 4) | ForEach-Object { "  ACL " + $_.Trim() } }
try { $bde = (Get-CimInstance -Namespace root\cimv2\security\microsoftvolumeencryption -ClassName Win32_EncryptableVolume -ErrorAction Stop | Select-Object -First 1); Write-Host ("  BitLocker: ProtectionStatus={0}（仅读取，不修改）" -f $bde.ProtectionStatus) } catch { Write-Host "  BitLocker: 无法查询（不修改系统设置）" -ForegroundColor Yellow }
Write-Host ("  DPAPI 可用: {0}" -f (Test-Path "$env:APPDATA\Microsoft\Protect"))

Write-Host "=== 生产服务（应与本轮无关、保持不变） ===" -ForegroundColor Cyan
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($role in @(
    @{ n = 'DSH Web'; m = { param($p) $p.CommandLine -match '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -and $p.CommandLine -match '\sweb(\s|$)' } },
    @{ n = 'Codex bridge'; m = { param($p) $p.Name -eq 'node.exe' -and $p.CommandLine -match 'codex' -and $p.CommandLine -notmatch 'dsh-gptbridge' } },
    @{ n = 'cloudflared'; m = { param($p) $p.Name -eq 'cloudflared.exe' } },
    @{ n = 'another-project(7676)'; m = { param($p) $p.ProcessId -eq (Get-NetTCPConnection -State Listen -LocalPort 7676 -ErrorAction SilentlyContinue).OwningProcess } })) {
  $hit = $all | Where-Object { & $role.m $_ } | Select-Object -First 1
  if ($hit) { Write-Host ("  {0,-16} pid={1} start={2}" -f $role.n, $hit.ProcessId, $hit.CreationDate) }
  else { Write-Host ("  {0,-16} 未发现" -f $role.n) -ForegroundColor Yellow }
}
