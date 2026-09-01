import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { FixtureCMSAdapter, ContentstackAdapter } from '../src/adapters/cms.js'
import type { ContentstackEntry } from '../src/types/cms.js'

// Wrap the real fs so fixture reads stay real but are countable (the fixture adapter
// documents that it caches entries rather than re-reading disk on every request).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  }
})

const CONFIG = {
  apiKey: 'blt-api-key',
  deliveryToken: 'cs-delivery-token',
  environment: 'production',
}

interface StubResponse {
  ok?: boolean
  status?: number
  body?: unknown
}

interface RecordedCall {
  url: URL
  headers: Record<string, string>
  contentType: string
}

/** Stubs global fetch and records every call the adapter makes. */
function stubFetch(handler: (contentType: string, url: URL) => StubResponse): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input)
    const contentType = url.pathname.split('/').filter(Boolean)[2]
    calls.push({ url, headers: init?.headers ?? {}, contentType })
    const stub = handler(contentType, url)
    return {
      ok: stub.ok ?? true,
      status: stub.status ?? 200,
      json: async () => stub.body ?? { entries: [], count: 0 },
    } as unknown as Response
  }))
  return calls
}

function entry(overrides: Partial<ContentstackEntry> & { uid: string }): ContentstackEntry {
  return {
    title: `Title ${overrides.uid}`,
    url: `/guides/${overrides.uid}`,
    content_type_uid: 'buying_guide',
    summary: `Summary ${overrides.uid}`,
    tags: ['jeans'],
    read_time: '5 min',
    icon: 'book',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(readFileSync).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FixtureCMSAdapter.getContent', () => {
  it('maps every field of a real fixture entry into the shape the results view renders', async () => {
    const cms = new FixtureCMSAdapter()
    const results = await cms.getContent({ goal: 'bathroom refresh', category: 'vanity', limit: 1 })

    expect(results).toEqual([{
      uid: 'blt-vanity-001',
      title: 'Bathroom Vanity Buying Guide',
      url: '/guides/bathroom-vanity-buying-guide',
      contentType: 'buying_guide',
      summary: 'How to choose the right vanity size, style, and mounting type for your bathroom. Includes size charts for small spaces.',
      tags: ['vanity', 'bathroom', 'buying-guide', 'small-spaces'],
      readTime: '6 min',
      icon: 'book',
    }])
  })

  it('returns fixture entries in file order and truncates to the requested limit', async () => {
    const cms = new FixtureCMSAdapter()
    const results = await cms.getContent({ goal: 'bathroom refresh', category: 'vanity', limit: 2 })

    expect(results.map(r => r.uid)).toEqual(['blt-vanity-001', 'blt-vanity-002'])
  })

  it('returns everything available when the limit exceeds the fixture size', async () => {
    const cms = new FixtureCMSAdapter()
    const results = await cms.getContent({ goal: 'coordinate finishes', category: 'hardware', limit: 5 })

    expect(results.map(r => r.uid)).toEqual(['blt-hardware-001'])
  })

  it('resolves the fixture regardless of how the category is cased', async () => {
    const cms = new FixtureCMSAdapter()
    const canonical = await cms.getContent({ goal: 'hang a mirror', category: 'mirror', limit: 5 })
    const shouty = await cms.getContent({ goal: 'hang a mirror', category: 'MIRROR', limit: 5 })

    expect(canonical.map(r => r.uid)).toEqual(['blt-mirror-001', 'blt-mirror-002'])
    expect(shouty).toEqual(canonical)
  })

  // Same untrimmed-normalisation hazard as the search fixture adapter: " mirror " would
  // become "-mirror-", miss the file, and cache the miss as "no guides for this category".
  it.each([' mirror', 'mirror ', '  mirror  '])(
    'resolves the fixture for a padded category %j', async category => {
      const cms = new FixtureCMSAdapter()
      const results = await cms.getContent({ goal: 'hang a mirror', category, limit: 5 })
      expect(results.map(r => r.uid)).toEqual(['blt-mirror-001', 'blt-mirror-002'])
    })

  it('returns an empty list rather than throwing for a category with no content', async () => {
    const cms = new FixtureCMSAdapter()
    await expect(
      cms.getContent({ goal: 'rooftop dinner', category: 'sunglasses', limit: 3 }),
    ).resolves.toEqual([])
  })

  it('serves repeat requests for the same category from cache instead of re-reading disk', async () => {
    const cms = new FixtureCMSAdapter()
    const first = await cms.getContent({ goal: 'bathroom refresh', category: 'tile', limit: 3 })
    const readsAfterFirst = vi.mocked(readFileSync).mock.calls.length
    const second = await cms.getContent({ goal: 'bathroom refresh', category: 'tile', limit: 3 })

    expect(readsAfterFirst).toBe(1)
    expect(vi.mocked(readFileSync).mock.calls.length).toBe(readsAfterFirst)
    expect(second).toEqual(first)
    expect(second).toHaveLength(3)
  })

  it('caches the miss for an unknown category so a bad signal cannot hammer the disk', async () => {
    const cms = new FixtureCMSAdapter()
    await cms.getContent({ goal: 'rooftop dinner', category: 'sunglasses', limit: 3 })
    const readsAfterFirst = vi.mocked(readFileSync).mock.calls.length
    await cms.getContent({ goal: 'rooftop dinner', category: 'sunglasses', limit: 3 })

    expect(vi.mocked(readFileSync).mock.calls.length).toBe(readsAfterFirst)
  })
})

describe('FixtureCMSAdapter.getByUrl', () => {
  it('finds an entry by url across every fixture file, not just the first one', async () => {
    const cms = new FixtureCMSAdapter()
    // vanity sorts last among the contentstack-*.json fixtures.
    const result = await cms.getByUrl('/guides/powder-room-dimensions')

    expect(result).toEqual({
      uid: 'blt-vanity-003',
      title: 'Powder Room Size Guide',
      url: '/guides/powder-room-dimensions',
      contentType: 'tool',
      summary: 'Standard dimensions for powder rooms and half-baths. Use this to confirm what sizes will fit before you buy.',
      tags: ['vanity', 'bathroom', 'dimensions', 'small-spaces'],
      readTime: '3 min',
      icon: 'calculator',
    })
  })

  it('returns the same mapped entry as getContent for the same underlying fixture record', async () => {
    const cms = new FixtureCMSAdapter()
    const [fromCategory] = await cms.getContent({ goal: 'hang a mirror', category: 'mirror', limit: 1 })
    const fromUrl = await cms.getByUrl('/guides/bathroom-mirror-buying-guide')

    expect(fromUrl).toEqual(fromCategory)
  })

  it('returns null for a url that does not exist', async () => {
    const cms = new FixtureCMSAdapter()
    await expect(cms.getByUrl('/guides/does-not-exist')).resolves.toBeNull()
  })

  it('matches the url exactly — no prefix or trailing-slash fuzziness', async () => {
    const cms = new FixtureCMSAdapter()

    await expect(cms.getByUrl('/how-to/hang-bathroom-mirror/')).resolves.toBeNull()
    await expect(cms.getByUrl('/how-to/hang-bathroom')).resolves.toBeNull()
    await expect(cms.getByUrl('/guides')).resolves.toBeNull()
    await expect(cms.getByUrl('')).resolves.toBeNull()
  })
})

describe('ContentstackAdapter.getContent', () => {
  it('queries the three content types in priority order against the delivery API', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getContent({ goal: 'rooftop dinner', category: 'jeans', limit: 3 })

    expect(calls.map(c => c.contentType)).toEqual(['buying_guide', 'how_to', 'project_guide'])
    expect(calls[0].url.origin).toBe('https://cdn.contentstack.io')
    expect(calls[0].url.pathname).toBe('/v3/content_types/buying_guide/entries')
  })

  it('authenticates with api_key + access_token headers and scopes by environment', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getContent({ goal: 'rooftop dinner', category: 'jeans', limit: 3 })

    for (const call of calls) {
      expect(call.headers).toEqual({
        api_key: 'blt-api-key',
        access_token: 'cs-delivery-token',
      })
      expect(call.url.searchParams.get('environment')).toBe('production')
    }
  })

  it('lower-cases the tag query so freeform LLM goal text still matches seeded tags', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getContent({
      goal: 'Rooftop Dinner Outfit',
      category: 'jeans',
      tags: ['Dark Wash', 'TAPERED'],
      limit: 4,
    })

    expect(JSON.parse(calls[0].url.searchParams.get('query')!)).toEqual({
      tags: { $in: ['jeans', 'rooftop dinner outfit', 'dark wash', 'tapered'] },
    })
  })

  it('drops empty signals from the tag query instead of matching on ""', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getContent({ goal: '', category: 'jeans', limit: 2 })

    expect(JSON.parse(calls[0].url.searchParams.get('query')!)).toEqual({
      tags: { $in: ['jeans'] },
    })
  })

  it('asks every content type for the full limit so an earlier type cannot starve a later one', async () => {
    const calls = stubFetch(type => ({
      body: type === 'buying_guide'
        ? { entries: [entry({ uid: 'bg-1' }), entry({ uid: 'bg-2' }), entry({ uid: 'bg-3' })], count: 3 }
        : { entries: [], count: 0 },
    }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getContent({ goal: 'rooftop dinner', category: 'jeans', limit: 3 })

    expect(calls.map(c => c.url.searchParams.get('limit'))).toEqual(['3', '3', '3'])
  })

  it('keeps a how_to result when buying_guide alone would have filled the limit', async () => {
    stubFetch(type => {
      if (type === 'buying_guide') {
        return { body: { entries: [entry({ uid: 'bg-1' }), entry({ uid: 'bg-2' })], count: 2 } }
      }
      if (type === 'how_to') {
        return {
          body: {
            entries: [
              entry({ uid: 'ht-1', content_type_uid: 'how_to' }),
              entry({ uid: 'ht-2', content_type_uid: 'how_to' }),
            ],
            count: 2,
          },
        }
      }
      return { body: { entries: [], count: 0 } }
    })
    const cms = new ContentstackAdapter(CONFIG)
    const results = await cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 })

    expect(results.map(r => r.uid)).toEqual(['bg-1', 'bg-2', 'ht-1'])
    expect(results.map(r => r.contentType)).toContain('how_to')
  })

  it('maps a live Contentstack payload onto exactly the ContentResult fields', async () => {
    stubFetch(type => ({
      body: type === 'buying_guide'
        ? {
            entries: [{
              uid: 'blt-live-001',
              title: 'How to Pick a Jean Fit',
              url: '/guides/jean-fit',
              content_type_uid: 'buying_guide',
              summary: 'Straight, slim, or tapered.',
              tags: ['jeans', 'fit'],
              read_time: '7 min',
              icon: 'book',
              updated_at: '2026-02-02T00:00:00Z',
            }],
            count: 1,
          }
        : { entries: [], count: 0 },
    }))
    const cms = new ContentstackAdapter(CONFIG)
    const [result] = await cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 })

    expect(result).toEqual({
      uid: 'blt-live-001',
      title: 'How to Pick a Jean Fit',
      url: '/guides/jean-fit',
      contentType: 'buying_guide',
      summary: 'Straight, slim, or tapered.',
      tags: ['jeans', 'fit'],
      readTime: '7 min',
      icon: 'book',
    })
    // CMS bookkeeping must not leak into the client payload.
    expect(Object.keys(result).sort()).toEqual(
      ['contentType', 'icon', 'readTime', 'summary', 'tags', 'title', 'uid', 'url'],
    )
  })

  it('omits readTime when the entry has no read_time rather than inventing one', async () => {
    stubFetch(type => ({
      body: type === 'buying_guide'
        ? { entries: [{ ...entry({ uid: 'no-read-time' }), read_time: undefined }], count: 1 }
        : { entries: [], count: 0 },
    }))
    const cms = new ContentstackAdapter(CONFIG)
    const [result] = await cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 })

    expect(result.readTime).toBeUndefined()
    expect(result.title).toBe('Title no-read-time')
    expect(result.icon).toBe('book')
    expect(result.tags).toEqual(['jeans'])
  })

  it('skips a failing content type and still returns the results from the healthy ones', async () => {
    stubFetch(type => {
      if (type === 'buying_guide') return { ok: false, status: 500 }
      if (type === 'how_to') {
        return { body: { entries: [entry({ uid: 'ht-1', content_type_uid: 'how_to' })], count: 1 } }
      }
      return { body: { entries: [], count: 0 } }
    })
    const cms = new ContentstackAdapter(CONFIG)
    const results = await cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 })

    expect(results.map(r => r.uid)).toEqual(['ht-1'])
  })

  it('resolves to an empty list when every content type errors', async () => {
    const calls = stubFetch(() => ({ ok: false, status: 401 }))
    const cms = new ContentstackAdapter(CONFIG)

    await expect(
      cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 }),
    ).resolves.toEqual([])
    expect(calls).toHaveLength(3)
  })

  it('resolves to an empty list when every content type returns no entries', async () => {
    stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)

    await expect(
      cms.getContent({ goal: 'jean fit', category: 'jeans', limit: 3 }),
    ).resolves.toEqual([])
  })
})

describe('ContentstackAdapter.getByUrl', () => {
  it('queries by exact url, one entry at a time, with the delivery credentials', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)
    await cms.getByUrl('/guides/jean-fit')

    expect(JSON.parse(calls[0].url.searchParams.get('query')!)).toEqual({ url: '/guides/jean-fit' })
    expect(calls[0].url.searchParams.get('limit')).toBe('1')
    expect(calls[0].url.searchParams.get('environment')).toBe('production')
    expect(calls[0].headers).toEqual({
      api_key: 'blt-api-key',
      access_token: 'cs-delivery-token',
    })
  })

  it('returns the mapped entry and stops querying once a content type matches', async () => {
    const calls = stubFetch(() => ({
      body: { entries: [entry({ uid: 'blt-live-002', url: '/guides/jean-fit' })], count: 1 },
    }))
    const cms = new ContentstackAdapter(CONFIG)
    const result = await cms.getByUrl('/guides/jean-fit')

    expect(result).toMatchObject({
      uid: 'blt-live-002',
      url: '/guides/jean-fit',
      contentType: 'buying_guide',
      readTime: '5 min',
    })
    expect(calls).toHaveLength(1)
  })

  it('keeps searching later content types when earlier ones have no match', async () => {
    const calls = stubFetch(type => ({
      body: type === 'project_guide'
        ? { entries: [entry({ uid: 'pg-1', content_type_uid: 'project_guide' })], count: 1 }
        : { entries: [], count: 0 },
    }))
    const cms = new ContentstackAdapter(CONFIG)
    const result = await cms.getByUrl('/guides/pg-1')

    expect(result?.uid).toBe('pg-1')
    expect(calls.map(c => c.contentType)).toEqual(['buying_guide', 'how_to', 'project_guide'])
  })

  it('ignores a content type that errors and uses the next one', async () => {
    stubFetch(type => (
      type === 'buying_guide'
        ? { ok: false, status: 500 }
        : { body: { entries: [entry({ uid: 'ht-9', content_type_uid: 'how_to' })], count: 1 } }
    ))
    const cms = new ContentstackAdapter(CONFIG)

    await expect(cms.getByUrl('/how-to/anything')).resolves.toMatchObject({ uid: 'ht-9' })
  })

  it('returns null when no content type has the url', async () => {
    const calls = stubFetch(() => ({ body: { entries: [], count: 0 } }))
    const cms = new ContentstackAdapter(CONFIG)

    await expect(cms.getByUrl('/guides/missing')).resolves.toBeNull()
    expect(calls).toHaveLength(3)
  })
})
