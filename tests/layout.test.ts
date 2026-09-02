import { describe, it, expect } from 'vitest'
import { buildShowAllUrl, buildSearchFacets } from '../src/agent/layout.js'
import type { IntentModel } from '../src/types/intent.js'

function intent(
  constraints: IntentModel['constraints'],
  goalType: IntentModel['goalType'] = 'style',
): IntentModel {
  return { goal: 'test goal', goalType, constraints, sessionId: 's1' }
}

/** Parse the /search URL back into its decoded query params. */
function params(url: string): URLSearchParams {
  return new URL(url, 'http://greeter.test').searchParams
}

describe('buildSearchFacets — budget', () => {
  it('uses the single number in an "Under $X" label as maxPrice', () => {
    expect(buildSearchFacets(intent({ budget: 'Under $2,000' })).maxPrice).toBe(2000)
  })

  it('takes the upper bound of a range, stripping thousands separators', () => {
    expect(buildSearchFacets(intent({ budget: '$1,000-$2,500' })).maxPrice).toBe(2500)
    expect(buildSearchFacets(intent({ budget: '$1,000–$2,500' })).maxPrice).toBe(2500)
  })

  it('takes the largest number regardless of the order it appears in the label', () => {
    expect(buildSearchFacets(intent({ budget: 'up to $900, ideally under $450' })).maxPrice).toBe(900)
  })

  it('omits the maxPrice facet entirely for "No set limit"', () => {
    const facets = buildSearchFacets(intent({ budget: 'No set limit' }))
    expect('maxPrice' in facets).toBe(false)
  })

  it('omits the maxPrice facet entirely when no budget was captured', () => {
    const facets = buildSearchFacets(intent({ styleFamily: 'Coastal' }))
    expect('maxPrice' in facets).toBe(false)
  })

  it('ignores a non-string budget value rather than crashing', () => {
    const facets = buildSearchFacets(intent({ budget: ['$500'] as unknown as string }))
    expect('maxPrice' in facets).toBe(false)
  })

  // "Over $5,000" is one of the four project budget chips the server itself injects
  // (server.ts budgetChoices). It names a FLOOR, so it must not become a ceiling —
  // parseBudgetUpperBound in server.ts already reads it as Infinity, and the two must agree
  // or the top budget tier is capped lower than "No set limit".
  it.each([
    'Over $5,000',
    'over $5,000',
    'Over $800',
  ])('omits the maxPrice facet for the open-ended label %s', label => {
    const facets = buildSearchFacets(intent({ budget: label }))
    expect('maxPrice' in facets).toBe(false)
  })

  it('still treats a label that merely contains "over" as a ceiling', () => {
    // "Just over" is a bound, not an open tier — only a leading "over" opens the range.
    expect(buildSearchFacets(intent({ budget: 'Just over $300' })).maxPrice).toBe(300)
  })
})

describe('buildSearchFacets — fit', () => {
  it.each([
    ["Women's", 'womens'],
    ['Womenswear', 'womens'],
    ['female', 'womens'],
    ['Woman', 'womens'],
    ["Men's", 'mens'],
    ['Menswear', 'mens'],
    ['male', 'mens'],
    ['No preference', 'unisex'],
    ['Anything', 'unisex'],
  ])('normalises %s to %s', (label, expected) => {
    expect(buildSearchFacets(intent({ fit: label })).fit).toBe(expected)
  })

  it('never resolves a label containing "women" to mens, even when it also names men', () => {
    expect(buildSearchFacets(intent({ fit: "Women's and men's" })).fit).toBe('womens')
    expect(buildSearchFacets(intent({ fit: 'women or men' })).fit).toBe('womens')
  })

  it('omits the fit facet when no fit-like constraint is present', () => {
    expect('fit' in buildSearchFacets(intent({ budget: 'Under $500' }))).toBe(false)
  })

  it('reads fit from the first present alias in fit > gender > shopFor > shoppingFor > fitPreference order', () => {
    expect(buildSearchFacets(intent({ fit: "Women's", gender: "Men's" })).fit).toBe('womens')
    expect(buildSearchFacets(intent({ gender: "Men's", shopFor: "Women's" })).fit).toBe('mens')
    expect(buildSearchFacets(intent({ shopFor: "Women's", shoppingFor: "Men's" })).fit).toBe('womens')
    expect(buildSearchFacets(intent({ shoppingFor: "Men's", fitPreference: "Women's" })).fit).toBe('mens')
    expect(buildSearchFacets(intent({ fitPreference: "Women's" })).fit).toBe('womens')
  })

  it('falls through an empty-string alias to the next populated one', () => {
    expect(buildSearchFacets(intent({ fit: '', gender: "Men's" })).fit).toBe('mens')
  })
})

describe('buildSearchFacets — style', () => {
  it('slugifies styleFamily to lowercase hyphenated form', () => {
    expect(buildSearchFacets(intent({ styleFamily: 'Smart casual' })).style).toBe('smart-casual')
    expect(buildSearchFacets(intent({ styleFamily: 'Coastal' })).style).toBe('coastal')
    expect(buildSearchFacets(intent({ styleFamily: 'Modern  Scandi Minimal' })).style)
      .toBe('modern-scandi-minimal')
  })

  it('does NOT derive a style facet from a free-form `style` sub-direction', () => {
    // "City Smart" is a model-invented sub-direction the catalog has no vocabulary for;
    // faceting on it would zero out every search.
    const facets = buildSearchFacets(intent({ style: 'City Smart' }))
    expect('style' in facets).toBe(false)
  })

  it('prefers styleFamily and ignores a conflicting free-form style', () => {
    const facets = buildSearchFacets(intent({ styleFamily: 'Smart casual', style: 'City Smart' }))
    expect(facets.style).toBe('smart-casual')
  })
})

describe('buildSearchFacets — facet surface', () => {
  it('applies only fit, maxPrice and style, never colour/warmth/finish/material', () => {
    const facets = buildSearchFacets(intent({
      fit: "Women's",
      budget: '$1,000-$2,500',
      styleFamily: 'Smart casual',
      colourDirection: 'warm neutrals',
      colour: 'oat',
      warmth: 'very warm',
      finish: 'matte',
      material: 'merino',
      style: 'City Smart',
    }))
    expect(facets).toEqual({ fit: 'womens', maxPrice: 2500, style: 'smart-casual' })
  })

  it('returns an empty facet object when nothing constrains the search', () => {
    expect(buildSearchFacets(intent({ colourDirection: 'earthy', finish: 'matte' }))).toEqual({})
  })
})

describe('buildShowAllUrl', () => {
  it('uses the project skin for project goals and the clothing skin otherwise', () => {
    expect(params(buildShowAllUrl('shelving', intent({}, 'project'))).get('skin')).toBe('project')
    expect(params(buildShowAllUrl('jacket', intent({}, 'style'))).get('skin')).toBe('clothing')
  })

  it('sends the category through as the search query, encoded safely', () => {
    const p = params(buildShowAllUrl('outerwear & knitwear', intent({})))
    expect(p.get('q')).toBe('outerwear & knitwear')
  })

  it('carries fit, budget, colour and style through as decoded params', () => {
    const p = params(buildShowAllUrl('coat', intent({
      fit: "Women's",
      budget: 'Under $2,000',
      colourDirection: 'warm neutrals',
      styleFamily: 'Smart casual',
    })))
    expect(p.get('q')).toBe('coat')
    expect(p.get('fit')).toBe('womens')
    expect(p.get('maxPrice')).toBe('2000')
    expect(p.get('colour')).toBe('warm neutrals')
    expect(p.get('style')).toBe('smart-casual')
  })

  it('emits only q and skin when there are no constraints', () => {
    const p = params(buildShowAllUrl('boots', intent({})))
    expect([...p.keys()].sort()).toEqual(['q', 'skin'])
  })

  it('resolves colour from colourDirection > color > colour', () => {
    expect(params(buildShowAllUrl('coat', intent({ colourDirection: 'warm neutrals', color: 'navy', colour: 'oat' }))).get('colour'))
      .toBe('warm neutrals')
    expect(params(buildShowAllUrl('coat', intent({ color: 'navy', colour: 'oat' }))).get('colour'))
      .toBe('navy')
    expect(params(buildShowAllUrl('coat', intent({ colour: 'oat' }))).get('colour'))
      .toBe('oat')
  })

  it('resolves fit from the first present alias and normalises it', () => {
    expect(params(buildShowAllUrl('coat', intent({ gender: "Men's", shopFor: "Women's" }))).get('fit'))
      .toBe('mens')
    expect(params(buildShowAllUrl('coat', intent({ shoppingFor: 'female' }))).get('fit'))
      .toBe('womens')
    expect(params(buildShowAllUrl('coat', intent({ fitPreference: 'No preference' }))).get('fit'))
      .toBe('unisex')
  })

  it('falls back to a free-form style for the browse link even without styleFamily', () => {
    // The URL is a human-facing browse link, unlike the search facets, so the
    // sub-direction is allowed to travel here.
    expect(params(buildShowAllUrl('coat', intent({ style: 'City Smart' }))).get('style'))
      .toBe('city-smart')
  })

  it('sends an empty maxPrice — not a zero — for an unparseable budget so no price filter applies', () => {
    const p = params(buildShowAllUrl('coat', intent({ budget: 'No set limit' })))
    expect(p.get('maxPrice')).toBe('')
  })

  it('ignores non-string constraint values such as categoryConstraints', () => {
    const p = params(buildShowAllUrl('coat', intent({
      categoryConstraints: { coat: { requiresTags: ['wool'] } },
      style: ['Coastal'] as unknown as string,
      fit: "Women's",
    })))
    expect(p.has('style')).toBe(false)
    expect(p.get('fit')).toBe('womens')
  })
})
