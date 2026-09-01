import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IntentModel } from '../src/types/intent.js'

// POST /api/show-me-now is the button at the end of every demo. It exists precisely to never
// dead-end, so the tests here are mostly about the guarantees: the category-source priority,
// the anchor exclusion, the empty-assembly retry, and what happens when even that fails.
// Only the LLM adapter is mocked; search and CMS run against the real fixture catalog.
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
const { FixtureSearchAdapter } = await import('../src/adapters/search.js')

// categoryStore is restored from a real file in /tmp at import time, so a reused session id
// would arrive already holding categories and skip the code path under test.
const RUN = Math.random().toString(36).slice(2, 8)
let sessionCounter = 0
const newSession = () => `smn-${RUN}-${sessionCounter++}`

function intentOf(overrides: Partial<IntentModel> = {}): IntentModel {
  return {
    goal: 'weekend trip',
    goalType: 'style',
    constraints: { budget: 'Under $400' },
    sessionId: 'unused',
    ...overrides,
  }
}

// The session travels in the server-issued cookie, not the body — see src/server/session.ts.
// `sessionId` here names the session under test; it is sent as that cookie.
async function showMeNow(body: Record<string, unknown> & { sessionId: string }) {
  const { sessionId, ...payload } = body
  const res = await app.request('/api/show-me-now', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `gsid=${sessionId}` },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() as any }
}

/** Seed the session's assembled-category store the way a completed chat turn would. */
async function seedCategoryStore(sessionId: string, cats: string[]) {
  await showMeNow({ sessionId, intent: intentOf({ sessionId }), categories: cats })
}

beforeEach(() => {
  mocks.getModel.mockReset().mockReturnValue('fake-model')
  mocks.generateStyleSpec.mockReset().mockResolvedValue({})
  mocks.allocateBudget.mockReset().mockResolvedValue({})
  mocks.generateCategoryMeta.mockReset().mockResolvedValue({ rationale: 'r', filterChips: [] })
  mocks.generateOverallSummary.mockReset().mockResolvedValue('a summary')
  mocks.generateRefinements.mockReset().mockResolvedValue(['Colour'])
  mocks.generateCategories.mockReset().mockResolvedValue(['top'])
  mocks.assignCollageRoles.mockReset().mockResolvedValue({})
  mocks.curateOutfits.mockReset().mockResolvedValue([])
})

describe('POST /api/show-me-now — preconditions', () => {
  it('rejects a session with no intent anywhere', async () => {
    const { status, body } = await showMeNow({ sessionId: newSession(), intent: null })
    expect(status).toBe(400)
    expect(body.error).toMatch(/no intent/i)
  })

  it('falls back to the stored intent when the client sends none', async () => {
    const sessionId = newSession()
    await showMeNow({ sessionId, intent: intentOf({ sessionId }), categories: ['top'] })

    const { status, body } = await showMeNow({ sessionId, intent: null })

    expect(status).toBe(200)
    expect(body.intent.goal).toBe('weekend trip')
  })
})

describe('POST /api/show-me-now — category source priority', () => {
  it('prefers the categories the client sent', async () => {
    const sessionId = newSession()
    const { body } = await showMeNow({ sessionId, intent: intentOf({ sessionId }), categories: ['shoes'] })

    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
    expect(mocks.generateCategories).not.toHaveBeenCalled()
  })

  it('falls back to the session\'s already-assembled categories', async () => {
    const sessionId = newSession()
    await seedCategoryStore(sessionId, ['shoes'])
    mocks.generateCategories.mockClear()

    const { body } = await showMeNow({ sessionId, intent: intentOf({ sessionId }) })

    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
    expect(mocks.generateCategories).not.toHaveBeenCalled()
  })

  it('generates categories as the last resort when nothing is cached', async () => {
    mocks.generateCategories.mockResolvedValue(['pants'])
    const sessionId = newSession()

    const { body } = await showMeNow({ sessionId, intent: intentOf({ sessionId }) })

    expect(mocks.generateCategories).toHaveBeenCalledOnce()
    expect(body.categories.map((c: any) => c.name)).toEqual(['pants'])
  })
})

describe('POST /api/show-me-now — response shape', () => {
  it('returns assembled rows with products, summary, outfits and refinements', async () => {
    mocks.curateOutfits.mockResolvedValue([
      { name: 'Weekend', rationale: 'easy', slots: {} },
    ])
    const sessionId = newSession()

    const { status, body } = await showMeNow({
      sessionId, intent: intentOf({ sessionId }), categories: ['top', 'shoes'],
    })

    expect(status).toBe(200)
    expect(body.categories.map((c: any) => c.name)).toEqual(['top', 'shoes'])
    expect(body.categories.every((c: any) => c.products.length > 0)).toBe(true)
    expect(body.summary).toBe('a summary')
    expect(body.curatedOutfits[0].name).toBe('Weekend')
    expect(body.refinements).toEqual(['Colour'])
  })

  it('still returns results when the outfit and refinement calls both fail', async () => {
    mocks.curateOutfits.mockRejectedValue(new Error('llm down'))
    mocks.generateRefinements.mockRejectedValue(new Error('llm down'))
    const sessionId = newSession()

    const { status, body } = await showMeNow({
      sessionId, intent: intentOf({ sessionId }), categories: ['top'],
    })

    expect(status).toBe(200)
    expect(body.categories[0].products.length).toBeGreaterThan(0)
    // buildCuratedOutfits swallows the curation failure and pairs by index instead, so outfits
    // still arrive — unnamed, because the naming came from the model that just failed.
    expect(body.curatedOutfits.length).toBeGreaterThan(0)
    expect(body.curatedOutfits.every((o: any) => o.name === '')).toBe(true)
    expect(body.refinements).toEqual([])
  })

  it('caches the assembled categories for the next turn', async () => {
    const sessionId = newSession()
    await showMeNow({ sessionId, intent: intentOf({ sessionId }), categories: ['shoes'] })
    mocks.generateCategories.mockClear()

    // No categories supplied this time — the store must answer.
    const { body } = await showMeNow({ sessionId, intent: intentOf({ sessionId }) })

    expect(mocks.generateCategories).not.toHaveBeenCalled()
    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
  })
})

describe('POST /api/show-me-now — anchor items', () => {
  it('never shops for a category the shopper already owns', async () => {
    const sessionId = newSession()
    const intent = intentOf({
      sessionId,
      anchorItems: [{ name: 'my own chinos', category: 'pants' }],
    })

    const { body } = await showMeNow({ sessionId, intent, categories: ['top', 'pants'] })

    expect(body.categories.map((c: any) => c.name)).toEqual(['top'])
  })

  it('applies the anchor exclusion to generated categories too', async () => {
    mocks.generateCategories.mockResolvedValue(['top', 'pants'])
    const sessionId = newSession()
    const intent = intentOf({
      sessionId,
      anchorItems: [{ name: 'my own chinos', category: 'pants' }],
    })

    const { body } = await showMeNow({ sessionId, intent })

    expect(body.categories.map((c: any) => c.name)).toEqual(['top'])
  })
})

describe('POST /api/show-me-now — the never-dead-end guarantee', () => {
  // The exact gap the old chat fast path had: a cached category list that no longer resolves
  // to anything must not strand the shopper.
  it('retries with a fresh category list when the first assembly comes back empty', async () => {
    mocks.generateCategories.mockResolvedValue(['shoes'])
    const sessionId = newSession()

    const { status, body } = await showMeNow({
      sessionId, intent: intentOf({ sessionId }), categories: ['not-a-real-category'],
    })

    expect(mocks.generateCategories).toHaveBeenCalledOnce()
    expect(status).toBe(200)
    expect(body.categories.map((c: any) => c.name)).toEqual(['shoes'])
    expect(body.categories[0].products.length).toBeGreaterThan(0)
  })

  it('re-applies the anchor exclusion on the retry', async () => {
    mocks.generateCategories.mockResolvedValue(['top', 'pants'])
    const sessionId = newSession()
    const intent = intentOf({
      sessionId,
      anchorItems: [{ name: 'my own chinos', category: 'pants' }],
    })

    const { body } = await showMeNow({ sessionId, intent, categories: ['not-a-real-category'] })

    expect(body.categories.map((c: any) => c.name)).toEqual(['top'])
  })

  it('reports a clear error rather than empty results when even the retry finds nothing', async () => {
    mocks.generateCategories.mockResolvedValue(['still-not-real'])
    const sessionId = newSession()

    const { status, body } = await showMeNow({
      sessionId, intent: intentOf({ sessionId }), categories: ['not-a-real-category'],
    })

    expect(status).toBe(500)
    expect(body.error).toMatch(/could not assemble/i)
    expect(body.categories).toBeUndefined()
  })

  it('does not cache a category list that failed to assemble', async () => {
    mocks.generateCategories.mockResolvedValue(['still-not-real'])
    const sessionId = newSession()
    await showMeNow({ sessionId, intent: intentOf({ sessionId }), categories: ['not-a-real-category'] })

    // A later call must not inherit the failed list from the store.
    mocks.generateCategories.mockResolvedValue(['top'])
    const { status, body } = await showMeNow({ sessionId, intent: intentOf({ sessionId }) })

    expect(status).toBe(200)
    expect(body.categories.map((c: any) => c.name)).toEqual(['top'])
  })

  it('returns 500 rather than hanging when the search backend throws', async () => {
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')
      .mockRejectedValue(new Error('search down'))
    const sessionId = newSession()

    const { status, body } = await showMeNow({
      sessionId, intent: intentOf({ sessionId }), categories: ['top'],
    })

    expect(status).toBe(500)
    expect(body.error).toBeDefined()
    querySpy.mockRestore()
  })

  it('returns 500 when the last-resort category call itself fails', async () => {
    mocks.generateCategories.mockRejectedValue(new Error('llm down'))
    const sessionId = newSession()

    const { status } = await showMeNow({ sessionId, intent: intentOf({ sessionId }) })

    expect(status).toBe(500)
  })
})
