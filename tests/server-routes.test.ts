import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { app } from '../src/server.js'

// Catalog stats are built by a floating promise at module load, so a test that reads them
// immediately after import can race it. The refresh route awaits the same builder, so hitting
// it once up front makes every stats-dependent assertion below deterministic.
beforeAll(async () => {
  const res = await app.request('/api/catalog-stats/refresh', { method: 'POST' })
  expect(res.status).toBe(200)
})

async function json<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await app.request(path, init)
  return { status: res.status, body: (await res.json()) as T }
}

function post(path: string, body: unknown) {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Every mutating route below writes module-level state shared by the whole suite, so each
// test that touches one records the value it found and puts it back afterwards.
const restores: (() => Promise<void>)[] = []
afterEach(async () => {
  while (restores.length) await restores.pop()!()
})

describe('GET /health', () => {
  it('reports fixture mode, the active provider and a non-empty catalog', async () => {
    const { status, body } = await json('/health')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.fixtures).toBe(true)
    expect(['claude', 'openai']).toContain(body.provider)
    expect(typeof body.intents).toBe('number')
    expect(body.catalogCategories).toBeGreaterThan(0)
  })

  it('agrees with /api/provider about which provider is active', async () => {
    const health = await json('/health')
    const provider = await json('/api/provider')
    expect(health.body.provider).toBe(provider.body.provider)
  })
})

describe('catalog stats', () => {
  it('exposes coherent per-category price stats built from the fixture catalog', async () => {
    const { status, body } = await json<Record<string, any>>('/api/catalog-stats')
    expect(status).toBe(200)
    const categories = Object.keys(body)
    expect(categories.length).toBeGreaterThan(0)
    for (const category of categories) {
      const s = body[category]
      expect(s.count).toBeGreaterThan(0)
      expect(s.min).toBeGreaterThan(0)
      expect(s.min).toBeLessThanOrEqual(s.avg)
      expect(s.avg).toBeLessThanOrEqual(s.max)
      expect(Number.isInteger(s.avg)).toBe(true)
    }
  })

  it('stats agree with what /api/search returns for the same category', async () => {
    const stats = await json<Record<string, any>>('/api/catalog-stats')
    const category = Object.keys(stats.body)[0]
    const search = await json<any>(`/api/search?q=${encodeURIComponent(category)}`)
    const prices = search.body.hits.map((h: any) => h.price)
    expect(search.body.nbHits).toBe(stats.body[category].count)
    expect(Math.min(...prices)).toBe(stats.body[category].min)
    expect(Math.max(...prices)).toBe(stats.body[category].max)
  })

  it('refresh rebuilds and returns the same category set the GET route serves', async () => {
    const { status, body } = await post('/api/catalog-stats/refresh', {})
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const after = await json<Record<string, any>>('/api/catalog-stats')
    expect(body.categories.sort()).toEqual(Object.keys(after.body).sort())
    expect(body.categories).toContain('shoes')
  })
})

describe('GET /api/product/:slug', () => {
  it('returns the fixture product whose url matches the slug', async () => {
    const { status, body } = await json<any>('/api/product/tan-leather-derby')
    expect(status).toBe(200)
    expect(body.url).toBe('/products/tan-leather-derby')
    expect(body.name).toBe('Tan Leather Derby')
    expect(body.category).toBe('shoes')
    expect(typeof body.price).toBe('number')
    expect(Array.isArray(body.images)).toBe(true)
  })

  it('404s as JSON for a slug that is in no fixture', async () => {
    const { status, body } = await json<any>('/api/product/definitely-not-a-real-product')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'not found' })
  })
})

describe('GET /api/search', () => {
  it('returns every product in a category when only q is given', async () => {
    const { status, body } = await json<any>('/api/search?q=shoes')
    expect(status).toBe(200)
    expect(body.nbHits).toBe(body.hits.length)
    expect(body.nbHits).toBeGreaterThan(0)
    expect(body.styleRelaxed).toBe(false)
    expect(body.requestedStyle).toBeNull()
    expect(body.hits.every((h: any) => h.category === 'shoes')).toBe(true)
  })

  it('applies maxPrice as an inclusive ceiling and ignores a non-numeric one', async () => {
    const all = await json<any>('/api/search?q=shoes')
    const capped = await json<any>('/api/search?q=shoes&maxPrice=150')
    expect(capped.body.nbHits).toBeGreaterThan(0)
    expect(capped.body.nbHits).toBeLessThan(all.body.nbHits)
    expect(capped.body.hits.every((h: any) => h.price <= 150)).toBe(true)

    const garbage = await json<any>('/api/search?q=shoes&maxPrice=cheap')
    expect(garbage.body.nbHits).toBe(all.body.nbHits)
  })

  it('narrows to a subset when a fit is requested', async () => {
    const all = await json<any>('/api/search?q=shoes')
    const womens = await json<any>('/api/search?q=shoes&fit=womens')
    const allIds = new Set(all.body.hits.map((h: any) => h.id))
    expect(womens.body.nbHits).toBeGreaterThan(0)
    expect(womens.body.nbHits).toBeLessThan(all.body.nbHits)
    expect(womens.body.hits.every((h: any) => allIds.has(h.id))).toBe(true)
  })

  it('drops an unmatchable style rather than showing the shopper nothing', async () => {
    const all = await json<any>('/api/search?q=shoes')
    const { status, body } = await json<any>('/api/search?q=shoes&style=cyberpunk')
    expect(status).toBe(200)
    expect(body.styleRelaxed).toBe(true)
    expect(body.requestedStyle).toBe('cyberpunk')
    expect(body.nbHits).toBe(all.body.nbHits)
  })

  it('returns an empty result set — not an error — for a category with no fixture', async () => {
    const { status, body } = await json<any>('/api/search?q=hovercraft')
    expect(status).toBe(200)
    expect(body.hits).toEqual([])
    expect(body.nbHits).toBe(0)
    expect(body.styleRelaxed).toBe(false)
    expect(body.requestedStyle).toBeNull()
  })

  it('returns an empty result set when q is missing entirely', async () => {
    const { status, body } = await json<any>('/api/search')
    expect(status).toBe(200)
    expect(body.nbHits).toBe(0)
  })
})

describe('provider switching', () => {
  it('switches the active provider and reflects it on GET /api/provider and /health', async () => {
    const original = (await json<any>('/api/provider')).body.provider
    restores.push(async () => { await post('/api/provider', { provider: original }) })

    const target = original === 'claude' ? 'openai' : 'claude'
    const { status, body } = await post('/api/provider', { provider: target })
    expect(status).toBe(200)
    expect(body.provider).toBe(target)
    expect((await json<any>('/api/provider')).body.provider).toBe(target)
    expect((await json<any>('/health')).body.provider).toBe(target)
  })

  it('rejects an unknown provider key and leaves the active provider untouched', async () => {
    const original = (await json<any>('/api/provider')).body.provider
    const { status, body } = await post('/api/provider', { provider: 'gemini' })
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Unknown provider' })
    expect((await json<any>('/api/provider')).body.provider).toBe(original)
  })

  it('resets model overrides to the new provider defaults on switch', async () => {
    const original = (await json<any>('/api/provider')).body.provider
    restores.push(async () => { await post('/api/provider', { provider: original }) })

    await post('/api/chat-model', { model: 'made-up-model-id' })
    expect((await json<any>('/api/chat-model')).body.model).toBe('made-up-model-id')

    const target = original === 'claude' ? 'openai' : 'claude'
    await post('/api/provider', { provider: target })
    const after = (await json<any>('/api/chat-model')).body.model
    expect(after).not.toBe('made-up-model-id')
    expect(after.length).toBeGreaterThan(0)
  })
})

describe.each([
  ['/api/chat-model', 'chat'],
  ['/api/spec-model', 'spec'],
  ['/api/curation-model', 'curation'],
])('%s', route => {
  it('serves a non-empty default model id', async () => {
    const { status, body } = await json<any>(route)
    expect(status).toBe(200)
    expect(typeof body.model).toBe('string')
    expect(body.model.length).toBeGreaterThan(0)
  })

  it('round-trips an override and trims surrounding whitespace', async () => {
    const original = (await json<any>(route)).body.model
    restores.push(async () => { await post(route, { model: original }) })

    const { status, body } = await post(route, { model: '  custom-model-7  ' })
    expect(status).toBe(200)
    expect(body.model).toBe('custom-model-7')
    expect((await json<any>(route)).body.model).toBe('custom-model-7')
  })

  it('rejects an empty or whitespace-only model id without clobbering the current one', async () => {
    const original = (await json<any>(route)).body.model
    for (const bad of ['', '   ']) {
      const { status, body } = await post(route, { model: bad })
      expect(status).toBe(400)
      expect(body).toEqual({ error: 'Model ID required' })
    }
    expect((await json<any>(route)).body.model).toBe(original)
  })

  it('is independent of the other two model routes', async () => {
    const others = ['/api/chat-model', '/api/spec-model', '/api/curation-model'].filter(r => r !== route)
    const before = await Promise.all(others.map(r => json<any>(r)))
    const original = (await json<any>(route)).body.model
    restores.push(async () => { await post(route, { model: original }) })

    await post(route, { model: 'isolated-model-check' })
    const after = await Promise.all(others.map(r => json<any>(r)))
    expect(after.map(r => r.body.model)).toEqual(before.map(r => r.body.model))
  })
})

describe('GET /api/env-status', () => {
  it('reports fixture mode and whether a gateway key is configured', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key')
    const withKey = await json<any>('/api/env-status')
    expect(withKey.status).toBe(200)
    expect(withKey.body).toEqual({ gatewayKey: true, useFixtures: true })

    vi.stubEnv('AI_GATEWAY_API_KEY', '')
    const withoutKey = await json<any>('/api/env-status')
    expect(withoutKey.body.gatewayKey).toBe(false)
    expect(withoutKey.body.useFixtures).toBe(true)
    vi.unstubAllEnvs()
  })
})

describe('debug routes', () => {
  it('/debug/intents and /debug/events serve JSON objects keyed by session', async () => {
    for (const route of ['/debug/intents', '/debug/events', '/debug/raw']) {
      const res = await app.request(route)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json()
      expect(typeof body).toBe('object')
      expect(Array.isArray(body)).toBe(false)
    }
  })

  it('/debug/requests serves a JSON array', async () => {
    const res = await app.request('/debug/requests')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(Array.isArray(await res.json())).toBe(true)
  })
})

describe('catch-all', () => {
  it('renders the shared guide template for a path a CMS entry claims', async () => {
    const res = await app.request('/guides/bathroom-vanity-buying-guide')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<html')
  })

  it('404s for an unmatched path with no CMS entry', async () => {
    const res = await app.request('/guides/no-such-guide-exists')
    expect(res.status).toBe(404)
  })

  it('404s unknown /api/* paths without attempting a CMS lookup', async () => {
    const res = await app.request('/api/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('404s paths that look like static files', async () => {
    const res = await app.request('/favicon.ico')
    expect(res.status).toBe(404)
  })
})
