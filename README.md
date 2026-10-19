# dsh-gptbridge

把 **外部 MCP 客户端**（ChatGPT 连接器 / Codex / 其他支持 MCP 的 agent）安全地接到**本机 DSH（DeepSeek Harness）**上。

一句话：**它是 DSH Relay 的「公网 OAuth 桥」——外部用 OAuth 2.1 + HTTPS 进来，内部用静态 Bearer 转到本机 Relay。**

```
ChatGPT / 任意 MCP 客户端
        │  HTTPS + OAuth 2.1 (PKCE, DCR)
        ▼
  Cloudflare Named Tunnel  ← 你的域名，TLS 由 Cloudflare 终结
        │  http://127.0.0.1:18080
        ▼
  dsh-gptbridge（本项目，Node 服务）
        │  Authorization: Bearer <relay-token>
        ▼
  DSH 里的 relay 插件  http://127.0.0.1:3079/plugins/dsh-relay/mcp
        ▼
  DSH 本体（原生创建会话 → 自动归到对应工作区）
```

## 为什么需要这一层

| DSH 里的 relay 插件 | 外部 MCP 客户端的要求 |
|---|---|
| 只监听 `127.0.0.1:3079` | 必须公网 HTTPS |
| 只认静态 bearer token | 必须 OAuth 2.1 + PKCE + 动态客户端注册 |
| 暴露全部 25 个工具 | 通常只需要一个受控子集 |

本项目正好补这三件事：**公网 TLS 入口（靠 Cloudflare Tunnel）+ OAuth 2.1 授权服务器 + 工具白名单代理**，另外补一个 relay 没有的本地工具 `archive_terminal_session`（归档会话，直接调 DSH 官方 API）。

## 特性

- **OAuth 2.1 授权服务器**：`/.well-known/oauth-authorization-server`、`/register`（DCR）、`/authorize`（口令页 + CSRF）、`/token`（PKCE）、`/revoke`；令牌存 SQLite
- **MCP Resource Server**：`POST /mcp`（Streamable HTTP，JSON-RPC 2.0），无 token 一律 401
- **工具白名单**：只放行配置里的工具，其余拒绝；默认 16 个（relay 15 + 本地归档 1）
- **上游热更新**：每次请求按 token 文件 mtime 重读 relay token —— DSH 重启换了 token，本服务自动跟上，**不用重启**
- **工具表不缓存失败**：上游短暂不可用时不会把残缺的工具表缓存 30 秒
- **标题前缀**：派发任务时给 `task` 自动加前缀；run 到达终态后调 DSH 官方 `session/rename` 把会话标题统一成 `gpt指派-<原标题>`
- **进程守护**：`watchdog-adapter.ps1` 每 60 秒探活，挂了自动拉起；与 DSH 启动器同启同停（可选）
- **一切都有审计**：审计事件落 SQLite；秘密只落 `app/config/secrets`（ACL 收紧、gitignore）

## 快速开始（Windows / PowerShell）

> 前提：本机已安装并运行 **DSH Web**（默认 `D:\Program Files\DSH`，监听 `127.0.0.1:3079`），且 **relay 插件已启用**（`plugins\dsh-relay\web\relay-endpoint.json` 存在）。

```powershell
# 0) 放置到任意目录，例如 E:\Code\Tools\dsh-gptbridge

# 1) 生成 OAuth 凭据（owner 口令 + pepper + 客户端记录加密密钥）
powershell -NoProfile -ExecutionPolicy Bypass -File .\app\scripts\init-auth.ps1

# 2) 复制配置并按需修改（publicUrl / allowedHosts / 工具白名单）
Copy-Item .\app\config\config.example.json .\app\config\config.json

# 3) 拉起适配器（自动读 DSH relay 的 descriptor 与 token）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-relay-adapter.ps1 -Port 18080

# 4) 自检：OAuth 全链路 + 工具面 + 目标工作区
$env:DSH_BASE='http://127.0.0.1:18080'
node .\app\tests\run-relay.mjs        # 7 项，不发真实任务
$env:DO_RUN='1'; node .\app\tests\run-relay.mjs   # 全闭环：start_review → wait_run → (可选) 归档
```

`init-auth.ps1` 会**交互提示**你设置 Owner 口令（不回显），并把它同时写到
`app/config/secrets/OWNER-PASSWORD.txt`（明文、仅本机可读，已被 `.gitignore` 忽略）——授权页要输入的就是它。

需要非交互（CI/自动化）时：

```powershell
$env:DSH_GPTBRIDGE_OWNER_PASSWORD='你的强口令(>=8位)'
powershell -NoProfile -ExecutionPolicy Bypass -File .\app\scripts\init-auth.ps1
```

轮换口令/pepper（会让所有既有令牌立即失效）：加 `-Force` 重跑。

## 接到你自己的域名（Cloudflare Named Tunnel）

完整步骤见 **[docs/DOMAIN-AND-CLOUDFLARE.md](docs/DOMAIN-AND-CLOUDFLARE.md)**，最小版：

```powershell
cloudflared tunnel login
cloudflared tunnel create dsh-gptbridge
# 把生成的 <TUNNEL-ID>.json 放到 config\tunnel\，把下面写进 config\tunnel\config.yml：
#   tunnel: <TUNNEL-ID>
#   credentials-file: <repo>\config\tunnel\<TUNNEL-ID>.json
#   ingress:
#     - hostname: mcp.example.com
#       service: http://127.0.0.1:18080
#     - service: http_status:404
cloudflared tunnel route dns dsh-gptbridge mcp.example.com
cloudflared tunnel --config .\config\tunnel\config.yml run
```

然后：

1. 把 `app\config\config.json` 的 `publicUrl` 改成 `https://mcp.example.com`，`allowedHosts` 加上 `mcp.example.com`
2. 在 ChatGPT 里添加自定义连接器，URL 填 `https://mcp.example.com/mcp`
3. 授权页输入 `OWNER-PASSWORD.txt` 里的口令

## 工具面（默认 16 个）

| 工具 | 作用 |
|---|---|
| `list_workspaces` / `list_workspace_sessions` / `list_capabilities` | 列工作区、列会话、查 provider/model |
| `start_review` | 只读派发（权限 preset 固定只读） |
| `start_run` | 可写派发（`workspace-write`） |
| `get_run` / `get_run_summary` / `list_runs` / `get_operation` | 查运行态与台账 |
| `wait_run` | 轮询到终态（单次 ≤30s，未终态就再调） |
| `steer_run` / `reply_run` / `cancel_run` | 纠偏、续对话、取消 |
| `read_notifications` / `doctor` | 通知投影、自检 |
| `archive_terminal_session` | **本项目提供**：归档终态会话（调 DSH `workspace/archiveSession`） |

> relay 自身还有 `setup_*` / `start_service` / `stop_service` / `open_service` 等 10 个运维工具，默认**不暴露**。

## 权限与"卡住"（重要）

relay 的三个权限档：`read-only` / `workspace-write` / `danger-full-access`。

- **`start_review` 永远是 `read-only`**（relay 设计如此，不接受 `permissionPreset`）。要写东西必须用 `start_run`。
- `start_run` 如果调用方**不传** `permissionPreset`，relay 默认也是 `read-only`；而 `workspace-write` 一旦碰到越界写入或需要确认的动作，会**等人点确认** —— 远端连接器没人点，表现就是"卡住不动"。
- 因此本适配器对 `start_run` 做了默认注入：`permissionPreset` 取 `app/config/config.json` 的 `runPermissionPreset`（默认 `danger-full-access`），并在选到危险档时补 `confirmedDangerousPermission: true`。

想收紧就改配置：

```jsonc
// app/config/config.json
{ "runPermissionPreset": "workspace-write" }   // 或 "read-only"
```

> `danger-full-access` 意味着模型在你机器上几乎不受限（可写工作区外、可起进程）。只给自己的私用连接器，别共享授权页。

另外暴露了第 17 个工具 **`reconcile_permissions`**（参数只有 `sessionId`）：当某会话因为权限被降级/"需要关注"而停住时，用它重试恢复原权限档。
## 目录结构

```
app/                 适配器本体（server.mjs + gateway/ + auth/ + scripts/ + tests/ + config/）
scripts/             生命周期脚本（relay 拉起、watchdog、DSH 启动器钩子）
legacy/              旧的 ACP 网关实现（保留参考，不再维护）
docs/                架构、域名接入、安全、排障
```

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [接入自己的域名（Cloudflare Tunnel）](docs/DOMAIN-AND-CLOUDFLARE.md)
- [安全与密钥管理](docs/SECURITY.md)
- [排障手册](docs/TROUBLESHOOTING.md)
- [在 ChatGPT 里配置连接器](docs/CHATGPT-CONNECTOR.md)
- [legacy：ACP 网关](legacy/README.md)

## 边界与免责

- 本项目**不是** DSH 官方组件，也不包含 DSH 本体的任何代码；它只按 DSH 暴露的 HTTP API 与 relay 的 MCP 协议工作。
- 它会把「在工作区里读写文件 + 起子进程」的能力开放给你授权的 MCP 客户端。**授权口令 = 代码执行权限**，请只给自己的私用连接器，别公开授权页。
- 未做 Windows 服务封装：进程生命周期由脚本/启动器管理，机器重启后需重新拉起（有 watchdog，但不跨重启）。

## License

MIT
