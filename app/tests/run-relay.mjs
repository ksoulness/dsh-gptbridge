// Relay 闭环验证：OAuth → tools/list → list_capabilities → start_review → wait_run → archive_terminal_session
// 目标：证明会话由 DSH 原生创建（session-<uuid>，自动归工作区）并可归档
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:18080'
const HOST = 'mcp.example.com'
const SEC = process.env.DSH_GPTBRIDGE_SECRETS ?? new URL('../config/secrets', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PW = readFileSync(`${SEC}\\OWNER-PASSWORD.txt`, 'utf8').trim()
const WS_PATH = process.env.WS ?? 'E:\\example-workspace'
const TASK = process.env.TASK ?? '只读核对：本工作区 PROJECT.md 的字节数是多少？只回答一行数字，不要修改任何文件。'
const DO_RUN = process.env.DO_RUN === '1'

const results = []
const rec = (n, ok, info = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`) }

const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: HOST }
async function jpost(path, body, extra = {}) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { ...hdr, ...extra }, body: JSON.stringify(body) })
  const t = await r.text()
  let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, j, t }
}
async function jget(path) {
  const r = await fetch(BASE + path, { headers: { host: HOST } })
  return { status: r.status, text: await r.text() }
}

// 1) OAuth
const reg = await jpost('/register', { client_name: 'verify-relay', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
const clientId = reg.j?.client_id
rec('DCR 注册', !!clientId, clientId)

const verifier = 'v-' + randomBytes(8).toString('hex')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const resource = 'https://mcp.example.com/mcp'
const authPath = `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=dsh%3Aread&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}&state=v1`
const page = await jget(authPath)
const fields = {}
for (const m of page.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2]
rec('授权页 + CSRF', page.status === 200 && !!fields.csrf_token, `status=${page.status}`)
const allow = await fetch(BASE + '/authorize', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', host: HOST },
  body: new URLSearchParams({ ...fields, owner_password: PW, decision: 'allow' }), redirect: 'manual',
})
const code = /[?&]code=([^&]+)/.exec(allow.headers.get('location') ?? '')?.[1]
rec('口令授权 → code', allow.status === 302 && !!code, `status=${allow.status}`)
const tok = await jpost('/token', { grant_type: 'authorization_code', code: decodeURIComponent(code ?? ''), client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource })
const A = { authorization: 'Bearer ' + tok.j?.access_token }
rec('PKCE 换令牌', !!tok.j?.access_token)

const call = async (name, args = {}) => {
  const r = await jpost('/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, A)
  if (r.j?.error) return { err: r.j.error }
  const txt = r.j?.result?.content?.[0]?.text
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

// 2) 工具面
const list = await jpost('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, A)
const names = (list.j?.result?.tools ?? []).map((t) => t.name)
const need = ['list_workspaces', 'list_capabilities', 'start_review', 'wait_run', 'archive_terminal_session']
rec('relay 工具面完整', need.every((n) => names.includes(n)), `共 ${names.length} 个`)

// 3) 工作区/能力
const ws = await call('list_workspaces')
const wsHit = (ws.workspaces ?? []).find((w) => String(w.path).toLowerCase() === WS_PATH.toLowerCase())
rec('list_workspaces 命中目标工作区', !!wsHit, wsHit ? `${wsHit.title} id=${wsHit.workspaceId} 现有会话=${wsHit.sessionCount}` : '未找到')

const caps = await call('list_capabilities')
const def = caps?.models?.default ?? {}
rec('list_capabilities', !!def.provider && !!def.model, `${def.provider} / ${def.model} / ${def.reasoningEffort ?? '-'}`)

if (!DO_RUN) {
  console.log('\n（未执行真实任务；设置 DO_RUN=1 运行闭环）')
} else {
  // 4) start_review
  const started = await call('start_review', {
    workspace: WS_PATH,
    task: TASK,
    provider: def.provider,
    model: def.model,
    reasoningEffort: def.reasoningEffort ?? 'low',
    sessionMode: 'fresh',
    openBrowser: false,
    idempotencyKey: 'verify-relay-' + Date.now(),
    authorizationBasis: 'explicit-user-request',
  })
  const runId = started?.runId
  const sessionId = started?.sessionId
  rec('start_review', !!runId && !!sessionId, `run=${runId} session=${sessionId}`)
  rec('sessionId 为 DSH 原生格式', typeof sessionId === 'string' && /^session-[0-9a-f-]{36}$/i.test(sessionId), sessionId)

  // 5) wait_run 到终态
  let snap = null
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timeout', 'orphaned'])
  for (let i = 0; i < 40; i++) {
    snap = await call('wait_run', { runId, timeoutMs: 20000 })
    const st = String(snap?.status ?? snap?.state ?? ''); if (terminal.has(st)) break
  }
  const st2 = String(snap?.status ?? snap?.state ?? ""); rec("wait_run 到终态", terminal.has(st2), "status=" + st2)
  const text = String(snap?.assistantText ?? snap?.run?.assistantText ?? '')
  rec('assistantText 非空', text.trim().length > 0, text.slice(0, 80).replace(/\s+/g, ' '))

  // 6) 归档（可选：设置 NO_ARCHIVE=1 跳过，让会话留在侧栏可见）
  if (process.env.NO_ARCHIVE === '1') {
    rec('跳过归档（NO_ARCHIVE=1）', true, '会话保留在工作区列表')
  } else {
    const arc = await call('archive_terminal_session', { session_id: sessionId, confirm: true })
    rec('archive_terminal_session', arc?.archived === true, JSON.stringify(arc).slice(0, 120))
  }
}

const fail = results.filter((r) => !r.ok).length
console.log(`\nSUMMARY[relay] PASS=${results.length - fail} FAIL=${fail} total=${results.length}`)
process.exit(fail ? 1 : 0)