/** 本地上游 JSON-RPC 客户端：只走 127.0.0.1，带超时/响应上限，可选请求头（如 Relay 的 Bearer）。 */
import { request as httpRequest } from 'node:http'

export function createUpstream(url, { timeoutMs = 60000, maxBytes = 8 * 1024 * 1024, headers = {}, headersFactory = null } = {}) {
  const u = new URL(url)
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) throw new Error('upstream must be loopback')
  const baseHeaders = { ...headers }

  function rpc(payload) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload))
      const req = httpRequest({
        host: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''), method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: `${u.hostname}:${u.port || 80}`,
          'content-length': body.length,
          accept: 'application/json, text/event-stream',
          ...baseHeaders,
          ...(headersFactory ? headersFactory() : {}),
        },
      }, (res) => {
        let size = 0; const chunks = []
        res.on('data', (c) => {
          size += c.length
          if (size > maxBytes) { req.destroy(new Error('upstream response too large')); return }
          chunks.push(c)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (!text.trim()) return reject(new Error(`upstream empty response (HTTP ${res.statusCode})`))
          try { resolve(JSON.parse(text)) } catch { reject(new Error(`upstream returned non-JSON (HTTP ${res.statusCode})`)) }
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')))
      req.on('error', reject)
      req.end(body)
    })
  }
  return { rpc }
}