# dsh-gptbridge · 初始化本地 OAuth 密钥（仅本机；不写 Git、不进日志）
#
# 生成：
#   config\secrets\pepper.txt   —— 令牌摘要用的服务端 pepper（48 字节随机）
#   config\secrets\owner.json   —— Owner 口令的 scrypt 摘要（授权页确认用）
#
# 只在首次运行；若已存在则拒绝覆盖（避免让既有 token 失效）。

[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$SEC = Join-Path $ROOT 'config\secrets'
New-Item -ItemType Directory -Force -Path $SEC | Out-Null

if ((Test-Path (Join-Path $SEC 'pepper.txt')) -and -not $Force) {
  Write-Host "已存在 config\secrets\pepper.txt；如需轮换请加 -Force（会使所有既有 token 立即失效）" -ForegroundColor Yellow
  exit 0
}

# 非交互：设置 DSH_GPTBRIDGE_OWNER_PASSWORD 环境变量即可（CI/自动化用）；否则交互输入
if ($env:DSH_GPTBRIDGE_OWNER_PASSWORD) {
  $plain = $env:DSH_GPTBRIDGE_OWNER_PASSWORD
  Write-Host "使用环境变量 DSH_GPTBRIDGE_OWNER_PASSWORD 作为 Owner 口令（长度 $($plain.Length)）" -ForegroundColor DarkGray
} else {
  $sec = Read-Host "设置本机 Owner 口令（授权页确认用，不回显；至少 8 位）" -AsSecureString
  if ($sec.Length -lt 8) { Write-Host "FAIL: 口令至少 8 位" -ForegroundColor Red; exit 1 }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $plain -or $plain.Length -lt 8) { Write-Host "FAIL: 口令至少 8 位" -ForegroundColor Red; exit 1 }

# 用 node 生成 scrypt 摘要与 pepper（避免在 PowerShell 里手工实现）
$tmp = Join-Path $env:TEMP ("dsh-init-" + [guid]::NewGuid().ToString('N') + ".mjs")
@'
import { scryptSync, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
const out = process.argv[2]
const pw = readFileSync(process.argv[3], "utf8").trim()
const salt = randomBytes(16)
const N = 131072, r = 8, p = 1   // OWASP 级内存成本（2^17）
const hash = scryptSync(pw, salt, 64, { N, r, p, maxmem: 512 * 1024 * 1024 })
writeFileSync(out + "\\owner.json", JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex"), n: N, r, p, created_at: new Date().toISOString() }, null, 2))
writeFileSync(out + "\\pepper.txt", randomBytes(48).toString("hex"))
'@ | Set-Content $tmp -Encoding utf8
$pwFile = Join-Path $env:TEMP ("dsh-init-pw-" + [guid]::NewGuid().ToString('N') + ".txt")
[IO.File]::WriteAllText($pwFile, $plain, (New-Object System.Text.UTF8Encoding($false)))
$plainForFile = $plain
$plain = $null
try { & node $tmp $SEC $pwFile | Out-Null } finally { Remove-Item $pwFile, $tmp -Force -ErrorAction SilentlyContinue }

$ok = (Test-Path (Join-Path $SEC 'owner.json')) -and (Test-Path (Join-Path $SEC 'pepper.txt'))
if (-not $ok) { Write-Host "FAIL: 生成失败" -ForegroundColor Red; exit 1 }
# 收紧目录 ACL：仅当前用户与 SYSTEM/Administrators 可访问
try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $aclGrant = '{0}:(OI)(CI)F' -f $me
  & icacls $SEC /inheritance:r /grant:r $aclGrant 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
  Write-Host "OK  : 已收紧 $SEC 的 ACL（仅当前用户/SYSTEM/Administrators）" -ForegroundColor Green
} catch { Write-Host "WARN: ACL 收紧失败，请手动检查 $SEC 权限" -ForegroundColor Yellow }

# 便于本机查阅授权口令：写一份明文到 secrets（已被 .gitignore 忽略）
try {
  $pwPath = Join-Path $SEC 'OWNER-PASSWORD.txt'
  [IO.File]::WriteAllText($pwPath, $plainForFile, (New-Object System.Text.UTF8Encoding($false)))
  & icacls $pwPath /inheritance:r /grant:r ("{0}:(R,W)" -f [Security.Principal.WindowsIdentity]::GetCurrent().Name) 'SYSTEM:(R,W)' | Out-Null
  Write-Host "OK  : Owner 口令已写入 $pwPath（明文，仅本机可读；授权页要用它）" -ForegroundColor Green
} catch { Write-Host "WARN: 未能写入 OWNER-PASSWORD.txt，请自行记住口令" -ForegroundColor Yellow }

Write-Host "OK  : 已生成 $SEC\owner.json 与 pepper.txt（内容未显示）" -ForegroundColor Green
Write-Host "      这些文件必须保持私密；不要提交 Git、不要粘贴到聊天中。" -ForegroundColor Yellow