# 排障手册

先记住三段日志的位置：

```
app\logs\service.out.log     适配器标准输出（含 REMOTE_MCP_LISTEN 端口）
app\logs\service.err.log     适配器错误
logs\watchdog.log            守护进程探活记录
logs\launcher-hook.log       与 DSH 启动器联动时的钩子日志（可选）
```

---

## 1. 症状 → 处置

| 症状 | 最可能原因 | 处置 |
|---|---|---|
| ChatGPT 报 `-32603 Internal error`，工具名正常 | 上游/本服务不可达，公网 502 | 先查 `https://<域名>/.well-known/oauth-authorization-server` 是否 200；502 就是适配器没跑 |
| 公网 502 | `127.0.0.1:18080` 没人监听 | `scripts\bring-up-relay.ps1 -Port 18080`；再确认 watchdog 在跑 |
| 公网 530/1033 | 隧道未连上/凭据不匹配 | `cloudflared tunnel list`；核对 `credentials-file` 与 TUNNEL-ID |
| 无 token 调 `/mcp` 返回 200 | 鉴权没生效（配置异常） | 检查是否误改了 `allowedHosts`/`publicUrl`；重启适配器 |
| 工具数是 1 或明显偏少 | 上游 relay 不可用（token 旧/DSH 未起） | 看 `service.err.log`；确认 DSH 在跑、`relay-endpoint.json` 存在 |
| `relay_descriptor_missing` | DSH 没起或 relay 插件未启用 | 启动 DSH；确认 `plugins\dsh-relay\web\relay-endpoint.json` |
| `grant_unavailable` / `archive_pending` | DSH 的浏览器授据变了或不存在 | 让 DSH 重新生成 `.credentials.yaml`；本服务会自动重签一次 cookie 重试 |
| `UNAUTHORIZED` 且连接器一直要求重新授权 | token 过期/被吊销 | 删连接器重新添加，或用 `node app\tests\run-relay.mjs` 走一遍 OAuth 自检 |
| `INVALID_PARAMS: unexpected [...]` | 客户端传了工具 schema 之外的参数 | 只传 `list_capabilities` 里声明的参数 |
| 会话没出现在工作区 | 任务被归档了（归档 = 从侧栏隐藏） | 取消归档，或下次不要调 `archive_terminal_session` |
| 会话标题没有 `gpt指派-` 前缀 | run 未到终态 / rename 失败 | 等 `wait_run` 到 `succeeded`；看 audit 里 `session_title_prefixed` |

---

## 2. 常用自检

```powershell
# 端口与进程
Get-NetTCPConnection -State Listen -LocalPort 18080
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'app\\server\.mjs' }

# 本机直连（应 401）
curl.exe -sS -o NUL -w "%{http_code}`n" -X POST -H "content-type: application/json" `
  -H "accept: application/json, text/event-stream" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:18080/mcp

# OAuth + 工具面 + 目标工作区（默认不发真实任务）
$env:DSH_BASE='http://127.0.0.1:18080'
node .\app\tests\run-relay.mjs

# 全链路（会真实调用模型）
$env:DO_RUN='1'; $env:WS='E:\example-workspace'; node .\app\tests\run-relay.mjs

# 回归（9 项）
node .\app\tests\run-regress.mjs
```

---

## 3. 守护进程（watchdog）

```powershell
# 启动（隐藏窗口常驻）
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',
  '.\scripts\watchdog-adapter.ps1','-Port','18080','-IntervalSeconds','60'
)

# 判断是否在跑：直接看心跳（比抓进程名可靠）
Get-Item .\logs\watchdog.heartbeat | Select-Object LastWriteTime

# 单实例锁：一个 watchdog 会独占 logs\watchdog.lock，第二个启动即退出
```

行为：每 60 秒检查「适配器进程存在 **且** 端口在听」；任一不满足就调 `start-relay-adapter.ps1` 重新拉起。

---

## 4. 与 DSH 生命周期联动（可选）

如果你的 DSH 有自己的启动器（如 `DeepSeek-Harness.ps1`），可以在两处挂钩子：

| 时机 | 调用 |
|---|---|
| DSH 启动成功（HTTP 可访问）之后 | `scripts\on-dsh-ready.ps1` |
| DSH 关闭之后 | `scripts\on-dsh-stop.ps1` |

`on-dsh-ready.ps1` 会：等 relay 的 descriptor + token 就绪（≤180s）→ 调 `bring-up-relay.ps1 -SkipIfHealthy`
（**已在运行就不重启适配器**，只确保 watchdog）。

`on-dsh-stop.ps1` 会：先停 watchdog（否则它会把适配器又拉起来）→ 再停适配器。

> 只重启 DSH 时不要调 stop 钩子：适配器可以一直活着，因为 token 是每次请求现读的。

---

## 5. 踩坑记录（省你几小时）

1. **中文脚本必须 UTF-8 BOM**
   PowerShell 5.1 按 ANSI 读无 BOM 文件，中文注释的乱码会吞掉后面的语句，表现为 `Test-Path $var` 收到 null。

2. **不要用 `& powershell -File xxx.ps1 | ForEach-Object` 调会留下常驻子进程的脚本**
   孙进程继承管道句柄 → 管道永不关闭 → 调用方永不返回（实测挂死 7 分钟）。
   统一改成 `Start-Process -RedirectStandardOutput <file>` + `WaitForExit()`。

3. **`Start-Process -ArgumentList` 遇空格会拆参数**
   路径含空格（如 `D:\Program Files\...`）必须先把 token 之类的文件复制到无空格路径再传。

4. **端口/进程双条件判断**
   只看 PID 会被"进程活着但没监听"骗过；只看端口会被"别的进程占用"骗过。

5. **归档 = 从侧栏隐藏**
   DSH 的 `archiveSession` 不会删数据，只是从工作区列表移除；`unarchiveSession` 可恢复。

6. **kill 进程要在独立进程里做**
   在自动化/作业里直接 `Stop-Process` 正在被跟踪的进程，可能触发宿主"作业范围未清空"报错。用脚本 + 身份校验（`legacy/gateway/proc-kill.mjs`）更稳。
