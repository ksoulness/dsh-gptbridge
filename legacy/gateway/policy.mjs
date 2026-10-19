/** 策略层：cwd 真实路径白名单、参数校验、工具分级、限额与脱敏。 */
import { lstatSync, realpathSync, existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, sep, dirname } from 'node:path'
import { CFG } from './config.mjs'

export class ToolError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details ?? null }
}

// ---------------- 脱敏与截断 ----------------
const REDACT = [
  [/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***'],
  [/(bearer|authorization)(\s*[:=]\s*|\s+)\S+/gi, '$1$2***'],
  [/((?:api[_-]?key|token|cookie|password)\s*[:=]\s*)\S+/gi, '$1***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----***'],
]
export function scrub(value) {
  let out = String(value ?? '')
  for (const [re, rep] of REDACT) out = out.replace(re, rep)
  return out
}
export function truncate(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8')
  if (buf.length <= maxBytes) return { text: String(text ?? ''), truncated: false, bytes: buf.length, total_bytes: buf.length }
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1 // 不切断 UTF-8 续字节
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, bytes: end, total_bytes: buf.length }
}

// ---------------- 参数校验 ----------------
export function assertKeys(params, allowed, tool) {
  for (const k of Object.keys(params ?? {})) {
    if (!allowed.includes(k)) throw new ToolError('INVALID_PARAMS', `parameter not allowed: ${k}`, { tool, rejected: k, allowed })
  }
}
export function requireString(params, key, { maxBytes, pattern } = {}) {
  const v = params?.[key]
  if (typeof v !== 'string' || v.trim() === '') throw new ToolError('INVALID_PARAMS', `${key} must be a non-empty string`)
  if (maxBytes !== undefined && Buffer.byteLength(v, 'utf8') > maxBytes) throw new ToolError('LIMIT_EXCEEDED', `${key} exceeds ${maxBytes} bytes`, { key, limit: maxBytes })
  if (pattern && !pattern.test(v)) throw new ToolError('INVALID_PARAMS', `${key} has an invalid format`)
  return v
}
export function optionalInt(params, key, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const v = params?.[key]
  if (v === undefined || v === null) return fallback
  if (!Number.isInteger(v) || v < min || v > max) throw new ToolError('INVALID_PARAMS', `${key} must be an integer in [${min}, ${max}]`)
  return v
}
export function requireBool(params, key, fallback = false) {
  const v = params?.[key]
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') throw new ToolError('INVALID_PARAMS', `${key} must be a boolean`)
  return v
}

// ---------------- 路径：真实路径 + reparse（Junction/符号链接）检查 ----------------
export function isAbsolutePath(p) {
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') : p.startsWith('/')
}
/** 逐段检测重解析点（Windows junction / symlink），并给出真实路径。 */
export function describePath(p) {
  const requested = resolve(p)
  const reparse = []
  let prefix = requested
  const chain = []
  while (prefix && prefix !== dirname(prefix)) { chain.push(prefix); prefix = dirname(prefix) }
  chain.push(prefix)
  for (const seg of chain.reverse()) {
    try { if (lstatSync(seg).isSymbolicLink()) reparse.push(seg) } catch { /* 不存在则跳过 */ }
  }
  let real = requested
  try { real = realpathSync.native(requested) } catch { /* 尚不存在：保留字面值 */ }
  return { requested, real, reparse_points: reparse, exists: existsSync(requested), is_dir: (() => { try { return statSync(requested).isDirectory() } catch { return false } })() }
}
function within(root, target) {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root
  return target === r || target.startsWith(r + sep)
}
/** cwd 白名单校验（按真实路径比较，阻断 junction/symlink 逃逸）。 */
export function assertCwdAllowed(cwd) {
  if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) throw new ToolError('INVALID_CWD', `cwd must be an absolute path: ${cwd}`)
  const d = describePath(cwd)
  if (!d.exists || !d.is_dir) throw new ToolError('INVALID_CWD', `cwd is not an existing directory: ${cwd}`)
  if (CFG.cwdAllow.length === 0) throw new ToolError('CWD_NOT_ALLOWED', 'no cwd allowlist configured; every cwd is rejected')
  const ok = CFG.cwdAllow.some((root) => { const r = describePath(root); return within(r.real, d.real) })
  if (!ok) throw new ToolError('CWD_NOT_ALLOWED', `cwd is outside the allowlist: ${cwd}`, { allowlist: CFG.cwdAllow, resolved: d.real })
  return d
}

// ---------------- 工具分级与权限策略 ----------------
export const TOOLS_META = {
  dsh_health: { klass: 'read', readOnlyHint: true },
  dsh_session_create: { klass: 'ctrl', readOnlyHint: false },
  dsh_session_list: { klass: 'read', readOnlyHint: true },
  dsh_session_resume: { klass: 'ctrl', readOnlyHint: false },
  dsh_session_set_config: { klass: 'ctrl', readOnlyHint: false },
  dsh_session_ownership: { klass: 'read', readOnlyHint: true },
  dsh_task_submit: { klass: 'write', readOnlyHint: false, realBlocked: true },
  dsh_task_status: { klass: 'read', readOnlyHint: true },
  dsh_task_events: { klass: 'read', readOnlyHint: true },
  dsh_task_result: { klass: 'read', readOnlyHint: true },
  dsh_task_cancel: { klass: 'ctrl', readOnlyHint: false },
  dsh_session_close: { klass: 'ctrl', readOnlyHint: false },
  dsh_git_status: { klass: 'read', readOnlyHint: true },
  dsh_git_diff: { klass: 'read', readOnlyHint: true },
  dsh_git_log: { klass: 'read', readOnlyHint: true },
  dsh_git_branch: { klass: 'read', readOnlyHint: true },
  dsh_git_test_result: { klass: 'read', readOnlyHint: true },
}

/**
 * 任务级/路径级权限策略（P2-B-LOCAL）。
 * 策略文件（JSON）：
 *   { "policy_id": "...", "task_binding": "single", "cwd_root": "F:\\...",
 *     "kinds": ["read"], "tool_pattern": "^(read|list|grep)$", "require_locations": true }
 * 判定顺序：有策略即走策略（全部不匹配 → 拒绝）；无策略退回旧的 title 前缀白名单。
 */
export function loadPermissionPolicy(path) {
  if (!path) return null
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { throw new ToolError('PERMISSION_POLICY_INVALID', `cannot read permission policy: ${e.message}`) }
  if (typeof raw?.cwd_root !== 'string' || !Array.isArray(raw?.kinds) || raw.kinds.length === 0) {
    throw new ToolError('PERMISSION_POLICY_INVALID', 'policy requires cwd_root and non-empty kinds')
  }
  const toolPattern = raw.tool_pattern ? new RegExp(raw.tool_pattern, 'i') : null
  return {
    policy_id: String(raw.policy_id ?? 'unnamed'),
    task_binding: String(raw.task_binding ?? 'single'),
    cwd_root: describePath(raw.cwd_root).real,
    kinds: raw.kinds.map((k) => String(k).toLowerCase()),
    tool_pattern: toolPattern,
    require_locations: raw.require_locations !== false,
  }
}

/** 返回 {decision, reason, detail}；任何不确定都拒绝（fail closed）。 */
export function decideScopedPermission({ policy, title, kind, locations }) {
  if (!policy) return { decision: 'reject-once', reason: 'no-policy' }
  const k = String(kind ?? '').toLowerCase()
  const toolTitle = String(title ?? '')
  if (!k) return { decision: 'reject-once', reason: 'unknown-kind' }
  if (!policy.kinds.includes(k)) return { decision: 'reject-once', reason: 'kind-not-allowed', detail: { kind: k, allowed: policy.kinds } }
  if (policy.tool_pattern && !policy.tool_pattern.test(toolTitle)) {
    return { decision: 'reject-once', reason: 'tool-not-allowed', detail: { title: scrub(toolTitle), pattern: String(policy.tool_pattern) } }
  }
  const paths = (locations ?? []).map((l) => (typeof l === 'string' ? l : l?.path)).filter((p) => typeof p === 'string' && p !== '')
  if (paths.length === 0) {
    return policy.require_locations
      ? { decision: 'reject-once', reason: 'no-locations' }
      : { decision: 'allow-once', reason: `scoped:${policy.policy_id}:no-locations` }
  }
  for (const p of paths) {
    const d = describePath(p)
    if (!within(policy.cwd_root, d.real)) {
      return { decision: 'reject-once', reason: 'path-outside-root', detail: { path: scrub(p), resolved: scrub(d.real), root: scrub(policy.cwd_root) } }
    }
  }
  return { decision: 'allow-once', reason: `scoped:${policy.policy_id}:${k}`, detail: { kind: k, paths: paths.map((p) => scrub(p)).slice(0, 5) } }
}
/**
 * 旧路径：title 前缀白名单（无作用域策略时使用）。默认拒绝。
 */
export function decidePermission(toolCall, resolvedTitle) {
  const title = String(resolvedTitle ?? toolCall?.title ?? '').toLowerCase()
  if (!title) return { decision: 'reject-once', reason: 'unknown-tool-title' }
  const allow = CFG.allowPermissionPrefixes.some((p) => title.startsWith(p))
  return allow
    ? { decision: 'allow-once', reason: 'allowlist:' + CFG.allowPermissionPrefixes.join(',') }
    : { decision: 'reject-once', reason: 'default-deny' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 只读工具授权（P2-B-LOCAL-2）
// 真实事件形态：kind=other、title=read、rawInput.file_path=<path>、locations 为空。
// 因此身份来自"可信只读工具名映射"，路径来自经 schema 允许的 rawInput 字段；
// kind=other 本身不授予任何权限，必须同时满足 工具∈只读集 + 路径在根内 + 无写类参数。
// ─────────────────────────────────────────────────────────────────────────────
export const READONLY_TOOL_NAMES = new Set([
  'read', 'read_file', 'view', 'open', 'cat', 'list', 'list_dir', 'ls', 'stat',
  'glob', 'grep', 'search', 'file_search', 'find', 'tree',
])
// 出现即视为"读取工具夹带写/执行/网络语义"，一律拒绝
export const FORBIDDEN_INPUT_KEYS = new Set([
  'command', 'cmd', 'shell', 'script', 'exec', 'spawn', 'args',
  'content', 'text', 'new_text', 'old_text', 'edits', 'patch', 'diff', 'append',
  'write', 'delete', 'remove', 'rm', 'move', 'rename', 'dest', 'destination', 'target_path_out',
  'url', 'uri', 'body', 'headers', 'method', 'env', 'chmod', 'chown', 'truncate',
])
const PATH_INPUT_KEYS = ['file_path', 'filePath', 'path', 'absolute_path', 'file']

function collectKeys(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 2) return out
  for (const [k, v] of Object.entries(obj)) {
    out.push(String(k))
    if (v && typeof v === 'object' && !Array.isArray(v)) collectKeys(v, depth + 1, out)
  }
  return out
}

function normalizeToolName(title) {
  const s = String(title ?? '').trim().toLowerCase()
  return s.split(/[\s(]/)[0]
}

/** 从 locations 与 rawInput 里提取候选路径（只认白名单字段）。 */
export function extractToolPaths({ locations, rawInput }) {
  const out = []
  for (const l of locations ?? []) {
    const p = typeof l === 'string' ? l : l?.path
    if (typeof p === 'string' && p) out.push(p)
  }
  if (rawInput && typeof rawInput === 'object') {
    for (const k of PATH_INPUT_KEYS) {
      const v = rawInput[k]
      if (typeof v === 'string' && v) out.push(v)
    }
  }
  return [...new Set(out)]
}

/** 只读授权裁决：fail-closed，返回 {decision, reason, detail}。 */
export function decideReadonlyPermission({ policy, title, kind, locations, rawInput }) {
  if (!policy) return { decision: 'reject-once', reason: 'no-policy' }
  const tool = normalizeToolName(title)
  if (!tool) return { decision: 'reject-once', reason: 'missing-tool-identity' }
  const allowedTools = policy.readonly_tools?.length ? policy.readonly_tools.map((t) => String(t).toLowerCase()) : [...READONLY_TOOL_NAMES]
  if (!allowedTools.includes(tool)) {
    return { decision: 'reject-once', reason: 'tool-not-allowed', detail: { tool: scrub(tool) } }
  }
  const k = String(kind ?? '').toLowerCase()
  if (!k) return { decision: 'reject-once', reason: 'missing-kind' }
  const allowedKinds = policy.kinds?.length ? policy.kinds : ['read', 'search', 'other']
  if (!allowedKinds.includes(k)) {
    return { decision: 'reject-once', reason: 'kind-not-allowed', detail: { kind: k, allowed: allowedKinds } }
  }
  const keys = collectKeys(rawInput ?? {})
  const bad = keys.filter((key) => FORBIDDEN_INPUT_KEYS.has(key.toLowerCase()))
  if (bad.length) {
    return { decision: 'reject-once', reason: 'write-params-present', detail: { tool: scrub(tool), params: bad.slice(0, 5) } }
  }
  const paths = extractToolPaths({ locations, rawInput })
  if (paths.length === 0) return { decision: 'reject-once', reason: 'missing-path', detail: { tool: scrub(tool) } }
  for (const p of paths) {
    const abs = isAbsolutePath(p) ? p : resolvePath(policy.cwd_root, p)
    let d
    try { d = describePath(abs) } catch (e) { return { decision: 'reject-once', reason: 'path-unresolvable', detail: { path: scrub(p), error: String(e.message).slice(0, 120) } } }
    // 任一路径段是符号链接/Junction 都拒绝（防重解析点逃逸）
    if (d.reparse_points.length > 0) {
      return { decision: 'reject-once', reason: 'path-link-blocked', detail: { path: scrub(p), resolved: scrub(d.real), links: d.reparse_points.map((x) => scrub(x)).slice(0, 3) } }
    }
    if (!within(policy.cwd_root, d.real)) {
      return { decision: 'reject-once', reason: 'path-outside-root', detail: { path: scrub(p), resolved: scrub(d.real), root: scrub(policy.cwd_root) } }
    }
    if (!d.exists) {
      return { decision: 'reject-once', reason: 'path-missing', detail: { path: scrub(p), resolved: scrub(d.real) } }
    }
  }
  return { decision: 'allow-once', reason: 'readonly:' + tool + ':' + k, detail: { tool: scrub(tool), kind: k, paths: paths.map((p) => scrub(p)).slice(0, 5) } }
}

function resolvePath(root, p) {
  return resolve(root, p)
}
