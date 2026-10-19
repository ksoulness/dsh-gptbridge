/**
 * MCP 资源服务器鉴权守卫
 * 逐请求验证：Bearer 存在 → 摘要可查 → issuer → audience → 未撤销 → 未过期 → scope → 工具白名单
 * 返回 { ok, status, code, scopes } —— 任何不确定都拒绝（fail closed）
 */
export function createGuard({ store, config }) {
  const realm = 'dsh-mcp'

  function parseBearer(req) {
    const h = String(req.headers.authorization ?? '')
    const m = /^Bearer\s+(\S+)$/i.exec(h)
    return m ? m[1] : null
  }

  function authenticate(req) {
    const token = parseBearer(req)
    if (!token) return { ok: false, status: 401, code: 'invalid_token', reason: 'missing_bearer', www: `Bearer realm="${realm}", resource="${config.resource}"` }
    const row = store.getAccess(token)
    if (!row) return { ok: false, status: 401, code: 'invalid_token', reason: 'unknown_token', www: `Bearer realm="${realm}", error="invalid_token"` }
    if (row.revoked_at) return { ok: false, status: 401, code: 'invalid_token', reason: 'revoked', www: `Bearer realm="${realm}", error="invalid_token"` }
    if (row.expires_at <= Date.now()) return { ok: false, status: 401, code: 'invalid_token', reason: 'expired', www: `Bearer realm="${realm}", error="invalid_token"` }
    if (row.issuer !== config.issuer) return { ok: false, status: 401, code: 'invalid_token', reason: 'issuer_mismatch', www: `Bearer realm="${realm}", error="invalid_token"` }
    if (row.audience !== config.resource) return { ok: false, status: 401, code: 'invalid_token', reason: 'audience_mismatch', www: `Bearer realm="${realm}", error="invalid_token"` }
    const scopes = String(row.scope || '').split(/\s+/).filter(Boolean)
    if (!scopes.includes(config.scope)) return { ok: false, status: 403, code: 'insufficient_scope', reason: 'scope_missing', www: `Bearer realm="${realm}", error="insufficient_scope", scope="${config.scope}"` }
    return { ok: true, status: 200, scopes, clientId: row.client_id, family: row.family }
  }

  /** 工具级授权：scope 必须允许，且工具在配置白名单内（不依赖 readOnlyHint/名称相似） */
  function authorizeTool(auth, toolName) {
    if (!auth?.ok) return { ok: false, status: auth?.status ?? 401, code: auth?.code ?? 'invalid_token', reason: auth?.reason ?? 'unauthenticated' }
    if (!config.exposedTools.includes(toolName)) {
      return { ok: false, status: 404, code: 'tool_not_exposed', reason: 'not_in_allowlist' }
    }
    const need = config.toolScope[toolName] ?? config.scope
    if (!auth.scopes.includes(need)) return { ok: false, status: 403, code: 'insufficient_scope', reason: `scope_${need}_required` }
    return { ok: true }
  }

  return { authenticate, authorizeTool }
}
