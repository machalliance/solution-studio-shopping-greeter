import type { SearchParams, AlgoliaHit, AlgoliaResponse } from '../types/search.js'
import type { SearchResult } from '../types/intent.js'
import { createFixtureLoader } from './fixtures.js'

/**
 * Adapter interface for product search. Implementations: FixtureSearchAdapter (local dev / demo),
 * AlgoliaAdapter (production). Swap by changing the instantiation in server.ts — call sites are identical.
 */
export interface SearchAdapter {
  query(params: SearchParams): Promise<SearchResult[]>
}

/**
 * In-memory fixture adapter for local development and demos.
 * Reads algolia-{category}.json files from /catalog/fixtures and applies the same facet filters
 * that AlgoliaAdapter would apply in production, so both adapters return consistent shapes.
 * Fixtures are parsed once per adapter instance and cached — no repeated disk reads.
 */
export class FixtureSearchAdapter implements SearchAdapter {
  private readonly loadFixture = createFixtureLoader<AlgoliaHit>(
    'algolia', (parsed: AlgoliaResponse) => parsed.hits,
  )

  async query(params: SearchParams): Promise<SearchResult[]> {
    const hits = this.loadFixture(params.category)

    const styleFilter  = params.facets.style as string | undefined
    const fitFilter    = params.facets.fit as string | undefined
    const maxPrice     = params.facets.maxPrice as number | undefined

    const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-')
    let results = hits

    if (styleFilter) results = results.filter(h => !h.style || slug(h.style) === slug(styleFilter))
    if (fitFilter)   results = results.filter(h => !h.fit || h.fit === 'unisex' || h.fit === fitFilter)
    if (maxPrice)    results = results.filter(h => h.price <= maxPrice)

    const norm = (s: string) => s.toLowerCase().replace(/-/g, ' ')

    // AND filter: item must contain every tag. Enforces explicit user constraints ("short sleeves only").
    if (params.requiresAll?.length) {
      const required = params.requiresAll.map(norm)
      results = results.filter(h => {
        const text = [h.name, ...(h.tags ?? [])].map(norm).join(' ')
        return required.every(r => text.includes(r))
      })
    }

    // OR filter: item must contain at least one tag. Guides style interpretation ("linen OR cotton OR breathable").
    if (params.requiresAny?.length) {
      const required = params.requiresAny.map(norm)
      results = results.filter(h => {
        const text = [h.name, ...(h.tags ?? [])].map(norm).join(' ')
        return required.some(r => text.includes(r))
      })
    }

    // Avoidance filtering: exclude products whose name or tags contain any avoidance term.
    // Normalise both sides (lowercase, hyphens → spaces) so "wide-leg" matches "wide leg".
    if (params.avoidances?.length) {
      const avoid = params.avoidances.map(norm)
      results = results.filter(h => {
        const text = [h.name, ...(h.tags ?? [])].map(norm).join(' ')
        return !avoid.some(a => text.includes(a))
      })
    }

    // No colour/warmth/finish interpretation here — those are intent signals the spec LLM
    // translates into the requiresAll/requiresAny/avoidances tag filters above, keeping this
    // adapter domain-agnostic and its behaviour identical to the live Algolia adapter.
    return results.slice(0, params.limit).map(hit => mapHit(hit))
  }
}

/**
 * Live Algolia adapter. Applies category, style, and fit as facet filters,
 * and budget as a numeric filter. Pagination is page-based (Algolia native).
 *
 * Deliberately no warmth/colour/finish handling here (or in FixtureSearchAdapter):
 * those intent signals are translated by the spec LLM into the requiresAll/requiresAny/
 * avoidances tag filters both adapters apply, so fixture and live behaviour stay
 * identical without either adapter knowing any domain vocabulary.
 */
export class AlgoliaAdapter implements SearchAdapter {
  constructor(private config: {
    appId: string
    apiKey: string
    indexName: string
  }) {}

  async query(params: SearchParams): Promise<SearchResult[]> {
    const url = `https://${this.config.appId}-dsn.algolia.net/1/indexes/${this.config.indexName}/query`

    // Algolia facetFilters: outer array = AND, inner array = OR.
    // requiresAll → each tag is its own AND group: [["tags:linen"], ["tags:short-sleeve"]]
    // requiresAny → all tags in one OR group: [["tags:linen", "tags:cotton", "tags:breathable"]]
    const facetFilters: (string | string[])[] = [`category:${params.category}`]
    if (params.facets.style) facetFilters.push(`style:${params.facets.style}`)
    if (params.facets.fit)   facetFilters.push(`fit:${params.facets.fit}`)
    if (params.requiresAll?.length) {
      for (const tag of params.requiresAll) facetFilters.push(`tags:${tag}`)
    }
    if (params.requiresAny?.length) {
      facetFilters.push(params.requiresAny.map(tag => `tags:${tag}`))
    }

    const numericFilters: string[] = []
    if (params.facets.maxPrice) numericFilters.push(`price <= ${params.facets.maxPrice}`)

    const body = {
      query: '',
      hitsPerPage: params.limit,
      page: Math.floor((params.offset ?? 0) / params.limit),
      facetFilters: facetFilters.length ? facetFilters : undefined,
      numericFilters: numericFilters.length ? numericFilters : undefined,
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': this.config.appId,
        'X-Algolia-API-Key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) return []

    const data: AlgoliaResponse = await res.json()
    return data.hits.map(hit => mapHit(hit))
  }
}

// Strip any absolute localhost origin from image URLs so they work regardless of
// the port/hostname the server is running on.
function normalizeImageUrl(url: string): string {
  return url.replace(/^https?:\/\/localhost:\d+/, '')
}

function mapHit(hit: AlgoliaHit): SearchResult {
  return {
    id: hit.objectID,
    name: hit.name,
    brand: hit.brand,
    price: hit.price,
    currency: hit.currency,
    category: hit.category,
    colourHex: hit.colourHex,
    images: (hit.images ?? []).map(normalizeImageUrl),
    url: hit.url,
    tags: hit.tags,
    rationale: hit.rationale,
    inStock: hit.inStock,
  }
}
