# 启动「指向 DSH 内置 Relay MCP」的适配器（relay 自带 token 鉴权）
[CmdletBinding()]
param(
  [int]$Port = 18080,
  [string[]]$Exposed = @(),
  [string]$WebHome = 'D:\Program Files\DSH',
  [switch]$LocalOnly
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$descPath = Get-ChildItem (Join-Path $WebHome 'plugins\dsh-relay') -Recurse -Filter 'relay-endpoint.json' -EA SilentlyContinue | Select-Object -First 1
if (-not $descPath) { throw "找不到 relay-endpoint.json（relay 未启动？）" }
$desc = Get-Content $descPath.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $desc.mcpUrl) { throw "descriptor 缺少 mcpUrl" }
if (-not (Test-Path $desc.tokenFilePath)) { throw "找不到 relay token: $($desc.tokenFilePath)" }
$token = (Get-Content $desc.tokenFilePath -Raw).Trim()
# 复制到无空格路径（Start-Process 传参遇空格会被拆断）
$tokenCopy = Join-Path $ROOT 'app\config\secrets\relay-token'
[IO.File]::WriteAllText($tokenCopy, $token, (New-Object System.Text.UTF8Encoding($false)))
try { & icacls $tokenCopy /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 'SYSTEM:(R,W)' | Out-Null } catch { }
if (-not $Exposed -or $Exposed.Count -eq 0) {
  $mgrPath = Join-Path $ROOT 'config\mcp-manager.json'
  $cfgPath = Join-Path $ROOT 'app\config\config.json'
  if (Test-Path $mgrPath) {
    $Exposed = @((Get-Content $mgrPath -Raw -Encoding UTF8 | ConvertFrom-Json).exposedTools)
  } elseif (Test-Path $cfgPath) {
    $Exposed = @((Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).exposedTools)
  }
  if (-not $Exposed -or $Exposed.Count -eq 0) { throw '无法确定要暴露的工具：请提供 -Exposed，或创建 config\mcp-manager.json / app\config\config.json' }
}
$a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $ROOT 'app\scripts\start-adapter.ps1'),
       '-UpstreamUrl', $desc.mcpUrl, '-Port', $Port, '-Exposed', ($Exposed -join ','),
       '-UpstreamTokenFile', $tokenCopy)
if ($LocalOnly) { $a += '-LocalOnly' }
& powershell.exe @a