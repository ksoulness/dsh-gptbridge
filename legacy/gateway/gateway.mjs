#!/usr/bin/env node
/**
 * DSH MCP Gateway (P2-A) —— 仅回环监听；real 模式不发送任何 prompt。
 *
 * 结构：config → registry(SQLite) → acp-client(stdio ACP) → tools(状态机/归属/日志) → HTTP MCP
 */
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CFG, BOOT_ID, VERSION, LIMITS, DB_PATH } from './config.mjs'
import { openRegistry } from './registry.mjs'
import { AcpClient, writeOverlay, killTree, pidAlive, getCommandLine } from './acp-client.mjs'
import { createToolLayer } from './tools.mjs'
import { TOOLS_META, scrub, ToolError, loadPermissionPolicy } from './policy.mjs'

globalThis.__P2A_T0 = Date.now()
mkdirSync(CFG.stateDir, { recursive: true })
const LOG_FILE = join(CFG.stateDir, `gateway-${BOOT_ID}.log`)
const log = (msg) => {
  const line = scrub(`[gw +${String(Date.now() - globalThis.__P2A_T0).padStart(6, ' ')}ms] ${msg}`)
  process.stderr.write(line + '\n')
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }) } catch { /* ignore */ }
}

// ---------------- 注册表 + 单实例锁 ----------------
const registry = openRegistry(CFG.stateDir)
try {
  registry.acquireRuntime()
} catch (e) {
  process.stdout.write(JSON.stringify({ event: 'gateway_refused', code: e.code ?? 'RUNTIME_ERROR', message: e.message, details: e.details ?? null }) + '\n')
  log(`refused to start: ${e.message}`)
  process.exit(3)
}
let permissionPolicy = null
try {
  permissionPolicy = loadPermissionPolicy(CFG.permissionPolicy)
  if (permissionPolicy) {
    log('permission policy: id=' + permissionPolicy.policy_id + ' kinds=' + permissionPolicy.kinds.join(',') + ' root=' + permissionPolicy.cwd_root + ' toolPattern=' + String(permissionPolicy.tool_pattern ?? ''))
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ event: 'gateway_refused', code: 'PERMISSION_POLICY_INVALID', message: e.message }) + '\n')
  log('refused: ' + e.message)
  process.exit(3)
}
const recovery = registry.recover()
log(`recovery: integrity=${recovery.integrity} orphaned=${recovery.orphaned.length} recovery_pending=${recovery.recovery_pending.length} stale_processes=${recovery.stale_processes.length}`)

// ---------------- 孤儿进程安全清理（仅身份匹配者） ----------------
for (const p of recovery.stale_processes) {
  const cmd = getCommandLine(p.pid)
  const ownOverlay = (p.overlay_path ?? '') !== '' && cmd.includes(p.overlay_path)
  if (!ownOverlay) {
    log(`stale pid ${p.pid} not verified as ours (overlay missing from cmdline) -> left untouched`)
    registry.stmt.markProcExit.run(Date.now(), null, null, 'stale_unverified_identity', p.id)
    continue
  }
  const r = killTree(p.pid, p.overlay_path)
  registry.stmt.markProcExit.run(Date.now(), null, null, `orphan_cleanup:${r.reason}`, p.id)
  log(`orphan pid ${p.pid} cleanup: ${r.killed ? 'killed' : 'not killed'} (${r.reason})`)
}

// ---------------- ACP ----------------
const overlayPath = writeOverlay(CFG.stateDir, { compression: 'none' })
let toolLayer
const acp = new AcpClient({
  registry,
  overlayPath,
  log,
  onUpdate: (p) => toolLayer?.onUpdate(p),
  onPermission: (p) => toolLayer?.onPermission(p) ?? { outcome: { outcome: 'selected', optionId: 'reject-once' } },
})
acp.start()
toolLayer = createToolLayer({ registry, acp, log, recovery, permissionPolicy })

await new Promise((r) => setTimeout(r, 250))
try {
  const init = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: 120000 })
  log(`acp initialize ok: ${JSON.stringify(init?.agentCapabilities ?? {})}`)
  registry.appendEvent(null, null, 'acp.initialized', { capabilities: init?.agentCapabilities ?? null, mode: CFG.mode })
} catch (e) {
  log(`acp initialize FAILED: ${e.message}`)
  registry.appendEvent(null, null, 'acp.initialize_failed', { code: e.code ?? 'ACP_ERROR', message: scrub(e.message) })
}

// ---------------- MCP 工具 schema ----------------
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false })
const schemas = {
  dsh_health: S({}),
  dsh_session_create: S({ cwd: { type: 'string', description: 'absolute project directory inside the allowlist' } }, ['cwd']),
  dsh_session_list: S({ cwd: { type: 'string' } }),
  dsh_session_ownership: S({ session_id: { type: 'string' } }, ['session_id']),
  dsh_session_resume: S({ session_id: { type: 'string' }, cwd: { type: 'string' } }, ['session_id']),
  dsh_session_set_config: S({ session_id: { type: 'string' }, config_id: { type: 'string', enum: ['model', 'reasoning_effort'] }, value: { type: 'string' } }, ['session_id', 'config_id', 'value']),
  dsh_task_submit: S({ session_id: { type: 'string' }, prompt: { type: 'string' }, idempotency_key: { type: 'string' } }, ['session_id', 'prompt']),
  dsh_task_status: S({ task_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['task_id']),
  dsh_task_events: S({ task_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }, ['task_id']),
  dsh_task_result: S({ task_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } }, ['task_id']),
  dsh_task_cancel: S({ task_id: { type: 'string' } }, ['task_id']),
  dsh_session_close: S({ session_id: { type: 'string' } }, ['session_id']),
  dsh_git_status: S({ cwd: { type: 'string' } }, ['cwd']),
  dsh_git_diff: S({ cwd: { type: 'string' }, base: { type: 'string' }, staged: { type: 'boolean' }, path: { type: 'string' } }, ['cwd']),
  dsh_git_log: S({ cwd: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['cwd']),
  dsh_git_branch: S({ cwd: { type: 'string' } }, ['cwd']),
  dsh_git_test_result: S({ cwd: { type: 'string' }, task_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['cwd']),
}
const descriptions = {
  dsh_health: 'Gateway/ACP 健康与策略摘要；不触发任何模型请求。',
  dsh_session_create: '在白名单 cwd 内创建持久会话（owner=gateway）。',
  dsh_session_list: '列出 ACP 可见的持久会话及其归属分类（活动会话会被 ACP 排除）。',
  dsh_session_ownership: '返回会话归属/锁状态与判定依据；不写入、不抢占。',
  dsh_session_resume: '仅允许恢复 gateway-owned 会话；锁冲突返回 SESSION_LOCKED。',
  dsh_session_set_config: '显式绑定 provider/model（configId=model，value 取 configOptions 给出的不透明字符串）；仅 gateway-owned。',
  dsh_task_submit: '入队一个任务并立即返回 task_id（幂等）；real 模式禁用。',
  dsh_task_status: '任务状态 + since_seq 增量事件（payload 有界）。',
  dsh_task_events: '事件日志分页（offset/limit）与时间戳。',
  dsh_task_result: '结算结果与输出分页（offset/limit）。',
  dsh_task_cancel: '取消排队或运行中的任务；会话保持可用。',
  dsh_session_close: '仅允许关闭 gateway-owned 会话。',
  dsh_git_status: '只读：工作区状态与 HEAD。',
  dsh_git_diff: '只读：diff（可指定 base/staged/path），输出有上限。',
  dsh_git_log: '只读：提交列表。',
  dsh_git_branch: '只读：当前分支与 HEAD。',
  dsh_git_test_result: '只读：网关记录的测试结果（P2-B 才产生）。',
}
// 只读模式：服务端只登记/暴露 klass=read 的工具（不依赖 annotations，不靠 UI 隐藏）
const EXPOSED = Object.keys(TOOLS_META).filter((n) => (CFG.readonlyMode ? TOOLS_META[n].klass === 'read' : true))
function toolList() {
  return EXPOSED.map((name) => ({
    name, description: descriptions[name], inputSchema: schemas[name],
    annotations: { readOnlyHint: TOOLS_META[name].readOnlyHint, destructiveHint: false, openWorldHint: false, title: name },
  }))
}

// ---------------- MCP over HTTP（仅回环） ----------------
function reply(id, result) { return { jsonrpc: '2.0', id, result } }
function fail(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } } }

async function handleRpc(msg) {
  const { id, method, params } = msg ?? {}
  if (id === undefined) return null
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-mcp-gateway', version: VERSION },
      instructions: 'Local DSH control plane. Task submission is asynchronous: submit, then poll status/events/result. Never assume a task ran; read the journal.',
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: toolList() })
  if (method !== 'tools/call') return fail(id, -32601, `method not found: ${method}`)
  const name = params?.name
  if (!TOOLS_META[name]) return fail(id, -32602, `unknown tool: ${name}`)
  if (!EXPOSED.includes(name)) {
    return fail(id, -32004, `READONLY_MODE_DENIED: ${name} (klass=${TOOLS_META[name].klass}) is not exposed in read-only mode`)
  }
  const fn = toolLayer.T[name]
  if (!fn) return fail(id, -32602, `tool not implemented: ${name}`)
  try {
    const result = await fn(params?.arguments ?? {})
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false })
  } catch (e) {
    const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
    const payload = { error: { code, message: scrub(String(e?.message ?? e)) }, details: e?.details ?? null }
    registry.appendEvent(null, null, 'tool.error', { tool: name, code })
    log(`tool ${name} error ${code}: ${payload.error.message.slice(0, 200)}`)
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true })
  }
}

const server = createServer(async (req, res) => {
  req.on('error', (e) => log(`request error: ${e.message}`))
  res.on('error', (e) => log(`response error: ${e.message}`))
  try {
    const remote = req.socket.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) { res.writeHead(403); res.end('loopback only'); return }

    if (req.method === 'GET' && req.url === '/health') {
      const body = { ok: acp.alive, version: VERSION, boot_id: BOOT_ID, acp_mode: CFG.mode, acp_pid: acp.child?.pid ?? null, last_seq: registry.stmt.lastSeq.get().seq, uptime_ms: Date.now() - globalThis.__P2A_T0 }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return
    }
    // 回环控制面：Windows 无可投递的 SIGTERM，优雅关闭需显式请求（要求 boot_id 匹配，防误触）
    if (req.method === 'POST' && req.url === '/_control/shutdown') {
      if (req.headers['x-p2a-boot'] !== BOOT_ID) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'boot_id mismatch', boot_id: BOOT_ID })); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, boot_id: BOOT_ID, stopping: true }))
      setTimeout(() => { void shutdown('CONTROL') }, 50)
      return
    }
    // Host 白名单：只接受回环主机名，抵御 DNS rebinding（隧道场景由 tunnel-client 以本地身份访问）
  const hostHeader = String(req.headers.host ?? '').toLowerCase()
  const hostName = hostHeader.split(':')[0]
  if (!CFG.allowHosts.includes(hostName)) {
    log(`reject non-allowlisted Host: ${scrub(hostHeader)}`)
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'host not allowed' } }))
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) { res.writeHead(404); res.end('not found'); return }

    let total = 0
    let tooBig = false
    const chunks = []
    for await (const c of req) {
      total += c.length
      if (total > LIMITS.maxBodyBytes) {
        // 超限后不再缓冲，但继续读空请求体，保证 413 能干净送达（不 reset 连接）
        tooBig = true
        chunks.length = 0
        continue
      }
      chunks.push(c)
    }
    if (tooBig) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `request body exceeds ${LIMITS.maxBodyBytes} bytes` } }))
      return
    }
    let msg
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return
    }
    // MCP 审计：只记录方法名与工具名，绝不记录参数内容
    const auditName = msg?.method === 'tools/call' ? String(msg?.params?.name ?? '') : ''
    log(`mcp request: method=${String(msg?.method ?? '')}${auditName ? ` tool=${auditName}` : ''} readonly=${CFG.readonlyMode}`)
    const out = await handleRpc(msg)
    if (out === null) { if (!res.destroyed) { res.writeHead(202); res.end() } return }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)) }
  } catch (e) {
    log(`handler failure: ${scrub(e?.stack ?? e)}`)
    if (!res.writableEnded && !res.destroyed) { try { res.writeHead(500); res.end('internal error') } catch { /* ignore */ } }
  }
})
process.on('uncaughtException', (e) => log(`uncaughtException (contained): ${scrub(e?.stack ?? e)}`))
process.on('unhandledRejection', (e) => log(`unhandledRejection (contained): ${scrub(e?.stack ?? e)}`))

const heartbeat = setInterval(() => { try { registry.heartbeat() } catch { /* ignore */ } }, 5000)

server.on('error', (e) => {
  // 监听失败必须 fail closed：写出结构化拒绝并以非 0 退出，绝不静默留着一个无监听进程
  const payload = { event: 'gateway_refused', code: e.code === 'EACCES' ? 'PORT_NOT_PERMITTED' : 'LISTEN_FAILED', message: String(e.message), port: CFG.port }
  try { process.stdout.write(JSON.stringify(payload) + '\n') } catch { /* ignore */ }
  log(`listen failed: ${payload.code} port=${CFG.port} (${e.message})`)
  try { registry.releaseRuntime() } catch { /* ignore */ }
  try { acp.stop('listen_failed') } catch { /* ignore */ }
  setTimeout(() => process.exit(3), 200)
})

server.listen(CFG.port, CFG.host, () => {
  const addr = server.address()
  process.stdout.write(`GATEWAY_LISTEN ${CFG.host}:${addr.port}\n`)
  log(`listening on ${CFG.host}:${addr.port} mode=${CFG.mode} db=${DB_PATH}`)
})

let shuttingDown = false
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown (${sig})`)
  clearInterval(heartbeat)
  try { server.close() } catch { /* ignore */ }
  try {
    const exited = await acp.stop(`gateway_${sig.toLowerCase()}`)
    log(`acp stopped: ${JSON.stringify(exited)}`)
  } catch (e) { log(`acp stop failed: ${e.message}`) }
  try { registry.releaseRuntime() } catch { /* ignore */ }
  try { registry.db.close() } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 120)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })