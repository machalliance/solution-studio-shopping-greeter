import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentParams, ContentstackEntry, ContentstackResponse } from '../types/cms.js'
import type { ContentResult } from '../types/intent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, '../../catalog/fixtures')

/**
 * Adapter interface for CMS content. Implementations: FixtureCMSAdapter (local dev / demo),
 * ContentstackAdapter (production). Swap by changing the instantiation in server.ts.
 */
export interface CMSAdapter {
  getContent(params: ContentParams): Promise<ContentResult[]>
  /** Looks up a single entry by its stored `url` field (e.g. "/guides/vanity-buying-guide"). */
  getByUrl(url: string): Promise<ContentResult | null>
}

/**
 * In-memory fixture adapter. Reads contentstack-{category}.json from /catalog/fixtures.
 * Fixtures are cached at construction time — no repeated disk reads per request.
 */
export class FixtureCMSAdapter implements CMSAdapter {
  private readonly cache = new Map<string, ContentstackEntry[]>()

  private loadFixture(category: string): ContentstackEntry[] {
    const key = category.toLowerCase().replace(/\s+/g, '-')
    if (this.cache.has(key)) return this.cache.get(key)!
    const filename = `contentstack-${key}.json`
    try {
      const raw = readFileSync(join(FIXTURES_DIR, filename), 'utf-8')
      const response: ContentstackResponse = JSON.parse(raw)
      this.cache.set(key, response.entries)
      return response.entries
    } catch {
      this.cache.set(key, [])
      return []
    }
  }

  async getContent(params: ContentParams): Promise<ContentResult[]> {
    const entries = this.loadFixture(params.category)
    return entries.slice(0, params.limit).map(entry => mapEntry(entry))
  }

  async getByUrl(url: string): Promise<ContentResult | null> {
    let files: string[]
    try {
      files = readdirSync(FIXTURES_DIR).filter(f => f.startsWith('contentstack-') && f.endsWith('.json'))
    } catch {
      return null
    }
    for (const file of files) {
      try {
        const response: ContentstackResponse = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf-8'))
        const entry = response.entries.find(e => e.url === url)
        if (entry) return mapEntry(entry)
      } catch {}
    }
    return null
  }
}

/**
 * Live Contentstack adapter. Queries three content types in priority order
 * (buying_guide, how_to, project_guide), filtering by category and goal tags.
 *
 * Content types are hardcoded to match the Phase 1 Contentstack schema.
 * Phase 2: read available content types from the Contentstack management API.
 */
export class ContentstackAdapter implements CMSAdapter {
  private static readonly CONTENT_TYPES = ['buying_guide', 'how_to', 'project_guide']

  constructor(private config: {
    apiKey: string
    deliveryToken: string
    environment: string
  }) {}

  async getContent(params: ContentParams): Promise<ContentResult[]> {
    const results: ContentResult[] = []

    // Queries every content type — no early break once `limit` is reached. `goal` and
    // `style` are session-global signals (every category's query matches on them), so a
    // category can legitimately match 2+ universal guides before ever reaching its one
    // truly category-specific entry (e.g. a jean-fit how-to). An early break by type let
    // whichever type happened to come first (buying_guide) fill the whole limit and
    // starve out how_to entirely — a real bug, not a hypothetical: a "jeans" refinement
    // matched Coastal + Rooftop (both buying_guide) and never found the jean-fit guide
    // because the loop broke before it reached how_to. Collecting everything first, then
    // slicing once at the end, means no type can starve out another this way. Cheap at
    // this catalog's size (a handful of entries per type).
    for (const type of ContentstackAdapter.CONTENT_TYPES) {
      // Tags are matched by exact string equality (Contentstack's $in is case-sensitive) —
      // every entry's tags are seeded lowercase, but the signals we send here aren't
      // guaranteed to be: category is already a fixed lowercase constant, but goal is
      // freeform LLM text ("Rooftop dinner outfit" vs. the seeded "rooftop dinner outfit")
      // and could silently fail to match on case alone. Normalizing everything here, once,
      // means no caller has to remember to do it themselves.
      //
      // category is namespaced ("category:pants"), same reasoning as the style: namespace
      // below — a bare category name is a collision risk, not just with an unrelated raw
      // product tag but with a narrower guide that legitimately carries the plain category
      // word for browsing/taxonomy purposes without actually being *about* the category as a
      // whole. A "Finding Your Jean Fit" guide tagged plain "pants" matched every pants-category
      // query regardless of whether any returned product was actually jeans — jean-fit isn't
      // pants-fit, so that guide should only ever surface via its own "jeans" product-attribute
      // tag, never via the category. Only a guide that opts in with "category:pants" now matches
      // on category alone; everything else has to earn its match through goal, style, or an
      // actual product tag.
      const matchTags = [params.category ? `category:${params.category}` : undefined, params.goal, ...(params.tags ?? [])]
        .filter((t): t is string => Boolean(t))
        .map(t => t.toLowerCase())
      // Each type is queried for the full `limit`, independent of what other types have
      // already contributed — shrinking this by results-so-far was the other half of the
      // starvation bug: once buying_guide filled the limit, later types were asked for
      // 0 (or negative) results and returned nothing, even before the early-break above.
      // The combined slice below is what actually enforces `limit` on the response.
      const url = new URL(`https://cdn.contentstack.io/v3/content_types/${type}/entries`)
      url.searchParams.set('environment', this.config.environment)
      url.searchParams.set('query', JSON.stringify({ tags: { $in: matchTags } }))
      url.searchParams.set('limit', String(params.limit))

      const res = await fetch(url.toString(), {
        headers: {
          api_key: this.config.apiKey,
          access_token: this.config.deliveryToken,
        },
      })

      if (!res.ok) continue

      const data: ContentstackResponse = await res.json()
      results.push(...data.entries.map(entry => mapEntry(entry)))
    }

    return results.slice(0, params.limit)
  }

  async getByUrl(url: string): Promise<ContentResult | null> {
    for (const type of ContentstackAdapter.CONTENT_TYPES) {
      const apiUrl = new URL(`https://cdn.contentstack.io/v3/content_types/${type}/entries`)
      apiUrl.searchParams.set('environment', this.config.environment)
      apiUrl.searchParams.set('query', JSON.stringify({ url }))
      apiUrl.searchParams.set('limit', '1')

      const res = await fetch(apiUrl.toString(), {
        headers: {
          api_key: this.config.apiKey,
          access_token: this.config.deliveryToken,
        },
      })
      if (!res.ok) continue

      const data: ContentstackResponse = await res.json()
      if (data.entries[0]) return mapEntry(data.entries[0])
    }
    return null
  }
}

function mapEntry(entry: ContentstackEntry): ContentResult {
  return {
    uid: entry.uid,
    title: entry.title,
    url: entry.url,
    contentType: entry.content_type_uid,
    summary: entry.summary,
    tags: entry.tags,
    readTime: entry.read_time,
    icon: entry.icon,
  }
}
