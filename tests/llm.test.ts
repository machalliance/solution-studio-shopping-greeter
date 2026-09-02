import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IntentModel } from '../src/types/intent.js'

const { genText } = vi.hoisted(() => ({ genText: vi.fn() }))

vi.mock('ai', () => ({
  generateText: genText,
  // Output.object() is only a schema carrier here — generateText is mocked, so pass it through.
  Output: { object: (cfg: unknown) => cfg },
}))

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (cfg: unknown) => (id: string) => ({ provider: 'anthropic', id, cfg }),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (cfg: unknown) => (id: string) => ({ provider: 'openai', id, cfg }),
}))

const { ClaudeAdapter, OpenAIAdapter } = await import('../src/adapters/llm.js')

/** Every field any method reads off a generateText result, so one mock serves all callers. */
const GENERIC_RESULT = {
  text: '[]',
  output: {
    outfits: [],
    spec: [],
    roles: [],
    allocation: [],
    categories: ['top'],
    rationale: 'r',
    filterChips: ['a', 'b'],
  },
}

function intent(overrides: Partial<IntentModel> = {}): IntentModel {
  return {
    goal: 'rooftop dinner in Lisbon',
    goalType: 'style',
    constraints: {},
    sessionId: 's1',
    ...overrides,
  }
}

/** The single argument generateText was called with, for call index `i`. */
function callArgs(i = 0): any {
  return genText.mock.calls[i][0]
}

beforeEach(() => {
  genText.mockReset()
  genText.mockResolvedValue(GENERIC_RESULT)
  vi.stubEnv('LLM_CLAUDE_CHAT', undefined)
  vi.stubEnv('LLM_CLAUDE_FAST', undefined)
  vi.stubEnv('LLM_OPENAI_CHAT', undefined)
  vi.stubEnv('LLM_OPENAI_FAST', undefined)
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ClaudeAdapter model routing', () => {
  it('routes chat/spec/curation to their own overrides and every other task to the fast model', () => {
    const a = new ClaudeAdapter()
    expect(a.getModel('chat')).toEqual({ provider: 'anthropic', id: 'anthropic/claude-sonnet-4-6', cfg: expect.anything() })
    expect(a.getModel('spec')).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })
    expect(a.getModel('curation')).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })

    const fast = a.getModel('reply')
    for (const task of ['reply', 'extraction', 'refinements', 'rationale', 'allocation'] as const) {
      // the same shared instance, not a fresh model per call
      expect(a.getModel(task)).toBe(fast)
    }
    expect(fast).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })
  })

  it('takes chat/spec/curation model IDs from env vars, independently of each other', () => {
    vi.stubEnv('LLM_CLAUDE_CHAT', 'claude-opus-4-9')
    vi.stubEnv('LLM_CLAUDE_FAST', 'claude-haiku-9')
    const a = new ClaudeAdapter()
    expect(a.chatModelOverride).toBe('claude-opus-4-9')
    expect(a.specModelOverride).toBe('claude-haiku-9')
    expect(a.curationModelOverride).toBe('claude-haiku-9')
    expect(a.getModel('chat')).toMatchObject({ id: 'anthropic/claude-opus-4-9' })
    expect(a.getModel('rationale')).toMatchObject({ id: 'anthropic/claude-haiku-9' })
  })

  it('prefers an explicit constructor fast model over the env var', () => {
    vi.stubEnv('LLM_CLAUDE_FAST', 'from-env')
    const a = new ClaudeAdapter('from-arg')
    expect(a.getModel('extraction')).toMatchObject({ id: 'anthropic/from-arg' })
    expect(a.specModelOverride).toBe('from-arg')
  })

  it('honours a runtime override switch without disturbing the other tasks', () => {
    const a = new ClaudeAdapter()
    a.chatModelOverride = 'claude-experimental-1'
    a.curationModelOverride = 'claude-curator-1'
    expect(a.getModel('chat')).toMatchObject({ id: 'anthropic/claude-experimental-1' })
    expect(a.getModel('curation')).toMatchObject({ id: 'anthropic/claude-curator-1' })
    expect(a.getModel('spec')).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })
    expect(a.getModel('refinements')).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })
  })

  it('points the provider at the Vercel AI Gateway with the gateway key', () => {
    const a = new ClaudeAdapter()
    expect(a.getModel('chat')).toMatchObject({
      cfg: { apiKey: 'test-key', baseURL: 'https://ai-gateway.vercel.sh/v1' },
    })
  })
})

describe('OpenAIAdapter model routing', () => {
  it('uses the openai provider namespace and its own defaults', () => {
    const a = new OpenAIAdapter()
    expect(a.getModel('chat')).toMatchObject({ provider: 'openai', id: 'openai/gpt-4o' })
    expect(a.getModel('spec')).toMatchObject({ provider: 'openai', id: 'openai/gpt-4o-mini' })
    expect(a.getModel('curation')).toMatchObject({ id: 'openai/gpt-4o-mini' })
    expect(a.getModel('rationale')).toMatchObject({ id: 'openai/gpt-4o-mini' })
  })

  it('reads its own env vars and ignores the Claude ones', () => {
    vi.stubEnv('LLM_CLAUDE_CHAT', 'claude-should-be-ignored')
    vi.stubEnv('LLM_OPENAI_CHAT', 'gpt-5-preview')
    vi.stubEnv('LLM_OPENAI_FAST', 'gpt-5-mini')
    const a = new OpenAIAdapter()
    expect(a.chatModelOverride).toBe('gpt-5-preview')
    expect(a.getModel('chat')).toMatchObject({ id: 'openai/gpt-5-preview' })
    expect(a.getModel('allocation')).toMatchObject({ id: 'openai/gpt-5-mini' })
  })
})

describe('per-method model selection', () => {
  it('sends spec work to the spec model, curation to the curation model, and the rest to fast', async () => {
    const a = new ClaudeAdapter()
    a.specModelOverride = 'spec-model'
    a.curationModelOverride = 'curation-model'
    a.chatModelOverride = 'chat-model'
    const i = intent()

    await a.generateStyleSpec(i, ['top'])
    expect(callArgs(0).model).toMatchObject({ id: 'anthropic/spec-model' })

    await a.curateOutfits(i, 500, [{ category: 'top', products: [] }])
    expect(callArgs(1).model).toMatchObject({ id: 'anthropic/curation-model' })

    genText.mockResolvedValue({ ...GENERIC_RESULT, text: '["a"]' })
    await a.generateRefinements(i, ['top'])
    await a.generateCategoryMeta(i, 'top', ['Linen shirt'])
    await a.generateOverallSummary(i, ['top'])
    await a.generateCategories(i)
    await a.allocateBudget(400, ['top'], { top: { min: 10, max: 100, avg: 50 } })
    await a.assignCollageRoles(i, ['top'])
    for (const call of genText.mock.calls.slice(2)) {
      expect(call[0].model).toMatchObject({ id: 'anthropic/claude-haiku-4-5-20251001' })
    }
  })
})

describe('generateRefinements prompt', () => {
  it('injects the captured intent and the categories already in the list', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ ...GENERIC_RESULT, text: '["x"]' })
    await a.generateRefinements(
      intent({
        goal: 'powder room refresh',
        goalType: 'project',
        constraints: { style: 'modern farmhouse', budget: '2400', finish: 'matte black', colourDirection: 'warm neutrals' },
      }),
      ['vanity', 'faucet'],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Goal: powder room refresh')
    expect(prompt).toContain('Type: project')
    expect(prompt).toContain('Style: modern farmhouse')
    expect(prompt).toContain('Budget: $2400')
    expect(prompt).toContain('Finish: matte black')
    expect(prompt).toContain('Colour direction: warm neutrals')
    expect(prompt).toContain('Categories already in the curated list: vanity, faucet')
  })

  it('marks unknown constraints and an empty category list rather than printing undefined', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ ...GENERIC_RESULT, text: '["x"]' })
    await a.generateRefinements(intent(), [])
    const prompt: string = callArgs().prompt
    expect(prompt).not.toContain('undefined')
    expect(prompt).toContain('Style: not specified')
    expect(prompt).toContain('Budget: not specified')
    expect(prompt).toContain('Categories already in the curated list: none yet')
  })
})

describe('generateRefinements parsing and fallbacks', () => {
  const chips = (n: number) => Array.from({ length: n }, (_, k) => `chip ${k}`)

  it('returns at most 9 chips from a clean JSON array', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: `  ${JSON.stringify(chips(12))}  ` })
    const out = await a.generateRefinements(intent(), ['top'])
    expect(out).toHaveLength(9)
    expect(out[0]).toBe('chip 0')
    expect(out[8]).toBe('chip 8')
  })

  it('recovers quoted suggestions when the model wraps the array in prose or fences', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      text: 'Sure! Here you go:\n```json\n["Go bolder on the mirror", "Upscale the lighting"]\n```',
    })
    const out = await a.generateRefinements(intent(), ['mirror'])
    expect(out).toEqual(['Go bolder on the mirror', 'Upscale the lighting'])
  })

  it('caps the salvaged quoted strings at 9', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: `not json ${chips(12).map(c => `"${c}"`).join(' ')}` })
    const out = await a.generateRefinements(intent(), [])
    expect(out).toHaveLength(9)
    expect(out).not.toContain('chip 9')
  })

  it('falls back to fashion defaults when JSON parses but is not an array', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: '{"suggestions": ["nope"]}' })
    const out = await a.generateRefinements(intent({ goalType: 'style' }), ['top'])
    expect(out).toHaveLength(9)
    expect(out).toContain('Try a bolder colour')
    expect(out).toContain('Add a blazer')
    expect(out).not.toContain('Add heated flooring')
  })

  it('falls back to project defaults for a project goal when the text is unusable', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: 'I cannot help with that.' })
    const out = await a.generateRefinements(intent({ goalType: 'project' }), ['vanity'])
    expect(out).toHaveLength(9)
    expect(out).toContain('Change finish to matte black')
    expect(out).toContain('Add heated flooring')
    expect(out).not.toContain('Add a blazer')
  })

  it('surfaces a model error to the caller instead of masking it as suggestions', async () => {
    const a = new ClaudeAdapter()
    genText.mockRejectedValue(new Error('gateway 500'))
    await expect(a.generateRefinements(intent(), ['top'])).rejects.toThrow('gateway 500')
  })
})

describe('allocateBudget', () => {
  const stats = {
    jacket: { min: 100, max: 800, avg: 300 },
    top: { min: 40, max: 200, avg: 90 },
    shoes: { min: 80, max: 500, avg: 200 },
  }

  it('rounds the model numbers and raises anything below the category minimum', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: {
        allocation: [
          { category: 'jacket', maxPrice: 349.6 },
          { category: 'top', maxPrice: 5 },
          { category: 'shoes', maxPrice: 230.2 },
        ],
      },
    })
    const out = await a.allocateBudget(700, ['jacket', 'top', 'shoes'], stats)
    expect(out).toEqual({ jacket: 350, top: 40, shoes: 230 })
  })

  it('fills in a category the model omitted using the catalog maximum', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ output: { allocation: [{ category: 'jacket', maxPrice: 400 }] } })
    const out = await a.allocateBudget(700, ['jacket', 'top'], stats)
    expect(out).toEqual({ jacket: 400, top: 200 })
  })

  it('ignores categories the model invented and still covers one with no catalog stats', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: { allocation: [{ category: 'hat', maxPrice: 50 }] },
    })
    const out = await a.allocateBudget(700, ['scarf'], {})
    expect(out).toEqual({ scarf: 9999 })
  })

  it('tells the model when the cheapest possible basket already exceeds the budget', async () => {
    const a = new ClaudeAdapter()
    await a.allocateBudget(150, ['jacket', 'top', 'shoes'], stats)
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Sum of cheapest options: $220 — exceeds budget')
    expect(prompt).toContain('Total budget: $150')
    expect(prompt).toContain('- jacket: $100–$800 (avg $300)')
  })

  it('omits the exceeds-budget warning and flags categories missing a price range', async () => {
    const a = new ClaudeAdapter()
    await a.allocateBudget(1000, ['jacket', 'belt'], stats)
    const prompt: string = callArgs().prompt
    expect(prompt).not.toContain('exceeds budget')
    expect(prompt).toContain('- belt: unknown price range')
  })
})

describe('generateCategoryMeta', () => {
  it('keeps a rationale and chips from the model', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: { rationale: 'Look for breathable linens in neutral tones.', filterChips: ['Under $200', 'Natural linen'] },
    })
    const out = await a.generateCategoryMeta(intent(), 'top', ['Linen shirt'])
    expect(out).toEqual({
      rationale: 'Look for breathable linens in neutral tones.',
      filterChips: ['Under $200', 'Natural linen'],
    })
  })

  it('reports an empty rationale as undefined so the UI can omit the line', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ output: { rationale: '', filterChips: ['Under $200'] } })
    const out = await a.generateCategoryMeta(intent(), 'top', ['Linen shirt'])
    expect(out.rationale).toBeUndefined()
    expect(out.filterChips).toEqual(['Under $200'])
  })

  it('describes the style, finish and only the first four products in the prompt', async () => {
    const a = new ClaudeAdapter()
    await a.generateCategoryMeta(
      intent({ constraints: { style: 'coastal chic', finish: 'brushed brass' } }),
      'lighting',
      ['A', 'B', 'C', 'D', 'E'],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Style: coastal chic, preferably in brushed brass')
    expect(prompt).toContain('Products assembled: A, B, C, D')
    expect(prompt).not.toContain(', E')
  })

  it('falls back to a generic style label when none was captured', async () => {
    const a = new ClaudeAdapter()
    await a.generateCategoryMeta(intent(), 'top', [])
    expect(callArgs().prompt).toContain('Style: the chosen style.')
  })
})

describe('generateOverallSummary', () => {
  it('trims whitespace and strips wrapping quotes the model adds', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: '\n  "For a rooftop dinner, the jacket is your anchor."  \n' })
    const out = await a.generateOverallSummary(intent(), ['jacket'])
    expect(out).toBe('For a rooftop dinner, the jacket is your anchor.')
  })

  it('leaves interior quotes alone', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ text: 'Pick the "hero" piece first.' })
    expect(await a.generateOverallSummary(intent(), ['jacket'])).toBe('Pick the "hero" piece first.')
  })

  it('seeds the prompt with the goal and the assembled categories', async () => {
    const a = new ClaudeAdapter()
    await a.generateOverallSummary(intent({ goal: 'powder room refresh' }), ['vanity', 'mirror'])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('putting together: "powder room refresh"')
    expect(prompt).toContain('these categories: vanity, mirror')
    expect(prompt).toContain('opens with "For a powder room refresh,"')
  })
})

describe('generateStyleSpec', () => {
  it('keys the returned spec by category name', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: {
        spec: [
          { category: 'top', requiresAll: ['short-sleeve'], requiresAny: ['linen', 'cotton'], avoidances: ['wool'] },
          { category: 'shoes', requiresAll: [], requiresAny: ['loafer'], avoidances: [] },
        ],
      },
    })
    const out = await a.generateStyleSpec(intent(), ['top', 'shoes'])
    expect(out).toEqual({
      top: { requiresAll: ['short-sleeve'], requiresAny: ['linen', 'cotton'], avoidances: ['wool'] },
      shoes: { requiresAll: [], requiresAny: ['loafer'], avoidances: [] },
    })
  })

  it('gives the model fashion warmth rules for a style goal', async () => {
    const a = new ClaudeAdapter()
    await a.generateStyleSpec(
      intent({ constraints: { style: 'coastal chic', colourDirection: 'sand and navy', fit: 'slim', warmth: 'hot' } }),
      ['top', 'pants'],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Style: coastal chic | Colour direction: sand and navy | Fit: slim | Warmth/temperature: hot')
    expect(prompt).toContain('Categories needed: top, pants')
    expect(prompt).toContain('Fashion: coordinate requiresAny tags')
    expect(prompt).toContain('mock-neck')
    expect(prompt).not.toContain('If vanity is matte black')
  })

  it('gives the model home finish rules for a project goal', async () => {
    const a = new ClaudeAdapter()
    await a.generateStyleSpec(intent({ goalType: 'project' }), ['vanity'])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Home: coordinate finish/material tags')
    expect(prompt).not.toContain('Fashion: coordinate requiresAny tags')
    expect(prompt).toContain('Style: mixed')
  })

  it('passes global and per-category constraints through so style tags cannot contradict them', async () => {
    const a = new ClaudeAdapter()
    await a.generateStyleSpec(
      intent({
        constraints: {
          requiresTags: ['petite'],
          categoryConstraints: { top: { requiresTags: ['short-sleeve'], requiresAny: ['linen', 'cotton'], avoidances: ['wool'] } },
        },
      }),
      ['top'],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Global explicit constraints (apply to all categories): petite')
    expect(prompt).toContain('top: AND short-sleeve, OR linen, OR cotton, avoid wool')
  })
})

describe('curateOutfits', () => {
  const products = [
    { id: 'p1', name: 'Linen Blazer', brand: 'Sud', tags: ['linen', 'unstructured', 'sand', 'light', 'relaxed', 'sixth'], price: 320, currency: 'USD' },
    { id: 'p2', name: 'Cotton Overshirt', tags: ['cotton'], price: 180, currency: 'USD' },
  ]

  it('flattens each outfit slot array into a category to product-id map', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: {
        outfits: [
          { name: 'Coastal Evening Ease', rationale: 'Linen anchors it.', slots: [{ category: 'jacket', productId: 'p1' }, { category: 'top', productId: 'p2' }] },
          { name: 'Sharper Harbour Look', rationale: 'Cotton sharpens it.', slots: [{ category: 'jacket', productId: 'p2' }] },
        ],
      },
    })
    const out = await a.curateOutfits(intent(), 600, [{ category: 'jacket', products }])
    expect(out).toEqual([
      { name: 'Coastal Evening Ease', rationale: 'Linen anchors it.', slots: { jacket: 'p1', top: 'p2' } },
      { name: 'Sharper Harbour Look', rationale: 'Cotton sharpens it.', slots: { jacket: 'p2' } },
    ])
  })

  it('states a finite budget and asks for outfits on a style goal', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(intent(), 600, [{ category: 'jacket', products }])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Total budget: $600')
    expect(prompt).toContain('curating outfit combinations')
  })

  it('says there is no budget limit for an unbounded budget, and curates products for a project goal', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(intent({ goalType: 'project' }), Infinity, [{ category: 'vanity', products }])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('No set budget limit')
    expect(prompt).not.toContain('Total budget: $')
    expect(prompt).toContain('curating product combinations')
  })

  it('lists at most ten products per category with at most five tags each', async () => {
    const a = new ClaudeAdapter()
    const many = Array.from({ length: 12 }, (_, k) => ({ id: `x${k}`, name: `Item ${k}`, tags: ['t'], price: 10, currency: 'USD' }))
    await a.curateOutfits(intent(), 600, [{ category: 'jacket', products: [...products, ...many] }])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('id:"x7"')
    expect(prompt).not.toContain('id:"x9"')
    expect(prompt).toContain('[Sud] "Linen Blazer"')
    expect(prompt).toContain('tags:linen,unstructured,sand,light,relaxed |')
    expect(prompt).not.toContain('sixth')
  })

  it('names the shopper anchor items so the look is built around what they already own', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(
      intent({ anchorItems: [{ name: 'Cream chinos', description: 'slim, cropped' }, { name: 'Tan loafers' }] }),
      600,
      [{ category: 'jacket', products }],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Anchor items (user already owns these — build around them): Cream chinos (slim, cropped), Tan loafers')
  })

  it('replays previous looks by product name and adds the continuity rule', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(intent(), 600, [{ category: 'jacket', products }], [
      { name: 'Coastal Evening Ease', slots: { jacket: 'p1', shoes: 'gone-from-catalog' } },
    ])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('- "Coastal Evening Ease": jacket="Linen Blazer", shoes="gone-from-catalog"')
    expect(prompt).toContain('- CONTINUITY:')
  })

  it('omits the continuity rule on a first curation', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(intent(), 600, [{ category: 'jacket', products }])
    const prompt: string = callArgs().prompt
    expect(prompt).not.toContain('CONTINUITY')
    expect(prompt).not.toContain('Previously shown looks')
  })

  it('repeats explicit shopper constraints as must-honour rules', async () => {
    const a = new ClaudeAdapter()
    await a.curateOutfits(
      intent({ constraints: { categoryConstraints: { top: { requiresTags: ['short-sleeve'], avoidances: ['wool'] } } } }),
      600,
      [{ category: 'top', products }],
    )
    const prompt: string = callArgs().prompt
    expect(prompt).toContain("Shopper's explicit constraints (must be honoured in EVERY outfit):")
    expect(prompt).toContain('- top: must include "short-sleeve", avoid "wool"')
  })
})

describe('assignCollageRoles', () => {
  it('keys roles and weights by category', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({
      output: {
        roles: [
          { category: 'jacket', displayRole: 'hero', weight: 8 },
          { category: 'belt', displayRole: 'accent', weight: 2 },
        ],
      },
    })
    const out = await a.assignCollageRoles(intent(), ['jacket', 'belt'])
    expect(out).toEqual({
      jacket: { displayRole: 'hero', weight: 8 },
      belt: { displayRole: 'accent', weight: 2 },
    })
  })

  it('lists every category the collage needs a role for', async () => {
    const a = new ClaudeAdapter()
    await a.assignCollageRoles(intent({ goal: 'powder room refresh' }), ['vanity', 'mirror', 'hardware'])
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Categories: vanity, mirror, hardware')
    expect(prompt).toContain('Goal: "powder room refresh"')
  })
})

describe('generateCategories', () => {
  it('returns the categories the model committed to', async () => {
    const a = new ClaudeAdapter()
    genText.mockResolvedValue({ output: { categories: ['jacket', 'top', 'shoes'] } })
    expect(await a.generateCategories(intent())).toEqual(['jacket', 'top', 'shoes'])
  })

  it('shows the model the goal type and everything captured so far', async () => {
    const a = new ClaudeAdapter()
    await a.generateCategories(intent({ goal: 'beach wedding guest', constraints: { style: 'coastal chic', budget: '900' } }))
    const prompt: string = callArgs().prompt
    expect(prompt).toContain('Goal: "beach wedding guest" (style)')
    expect(prompt).toContain('Captured so far: {"style":"coastal chic","budget":"900"}')
    expect(prompt).toContain('AVAILABLE CATEGORIES')
  })

  it('propagates a model failure so the caller can fall back', async () => {
    const a = new ClaudeAdapter()
    genText.mockRejectedValue(new Error('schema validation failed'))
    await expect(a.generateCategories(intent())).rejects.toThrow('schema validation failed')
  })
})
