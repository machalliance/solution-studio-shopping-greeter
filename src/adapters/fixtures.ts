import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = join(__dirname, '../../catalog/fixtures')

/**
 * Category → fixture filename key. Categories arrive as free-form LLM output, so padding is
 * reachable in practice: without the trim, " mirror " normalises to "-mirror-", misses the
 * file, and the miss is then cached — a silently empty product row or guide list with no error.
 */
export function fixtureKey(category: string): string {
  return category.trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * Builds a cached per-category fixture reader. Both fixture adapters load the same way and
 * differ only in filename prefix and which array they pull out of the parsed file, so the
 * shared shape lives here rather than being copied — the two copies had already drifted into
 * carrying the same bug twice.
 *
 * A missing or unparseable file caches an empty result: fixtures are a fixed local set, so a
 * miss means "this category has no fixture", not a transient failure worth retrying per request.
 */
export function createFixtureLoader<T>(prefix: string, extract: (parsed: any) => T[] | undefined) {
  const cache = new Map<string, T[]>()
  return (category: string): T[] => {
    const key = fixtureKey(category)
    const cached = cache.get(key)
    if (cached) return cached
    let items: T[] = []
    try {
      const raw = readFileSync(join(FIXTURES_DIR, `${prefix}-${key}.json`), 'utf-8')
      items = extract(JSON.parse(raw)) ?? []
    } catch {
      items = []
    }
    cache.set(key, items)
    return items
  }
}
