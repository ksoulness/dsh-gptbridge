/**
 * 本地补充工具：archive_terminal_session
 * 直接调用 DSH 官方 HTTP API（与 dsh-codex-kit 的 session-archive.mjs 同样的鉴权方式）：
 *   POST {hostWebUrl}/api/workspace/archiveSession
 *   鉴权 cookie 由 HOME/.credentials.yaml 里的 client-connection/browser-session 授据 HMAC 生成
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const SESSION_ID = /^session-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function resolveWebHome() {
  return process.env.DSH_WEB_HOME ?? 'D:\\Program Files\\DSH'
}

function findDescriptor(home) {
  const base = join(home, 'plugins', 'dsh-relay')
  if (!existsSync(base)) return null
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === 'relay-endpoint.json') { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
    }
  }
  return null
}

function mintCookie(home, host) {
  const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  // 最小解析：找到 browser-session 授据的 payload.secret
  const idx = doc.indexOf('client-connection/browser-session')
  if (idx < 0) throw new Error('missing browser-session grant')
  const tail = doc.slice(idx)
  const m = tail.match(/secret:\s*"?([A-Za-z0-9_-]{43}=?)"?/)
  if (!m) throw new Error('missing browser-session secret')
  const secret = Buffer.from(m[1], 'base64url')
  if (secret.byteLength !== 32) throw new Error('invalid grant length')
  const authority = new URL(host).host
  const issuedAt = Date.now()
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 60000 })).toString('base64url')
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}

export function createDelegation({ config = {}, audit = () => {} } = {}) {
  const home = config.webHome ?? resolveWebHome()

  async function archiveSession(sessionId, action = 'archive') {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      return { archived: false, state: 'invalid_session_id', hint: 'need full session-<uuid>' }
    }
    const descriptor = findDescriptor(home)
    if (!descriptor?.hostWebUrl) return { archived: false, state: 'relay_descriptor_missing' }
    const host = String(descriptor.hostWebUrl).replace(/\/$/, '')
    let cookie
    try { cookie = mintCookie(home, host) } catch (e) { return { archived: false, state: 'grant_unavailable', reason: String(e.message).slice(0, 80) } }
    const method = action === 'archive' ? 'workspace/archiveSession' : 'workspace/unarchiveSession'
    const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request: { sessionId } } } })
    const send = (ck) => fetch(`${host}/api/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', cookie: ck },
      body,
    })
    let res
    try {
      res = await send(cookie)
      // DSH 可能轮换 browser-session 授据：401 时重读凭据、重签一次 cookie 再试
      if (res.status === 401) {
        const fresh = mintCookie(home, host)
        res = await send(fresh)
      }
    } catch { return { archived: false, state: 'archive_pending', errorCode: 'REQUEST_FAILED' } }
    if (res.status !== 200) return { archived: false, state: 'archive_pending', errorCode: `HTTP_${res.status}` }
    let msg
    try { msg = await res.json() } catch { return { archived: false, state: 'archive_pending', errorCode: 'BAD_RESPONSE' } }
    const result = msg?.result
    if (result?.ok !== true) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : 'HOST_REJECTED'
      return { archived: false, state: 'archive_pending', errorCode: code }
    }
    return action === 'archive' ? { archived: true, session_id: sessionId } : { restored: true, session_id: sessionId }
  }


  async function callApi(method, request, action = 'archive') {
    const descriptor = findDescriptor(home)
    if (!descriptor?.hostWebUrl) return { ok: false, state: 'relay_descriptor_missing' }
    const host = String(descriptor.hostWebUrl).replace(/\/$/, '')
    let cookie
    try { cookie = mintCookie(home, host) } catch (e) { return { ok: false, state: 'grant_unavailable', reason: String(e.message).slice(0, 80) } }
    const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } })
    const send = (ck) => fetch(`${host}/api/${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', cookie: ck }, body,
    })
    let res
    try { res = await send(cookie); if (res.status === 401) res = await send(mintCookie(home, host)) }
    catch { return { ok: false, state: 'request_failed' } }
    if (res.status !== 200) return { ok: false, state: `http_${res.status}` }
    try { return { ok: true, body: await res.json() } } catch { return { ok: false, state: 'bad_response' } }
  }

  /** 找到某个会话的 jsonl 文件（不依赖 slug 编码规则，直接扫一层工作区目录） */
  function findSessionFile(sessionId) {
    const root = join(home, 'sessions')
    if (!existsSync(root)) return null
    let slugs = []
    try { slugs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return null }
    for (const slug of slugs) {
      const p = join(root, slug, String(sessionId), 'session.v4.jsonl')
      if (existsSync(p)) return p
    }
    return null
  }

  /** 读取会话当前标题（最后一条 session/title 事件） */
  function currentTitle(sessionId) {
    const p = findSessionFile(sessionId)
    if (!p) return null
    let title = null
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.includes('"session/title"')) continue
        try { const o = JSON.parse(line); if (o?.data?.title) title = String(o.data.title) } catch {}
      }
    } catch { return null }
    return title
  }

  /** 给会话标题加前缀（幂等）：调用官方 session/rename */
  async function renameSession(sessionId, title) {
    const out = await callApi('session/rename', { sessionId, title })
    if (!out.ok) return { renamed: false, state: out.state }
    return { renamed: true, title }
  }

  async function prefixTitle(sessionId, prefix = 'gpt指派-') {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { renamed: false, state: 'invalid_session_id' }
    const cur = currentTitle(sessionId)
    if (!cur) return { renamed: false, state: 'title_unavailable' }
    // 先剥掉已有的同类前缀（gpt指派- / gpt指派｜ / codex指派- 等），避免叠加成 gpt指派-codex指派-gpt指派｜…
    const stripped = cur.replace(/^(?:gpt指派[-｜]\s*|codex指派[-｜]\s*)+/u, '').trim()
    const base = stripped || cur
    const target = prefix + base
    if (cur === target) return { renamed: false, state: 'already_prefixed', title: cur }
    const normalized = target !== prefix + cur
    const out = await renameSession(sessionId, target)
    return normalized ? { ...out, normalized_from: cur } : out
  }

  const localTools = [
    {
      name: 'archive_terminal_session',
      description: '归档已到终态的 DSH 会话（调用 DSH 官方 workspace/archiveSession；需要完整 session-<uuid>）。',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['session_id'],
      },
      async handler(args) {
        const out = await archiveSession(args?.session_id, 'archive')
        audit('session_archived', { detail: { session_id: args?.session_id, outcome: out } })
        return out
      },
    },
  ]

  async function call(name, args) {
    const t = localTools.find((x) => x.name === name)
    if (!t) throw new Error(`unknown local tool: ${name}`)
    return t.handler(args ?? {})
  }

  return { localTools, call, names: localTools.map((t) => t.name), archiveSession, renameSession, prefixTitle, currentTitle, findSessionFile, home }
}