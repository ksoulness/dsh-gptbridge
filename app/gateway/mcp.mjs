/**
 * MCP 适配器（Resource Server 的协议层）
 * 只暴露配置白名单中的只读工具，tools/call 转发到既有本地只读 Gateway（不重复实现工具）。
 */
import { createDelegation } from './delegation.mjs'

export function createMcp({ config, guard, upstream, audit }) {
  const cache = { tools: null, at: 0 }
  const delegation = createDelegation({ config, audit })

  const jsonRpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
  const jsonRpcErr = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

  async function loadTools() {
    if (cache.tools && Date.now() - cache.at < 30_000) return cache.tools
    const r = await upstream.rpc({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} })
    const all = r?.result?.tools ?? []
    const mapped = all
      .filter((t) => config.exposedTools.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: t.name },
      }))
    for (const lt of delegation.localTools) {
      if (!config.exposedTools.includes(lt.name)) continue
      mapped.push({
        name: lt.name,
        description: lt.description,
        inputSchema: lt.inputSchema,
        annotations: { readOnlyHint: lt.name !== 'archive_terminal_session', destructiveHint: false, openWorldHint: false, title: lt.name },
      })
    }
    // 只缓存成功结果：上游失败（例如 relay token 轮换中）时不缓存，避免 30 秒内一直返回残缺工具表
    if (all.length > 0) { cache.tools = mapped; cache.at = Date.now() }
    return mapped
  }

  function allowedArgs(tool) {
    const props = tool?.inputSchema?.properties
    return props && typeof props === 'object' ? Object.keys(props) : []
  }

  async function handle(body, req) {
    const { id, method, params } = body ?? {}
    const isNotification = id === undefined || id === null
    if (method === 'initialize') {
      return jsonRpcOk(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-gptbridge', version: '0.1.0' },
        instructions: 'DSH MCP: whitelisted read tools plus delegation tools (list_workspaces / list_capabilities / archive_terminal_session). Session creation and task submission are available only when explicitly enabled in the local manager.',
      })
    }
    if (method === 'notifications/initialized' || method === 'ping' && isNotification) return null
    if (method === 'ping') return jsonRpcOk(id, {})

    const auth = guard.authenticate(req)
    if (method === 'tools/list') {
      if (!auth.ok) return { httpStatus: auth.status, body: jsonRpcErr(id, -32001, 'UNAUTHORIZED', { reason: auth.reason }), www: auth.www }
      const tools = await loadTools()
      return jsonRpcOk(id, { tools })
    }
    if (method === 'tools/call') {
      const name = String(params?.name ?? '')
      const decision = guard.authorizeTool(auth, name)
      if (!decision.ok) {
        audit('tool_denied', { tool: name, reason: decision.reason })
        const httpStatus = decision.status === 404 ? 200 : decision.status
        return { httpStatus, body: jsonRpcErr(id, -32003, 'FORBIDDEN', { tool: name, reason: decision.reason }), www: auth.www }
      }
      const tools = await loadTools()
      const tool = tools.find((t) => t.name === name)
      let args = params?.arguments ?? {}
      if (args && typeof args === 'object') {
        const allowed = new Set(allowedArgs(tool))
        const extra = Object.keys(args).filter((k) => !allowed.has(k))
        if (extra.length) {
          audit('tool_bad_args', { tool: name, detail: { extra } })
          return jsonRpcErr(id, -32602, 'INVALID_PARAMS', { unexpected: extra })
        }
      }
      // 给派发类工具的任务文本加统一前缀，便于在 DSH 侧栏识别（relay 会话标题取首条用户消息）
      if ((name === 'start_review' || name === 'start_run') && args && typeof args.task === 'string' && !args.task.startsWith('gpt指派｜')) {
        args = { ...args, task: 'gpt指派｜' + args.task }
      }
      if (delegation.names.includes(name)) {
        audit('tool_called', { tool: name, detail: { client: auth.clientId, local: true } })
        try {
          const out = await delegation.call(name, args)
          return jsonRpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
        } catch (e) {
          audit('local_tool_failure', { tool: name, detail: { message: String(e.message).slice(0, 160) } })
          return jsonRpcErr(id, -32603, 'LOCAL_TOOL_FAILED', { message: String(e.message).slice(0, 160) })
        }
      }
      try {
        const r = await upstream.rpc({ jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name, arguments: args } })
        if (r?.error) return jsonRpcErr(id, -32603, 'UPSTREAM_ERROR', { code: r.error.code, message: String(r.error.message ?? '').slice(0, 200) })
        audit('tool_called', { tool: name, detail: { client: auth.clientId } })
        let out = r?.result ?? { content: [], isError: true }
        // 裁剪上游回显的工具清单：只回显“实际放行”的工具名，避免向客户端泄漏未开放能力
        if (name === 'dsh_health' && Array.isArray(out?.content) && typeof out.content[0]?.text === 'string') {
          try {
            const obj = JSON.parse(out.content[0].text)
            if (Array.isArray(obj.exposed_tools)) {
              obj.exposed_tools = obj.exposed_tools.filter((t) => config.exposedTools.includes(t))
              out = { ...out, content: [{ ...out.content[0], text: JSON.stringify(obj) }] }
            }
          } catch { /* 非 JSON 回包：保持原样 */ }
        }
        // relay 的 run 到达终态后，把会话标题统一改成「gpt指派-XXX」
        try {
          const textOut = out?.content?.[0]?.text
          const snap = typeof textOut === 'string' ? JSON.parse(textOut) : null
          if (snap && snap.sessionId) {
            const st = String(snap.status ?? snap.state ?? '')
            if (['succeeded', 'failed', 'cancelled', 'timeout', 'orphaned', 'completed'].includes(st)) {
              const r = await delegation.prefixTitle(snap.sessionId, 'gpt指派-')
              if (r?.renamed) audit('session_title_prefixed', { detail: { session_id: snap.sessionId, title: r.title } })
            }
          }
        } catch { /* 标题前缀失败不影响工具结果 */ }
        return jsonRpcOk(id, out)
      } catch (e) {
        audit('upstream_failure', { tool: name, detail: { message: String(e.message).slice(0, 160) } })
        return jsonRpcErr(id, -32603, 'UPSTREAM_UNAVAILABLE', { message: 'local DSH gateway unreachable' })
      }
    }
    return jsonRpcErr(id, -32601, `method not found: ${method}`)
  }

  return { handle }
}
