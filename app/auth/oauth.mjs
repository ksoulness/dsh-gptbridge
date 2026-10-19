/**
 * OAuth 2.1 授权服务器（Authorization Server）
 * - Authorization Code + PKCE(S256) + Refresh Token 轮换 + Revocation + DCR
 * - 元数据：/.well-known/oauth-authorization-server 与 /.well-known/oauth-protected-resource
 * - 与资源服务器职责分离：本模块只签发/校验令牌数据，MCP 侧由 auth/guard.mjs 消费
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { verifyOwnerPassword } from './store.mjs'

const b64u = (buf) => buf.toString('base64url')
const pkce = (verifier) => b64u(createHash('sha256').update(verifier).digest())
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createOAuth({ store, config }) {
  const { issuer, resource, scopes, owner } = config
  const addCommon = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  const oauthError = (res, status, code, desc) => addCommon(res, { error: code, error_description: desc }, status)

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scopes,
    authorization_response_iss_parameter_supported: true,
  })
  const prm = () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ['header'],
    resource_documentation: `${issuer}/docs`,
  })

  const validRedirect = (client, uri) => {
    if (typeof uri !== 'string' || /[*\s]/.test(uri)) return false     // 禁止通配符/空白
    if (!/^https:\/\//i.test(uri) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(uri)) return false
    return Array.isArray(client.redirect_uris) && client.redirect_uris.some((u) => safeEq(u, uri))  // 精确匹配
  }
  const scopeAllows = (requested) => requested.every((s) => scopes.includes(s))

  function consentPage({ client, scope, resource: res, params, error }) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n')
    const csrfInput = params.csrf_token ? '' : ''
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权 DSH 只读 MCP</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:1.6">
<h2>授权请求</h2>
<p>应用：<b>${esc(client.client_name || client.client_id)}</b><br>
授权对象（资源）：<code>${esc(res)}</code><br>
请求范围：<code>${esc(scope.join(' '))}</code>（只读查询）<br>
权限说明：仅可读取 DSH 健康状态与（后续审批后）任务/Git 只读信息；<b>不能</b>提交任务、取消任务、修改会话或写入 Git。</p>
${error ? `<p style="color:#b00">${esc(error)}</p>` : ''}
<form method="post" action="${esc(issuer)}/authorize">
${hidden}
<p><label>请输入本机 Owner 口令以确认授权：<br><input type="password" name="owner_password" autocomplete="off" required></label></p>
<p><button type="submit" name="decision" value="allow">允许</button>
<button type="submit" name="decision" value="deny">拒绝</button></p>
</form></body></html>`
  }

  async function handle(req, res, url) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') { addCommon(res, metadata()); return true }
    if (req.method === 'GET' && p === '/.well-known/oauth-protected-resource') { addCommon(res, prm()); return true }
    if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server/mcp') { addCommon(res, metadata()); return true }
    if (req.method === 'GET' && p === '/.well-known/oauth-protected-resource/mcp') { addCommon(res, prm()); return true }

    if (req.method === 'POST' && p === '/register') {
      const body = req.body ?? {}
      const rawUris = body.redirect_uris
      const uris = Array.isArray(rawUris) ? rawUris : (typeof rawUris === 'string' && rawUris ? rawUris.split(/[\s,]+/).filter(Boolean) : [])
      if (!uris.length || uris.some((u) => !/^https:\/\//i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u))) {
        return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https or loopback http'), true
      }
      const clientId = 'dsh_client_' + randomBytes(16).toString('hex')
      const client = { client_id: clientId, client_name: String(body.client_name ?? 'ChatGPT'), redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', created_at: Date.now() }
      store.saveClient(client)
      store.audit('client_registered', { clientId, detail: { name: client.client_name } })
      addCommon(res, client, 201)
      return true
    }

    if (p === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const src = req.method === 'POST' ? (req.body ?? {}) : Object.fromEntries(url.searchParams)
      const clientId = String(src.client_id ?? '')
      const redirectUri = String(src.redirect_uri ?? '')
      const scope = String(src.scope ?? 'dsh:read').split(/\s+/).filter(Boolean)
      const client = store.getClient(clientId)
      if (!client) { return oauthError(res, 400, 'invalid_client', 'unknown client_id'), true }
      if (!validRedirect(client, redirectUri)) { store.audit('authorize_bad_redirect', { clientId, detail: { redirectUri } }); return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uri not registered'), true }
      if (String(src.response_type ?? '') !== 'code') { return oauthError(res, 400, 'unsupported_response_type', 'only code'), true }
      if (!String(src.code_challenge ?? '') || String(src.code_challenge_method ?? '') !== 'S256') {
        store.audit('authorize_pkce_missing', { clientId }); return oauthError(res, 400, 'invalid_request', 'PKCE S256 required'), true
      }
      if (!scopeAllows(scope)) { store.audit('authorize_bad_scope', { clientId, detail: { scope } }); return oauthError(res, 403, 'invalid_scope', 'scope not allowed'), true }
      const resourceParam = String(src.resource ?? resource)
      if (resourceParam !== resource) { store.audit('authorize_bad_resource', { clientId, detail: { resourceParam } }); return oauthError(res, 400, 'invalid_target', 'resource mismatch'), true }

      if (req.method === 'GET') {
        const csrfToken = config.csrf.issue({ clientId, challenge: String(src.code_challenge) })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(consentPage({ client, scope, resource: resourceParam, params: { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: String(src.code_challenge), code_challenge_method: 'S256', scope: scope.join(' '), state: String(src.state ?? ''), resource: resourceParam, csrf_token: csrfToken } }))
        return true
      }
      if (String(src.decision ?? '') !== 'allow') {
        store.audit('authorize_denied', { clientId })
        const u = new URL(redirectUri); u.searchParams.set('error', 'access_denied'); if (src.state) u.searchParams.set('state', String(src.state))
        res.writeHead(302, { location: u.toString() }); res.end(); return true
      }
      const csrfCheck = config.csrf.verify(String(src.csrf_token ?? ''), { clientId, challenge: String(src.code_challenge) })
      if (!csrfCheck.ok) {
        store.audit('authorize_csrf_rejected', { clientId, detail: { reason: csrfCheck.reason } })
        const failState = config.limiters?.fail ? config.limiters.fail('owner_login_fail', req.socket?.remoteAddress ?? 'unknown', 10, 60_000) : { blocked: false }
        return oauthError(res, 400, 'invalid_request', `csrf verification failed (${csrfCheck.reason})`), true
      }
      if (!verifyOwnerPassword(String(src.owner_password ?? '').trim(), owner)) {
        const f = config.limiters?.fail ? config.limiters.fail('owner_login_fail', req.socket?.remoteAddress ?? 'unknown', 10, 60_000) : { blocked: false, failures: 1 }
        store.audit('authorize_bad_owner_password', { clientId, detail: { failures: f.failures, blocked: f.blocked } })
        if (f.blocked) return oauthError(res, 429, 'too_many_attempts', 'owner login temporarily locked'), true
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(consentPage({ client, scope, resource: resourceParam, params: { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: String(src.code_challenge), code_challenge_method: 'S256', scope: scope.join(' '), state: String(src.state ?? ''), resource: resourceParam }, error: 'Owner 口令不正确' }))
        return true
      }
      const code = 'dsh_code_' + randomBytes(24).toString('base64url')
      store.createCode({ code, clientId, redirectUri, scope: scope.join(' '), resource: resourceParam, challenge: String(src.code_challenge), method: 'S256', ttlMs: 5 * 60_000 })
      store.audit('authorize_allowed', { clientId, detail: { scope } })
      const u = new URL(redirectUri); u.searchParams.set('code', code); if (src.state) u.searchParams.set('state', String(src.state)); u.searchParams.set('iss', issuer)
      res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end()
      return true
    }

    if (req.method === 'POST' && p === '/token') {
      const b = req.body ?? {}
      const grant = String(b.grant_type ?? '')
      if (grant === 'authorization_code') {
        const code = String(b.code ?? '')
        const clientId = String(b.client_id ?? '')
        const verifier = String(b.code_verifier ?? '')
        const taken = store.consumeCode(code)
        if (!taken.ok) { store.audit('token_code_rejected', { clientId, detail: { reason: taken.reason } }); return oauthError(res, 400, 'invalid_grant', taken.reason), true }
        const row = taken.row
        if (row.client_id !== clientId) { store.audit('token_code_client_mismatch', { clientId }); return oauthError(res, 400, 'invalid_grant', 'client mismatch'), true }
        if (safeEq(String(b.redirect_uri ?? ''), row.redirect_uri) === false) { store.audit('token_redirect_mismatch', { clientId }); return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch'), true }
        if (String(b.resource ?? row.resource) !== row.resource) { store.audit('token_resource_mismatch', { clientId }); return oauthError(res, 400, 'invalid_target', 'resource mismatch'), true }
        if (!verifier || !safeEq(pkce(verifier), row.challenge)) { store.audit('token_pkce_failed', { clientId }); return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed'), true }
        const t = store.issueTokens({ clientId, scope: row.scope, audience: row.resource, issuer, accessTtlMs: config.accessTtlMs, refreshTtlMs: config.refreshTtlMs })
        store.audit('token_issued', { clientId, detail: { grant: 'authorization_code' } })
        return addCommon(res, { access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh, scope: row.scope }), true
      }
      if (grant === 'refresh_token') {
        const rt = String(b.refresh_token ?? '')
        const row = store.getRefresh(rt)
        if (!row || row.revoked_at) { store.audit('token_refresh_rejected', { detail: { reason: 'unknown_or_revoked' } }); return oauthError(res, 400, 'invalid_grant', 'refresh token invalid'), true }
        if (row.rotated_at) {
          store.revokeFamily(row.family)
          store.audit('token_refresh_reuse_detected', { clientId: row.client_id, detail: { family: row.family } })
          return oauthError(res, 400, 'invalid_grant', 'refresh token reused; family revoked'), true
        }
        if (row.expires_at < Date.now()) { store.audit('token_refresh_expired', { clientId: row.client_id }); return oauthError(res, 400, 'invalid_grant', 'refresh token expired'), true }
        store.rotateRefresh(rt)
        store.revokeAccessHash(row.access_hash)   // 轮换时使旧 access token 立即失效
        const t = store.issueTokens({ clientId: row.client_id, scope: row.scope, audience: row.audience, issuer, family: row.family, accessTtlMs: config.accessTtlMs, refreshTtlMs: config.refreshTtlMs })
        store.audit('token_refreshed', { clientId: row.client_id })
        return addCommon(res, { access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh, scope: row.scope }), true
      }
      return oauthError(res, 400, 'unsupported_grant_type', 'only authorization_code / refresh_token'), true
    }

    if (req.method === 'POST' && p === '/revoke') {
      const token = String(req.body?.token ?? '')
      const isRefresh = String(req.body?.token_type_hint ?? '') === 'refresh_token'
      const done = isRefresh ? store.revokeRefresh(token) : (store.revokeAccess(token) || store.revokeRefresh(token))
      store.audit('token_revoked', { detail: { isRefresh, done } })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{}')
      return true
    }
    return false
  }

  return { handle, metadata, prm }
}
