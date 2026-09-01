import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { CategoryResult, IntentModel, SearchResult } from '../src/types/intent.js'
import type { SearchParams } from '../src/types/search.js'

// The LLM adapter is the only non-deterministic dependency in the assembly path, so it is
// replaced wholesale. Search + CMS run against the real fixture adapters.
const mocks = vi.hoisted(() => ({
  generateStyleSpec: vi.fn(),
  allocateBudget: vi.fn(),
  generateCategoryMeta: vi.fn(),
  generateOverallSummary: vi.fn(),
  generateRefinements: vi.fn(),
  assignCollageRoles: vi.fn(),
  curateOutfits: vi.fn(),
  getModel: vi.fn(),
}))

vi.mock('../src/adapters/llm.js', () => {
  class FakeAdapter {
    constructor() { Object.assign(this, mocks) }
  }
  return { ClaudeAdapter: FakeAdapter, OpenAIAdapter: FakeAdapter }
})

const { app, assembleResults, buildCuratedOutfits, parseBudgetUpperBound } = await import('../src/server.js')
const { FixtureSearchAdapter } = await import('../src/adapters/search.js')

let sessionCounter = 0
function intentOf(constraints: IntentModel['constraints'] = {}): IntentModel {
  sessionCounter += 1
  return {
    goal: 'weekend trip',
    goalType: 'style',
    constraints,
    sessionId: `session-${sessionCounter}`,
  }
}

function product(id: string, price: number, category = 'top'): SearchResult {
  return {
    id, name: `Product ${id}`, price, currency: 'USD', category,
    images: [], url: `/p/${id}`, tags: [], inStock: true,
  }
}

function categoryResult(name: string, products: SearchResult[], scrollProducts: SearchResult[] = []): CategoryResult {
  return {
    name, displayName: name, displayRole: 'supporting', weight: 5,
    products, scrollProducts, cmsContent: [], showAllUrl: `/search?q=${name}`,
  }
}

// Only the per-category product searches (limit 10); excludes the limit-200 catalog-stats
// sweep that runs on its own schedule at startup.
function searchCalls(spy: { mock: { calls: unknown[][] } }): SearchParams[] {
  return (spy.mock.calls.map(c => c[0]) as SearchParams[]).filter(p => p.limit === 10)
}

beforeEach(() => {
  mocks.generateStyleSpec.mockReset().mockResolvedValue({})
  mocks.allocateBudget.mockReset().mockResolvedValue({})
  mocks.generateCategoryMeta.mockReset().mockResolvedValue({ rationale: 'because it works', filterChips: [] })
  mocks.generateOverallSummary.mockReset().mockResolvedValue('')
  mocks.generateRefinements.mockReset().mockResolvedValue([])
  mocks.assignCollageRoles.mockReset().mockResolvedValue({})
  mocks.curateOutfits.mockReset().mockResolvedValue([])
})

describe('parseBudgetUpperBound', () => {
  it('takes the number out of an "Under $N" label', () => {
    expect(parseBudgetUpperBound('Under $500')).toBe(500)
  })

  it('takes the upper end of a range, comma-separated or en-dashed', () => {
    expect(parseBudgetUpperBound('$400-$800')).toBe(800)
    expect(parseBudgetUpperBound('$1,000–$2,500')).toBe(2500)
  })

  it('treats "no set limit" phrasing as unbounded', () => {
    expect(parseBudgetUpperBound('No set limit')).toBe(Infinity)
    expect(parseBudgetUpperBound('no limit')).toBe(Infinity)
  })

  it('treats an "Over $N" label as unbounded rather than capping at N', () => {
    // "Over $5,000" contains a number, but it is a floor, not a ceiling — reading it as a
    // maximum would filter the shopper's whole catalog down to the cheapest items.
    expect(parseBudgetUpperBound('Over $5,000')).toBe(Infinity)
  })

  it('is unbounded for missing or non-string budgets', () => {
    expect(parseBudgetUpperBound(undefined)).toBe(Infinity)
    expect(parseBudgetUpperBound(null)).toBe(Infinity)
    expect(parseBudgetUpperBound('')).toBe(Infinity)
    expect(parseBudgetUpperBound(500)).toBe(Infinity)
    expect(parseBudgetUpperBound({ max: 500 })).toBe(Infinity)
    expect(parseBudgetUpperBound(['$500'])).toBe(Infinity)
  })

  it('is unbounded for text carrying no number', () => {
    expect(parseBudgetUpperBound('budget friendly')).toBe(Infinity)
  })
})

describe('assembleResults', () => {
  beforeAll(async () => {
    // Catalog stats are built by a floating promise at import time; force a deterministic
    // rebuild so the budget-allocation branch is reachable regardless of timing.
    await app.request('/api/catalog-stats/refresh', { method: 'POST' })
  })

  it('returns one result per requested category, in the requested order', async () => {
    const res = await assembleResults(intentOf(), ['shoes', 'top', 'pants'])
    expect(res.map(r => r.name)).toEqual(['shoes', 'top', 'pants'])
    for (const cat of res) {
      expect(cat.products.length).toBeGreaterThan(0)
      expect(cat.products.every(p => p.category === cat.name)).toBe(true)
    }
  })

  it('shows at most 4 cards per row and puts the remainder in the scroll strip', async () => {
    const [top] = await assembleResults(intentOf(), ['top'])
    expect(top.products).toHaveLength(4)
    expect(top.scrollProducts.length).toBeGreaterThan(0)
    const ids = [...top.products, ...top.scrollProducts].map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('assembles every category concurrently rather than one after another', async () => {
    // Each category's meta call blocks until ALL of them have started. If assembly were
    // sequential the first call would never be released and this test would time out.
    const categories = ['top', 'pants', 'shoes']
    let started = 0
    let release!: () => void
    const allStarted = new Promise<void>(resolve => { release = resolve })
    mocks.generateCategoryMeta.mockImplementation(async () => {
      started += 1
      if (started === categories.length) release()
      await allStarted
      return { rationale: 'r', filterChips: [] }
    })

    const res = await assembleResults(intentOf(), categories)
    expect(res).toHaveLength(3)
    expect(started).toBe(3)
  })

  it('applies the LLM per-category budget allocation instead of the flat budget cap', async () => {
    mocks.allocateBudget.mockResolvedValue({ shoes: 100, top: 80 })
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

    const res = await assembleResults(intentOf({ budget: 'Under $2,000' }), ['shoes', 'top'])

    const firstCall = (cat: string) => searchCalls(querySpy).find(p => p.category === cat)!
    expect(firstCall('shoes').facets.maxPrice).toBe(100)
    expect(firstCall('top').facets.maxPrice).toBe(80)
    // And the allocation actually constrains what the shopper is shown — neither category
    // gets the flat $2,000 cap.
    expect(res.find(r => r.name === 'shoes')!.products.every(p => p.price <= 100)).toBe(true)
    expect(res.find(r => r.name === 'top')!.products.every(p => p.price <= 80)).toBe(true)
    querySpy.mockRestore()
  })

  it('retries the search without maxPrice when the budget filter starves a category', async () => {
    // Under $20 matches nothing in any fixture category — without the retry the shopper
    // gets an empty shopping-list row.
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

    const res = await assembleResults(intentOf({ budget: 'Under $20' }), ['shoes'])

    const shoesCalls = searchCalls(querySpy).filter(p => p.category === 'shoes')
    expect(shoesCalls).toHaveLength(2)
    expect(shoesCalls[0].facets.maxPrice).toBe(20)
    expect(shoesCalls[1].facets.maxPrice).toBeUndefined()
    expect(res[0].products.length).toBeGreaterThan(0)
    expect(res[0].products.some(p => p.price > 20)).toBe(true)
    querySpy.mockRestore()
  })

  // Retry 1 proves maxPrice is starving the row. Every later retry must therefore keep the
  // price filter off — re-applying it re-creates the exact starvation retry 1 just escaped.
  it('keeps the budget filter off for every retry after the budget retry', async () => {
    mocks.generateStyleSpec.mockResolvedValue({
      shoes: { requiresAll: [], requiresAny: ['no-such-tag-anywhere'], avoidances: [] },
    })
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

    // `style` is what gates spec generation (hasSpecSignal), which is what arms retries 2-5.
    await assembleResults(intentOf({ budget: 'Under $20', style: 'Coastal' }), ['shoes'])

    const shoesCalls = searchCalls(querySpy).filter(p => p.category === 'shoes')
    expect(shoesCalls.length).toBeGreaterThan(2)
    // Only the very first query may carry maxPrice.
    for (const call of shoesCalls.slice(1)) {
      expect(call.facets.maxPrice).toBeUndefined()
    }
    querySpy.mockRestore()
  })

  // The retries relax progressively, but a later, looser query can still return FEWER results
  // than an earlier one (it re-queries with a different tag set, not a superset). Overwriting
  // unconditionally throws away products the assembler already had in hand and ships an empty
  // shopping-list row instead.
  it('never ends up with fewer products than an earlier retry already found', async () => {
    mocks.generateStyleSpec.mockResolvedValue({
      shoes: { requiresAll: [], requiresAny: ['loafer'], avoidances: [] },
    })
    const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

    const res = await assembleResults(intentOf({ budget: 'Under $60', style: 'Coastal' }), ['shoes'])

    const counts: number[] = []
    for (const call of searchCalls(querySpy).filter(p => p.category === 'shoes')) {
      counts.push((await new FixtureSearchAdapter().query(call)).length)
    }
    const bestAvailable = Math.max(...counts)
    expect(bestAvailable).toBeGreaterThan(0)
    expect(res[0].products.length + res[0].scrollProducts.length).toBe(bestAvailable)
    querySpy.mockRestore()
  })

  // The default beforeEach stubs generateStyleSpec to {}, which makes the whole spec-composition
  // block below a no-op. These tests supply a real spec so the tags actually handed to the search
  // adapter are asserted — that composition is what turns a style choice into products.
  describe('constraint composition handed to the search adapter', () => {
    const firstShoesCall = (spy: Parameters<typeof searchCalls>[0]) =>
      searchCalls(spy).find(p => p.category === 'shoes')!

    it('merges global, per-category and spec constraints into one query', async () => {
      mocks.generateStyleSpec.mockResolvedValue({
        shoes: { requiresAll: ['spec-all'], requiresAny: ['spec-any'], avoidances: ['spec-avoid'] },
      })
      const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

      await assembleResults(intentOf({
        style: 'Coastal',
        requiresTags: ['global-tag'],
        avoidances: ['global-avoid'],
        categoryConstraints: { shoes: { avoidances: ['cat-avoid'] } },
      }), ['shoes'])

      const call = firstShoesCall(querySpy)
      expect(call.requiresAll).toEqual(['global-tag', 'spec-all'])
      expect(call.avoidances).toEqual(['global-avoid', 'cat-avoid', 'spec-avoid'])
      expect(call.requiresAny).toEqual(['spec-any'])
      querySpy.mockRestore()
    })

    // The shopper's own hard AND constraint must not be diluted by the style model's OR tags,
    // but their own OR alternatives ("jeans or chinos") always survive.
    it('suppresses the spec OR tags when the shopper set a hard tag for that category', async () => {
      mocks.generateStyleSpec.mockResolvedValue({
        shoes: { requiresAll: [], requiresAny: ['spec-any'], avoidances: [] },
      })
      const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

      await assembleResults(intentOf({
        style: 'Coastal',
        categoryConstraints: { shoes: { requiresTags: ['leather'], requiresAny: ['loafer', 'boot'] } },
      }), ['shoes'])

      const call = firstShoesCall(querySpy)
      expect(call.requiresAll).toEqual(['leather'])
      expect(call.requiresAny).toEqual(['loafer', 'boot'])
      expect(call.requiresAny).not.toContain('spec-any')
      querySpy.mockRestore()
    })

    it('keeps the spec OR tags alongside the shopper\'s own alternatives when no hard tag is set', async () => {
      mocks.generateStyleSpec.mockResolvedValue({
        shoes: { requiresAll: [], requiresAny: ['spec-any'], avoidances: [] },
      })
      const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

      await assembleResults(intentOf({
        style: 'Coastal',
        categoryConstraints: { shoes: { requiresAny: ['loafer'] } },
      }), ['shoes'])

      expect(firstShoesCall(querySpy).requiresAny).toEqual(['loafer', 'spec-any'])
      querySpy.mockRestore()
    })

    it('proceeds with no spec constraints when the spec LLM fails', async () => {
      mocks.generateStyleSpec.mockRejectedValue(new Error('spec down'))
      const querySpy = vi.spyOn(FixtureSearchAdapter.prototype, 'query')

      const res = await assembleResults(intentOf({ style: 'Coastal' }), ['shoes'])

      const call = firstShoesCall(querySpy)
      expect(call.requiresAll).toEqual([])
      expect(call.requiresAny).toEqual([])
      expect(res[0].products.length).toBeGreaterThan(0)
      querySpy.mockRestore()
    })
  })

  // A row with no products renders as a blank tile, so an unmatched category must not survive
  // assembly. Dropping it here is also what lets the callers' "no results" fallback fire at all —
  // the row count previously equalled the requested category count no matter what was found.
  it('drops a category that matched no products', async () => {
    const res = await assembleResults(intentOf(), ['top', 'trousers'])
    expect(res.map(r => r.name)).toEqual(['top'])
  })

  it('returns nothing when no requested category matched', async () => {
    expect(await assembleResults(intentOf(), ['trousers', 'also-not-real'])).toEqual([])
  })

  it('keeps every category that did match', async () => {
    const res = await assembleResults(intentOf(), ['top', 'shoes'])
    expect(res.map(r => r.name)).toEqual(['top', 'shoes'])
  })

  it('applies the LLM collage roles and falls back to supporting/5 for unassigned categories', async () => {
    mocks.assignCollageRoles.mockResolvedValue({ shoes: { displayRole: 'hero', weight: 9 } })
    const res = await assembleResults(intentOf(), ['shoes', 'top'])
    expect(res[0]).toMatchObject({ name: 'shoes', displayRole: 'hero', weight: 9 })
    expect(res[1]).toMatchObject({ name: 'top', displayRole: 'supporting', weight: 5 })
  })

  it('still returns products when the rationale and role LLM calls fail', async () => {
    mocks.generateCategoryMeta.mockRejectedValue(new Error('llm down'))
    mocks.assignCollageRoles.mockRejectedValue(new Error('llm down'))
    const res = await assembleResults(intentOf(), ['pants'])
    expect(res).toHaveLength(1)
    expect(res[0].products.length).toBeGreaterThan(0)
    expect(res[0].rationale).toBeUndefined()
    expect(res[0].filterChips).toEqual([])
    expect(res[0].displayRole).toBe('supporting')
  })
})

describe('buildCuratedOutfits', () => {
  const cats = [
    categoryResult('top', [product('top-a', 50), product('top-b', 60)]),
    categoryResult('pants', [product('pants-a', 90, 'pants')], [product('pants-b', 30, 'pants')]),
  ]

  it('resolves curated slot ids to real products and totals their prices', async () => {
    mocks.curateOutfits.mockResolvedValue([
      { name: 'Weekend', rationale: 'easy pairing', slots: { top: 'top-b', pants: 'pants-b' } },
    ])
    const [outfit] = await buildCuratedOutfits(intentOf(), cats)
    expect(outfit.name).toBe('Weekend')
    expect(outfit.rationale).toBe('easy pairing')
    expect(outfit.items.map(i => i.product.id)).toEqual(['top-b', 'pants-b'])
    expect(outfit.totalPrice).toBe(90)
  })

  it('fills a missing or unknown slot with the category\'s top product', async () => {
    mocks.curateOutfits.mockResolvedValue([
      { name: 'Partial', rationale: '', slots: { pants: 'does-not-exist' } },
    ])
    const [outfit] = await buildCuratedOutfits(intentOf(), cats)
    expect(outfit.items.map(i => i.category)).toEqual(['top', 'pants'])
    expect(outfit.items.map(i => i.product.id)).toEqual(['top-a', 'pants-a'])
    expect(outfit.totalPrice).toBe(140)
  })

  // The slot id comes from the curation LLM and is resolved against a lookup spanning every
  // category, so a cross-category id would otherwise render a pair of pants in the top slot —
  // an outfit with two pairs of pants and no shirt, on screen.
  it('ignores a slot id belonging to a different category and uses that category\'s own product', async () => {
    mocks.curateOutfits.mockResolvedValue([
      { name: 'Confused', rationale: '', slots: { top: 'pants-b', pants: 'pants-a' } },
    ])
    const [outfit] = await buildCuratedOutfits(intentOf(), cats)
    const top = outfit.items.find(i => i.category === 'top')!
    expect(top.product.id).toBe('top-a')
    expect(top.product.category).toBe('top')
    expect(outfit.items.map(i => i.product.id)).toEqual(['top-a', 'pants-a'])
  })

  it('stays on-budget just below the 1.40x threshold', async () => {
    const c = [categoryResult('top', [product('top-a', 139.99)])]
    mocks.curateOutfits.mockResolvedValue([{ name: 'A', rationale: '', slots: { top: 'top-a' } }])
    const [outfit] = await buildCuratedOutfits(intentOf({ budget: 'Under $100' }), c)
    expect(outfit.totalPrice).toBe(139.99)
    expect(outfit.budgetStatus).toBe('on-budget')
  })

  it('stays on-budget exactly at the 1.40x threshold', async () => {
    const c = [categoryResult('top', [product('top-a', 100)]), categoryResult('pants', [product('pants-a', 40, 'pants')])]
    mocks.curateOutfits.mockResolvedValue([{ name: 'A', rationale: '', slots: {} }])
    const [outfit] = await buildCuratedOutfits(intentOf({ budget: 'Under $100' }), c)
    expect(outfit.totalPrice).toBe(140)
    expect(outfit.budgetStatus).toBe('on-budget')
  })

  it('flips to aspirational above the 1.40x threshold', async () => {
    const c = [categoryResult('top', [product('top-a', 140.5)])]
    mocks.curateOutfits.mockResolvedValue([{ name: 'A', rationale: '', slots: { top: 'top-a' } }])
    const [outfit] = await buildCuratedOutfits(intentOf({ budget: 'Under $100' }), c)
    expect(outfit.budgetStatus).toBe('aspirational')
  })

  it('never marks an outfit aspirational when the shopper set no budget', async () => {
    const c = [categoryResult('top', [product('top-a', 9999)])]
    mocks.curateOutfits.mockResolvedValue([{ name: 'A', rationale: '', slots: { top: 'top-a' } }])
    const [outfit] = await buildCuratedOutfits(intentOf({ budget: 'No set limit' }), c)
    expect(outfit.totalPrice).toBe(9999)
    expect(outfit.budgetStatus).toBe('on-budget')
  })

  it('falls back to index pairing when curation returns nothing', async () => {
    mocks.curateOutfits.mockResolvedValue([])
    const c = [
      categoryResult('top', [product('top-1', 10), product('top-2', 20)]),
      categoryResult('pants', [product('pants-1', 30, 'pants'), product('pants-2', 40, 'pants')]),
    ]
    const outfits = await buildCuratedOutfits(intentOf(), c)
    expect(outfits).toHaveLength(2)
    expect(outfits[0].items.map(i => i.product.id)).toEqual(['top-1', 'pants-1'])
    expect(outfits[1].items.map(i => i.product.id)).toEqual(['top-2', 'pants-2'])
    expect(outfits.map(o => o.totalPrice)).toEqual([40, 60])
  })

  it('caps the fallback at 3 outfits and skips categories with nothing at that index', async () => {
    mocks.curateOutfits.mockResolvedValue([])
    const c = [
      categoryResult('top', [product('t1', 10), product('t2', 10), product('t3', 10), product('t4', 10), product('t5', 10)]),
      categoryResult('pants', [product('p1', 20, 'pants'), product('p2', 20, 'pants')]),
    ]
    const outfits = await buildCuratedOutfits(intentOf(), c)
    expect(outfits).toHaveLength(3)
    expect(outfits.map(o => o.items.length)).toEqual([2, 2, 1])
    expect(outfits[2].items.map(i => i.product.id)).toEqual(['t3'])
    expect(outfits[2].totalPrice).toBe(10)
  })

  it('falls back when curation throws instead of surfacing the error', async () => {
    mocks.curateOutfits.mockRejectedValue(new Error('curation blew up'))
    const outfits = await buildCuratedOutfits(intentOf(), cats)
    expect(outfits.length).toBeGreaterThan(0)
    expect(outfits[0].items.map(i => i.product.id)).toEqual(['top-a', 'pants-a'])
  })

  it('returns no outfit at all rather than an empty one when no category has products', async () => {
    mocks.curateOutfits.mockResolvedValue([{ name: 'Ghost', rationale: '', slots: { top: 'nope' } }])
    const outfits = await buildCuratedOutfits(intentOf(), [categoryResult('top', []), categoryResult('pants', [])])
    expect(outfits).toEqual([])
  })

  it('feeds the previous turn\'s outfits back into the next curation for the same session', async () => {
    mocks.curateOutfits.mockResolvedValue([
      { name: 'Turn one', rationale: 'x', slots: { top: 'top-a', pants: 'pants-a' } },
    ])
    const intent = intentOf()
    await buildCuratedOutfits(intent, cats)
    await buildCuratedOutfits(intent, cats)
    expect(mocks.curateOutfits.mock.calls[0][3]).toBeUndefined()
    expect(mocks.curateOutfits.mock.calls[1][3]).toEqual([
      { name: 'Turn one', slots: { top: 'top-a', pants: 'pants-a' } },
    ])
  })
})
