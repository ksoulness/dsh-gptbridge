/** 工具层：状态机、归属、事件日志分页、限额、权限审批。所有工具都在策略层之下。 */
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CFG, LIMITS, VERSION } from './config.mjs'
import { TOOLS_META, ToolError, assertKeys, requireString, optionalInt, assertCwdAllowed, decidePermission, decideScopedPermission, decideReadonlyPermission, scrub, truncate } from './policy.mjs'
import { gitTools } from './git-tools.mjs'
import { STATE_ORIGIN, TERMINAL } from './registry.mjs'

export function createToolLayer({ registry, acp, log, recovery, permissionPolicy = null }) {
  const currentTask = new Map()     // session_id -> task_id
  const taskCtl = new Map()         // task_id -> {reason}
  const sessionQueues = new Map()   // session_id -> Promise
  const cwdQueues = new Map()       // real cwd -> Promise
  const toolCalls = new Map()       // toolCallId -> { title, kind, locations }（permission 只带 id，需事件回填）
  const turns = new Map()           // task_id -> Set(messageId)，用于真实模式的轮次上限

  const sha256 = (s) => createHash('sha256').update(s).digest('hex')
  const ev = (taskId, sessionId, kind, payload) => registry.appendEvent(taskId, sessionId, kind, payload)

  // ---------- 归属 ----------
  function classify(sessionId, { probeDisk = true } = {}) {
    const row = registry.stmt.getSession.get(sessionId) ?? null
    let onDisk = null
    if (probeDisk) onDisk = findOnDisk(sessionId)
    const base = {
      session_id: sessionId,
      registered: Boolean(row),
      owner: row?.owner ?? 'unowned',
      owner_basis: row?.owner_basis ?? 'not_in_registry',
      web_suspected: /^session-[0-9a-f-]{36}$/.test(sessionId),
      on_disk: onDisk,
      lock_state: row?.lock_state ?? 'unknown',
      lock_at: row?.lock_at ?? null,
      lock_detail: row?.lock_detail ?? null,
      closed: row?.closed_at != null,
    }
    base.write_allowed = row?.owner === 'gateway' && base.lock_state !== 'held' && !base.closed
    base.classification = base.lock_state === 'held'
      ? 'locked'
      : base.owner === 'gateway' ? 'gateway_owned'
        : base.web_suspected ? 'web_owned_suspected'
          : base.registered ? 'foreign' : 'unowned'
    base.lock_evidence = row?.lock_state === 'held'
      ? { measured_at: row.lock_at, detail: row.lock_detail, method: 'acp session/resume attempt (real write-open lock)' }
      : { measured_at: null, detail: null, method: 'no write attempt (write attempts are made only for gateway-owned sessions)' }
    return base
  }
  function findOnDisk(sessionId) {
    const root = sessionRoot()
    if (!root || !existsSync(root)) return null
    try {
      for (const proj of readdirSync(root, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue
        const dir = join(root, proj.name, sessionId)
        if (!existsSync(dir)) continue
        const files = readdirSync(dir)
        const enc = files.some((f) => f.endsWith('.zstd')) ? 'zstd' : files.some((f) => f.endsWith('.jsonl')) ? 'none' : 'unknown'
        return { dir: `${proj.name}/${sessionId}`, files, encoding: enc }
      }
    } catch { /* ignore */ }
    return null
  }
  function sessionRoot() {
    return CFG.mode === 'mock' ? join(CFG.stateDir, 'mock-dsh-home', 'sessions') : (CFG.acpHome ? join(CFG.acpHome, 'sessions') : null)
  }

  // ---------- 队列：会话 FIFO + 同 cwd 串行 ----------
  function enqueueSession(sessionId, job) {
    const prev = sessionQueues.get(sessionId) ?? Promise.resolve()
    const next = prev.then(job, job).catch((e) => log(`session queue error: ${e.message}`))
    sessionQueues.set(sessionId, next)
    return next
  }
  async function withCwdLock(cwd, taskId, fn) {
    const prev = cwdQueues.get(cwd) ?? Promise.resolve()
    let release
    const gate = new Promise((r) => { release = r })
    cwdQueues.set(cwd, prev.then(() => gate))
    await prev
    const stale = registry.stmt.getCwdLock.get(cwd)
    if (stale) {
      let alive = false
      try { process.kill(stale.pid, 0); alive = true } catch { alive = false }
      if (!alive) registry.stmt.delCwdLock.run(cwd, stale.task_id)
    }
    try { registry.stmt.tryCwdLock.run(cwd, taskId, process.pid, Date.now()) } catch { /* PK 冲突：同进程内已串行 */ }
    ev(taskId, null, 'cwd.lock_acquired', { cwd })
    try { return await fn() } finally {
      registry.stmt.delCwdLock.run(cwd, taskId)
      ev(taskId, null, 'cwd.lock_released', { cwd })
      release()
    }
  }

  // ---------- 任务执行 ----------
  async function runTask(taskId, sessionId, prompt, cwd) {
    const task = registry.stmt.getTask.get(taskId)
    if (!task || task.state !== 'queued') return
    await withCwdLock(cwd, taskId, async () => {
      const fresh = registry.stmt.getTask.get(taskId)
      if (!fresh || fresh.state !== 'queued') return
      registry.stmt.setState.run('running', 'gw', Date.now(), null, null, null, null, 0, 0, taskId)
      ev(taskId, sessionId, 'task.running', { started_at: Date.now() })
      currentTask.set(sessionId, taskId)
      const ctl = { reason: null }
      taskCtl.set(taskId, ctl)
      const timer = setTimeout(() => {
        ctl.reason = 'timeout'
        ev(taskId, sessionId, 'task.timeout', { timeout_ms: LIMITS.taskTimeoutMs })
        try { acp.notify('session/cancel', { sessionId }) } catch { /* ignore */ }
      }, LIMITS.taskTimeoutMs)
      try {
        const result = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0 })
        clearTimeout(timer)
        const stop = result?.stopReason ?? 'unknown'
        const state = ctl.reason === 'timeout' ? 'timeout'
          : ctl.reason === 'cancel' ? 'cancelled'
            : ctl.reason === 'turn_budget' ? 'failed'
              : stop === 'cancelled' ? 'cancelled' : 'completed'
        const errCode = ctl.reason === 'turn_budget' ? 'TURN_BUDGET_EXCEEDED' : state === 'timeout' ? 'TASK_TIMEOUT' : null
        registry.stmt.finish.run(state, 'both', Date.now(), stop, errCode,
          errCode === 'TURN_BUDGET_EXCEEDED' ? `assistant turn budget exceeded (${LIMITS.maxAssistantTurns ?? CFG.maxAssistantTurns})`
            : errCode === 'TASK_TIMEOUT' ? `task exceeded ${LIMITS.taskTimeoutMs} ms` : null,
          ctl.reason === 'timeout' || ctl.reason === 'turn_budget' ? 1 : 0,
          ctl.reason === 'timeout' || ctl.reason === 'turn_budget' ? 1 : 0, taskId)
        ev(taskId, sessionId, 'task.settled', { stop_reason: stop, state })
      } catch (e) {
        clearTimeout(timer)
        const code = e?.code ?? 'ACP_ERROR'
        const unknownOutcome = code === 'ACP_EXITED' || code === 'ACP_UNAVAILABLE'
        const state = ctl.reason === 'timeout' ? 'timeout'
          : ctl.reason === 'turn_budget' ? 'failed'
            : unknownOutcome ? 'unknown' : 'failed'
        const errCode = ctl.reason === 'turn_budget' ? 'TURN_BUDGET_EXCEEDED'
          : unknownOutcome ? 'UNKNOWN_OUTCOME' : code
        registry.stmt.finish.run(state, 'gw', Date.now(), null, errCode,
          unknownOutcome ? 'ACP process ended while the prompt was in flight; the result is unknown and will NOT be resubmitted'
            : ctl.reason === 'turn_budget' ? `assistant turn budget exceeded (${LIMITS.maxAssistantTurns})`
              : String(e?.message ?? e),
          0, unknownOutcome ? 1 : 0, taskId)
        ev(taskId, sessionId, unknownOutcome ? 'task.unknown' : 'task.failed', { code: errCode, message: scrub(String(e?.message ?? e)).slice(0, 500), auto_resubmit: false })
      } finally {
        taskCtl.delete(taskId)
        currentTask.delete(sessionId)
      }
    })
  }

  // ---------- ACP 更新 → 事件 ----------
  function onUpdate(params) {
    const sessionId = params?.sessionId
    const taskId = currentTask.get(sessionId) ?? null
    const update = params?.update ?? {}
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      if (toolCalls.size > 500) toolCalls.clear()
      const prev = toolCalls.get(update.toolCallId) ?? {}
      toolCalls.set(update.toolCallId, {
        title: update.title ?? prev.title ?? '',
        kind: update.kind ?? prev.kind ?? '',
        locations: update.locations ?? prev.locations ?? [],
        rawInput: update.rawInput ?? prev.rawInput ?? null,
      })
    }
    ev(taskId, sessionId, `update.${update.sessionUpdate ?? 'unknown'}`, update)
    // 真实模式的轮次上限（按 assistant 消息计，作为 provider 请求数的保守代理）
    if (CFG.maxAssistantTurns > 0 && taskId && update.sessionUpdate === 'agent_message_chunk' && update.messageId) {
      const seen = turns.get(taskId) ?? new Set()
      seen.add(update.messageId)
      turns.set(taskId, seen)
      if (seen.size > CFG.maxAssistantTurns) {
        const ctl = taskCtl.get(taskId)
        if (ctl && !ctl.reason) {
          ctl.reason = 'turn_budget'
          ev(taskId, sessionId, 'task.turn_budget_exceeded', { turns: seen.size, limit: CFG.maxAssistantTurns })
          try { acp.notify('session/cancel', { sessionId }) } catch { /* ignore */ }
        }
      }
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const t = taskId ? registry.stmt.getTask.get(taskId) : null
      if (t) {
        const merged = truncate(`${t.output_text ?? ''}${update?.content?.text ?? ''}`, LIMITS.maxResultBytes)
        registry.stmt.setOutput.run(merged.text, merged.truncated ? 1 : 0, taskId)
      }
    }
  }

  // ---------- 权限 ----------
  function onPermission(params) {
    const sessionId = params?.sessionId
    const taskId = currentTask.get(sessionId) ?? null
    const toolCallId = params?.toolCall?.toolCallId
    const known = toolCalls.get(toolCallId) ?? {}
    const title = known.title || params?.toolCall?.title || ''
    const kind = known.kind || params?.toolCall?.kind || ''
    const locations = known.locations ?? params?.toolCall?.locations ?? []
    // 有作用域策略则走策略（任务/工具/kind/路径四重约束），否则退回旧的 title 前缀白名单
    const rawInput = known.rawInput ?? params?.toolCall?.rawInput ?? null
    const verdict = permissionPolicy
      ? decideReadonlyPermission({ policy: permissionPolicy, title, kind, locations, rawInput })
      : decidePermission(params?.toolCall, title)
    registry.stmt.insApproval.run(taskId, sessionId, scrub(String(title)), verdict.decision,
      `${permissionPolicy ? `policy=${permissionPolicy.policy_id}:` : ''}${verdict.reason}`, Date.now())
    ev(taskId, sessionId, 'permission.request', {
      tool: scrub(String(title)), tool_call_id: toolCallId ?? null, kind,
      locations: (locations ?? []).map((l) => scrub(String(l?.path ?? l))).slice(0, 5),
      decision: verdict.decision, reason: verdict.reason, detail: verdict.detail ?? null,
      params_keys: rawInput && typeof rawInput === 'object' ? Object.keys(rawInput).slice(0, 12) : [],
      policy_id: permissionPolicy?.policy_id ?? null, task_id: taskId,
    })
    return { outcome: { outcome: 'selected', optionId: verdict.decision } }
  }

  // ---------- 工具 ----------
  const T = {}

  T.dsh_health = async () => ({
    ok: acp.alive,
    tool_mode: CFG.readonlyMode ? 'read-only' : 'full',
    exposed_tools: Object.keys(TOOLS_META).filter((n) => (CFG.readonlyMode ? TOOLS_META[n].klass === 'read' : true)),
    gateway: { version: VERSION, boot_id: registry.bootId, pid: process.pid, state_dir: CFG.stateDir, uptime_ms: Date.now() - (globalThis.__P2A_T0 ?? Date.now()), last_seq: registry.stmt.lastSeq.get().seq },
    acp: { mode: CFG.mode, pid: acp.child?.pid ?? null, ppid: acp.child ? process.pid : null, alive: acp.alive, exited: acp.exited, overlay: acp.overlayPath },
    counts: { sessions: registry.stmt.allSessions.all().length, active_tasks: registry.stmt.listActive.get().n, open_processes: registry.stmt.openProcs.all().length },
    recovery: recovery ?? null,
    limits: LIMITS,
    policy: {
      cwd_allow: CFG.cwdAllow, permission: CFG.allowPermissionPrefixes.length ? `allowlist:${CFG.allowPermissionPrefixes.join(',')}` : 'default-deny',
      task_submit: CFG.mode === 'real' ? (CFG.allowRealSubmit ? `enabled(one-shot, max=${CFG.maxRealPrompts})` : 'disabled') : 'mock-only',
      auth_mode: 'none-loopback', bind: CFG.host,
      permission_policy: permissionPolicy ? { policy_id: permissionPolicy.policy_id, kinds: permissionPolicy.kinds, cwd_root: permissionPolicy.cwd_root, tool_pattern: String(permissionPolicy.tool_pattern ?? ''), require_locations: permissionPolicy.require_locations } : null,
    },
    budget: {
      real_prompt: registry.readBudget('real_prompt') ?? { used: 0, limit_: CFG.maxRealPrompts },
      max_assistant_turns: CFG.maxAssistantTurns,
    },
    states: { supported: Object.keys(STATE_ORIGIN), origin: STATE_ORIGIN },
  })

  T.dsh_session_create = async (params) => {
    assertKeys(params, ['cwd'], 'dsh_session_create')
    const d = assertCwdAllowed(requireString(params, 'cwd'))
    const result = await acp.request('session/new', { cwd: d.real, mcpServers: [] })
    const sessionId = result?.sessionId
    if (!sessionId) throw new ToolError('ACP_PROTOCOL', 'session/new returned no sessionId')
    registry.stmt.upSession.run(sessionId, d.real, Date.now(), null, CFG.mode === 'mock' ? 'mock-acp' : 'acp', 'gateway', 'created_by_gateway', 'free', Date.now(), null)
    ev(null, sessionId, 'session.created', { cwd: d.real, reparse_points: d.reparse_points, configs: result?.configOptions?.length ?? 0 })
    return { session_id: sessionId, cwd: d.real, owner: 'gateway', config_options: result?.configOptions ?? [], reparse_points: d.reparse_points }
  }

  T.dsh_session_list = async (params) => {
    assertKeys(params, ['cwd'], 'dsh_session_list')
    const req = {}
    if (params?.cwd !== undefined) req.cwd = assertCwdAllowed(requireString(params, 'cwd')).real
    const result = await acp.request('session/list', req)
    const rows = (result?.sessions ?? []).map((s) => {
      const c = classify(s.sessionId, { probeDisk: false })
      return { session_id: s.sessionId, cwd: s.cwd, classification: c.classification, owner: c.owner, write_allowed: c.write_allowed, registered: c.registered, closed: c.closed }
    })
    return { sessions: rows, next_cursor: result?.nextCursor ?? null, note: 'ACP 的 session/list 会排除本进程正在活动的会话' }
  }

  T.dsh_session_ownership = async (params) => {
    assertKeys(params, ['session_id'], 'dsh_session_ownership')
    const sessionId = requireString(params, 'session_id', { maxBytes: 200 })
    return { ...classify(sessionId), policy: 'web/foreign/unowned 默认禁止写入；held 时禁止抢占；不允许删锁文件或终止他进程' }
  }

  T.dsh_session_resume = async (params) => {
    assertKeys(params, ['session_id', 'cwd'], 'dsh_session_resume')
    const sessionId = requireString(params, 'session_id', { maxBytes: 200 })
    const row = registry.stmt.getSession.get(sessionId)
    if (!row) throw new ToolError('SESSION_NOT_OWNED', 'session is not registered as gateway-owned; writes are refused by default', { session_id: sessionId })
    if (row.owner !== 'gateway') throw new ToolError('SESSION_NOT_OWNED', `session owner is ${row.owner}; gateway will not take it over`, { session_id: sessionId })
    const d = assertCwdAllowed(requireString({ cwd: params?.cwd ?? row.cwd }, 'cwd'))
    try {
      const result = await acp.request('session/resume', { sessionId, cwd: d.real, mcpServers: [] })
      registry.stmt.upSession.run(sessionId, d.real, row.created_at, null, row.origin, 'gateway', 'resumed_by_gateway', 'free', Date.now(), null)
      ev(null, sessionId, 'session.resumed', { cwd: d.real })
      return { session_id: sessionId, cwd: d.real, owner: 'gateway', config_options: result?.configOptions ?? [], history_replay: false }
    } catch (e) {
      const hay = `${e?.message ?? ''} ${e?.details?.detail ?? ''}`
      if (/already active|already owned by an active write handle/i.test(hay)) {
        registry.stmt.setLock.run('held', Date.now(), scrub(hay).slice(0, 400), sessionId)
        ev(null, sessionId, 'session.locked', { detail: scrub(hay).slice(0, 400) })
        throw new ToolError('SESSION_LOCKED', 'session is write-locked by another process', { session_id: sessionId, detail: scrub(hay).slice(0, 400) })
      }
      if (/not resumable/i.test(hay)) throw new ToolError('SESSION_NOT_RESUMABLE', hay.trim())
      if (/cwd does not match/i.test(hay)) throw new ToolError('SESSION_CWD_MISMATCH', hay.trim())
      throw e
    }
  }

  T.dsh_task_submit = async (params) => {
    assertKeys(params, ['session_id', 'prompt', 'idempotency_key'], 'dsh_task_submit')
    if (CFG.mode === 'real' && !CFG.allowRealSubmit) {
      throw new ToolError('REAL_ACP_SUBMIT_DISABLED', 'task submission against the real ACP bridge is disabled (P2-A default); enable with --allow-real-submit --max-real-prompts N')
    }
    const sessionId = requireString(params, 'session_id', { maxBytes: 200 })
    const rawPrompt = requireString(params, 'prompt', { maxBytes: LIMITS.maxPromptBytes })
    const prompt = String(CFG.promptPrefix ?? '') + rawPrompt
    const idem = params?.idempotency_key === undefined ? null : requireString(params, 'idempotency_key', { maxBytes: 200 })

    const c = classify(sessionId, { probeDisk: false })
    if (c.owner !== 'gateway') throw new ToolError('SESSION_NOT_OWNED', `session classification is ${c.classification}; write refused`, { classification: c.classification })
    if (c.closed) throw new ToolError('SESSION_CLOSED', `session is closed: ${sessionId}`)
    if (c.lock_state === 'held') throw new ToolError('SESSION_LOCKED', 'session is write-locked; refusing to submit', { lock_detail: c.lock_detail })

    if (idem) {
      const dup = registry.stmt.byIdem.get(idem)
      if (dup) {
        ev(dup.task_id, dup.session_id, 'task.idempotent_replay', { idempotency_key: idem })
        return { task_id: dup.task_id, session_id: dup.session_id, state: dup.state, replayed: true, seq: registry.stmt.lastSeq.get().seq }
      }
    }
    const active = registry.stmt.listActive.get().n
    if (active >= LIMITS.maxConcurrentTasks) throw new ToolError('TOO_MANY_TASKS', `concurrent task limit reached (${LIMITS.maxConcurrentTasks})`, { active })

    const taskId = `t-${randomUUID()}`
    const cwd = registry.stmt.getSession.get(sessionId)?.cwd ?? null
    // 真实模式：在任何前置校验通过之后、真正发送之前，原子消耗一次性预算
    if (CFG.mode === 'real') {
      if (CFG.maxRealPrompts <= 0) throw new ToolError('REAL_PROMPT_BUDGET_NOT_CONFIGURED', 'real prompt budget is not configured; refusing to send')
      const b = registry.incBudget('real_prompt', CFG.maxRealPrompts)
      if (!b.ok) throw new ToolError('REAL_PROMPT_BUDGET_EXHAUSTED', `real prompt budget exhausted (${b.used}/${b.limit}); refusing to send`, b)
      registry.appendEvent(null, sessionId, 'budget.real_prompt_consumed', { used: b.used, limit: b.limit, task_id: taskId })
    }
    registry.stmt.insTask.run(taskId, sessionId, idem, 'queued', Buffer.byteLength(prompt, 'utf8'), sha256(prompt), Date.now(), 'gw', cwd, 0, 0)
    const seq = ev(taskId, sessionId, 'task.queued', { prompt_len: Buffer.byteLength(prompt, 'utf8'), prompt_sha256: sha256(prompt).slice(0, 16) })
    enqueueSession(sessionId, () => runTask(taskId, sessionId, prompt, cwd))
    return { task_id: taskId, session_id: sessionId, state: 'queued', seq, idempotency_key: idem }
  }

  function taskOr404(taskId) {
    const t = registry.stmt.getTask.get(taskId)
    if (!t) throw new ToolError('UNKNOWN_TASK', `unknown task: ${taskId}`)
    return t
  }

  T.dsh_task_status = async (params) => {
    assertKeys(params, ['task_id', 'since_seq', 'limit'], 'dsh_task_status')
    const taskId = requireString(params, 'task_id', { maxBytes: 200 })
    const t = taskOr404(taskId)
    const since = optionalInt(params, 'since_seq', { min: 0, fallback: 0 })
    const limit = optionalInt(params, 'limit', { min: 1, max: 200, fallback: 50 })
    const rows = registry.stmt.eventsSince.all(taskId, since, limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      task_id: t.task_id, session_id: t.session_id, state: t.state, state_origin: t.state_origin,
      can_retry: t.can_retry === 1, requires_human: t.requires_human === 1, resubmittable: false,
      stop_reason: t.stop_reason, error: t.error_code ? { code: t.error_code, message: t.error_message } : null,
      created_at: t.created_at, started_at: t.started_at, finished_at: t.finished_at,
      output: { bytes: Buffer.byteLength(t.output_text ?? '', 'utf8'), truncated: t.output_truncated === 1 },
      events: page.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, ts: new Date(e.at).toISOString(), payload: registry.parsePayload(e.payload), payload_truncated: e.payload_truncated === 1 })),
      next_seq: page.length ? page[page.length - 1].seq : since, has_more: hasMore,
      tool_calls: summarizeToolCalls(taskId),
    }
  }

  T.dsh_task_events = async (params) => {
    assertKeys(params, ['task_id', 'since_seq', 'limit', 'offset'], 'dsh_task_events')
    const taskId = requireString(params, 'task_id', { maxBytes: 200 })
    taskOr404(taskId)
    const since = optionalInt(params, 'since_seq', { min: 0, fallback: 0 })
    const limit = optionalInt(params, 'limit', { min: 1, max: 200, fallback: 50 })
    const offset = optionalInt(params, 'offset', { min: 0, fallback: 0 })
    const all = registry.stmt.eventsSince.all(taskId, since, 100000)
    const slice = all.slice(offset, offset + limit)
    return {
      task_id: taskId, total: all.length, offset, limit,
      events: slice.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, ts: new Date(e.at).toISOString(), payload: registry.parsePayload(e.payload), payload_truncated: e.payload_truncated === 1 })),
      next_seq: slice.length ? slice[slice.length - 1].seq : since, has_more: offset + limit < all.length,
    }
  }

  T.dsh_task_result = async (params) => {
    assertKeys(params, ['task_id', 'offset', 'limit'], 'dsh_task_result')
    const taskId = requireString(params, 'task_id', { maxBytes: 200 })
    const t = taskOr404(taskId)
    const full = Buffer.from(t.output_text ?? '', 'utf8')
    const offset = optionalInt(params, 'offset', { min: 0, max: full.length, fallback: 0 })
    const limit = optionalInt(params, 'limit', { min: 1, max: LIMITS.maxResultBytes, fallback: LIMITS.maxResultBytes })
    const slice = full.subarray(offset, offset + limit)
    return {
      task_id: t.task_id, session_id: t.session_id, state: t.state, state_origin: t.state_origin,
      settled: TERMINAL.has(t.state) || t.state === 'unknown',
      output_text: slice.toString('utf8'), output_offset: offset, output_bytes: full.length,
      output_has_more: offset + limit < full.length, output_truncated_at_capture: t.output_truncated === 1,
      stop_reason: t.stop_reason, error: t.error_code ? { code: t.error_code, message: t.error_message } : null,
      can_retry: t.can_retry === 1, requires_human: t.requires_human === 1,
    }
  }

  T.dsh_task_cancel = async (params) => {
    assertKeys(params, ['task_id'], 'dsh_task_cancel')
    const taskId = requireString(params, 'task_id', { maxBytes: 200 })
    const t = taskOr404(taskId)
    if (TERMINAL.has(t.state) || t.state === 'unknown') return { task_id: taskId, state: t.state, changed: false }
    if (t.state === 'queued' || t.state === 'recovery_pending') {
      registry.stmt.finish.run('cancelled', 'gw', Date.now(), null, 'CANCELLED_BEFORE_START', 'cancelled before the prompt was sent', 0, 0, taskId)
      ev(taskId, t.session_id, 'task.cancelled', { phase: 'queued' })
      return { task_id: taskId, state: 'cancelled', changed: true }
    }
    const ctl = taskCtl.get(taskId)
    if (ctl) ctl.reason = 'cancel'
    try { acp.notify('session/cancel', { sessionId: t.session_id }) } catch (e) { throw new ToolError('ACP_UNAVAILABLE', String(e.message)) }
    ev(taskId, t.session_id, 'task.cancel_requested', {})
    registry.stmt.insApproval.run(taskId, t.session_id, 'session/cancel', 'requested', 'operator cancel', Date.now())
    return { task_id: taskId, state: t.state, changed: true, note: 'cancellation requested; poll dsh_task_status' }
  }

  T.dsh_session_close = async (params) => {
    assertKeys(params, ['session_id'], 'dsh_session_close')
    const sessionId = requireString(params, 'session_id', { maxBytes: 200 })
    const row = registry.stmt.getSession.get(sessionId)
    if (!row) throw new ToolError('SESSION_NOT_OWNED', 'session is not registered; close refused by default')
    if (row.owner !== 'gateway') throw new ToolError('SESSION_NOT_OWNED', `session owner is ${row.owner}; gateway will not close it`)
    await acp.request('session/close', { sessionId })
    registry.stmt.setClosed.run(Date.now(), sessionId)
    registry.stmt.setLock.run('free', Date.now(), null, sessionId)
    ev(null, sessionId, 'session.closed', {})
    return { session_id: sessionId, closed: true, owner: 'gateway' }
  }

  /** 显式绑定 provider/model（ACP configId=model，value 为选项状态里给出的不透明字符串）。 */
  T.dsh_session_set_config = async (params) => {
    assertKeys(params, ['session_id', 'config_id', 'value'], 'dsh_session_set_config')
    const sessionId = requireString(params, 'session_id', { maxBytes: 200 })
    const configId = requireString(params, 'config_id', { maxBytes: 64 })
    if (!['model', 'reasoning_effort'].includes(configId)) throw new ToolError('INVALID_PARAMS', `unsupported config_id: ${configId}`, { allowed: ['model', 'reasoning_effort'] })
    const value = requireString(params, 'value', { maxBytes: 200 })
    const row = registry.stmt.getSession.get(sessionId)
    if (!row) throw new ToolError('SESSION_NOT_OWNED', 'session is not registered; config change refused')
    if (row.owner !== 'gateway') throw new ToolError('SESSION_NOT_OWNED', `session owner is ${row.owner}; config change refused`)
    const result = await acp.request('session/set_config_option', { sessionId, configId, value })
    const opts = result?.configOptions ?? []
    const modelOpt = opts.find((o) => o.id === 'model') ?? null
    ev(null, sessionId, 'session.config_changed', { config_id: configId, value, current: modelOpt?.currentValue ?? null })
    return {
      session_id: sessionId, config_id: configId, accepted: true,
      model_current: modelOpt?.currentValue ?? null,
      option_ids: opts.map((o) => o.id),
    }
  }

  function summarizeToolCalls(taskId) {
    const rows = registry.stmt.eventsSince.all(taskId, 0, 100000)
    const map = new Map()
    for (const r of rows) {
      let p; p = registry.parsePayload(r.payload); if (p === null || p?.unparsable) continue
      if (r.kind === 'update.tool_call' && p?.toolCallId) map.set(p.toolCallId, { tool_call_id: p.toolCallId, title: p.title, status: p.status, seq: r.seq })
      else if (r.kind === 'update.tool_call_update' && p?.toolCallId) map.set(p.toolCallId, { ...(map.get(p.toolCallId) ?? { tool_call_id: p.toolCallId }), status: p.status, seq: r.seq })
    }
    return [...map.values()]
  }

  // ---------- Git（只读） ----------
  T.dsh_git_status = async (params) => { assertKeys(params, ['cwd'], 'dsh_git_status'); return gitTools.dsh_git_status(params) }
  T.dsh_git_diff = async (params) => { assertKeys(params, ['cwd', 'base', 'staged', 'path'], 'dsh_git_diff'); return gitTools.dsh_git_diff(params) }
  T.dsh_git_log = async (params) => { assertKeys(params, ['cwd', 'limit'], 'dsh_git_log'); return gitTools.dsh_git_log(params) }
  T.dsh_git_branch = async (params) => { assertKeys(params, ['cwd'], 'dsh_git_branch'); return gitTools.dsh_git_branch(params) }
  T.dsh_git_test_result = async (params) => { assertKeys(params, ['cwd', 'task_id', 'limit'], 'dsh_git_test_result'); return gitTools.dsh_git_test_result(params, registry) }

  return { T, classify, onUpdate, onPermission, taskCtl }
}
