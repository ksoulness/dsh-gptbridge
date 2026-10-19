# P3-0 · 只读 MCP 端点（隔离网关；仅暴露 klass=read 工具；无模型出站）
#
# 用法：
#   cd <repo>\dsh\local
#   .\start-readonly-mcp.ps1              # 启动并把端点写入 mcp-endpoint.json
#   .\stop-readonly-mcp.ps1               # 停止（控制面 + 身份校验式兜底）
#
# 说明：
#   * 不启动出站代理：只读端点不允许任何模型调用（task_submit 在服务端未登记）
#   * 网关以 --readonly 启动：CONTROL/WRITE 工具不会出现在 tools/list，tools/call 直接 -32004
#   * 仅监听 127.0.0.1；Host 白名单 127.0.0.1/localhost（防 DNS rebinding）
#   * 端点信息写入 mcp-endpoint.json（不含任何密钥）

[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$StateRoot = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # <repo>
$DSH  = Join-Path $ROOT 'dsh'
if (-not $StateRoot) { $StateRoot = Join-Path $ROOT 'state\ro' }
# acpHome 优先取配置（让 ACP 与 DSH Web 共用会话库，GPT 会话才能直接出现在 Web 的工作区里）
$HOME_DIR = Join-Path $DSH 'local\dsh-home'
try {
  $mgrCfgPath = Join-Path $ROOT 'config\mcp-manager.json'
  if (Test-Path $mgrCfgPath) {
    $mgrCfg = Get-Content $mgrCfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($mgrCfg.acpHome) { $HOME_DIR = [string]$mgrCfg.acpHome }
  }
} catch { }
$REPO = Join-Path $DSH 'local\repo'
$OVERLAY = Join-Path $DSH 'local\acp-local-overlay.yml'
$GW = Join-Path $DSH 'gateway\gateway.mjs'
$DSH_BIN = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$STATE = Join-Path $StateRoot ("ro-" + (Get-Date -Format 'MMdd-HHmmss'))
$ENDPOINT = Join-Path $ROOT 'logs\mcp-endpoint.json'
$KILL = Join-Path $DSH 'gateway\proc-kill.mjs'

function Fail([string]$m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m) { Write-Host "OK  : $m" -ForegroundColor Green }

$gwProc = $null
try {
  foreach ($p in @($GW, $DSH_BIN, $OVERLAY)) { if (-not (Test-Path $p)) { Fail "缺少文件: $p" } }
  # 只有「项目内隔离 HOME」才做凭据白名单校验；共用 DSH Web HOME 时跳过（那是用户自己的正式 HOME）
  $isoHome = Join-Path $DSH 'local\dsh-home'
  $usingIso = ([IO.Path]::GetFullPath($HOME_DIR) -eq [IO.Path]::GetFullPath($isoHome))
  if (-not $usingIso) { Ok ("ACP HOME = 共用 " + $HOME_DIR + "（GPT 会话将直接写入该 HOME 的 sessions，出现在 DSH Web 工作区）") }
  $credFile = Join-Path $HOME_DIR '.credentials.yaml'
  # 注入对所有 HOME 生效；越权键校验只在项目内隔离 HOME 执行
  if ($credFile -and (Test-Path $credFile)) {
    if (-not $usingIso) { $badKeys = @() }
    $badKeys = (Get-Content $credFile) | Select-String -Pattern '^\s+([A-Za-z0-9_]+)\s*:' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Where-Object { $_ -notin @('version','refs','DSH_API_KEY') }
    if ($badKeys) { Fail ("隔离 HOME 的 .credentials.yaml 含有未授权键: " + ($badKeys -join ',')) }
    Ok '凭据: 仅 DSH_API_KEY（ACL 已收紧）'
    # 把 DSH_API_KEY 注入进程环境（ACP 继承 process.env），避免出现在命令行里
    $keyLine = (Get-Content $credFile | Select-String 'DSH_API_KEY\s*:\s*(.+)$').Matches
    if ($keyLine.Count -gt 0) {
      $k = $keyLine[0].Groups[1].Value.Trim().Trim('"').Trim("'")
      if ($k.Length -ge 8) { $env:DSH_API_KEY = $k; Ok ("凭据注入: DSH_API_KEY 长度 " + $k.Length) }
      else { Fail '凭据文件中的 DSH_API_KEY 值过短' }
    } else { Fail '凭据文件缺少 DSH_API_KEY' }
  }
  if ($usingIso) { foreach ($c in @('.env', 'auth\store.json')) { if (Test-Path (Join-Path $HOME_DIR $c)) { Fail ("隔离 HOME 出现凭据文件 " + $c + "（拒绝启动）") } } }
  Ok "文件与隔离 HOME 检查通过"
  New-Item -ItemType Directory -Force -Path $STATE | Out-Null

  $env:DSH_HOME = $HOME_DIR
  $env:DSH_TELEMETRY_DISABLED = '1'

  # 允许被读取的目录（来自管理器配置；默认仅沙箱 repo）
  $mgrFile = Join-Path $ROOT 'config\mcp-manager.json'
  $cwdAllow = @($REPO)
  if (Test-Path $mgrFile) {
    try {
      $mgr = Get-Content $mgrFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($mgr.cwdAllow -and @($mgr.cwdAllow).Count -gt 0) { $cwdAllow = @($mgr.cwdAllow | Where-Object { $_ } | ForEach-Object { [string]$_ }) }
    } catch { Write-Host "WARN: 管理器配置解析失败，使用默认 cwd-allow" -ForegroundColor Yellow }
  }
  # 委派所需：真实提交开关与真实 Prompt 预算（来自管理器配置）
  $submitArgs = @()
  if ($mgr) {
    if ($mgr.allowRealSubmit -eq $true) { $submitArgs += '--allow-real-submit' }
    $budget = 0
    if ($null -ne $mgr.maxRealPrompts) { $budget = [int]$mgr.maxRealPrompts }
    if ($budget -gt 0) { $submitArgs += @('--max-real-prompts', [string]$budget) }
  }
  if ($submitArgs.Count -gt 0) { Ok ("提交开关: " + ($submitArgs -join ' ')) } else { Ok '提交开关: 关闭（只读模式）' }

  $cwdArgs = @()
  foreach ($dir in $cwdAllow) { $cwdArgs += @('--cwd-allow', [string]$dir) }
  Ok ("cwd-allow: " + ($cwdAllow -join ' | '))

  # allowRealSubmit=true 时不再传 --readonly（gateway 在 readonly 模式会隐藏写/控制工具）
  $roArgs = @()
  if (-not ($mgr -and $mgr.allowRealSubmit -eq $true)) { $roArgs += '--readonly' }
  else { Ok '模式: workspace-write（委派已启用，写权限已按 cwd-allow 限定）' }
  # 路径含空格时不能作为独立参数传给 Start-Process（会被拆成两段），改用继承环境变量 DSH_HOME
  $acpHomeArgs = @()
  if ($HOME_DIR -match '\s') { Ok ("acp-home 含空格，经继承环境变量 DSH_HOME 生效: " + $HOME_DIR) }
  else { $acpHomeArgs = @('--acp-home', $HOME_DIR) }
  $gwArgs = @($GW, '--acp-mode', 'real', '--acp-bin', $DSH_BIN) + $acpHomeArgs + @('--acp-patch', $OVERLAY) + $cwdArgs + $submitArgs + $roArgs + @(
    '--allow-host', '127.0.0.1,localhost',
    '--max-assistant-turns', '6', '--task-timeout-ms', '180000', '--state', $STATE, '--port', $Port)
  $gwProc = Start-Process -FilePath 'node' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $STATE 'gateway.out.log') -RedirectStandardError (Join-Path $STATE 'gateway.err.log') `
    -ArgumentList $gwArgs

  $script:ActualPort = 0
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 150
    if ($gwProc.HasExited) { break }
    $glog = Get-Content (Join-Path $STATE 'gateway.out.log') -Raw -ErrorAction SilentlyContinue
    if ($glog -match 'GATEWAY_LISTEN 127\.0\.0\.1:(\d+)') { $script:ActualPort = [int]$Matches[1]; break }
  }
  if ($script:ActualPort -eq 0) {
    Get-Content (Join-Path $STATE 'gateway.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Fail "网关未报告监听端口"
  }

  $id = (& node $KILL --capture --pid $gwProc.Id 2>$null | ConvertFrom-Json)
  @{
    url = "http://127.0.0.1:$($script:ActualPort)/mcp"
    health = "http://127.0.0.1:$($script:ActualPort)/health"
    port = $script:ActualPort
    tool_mode = 'read-only'
    state = $STATE
    boot_started_at = (Get-Date).ToString('o')
    gateway_identity = $id
  } | ConvertTo-Json -Depth 5 | ForEach-Object { [IO.File]::WriteAllText($ENDPOINT, $_, (New-Object System.Text.UTF8Encoding($false))) }

  Ok "只读 MCP 端点：http://127.0.0.1:$($script:ActualPort)/mcp"
  Ok "端点信息：$ENDPOINT（不含密钥）"
  Write-Host "  停止：.\stop-readonly-mcp.ps1" -ForegroundColor Cyan

  if ($SelfTest) { Write-Host "SELFTEST PASS" -ForegroundColor Green; return }
  Wait-Process -Id $gwProc.Id
}
catch { Write-Host "`n异常：$($_.Exception.Message)" -ForegroundColor Red; throw }
finally {
  if ($gwProc -and -not $gwProc.HasExited) {
    try {
      $boot = (Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $script:ActualPort) -TimeoutSec 2).boot_id
      if ($boot) { Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/_control/shutdown" -f $script:ActualPort) -Method Post -Headers @{ 'x-p2a-boot' = $boot } -TimeoutSec 4 | Out-Null }
    } catch { }
    Start-Sleep -Milliseconds 800
    if (-not $gwProc.HasExited) { try { Stop-Process -Id $gwProc.Id -Force } catch { } }
  }
  Remove-Item $ENDPOINT -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_HOME, Env:DSH_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
  Write-Host "CLEANUP OK" -ForegroundColor Green
}
