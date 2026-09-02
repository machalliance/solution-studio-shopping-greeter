import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SearchParams } from '../src/types/search.js'

// A synthetic fixture is needed for the "hit has no style at all" branch: every product in
// catalog/fixtures currently carries a style, so the null-safe rule is unreachable from disk.
// node:fs is only intercepted for this one filename — every other read hits the real fixtures.
const { STYLELESS_FIXTURE } = vi.hoisted(() => ({
  STYLELESS_FIXTURE: {
    hits: [
      { objectID: 'x-1', name: 'No Style Sconce', price: 10, currency: 'USD', category: 'styleless', tags: [], images: [], url: '/p/x1', inStock: true },
      { objectID: 'x-2', name: 'Scandi Sconce', style: 'scandi', price: 20, currency: 'USD', category: 'styleless', tags: [], images: [], url: '/p/x2', inStock: true },
      { objectID: 'x-3', name: 'Coastal Sconce', style: 'coastal', price: 30, currency: 'USD', category: 'styleless', tags: [], images: [], url: '/p/x3', inStock: true },
    ],
    nbHits: 3, page: 0, nbPages: 1, hitsPerPage: 20, processingTimeMS: 1, query: '',
  },
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('algolia-styleless.json')) {
        return JSON.stringify(STYLELESS_FIXTURE)
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    },
  }
})

const { FixtureSearchAdapter, AlgoliaAdapter } = await import('../src/adapters/search.js')

const params = (over: Partial<SearchParams> & { category: string }): SearchParams => ({
  facets: {},
  limit: 50,
  ...over,
})

const ids = (rows: { id: string }[]) => rows.map(r => r.id)

describe('FixtureSearchAdapter — catalogue loading', () => {
  it('returns no results for a category with no fixture file instead of throwing', async () => {
    const adapter = new FixtureSearchAdapter()
    await expect(adapter.query(params({ category: 'spaceship' }))).resolves.toEqual([])
  })

  // Category is free-form LLM output reaching a bare readFileSync(join(FIXTURES_DIR, ...)) — an
  // unsanitised "../../../../package" would resolve outside FIXTURES_DIR and read whatever sits
  // at that path. Path-separator and traversal characters are stripped before the file lookup,
  // so this just misses like any other unknown category, never reaches outside the fixtures dir.
  it('does not let a path-traversal category escape the fixtures directory', async () => {
    const adapter = new FixtureSearchAdapter()
    await expect(adapter.query(params({ category: '../../../../package' }))).resolves.toEqual([])
  })

  it('resolves the fixture file case- and whitespace-insensitively', async () => {
    const adapter = new FixtureSearchAdapter()
    const upper = await adapter.query(params({ category: 'LIGHTING' }))
    const lower = await adapter.query(params({ category: 'lighting' }))
    expect(ids(upper)).toEqual(['lighting-001', 'lighting-002', 'lighting-003', 'lighting-004', 'lighting-005', 'lighting-006'])
    expect(ids(lower)).toEqual(ids(upper))
  })

  // Categories originate as free-form LLM output, so stray padding is reachable. Untrimmed,
  // " lighting " normalises to "-lighting-", misses the file, and caches the miss — a whole
  // product row silently empty.
  it.each([' lighting', 'lighting ', '  lighting  ', '\tlighting\n'])(
    'resolves the fixture file for a padded category %j', async category => {
      const adapter = new FixtureSearchAdapter()
      const padded = await adapter.query(params({ category }))
      expect(ids(padded)).toEqual(ids(await adapter.query(params({ category: 'lighting' }))))
      expect(padded.length).toBeGreaterThan(0)
    })

  it('caches unfiltered hits, so a narrow query does not shrink a later broad one', async () => {
    const adapter = new FixtureSearchAdapter()
    const narrow = await adapter.query(params({ category: 'lighting', facets: { style: 'coastal' } }))
    const broad = await adapter.query(params({ category: 'lighting' }))
    expect(ids(narrow)).toEqual(['lighting-004', 'lighting-005', 'lighting-006'])
    expect(broad).toHaveLength(6)
  })
})

describe('FixtureSearchAdapter — result shaping', () => {
  it('exposes only the SearchResult fields, dropping internal fixture-only copy', async () => {
    const adapter = new FixtureSearchAdapter()
    const [first] = await adapter.query(params({ category: 'top', limit: 1 }))
    expect(first).toEqual({
      id: 'top-001',
      name: 'Linen Shirt — Cream',
      brand: 'Loro Piana',
      price: 195,
      currency: 'USD',
      category: 'top',
      colourHex: '#F5F0E6',
      images: ['/images/top-001.jpg'],
      url: '/products/linen-shirt-cream',
      tags: ['linen-shirt', 'cream', 'relaxed', 'elevated', 'lightweight'],
      rationale: undefined,
      inStock: true,
    })
    // description / imagePrompt / finish / colourFamily / style / fit must not leak downstream
    expect(Object.keys(first).sort()).toEqual(
      ['brand', 'category', 'colourHex', 'currency', 'id', 'images', 'inStock', 'name', 'price', 'rationale', 'tags', 'url'],
    )
  })

  it('caps results at the requested limit, preserving catalogue order', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'pants', limit: 3 }))
    expect(ids(rows)).toEqual(['pants-001', 'pants-002', 'pants-003'])
  })
})

describe('FixtureSearchAdapter — facet filters', () => {
  it('excludes products whose style disagrees with the requested style', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'lighting', facets: { style: 'scandi' } }))
    expect(ids(rows)).toEqual(['lighting-001', 'lighting-002', 'lighting-003'])
  })

  it('matches styles across spacing/hyphenation differences', async () => {
    const adapter = new FixtureSearchAdapter()
    const spaced = await adapter.query(params({ category: 'top', facets: { style: 'smart casual' } }))
    const hyphenated = await adapter.query(params({ category: 'top', facets: { style: 'smart-casual' } }))
    expect(spaced).toHaveLength(27)
    expect(ids(spaced)).toEqual(ids(hyphenated))
    expect(ids(spaced)).not.toContain('top-026')
  })

  it('keeps style-less products under a style filter rather than dropping them', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'styleless', facets: { style: 'scandi' } }))
    expect(ids(rows)).toEqual(['x-1', 'x-2'])
  })

  it('keeps unisex products alongside the requested fit and excludes the other fit', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'shoes', facets: { fit: 'mens' } }))
    expect(ids(rows)).toEqual([
      'shoes-001', 'shoes-002', 'shoes-003', 'shoes-007', 'shoes-008',
      'shoes-009', 'shoes-010', 'shoes-014', 'shoes-015', 'shoes-016', 'shoes-017',
    ])
  })

  it('keeps fit-less products (home goods) under a garment fit filter', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'lighting', facets: { fit: 'womens' } }))
    expect(rows).toHaveLength(6)
  })

  it('treats maxPrice as an inclusive ceiling', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'pants', facets: { maxPrice: 125 } }))
    expect(rows).toHaveLength(11)
    expect(ids(rows)).toContain('pants-009') // priced at exactly 125
    expect(rows.every(r => r.price <= 125)).toBe(true)
  })

  it('composes category, style, fit and budget into a single narrowed set', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({
      category: 'top',
      facets: { style: 'casual', fit: 'womens', maxPrice: 80 },
    }))
    expect(ids(rows)).toEqual(['top-029', 'top-030', 'top-032'])
  })
})

describe('FixtureSearchAdapter — tag filters', () => {
  it('requiresAll is AND: a product matching only one required term is excluded', async () => {
    const adapter = new FixtureSearchAdapter()
    const linen = await adapter.query(params({ category: 'top', requiresAll: ['linen'] }))
    const shortSleeve = await adapter.query(params({ category: 'top', requiresAll: ['short-sleeve'] }))
    const both = await adapter.query(params({ category: 'top', requiresAll: ['linen', 'short-sleeve'] }))
    expect(ids(linen)).toEqual(['top-001', 'top-004', 'top-006', 'top-017', 'top-020', 'top-025', 'top-031'])
    expect(ids(shortSleeve)).toEqual(['top-013', 'top-018', 'top-019', 'top-023'])
    expect(both).toEqual([])
  })

  it('requiresAny is OR: the union of the individual term matches', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'top', requiresAny: ['linen', 'short-sleeve'] }))
    expect(ids(rows)).toEqual([
      'top-001', 'top-004', 'top-006', 'top-013', 'top-017', 'top-018',
      'top-019', 'top-020', 'top-023', 'top-025', 'top-031',
    ])
  })

  it('matches a hyphenated tag against a spaced request and against the product name', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'pants', requiresAll: ['wide leg'] }))
    expect(ids(rows)).toEqual(['pants-007', 'pants-014', 'pants-016', 'pants-017', 'pants-021'])
  })

  it('avoidances remove every product carrying the avoided term', async () => {
    const adapter = new FixtureSearchAdapter()
    const all = await adapter.query(params({ category: 'pants' }))
    const rows = await adapter.query(params({ category: 'pants', avoidances: ['wide-leg'] }))
    expect(all).toHaveLength(36)
    expect(rows).toHaveLength(31)
    expect(ids(rows)).not.toContain('pants-007')
    expect(rows.every(r => !/wide.leg/i.test([r.name, ...r.tags].join(' ')))).toBe(true)
  })

  it('applies avoidances after requiresAny, so an avoided term wins over a wanted one', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({
      category: 'pants',
      requiresAny: ['wide-leg', 'cigarette'],
      avoidances: ['wide-leg'],
    }))
    expect(ids(rows)).toEqual(['pants-015', 'pants-022'])
  })
})

describe('AlgoliaAdapter', () => {
  const config = { appId: 'APP123', apiKey: 'secret-key', indexName: 'products_prod' }
  const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    return { url, init, body: JSON.parse(init.body as string) }
  }

  it('posts to the app-specific index endpoint with credential headers', async () => {
    fetchMock.mockResolvedValue(okResponse({ hits: [] }))
    await new AlgoliaAdapter(config).query(params({ category: 'top', limit: 5 }))
    const { url, init } = lastCall()
    expect(url).toBe('https://APP123-dsn.algolia.net/1/indexes/products_prod/query')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'X-Algolia-Application-Id': 'APP123',
      'X-Algolia-API-Key': 'secret-key',
      'Content-Type': 'application/json',
    })
  })

  it('translates facets and tag rules into facetFilters/numericFilters and paginates by offset', async () => {
    fetchMock.mockResolvedValue(okResponse({ hits: [] }))
    await new AlgoliaAdapter(config).query(params({
      category: 'top',
      facets: { style: 'smart-casual', fit: 'womens', maxPrice: 200 },
      requiresAll: ['linen', 'short-sleeve'],
      requiresAny: ['cream', 'oat'],
      limit: 5,
      offset: 10,
    }))
    const { body } = lastCall()
    expect(body.facetFilters).toEqual([
      'category:top',
      'style:smart-casual',
      'fit:womens',
      'tags:linen',
      'tags:short-sleeve',
      ['tags:cream', 'tags:oat'], // OR group
    ])
    expect(body.numericFilters).toEqual(['price <= 200'])
    expect(body.hitsPerPage).toBe(5)
    expect(body.page).toBe(2)
  })

  it('sends category alone and omits numericFilters when nothing else is constrained', async () => {
    fetchMock.mockResolvedValue(okResponse({ hits: [] }))
    await new AlgoliaAdapter(config).query(params({ category: 'lighting', limit: 8 }))
    const { body } = lastCall()
    expect(body.facetFilters).toEqual(['category:lighting'])
    expect(body).not.toHaveProperty('numericFilters')
    expect(body.page).toBe(0)
  })

  it('maps hits to the same SearchResult shape the fixture adapter returns', async () => {
    fetchMock.mockResolvedValue(okResponse({
      hits: [{
        objectID: 'live-1',
        name: 'Linen Shirt — Cream',
        brand: 'Loro Piana',
        price: 195,
        currency: 'USD',
        category: 'top',
        style: 'smart-casual',
        fit: 'mens',
        finish: 'cream',
        colourFamily: 'cream',
        description: 'internal copy',
        colourHex: '#F5F0E6',
        tags: ['linen', 'cream'],
        images: ['/images/top-001.jpg'],
        url: '/products/linen-shirt-cream',
        inStock: false,
        rationale: 'Breathes in the heat.',
      }],
    }))
    const rows = await new AlgoliaAdapter(config).query(params({ category: 'top', limit: 5 }))
    expect(rows).toEqual([{
      id: 'live-1',
      name: 'Linen Shirt — Cream',
      brand: 'Loro Piana',
      price: 195,
      currency: 'USD',
      category: 'top',
      colourHex: '#F5F0E6',
      images: ['/images/top-001.jpg'],
      url: '/products/linen-shirt-cream',
      tags: ['linen', 'cream'],
      rationale: 'Breathes in the heat.',
      inStock: false,
    }])
  })

  it('returns no results rather than throwing when Algolia responds with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'Invalid API key' }) })
    await expect(new AlgoliaAdapter(config).query(params({ category: 'top', limit: 5 })))
      .resolves.toEqual([])
  })

  it('does not degrade to an empty list when a 200 body has no hits array', async () => {
    fetchMock.mockResolvedValue(okResponse({ message: 'unexpected' }))
    await expect(new AlgoliaAdapter(config).query(params({ category: 'top', limit: 5 })))
      .rejects.toThrow(TypeError)
  })
})

describe('image URL normalisation', () => {
  const config = { appId: 'APP123', apiKey: 'k', indexName: 'i' }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const hit = (over: Record<string, unknown>) => ({
    objectID: 'i-1', name: 'Item', price: 1, currency: 'USD', category: 'top',
    tags: [], url: '/p/i-1', inStock: true, ...over,
  })

  it('strips a localhost origin with any port and leaves other URL forms alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [hit({
          images: [
            'http://localhost:3000/images/top-001.jpg',
            'https://localhost:8787/images/top-002.jpg',
            '/images/top-003.jpg',
            'https://cdn.example.com/images/top-004.jpg',
            '',
          ],
        })],
      }),
    }))
    const [row] = await new AlgoliaAdapter(config).query(params({ category: 'top', limit: 1 }))
    expect(row.images).toEqual([
      '/images/top-001.jpg',
      '/images/top-002.jpg',
      '/images/top-003.jpg',
      'https://cdn.example.com/images/top-004.jpg',
      '',
    ])
  })

  it('yields an empty image list when the hit has no images field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: [hit({})] }),
    }))
    const [row] = await new AlgoliaAdapter(config).query(params({ category: 'top', limit: 1 }))
    expect(row.images).toEqual([])
  })

  it('leaves the relative fixture image paths untouched', async () => {
    const adapter = new FixtureSearchAdapter()
    const rows = await adapter.query(params({ category: 'vanity', limit: 3 }))
    expect(rows.every(r => r.images.every(i => i.startsWith('/images/')))).toBe(true)
    expect(rows[0].images.length).toBeGreaterThan(0)
  })
})
