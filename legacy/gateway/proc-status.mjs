#!/usr/bin/env node
/**
 * 动态服务状态探针（只读）。
 * 输出 JSON：每个角色的实例（pid/exe/creation/fingerprint/ports）+ 健康状态。
 * 用于测试前后对比：允许 PID 变化，不允许身份被替换。
 *
 * 用法：
 *   node gateway/proc-status.mjs --out before.json
 *   node gateway/proc-status.mjs --compare before.json
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { snapshot, listeners, discover, classify, httpProbe } from './procguard.mjs'
import { connect } from 'node:net'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d }

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = connect({ host, port })
    const done = (r) => { try { s.destroy() } catch { /* ignore */ } resolve(r) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done({ reachable: true }))
    s.once('timeout', () => done({ reachable: false, error: 'timeout' }))
    s.once('error', (e) => done({ reachable: false, error: String(e.code ?? e.message) }))
  })
}

async function collect() {
  const snap = snapshot()
  const lis = listeners()
  const out = { at: new Date().toISOString(), services: {} }
  for (const role of ['dsh-web', 'codex-with-chatgpt', 'cloudflared']) {
    const d = discover(snap, lis, role)
    const inst = d.instances?.[0]
    let health = { reachable: false, note: 'not-running' }
    if (inst) {
      const ports = inst.ports ?? []
      if (role === 'dsh-web') {
        const p = ports.find((x) => x > 1024) ?? ports[0]
        health = p ? await httpProbe(p, '/') : { reachable: false, note: 'no-listening-port' }
      } else {
        const p = ports[0]
        health = p ? await tcpProbe('127.0.0.1', p) : { reachable: false, note: 'no-listening-port' }
      }
      health.ports = ports
    }
    out.services[role] = { ...d, health }
  }
  // 本地模型网关：不在本机进程表内，仅做 TCP 探测（不推理、不带凭据）
  const modelHost = arg('model-host', '127.0.0.1:8080').split(':')
  out.services['model-gateway'] = {
    role: 'model-gateway', found: false, note: 'remote-lan-service',
    target: modelHost.join(':'), health: await tcpProbe(modelHost[0], Number(modelHost[1] ?? 80)),
  }
  return out
}

const cur = await collect()
const outPath = arg('out', '')
if (outPath) { writeFileSync(outPath, JSON.stringify(cur, null, 2)); console.log('written ' + outPath) }

const cmpPath = arg('compare', '')
if (cmpPath) {
  const prev = JSON.parse(readFileSync(cmpPath, 'utf8'))
  const rows = []
  for (const role of Object.keys(cur.services)) {
    const a = prev.services?.[role]
    const b = cur.services[role]
    const verdict = role === 'model-gateway'
      ? (a?.health?.reachable === b.health.reachable ? 'healthy' : 'changed')
      : classify(a, b)
    rows.push({
      role,
      verdict,
      before: a ? { pid: a.instances?.[0]?.pid ?? null, creation: a.instances?.[0]?.creation ?? null, fp: a.instances?.[0]?.fp?.slice(0, 12) ?? null, ports: a.health?.ports ?? [], reachable: a.health?.reachable ?? null } : null,
      after: { pid: b.instances?.[0]?.pid ?? null, creation: b.instances?.[0]?.creation ?? null, fp: b.instances?.[0]?.fp?.slice(0, 12) ?? null, ports: b.health?.ports ?? (b.health?.ports ?? []), reachable: b.health?.reachable ?? null },
    })
  }
  console.log(JSON.stringify({ at: cur.at, comparison: rows }, null, 2))
} else if (!outPath) {
  console.log(JSON.stringify(cur, null, 2))
}
