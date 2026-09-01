import type { IntentModel } from '../types/intent.js'

/**
 * Extracts the upper bound from a budget label like "$1,000–$2,500" or "Under $2,000".
 * Used to set Algolia's maxPrice numeric filter. "No set limit" / no match → undefined (no filter).
 *
 * A leading "over" names a FLOOR, not a ceiling — "Over $5,000" is the top project budget chip
 * (see budgetChoices in server.ts), and reading its number as maxPrice capped the most generous
 * shopper below the "No set limit" one. Must stay in agreement with parseBudgetUpperBound in
 * server.ts, which already reads the same label as Infinity. Anchored deliberately: "Just over
 * $300" is a bound the shopper typed, not an open tier.
 */
function parseBudgetNumber(label: string): number | undefined {
  if (/^\s*over\b/i.test(label)) return undefined
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
  const fit         = getStr(c, 'fit', 'gender', 'shopFor', 'shoppingFor', 'fitPreference')
  const budget       = getStr(c, 'budget')
  const styleFamily  = getStr(c, 'styleFamily')
  // Fit, price, and styleFamily are the only hard constraints applied at search time.
  // Warmth, colour direction, finish, and free-form style refinements (e.g. a sub-direction
  // like "City Smart") remain intent signals the spec LLM (generateStyleSpec) translates
  // into per-category requiresTags/avoidances before search runs — do not add those back as
  // facets here, that splits interpretation across layers and reintroduces the domain
  // hardcoding this module must stay free of.
  //
  // styleFamily is the one exception, and deliberately uses styleFamily (never plain
  // `style`): it's the only style-related field guaranteed to always be one of the fixed
  // step-2/3 chip options the catalog's own `style` field actually uses — `style` itself can
  // be a free-form sub-direction the catalog has no vocabulary for, which would zero out
  // every search the moment a shopper picks one. Both search adapters already null-safely
  // handle a style facet (keep items with no style set, exclude items whose style disagrees)
  // — this was already built, just never populated. Without this, nothing ever checks a
  // product's own style classification against the requested one: a correctly-tagged
  // `casual` item can still win a spot in a `smart-casual` pool purely by matching a fuzzy
  // material/occasion tag (e.g. "cotton") in the spec's requiresAny — see
  // [[greeter_style_facet_added]] for the real incident this fixes.
  if (fit)         facets.fit   = normalizeFit(fit)
  if (budget)      { const n = parseBudgetNumber(budget); if (n != null) facets.maxPrice = n }
  if (styleFamily) facets.style = normalizeStyle(styleFamily)
  return facets
}
