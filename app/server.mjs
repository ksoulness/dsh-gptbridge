#!/usr/bin/env node
/**
 * dsh-remote-mcp 服务入口（阶段 3：本地运行，可配置公网 issuer）
 * 同源提供：OAuth 2.1 AS + 受保护的 MCP（/mcp）
 *
 * 公网一致性：
 *  - --public-url 决定 issuer/resource（不信任 Host / X-Forwarded-*）
 *  - Host 白名单独立配置（--allow-host），公网域名必须显式加入
 *  - 仍只监听 127.0.0.1（Cloudflare 出站隧道回连本地）
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OAuthStore } from './auth/store.mjs'
import { createOAuth } from './auth/oauth.mjs'
import { createGuard } from './auth/guard.mjs'
import { createCsrf } from './auth/csrf.mjs'
import { createLimiters } from './auth/ratelimit.mjs'
import { createMcp } from './gateway/mcp.mjs'
import { createUpstream } from './gateway/upstream.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const ROOT = resolve(import.meta.dirname)
const CONFIG_PATH = arg('config', join(ROOT, 'config', 'dsh-remote-mcp.json'))
const SECRETS_DIR = arg('secrets-dir', join(ROOT, 'config', 'secrets'))
const LOGS_DIR = arg('logs-dir', join(ROOT, 'logs'))
const ENDPOINT_FILE = arg('endpoint-file', join(LOGS_DIR, 'endpoint.json'))
const UPSTREAM = arg('upstream', '')
const PORT = Number(arg('port', '0'))
const HOST = arg('host', '127.0.0.1')
const BOOT = `${Date.now().toString(36)}-${process.pid}`
const STATE_DIR = arg('state-dir', join(ROOT, 'state'))

mkdirSync(LOGS_DIR, { recursive: true })
const LOG_FILE = join(LOGS_DIR, `service-${BOOT}.log`)
const scrub = (s) => String(s)
  .replace(/(dsh_at_|dsh_rt_|dsh_code_)[A-Za-z0-9_-]+/g, '$1<redacted>')
  .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
  .replace(/(owner_password=)[^&\s]+/gi, '$1<redacted>')
function log(msg) {
  const line = `[${new Date().toISOString()}] ${scrub(msg)}`
  try { appendFileSync(LOG_FILE, line + '\n') } catch { /* ignore */ }
  if (process.env.DSH_REMOTE_VERBOSE) process.stdout.write(line + '\n')
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const exposed = (arg('exposed', '') || cfg.exposedTools.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const allowedTools = [...(cfg.allowedReadTools ?? []), ...(cfg.allowedControlTools ?? [])]
const notAllowed = exposed.filter((t) => !allowedTools.includes(t))
if (notAllowed.length) { console.error('refused: exposed tools not in allowedReadTools: ' + notAllowed.join(',')); process.exit(3) }

const pepperPath = join(SECRETS_DIR, 'pepper.txt')
const ownerPath = join(SECRETS_DIR, 'owner.json')
if (!existsSync(pepperPath) || !existsSync(ownerPath)) { console.error('refused: secrets not initialized'); process.exit(3) }
const pepper = readFileSync(pepperPath, 'utf8').trim()
const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
if (pepper.length < 32) { console.error('refused: pepper too short'); process.exit(3) }

mkdirSync(STATE_DIR, { recursive: true })
const store = new OAuthStore(join(STATE_DIR, 'oauth.sqlite'), pepper)
const upstreamUrl = UPSTREAM || cfg.upstreamUrl
const upstreamHeaders = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--upstream-header' && argv[i + 1]) { const k = argv[i + 1].indexOf(':'); if (k > 0) upstreamHeaders[argv[i + 1].slice(0, k).trim()] = argv[i + 1].slice(k + 1).trim() }
}
const tokenFile = arg('upstream-token-file', '')
let tokenCache = { value: '', mtimeMs: 0 }
function currentToken() {
  if (!tokenFile) return ''
  try {
    const st = statSync(tokenFile)
    if (st.mtimeMs !== tokenCache.mtimeMs) {
      tokenCache = { value: readFileSync(tokenFile, 'utf8').trim(), mtimeMs: st.mtimeMs }
    }
  } catch { return tokenCache.value }
  return tokenCache.value
}
if (tokenFile) {
  const t0 = currentToken()
  if (t0) upstreamHeaders.Authorization = `Bearer ${t0}`
}
const upstreamHeaderFactory = tokenFile ? () => {
  const t = currentToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
} : null
if (!upstreamUrl) { console.error('refused: missing --upstream'); process.exit(3) }

// ---- 公网 URL 与 Host 白名单（互不推导：不信任 Host / X-Forwarded-*） ----
const PUBLIC_URL = String(arg('public-url', cfg.publicUrl ?? '')).replace(/\/+$/, '')
if (PUBLIC_URL && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(PUBLIC_URL)) {
  console.error('refused: --public-url must be https://host (no path, no port)'); process.exit(3)
}
const allowHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
for (const h of String(arg('allow-host', (cfg.allowedHosts ?? []).join(','))).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) allowHosts.add(h)
if (PUBLIC_URL) allowHosts.add(new URL(PUBLIC_URL).hostname.toLowerCase())

const LIMITS = {
  maxBodyBytes: Number(arg('max-body-bytes', String(cfg.limits?.maxBodyBytes ?? 1048576))),
  maxConcurrent: Number(arg('max-concurrent', String(cfg.limits?.maxConcurrent ?? 8))),
}
const limiters = createLimiters(cfg.rateLimits ?? {})
let inflight = 0
const csrf = createCsrf(pepper)

// 日志保留：启动时清理超过保留期的 service-*.log（默认 14 天）
const RETENTION_DAYS = Number(cfg.logRetentionDays ?? 14)
try {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000
  for (const f of readdirSync(LOGS_DIR)) {
    if (!/^service-.*\.log$/.test(f)) continue
    const p = join(LOGS_DIR, f)
    if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
  }
} catch { /* ignore */ }

let ctx = null

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...extra })
  res.end(text)
}
function routeName(pathname) {
  if (pathname === '/mcp') return 'mcp'
  if (pathname === '/authorize') return 'authorize'
  if (pathname === '/token') return 'token'
  if (pathname === '/register') return 'register'
  if (pathname === '/revoke') return 'revoke'
  if (pathname.startsWith('/.well-known/')) return 'metadata'
  return 'other'
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = []; let tooBig = false
    req.on('data', (c) => {
      size += c.length
      if (size > LIMITS.maxBodyBytes) { tooBig = true; chunks.length = 0; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooBig) return fail(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return ok({})
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase()
      if (ctype.includes('application/x-www-form-urlencoded')) return ok(Object.fromEntries(new URLSearchParams(text)))
      try { ok(JSON.parse(text)) } catch { fail(Object.assign(new Error('invalid json'), { code: 'BAD_JSON' })) }
    })
    req.on('error', fail)
  })
}

const server = createServer(async (req, res) => {
  const started = Date.now()
  try {
    const hostName = String(req.headers.host ?? '').toLowerCase().split(':')[0]
    if (!allowHosts.has(hostName)) { log(`reject host=${hostName}`); return sendJson(res, 403, { error: 'host_not_allowed' }) }
    if (!ctx) return sendJson(res, 503, { error: 'starting' })
    // 真实身份只取 socket 对端；X-Forwarded-For 不参与任何判定
    const ip = req.socket.remoteAddress ?? 'unknown'
    const url = new URL(req.url, ctx.issuer)
    const route = routeName(url.pathname)
    const lim = limiters.hit(route, ip)
    if (!lim.ok) {
      log(`rate_limited route=${route}`)
      return sendJson(res, 429, { error: 'rate_limited', route }, { 'retry-after': String(Math.ceil(lim.retryAfterMs / 1000)) })
    }
    if (inflight >= LIMITS.maxConcurrent) return sendJson(res, 503, { error: 'too_many_concurrent' })
    inflight += 1
    try {
      if (req.method === 'POST') {
        try { req.body = await readBody(req) } catch (e) {
          if (e.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'request_too_large', limit: LIMITS.maxBodyBytes })
          return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        }
      }
      if (url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, boot: BOOT, issuer: ctx.issuer, resource: ctx.resource, exposed, mode: PUBLIC_URL ? 'public-url' : 'local' })
      }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
        const out = await ctx.mcp.handle(req.body, req)
        if (out === null) { res.writeHead(202); return res.end() }
        if (out.httpStatus) {
          if (out.httpStatus === 401 || out.httpStatus === 403) store.audit('mcp_denied', { detail: { status: out.httpStatus } })
          return sendJson(res, out.httpStatus, out.body, out.www ? { 'www-authenticate': out.www } : {})
        }
        return sendJson(res, 200, out)
      }
      if (await ctx.oauth.handle(req, res, url)) return
      return sendJson(res, 404, { error: 'not_found' })
    } finally {
      inflight -= 1
      log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`)
    }
  } catch (e) {
    log(`handler_failure ${String(e?.message ?? e)}`)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
    else try { res.end() } catch { /* ignore */ }
  }
})

server.on('error', (e) => { console.error(`listen failed: ${e.code} ${e.message}`); process.exit(3) })

server.listen(PORT, HOST, () => {
  const actual = server.address().port
  const issuer = PUBLIC_URL || `http://127.0.0.1:${actual}`
  const resource = `${issuer}/mcp`
  const oauth = createOAuth({ store, config: { issuer, resource, scopes: cfg.scopes, owner, accessTtlMs: cfg.accessTtlMs, refreshTtlMs: cfg.refreshTtlMs, csrf, limiters } })
  try {
    const days = Number(cfg.auditRetentionDays ?? 30)
    const pruned = store.pruneAudit(days)
    if (pruned > 0) log(`audit pruned ${pruned} rows (retention ${days}d)`)
  } catch { /* 清理失败不影响启动 */ }
  const guard = createGuard({ store, config: { issuer, resource, scope: cfg.scope, exposedTools: exposed, toolScope: cfg.toolScope ?? {} } })
  const mcp = createMcp({ config: { exposedTools: exposed, runPermissionPreset: cfg.runPermissionPreset ?? 'danger-full-access', runPermissionPresetMode: cfg.runPermissionPresetMode ?? 'enforce' }, guard, upstream: createUpstream(upstreamUrl, { headers: upstreamHeaders, headersFactory: upstreamHeaderFactory }), audit: (ev, d) => store.audit(ev, d) })
  ctx = { issuer, resource, oauth, guard, mcp, port: actual }
  writeFileSync(ENDPOINT_FILE, JSON.stringify({
    url: resource, issuer, port: actual, boot: BOOT, exposedTools: exposed, scopes: cfg.scopes,
    mode: PUBLIC_URL ? 'public-url' : 'local', publicUrl: PUBLIC_URL || null,
    allowHosts: [...allowHosts], started_at: new Date().toISOString(),
  }, null, 2))
  log(`listening 127.0.0.1:${actual} issuer=${issuer} upstream=${upstreamUrl} exposed=${exposed.join(',')} mode=${PUBLIC_URL ? 'public-url' : 'local'}`)
  process.stdout.write(`REMOTE_MCP_LISTEN 127.0.0.1:${actual}\n`)
})

process.on('SIGTERM', () => { log('sigterm'); try { server.close() } catch { } process.exit(0) })
process.on('SIGINT', () => { log('sigint'); try { server.close() } catch { } process.exit(0) })
