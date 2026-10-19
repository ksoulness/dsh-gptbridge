// 回归用例：覆盖 P3-4F / P3-4G 两个真实盲区 + 多工具白名单与回包裁剪
//  R1 https 形式 redirect_uri 必须被接受（旧 bug：正则 /[*\\s]/ 误把字母 s 当禁用字符）
//  R2 N=2^17 的 scrypt 口令必须能通过校验（旧 bug：verifyOwnerPassword 未传 maxmem → 恒 false）
//  R3 白名单外工具必须被拒（-32003），白名单内工具可调用
//  R4 dsh_health 回包中的 exposed_tools 必须裁剪为“实际放行”集合
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, scryptSync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
const RUN = join(ROOT, 'state', 'regress-' + Date.now())
const SEC = join(RUN, 'secrets'), LOGS = join(RUN, 'logs'), EP = join(LOGS, 'endpoint.json')
mkdirSync(SEC, { recursive: true }); mkdirSync(LOGS, { recursive: true })

const results = []
const record = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`) }

// ---- N=2^17 凭据（与 init-auth 一致，含 maxmem）
const OWNER_PW = 'dsh-' + randomBytes(9).toString('hex')
const salt = randomBytes(16), N = 131072, r = 8, p = 1
writeFileSync(join(SEC, 'owner.json'), JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(OWNER_PW, salt, 64, { N, r, p, maxmem: 512 * 1024 * 1024 }).toString('hex'), n: N, r, p }, null, 2))
writeFileSync(join(SEC, 'pepper.txt'), randomBytes(48).toString('hex'))

// ---- 假上游：6 个工具（4 放行 / 2 未放行）
const TOOLS = ['dsh_health', 'dsh_git_status', 'dsh_git_log', 'dsh_git_branch', 'dsh_task_status', 'dsh_task_submit']
writeFileSync(join(RUN, 'mock.mjs'), `import { createServer } from 'node:http'
const tools = ${JSON.stringify(TOOLS)}.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } }))
createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c))
  req.on('end', () => {
    const msg = JSON.parse(b || '{}'), id = msg.id ?? 0
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })) }
    if (msg.method === 'tools/list') return ok({ tools })
    if (msg.method === 'tools/call') {
      const n = msg.params?.name
      if (n === 'dsh_health') return ok({ content: [{ type: 'text', text: JSON.stringify({ ok: true, tool_mode: 'read-only', exposed_tools: tools.map((t) => t.name), budget: { real_prompt: { used: 0, limit_: 0 } } }) }] })
      return ok({ content: [{ type: 'text', text: JSON.stringify({ tool: n, value: 42 }) }] })
    }
    ok({})
  })
}).listen(0, '127.0.0.1', function () { console.log('MOCK_READY ' + this.address().port) })
`)

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => res(pt)) }) })
const waitFor = (file, ms = 25000) => new Promise((res, rej) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    try { const t = readFileSync(file, 'utf8'); if (t.trim()) { clearInterval(iv); res(JSON.parse(t)) } } catch {}
    if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout ' + file)) }
  }, 150)
})

let mock, svc
try {
  mock = spawn(process.execPath, [join(RUN, 'mock.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const up = await new Promise((res) => mock.stdout.on('data', (d) => { const m = /MOCK_READY (\d+)/.exec(String(d)); if (m) res('http://127.0.0.1:' + m[1] + '/mcp') }))

  const EXPOSED = ['dsh_health', 'dsh_git_status', 'dsh_git_log', 'dsh_git_branch']
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'))
  writeFileSync(join(RUN, 'config.json'), JSON.stringify({ ...cfg, publicUrl: '', allowedHosts: [], upstreamUrl: up, exposedTools: EXPOSED }, null, 2))

  const port = await freePort()
  svc = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(port), '--upstream', up,
    '--config', join(RUN, 'config.json'), '--secrets-dir', SEC, '--state-dir', RUN, '--logs-dir', LOGS,
    '--endpoint-file', EP], { stdio: ['ignore', 'pipe', 'inherit'] })
  const ep = await waitFor(EP)
  const BASE = `http://127.0.0.1:${port}`
  const J = (path, opts = {}) => fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.headers ?? {}) } })

  // R1: DCR 使用 https redirect_uri + authorize 必须 200
  const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
  const reg = await (await J('/register', { method: 'POST', body: JSON.stringify({ client_name: 'RegressChatGPT', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json()
  const verifier = 'verifier-' + randomBytes(8).toString('hex')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authPath = `/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=dsh%3Aread&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(ep.url)}&state=regress1`
  const authRes = await fetch(BASE + authPath)
  const authHtml = await authRes.text()
  record('R1 https redirect_uri 被接受（旧 bug：[*\\\\s] 误伤字母 s）', authRes.status === 200 && authHtml.includes('csrf_token'), 'status=' + authRes.status)

  const fields = {}
  for (const m of authHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2]

  // R2: 正确口令 → 302 + code；错误口令 → 401
  const allow = await fetch(BASE + '/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, owner_password: OWNER_PW, decision: 'allow' }), redirect: 'manual' })
  const loc = allow.headers.get('location') ?? ''
  record('R2 N=2^17 口令校验通过并发放 code（旧 bug：未传 maxmem → 恒 false）', allow.status === 302 && /[?&]code=/.test(loc), 'status=' + allow.status)
  const wrong = await fetch(BASE + '/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, owner_password: 'wrong-password', decision: 'allow' }), redirect: 'manual' })
  record('R2b 错误口令被拒绝', wrong.status === 401, 'status=' + wrong.status)

  // R3/R4: 换 token → tools/list 与 tools/call
  const code = decodeURIComponent(/[?&]code=([^&]+)/.exec(loc)?.[1] ?? '')
  const tok = await (await J('/token', { method: 'POST', body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: ep.url }) })).json()
  record('R3a PKCE 换令牌成功', typeof tok.access_token === 'string' && tok.access_token.length > 10)
  const AUTH = { authorization: 'Bearer ' + tok.access_token }
  const list = await (await J('/mcp', { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()
  const names = (list?.result?.tools ?? []).map((t) => t.name).sort()
  record('R3b tools/list 仅含白名单 4 项', JSON.stringify(names) === JSON.stringify([...EXPOSED].sort()), names.join(','))

  const denied = await (await J('/mcp', { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_task_status', arguments: {} } }) })).json()
  record('R3c 未放行只读工具被拒（-32003）', denied?.error?.code === -32003, 'code=' + (denied?.error?.code ?? 'n/a'))

  const submit = await (await J('/mcp', { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_task_submit', arguments: {} } }) })).json()
  record('R3d 写入类工具被拒（-32003）', submit?.error?.code === -32003, 'code=' + (submit?.error?.code ?? 'n/a'))

  const gitOk = await (await J('/mcp', { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_git_status', arguments: {} } }) })).json()
  record('R3e 白名单内工具可调用', !!gitOk?.result && !gitOk?.error, gitOk?.error ? JSON.stringify(gitOk.error).slice(0, 80) : 'ok')

  const health = await (await J('/mcp', { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dsh_health', arguments: {} } }) })).json()
  const payload = JSON.parse(health?.result?.content?.[0]?.text ?? '{}')
  const trimmed = Array.isArray(payload.exposed_tools) ? payload.exposed_tools : []
  record('R4 dsh_health.exposed_tools 已裁剪为放行集合', JSON.stringify(trimmed.sort()) === JSON.stringify([...EXPOSED].sort()), trimmed.join(','))
} catch (e) {
  record('EXCEPTION', false, String(e?.message ?? e).slice(0, 160))
} finally {
  try { svc?.kill('SIGKILL') } catch {}
  try { mock?.kill('SIGKILL') } catch {}
  const pass = results.filter((x) => x.ok).length
  console.log(`\nSUMMARY[regress] PASS=${pass} FAIL=${results.length - pass} total=${results.length}`)
  try { rmSync(RUN, { recursive: true, force: true }) } catch {}
}
