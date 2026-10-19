# dsh-gptbridge · Named Tunnel 启动器（受控；本轮不创建、不启动）
#
# 前置（须由你在 Cloudflare 侧完成，并经本轮之后单独审批）：
#   1) 独立域名/子域：如 dsh-mcp.<你的域名>（不要复用 another-project.example.com）
#   2) cloudflared tunnel create dsh-mcp-private  → 得到 Tunnel ID 与 credentials json
#   3) 新 DNS CNAME 指向 <tunnel-id>.cfargotunnel.com
#   4) 把 credentials json 放到 config\tunnel\ 下（gitignore，不提交）
#
# 用法（获批后）：
#   .\start-tunnel.ps1 -TunnelId <uuid> -Hostname dsh-mcp.example.com -Credentials config\tunnel\<id>.json -IConfirmAuthorized
#
# 安全：显式指定 --config 与 --origincert/credentials，绝不隐式加载 another-project 生产配置；
#       只转发到本工程 OAuth MCP 的本地端口；不含 catch-all 之外的路由。

[CmdletBinding()]
param(
  [string]$TunnelId = '',
  [string]$Hostname = '',
  [string]$Credentials = '',
  [string]$ConfiguredExe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe',
  [switch]$IConfirmAuthorized,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$ENDPOINT = Join-Path $ROOT 'logs\endpoint.json'
$KILL = [IO.Path]::GetFullPath((Join-Path $ROOT '..\legacy\gateway\proc-kill.mjs'))

function Fail([string]$m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m) { Write-Host "OK  : $m" -ForegroundColor Green }

if (-not (Test-Path $ConfiguredExe)) { Fail "未找到 cloudflared.exe：$ConfiguredExe（可复用 another-project 同一二进制，但不得共用其配置/凭据）" }
Ok "cloudflared: $(& $ConfiguredExe --version 2>&1 | Select-Object -First 1)"

if (-not (Test-Path $ENDPOINT)) { Fail "本地 OAuth MCP 未运行（先 scripts\start-local.ps1）" }
$ep = Get-Content $ENDPOINT -Raw | ConvertFrom-Json
$localUrl = "http://127.0.0.1:$($ep.port)"
Ok "本地目标：$localUrl（仅本工程 OAuth MCP，禁止指向 3079/48765/7676/7863）"

if ($TunnelId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { Fail "缺少或格式不符的 -TunnelId（UUID）" }
if ($Hostname -notmatch '^[a-z0-9.-]+\.[a-z]{2,}$') { Fail "缺少或格式不符的 -Hostname" }
if (-not $Credentials -or -not (Test-Path $Credentials)) { Fail "缺少 -Credentials（本工程专用 credentials json，不得复用 another-project 凭据）" }

$cfgDir = Join-Path $ROOT 'config\tunnel'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfgPath = Join-Path $cfgDir 'config.yml'
$cfg = @"
tunnel: $TunnelId
credentials-file: $((Resolve-Path $Credentials).Path)
no-autoupdate: true
metrics: 127.0.0.1:0
ingress:
  - hostname: $Hostname
    service: $localUrl
  - service: http_status:404
"@
[IO.File]::WriteAllText($cfgPath, $cfg, (New-Object System.Text.UTF8Encoding($false)))
Ok "已生成本工程独立配置：$cfgPath（catch-all 404，单入口）"

if ($DryRun -or -not $IConfirmAuthorized) {
  Write-Host "`n仅生成配置，未启动隧道（需要 -IConfirmAuthorized 且已获公网部署专项授权）。" -ForegroundColor Yellow
  Write-Host "获批后执行：`n  & '$ConfiguredExe' tunnel --config '$cfgPath' run $TunnelId" -ForegroundColor Cyan
  return
}

$proc = Start-Process -FilePath $ConfiguredExe -PassThru -NoNewWindow -ArgumentList @('tunnel', '--config', $cfgPath, 'run', $TunnelId) `
  -RedirectStandardOutput (Join-Path $ROOT 'logs\tunnel.out.log') -RedirectStandardError (Join-Path $ROOT 'logs\tunnel.err.log')
Start-Sleep -Seconds 4
if ($proc.HasExited) { Get-Content (Join-Path $ROOT 'logs\tunnel.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }; Fail "cloudflared 启动即退出" }
$id = (& node $KILL --capture --pid $proc.Id 2>$null | ConvertFrom-Json)
@{ pid = $proc.Id; identity = $id; tunnel_id = $TunnelId; hostname = $Hostname; config = $cfgPath; started_at = (Get-Date).ToString('o') } |
  ConvertTo-Json -Depth 5 | ForEach-Object { [IO.File]::WriteAllText((Join-Path $ROOT 'logs\tunnel-run.json'), $_, (New-Object System.Text.UTF8Encoding($false))) }
Ok "隧道进程已启动 pid=$($proc.Id)（运行信息无密钥）"
