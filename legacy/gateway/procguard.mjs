/**
 * 动态进程身份与安全清理（P2-B-LOCAL-2）
 *
 * 原则：
 *  1) 禁止硬编码任何 PID；一律按"可执行文件 + 命令行 + 监听端口 + 启动时间"动态识别。
 *  2) 清理前必须重新核验身份（creation_time + 可执行文件 + 命令行指纹），任何不一致都拒绝。
 *  3) 端口只是辅助证据；不能仅凭"占用 3079"认定是 DSH。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { request as httpRequest } from 'node:http'

const PS = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

function runPs(script, timeout = 25000) {
  try {
    return execFileSync(PS, [...PS_ARGS, script], { encoding: 'utf8', timeout, windowsHide: true })
  } catch (e) {
    return ''
  }
}

export function normalizeCmdline(cmd) {
  return String(cmd ?? '').replace(/\s+/g, ' ').trim()
}

export function fingerprint(cmdline) {
  return createHash('sha256').update(normalizeCmdline(cmdline)).digest('hex')
}

/** 一次取全量进程快照：pid -> { pid, ppid, exe, cmdline, creation, fp } */
export function snapshot() {
  const out = runPs('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress')
  const map = new Map()
  let arr = []
  try { arr = JSON.parse(out || '[]') } catch { arr = [] }
  if (!Array.isArray(arr)) arr = [arr]
  for (const r of arr) {
    const pid = Number(r.ProcessId)
    if (!Number.isFinite(pid)) continue
    const cmdline = r.CommandLine ?? ''
    map.set(pid, {
      pid,
      ppid: Number(r.ParentProcessId),
      exe: r.ExecutablePath ?? '',
      cmdline,
      creation: String(r.CreationDate ?? ''),
      fp: fingerprint(cmdline),
    })
  }
  return map
}

/** 监听端口表：port -> [{pid, addr}] */
export function listeners() {
  const out = runPs('Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress')
  const map = new Map()
  let arr = []
  try { arr = JSON.parse(out || '[]') } catch { arr = [] }
  if (!Array.isArray(arr)) arr = [arr]
  for (const r of arr) {
    const port = Number(r.LocalPort)
    if (!Number.isFinite(port)) continue
    if (!map.has(port)) map.set(port, [])
    map.get(port).push({ pid: Number(r.OwningProcess), addr: r.LocalAddress })
  }
  return map
}

export function captureIdentity(pid, snap = null) {
  const s = snap ?? snapshot()
  const p = s.get(Number(pid))
  if (!p) return null
  return { pid: p.pid, ppid: p.ppid, exe: p.exe, exe_name: basename(p.exe || ''), creation: p.creation, cmdline: p.cmdline, fp: p.fp }
}

/**
 * 服务角色定义：全部基于内容特征，不含任何 PID / 端口硬编码。
 * 端口仅用于交叉验证，不作为唯一判据。
 */
const HARNESS = /p2[ab]-local|p2a[\\/]|proc-status|proc-kill|gateway\.mjs|provider-proxy\.mjs/i

export const ROLES = [
  {
    role: 'dsh-web',
    // node 宿主 + dsh 入口 + web 模式；不看端口（端口只做交叉验证）
    match: (p) => /node\.exe$/i.test(p.exe) && /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(p.cmdline)
      && (/\sweb(\s|$)/.test(p.cmdline) || /--profile\s+web\b/.test(p.cmdline)) && !HARNESS.test(p.cmdline),
    kind: 'http',
  },
  {
    role: 'codex-with-chatgpt',
    // 该服务是 node 宿主 + codex 关键字 + 自身持有监听端口；ChatGPT.exe/UI 子进程与 shell 一律排除
    match: (p, lis) => /^node\.exe$/i.test(basename(p.exe)) && /codex/i.test(p.cmdline) && !HARNESS.test(p.cmdline)
      && [...lis.values()].some((arr) => arr.some((x) => x.pid === p.pid)),
    kind: 'tcp',
  },
  {
    role: 'cloudflared',
    match: (p) => /^cloudflared(\.exe)?$/i.test(basename(p.exe)),
    kind: 'tcp',
  },
]

/** 发现某一角色的当前实例（可能多个 → ambiguous） */
export function discover(snap, lis, roleName) {
  const def = ROLES.find((r) => r.role === roleName)
  if (!def) return { role: roleName, found: false, reason: 'unknown-role' }
  const hits = [...snap.values()].filter((p) => def.match(p, lis))
  const enriched = hits.map((p) => ({
    pid: p.pid, ppid: p.ppid, exe: p.exe, exe_name: basename(p.exe || ''), creation: p.creation,
    fp: p.fp, ports: [...lis.entries()].filter(([, arr]) => arr.some((x) => x.pid === p.pid)).map(([port]) => port).sort((a, b) => a - b),
  }))
  return { role: roleName, found: enriched.length > 0, ambiguous: enriched.length > 1, instances: enriched }
}

/** 单次 HTTP 健康探测（只读，不触达模型） */
export function httpProbe(port, path = '/', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve({ reachable: true, status: res.statusCode ?? 0 })
    })
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, status: 0, error: 'timeout' }) })
    req.on('error', (e) => resolve({ reachable: false, status: 0, error: String(e.code ?? e.message) }))
    req.end()
  })
}

/**
 * 服务状态分类（允许 PID 正常变化）：
 *   healthy | restarted | stopped | replaced | ambiguous | port-conflict | health-failed | not-running
 */
export function classify(prev, cur) {
  const prevOk = prev?.found && !prev.ambiguous
  const curOk = cur?.found && !cur.ambiguous
  if (prev?.found && prev?.ambiguous && cur?.found && cur?.ambiguous) {
    // 多实例角色（如两条 cloudflared）：PID 集合与端口集合都一致即视为未变化
    const ps = (s) => (s.instances ?? []).map((i) => i.pid).sort().join(',')
    const pts = (s) => (s.health?.ports ?? []).slice().sort().join(',')
    return ps(prev) === ps(cur) && pts(prev) === pts(cur) ? 'healthy' : 'ambiguous'
  }
  if (!prevOk && !curOk) return 'not-running'
  if (prevOk && !curOk) return cur?.found ? 'ambiguous' : 'stopped'
  if (!prevOk && curOk) return 'restarted' // 之前无、现在有 → 视为新启动
  const a = prev.instances[0]
  const b = cur.instances[0]
  if (a.pid === b.pid && a.creation === b.creation) return 'healthy'
  if (a.pid !== b.pid && a.fp === b.fp) return 'restarted' // 同身份不同 PID → 正常重启
  if (a.pid !== b.pid && a.fp !== b.fp) return 'replaced'   // 身份变了 → 不是同一服务
  return 'health-failed'
}

/**
 * 只清理"自己启动且身份完全一致"的进程；任何不确定都拒绝。
 * identity: { pid, creation, exe, fp }
 */
export function killVerified(identity, { snap = null } = {}) {
  if (!identity?.pid) return { killed: false, reason: 'no-identity' }
  const s = snap ?? snapshot()
  const cur = s.get(Number(identity.pid))
  if (!cur) return { killed: false, reason: 'pid-gone' }
  if (identity.creation && cur.creation !== identity.creation) return { killed: false, reason: 'pid-reused', detail: { recorded: identity.creation, current: cur.creation } }
  if (identity.fp && cur.fp !== identity.fp) return { killed: false, reason: 'cmdline-mismatch', detail: { recorded: identity.fp.slice(0, 16), current: cur.fp.slice(0, 16) } }
  if (identity.exe && cur.exe && identity.exe !== cur.exe) return { killed: false, reason: 'exe-mismatch', detail: { recorded: basename(identity.exe), current: basename(cur.exe) } }
  try {
    execFileSync('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    return { killed: true, reason: 'verified-tree-kill' }
  } catch (e) {
    return { killed: false, reason: 'taskkill-failed:' + String(e.message).slice(0, 120) }
  }
}
