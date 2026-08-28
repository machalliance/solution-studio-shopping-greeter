import type { IntentModel } from '../types/intent.js'

/**
 * Extracts the upper bound from a budget label like "$1,000–$2,500" or "Under $2,000".
 * Used to set Algolia's maxPrice numeric filter. "No set limit" / no match → undefined (no filter).
 */
function parseBudgetNumber(label: string): number | undefined {
  const nums = label.match(/\d[\d,]*/g)?.map(n => parseInt(n.replace(/,/g, ''), 10)) ?? []
  if (nums.length === 0) return undefined
  return Math.max(...nums)
}

// Read a string value from the open constraints record by one or more possible key names.
function getStr(constraints: IntentModel['constraints'], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = constraints[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Slugifies a style label for the fixture/Algolia `style` facet. Only ever called with
 * `styleFamily` — one of the fixed step-2/3 chip options ("Smart casual", "Coastal", "Scandi",
 * etc.) that the catalog's own style values already match once lowercased and hyphenated. There
 * is deliberately no alias table here: a free-form sub-direction name the model invents (e.g.
 * "City Smart") is never passed to this function — see `styleFamily` in the TurnSchema for why.
 */
function normalizeStyle(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-')
}

/** Maps the model's fit label to the canonical slug used in fixture files and Algolia. */
function normalizeFit(label: string): string {
  const lower = label.toLowerCase()
  if (lower.includes('women') || lower.includes('woman') || lower === 'female') return 'womens'
  if ((lower.includes('men') || lower === 'male') && !lower.includes('women')) return 'mens'
  return 'unisex'
}


export function buildShowAllUrl(category: string, intent: IntentModel): string {
  const c = intent.constraints
  const params = new URLSearchParams({ q: category })
  const skin = intent.goalType === 'project' ? 'project' : 'clothing'
  params.set('skin', skin)
  const style  = getStr(c, 'styleFamily', 'style')
  const budget = getStr(c, 'budget')
  const colour = getStr(c, 'colourDirection', 'color', 'colour')
  const fit    = getStr(c, 'fit', 'gender', 'shopFor', 'shoppingFor', 'fitPreference')
  if (style)  params.set('style', normalizeStyle(style))
  if (budget) params.set('maxPrice', String(parseBudgetNumber(budget) ?? ''))
  if (colour) params.set('colour', colour)
  if (fit)    params.set('fit', normalizeFit(fit))
  return `/search?${params.toString()}`
}

export function buildSearchFacets(intent: IntentModel): Record<string, string | number> {
  const c = intent.constraints
  const facets: Record<string, string | number> = {}
  const fit     = getStr(c, 'fit', 'gender', 'shopFor', 'shoppingFor', 'fitPreference')
  const budget  = getStr(c, 'budget')
  // Fit and price are the only hard constraints applied at search time — both are
  // domain-agnostic. Style, warmth, colour direction, and finish are intent signals:
  // the spec LLM (generateStyleSpec) translates them into per-category requiresTags
  // and avoidances before search runs, identically for fixtures and live Algolia.
  // Do not add them back as facets here — that splits interpretation across layers
  // and reintroduces the domain hardcoding this module must stay free of.
  if (fit)    facets.fit    = normalizeFit(fit)
  if (budget) { const n = parseBudgetNumber(budget); if (n != null) facets.maxPrice = n }
  return facets
}
