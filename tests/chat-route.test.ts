import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IntentModel } from '../src/types/intent.js'

// POST /api/chat is the whole conversation: it streams the reply, previews chips, merges the
// intent delta, gates on budget, and decides whether to assemble. Two seams are mocked — the
// model stream ('ai') and the LLM adapter — and everything else (intent merge, budget gate,
// SSE ordering, assembly against the real fixture catalog) runs for real.
const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
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

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  // server.ts only passes the result of Output.object() straight through to streamText.
  Output: { object: (config: unknown) => config },
}))

vi.mock('../src/adapters/llm.js', () => {
  class FakeAdapter {
    constructor() { Object.assign(this, mocks) }
  }
  return { ClaudeAdapter: FakeAdapter, OpenAIAdapter: FakeAdapter }
})

const { app } = await import('../src/server.js')
const { FixtureSearchAdapter } = await import('../src/adapters/search.js')

// categoryStore is restored from a real file in /tmp at import time, so a session id reused
// across runs would arrive already holding categories and silently take the refinement path.
// A per-process prefix keeps every test's session genuinely new.
const RUN = Math.random().toString(36).slice(2, 8)
let sessionCounter = 0
const newSession = () => `chat-${RUN}-${sessionCounter++}`

type SSEEvent = Record<string, any> & { type: string }

/** Drive one chat turn and return the parsed SSE event stream. */
async function chat(body: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  sessionId: string
  intent?: IntentModel | null
  selections?: string[]
  categories?: string[]
}): Promise<SSEEvent[]> {
  // The session travels in the server-issued cookie, not the body — see src/server/session.ts.
  const { sessionId, ...payload } = body
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `gsid=${sessionId}` },
    body: JSON.stringify({ intent: null, ...payload }),
  })
  expect(res.status).toBe(200)
  return parseSSE(await res.text())
}

function parseSSE(raw: string): SSEEvent[] {
  return raw
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => JSON.parse(l.slice(6)))
}

const types = (events: SSEEvent[]) => events.map(e => e.type)
const first = (events: SSEEvent[], type: string) => events.find(e => e.type === type)
const all = (events: SSEEvent[], type: string) => events.filter(e => e.type === type)
const replyText = (events: SSEEvent[]) => all(events, 'text-delta').map(e => e.content).join('')

/** The delta shape server.ts expects: every key present, nulls rather than omissions. */
function delta(overrides: Record<string, unknown> = {}) {
  return {
    goal: null, goalType: null, style: null, styleFamily: null, fit: null, budget: null,
    colourDirection: null, warmth: null, venue: null, finish: null,
    roomSize: null, vanityWidth: null, avoidances: [], requiresTags: [],
    categoryConstraints: [], anchorItem: null,
    ...overrides,
  }
}

/**
 * Stage one model turn. `partials` are the incremental objects the stream yields; `final` is the
 * validated object server.ts reads after the stream closes.
 */
function modelTurn(final: Record<string, unknown>, partials?: Record<string, unknown>[]) {
  const chunks = partials ?? [{ reply: final.reply ?? '' }]
  mocks.streamText.mockReturnValue({
    partialOutputStream: (async function* () {
      for (const p of chunks) yield p
    })(),
    output: Promise.resolve(final),
  })
}

const turn = (o: Record<string, unknown> = {}) => ({
  reply: 'Sounds good.',
  chips: { kind: 'select', choices: [] },
  delta: delta(),
  isReady: false,
  isEarlyReady: false,
  categories: [],
  ...o,
})

beforeEach(() => {
  mocks.streamText.mockReset()
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

describe('POST /api/chat — SSE contract', () => {
  it('streams only the newly generated slice of the reply and ends with done', async () => {
    modelTurn(turn({ reply: 'Hello there friend' }), [
      { reply: 'Hello' },
      { reply: 'Hello there' },
      { reply: 'Hello there friend' },
    ])

    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })

    expect(all(events, 'text-delta').map(e => e.content)).toEqual(['Hello', ' there', ' friend'])
    expect(replyText(events)).toBe('Hello there friend')
    expect(types(events).at(-1)).toBe('done')
  })

  it('never re-sends text the shopper has already seen when a partial repeats', async () => {
    modelTurn(turn({ reply: 'Same' }), [{ reply: 'Same' }, { reply: 'Same' }, { reply: 'Same' }])
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    expect(replyText(events)).toBe('Same')
    expect(all(events, 'text-delta')).toHaveLength(1)
  })

  it('emits intent-update then done for an ordinary clarifying turn', async () => {
    modelTurn(turn({ chips: { kind: 'options', choices: ['Scandi', 'Coastal'] } }))
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    expect(types(events)).toEqual(['text-delta', 'options', 'intent-update', 'done'])
  })

  it('reports a generic error without leaking provider detail when the model call fails', async () => {
    mocks.streamText.mockImplementation(() => { throw new Error('gateway 429: billing quota exceeded') })
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    const err = first(events, 'error')!
    expect(err).toBeDefined()
    expect(Object.keys(err)).toEqual(['type'])
    expect(JSON.stringify(events)).not.toContain('billing')
  })
})

describe('POST /api/chat — chip previewing', () => {
  it('previews chips as soon as delta appears, before the stream closes', async () => {
    modelTurn(turn({ chips: { kind: 'options', choices: ['Scandi', 'Coastal'] } }), [
      { reply: 'Pick one' },
      { reply: 'Pick one', chips: { kind: 'options', choices: ['Scandi', 'Coastal'] } },
      { reply: 'Pick one', chips: { kind: 'options', choices: ['Scandi', 'Coastal'] }, delta: delta() },
    ])

    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })

    const options = all(events, 'options')
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ kind: 'options', choices: ['Scandi', 'Coastal'] })
  })

  it('does not preview chips while chips is still growing mid-stream', async () => {
    // delta has not appeared yet, so chips may still be incomplete — previewing here is what
    // previously showed the shopper a truncated option.
    modelTurn(turn({ chips: { kind: 'options', choices: ['Scandi', 'Coastal', 'Japandi'] } }), [
      { reply: 'Pick', chips: { kind: 'options', choices: ['Scandi', 'Coast'] } },
      { reply: 'Pick', chips: { kind: 'options', choices: ['Scandi', 'Coastal', 'Japandi'] }, delta: delta() },
    ])

    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })

    expect(all(events, 'options')).toHaveLength(1)
    expect(first(events, 'options')!.choices).toEqual(['Scandi', 'Coastal', 'Japandi'])
  })

  it('does not preview a single-choice chip set', async () => {
    modelTurn(turn({ chips: { kind: 'select', choices: ['Only one'] } }), [
      { reply: 'Pick', chips: { kind: 'select', choices: ['Only one'] }, delta: delta() },
    ])
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    // Emitted once by the post-stream path, not twice.
    expect(all(events, 'options')).toHaveLength(1)
  })

  it('does not duplicate the preview when the final chips are identical', async () => {
    const chips = { kind: 'options', choices: ['A', 'B'] }
    modelTurn(turn({ chips }), [
      { reply: 'Pick', chips, delta: delta() },
    ])
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    expect(all(events, 'options')).toHaveLength(1)
  })
})

describe('POST /api/chat — budget gate', () => {
  it('defers isReady and injects fashion budget chips when budget was never captured', async () => {
    modelTurn(turn({ isReady: true, categories: ['top'], delta: delta({ goalType: 'style', style: 'Coastal' }) }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    expect(types(events)).not.toContain('intent-ready')
    expect(first(events, 'options')).toMatchObject({
      kind: 'select',
      choices: ['Under $400', '$400–$800', '$800–$1,500', 'No set limit'],
    })
  })

  it('injects the project budget chips for a room project, including the open-ended tier', async () => {
    modelTurn(turn({ isReady: true, categories: ['vanity'], delta: delta({ goalType: 'project' }) }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    expect(first(events, 'options')!.choices).toEqual(
      ['Under $1,000', '$1,000–$2,500', '$2,500–$5,000', 'Over $5,000'],
    )
  })

  it('assembles once a budget is present', async () => {
    modelTurn(turn({
      isReady: true,
      categories: ['top'],
      delta: delta({ goalType: 'style', budget: 'Under $400' }),
    }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    const ready = first(events, 'intent-ready')!
    expect(ready).toBeDefined()
    expect(ready.categories[0].name).toBe('top')
    expect(ready.categories[0].products.length).toBeGreaterThan(0)
    expect(ready.summary).toBe('a summary')
    expect(types(events)).toContain('building')
  })
})

describe('POST /api/chat — "show me now" override', () => {
  it('forces assembly even when the model did not set isReady', async () => {
    modelTurn(turn({ isReady: false, categories: ['top'], delta: delta({ budget: 'Under $400' }) }))

    const events = await chat({
      messages: [{ role: 'user', content: 'Show me now' }],
      sessionId: newSession(),
    })

    expect(first(events, 'intent-ready')).toBeDefined()
  })

  it('bypasses the budget gate so the shopper is never asked one more question', async () => {
    modelTurn(turn({ isReady: true, categories: ['top'], delta: delta() }))

    const events = await chat({
      messages: [{ role: 'user', content: 'show me now' }],
      sessionId: newSession(),
    })

    expect(first(events, 'intent-ready')).toBeDefined()
    expect(all(events, 'options')).toHaveLength(0)
  })

  it('falls back to a dedicated category call when the model committed to none', async () => {
    modelTurn(turn({ isReady: true, categories: [], delta: delta({ budget: 'Under $400' }) }))
    mocks.generateCategories.mockResolvedValue(['shoes'])

    const events = await chat({
      messages: [{ role: 'user', content: 'show me now' }],
      sessionId: newSession(),
    })

    expect(mocks.generateCategories).toHaveBeenCalled()
    expect(first(events, 'intent-ready')!.categories[0].name).toBe('shoes')
  })

  it('ignores the phrase inside an unrelated topic label', async () => {
    // "Show me what you have" is the anchor-item topic — matching it forced isReady with no
    // categories and stranded the conversation.
    modelTurn(turn({ isReady: false, categories: [], delta: delta() }))

    const events = await chat({
      messages: [{ role: 'user', content: 'Show me what you have' }],
      sessionId: newSession(),
    })

    expect(types(events)).toContain('intent-update')
    expect(first(events, 'intent-ready')).toBeUndefined()
  })
})

describe('POST /api/chat — early-ready', () => {
  it('emits early-ready and caches the categories for a later show-me-now', async () => {
    const sessionId = newSession()
    modelTurn(turn({
      isEarlyReady: true,
      categories: ['top'],
      delta: delta({ goalType: 'style', budget: 'Under $400' }),
    }))

    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId })
    expect(types(events)).toContain('early-ready')

    // The cached list lets the next turn skip the model entirely.
    mocks.streamText.mockReset()
    const second = await chat({ messages: [{ role: 'user', content: 'Show me now' }], sessionId })

    expect(mocks.streamText).not.toHaveBeenCalled()
    expect(first(second, 'intent-ready')!.categories[0].name).toBe('top')
    expect(replyText(second)).toMatch(/Here's what I've put together/)
  })

  // The main path already excludes an anchor item's category from assembly (a shopper who says
  // "I already own this" never gets it re-recommended); the fast path skipped that same filter.
  it('excludes an anchor item\'s category from the fast path too', async () => {
    const sessionId = newSession()
    modelTurn(turn({
      isEarlyReady: true,
      categories: ['top', 'pants'],
      delta: delta({
        goalType: 'style', budget: 'Under $400',
        anchorItem: { name: 'dark jeans', description: null, category: 'pants' },
      }),
    }))
    await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId })

    mocks.streamText.mockReset()
    const second = await chat({ messages: [{ role: 'user', content: 'Show me now' }], sessionId })

    const names = first(second, 'intent-ready')!.categories.map((c: any) => c.name)
    expect(names).not.toContain('pants')
    expect(names).toContain('top')
  })

  // The fast path's own assembly failing used to write intent-update and return with no retry —
  // a confirmed dead-end. Only a thrown assembly reaches it: a category that matches nothing
  // still yields a row (see the empty-row test below), so the row count alone never hits zero.
  it('retries the fast path with fresh categories when the cached list assembles nothing', async () => {
    const sessionId = newSession()
    modelTurn(turn({
      isEarlyReady: true,
      categories: ['top'],
      delta: delta({ goalType: 'style', budget: 'Under $400' }),
    }))
    await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId })

    mocks.streamText.mockReset()
    mocks.generateCategories.mockResolvedValue(['shoes'])
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')
    querySpy.mockRejectedValueOnce(new Error('search down'))

    const events = await chat({ messages: [{ role: 'user', content: 'Show me now' }], sessionId })

    expect(mocks.generateCategories).toHaveBeenCalled()
    expect(first(events, 'intent-ready')!.categories[0].name).toBe('shoes')
    querySpy.mockRestore()
  })

  it('uses the project wording in the canned fast-path reply', async () => {
    const sessionId = newSession()
    modelTurn(turn({
      isEarlyReady: true,
      categories: ['vanity'],
      delta: delta({ goalType: 'project', goal: 'bathroom refresh', budget: 'Under $5,000' }),
    }))
    await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId })

    mocks.streamText.mockReset()
    const events = await chat({ messages: [{ role: 'user', content: 'Show me now' }], sessionId })

    expect(replyText(events)).toBe("Here's your bathroom refresh shopping list — let's get you set up.")
  })
})

describe('POST /api/chat — intent delta merge', () => {
  /** Run two turns on one session and return the intent the second turn produced. */
  async function twoTurns(firstDelta: Record<string, unknown>, secondDelta: Record<string, unknown>) {
    const sessionId = newSession()
    modelTurn(turn({ delta: delta(firstDelta) }))
    await chat({ messages: [{ role: 'user', content: 'one' }], sessionId })
    modelTurn(turn({ delta: delta(secondDelta) }))
    const events = await chat({ messages: [{ role: 'user', content: 'two' }], sessionId })
    return first(events, 'intent-update')!.intent as IntentModel
  }

  it('holds styleFamily fixed once set, even if a later turn tries to change it', async () => {
    const intent = await twoTurns({ styleFamily: 'Coastal' }, { styleFamily: 'Industrial', style: 'Nautical' })
    expect(intent.constraints.styleFamily).toBe('Coastal')
    expect(intent.constraints.style).toBe('Nautical')
  })

  it('unions avoidances across turns', async () => {
    const intent = await twoTurns({ avoidances: ['neon'] }, { avoidances: ['leather', 'neon'] })
    expect(intent.constraints.avoidances).toEqual(['neon', 'leather'])
  })

  it('replaces requiresTags rather than accumulating them into an unsatisfiable AND', async () => {
    const intent = await twoTurns({ requiresTags: ['linen'] }, { requiresTags: ['wool'] })
    expect(intent.constraints.requiresTags).toEqual(['wool'])
  })

  it('merges categoryConstraints per category — replacing AND tags, unioning OR tags', async () => {
    const intent = await twoTurns(
      { categoryConstraints: [{ category: 'pants', requiresTags: ['slim'], requiresAny: ['jeans'], avoidances: ['black'] }] },
      { categoryConstraints: [{ category: 'pants', requiresTags: ['wide-leg'], requiresAny: ['chinos'], avoidances: ['white'] }] },
    )
    expect(intent.constraints.categoryConstraints).toEqual({
      pants: { requiresTags: ['wide-leg'], requiresAny: ['jeans', 'chinos'], avoidances: ['black', 'white'] },
    })
  })

  it('keeps an existing category AND tag when a later turn sends none for it', async () => {
    const intent = await twoTurns(
      { categoryConstraints: [{ category: 'top', requiresTags: ['short-sleeve'], requiresAny: [], avoidances: [] }] },
      { categoryConstraints: [{ category: 'top', requiresTags: [], requiresAny: ['linen'], avoidances: [] }] },
    )
    expect((intent.constraints.categoryConstraints as any).top.requiresTags).toEqual(['short-sleeve'])
  })

  it('replaces an anchor item for the same category instead of collecting duplicates', async () => {
    const intent = await twoTurns(
      { anchorItem: { name: 'dark jeans', description: 'indigo', category: 'pants' } },
      { anchorItem: { name: 'navy jeans', description: 'navy', category: 'pants' } },
    )
    expect(intent.anchorItems).toEqual([{ name: 'navy jeans', description: 'navy', category: 'pants' }])
  })

  it('keeps anchor items for different categories side by side', async () => {
    const intent = await twoTurns(
      { anchorItem: { name: 'dark jeans', description: null, category: 'pants' } },
      { anchorItem: { name: 'brown boots', description: null, category: 'shoes' } },
    )
    expect(intent.anchorItems!.map(a => a.category)).toEqual(['pants', 'shoes'])
  })

  it.each([
    ['unknown', 'unknown'],
    ['placeholder marker', '<budget>'],
    ['mixed-case unknown', 'Unknown'],
  ])('strips a %s value rather than storing it as a real constraint', async (_label, value) => {
    const sessionId = newSession()
    modelTurn(turn({ delta: delta({ budget: value, style: 'Coastal' }) }))
    const events = await chat({ messages: [{ role: 'user', content: 'hi' }], sessionId })
    const intent = first(events, 'intent-update')!.intent as IntentModel
    expect(intent.constraints.budget).toBeUndefined()
    expect(intent.constraints.style).toBe('Coastal')
  })

  it('excludes an owned item\'s category from the assembled shopping list', async () => {
    modelTurn(turn({
      isReady: true,
      categories: ['top', 'pants'],
      delta: delta({
        budget: 'Under $400',
        anchorItem: { name: 'my own chinos', description: null, category: 'pants' },
      }),
    }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    const names = first(events, 'intent-ready')!.categories.map((c: any) => c.name)
    expect(names).toEqual(['top'])
  })
})

describe('POST /api/chat — refinement turns', () => {
  it('re-assembles with updated constraints when the session already has categories', async () => {
    const sessionId = newSession()
    modelTurn(turn({ isReady: true, categories: ['top'], delta: delta({ budget: 'Under $400' }) }))
    await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId })

    // A later non-ready turn is a refinement, not a question.
    modelTurn(turn({ isReady: false, categories: [], delta: delta({ avoidances: ['black'] }) }))
    const events = await chat({ messages: [{ role: 'user', content: 'no black' }], sessionId })

    const ready = first(events, 'intent-ready')!
    expect(ready).toBeDefined()
    expect(ready.categories[0].name).toBe('top')
    expect(ready.intent.constraints.avoidances).toEqual(['black'])
  })

  it('falls back to intent-update when the model claims ready but names no categories', async () => {
    modelTurn(turn({ isReady: true, categories: [], delta: delta({ budget: 'Under $400' }) }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    expect(first(events, 'intent-ready')).toBeUndefined()
    expect(first(events, 'intent-update')).toBeDefined()
    expect(types(events).at(-1)).toBe('done')
  })

  // The model can invent a category the catalog has no vocabulary for — the chat prompt warns it
  // twice about "trousers" specifically. A row with no products renders as a blank tile in
  // CollageView, so it must never reach the shopper.
  it('drops a category with no catalog match instead of shipping a blank tile', async () => {
    modelTurn(turn({
      isReady: true,
      categories: ['top', 'trousers'],
      delta: delta({ budget: 'Under $400' }),
    }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    const rows = first(events, 'intent-ready')!.categories
    expect(rows.map((r: any) => r.name)).toEqual(['top'])
    expect(rows.every((r: any) => r.products.length > 0)).toBe(true)
  })

  it('falls back to intent-update when every requested category comes back empty', async () => {
    modelTurn(turn({
      isReady: true,
      categories: ['trousers', 'also-not-real'],
      delta: delta({ budget: 'Under $400' }),
    }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    expect(first(events, 'intent-ready')).toBeUndefined()
    expect(first(events, 'intent-update')).toBeDefined()
    expect(types(events).at(-1)).toBe('done')
  })

  it('still completes the turn when the refinement chip call fails', async () => {
    mocks.generateRefinements.mockRejectedValue(new Error('llm down'))
    modelTurn(turn({ isReady: true, categories: ['top'], delta: delta({ budget: 'Under $400' }) }))

    const events = await chat({ messages: [{ role: 'user', content: 'ready' }], sessionId: newSession() })

    expect(first(events, 'intent-ready')).toBeDefined()
    expect(types(events)).toContain('done')
  })
})

describe('POST /api/chat — timeout guard', () => {
  afterEach(() => { vi.useRealTimers() })

  it('turns a stalled model stream into an error event instead of hanging', async () => {
    mocks.streamText.mockReturnValue({
      partialOutputStream: (async function* () {
        await new Promise(() => {})
        yield {}
      })(),
      output: new Promise(() => {}),
    })

    vi.useFakeTimers()
    const pending = chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: newSession() })
    await vi.advanceTimersByTimeAsync(15_000)
    const events = await pending

    expect(first(events, 'error')).toBeDefined()
  })
})
