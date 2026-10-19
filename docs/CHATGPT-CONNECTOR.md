# 在 ChatGPT 里配置连接器

## 1. 前提

- 已完成 [DOMAIN-AND-CLOUDFLARE.md](DOMAIN-AND-CLOUDFLARE.md)：`https://<你的域名>` 能返回 200（元数据端点）
- 适配器正在跑：`curl http://127.0.0.1:18080/mcp` 无 token 应 401
- `app/config/config.json` 的 `publicUrl` / `allowedHosts` 已改成你的域名

## 2. 添加连接器

1. ChatGPT → 设置 → **连接器 / Connectors** → 添加自定义连接器
2. 名称随意（例如 `dsh`）
3. MCP 服务器 URL：**`https://<你的域名>/mcp`**
   - 注意结尾是 `/mcp`；不要写成根路径
   - 认证方式选 **OAuth**（本服务自带 DCR，不需要你手填 client id/secret）
4. 保存后点"连接/授权"，会弹出授权页

## 3. 授权

授权页只有一件事：输入 **owner 口令**

```
<repo>\app\config\secrets\OWNER-PASSWORD.txt
```

输对 → 302 回到 ChatGPT → 拿到 access token（1 小时）+ refresh token（30 天）。

> 如果口令忘了：删掉该文件后重跑 `app\scripts\init-auth.ps1`，然后删连接器重新添加。

## 4. 会话一旦连上，先用这三条确认

```text
1) list_workspaces
2) list_capabilities
3) node <repo>\app\tests\run-relay.mjs       # 本机侧自检，7 项应全 PASS
```

`list_workspaces` 会返回 DSH 里的工作区（`workspaceId` / `path` / `title` / `sessionCount`），`list_capabilities` 返回默认的 `provider` / `model` / `reasoningEffort`。

## 5. 一个最小可用的派发提示词

```text
你现在有 dsh 连接器（16 个工具）。按顺序执行，不要跳步：

1) list_workspaces → 确认存在 path = "<你的工作区路径>"
2) list_capabilities → 记下 models.default 的 provider / model / reasoningEffort
3) start_review 参数：
   workspace: "<你的工作区路径>"
   task: "只读核对：本工作区 README.md 有多少行、一级标题是什么。不要修改任何文件。"
   provider / model / reasoningEffort: 用第 2 步拿到的默认值
   authorizationBasis: "explicit-user-request"
   sessionMode: "fresh"
   openBrowser: false
   idempotencyKey: "read-<时间戳>"
4) wait_run { runId, timeoutMs: 20000 } 反复调用，直到 status ∈
   {succeeded, failed, cancelled, timeout, orphaned}
5) 贴 assistantText 原文

注意：不要调用 archive_terminal_session，我要在 DSH 侧栏继续看到这条会话。
```

派发成功后：

- 会话由 **DSH 自己创建**（`session-<uuid>`），自动出现在对应工作区
- 标题会在 run 终态后被改成 **`gpt指派-<原标题>`**
- 想让会话一直可见 → 不要归档；想清理 → 才调 `archive_terminal_session`

## 6. 常见连接器问题

| 现象 | 原因 | 处置 |
|---|---|---|
| 添加后就报 unauthorized | 口令错 / 令牌过期 | 重新授权；口令以 `OWNER-PASSWORD.txt` 为准 |
| 保存连接器失败、提示无法验证 | URL 不是 `/mcp` 或公网不可达 | 用 curl 验证 `https://<域名>/.well-known/oauth-authorization-server` |
| 工具列表为空 | 上游 relay 不可用（工具表不缓存失败） | 重启 DSH 后重连；或先跑 `run-relay.mjs` 看工具面 |
| 只能看到很少工具 | `exposedTools` 被改小 | 改 `app/config/config.json` 后重启适配器 |
| 每次都要重新授权 | refresh 被拒（删过 sqlite / 密钥变了） | 属预期：删连接器重新添加 |
