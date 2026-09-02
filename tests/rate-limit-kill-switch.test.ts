import { describe, it, expect, beforeEach, vi } from 'vitest'

// RATE_LIMIT_MAX=0 is an operator's emergency kill-switch during an incident. It needs its own
// file: env vars are read once at module load, and security.test.ts already imports the server
// with RATE_LIMIT_MAX=3.
process.env.RATE_LIMIT_MAX = '0'
process.env.RATE_LIMIT_WINDOW_MS = '60000'

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(() => 'fake-model'),
  generateStyleSpec: vi.fn().mockResolvedValue({}),
  allocateBudget: vi.fn().mockResolvedValue({}),
  generateCategoryMeta: vi.fn().mockResolvedValue({ rationale: 'r', filterChips: [] }),
  generateOverallSummary: vi.fn().mockResolvedValue(''),
  generateRefinements: vi.fn().mockResolvedValue([]),
  generateCategories: vi.fn().mockResolvedValue(['top']),
  assignCollageRoles: vi.fn().mockResolvedValue({}),
  curateOutfits: vi.fn().mockResolvedValue([{ name: 'Look', rationale: '', slots: {} }]),
}))

vi.mock('../src/adapters/llm.js', () => {
  class FakeAdapter {
    constructor() { Object.assign(this, mocks) }
  }
  return { ClaudeAdapter: FakeAdapter, OpenAIAdapter: FakeAdapter }
})

const { app } = await import('../src/server.js')
const { resetRateLimits } = await import('../src/server/rateLimit.js')

beforeEach(() => resetRateLimits())

// `Number('0') || 20` evaluates falsy and silently fell back to the default of 20, so the
// kill-switch never actually took effect. Also checks the first-request branch specifically:
// a fresh client's very first request used to skip the MAX_REQUESTS check entirely.
it('blocks every request, including a client\'s very first, when RATE_LIMIT_MAX=0', async () => {
  const res = await app.request('/api/show-me-now', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' },
    body: JSON.stringify({
      intent: { goal: 'weekend trip', goalType: 'style', constraints: {}, sessionId: 'ignored' },
      categories: ['top'],
    }),
  })

  expect(res.status).toBe(429)
})
