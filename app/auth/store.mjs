/**
 * OAuth 2.1 授权服务器存储层（独立 SQLite，不与 another-project 共享）
 * - 令牌只存 SHA-256(pepper || token) 单向摘要，明文不落盘
 * - 支持 client(DCR)、authorization code、access/refresh token、撤销、审计
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function newToken(prefix) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export class OAuthStore {
  constructor(dbPath, pepper) {
    if (!pepper || pepper.length < 32) throw new Error('oauth pepper missing or too short')
    this.pepper = pepper
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY, client_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, resource TEXT NOT NULL, challenge TEXT NOT NULL, method TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER, subject TEXT);
      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, audience TEXT NOT NULL,
        issuer TEXT NOT NULL, family TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY, access_hash TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        audience TEXT NOT NULL, issuer TEXT NOT NULL, family TEXT NOT NULL, issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL,
        client_id TEXT, subject TEXT, detail TEXT);
    `)
    this.q = {
      putClient: this.db.prepare('INSERT INTO clients(client_id, client_json, created_at) VALUES(?,?,?)'),
      getClient: this.db.prepare('SELECT client_json FROM clients WHERE client_id=?'),
      putCode: this.db.prepare(`INSERT INTO codes(code_hash,client_id,redirect_uri,scope,resource,challenge,method,expires_at,subject)
        VALUES(?,?,?,?,?,?,?,?,?)`),
      getCode: this.db.prepare('SELECT * FROM codes WHERE code_hash=?'),
      useCode: this.db.prepare('UPDATE codes SET used_at=? WHERE code_hash=? AND used_at IS NULL'),
      putAccess: this.db.prepare(`INSERT INTO access_tokens(token_hash,client_id,scope,audience,issuer,family,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`),
      getAccess: this.db.prepare('SELECT * FROM access_tokens WHERE token_hash=?'),
      revokeAccess: this.db.prepare('UPDATE access_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL'),
      revokeFamily: this.db.prepare('UPDATE access_tokens SET revoked_at=? WHERE family=? AND revoked_at IS NULL'),
      putRefresh: this.db.prepare(`INSERT INTO refresh_tokens(token_hash,access_hash,client_id,scope,audience,issuer,family,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`),
      getRefresh: this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?'),
      rotateRefresh: this.db.prepare('UPDATE refresh_tokens SET rotated_at=? WHERE token_hash=? AND rotated_at IS NULL'),
      revokeRefreshFamily: this.db.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE family=? AND revoked_at IS NULL'),
      audit: this.db.prepare('INSERT INTO audit(at,event,client_id,subject,detail) VALUES(?,?,?,?,?)'),
    }
  }

  hash(token) {
    return sha256(this.pepper + '|' + token)
  }

  audit(event, { clientId = null, subject = null, detail = null } = {}) {
    // 审计只记录事件与标识，绝不记录令牌或密钥
    this.q.audit.run(Date.now(), event, clientId, subject, detail ? JSON.stringify(detail).slice(0, 500) : null)
  }

  /** 审计保留期：删除早于 N 天的记录（启动时调用） */
  pruneAudit(days) {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) return 0
    const cutoff = Date.now() - d * 86400000
    const r = this.db.prepare('DELETE FROM audit WHERE at < ?').run(cutoff)
    return Number(r.changes ?? 0)
  }

  saveClient(client) {
    this.q.putClient.run(client.client_id, JSON.stringify(client), Date.now())
  }

  getClient(clientId) {
    const row = this.q.getClient.get(clientId)
    return row ? JSON.parse(row.client_json) : null
  }

  createCode({ code, clientId, redirectUri, scope, resource, challenge, method, ttlMs, subject }) {
    this.q.putCode.run(this.hash(code), clientId, redirectUri, scope, resource, challenge, method, Date.now() + ttlMs, subject ?? null)
  }

  /** 单次使用：返回 {ok, row} —— 重放时 used_at 已置位 → ok=false */
  consumeCode(code) {
    const row = this.q.getCode.get(this.hash(code))
    if (!row) return { ok: false, reason: 'unknown_code' }
    if (row.used_at) return { ok: false, reason: 'code_replayed' }
    if (row.expires_at < Date.now()) return { ok: false, reason: 'code_expired' }
    const r = this.q.useCode.run(Date.now(), this.hash(code))
    if (!r.changes) return { ok: false, reason: 'code_replayed' }
    return { ok: true, row }
  }

  issueTokens({ clientId, scope, audience, issuer, family, accessTtlMs, refreshTtlMs }) {
    const access = newToken('dsh_at')
    const refresh = newToken('dsh_rt')
    const now = Date.now()
    const fam = family ?? newToken('fam')
    this.q.putAccess.run(this.hash(access), clientId, scope, audience, issuer, fam, now, now + accessTtlMs)
    this.q.putRefresh.run(this.hash(refresh), this.hash(access), clientId, scope, audience, issuer, fam, now, now + refreshTtlMs)
    return { access, refresh, family: fam, expiresIn: Math.floor(accessTtlMs / 1000) }
  }

  getAccess(token) { return this.q.getAccess.get(this.hash(token)) ?? null }
  getRefresh(token) { return this.q.getRefresh.get(this.hash(token)) ?? null }
  revokeAccess(token) { return this.q.revokeAccess.run(Date.now(), this.hash(token)).changes > 0 }
  revokeAccessHash(hash) { return this.q.revokeAccess.run(Date.now(), hash).changes > 0 }
  revokeFamily(family) {
    this.q.revokeFamily.run(Date.now(), family)
    this.q.revokeRefreshFamily.run(Date.now(), family)
  }
  revokeRefresh(token) {
    const row = this.getRefresh(token)
    if (!row) return false
    this.revokeFamily(row.family)
    return true
  }
  rotateRefresh(token) { return this.q.rotateRefresh.run(Date.now(), this.hash(token)).changes > 0 }
}

/** owner 口令：scrypt 摘要，供 /authorize 的同意页校验 */
export function verifyOwnerPassword(password, stored) {
  if (typeof password !== 'string' || !stored?.salt || !stored?.hash) return false
  try {
    const guess = scryptSync(password, Buffer.from(stored.salt, 'hex'), 64, { N: stored.n, r: stored.r, p: stored.p, maxmem: 512 * 1024 * 1024 })
    const want = Buffer.from(stored.hash, 'hex')
    return guess.length === want.length && timingSafeEqual(guess, want)
  } catch { return false }
}
