import type { Context, Next } from 'hono'

/**
 * Fixed-window in-memory rate limiter for the endpoints that spend money.
 *
 * /api/chat and /api/show-me-now each call a paid LLM gateway on the operator's key, with no
 * account behind them. On a public URL that is an unbounded bill, so they need a ceiling even
 * though nothing about them is otherwise sensitive.
 *
 * In-memory means per-process: a multi-instance deployment needs a shared store (Redis) for the
 * limit to hold globally. Adequate for a single-instance prototype, and deliberately simple.
 */

/** `Number('0') || fallback` would silently discard an operator's `0`, which is a deliberate
 *  hard kill-switch during an incident, not an unset value — so unset/empty is distinguished
 *  from an explicit 0 rather than relying on falsy-ness. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const WINDOW_MS = envInt('RATE_LIMIT_WINDOW_MS', 60_000)
const MAX_REQUESTS = envInt('RATE_LIMIT_MAX', 20)

interface Window { count: number; resetAt: number }

const windows = new Map<string, Window>()

/** Clears all counters. Exported for tests; nothing in the request path calls it. */
export function resetRateLimits() {
  windows.clear()
}

/** Opportunistic sweep of expired windows, throttled to once per WINDOW_MS so it doesn't scan
 *  the whole map on every request. Without this, every distinct client identity that ever made
 *  one request leaves a permanent entry for the life of the process. */
let lastSweep = Date.now()
function sweepExpired(now: number) {
  if (now - lastSweep < WINDOW_MS) return
  lastSweep = now
  for (const [key, w] of windows) if (now >= w.resetAt) windows.delete(key)
}

/**
 * Best-effort client identity. Behind a proxy the socket address is the proxy's, so the first
 * X-Forwarded-For hop is preferred — spoofable by a direct caller, which is why this is a cost
 * guard rather than a security boundary. The session cookie is the last resort so that a client
 * with no usable address still gets counted rather than sharing one global bucket.
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  const real = c.req.header('x-real-ip')
  if (real) return real.trim()
  const conn = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress
  if (conn) return conn
  return c.get('sessionId') ?? 'unknown'
}

/** Rejects with 429 once a client exceeds MAX_REQUESTS within WINDOW_MS. */
export async function rateLimit(c: Context, next: Next) {
  const key = clientKey(c)
  const now = Date.now()
  sweepExpired(now)
  const current = windows.get(key)

  // MAX_REQUESTS <= 0 is an operator hard-stop — checked before the fresh-window branch below,
  // which would otherwise always let a client's first request in a window through regardless.
  if (MAX_REQUESTS <= 0) {
    console.warn(`[rate-limit] ${key} blocked — MAX_REQUESTS=${MAX_REQUESTS}`)
    return c.json({ error: 'Too many requests — please wait a moment and try again.' }, 429, { 'Retry-After': '60' })
  }

  if (!current || now >= current.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return next()
  }

  if (current.count >= MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    console.warn(`[rate-limit] ${key} exceeded ${MAX_REQUESTS} requests, retry in ${retryAfter}s`)
    return c.json(
      { error: 'Too many requests — please wait a moment and try again.' },
      429,
      { 'Retry-After': String(retryAfter) },
    )
  }

  current.count += 1
  return next()
}
