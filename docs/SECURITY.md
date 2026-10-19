# 安全与密钥管理

## 0. 一句话

**授权口令 = 能在你的工作区里读写文件、起子进程的权限。** 把它当成"本机 shell 密码"对待。

## 1. 权限边界（这个项目到底能干什么）

被授权的 MCP 客户端可以：

- 列出 DSH 工作区与会话
- 在指定工作区**只读**（`start_review`）或**可写**（`start_run`，`workspace-write`）地派发任务
- 让 DSH 在工作区里读写文件、执行命令（DSH 自身的沙箱/策略决定边界）
- 归档终态会话（从侧栏隐藏）

**不能**通过本项目：

- 直接访问工作区以外的文件（由 DSH 的 `cwd-allow` 与 permission preset 决定，不是本项目）
- 拿到 relay 的 bearer token（适配器内部持有，不向客户端暴露）
- 拿到 DSH 的浏览器会话授据（只在服务端内存中用于签名）

## 2. 密钥清单与落点

| 密钥 | 位置 | 生成方式 | 备注 |
|---|---|---|---|
| owner 口令 | `app/config/secrets/OWNER-PASSWORD.txt` | `init-auth.ps1` 随机生成 | 授权页要输入；可自行改成好记的强口令，但别用字典词 |
| pepper | `app/config/secrets/pepper.txt` | `init-auth.ps1` | 参与哈希，泄露等于降低口令强度 |
| client 记录加密密钥 | `app/config/secrets/owner.json` | `init-auth.ps1` | 用于加密存储的 client secret（如果有） |
| relay bearer token | `app/config/secrets/relay-token` | `start-relay-adapter.ps1` 从 DSH 复制 | 每次启动复制；DSH 轮换后自动跟上 |
| 隧道凭据 | `config/tunnel/<TUNNEL-ID>.json` | `cloudflared tunnel create` | 等价于隧道身份，泄露可接管隧道 |
| DSH 浏览器授据 | DSH 自己的 `.credentials.yaml` | DSH 生成 | 本服务**只读**用于 HMAC 签名，不复制不落盘 |

以上全部在 `.gitignore` 里；`init-auth.ps1` 会尝试用 `icacls` 收紧目录 ACL（仅当前用户 + SYSTEM + Administrators）。

## 3. 部署建议

1. **只给自己的私用连接器**授权；不要把授权页发给别人
2. 子域用**随机串**（如 `dsh-mcp-a1b2c3.<域名>`），不要用 `dsh.<域名>` 这种容易被扫到的
3. Cloudflare 侧：`Always Use HTTPS` 开；对 `/mcp`、`/.well-known/*`、`/token`、`/register`、`/authorize` 禁缓存；WAF 拦常见扫描路径
4. **不要**在 `/mcp` 上叠 Cloudflare Access（会打断 OAuth 回调）
5. 服务器若多人共用：用独立 Windows 账户跑适配器，别用管理员账户
6. 定期轮换：删掉 `app/state/*.sqlite` 会吊销所有已发令牌（客户端要重新授权）；删 `OWNER-PASSWORD.txt` 后重跑 `init-auth.ps1` 会换口令
7. 审计：所有 `/mcp` 调用、授权、token 签发都进 `app/state/*.sqlite` 的 audit 表；`logRetentionDays` / `auditRetentionDays` 控制保留

## 4. 已知风险（如实说明）

| 风险 | 说明 | 缓解 |
|---|---|---|
| 同机同账户可读凭据 | `app/config/secrets/*` 对当前用户可读；任何以该用户身份运行的进程都能读 | 用独立低权限账户跑服务；机器本身可信 |
| 口令即权限 | 口令泄露 = 对方可在你工作区执行任务 | 强口令 + 不公开授权页 + 定期轮换 + 监控 audit |
| DSH 授据依赖 | 归档/改名依赖 DSH 的 `.credentials.yaml`；DSH 若改变授据格式，这两个功能会先失败（MCP 其他工具不受影响） | 失败时返回 `archive_pending`/`grant_unavailable`，不 panic |
| 公网暴露面 | 授权服务器在公网 | 限速已内置（register/token/authorize 各有上限）+ Cloudflare WAF |
| 无 Windows 服务封装 | 进程被杀需要 watchdog 拉起；机器重启需人工/计划任务 | 可自行注册计划任务（本项目不改系统配置） |

## 5. 出问题时先关哪里

```powershell
# 立刻断掉外部访问（保留本机调试）
powershell -File .\scripts\stop-all.ps1

# 只停隧道
Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 18080).OwningProcess   # 不推荐，按 PID 先确认

# 吊销所有令牌（客户端需重新授权）
Remove-Item .\app\state\*.sqlite
```
