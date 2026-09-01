import { llm, search, cms, zeroResultsAction } from './config.js'
import { catalogStats } from './catalogStats.js'
import { specCache, budgetCache, curatedOutfitCache, type CachedSpec } from './stores.js'
import { categoryDisplayName } from '../agent/intent.js'
import { buildSearchFacets, buildShowAllUrl } from '../agent/layout.js'
import type { IntentModel, CategoryResult, CuratedOutfit } from '../types/intent.js'

/**
 * Assembles the full results payload for a given intent and category list.
 *
 * For each category:
 *   1. Optionally allocates a per-category budget via LLM (proportional, hero-biased)
 *   2. Queries the search adapter with intent-derived facets + allocated maxPrice
 *   3. Retries without maxPrice if budget filtering returns zero results
 *   4. Queries the CMS adapter for matching guides / how-tos
 *   5. Generates an LLM rationale sentence and 2–3 filter chip labels
 *
 * All categories are assembled in parallel. Budget allocation runs first (single LLM call)
 * so per-category maxPrice is available before the parallel search queries fire.
 */
export async function assembleResults(
  intent: IntentModel,
  categories: string[]
): Promise<CategoryResult[]> {
  const baseFacets = buildSearchFacets(intent)

  const globalAvoidances: string[] = Array.isArray(intent.constraints.avoidances)
    ? (intent.constraints.avoidances as string[])
    : []
  const globalRequiresTags: string[] = Array.isArray(intent.constraints.requiresTags)
    ? intent.constraints.requiresTags
    : []
  const categoryConstraints = intent.constraints.categoryConstraints ?? {}

  // Spec + budget run in parallel — they are independent and both gate the per-category search.
  const hasCatalogStats = Object.keys(catalogStats).length > 0
  const budgetFacet = baseFacets.maxPrice as number | undefined
  const fitFilter = baseFacets.fit as string | undefined

  // Run spec whenever any signal the spec LLM can translate is present — not only style.
  // warmth, colourDirection, venue, and finish all produce per-category avoidances/tags.
  const hasSpecSignal = !!(intent.constraints.style || intent.constraints.warmth ||
    intent.constraints.colourDirection || intent.constraints.venue || intent.constraints.finish)

  // Global signals feed every category's spec entry (style coherence); a category's own
  // categoryConstraints only feeds its own entry. A category's key changes only if one of
  // those two actually changed for it — untouched categories keep the identical key turn to
  // turn regardless of what changed elsewhere in the intent.
  const globalSpecSignal = JSON.stringify({
    style: intent.constraints.style, colour: intent.constraints.colourDirection,
    fit: intent.constraints.fit, warmth: intent.constraints.warmth,
    venue: intent.constraints.venue, finish: intent.constraints.finish,
    goalType: intent.goalType, goal: intent.goal, globalRequiresTags,
  })
  const specKeyFor = (cat: string) => JSON.stringify({ global: globalSpecSignal, cc: categoryConstraints[cat] ?? null })

  const [styleSpec, perCategoryMax] = await Promise.all([
    (async (): Promise<Record<string, CachedSpec>> => {
      if (!hasSpecSignal) return {}
      const prevEntries = specCache.get(intent.sessionId) ?? {}
      const stale = categories.filter(cat => prevEntries[cat]?.key !== specKeyFor(cat))
      if (stale.length === 0) {
        const reused: Record<string, CachedSpec> = {}
        for (const cat of categories) reused[cat] = prevEntries[cat].spec
        return reused
      }
      const fresh = await llm.generateStyleSpec(intent, categories).catch(err => {
        console.error('[spec] generation failed, proceeding without:', err)
        return {} as Record<string, CachedSpec>
      })
      console.log('[spec]', JSON.stringify(fresh), '| stale categories recomputed:', stale.join(', '))
      const merged: Record<string, CachedSpec> = {}
      const nextEntries: Record<string, { key: string; spec: CachedSpec }> = {}
      for (const cat of categories) {
        const useFresh = stale.includes(cat) || !prevEntries[cat]
        const spec = useFresh ? (fresh[cat] ?? { requiresAll: [], requiresAny: [], avoidances: [] }) : prevEntries[cat].spec
        merged[cat] = spec
        nextEntries[cat] = { key: specKeyFor(cat), spec }
      }
      specCache.set(intent.sessionId, nextEntries)
      return merged
    })(),

    // Budget: fit-aware per-category allocation.
    // Build fit-aware stats first (per-category search queries), then call allocateBudget.
    // Falls back to uniform maxPrice when catalog stats or budget are unavailable.
    (async (): Promise<Record<string, number>> => {
      if (!hasCatalogStats || budgetFacet == null) return {}
      const relevantStats: Record<string, { min: number; max: number; avg: number }> = {}
      await Promise.all(categories.map(async cat => {
        if (!catalogStats[cat]) return
        if (fitFilter) {
          const fitResults = await search.query({ category: cat, facets: { fit: fitFilter }, avoidances: globalAvoidances, limit: 200 }).catch(() => [])
          if (fitResults.length > 0) {
            const prices = fitResults.map(r => r.price)
            relevantStats[cat] = { min: Math.min(...prices), max: Math.max(...prices), avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) }
            return
          }
        }
        relevantStats[cat] = catalogStats[cat]
      }))
      const budgetKey = JSON.stringify({ budgetFacet, categories, relevantStats })
      const cachedBudget = budgetCache.get(intent.sessionId)
      if (cachedBudget?.key === budgetKey) return cachedBudget.allocation
      const alloc = await llm.allocateBudget(budgetFacet, categories, relevantStats).catch(() => ({}))
      console.log('[budget] fit-aware stats:', JSON.stringify(relevantStats))
      console.log('[budget] per-category allocation:', JSON.stringify(alloc))
      budgetCache.set(intent.sessionId, { key: budgetKey, allocation: alloc })
      return alloc
    })(),
  ])

  const assembled = await Promise.all(
    categories.map(async category => {
      // Build category-specific facets: use allocation if available, else base maxPrice
      const facets = { ...baseFacets }
      if (perCategoryMax[category] != null) facets.maxPrice = perCategoryMax[category]

      const catCC = categoryConstraints[category] ?? {}
      const catSpec = styleSpec[category]
      const avoidances = [...globalAvoidances, ...(catCC.avoidances ?? []), ...(catSpec?.avoidances ?? [])]
      // requiresAll (AND): explicit user constraints — global + per-category + spec's explicit read of intent.
      // requiresAny (OR): the shopper's own explicit alternatives (catCC.requiresAny, e.g. "jeans or
      // chinos") always apply — never suppressed. Spec's style-interpretation OR tags are suppressed
      // only when catCC already has a hard AND constraint for this category, to prevent style tags
      // diluting it; they coexist fine alongside the shopper's own OR alternatives.
      const requiresAll = [...globalRequiresTags, ...(catCC.requiresTags ?? []), ...(catSpec?.requiresAll ?? [])]
      const requiresAny = [
        ...(catCC.requiresAny ?? []),
        ...(catCC.requiresTags?.length ? [] : (catSpec?.requiresAny ?? [])),
      ]

      let products = await search.query({ category, facets, avoidances, requiresAll, requiresAny, limit: 10 })

      // Facets carried into every later retry. Once a retry proves a facet is starving the
      // row, it stays dropped — re-applying it below would re-create the exact starvation the
      // retry just escaped.
      let activeFacets = facets

      // Each retry relaxes a different constraint, but a looser query is NOT a superset of a
      // tighter one: dropping the spec's style tags re-queries with a different tag set and can
      // return fewer products than the previous attempt already found. Adopting unconditionally
      // therefore threw away products that were already in hand and shipped a thinner (often
      // empty) shopping-list row. Only take a retry that genuinely improves the row; on a tie,
      // keep the earlier, more precise result.
      const adopt = (candidate: typeof products) => {
        if (candidate.length > products.length) products = candidate
      }

      // Retry 1: drop budget filter if it's starving the row
      if (products.length < 3 && activeFacets.maxPrice != null) {
        const initialCount = products.length
        const relaxedFacets = { ...activeFacets }
        delete relaxedFacets.maxPrice
        const retried = await search.query({ category, facets: relaxedFacets, avoidances, requiresAll, requiresAny, limit: 10 })
        activeFacets = relaxedFacets
        adopt(retried)
        console.log(`[budget] ${category} returned ${initialCount} at maxPrice=${facets.maxPrice}, retried without price filter → ${retried.length} results`)
      }
      // Retry 2: drop spec avoidances and requiresAny if still starved — explicit requiresAll and the
      // shopper's own requiresAny (catCC.requiresAny) stay in force, only spec's style-interpretation
      // requiresAny is dropped.
      if (products.length < 3 && catSpec && (catSpec.requiresAny.length > 0 || catSpec.avoidances.length > 0)) {
        const baseAvoidances = [...globalAvoidances, ...(catCC.avoidances ?? [])]
        const retried = await search.query({ category, facets: activeFacets, avoidances: baseAvoidances, requiresAll, requiresAny: catCC.requiresAny ?? [], limit: 10 })
        adopt(retried)
        console.log(`[spec] ${category} still thin after budget retry, dropped spec requiresAny/avoidances → ${retried.length} results`)
      }
      // Retry 3: drop spec requiresAll too — last resort so categories are never empty
      if (products.length < 3 && catSpec?.requiresAll?.length) {
        const baseAvoidances = [...globalAvoidances, ...(catCC.avoidances ?? [])]
        const baseRequiresAll = [...globalRequiresTags, ...(catCC.requiresTags ?? [])]
        const retried = await search.query({ category, facets: activeFacets, avoidances: baseAvoidances, requiresAll: baseRequiresAll, requiresAny: catCC.requiresAny ?? [], limit: 10 })
        adopt(retried)
        console.log(`[spec] ${category} still empty, dropped spec requiresAll too → ${retried.length} results`)
      }
      // Retry 4: drop catCC.requiresTags and catCC.requiresAny too if the category is still completely
      // empty. These normally stay in force at every retry above because they represent the shopper's
      // own explicit ask (e.g. "slim pants only", "jeans or chinos" from chat) — dropping them would
      // show something that contradicts what was typed. But categoryConstraints also gets written to
      // from anchor items ("build around something you own"), where the tags are the LLM's own guess
      // at translating freeform language into search tags, not something the shopper typed — and that
      // guess isn't grounded in the catalog's real vocabulary the way generateStyleSpec() deliberately
      // is. A guess like ["dark","slim"] for "slim dark indigo jeans" can permanently zero out a
      // category, since real tags are always compound ("dark-indigo", never bare "dark") and this
      // constraint was otherwise never relaxed. Only fires when the category would otherwise be
      // entirely empty (< 1, not < 3) — a thin-but-nonempty result from an explicit constraint is left
      // alone.
      if (products.length < 1 && (catCC.requiresTags?.length || catCC.requiresAny?.length)) {
        const retried = await search.query({ category, facets: activeFacets, avoidances: globalAvoidances, requiresAll: globalRequiresTags, requiresAny: [], limit: 10 })
        adopt(retried)
        console.log(`[anchor] ${category} still empty, dropped category constraint requiresTags/requiresAny too → ${retried.length} results`)
      }
      // Retry 5: drop the styleFamily facet too, absolute last resort. Unlike fit (never
      // dropped — showing the wrong gender is a worse failure than an empty category), style
      // is a preference the catalog may simply not have coverage for in every category (e.g.
      // no "smart-casual"-tagged belts at all) — an empty shopping-list row is worse than one
      // stylistically-imperfect item in it, matching every other relaxable filter above.
      if (products.length < 1 && activeFacets.style) {
        const relaxedFacets = { ...activeFacets }
        delete relaxedFacets.style
        const retried = await search.query({ category, facets: relaxedFacets, avoidances: globalAvoidances, requiresAll: globalRequiresTags, requiresAny: [], limit: 10 })
        activeFacets = relaxedFacets
        adopt(retried)
        console.log(`[style] ${category} still empty, dropped style facet too → ${retried.length} results`)
      }

      const productNames = products.slice(0, 4).map(p => p.name)

      // CMS content is matched AFTER products are finalized (all retries done), not before —
      // matching only on category/goal/style can't tell "Pants" resolved to jeans vs shorts vs
      // chinos. Product tags are the real signal: a jean-fit guide tagged "jeans"/"denim" now
      // only surfaces when the actual shown products carry those tags, regardless of whether
      // the shopper ever typed the word "jeans".
      //
      // The style signal is namespaced ("style:coastal beach casual") rather than passed bare.
      // A bare style name can collide with an unrelated raw product tag that happens to share the
      // same word — e.g. shirts are commonly tagged "smart-casual" as a general versatility
      // descriptor regardless of the shopper's actually-selected style, which wrongly matched a
      // "Smart Casual" guide against a "Coastal Beach Casual" outfit. No product will ever carry
      // a tag starting with "style:", so the namespace makes that collision structurally
      // impossible — CMS entries opt in by tagging themselves "style:<name>" to match precisely.
      const styleTag = typeof intent.constraints.style === 'string' ? `style:${intent.constraints.style.toLowerCase()}` : undefined
      const productTags = Array.from(new Set(products.flatMap(p => p.tags)))
      const cmsTags = styleTag ? [styleTag, ...productTags] : productTags

      const [cmsContent, { rationale, filterChips }] = await Promise.all([
        // 4, not 2 — goal/style are session-global signals every category legitimately
        // matches, so 2 slots can fill entirely with universal guides (e.g. an occasion
        // guide + a style guide) before a category-specific match (e.g. a jean-fit
        // how-to) ever gets counted. All categories' results get deduped together in the
        // UI, so a slightly higher per-category cap costs nothing there.
        cms.getContent({ goal: intent.goal, category, tags: cmsTags, limit: 4 }).catch(() => []),
        llm.generateCategoryMeta(intent, category, productNames).catch(() => ({ rationale: undefined, filterChips: [] as string[] })),
      ])

      return {
        name: category,
        displayName: categoryDisplayName(category, intent.constraints.categoryConstraints?.[category]?.requiresTags),
        displayRole: 'supporting' as const,  // placeholder — overwritten below
        weight: 5,
        products: products.slice(0, 4),
        scrollProducts: products.slice(4),
        cmsContent,
        showAllUrl: buildShowAllUrl(category, intent),
        rationale,
        filterChips: filterChips ?? [],
      }
    })
  )

  // Assign collage roles + weights in one call across all assembled categories.
  const roles = await llm.assignCollageRoles(intent, categories).catch(err => {
    console.error('[collage roles] assignment failed, using defaults:', err)
    return {} as Record<string, { displayRole: 'hero' | 'supporting' | 'accent'; weight: number }>
  })

  // Drop rows that found nothing. Every retry above has already run, so an empty row here means
  // the catalog genuinely has no vocabulary for that category — usually one the model invented
  // (the chat prompt warns it twice about "trousers"). CollageView renders such a row as a blank
  // tile, and nothing else between here and render filters it. Dropping is also what lets the
  // callers' "no results → intent-update" fallback fire: the row count previously equalled the
  // requested category count no matter what was found, so it could never reach zero.
  const populated = assembled.filter(cat => cat.products.length > 0)
  if (populated.length !== assembled.length) {
    const dropped = assembled.filter(cat => cat.products.length === 0).map(cat => cat.name)
    console.warn(`[assemble] dropped categories with no catalog match: ${dropped.join(', ')}`)
  }

  return populated.map(cat => ({
    ...cat,
    displayRole: roles[cat.name]?.displayRole ?? cat.displayRole,
    weight: roles[cat.name]?.weight ?? cat.weight,
  }))
}

/** Extracts the upper numeric bound from budget strings like "Under $500", "$400–$800", "No set limit". */
export function parseBudgetUpperBound(budget: unknown): number {
  if (!budget || typeof budget !== 'string') return Infinity
  if (/no.*(set\s+)?limit/i.test(budget) || /^over/i.test(budget)) return Infinity
  const nums = [...budget.matchAll(/\d[\d,]*/g)].map(m => parseInt(m[0].replace(/,/g, '')))
  return nums.length > 0 ? Math.max(...nums) : Infinity
}

/**
 * Calls the fast LLM to select specific product combinations across categories.
 * Resolves returned IDs to full SearchResult objects, computes totals, and applies
 * budget-status tiers: on-budget (≤100%), aspirational (>140%). Budget is the softest constraint.
 * Falls back to index-based pairing if curation fails or returns bad IDs.
 */

export async function buildCuratedOutfits(
  intent: IntentModel,
  categoryResults: CategoryResult[]
): Promise<CuratedOutfit[]> {
  const budget = parseBudgetUpperBound(intent.constraints.budget)

  // Slim product lists for the LLM prompt (no images, no rationale text)
  const categoryProducts = categoryResults.map(cat => ({
    category: cat.name,
    products: [...cat.products, ...cat.scrollProducts].map(p => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      tags: p.tags,
      price: p.price,
      currency: p.currency,
    })),
  }))

  let curatedSlots: { name: string; rationale: string; slots: Record<string, string> }[] = []
  try {
    const previousOutfits = curatedOutfitCache.get(intent.sessionId)
    curatedSlots = await llm.curateOutfits(intent, budget, categoryProducts, previousOutfits)
    curatedOutfitCache.set(intent.sessionId, curatedSlots.map(({ name, slots }) => ({ name, slots })))
  } catch (err) {
    console.error('[curation error]', err)
  }

  // Resolve IDs → full product objects, compute total, budget status
  const outfits: CuratedOutfit[] = curatedSlots.map(({ name, rationale, slots }) => {
    const items: CuratedOutfit['items'] = []
    let totalPrice = 0

    for (const cat of categoryResults) {
      const allProducts = [...cat.products, ...cat.scrollProducts]
      const selectedId = slots[cat.name]
      // Resolve the curated id within THIS category only. Resolving against a lookup spanning
      // every category (as this used to) meant an id the curation model put in the wrong slot
      // rendered e.g. a pair of pants in the top slot — an outfit with two pairs of pants and no
      // shirt. A mismatched id now falls through to the category's own top product, same as an
      // unknown one.
      const selected = selectedId ? allProducts.find(p => p.id === selectedId) : undefined
      const product = selected ?? allProducts[0]
      if (!product) continue
      items.push({ category: cat.name, product })
      totalPrice += product.price
    }

    if (items.length === 0) return null

    let budgetStatus: CuratedOutfit['budgetStatus'] = 'on-budget'
    if (budget < Infinity && totalPrice > budget * 1.40) budgetStatus = 'aspirational'

    return { name, rationale, budgetStatus, totalPrice, items }
  }).filter((o): o is CuratedOutfit => o !== null)

  // Fallback: index-based pairing if curation returned nothing
  if (outfits.length === 0) {
    const allCatProducts = categoryResults.map(cat => [...cat.products, ...cat.scrollProducts])
    const maxSlots = Math.min(3, Math.max(...allCatProducts.map(p => p.length), 0))
    for (let i = 0; i < maxSlots; i++) {
      const items = categoryResults
        .map((cat, ci) => ({ category: cat.name, product: allCatProducts[ci][i] }))
        .filter(({ product }) => product != null)
      if (items.length === 0) continue
      const totalPrice = items.reduce((s, { product }) => s + product.price, 0)
      let budgetStatus: CuratedOutfit['budgetStatus'] = 'on-budget'
      if (budget < Infinity && totalPrice > budget * 1.40) budgetStatus = 'aspirational'
      outfits.push({ name: '', rationale: '', budgetStatus, totalPrice, items })
    }
  }

  return outfits
}
