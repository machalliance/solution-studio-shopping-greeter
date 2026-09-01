import { randomUUID } from 'node:crypto'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'

/**
 * Server-issued session identity.
 *
 * The client used to invent its own sessionId and send it in the request body, and the server
 * trusted it — so anyone who supplied another session's id was handed that session's stored
 * intent and assembled categories. The id is now minted here, kept in an HttpOnly cookie the
 * page's JavaScript cannot read or forge, and read only from that cookie. A sessionId in the
 * body is ignored entirely; leaving a fallback to it would reopen the hole, since an attacker
 * would simply omit the cookie.
 */

/** The app's Hono environment — every handler can read the session id off the context. */
export type AppEnv = { Variables: { sessionId: string } }

const COOKIE_NAME = 'gsid'

// Secure requires HTTPS, which local development over http:// does not have — the cookie would
// silently never be set. SameSite=Lax is enough here: the panel iframe is same-origin with the
// host pages. A cross-origin embed would need SameSite=None, which in turn requires Secure.
const isProduction = process.env.NODE_ENV === 'production'

/** Issues a session cookie when the browser has none, and exposes the id to handlers. */
export async function sessionMiddleware(c: Context, next: Next) {
  let sessionId = getCookie(c, COOKIE_NAME)
  if (!sessionId) {
    sessionId = randomUUID()
    setCookie(c, COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: isProduction,
      maxAge: 60 * 60 * 24 * 7,
    })
  }
  c.set('sessionId', sessionId)
  return next()
}

/** The session id for this request. Always the cookie's — never anything the caller sent. */
export function getSessionId(c: Context): string {
  return c.get('sessionId')
}
