import { describe, it, expect, beforeEach, vi } from 'vitest'

// These four hardening concerns only matter once the app is reachable by strangers, so nothing
// static flags them — the code does exactly what it says. Each test states the behaviour a
// public deployment needs.

// Read at module load by the server, so they must be set before it is imported.
process.env.ENABLE_ADMIN_ROUTES = 'false'
process.env.RATE_LIMIT_MAX = '3'
process.env.RATE_LIMIT_WINDOW_MS = '60000'
// These tests simulate distinct clients via X-Forwarded-For, which is exactly the
// reverse-proxy scenario TRUST_PROXY gates — off by default so a direct, unproxied deployment
// (rateLimit.ts's clientKey()) can't have its rate limit trivially rotated by a spoofed header.
process.env.TRUST_PROXY = 'true'

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(() => 'fake-model'),
  generateStyleSpec: vi.fn(),
  allocateBudget: vi.fn(),
  generateCategoryMeta: vi.fn(),
  generateOverallSummary: vi.fn(),
  generateRefinements: vi.fn(),
  generateCategories: vi.fn(),
  assignCollageRoles: vi.fn(),
  curateOutfits: vi.fn(),
}))

vi.mock('../src/adapters/llm.js', () => {
  class FakeAdapter {
    constructor() { Object.assign(this, mocks) }
  }
  return { ClaudeAdapter: FakeAdapter, OpenAIAdapter: FakeAdapter }
})

const { app } = await import('../src/server.js')
const { resetRateLimits } = await import('../src/server/rateLimit.js')
const { FixtureSearchAdapter } = await import('../src/adapters/search.js')
const { llm } = await import('../src/server/config.js')

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const intentOf = () => ({
  goal: 'weekend trip', goalType: 'style',
  constraints: { budget: 'Under $400' }, sessionId: 'ignored',
})

let ipCounter = 0
/** A distinct client address per test, so one test's rate-limit budget is its own. */
const freshIp = () => `10.0.0.${++ipCounter}`

beforeEach(() => {
  resetRateLimits()
  mocks.getModel.mockReset().mockReturnValue('fake-model')
  mocks.generateStyleSpec.mockReset().mockResolvedValue({})
  mocks.allocateBudget.mockReset().mockResolvedValue({})
  mocks.generateCategoryMeta.mockReset().mockResolvedValue({ rationale: 'r', filterChips: [] })
  mocks.generateOverallSummary.mockReset().mockResolvedValue('')
  mocks.generateRefinements.mockReset().mockResolvedValue([])
  mocks.generateCategories.mockReset().mockResolvedValue(['top'])
  mocks.assignCollageRoles.mockReset().mockResolvedValue({})
  mocks.curateOutfits.mockReset().mockResolvedValue([{ name: 'Look', rationale: '', slots: {} }])
})

describe('debug routes are not public', () => {
  // /debug/intents returns every session's captured goal, budget and preferences; /debug/raw
  // returns raw model output. On a public deployment that is other people's conversations.
  it.each(['/debug/intents', '/debug/events', '/debug/requests', '/debug/raw'])(
    'refuses %s when admin routes are disabled', async path => {
      const res = await app.request(path)
      expect(res.status).toBe(404)
    })

  it('does not leak a stored intent through the debug dump', async () => {
    await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': freshIp() })

    const res = await app.request('/debug/intents')

    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('weekend trip')
  })
})

describe('global config cannot be rewritten by a visitor', () => {
  // These mutate module-level state for every user at once, not per session.
  it.each([
    ['/api/provider', { provider: 'openai' }],
    ['/api/chat-model', { model: 'anything-a-stranger-types' }],
    ['/api/spec-model', { model: 'anything-a-stranger-types' }],
    ['/api/curation-model', { model: 'anything-a-stranger-types' }],
  ])('refuses POST %s when admin routes are disabled', async (path, body) => {
    expect((await post(path, body)).status).toBe(404)
  })

  // /api/env-status and the three model-id GETs are gated the same as their POST siblings —
  // reading which model/gateway config is active is reconnaissance value, same reasoning as
  // the write side. Verified against the llm singleton directly, not a GET, since that GET is
  // exactly what's under test here (asserting via it would be circular).
  it('leaves the active model untouched after a refused write', async () => {
    const before = llm.chatModelOverride
    await post('/api/chat-model', { model: 'anything-a-stranger-types' })
    expect(llm.chatModelOverride).toBe(before)
  })

  it.each(['/api/env-status', '/api/chat-model', '/api/spec-model', '/api/curation-model'])(
    'refuses GET %s when admin routes are disabled', async path => {
      expect((await app.request(path)).status).toBe(404)
    })

  it('still serves the read-only status routes that carry no config detail', async () => {
    expect((await app.request('/api/provider')).status).toBe(200)
    expect((await app.request('/health')).status).toBe(200)
  })
})

describe('the paid endpoints are rate limited', () => {
  it('rejects a burst past the limit with 429', async () => {
    const ip = freshIp()
    const send = () => post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': ip })

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await send()).status)

    // RATE_LIMIT_MAX is 3 for this file.
    expect(statuses.slice(0, 3).every(s => s !== 429)).toBe(true)
    expect(statuses.slice(3)).toEqual([429, 429])
  })

  it('limits the chat turn too', async () => {
    const ip = freshIp()
    const send = () => post('/api/chat',
      { messages: [{ role: 'user', content: 'hi' }], intent: null }, { 'x-forwarded-for': ip })

    for (let i = 0; i < 3; i++) await send()

    expect((await send()).status).toBe(429)
  })

  it('counts each client address separately', async () => {
    const busy = freshIp()
    for (let i = 0; i < 3; i++) {
      await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] }, { 'x-forwarded-for': busy })
    }
    expect((await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': busy })).status).toBe(429)

    const other = await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': freshIp() })
    expect(other.status).not.toBe(429)
  })

  it('tells the caller how long to wait', async () => {
    const ip = freshIp()
    for (let i = 0; i < 4; i++) {
      await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] }, { 'x-forwarded-for': ip })
    }
    const res = await post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': ip })

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('does not rate limit ordinary page and status requests', async () => {
    const ip = freshIp()
    for (let i = 0; i < 10; i++) {
      expect((await app.request('/health', { headers: { 'x-forwarded-for': ip } })).status).toBe(200)
    }
  })

  it('releases the budget once the window passes', async () => {
    const ip = freshIp()
    const send = () => post('/api/show-me-now', { intent: intentOf(), categories: ['top'] },
      { 'x-forwarded-for': ip })
    for (let i = 0; i < 4; i++) await send()
    expect((await send()).status).toBe(429)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    try {
      expect((await send()).status).not.toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the session id comes from the server, not the client', () => {
  const cookieOf = (res: Response) => res.headers.get('set-cookie') ?? ''

  it('issues a session cookie on a first visit', async () => {
    const res = await app.request('/health')
    const cookie = cookieOf(res)
    expect(cookie).toMatch(/gsid=/)
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite')
    expect(cookie.toLowerCase()).toContain('path=/')
  })

  it('issues an unguessable id', async () => {
    const idOf = (res: Response) => (cookieOf(res).match(/gsid=([^;]+)/) ?? [])[1]
    const a = idOf(await app.request('/health'))
    const b = idOf(await app.request('/health'))
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
  })

  it('reuses the id the browser already holds instead of minting another', async () => {
    const res = await app.request('/health', { headers: { cookie: 'gsid=existing-session-id' } })
    expect(cookieOf(res)).toBe('')
  })

  // The whole point: a stranger who types someone else's id in the request body gets their own
  // session, not that person's saved work.
  it('ignores a sessionId supplied in the request body', async () => {
    const victim = 'victim-session-id'
    await post('/api/show-me-now',
      { sessionId: victim, intent: intentOf(), categories: ['shoes'] },
      { cookie: `gsid=${victim}`, 'x-forwarded-for': freshIp() })

    // A different visitor claims the victim's id in the body, with their own cookie.
    mocks.generateCategories.mockResolvedValue(['top'])
    const res = await post('/api/show-me-now',
      { sessionId: victim, intent: intentOf() },
      { cookie: 'gsid=attacker-session-id', 'x-forwarded-for': freshIp() })

    const body = await res.json() as any
    // Falls back to a freshly generated list, not the victim's cached ['shoes'].
    expect(body.categories.map((c: any) => c.name)).toEqual(['top'])
  })

  // /api/refinements took intent.sessionId as given — unlike /api/chat and /api/show-me-now,
  // which both override it from the cookie. A caller-claimed id there could read or poison
  // another session's cached state the same way the body-level sessionId hole above could.
  it('overrides an intent-embedded sessionId on /api/refinements too', async () => {
    mocks.generateRefinements.mockClear()
    await post('/api/refinements',
      { intent: { ...intentOf(), sessionId: 'someone-elses-session' }, categories: ['top'] },
      { cookie: 'gsid=my-real-session', 'x-forwarded-for': freshIp() })

    const [passedIntent] = mocks.generateRefinements.mock.calls.at(-1) as [{ sessionId: string }]
    expect(passedIntent.sessionId).toBe('my-real-session')
  })

  // The per-session spec/budget/outfit caches in assemble.ts are keyed on intent.sessionId,
  // which arrives inside the client-supplied intent object. Left unnormalised, a caller who
  // sets it to someone else's id reads and poisons that session's cached work — the same class
  // of hole as the body sessionId, one layer down.
  it('does not let an intent-embedded sessionId reach another session\'s caches', async () => {
    const shared = 'someone-elses-session'
    const intentClaiming = { ...intentOf(), sessionId: shared }

    await post('/api/show-me-now', { intent: intentClaiming, categories: ['top'] },
      { cookie: 'gsid=session-a', 'x-forwarded-for': freshIp() })

    mocks.curateOutfits.mockClear()
    await post('/api/show-me-now', { intent: intentClaiming, categories: ['top'] },
      { cookie: 'gsid=session-b', 'x-forwarded-for': freshIp() })

    // 4th argument is previousOutfits, fed from curatedOutfitCache.
    const previousOutfits = mocks.curateOutfits.mock.calls.at(-1)?.[3]
    expect(previousOutfits).toBeUndefined()
  })

  it('keeps a session\'s own work reachable across requests with its cookie', async () => {
    const ip = freshIp()
    const cookie = 'gsid=my-own-session'
    await post('/api/show-me-now', { intent: intentOf(), categories: ['shoes'] },
      { cookie, 'x-forwarded-for': ip })

    mocks.generateCategories.mockClear()
    const res = await post('/api/show-me-now', { intent: intentOf() }, { cookie, 'x-forwarded-for': ip })

    const body = await res.json() as any
    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
    expect(mocks.generateCategories).not.toHaveBeenCalled()
  })

  // categoryStore used to save the requested list, not what assembly actually returned —
  // assembleResults drops categories with zero catalog matches, so a nonexistent category kept
  // getting re-searched (and re-billed through generateStyleSpec) on every later turn.
  it('stops re-requesting a category that returned no products', async () => {
    const ip = freshIp()
    const cookie = 'gsid=phantom-category-session'
    await post('/api/show-me-now', { intent: intentOf(), categories: ['shoes', 'nonexistent-widget'] },
      { cookie, 'x-forwarded-for': ip })

    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')
    querySpy.mockClear()
    const res = await post('/api/show-me-now', { intent: intentOf() }, { cookie, 'x-forwarded-for': ip })

    const body = await res.json() as any
    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
    expect(querySpy.mock.calls.some(call => call[0]?.category === 'nonexistent-widget')).toBe(false)
    querySpy.mockRestore()
  })
})
