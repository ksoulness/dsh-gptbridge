# legacy：ACP 网关（保留参考，不再维护）

这个目录放的是本项目**早期**的方案：`dsh-gptbridge` 直接把 DSH 的 **ACP** 进程当成上游，自己实现工具（`dsh_health` / `dsh_git_*` / `dsh_task_*` …）。

## 为什么被替换

| 维度 | ACP 方案（legacy） | Relay 方案（当前主线） |
|---|---|---|
| 会话归属 | 由外挂 ACP 创建 → 不在 DSH 工作区登记表里 → 侧栏只会出现在「未分组」 | 由 **DSH 自己创建** `session-<uuid>` → 自动写进 `workspace.json` → 精准归组 |
| 会话复用/归档 | 需要自己复制会话文件、自己改登记表（还要重启 DSH 才生效） | relay 原生支持；归档走官方 `workspace/archiveSession` |
| 上游协议 | ACP 子进程（JSON-RPC over stdio） | MCP over HTTP（`127.0.0.1:3079/plugins/dsh-relay/mcp`） |
| 维护成本 | 要跟着 DSH 内部细节走 | 只依赖 relay 的公开工具面 |

结论：**新部署请用主线（relay 方案），不要用 legacy。**

## 目录内容

| 文件 | 说明 |
|---|---|
| `gateway/*.mjs` | ACP 网关：`gateway.mjs`（主循环）、`acp-client.mjs`（stdio JSON-RPC 客户端）、`tools.mjs`（工具实现）、`policy.mjs`（路径/命令策略）、`procguard.mjs`、`registry.mjs`、`git-tools.mjs`、`proc-kill.mjs`（身份校验式结束进程，主线也在用）、`proc-status.mjs` |
| `start-readonly-mcp.ps1` / `stop-readonly-mcp.ps1` | 早期启动脚本（需自行准备 ACP HOME 与凭据环境变量） |
| `acp-local-overlay.example.yml` | DSH 的 ACP overlay 示例（`baseURL` / `apiKeyEnv` / provider / model 由你自填） |

## 如果一定要用

1. 准备一个 DSH HOME（可以是 DSH 本体同一个 HOME，也可以隔离）
2. 在 HOME 的 `.credentials.yaml` 里放一条 provider 凭据，并把它作为**环境变量**注入（不要写进命令行）
3. 按 `acp-local-overlay.example.yml` 写 overlay，指向你的模型服务
4. 启动：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\legacy\start-readonly-mcp.ps1
   ```
5. 适配器侧仍可用 `app\scripts\start-adapter.ps1 -UpstreamUrl http://127.0.0.1:<port>/mcp`

> 注意：legacy 的工具名（`dsh_*`）与主线（relay 语义）不同，两者不要混用同一份 `config.json` 白名单。
