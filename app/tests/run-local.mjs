#!/usr/bin/env node
/**
 * dsh-gptbridge · 阶段 1/2 本地安全测试（20 项）
 * 全部在本机回环 + Mock 上游完成：不触达公网、不发真实模型请求、不动生产服务。
 */
import { createServer } from 'node:http'
import httpMod from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUN = join(ROOT, 'state', `test-${Date.now().toString(36)}`)
mkdirSync(RUN, { recursive: true })
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- Mock 上游（只读 DSH Gateway 的替身） ----------
const READ_TOOLS = [
  ['dsh_health', { type: 'object', properties: {} }],
  ['dsh_session_list', { type: 'object', properties: {} }],
  ['dsh_session_ownership', { type: 'object', properties: { session_id: { type: 'string' } } }],
  ['dsh_task_status', { type: 'object', properties: { task_id: { type: 'string' } } }],
  ['dsh_task_events', { type: 'object', properties: { task_id: { type: 'string' }, limit: { type: 'number' } } }],
  ['dsh_task_result', { type: 'object', properties: { task_id: { type: 'string' } } }],
  ['dsh_git_status', { type: 'object', properties: { cwd: { type: 'string' } } }],
  ['dsh_git_diff', { type: 'object', properties: { cwd: { type: 'string' } } }],
  ['dsh_git_log', { type: 'object', properties: { cwd: { type: 'string' } } }],
  ['dsh_git_branch', { type: 'object', properties: { cwd: { type: 'string' } } }],
  ['dsh_git_test_result', { type: 'object', properties: { cwd: { type: 'string' } } }],
]
const mockState = { big: false, calls: 0 }
const mock = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => {
    let msg = {}
    try { msg = JSON.parse(b) } catch { }
    mockState.calls += 1
    const send = (o) => { const t = JSON.stringify(o); res.writeHead(200, { 'content-type': 'application/json' }); res.end(t) }
    if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: READ_TOOLS.map(([name, inputSchema]) => ({ name, description: name, inputSchema, annotations: { readOnlyHint: true } })) } })
    if (msg.method === 'tools/call') {
      if (mockState.big) return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x'.repeat(400_000) }], structuredContent: { pad: 'x'.repeat(400_000) } } })
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, tool_mode: 'read-only', exposed_tools: 11, source: 'mock-upstream' }, isError: false } })
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
  })
})
await new Promise((ok) => mock.listen(0, '127.0.0.1', ok))
const mockUrl = `http://127.0.0.1:${mock.address().port}/mcp`

// ---------- 测试用密钥与配置 ----------
const secDir = join(RUN, 'secrets'); mkdirSync(secDir, { recursive: true })
const OWNER = 'test-owner-password-123'
const salt = randomBytes(16)
writeFileSync(join(secDir, 'owner.json'), JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(OWNER, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), n: 16384, r: 8, p: 1 }))
writeFileSync(join(secDir, 'pepper.txt'), randomBytes(48).toString('hex'))
const cfgPath = join(RUN, 'config.json')
const baseCfg = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'))
writeFileSync(cfgPath, JSON.stringify({ ...baseCfg, publicUrl: '', allowedHosts: [], upstreamUrl: mockUrl, exposedTools: ['dsh_health'] }, null, 2))
const endpointFile = join(RUN, 'endpoint.json')

// ---------- 启动服务（固定端口便于重启测试） ----------
const net = await import('node:net')
const freePort = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const FIXED = freePort
function startService(extra = []) {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(FIXED), '--config', cfgPath,
    '--secrets-dir', secDir, '--state-dir', join(RUN, 'state'), '--logs-dir', join(RUN, 'logs'),
    '--endpoint-file', endpointFile, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const ready = new Promise((ok, no) => {
    let buf = ''
    child.stdout.on('data', (d) => { buf += d.toString(); if (/REMOTE_MCP_LISTEN/.test(buf)) ok() })
    child.on('exit', (c) => no(new Error('service exited ' + c)))
    setTimeout(() => no(new Error('service start timeout')), 15000)
  })
  return { child, ready }
}
let svc = startService()
await svc.ready
const ep = JSON.parse(readFileSync(endpointFile, 'utf8'))
const ISSUER = ep.issuer
const MCP = ep.url

// ---------- HTTP 助手 ----------
function post(pathname, body, headers = {}) {
  return new Promise((ok, no) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    const u = new URL(pathname, ISSUER)
    const req = httpMod.request({
      host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { host: `127.0.0.1:${u.port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => { let j = null; try { j = JSON.parse(t) } catch { } ok({ status: res.statusCode, json: j, text: t, headers: res.headers }) }) })
    req.on('error', no); req.end(payload)
  })
}

function form(pathname, obj, headers = {}) {
  const payload = new URLSearchParams(obj).toString()
  return new Promise((ok, no) => {
    const u = new URL(pathname, ISSUER)
    const req = httpMod.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { host: `127.0.0.1:${u.port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload), ...headers } },
    (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode, text: t, location: res.headers.location, headers: res.headers, json: (() => { try { return JSON.parse(t) } catch { return null } })() })) })
    req.on('error', no); req.end(payload)
  })
}
function get(pathname, headers = {}) {
  return new Promise((ok, no) => {
    const u = new URL(pathname, ISSUER)
    const req = httpMod.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: `127.0.0.1:${u.port}`, ...headers } },
      (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode, text: t, json: (() => { try { return JSON.parse(t) } catch { return null } })(), headers: res.headers })) })
    req.on('error', no); req.end()
  })
}
const rpc = (name, args, token, id = 1) => post('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  token ? { authorization: `Bearer ${token}` } : {})
// 走完整授权码 + PKCE 流程拿一组新令牌（每次都是独立 family）
async function issueToken() {
  const v = randomBytes(32).toString('base64url')
  const c = createHash('sha256').update(v).digest('base64url')
  const q = `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${c}&code_challenge_method=S256&scope=dsh%3Aread&state=sx&resource=${encodeURIComponent(MCP)}`
  const consentX = await get(q)
  const csrfX = (/name="csrf_token" value="([^"]+)"/.exec(consentX.text) ?? [])[1]
  const f = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: c, code_challenge_method: 'S256', scope: 'dsh:read', state: 'sx', resource: MCP, decision: 'allow', owner_password: OWNER, csrf_token: csrfX })
  const code = new URL(f.location).searchParams.get('code')
  const r = await form('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v, resource: MCP })
  return { access: r.json.access_token, refresh: r.json.refresh_token, status: r.status }
}

// ---------- OAuth 全流程 ----------
const CLIENT_NAME = 'ChatGPT Test Client'
const REDIRECT = 'http://127.0.0.1:9999/callback'
const reg = await post('/register', { client_name: CLIENT_NAME, redirect_uris: [REDIRECT] })
const clientId = reg.json?.client_id
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const authQuery = `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=dsh%3Aread&state=st1&resource=${encodeURIComponent(MCP)}`
const consent = await get(authQuery)

record('1 未授权请求 → 401 + WWW-Authenticate', await (async () => { const r = await rpc('dsh_health', {}, null); return r.status === 401 && /Bearer/.test(r.headers['www-authenticate'] ?? '') })(), '')
record('2 OAuth 元数据与受保护资源元数据可用', await (async () => {
  const m = await get('/.well-known/oauth-authorization-server'); const p = await get('/.well-known/oauth-protected-resource')
  return m.status === 200 && m.json.issuer === ISSUER && p.json.resource === MCP && p.json.authorization_servers?.[0] === ISSUER
})(), `issuer=${ISSUER}`)
record('3 授权页展示应用/Scopes/资源/权限范围', consent.status === 200 && consent.text.includes(CLIENT_NAME) && consent.text.includes('dsh:read') && consent.text.includes(MCP) && consent.text.includes('不能'), '')

const csrf1 = (/name="csrf_token" value="([^"]+)"/.exec(consent.text) ?? [])[1]
const allow = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'st1', resource: MCP, decision: 'allow', owner_password: OWNER, csrf_token: csrf1 })
const code = allow.location ? new URL(allow.location).searchParams.get('code') : null
const tok = await form('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP })
const access = tok.json?.access_token
const refresh = tok.json?.refresh_token
record('4 Authorization Code + PKCE 换取令牌成功', tok.status === 200 && /^dsh_at_/.test(access ?? '') && /^dsh_rt_/.test(refresh ?? ''), `expires_in=${tok.json?.expires_in}`)

const ok1 = await rpc('dsh_health', {}, access)
record('5 授权后 dsh_health 调用成功（只读）', ok1.status === 200 && ok1.json?.result?.structuredContent?.ok === true, `mode=${ok1.json?.result?.structuredContent?.tool_mode}`)

const replay = await form('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP })
record('6 授权码重放被拒绝', replay.status === 400 && /invalid_grant/.test(replay.text), '')

const badPkce = await (async () => {
  const c2 = await get(authQuery); const cc = (/name="csrf_token" value="([^"]+)"/.exec(c2.text) ?? [])[1]
  const f2 = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 's', resource: MCP, decision: 'allow', owner_password: OWNER, csrf_token: cc })
  const code2 = new URL(f2.location).searchParams.get('code')
  return form('/token', { grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxx', resource: MCP })
})()
record('7 PKCE 校验失败被拒绝', badPkce.status === 400 && /invalid_grant/.test(badPkce.text), '')

record('8 Refresh Token 轮换成功', await (async () => {
  const r = await form('/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })
  return r.status === 200 && r.json.access_token !== access && r.json.refresh_token !== refresh
})(), '')

const refreshReuse = await form('/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })
const afterReuse = await rpc('dsh_health', {}, access)
record('9 Refresh Token 重放 → family 撤销且旧 access 失效', refreshReuse.status === 400 && afterReuse.status === 401, '')

const tok2 = await issueToken()
await form('/revoke', { token: tok2.access })
record('10 Token 撤销后使用 → 401', (await rpc('dsh_health', {}, tok2.access)).status === 401, '')
const tok3 = await issueToken()
const access3 = tok3.access

record('11 Redirect URI 未注册 → 拒绝', await (async () => { const r = await get(`/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=dsh%3Aread`) ; return r.status === 400 && /invalid_redirect_uri/.test(r.text) })(), '')
record('12 缺少 PKCE → 拒绝', await (async () => { const r = await get(`/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=dsh%3Aread`); return r.status === 400 && /PKCE/.test(r.text) })(), '')
record('13 Host Header 攻击 → 403', await (async () => { const h = await new Promise((ok) => { const u = new URL(MCP); const q = httpMod.request({ host: '127.0.0.1', port: u.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode) }); q.on('error', () => ok(0)); q.end('{}') }); return h === 403 })(), '')
record('14 未注册工具调用被拒绝', await (async () => { const r = await rpc('dsh_task_submit', { prompt: 'x' }, access3); return r.json?.error?.code === -32003 || r.status === 404 })(), '')
record('15 已注册但未开放的只读工具仍被拒绝（白名单）', await (async () => { const r = await rpc('dsh_git_diff', { cwd: 'C:\\' }, access3); return r.json?.error?.code === -32003 })(), '')
record('16 请求参数注入被拒绝', await (async () => { const r = await rpc('dsh_health', { evil: true }, access3); return r.json?.error?.code === -32602 })(), '')
record('17 超大请求体 → 413', await (async () => { const r = await post('/mcp', 'x'.repeat(1_200_000)); return r.status === 413 })(), '')

// 伪造 issuer / audience / scope：直接写入存储模拟被篡改的令牌
const { OAuthStore } = await import('../auth/store.mjs')
const storePepper = readFileSync(join(secDir, 'pepper.txt'), 'utf8').trim()
const st = new OAuthStore(join(RUN, 'state', 'oauth.sqlite'), storePepper)
const mkToken = (over) => {
  const t = 'dsh_at_' + randomBytes(24).toString('base64url')
  st.q.putAccess.run(st.hash(t), over.clientId ?? clientId, over.scope ?? 'dsh:read', over.audience ?? MCP, over.issuer ?? ISSUER, 'fam-x', Date.now(), over.expires ?? Date.now() + 60000)
  return t
}
record('18 伪造 Audience → 401', (await rpc('dsh_health', {}, mkToken({ audience: 'https://other.example/mcp' }))).status === 401, '')
record('19 伪造 Issuer → 401', (await rpc('dsh_health', {}, mkToken({ issuer: 'https://evil.example' }))).status === 401, '')
const scopeTok = mkToken({ scope: 'dsh:write' })
record('20 Scope 不足 → 403', (await rpc('dsh_health', {}, scopeTok)).status === 403, '')

// 进程异常退出与恢复：杀掉服务，重启同端口，旧 token 仍有效
svc.child.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 600))
const validTok = access3
svc = startService()
await svc.ready
const afterRestart = await rpc('dsh_health', {}, validTok)
record('21 服务异常退出并重启后，未过期 Token 仍有效（issuer 不变）', afterRestart.status === 200, '')

// 上游不可用 / 大输出：故障隔离
const svcDown = await (async () => { mockState.big = true; const r = await rpc('dsh_health', {}, validTok); return r })()
record('22 上游返回超大输出 → 拒绝并保持服务可用（故障隔离）', svcDown.json?.error?.code === -32603 && (await get('/health')).status === 200, `code=${svcDown.json?.error?.code}`)

mockState.big = false
const concurrent = await Promise.all(Array.from({ length: 8 }, () => rpc('dsh_health', {}, validTok)))
record('23 多客户端并发（8 并发）全部成功', concurrent.every((r) => r.status === 200), '')

// 上游真的挂掉：关闭 mock
await new Promise((r) => mock.close(r))
const isolated = await rpc('dsh_health', {}, validTok)
record('24 上游 DSH Gateway 不可用 → 明确错误且自身不崩', isolated.json?.error?.code === -32603 && (await get('/health')).status === 200, '')

// 令牌泄漏扫描
const logDir = join(RUN, 'logs')
const { readdirSync } = await import('node:fs')
const logText = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n')
record('25 日志中无令牌/密钥明文', !/dsh_at_[A-Za-z0-9_-]{10,}/.test(logText) && !/dsh_rt_[A-Za-z0-9_-]{10,}/.test(logText) && !logText.includes(OWNER), `logs=${readdirSync(logDir).length}`)

// 清理
try { svc.child.kill('SIGTERM') } catch { }
await new Promise((r) => setTimeout(r, 500))
const passed = results.filter((r) => r.ok).length
writeFileSync(join(ROOT, 'logs', 'local-test-summary.json'), JSON.stringify({ at: new Date().toISOString(), issuer: ISSUER, mcp: MCP, passed, total: results.length, results }, null, 2))
console.log(`\nSUMMARY[dsh-gptbridge local] PASS=${passed} FAIL=${results.length - passed} total=${results.length}`)
try { if (!process.env.KEEP_TEST_STATE) rmSync(RUN, { recursive: true, force: true }) } catch { }
process.exit(passed === results.length ? 0 : 1)
