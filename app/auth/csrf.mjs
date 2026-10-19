/** 同意页 CSRF 令牌：HMAC(pepper) 绑定 client_id + PKCE challenge + 过期时间 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const b64 = (b) => Buffer.from(b).toString('base64url')
const unb64 = (s) => Buffer.from(s, 'base64url')

export function createCsrf(pepper) {
  if (!pepper || pepper.length < 32) throw new Error('csrf pepper too short')

  function sign(payload) {
    return createHmac('sha256', pepper).update(payload).digest('base64url')
  }

  /** @returns token = base64url(nonce.exp).sig */
  function issue({ clientId, challenge, ttlMs = 5 * 60_000 }) {
    const nonce = randomBytes(12).toString('base64url')
    const exp = Date.now() + ttlMs
    const payload = `csrf|${clientId}|${challenge}|${exp}|${nonce}`
    return `${b64(payload)}.${sign(payload)}`
  }

  function verify(token, { clientId, challenge }) {
    if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' }
    const [payloadB64, sig] = token.split('.')
    let payload
    try { payload = unb64(payloadB64).toString('utf8') } catch { return { ok: false, reason: 'malformed' } }
    const parts = payload.split('|')
    if (parts.length !== 5 || parts[0] !== 'csrf') return { ok: false, reason: 'malformed' }
    const [, cid, chal, exp] = parts
    const want = Buffer.from(sign(payload))
    const got = Buffer.from(String(sig))
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' }
    if (Number(exp) < Date.now()) return { ok: false, reason: 'expired' }
    if (cid !== clientId || chal !== challenge) return { ok: false, reason: 'binding_mismatch' }
    return { ok: true }
  }

  return { issue, verify }
}
