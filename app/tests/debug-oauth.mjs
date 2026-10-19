// 一次性调试：跑 OAuth 流程并打印 /token 原始响应
import { createServer } from 'node:http'
import httpMod from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUN = join(ROOT, 'state', 'debug-' + Date.now().toString(36))
mkdirSync(RUN, { recursive: true })
const mock = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => {
    let m = {}; try { m = JSON.parse(b) } catch { }
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'dsh_health', description: 'h', inputSchema: { type: 'object', properties: {} } }] } })
    if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true }, isError: false } })
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } })
  })
})
await new Promise((ok) => mock.listen(0, '127.0.0.1', ok))
const mockUrl = `http://127.0.0.1:${mock.address().port}/mcp`
const secDir = join(RUN, 'secrets'); mkdirSync(secDir, { recursive: true })
const OWNER = 'test-owner-password-123'
const salt = randomBytes(16)
writeFileSync(join(secDir, 'owner.json'), JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(OWNER, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex'), n: 16384, r: 8, p: 1 }))
writeFileSync(join(secDir, 'pepper.txt'), randomBytes(48).toString('hex'))
const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'))
writeFileSync(join(RUN, 'config.json'), JSON.stringify({ ...cfg, upstreamUrl: mockUrl, exposedTools: ['dsh_health'] }))
const epFile = join(RUN, 'endpoint.json')
const child = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', '0', '--config', join(RUN, 'config.json'), '--secrets-dir', secDir, '--state-dir', join(RUN, 'state'), '--logs-dir', join(RUN, 'logs'), '--endpoint-file', epFile], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((ok) => child.stdout.on('data', (d) => { if (/REMOTE_MCP_LISTEN/.test(d.toString())) ok() }))
const ep = JSON.parse(readFileSync(epFile, 'utf8'))
const I = ep.issuer

const form = (p, obj) => new Promise((ok) => {
  const u = new URL(p, I); const payload = new URLSearchParams(obj).toString()
  const r = httpMod.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'POST', headers: { host: `127.0.0.1:${u.port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) } }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode, text: t, location: res.headers.location })) })
  r.end(payload)
})
const get = (p) => new Promise((ok) => { const u = new URL(p, I); const r = httpMod.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers: { host: `127.0.0.1:${u.port}` } }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => ok({ status: res.statusCode, text: t })) }); r.end() })

const REDIRECT = 'http://127.0.0.1:9999/callback'
const reg = await form('/register', { client_name: 'dbg', redirect_uris: REDIRECT })
console.log('register:', reg.status, reg.text.slice(0, 200))
const clientId = JSON.parse(reg.text).client_id
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const q = `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=dsh%3Aread&state=s1&resource=${encodeURIComponent(ep.url)}`
console.log('consent:', (await get(q)).status)
const allow = await form('/authorize', { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'dsh:read', state: 's1', resource: ep.url, decision: 'allow', owner_password: OWNER })
console.log('authorize:', allow.status, allow.location)
const code = allow.location ? new URL(allow.location).searchParams.get('code') : null
const tok = await form('/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: ep.url })
console.log('token:', tok.status, tok.text.slice(0, 300))
child.kill('SIGTERM'); mock.close(); process.exit(0)
