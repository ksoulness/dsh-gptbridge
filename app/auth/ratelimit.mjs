/** 分端点固定窗口限流（按 socket 对端地址计数；不信任 X-Forwarded-For） */
export function createLimiters(spec = {}) {
  const buckets = new Map() // `${name}|${ip}` -> {n, reset}
  const now = () => Date.now()

  function hit(name, ip) {
    const cfg = spec[name] ?? { limit: 60, windowMs: 60_000 }
    const key = `${name}|${ip}`
    const b = buckets.get(key) ?? { n: 0, reset: now() + cfg.windowMs }
    if (now() > b.reset) { b.n = 0; b.reset = now() + cfg.windowMs }
    b.n += 1
    buckets.set(key, b)
    return { ok: b.n <= cfg.limit, remaining: Math.max(0, cfg.limit - b.n), retryAfterMs: Math.max(0, b.reset - now()), limit: cfg.limit }
  }

  /** 失败计数：仅对认证失败累加，成功可清零 */
  function fail(name, ip, limit = 10, windowMs = 60_000) {
    const key = `${name}|${ip}`
    const b = buckets.get(key) ?? { n: 0, reset: now() + windowMs, fail: 0 }
    if (now() > b.reset) { b.n = 0; b.reset = now() + windowMs; b.fail = 0 }
    b.fail = (b.fail ?? 0) + 1
    buckets.set(key, b)
    return { blocked: b.fail > limit, failures: b.fail, limit }
  }
  function reset(name, ip) { buckets.delete(`${name}|${ip}`) }
  return { hit, fail, reset, size: () => buckets.size }
}
