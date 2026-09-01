import { readdirSync } from 'node:fs'
import { FIXTURES_DIR, search } from './config.js'

// Built at startup by querying the search adapter for every category. Injected into LLM prompts
// so budget options are calibrated to real products.
// In production: FixtureSearchAdapter → AlgoliaAdapter, same interface, no code change.

export interface CategoryStats { min: number; max: number; avg: number; count: number }
export type CatalogStats = Record<string, CategoryStats>

export const catalogStats: CatalogStats = {}

export async function buildCatalogStats(): Promise<void> {
  let categories: string[]
  try {
    categories = readdirSync(FIXTURES_DIR)
      .filter(f => f.startsWith('algolia-') && f.endsWith('.json'))
      .map(f => f.replace('algolia-', '').replace('.json', ''))
  } catch {
    categories = []
  }
  await Promise.all(categories.map(async category => {
    try {
      const results = await search.query({ category, facets: {}, limit: 200 })
      if (results.length === 0) return
      const prices = results.map(r => r.price)
      catalogStats[category] = {
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        count: results.length,
      }
    } catch { /* skip category if fixture missing */ }
  }))
  console.log(`[catalog] stats ready for: ${Object.keys(catalogStats).join(', ')}`)
}
