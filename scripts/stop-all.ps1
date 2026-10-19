# 停止全部本工程进程（身份校验式；绝不按名批量结束）
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
Write-Host "=== 停止 OAuth MCP 适配器 ===" -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ROOT 'app\scripts\stop-adapter.ps1')
Write-Host "=== 停止只读 Gateway ===" -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ROOT 'legacy\stop-readonly-mcp.ps1')
Write-Host "=== 剩余核验 ===" -ForegroundColor Cyan
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'dsh-gptbridge[\\\\/](app[\\\\/]server\.mjs|legacy[\\\\/]gateway[\\\\/]gateway\.mjs)' }
Write-Host ("  本工程残留进程: {0}" -f ($left | Measure-Object).Count)
Write-Host "  生产服务未触碰（DSH Web / Codex / cloudflared / another-project）"
