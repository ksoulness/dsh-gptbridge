/** ACP 适配器：进程生命周期、stdio NDJSON 帧、请求/通知/权限、优雅关闭与进程树清理。 */
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CFG, BOOT_ID, ACP_MARKER } from './config.mjs'
import { scrub, ToolError } from './policy.mjs'

export function writeOverlay(stateDir, { compression = 'none' } = {}) {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `acp-overlay-${BOOT_ID}.yml`)
  writeFileSync(path, `# P2-A overlay · ${ACP_MARKER}\n# 该文件同时用作 ACP 子进程身份标记（cmdline 可见），用于安全清理孤儿进程。\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: ${compression}\n`)
  return path
}

/** 读取进程命令行（仅用于安全清理前的身份核验）。 */
export function getCommandLine(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout: 8000 })
    return out.trim()
  } catch { return '' }
}
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
/** 只对"确认属于本网关 overlay"的进程执行进程树终止；否则拒绝。 */
export function killTree(pid, marker) {
  const cmd = getCommandLine(pid)
  if (!cmd || !cmd.includes(marker)) return { killed: false, reason: 'identity_mismatch', cmdline_sample: scrub(cmd).slice(0, 200) }
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000 })
    return { killed: true, reason: 'taskkill_tree' }
  } catch (e) {
    return { killed: false, reason: `taskkill_failed:${String(e.message).slice(0, 120)}` }
  }
}

export class AcpClient {
  constructor({ registry, onUpdate, onPermission, overlayPath, log }) {
    this.registry = registry
    this.onUpdate = onUpdate
    this.onPermission = onPermission
    this.overlayPath = overlayPath
    this.pending = new Map()
    this.reqId = 0
    this.alive = false
    this.exited = null
    this.procRowId = null
    this.stopReason = null
    this.log = log ?? (() => {})
    this.recentUpdates = []
  }

  spawnSpec() {
    if (CFG.mode === 'mock') {
      const bin = join(import.meta.dirname, '..', 'mock-acp', 'server.mjs')
      return {
        command: process.execPath,
        args: [bin, '--state', join(CFG.stateDir, 'mock-acp'), '--task-delay', String(CFG.mockDelay), '--answer-bytes', String(CFG.mockAnswerBytes), '--tool-kind', CFG.mockToolKind, '--tool-title', CFG.mockToolTitle, ...(CFG.mockToolPath ? ['--tool-path', CFG.mockToolPath] : []), ...(CFG.mockToolRawInput ? ['--tool-rawinput', CFG.mockToolRawInput] : [])],
        cwd: CFG.stateDir,
        env: { ...process.env, DSH_HOME: join(CFG.stateDir, 'mock-dsh-home'), P2A_ROLE: 'mock-acp' },
        dshHome: join(CFG.stateDir, 'mock-dsh-home'),
      }
    }
    if (!CFG.dshBin) throw new ToolError('CONFIG_ERROR', 'real mode requires --acp-bin <path to dsh lib/bin.js>')
    const env = {
      ...process.env,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      P2A_ROLE: 'real-acp',
      P2A_MARKER: ACP_MARKER,
    }
    if (CFG.acpHome) env.DSH_HOME = CFG.acpHome
    for (const kv of CFG.acpExtraEnv) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1) }
    return {
      command: process.execPath,
      args: [CFG.dshBin, '--profile', 'acp', '--patch', this.overlayPath, ...(CFG.acpPatch ? ['--patch', CFG.acpPatch] : [])],
      cwd: CFG.acpHome ?? CFG.stateDir,
      env,
      dshHome: env.DSH_HOME ?? null,
    }
  }

  start() {
    const spec = this.spawnSpec()
    this.spec = spec
    this.log(`acp spawn: ${spec.command} ${spec.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.alive = true
    const role = CFG.mode === 'mock' ? 'mock-acp' : 'real-acp'
    this.registry.stmt.insProc.run(this.child.pid, process.pid, role, spec.dshHome, this.overlayPath, Date.now(),
      null, null, null, null)
    this.procRowId = this.registry.stmt.lastProcId.get().id
    // 记录身份快照：清理前必须用它重新核验，防 PID 复用误杀
    try {
      const snap = snapshot()
      const id = captureIdentity(this.child.pid, snap)
      if (id) {
        this.identity = { pid: id.pid, creation: id.creation, exe: id.exe, fp: id.fp }
        this.registry.stmt.setProcIdentity.run(id.creation, id.exe, id.fp, this.procRowId)
        this.log(`acp identity: pid=${id.pid} creation=${id.creation} exe=${id.exe_name} fp=${id.fp.slice(0, 12)}`)
      } else {
        this.log('acp identity: capture failed (child not yet visible); cleanup will refuse unverified kill')
      }
    } catch (e) { this.log('acp identity capture error: ' + String(e.message).slice(0, 120)) }

    this.child.on('exit', (code, signal) => {
      this.alive = false
      this.exited = { code, signal }
      this.registry.stmt.markProcExit.run(Date.now(), code, signal, this.stopReason ?? 'unexpected_exit', this.procRowId)
      this.log(`acp exit code=${code} signal=${signal} reason=${this.stopReason ?? 'unexpected_exit'}`)
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ToolError('ACP_EXITED', `acp process exited (code=${code}, signal=${signal})`, { reason: this.stopReason ?? 'unexpected_exit' })) }
      this.pending.clear()
      this.onExit?.(this.exited)
    })
    this.child.on('error', (e) => { this.alive = false; this.log(`acp spawn error: ${e.message}`) })
    createInterface({ input: this.child.stdout, terminal: false }).on('line', (l) => { try { this.onLine(l) } catch (e) { this.log(`stdout handler error: ${e.message}`) } })
    this.stderrLines = []
    createInterface({ input: this.child.stderr, terminal: false }).on('line', (l) => {
      const s = scrub(l)
      if (this.stderrLines.length < 200) this.stderrLines.push(s)
      if (s.trim()) this.log(`acp stderr: ${s.slice(0, 300)}`)
    })
    return this
  }

  onLine(line) {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch {
      this.log(`protocol violation (non-JSON stdout): ${scrub(line).slice(0, 200)}`)
      this.nonJsonLines = (this.nonJsonLines ?? 0) + 1
      return
    }
    if (msg.method === 'session/update') {
      if (this.recentUpdates.length > 200) this.recentUpdates.shift()
      this.recentUpdates.push(msg.params)
      this.onUpdate?.(msg.params)
      return
    }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        const answer = this.onPermission?.(msg.params) ?? { outcome: { outcome: 'selected', optionId: 'reject-once' } }
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer }) + '\n')
        return
      }
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported client method' } }) + '\n')
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) {
        const detail = String(msg.error.data?.details ?? msg.error.data?.detail ?? '')
        p.reject(new ToolError('ACP_ERROR', String(msg.error.message), { acpCode: msg.error.code, detail: scrub(detail) }))
      } else p.resolve(msg.result)
    }
  }

  request(method, params, { timeoutMs = CFG.requestTimeoutMs } = {}) {
    if (!this.alive) return Promise.reject(new ToolError('ACP_UNAVAILABLE', 'acp process is not running'))
    const id = ++this.reqId
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new ToolError('REQUEST_TIMEOUT', `${method} timed out after ${timeoutMs} ms`)) }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method, params) {
    if (!this.alive) throw new ToolError('ACP_UNAVAILABLE', 'acp process is not running')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 优雅关闭：stdin EOF → 等退出 → SIGTERM → 等 grace → 进程树强制终止（仅本 overlay 身份）。 */
  async stop(reason = 'gateway_shutdown') {
    if (!this.child || this.exited) return this.exited ?? { code: null, signal: null }
    this.stopReason = reason
    try { this.child.stdin.end() } catch { /* ignore */ }
    const waitExit = (ms) => new Promise((r) => {
      if (this.exited) { r(true); return }
      const t = setTimeout(() => r(false), ms)
      this.child.once('exit', () => { clearTimeout(t); r(true) })
    })
    if (await waitExit(CFG.shutdownGraceMs)) return this.exited
    this.stopReason = `${reason}:sigterm`
    try { this.child.kill('SIGTERM') } catch { /* ignore */ }
    if (await waitExit(1500)) return this.exited
    this.stopReason = `${reason}:tree_kill`
    const verdict = killVerified(this.identity ?? { pid: this.child.pid })
    if (!verdict.killed) {
      this.log(`acp kill refused: ${verdict.reason}${verdict.detail ? ' ' + JSON.stringify(verdict.detail) : ''}`)
    }
    await waitExit(2000)
    return this.exited ?? { code: null, signal: null }
  }
}
