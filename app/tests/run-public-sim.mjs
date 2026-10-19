#!/usr/bin/env node
/**
 * P3-3 · 纯本地「公网环境」模拟（Mock HTTPS Origin + 边缘代理）
 * 验证：public-url 决定 issuer/resource；X-Forwarded-* 不被信任；Host 白名单；CSRF；分端点限流；
 *       scope/audience/撤销；日志脱敏；重启恢复。
 */
import { createServer } from 'node:http'
import httpMod from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUN = join(ROOT, 'state', `public-${Date.now().toString(36)}`)
mkdirSync(RUN, { recursive: true })
const results = []
const record = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`) }

const PUBLIC = 'https://dsh-mcp.test'
const OWNER = 'public-owner-password-123'

// Mock 只读上游
const READ = [['dsh_health', { type: 'object', properties: {} }], ['dsh_git_diff', { type: 'object', properties: { cwd: { type: 'string' } } }]]
const mock = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => {
    let m = {}; try { m = JSON.parse(b) } catch { }
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: READ.map(([name, inputSchema]) => ({ name, description: name, inputSchema })) } })
    if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, tool_mode: 'read-only' }, isError: false } })
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } })
  })
})
await new Promise((ok) => mock.listen(0, '127.0.0.1', ok))
const mockUrl = `http://127.0.0.1:${mock.address().port}/mcp`

const secDir = join(RUN, 'secrets'); mkdirSync(secDir, { recursive: true })
const salt = randomBytes(16)
writeFileSync(join(secDir, 'owner.json'), JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(OWNER, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), n: 16384, r: 8, p: 1 }))
writeFileSync(join(secDir, 'pepper.txt'), randomBytes(48).toString('hex'))
const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'))
writeFileSync(join(RUN, 'config.json'), JSON.stringify({ ...cfg, publicUrl: '', allowedHosts: [], upstreamUrl: mockUrl, exposedTools: ['dsh_health'] }, null, 2))
const epFile = join(RUN, 'endpoint.json')

const net = await import('node:net')
const PORT = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
function start() {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(PORT), '--config', join(RUN, 'config.json'),
    '--secrets-dir', secDir, '--state-dir', join(RUN, 'state'), '--logs-dir', join(RUN, 'logs'), '--endpoint-file', epFile,
    '--public-url', PUBLIC, '--allow-host', '127.0.0.1,localhost,dsh-mcp.test'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const ready = new Promise((ok, no) => { child.stdout.on('data', (d) => { if (/REMOTE_MCP_LISTEN/.test(d.toString())) ok() }); child.on('exit', (c) => no(new Error('exited ' + c))); setTimeout(() => no(new Error('timeout')), 15000) })
  return { child, ready }
}
let svc = start(); await svc.ready

// 边缘代理：模拟 Cloudflare（Host=公网域名，附带伪造的 X-Forwarded-*）
const edge = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const p = httpMod.request({
      host: '127.0.0.1', port: PORT, path: req.url, method: req.method,
      headers: {
        host: 'dsh-mcp.test',
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
        'content-length': body.length,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.attacker.test',
        'x-forwarded-for': '203.0.113.9',
        authorization: req.headers.authorization ?? '',
      },
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    p.end(body)
  })
})
await new Promise((ok) => edge.listen(0, '127.0.0.1', ok))
const EDGE = edge.address().port

const call = (path, opts = {}) => new Promise((ok) => {
  const payload = opts.body === undefined ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const r = httpMod.request({ host: '127.0.0.1', port: opts.direct ? PORT : EDGE, path, method: opts.method ?? 'POST',
    headers: { host: opts.host ?? `127.0.0.1:${opts.direct ? PORT : EDGE}`, 'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(opts.headers ?? {}) } },
  (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode, text: t, headers: res.headers, location: res.headers.location, json: (() => { try { return JSON.parse(t) } catch { return null } })() })) })
  r.on('error', () => ok({ status: 0, text: 'conn-error' }))
  r.end(payload ?? undefined)
})
const form = (path, obj) => call(path, { body: Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'), form: true })
const get = (path) => call(path, { method: 'GET' })
const rpc = (name, args, token) => call('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: token ? { authorization: `Bearer ${token}` } : {} })
const csrfOf = (html) => (/name="csrf_token" value="([^"]+)"/.exec(html) ?? [])[1]

// P1/P2 discovery 走代理，issuer 必须是公网 URL
const meta = await get('/.well-known/oauth-authorization-server')
const prm = await get('/.well-known/oauth-protected-resource')
record('P1 AS metadata：issuer 与全部端点均为公网地址', meta.status === 200 && meta.json.issuer === PUBLIC && meta.json.token_endpoint === PUBLIC + '/token' && meta.json.authorization_endpoint === PUBLIC + '/authorize', `issuer=${meta.json?.issuer}`)
record('P2 PRM：resource 为公网 MCP 资源，authorization_servers 指向自身', prm.json.resource === PUBLIC + '/mcp' && prm.json.authorization_servers?.[0] === PUBLIC)
record('P3 伪造 X-Forwarded-Host 不影响 issuer', meta.json.issuer === PUBLIC && !meta.text.includes('evil.attacker.test'))

// P4 直连（Host=公网域名、XFH 伪造）→ 未带 token 应 401
const noToken = await call('/mcp', { direct: true, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_health', arguments: {} } } })
record('P4 未授权 /mcp → 401（走公网 Host 直连）', noToken.status === 401 && /Bearer/.test(noToken.headers['www-authenticate'] ?? ''))

// P5 非白名单 Host → 403
const badHost = await call('/mcp', { direct: true, host: 'evil.example', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } })
record('P5 非白名单 Host → 403（不因公网域名而放宽）', badHost.status === 403)

// P6 完整授权流程（经代理）
const REDIRECT = 'http://127.0.0.1:9999/callback'
const reg = await call('/register', { body: { client_name: 'ChatGPT Public Sim', redirect_uris: [REDIRECT] } })
const clientId = reg.json?.client_id
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const q = '/authorize?client_id=' + clientId + '&redirect_uri=' + encodeURIComponent(REDIRECT) + '&response_type=code&code_challenge=' + challenge + '&code_challenge_method=S256&scope=dsh%3Aread&state=p1&resource=' + encodeURIComponent(PUBLIC + '/mcp')
const consent = await get(q)
const csrf = csrfOf(consent.text)
record('P6 同意页经公网地址渲染并下发 CSRF', consent.status === 200 && Boolean(csrf) && consent.text.includes('dsh:read'))
const allow = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'p1', resource: PUBLIC + '/mcp', decision: 'allow', owner_password: OWNER, csrf_token: csrf })
const code = allow.location ? new URL(allow.location).searchParams.get('code') : null
const tok = await form('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: PUBLIC + '/mcp' })
const access = tok.json?.access_token
record('P7 公网地址下 Code+PKCE 换令牌成功（audience=公网资源）', tok.status === 200 && /^dsh_at_/.test(access ?? ''))

// P8 使用令牌调用（经代理）
const ok1 = await rpc('dsh_health', {}, access)
record('P8 经代理调用 dsh_health 成功', ok1.status === 200 && ok1.json?.result?.structuredContent?.ok === true, 'status=' + ok1.status + ' body=' + String(ok1.text).slice(0, 160))
const list = await call('/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers: { authorization: `Bearer ${access}` } })
record('P9 tools/list 仅 dsh_health（白名单）', (list.json?.result?.tools ?? []).length === 1 && list.json?.result?.tools?.[0]?.name === 'dsh_health', 'status=' + list.status + ' body=' + String(list.text).slice(0, 120))

// 预留一组令牌用于「重启后仍有效」验证（放在限流用例之前）
const keepTok = await (async () => {
  const c = await get(q)
  const a = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'keep', resource: PUBLIC + '/mcp', decision: 'allow', owner_password: OWNER, csrf_token: csrfOf(c.text) })
  const cd = new URL(a.location).searchParams.get('code')
  return form('/token', { grant_type: 'authorization_code', code: cd, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: PUBLIC + '/mcp' })
})()
const keep = keepTok.json?.access_token

// P10 SDK 未注册工具被拒
const den = await rpc('dsh_task_submit', { prompt: 'x' }, access)
record('P10 控制/写入工具仍不可达（已认证后被白名单拒）', den.status === 200 && den.json?.error?.code === -32003, 'status=' + den.status)

// P11 通配符 redirect 被拒
const wild = await get('/authorize?client_id=' + clientId + '&redirect_uri=' + encodeURIComponent('https://*.attacker.test/cb') + '&response_type=code&code_challenge=' + challenge + '&code_challenge_method=S256&scope=dsh%3Aread')
record('P11 通配符 redirect_uri → 拒绝', wild.status === 400)
// P12 缺 CSRF → 400
const noCsrf = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'p', resource: PUBLIC + '/mcp', decision: 'allow', owner_password: OWNER })
record('P12 缺少 CSRF → 400', noCsrf.status === 400 && /csrf/i.test(noCsrf.text))
// P13 CSRF 篡改 → 400
const c2 = await get(q)
const tampered = (csrfOf(c2.text) ?? '').slice(0, -4) + 'AAAA'
const badCsrf = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'p', resource: PUBLIC + '/mcp', decision: 'allow', owner_password: OWNER, csrf_token: tampered })
record('P13 CSRF 签名篡改 → 400', badCsrf.status === 400)

// P14 口令失败限流：连续错误口令 → 最终 429
let last = null
for (let i = 0; i < 11; i++) {
  const c = await get(q)
  last = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 'p', resource: PUBLIC + '/mcp', decision: 'allow', owner_password: 'wrong-' + i, csrf_token: csrfOf(c.text) })
}
record('P14 Owner 口令失败计数触发限流（429）', last.status === 429, `status=${last.status}`)

// P15 /token 突发限流
let burst = []
for (let i = 0; i < 35; i++) burst.push(await form('/token', { grant_type: 'refresh_token', refresh_token: 'nope', client_id: clientId }))
const rateLimited = burst.filter((r) => r.status === 429).length
record('P15 /token 突发 → 429（带 Retry-After）', rateLimited > 0 && Boolean(burst.find((r) => r.status === 429)?.headers['retry-after']), `429_count=${rateLimited}`)

// P16 撤销后 401
await form('/revoke', { token: access })
record('P16 撤销后经代理调用 → 401', (await rpc('dsh_health', {}, access)).status === 401)

// P17 日志脱敏
const logs = readdirSync(join(RUN, 'logs')).map((f) => readFileSync(join(RUN, 'logs', f), 'utf8')).join('\n')
record('P17 日志无令牌/口令/X-Forwarded 注入痕迹', !/dsh_at_[A-Za-z0-9_-]{10,}/.test(logs) && !/dsh_rt_[A-Za-z0-9_-]{10,}/.test(logs) && !logs.includes(OWNER) && !logs.includes('evil.attacker.test'))

// P18 重启后公网 issuer 不变、未过期令牌仍有效
svc.child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 600))
svc = start(); await svc.ready
const meta2 = await get('/.well-known/oauth-authorization-server')
const afterRestart = await rpc('dsh_health', {}, keep)
record('P18 重启后 issuer 仍为公网地址且旧令牌有效', meta2.json.issuer === PUBLIC && afterRestart.status === 200, `status=${afterRestart.status}`)
const passed = results.filter((r) => r.ok).length
writeFileSync(join(ROOT, 'logs', 'public-sim-summary.json'), JSON.stringify({ at: new Date().toISOString(), publicUrl: PUBLIC, passed, total: results.length, results }, null, 2))
console.log(`\nSUMMARY[public-sim] PASS=${passed} FAIL=${results.length - passed} total=${results.length}`)
svc.child.kill('SIGTERM'); edge.close(); mock.close()
process.exit(passed === results.length ? 0 : 1)
