# 接入你自己的域名（Cloudflare Named Tunnel）

目标：让 `https://<你的子域>` 指向本机 `http://127.0.0.1:18080`，**不开放任何入站端口、不申请证书、不配 Nginx**。

> 为什么用 Cloudflare Tunnel：MCP 客户端（ChatGPT 连接器）要求公网 HTTPS + OAuth；而 relay 只监听 `127.0.0.1`。Tunnel 是出站连接，家里/公司网络没有公网 IP 也能用。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 域名 | 已托管在 Cloudflare（NS 指向 Cloudflare）。没有就在 Cloudflare 添加站点并按提示改 NS |
| 本机 | Windows；Node ≥ 22；DSH Web 已在跑（relay 在 `127.0.0.1:3079`）；本项目适配器已能在 `127.0.0.1:18080` 正常响应 |
| 端口 | **不需要**在路由器/防火墙开任何入站端口 |

子域名建议：`mcp.<你的域名>` 或更随机的 `dsh-mcp-<随机串>.<你的域名>`（降低被扫描概率）。

---

## 1. 安装 cloudflared

任选其一：

```powershell
winget install --id Cloudflare.cloudflared
# 或
scoop install cloudflared
# 或直接下载 cloudflared-windows-amd64.exe 重命名为 cloudflared.exe 放进 PATH
```

验证：

```powershell
cloudflared --version
```

---

## 2. 登录 Cloudflare（一次性）

```powershell
cloudflared tunnel login
```

浏览器会打开授权页 → 选择你的域名 → 授权。成功后本机生成用户证书（Windows 默认 `%USERPROFILE%\.cloudflared\cert.pem`）。

---

## 3. 创建 Named Tunnel

```powershell
cloudflared tunnel create dsh-gptbridge
```

输出类似：

```
Tunnel credentials written to C:\Users\<you>\.cloudflared\<TUNNEL-ID>.json
Created tunnel dsh-gptbridge with id <TUNNEL-ID>
```

把 `<TUNNEL-ID>.json` **复制到本仓库**（该目录已被 `.gitignore` 忽略，不会误提交）：

```
<repo>\config\tunnel\<TUNNEL-ID>.json
```

查询已有隧道：

```powershell
cloudflared tunnel list
```

---

## 4. 写隧道配置

新建 `<repo>\config\tunnel\config.yml`：

```yaml
tunnel: <TUNNEL-ID>
credentials-file: <repo>\config\tunnel\<TUNNEL-ID>.json

# 可选：指标端口（本机排查用）
metrics: 127.0.0.1:49312

no-autoupdate: true
protocol: http2

ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:18080
  # 需要的话可以再加别的服务，例如：
  # - hostname: dsh.example.com
  #   service: http://127.0.0.1:3079
  - service: http_status:404
```

要点：

- **最后一条必须是兜底**（`http_status:404`），否则 cloudflared 启动会报配置错误
- `credentials-file` 用**绝对路径**最稳（Windows 反斜杠请写成 `\\` 或用正斜杠）
- `ingress` 里的 `hostname` 必须和后面 DNS 绑定的域名完全一致

---

## 5. 绑定 DNS

命令行（推荐，自动建 CNAME 指向 `<TUNNEL-ID>.cfargotunnel.com` 并走 Cloudflare 代理）：

```powershell
cloudflared tunnel route dns dsh-gptbridge mcp.example.com
```

或在 Cloudflare Dashboard → DNS 手动添加：

| 类型 | 名称 | 内容 | 代理状态 |
|---|---|---|---|
| CNAME | `mcp` | `<TUNNEL-ID>.cfargotunnel.com` | **已代理（橙色云）** |

> 必须是橙色云（Proxied）。灰色云会绕过 Tunnel，直接解析到不存在的主机。

---

## 6. 启动隧道

前台试跑（先确认能通）：

```powershell
cloudflared tunnel --config <repo>\config\tunnel\config.yml run
```

本项目也带了一个受控启动器（会做前置校验、写日志、按身份记录 PID）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\app\scripts\start-tunnel.ps1 `
  -Config .\config\tunnel\config.yml -Credentials .\config\tunnel\<TUNNEL-ID>.json
```

后台常驻的几种常见做法（任选）：

```powershell
# A. 隐藏窗口
Start-Process cloudflared -WindowStyle Hidden -ArgumentList 'tunnel','--config','<repo>\config\tunnel\config.yml','run'

# B. 用 cloudflared 自带服务安装（需要管理员，会注册为 Windows 服务）
cloudflared service install
# 注意：服务方式用的是 %USERPROFILE%\.cloudflared\config.yml，与你仓库里的 profile 不同

# C. 交给自己的进程管理/计划任务（本项目不注册服务，按需自行决定）
```

---

## 7. 验证

```powershell
# 1) 元数据端点应 200
curl.exe -sS -o NUL -w "%{http_code}`n" https://mcp.example.com/.well-known/oauth-authorization-server

# 2) 无 token 调 MCP 应 401（说明 OAuth 在工作）
curl.exe -sS -o NUL -w "%{http_code}`n" -X POST `
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://mcp.example.com/mcp

# 3) 本机直连对照（应为同样结果）
curl.exe -sS -o NUL -w "%{http_code}`n" -X POST -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:18080/mcp
```

拿到 `200` / `401` 就说明链路通了。

---

## 8. 让适配器认识你的域名（必做）

改 `app\config\config.json`：

```json
{
  "publicUrl": "https://mcp.example.com",
  "allowedHosts": ["mcp.example.com"]
}
```

- `publicUrl` 决定 OAuth 的 `issuer` 与 `resource`（ChatGPT 会校验资源指示符）
- `allowedHosts` 用于 Host 头校验，防止别人拿这个服务当万能入口

改完重启适配器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bring-up-relay.ps1 -Port 18080
```

然后到 ChatGPT 里添加连接器，URL 填 `https://mcp.example.com/mcp`（详见 [CHATGPT-CONNECTOR.md](CHATGPT-CONNECTOR.md)）。

---

## 9. Cloudflare 侧的推荐设置

| 项 | 建议 | 原因 |
|---|---|---|
| SSL/TLS 模式 | **Full** 或 Full (strict) | Tunnel 到源站是 `http://127.0.0.1`，边缘证书由 Cloudflare 管；不要用 Flexible 之外的奇怪组合 |
| Always Use HTTPS | 开 | 避免明文入口 |
| 缓存规则 | 对 `/mcp`、`/.well-known/*`、`/token`、`/register`、`/authorize` **禁用缓存** | 这些是动态 API |
| WAF 自定义规则 | 拦截常见扫描路径（`/.env`、`/wp-login.php`、`/phpmyadmin` 等） | 公网暴露面越小越好 |
| Rate limiting | 对 `/authorize`、`/token` 加限速 | 本服务自身也有限速，双层更稳 |
| Cloudflare Access | **不建议**加在 `/mcp` 上 | Access 会拦住 ChatGPT 的 OAuth 回调，导致连接器无法工作 |
| Bot Fight Mode | 视情况关闭对 `/mcp` 的挑战 | 机器人挑战会打断 MCP 客户端 |

---

## 10. 常见错误对照

| 现象 | 含义 | 处置 |
|---|---|---|
| **502 Bad Gateway** | Tunnel 通了，但 `127.0.0.1:18080` 没人监听 | 适配器没跑：`scripts\bring-up-relay.ps1`；或 watchdog 没起 |
| **530 / 1033** | 边缘没找到隧道连接 / 隧道 ARGO 出错 | `cloudflared tunnel list` 看连接状态；`route dns` 是否指到正确 TUNNEL-ID |
| **1033 Argo Tunnel error** | 隧道进程没起或凭据不匹配 | 检查 `credentials-file` 路径与 TUNNEL-ID 是否一致 |
| **403 + Cloudflare 页面** | WAF/Access 拦了 | 对 `/mcp`、`/.well-known/*` 放行 |
| **SSL handshake failed (526/525)** | 边缘到源站证书问题 | 源站是 `http://`，确认 ingress 里写的是 `http://127.0.0.1:18080` |
| **401 一直不变** | 正常（未带 token） | 说明 OAuth 在工作；用连接器授权或用测试脚本走 PKCE |
| **`Invalid Host header` / 400** | `allowedHosts` 没加你的域名 | 补进 `allowedHosts` 并重启适配器 |

排查用日志：

```
<repo>\app\logs\service.out.log
<repo>\app\logs\service.err.log
<repo>\logs\watchdog.log
<repo>\logs\launcher-hook.log      # 如果接了 DSH 启动器
```

---

## 11. 不用 Named Tunnel 的替代方案

| 方案 | 说明 | 取舍 |
|---|---|---|
| Quick Tunnel（`cloudflared tunnel --url http://127.0.0.1:18080`） | 免域名，随机 `*.trycloudflare.com` | 每次重启换域名 → OAuth `publicUrl` 得跟着改，不适合长期 |
| Dashboard 创建隧道 + Token 启动 | 在 Cloudflare 面板建隧道，拿到 token 后 `cloudflared tunnel run --token <token>` | 不用本地 cert.pem，适合多机；但 token 也是敏感凭据 |
| 反向代理 + 自己签证书 | Nginx/Caddy + Let's Encrypt | 需要公网 IP + 开 80/443，运维成本更高 |

不论哪种，**只要最终 TLS 终止后转发到 `127.0.0.1:18080`，本项目都不用改**；只需把 `publicUrl` / `allowedHosts` 改成实际对外域名。
