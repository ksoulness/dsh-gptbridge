# 架构

## 1. 组件与职责

```
┌──────────────┐   HTTPS + OAuth 2.1    ┌────────────────────┐
│  外部 MCP 端  │ ─────────────────────► │  Cloudflare Tunnel │  TLS 终结、DNS、WAF
│ (ChatGPT 等)  │ ◄───────────────────── │  (出站连接回源)     │
└──────────────┘                        └─────────┬──────────┘
                                                  │ http://127.0.0.1:18080
                                        ┌─────────▼──────────┐
                                        │  dsh-gptbridge      │
                                        │  ├ /register (DCR)  │
                                        │  ├ /authorize (口令) │  本项目
                                        │  ├ /token  (PKCE)   │
                                        │  ├ /.well-known/... │
                                        │  └ /mcp    (MCP RS) │
                                        └─────────┬──────────┘
                                                  │ Bearer <relay-token>
                                        ┌─────────▼──────────┐
                                        │ DSH relay 插件      │  127.0.0.1:3079
                                        │ (25 个 MCP 工具)    │
                                        └─────────┬──────────┘
                                                  ▼
                                        ┌────────────────────┐
                                        │ DSH 本体            │
                                        │ 原生建会话/工作区    │
                                        └────────────────────┘
```

本服务内部模块：

| 文件 | 职责 |
|---|---|
| `app/server.mjs` | HTTP 入口、路由、端点文件、审计、上游构造、优雅退出 |
| `app/auth/oauth.mjs` | 授权服务器：元数据、DCR、authorize、token、refresh、revoke |
| `app/auth/store.mjs` | SQLite 持久化：client / code / token / audit |
| `app/auth/guard.mjs` | `/mcp` 的 Bearer 校验 + scope 判定 |
| `app/auth/csrf.mjs`、`ratelimit.mjs` | 授权页 CSRF、分端点限速 |
| `app/gateway/mcp.mjs` | MCP 协议层：`initialize` / `tools/list` / `tools/call`、白名单、参数校验、标题前缀钩子 |
| `app/gateway/upstream.mjs` | 到 relay 的 JSON-RPC 客户端（loopback、超时、响应上限、请求头工厂） |
| `app/gateway/delegation.mjs` | 本地工具：`archive_terminal_session`；会话标题 rename；官方 API 调用 + HMAC cookie |

## 2. 鉴权链

```
ChatGPT ──(1) GET /.well-known/oauth-authorization-server
        ──(2) POST /register            → client_id（DCR，无需预注册）
        ──(3) GET  /authorize?...PKCE…  → 授权页（CSRF token）
        ──(4) POST /authorize           → 302 ?code=…
        ──(5) POST /token (code+verifier) → access_token
        ──(6) POST /mcp  Authorization: Bearer access_token
```

- access token 默认 1 小时，refresh token 30 天（可在 config 里改）
- PKCE 强制 S256；`resource` 参数与 `publicUrl` 绑定
- `/mcp` 无 token → 401 + `WWW-Authenticate`，不泄漏内部信息

## 3. 工具白名单

`config.json` 三个列表共同决定可见面：

- `exposedTools`：对客户端展示哪些（默认 16）
- `allowedReadTools` / `allowedControlTools`：实际放行哪些（防止"展示但可调"或"可调但隐藏"）

调用时还会做**参数键校验**：只接受工具 `inputSchema` 里声明的参数名，多余参数直接 `-32602`。

## 4. 上游热更新（DSH 重启不炸）

relay 的 bearer token 会随 DSH 重启重新签发。`server.mjs` 里：

```js
// 按 mtime 变化重读，不缓存旧 token
const st = statSync(tokenFile)
if (st.mtimeMs !== tokenCache.mtimeMs) tokenCache = { value: readFileSync(...), mtimeMs: st.mtimeMs }
```

`upstream.mjs` 提供 `headersFactory`，于是**每次请求**都带当前 token；`mcp.mjs` 在上游失败时**不缓存**工具表（避免 30 秒残缺）。

## 5. 会话落地流程

```
start_review/start_run
   │  (适配器给 task 加前缀)
   ▼
relay → DSH 创建 session-<uuid>（DSH 自己登记工作区，侧栏自动归组）
   │
   ├─ 客户端轮询 wait_run
   │      └─ 首次拿到终态时：适配器读 session 的当前标题，
   │         调 POST /api/session/rename 改成 `gpt指派-<原标题>`（幂等）
   │
   └─ archive_terminal_session
          └─ POST /api/workspace/archiveSession（HMAC cookie 来自
             DSH 的 .credentials.yaml 里 client-connection/browser-session 授据）
```

两个本地 API 调用都用同一套「浏览器会话 cookie」鉴权：把授据 secret 做 HMAC 生成 `dsh-auth-<sha256(authority)>=v1.<body>.<sig>`，不依赖 DSH 内部代码。

## 6. 进程模型

| 进程 | 说明 |
|---|---|
| 适配器（`node app/server.mjs`） | 单进程；监听 `adapterPort`（默认 18080） |
| watchdog | PowerShell 循环，60s 探活（进程 + 端口），挂了就调 `start-relay-adapter.ps1`；单实例锁 `logs\watchdog.lock`；心跳 `logs\watchdog.heartbeat` |
| 隧道（cloudflared） | 独立进程，可交给服务/计划任务 |

与 DSH 启动器的钩子（可选）：DSH 启动成功 → `on-dsh-ready.ps1`（等 relay token → `bring-up-relay.ps1`）；DSH 关闭 → `on-dsh-stop.ps1`（先停 watchdog 再停适配器）。详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
