import { describe, it, expect } from 'vitest'
import { buildChatPrompt, categoryDisplayName, type CatalogStatsSlim } from '../src/agent/intent.js'
import type { IntentModel } from '../src/types/intent.js'

function makeIntent(overrides: Partial<IntentModel> = {}): IntentModel {
  return {
    goal: 'rooftop wedding guest outfit',
    goalType: 'style',
    constraints: { style: 'Coastal Chic' },
    sessionId: 'sess-123',
    ...overrides,
  }
}

const stats: CatalogStatsSlim = {
  vanity: { min: 300, max: 1800, avg: 900 },
  jacket: { min: 80, max: 420, avg: 190 },
  telescope: { min: 55, max: 5000, avg: 700 },
}

describe('categoryDisplayName', () => {
  it('capitalises a plain slug', () => {
    expect(categoryDisplayName('jacket')).toBe('Jacket')
    expect(categoryDisplayName('faucet')).toBe('Faucet')
  })

  it('normalises casing rather than passing the slug through', () => {
    expect(categoryDisplayName('SHOES')).toBe('Shoes')
    expect(categoryDisplayName('PaNtS')).toBe('Pants')
  })

  it('renders the dress category as Dress when no skirt constraint is present', () => {
    expect(categoryDisplayName('dress')).toBe('Dress')
    expect(categoryDisplayName('dress', [])).toBe('Dress')
    expect(categoryDisplayName('dress', ['linen', 'midi'])).toBe('Dress')
  })

  it('renders the dress category as Skirt when the shopper narrowed it to skirt', () => {
    expect(categoryDisplayName('dress', ['skirt'])).toBe('Skirt')
    expect(categoryDisplayName('dress', ['linen', 'skirt'])).toBe('Skirt')
    expect(categoryDisplayName('DRESS', ['skirt'])).toBe('Skirt')
  })

  it('only applies the skirt label to the dress category', () => {
    expect(categoryDisplayName('top', ['skirt'])).toBe('Top')
    expect(categoryDisplayName('pants', ['skirt'])).toBe('Pants')
  })

  it('does not throw on an empty slug', () => {
    expect(categoryDisplayName('')).toBe('')
  })
})

describe('buildChatPrompt — catalog stats block', () => {
  it('omits the price-range block entirely when no stats are supplied', () => {
    const prompt = buildChatPrompt(makeIntent(), [], {}, [])
    expect(prompt).not.toContain('CATALOG PRICE RANGES')
  })

  it('injects the price-range block when stats are supplied', () => {
    const prompt = buildChatPrompt(makeIntent(), [], stats, [])
    expect(prompt).toContain('CATALOG PRICE RANGES')
  })

  it('groups categories into Home / Fashion / Other', () => {
    const prompt = buildChatPrompt(makeIntent(), [], stats, [])
    expect(prompt).toMatch(/^Home: vanity \$300–\$1800$/m)
    expect(prompt).toMatch(/^Fashion: jacket \$80–\$420$/m)
    expect(prompt).toMatch(/^Other: telescope \$55–\$5000$/m)
  })

  it('puts an unknown category under Other, never under Home or Fashion', () => {
    const prompt = buildChatPrompt(makeIntent(), [], { telescope: { min: 55, max: 5000, avg: 700 } }, [])
    expect(prompt).toMatch(/^Other: telescope \$55–\$5000$/m)
    expect(prompt).not.toContain('Home: telescope')
    expect(prompt).not.toContain('Fashion: telescope')
  })

  it('emits only the groups that have members', () => {
    const prompt = buildChatPrompt(makeIntent(), [], { mirror: { min: 40, max: 250, avg: 90 } }, [])
    expect(prompt).toMatch(/^Home: mirror \$40–\$250$/m)
    // the static AVAILABLE CATEGORIES section also starts a line with "Fashion:",
    // so match only lines carrying a price range
    expect(prompt).not.toMatch(/^Fashion: .*\$\d/m)
    expect(prompt).not.toMatch(/^Other: /m)
  })

  it('joins multiple categories in the same group with a pipe separator', () => {
    const prompt = buildChatPrompt(makeIntent(), [], {
      top: { min: 20, max: 120, avg: 55 },
      shoes: { min: 60, max: 340, avg: 150 },
    }, [])
    expect(prompt).toMatch(/^Fashion: top \$20–\$120 \| shoes \$60–\$340$/m)
  })

  it('formats the exact min/max passed, not the average', () => {
    const prompt = buildChatPrompt(makeIntent(), [], { tile: { min: 7, max: 99, avg: 42 } }, [])
    expect(prompt).toContain('tile $7–$99')
    expect(prompt).not.toContain('42')
  })
})

describe('buildChatPrompt — prior selections', () => {
  it('omits the selections block when there are none', () => {
    const prompt = buildChatPrompt(makeIntent(), [], {}, [])
    expect(prompt).not.toContain('SELECTIONS CONFIRMED BY CLICK')
  })

  it('injects selections as a 1-based numbered ground-truth list in order', () => {
    const prompt = buildChatPrompt(makeIntent(), ['Coastal', "Women's", 'Might get cool'], {}, [])
    expect(prompt).toContain('SELECTIONS CONFIRMED BY CLICK — treat as ground truth:')
    expect(prompt).toContain('  1. Coastal')
    expect(prompt).toContain("  2. Women's")
    expect(prompt).toContain('  3. Might get cool')
    expect(prompt.indexOf('1. Coastal')).toBeLessThan(prompt.indexOf('3. Might get cool'))
  })
})

describe('buildChatPrompt — current intent', () => {
  it('serialises the passed intent as JSON', () => {
    const intent = makeIntent({ goal: 'bathroom refresh', goalType: 'project', sessionId: 'abc-999' })
    const prompt = buildChatPrompt(intent, [], {}, [])
    expect(prompt).toContain('Current intent:')
    expect(prompt).toContain(JSON.stringify(intent, null, 2))
    expect(prompt).not.toContain('No intent yet')
  })

  it('shows the empty-state wording when intent is null', () => {
    const prompt = buildChatPrompt(null, [], {}, [])
    expect(prompt).toContain('No intent yet — build it from the opening message.')
    expect(prompt).not.toContain('Current intent:')
  })
})

describe('buildChatPrompt — refinement block', () => {
  it('omits the refinement block when no categories are assembled', () => {
    const prompt = buildChatPrompt(makeIntent(), [], {}, [])
    expect(prompt).not.toContain('REFINEMENT')
  })

  it('lists the currently assembled categories in order', () => {
    const prompt = buildChatPrompt(makeIntent(), [], {}, ['jacket', 'top', 'pants', 'shoes'])
    expect(prompt).toContain('REFINEMENT — categories currently assembled: jacket, top, pants, shoes')
  })
})

describe('buildChatPrompt — defaults', () => {
  it('produces the empty-state variant of every conditional block when called with intent only', () => {
    const prompt = buildChatPrompt(makeIntent())
    expect(prompt).not.toContain('CATALOG PRICE RANGES')
    expect(prompt).not.toContain('SELECTIONS CONFIRMED BY CLICK')
    expect(prompt).not.toContain('REFINEMENT')
    expect(prompt).toContain('Current intent:')
  })

  it('still contains the invariant instruction scaffolding', () => {
    const prompt = buildChatPrompt(null)
    expect(prompt).toContain('AVAILABLE CATEGORIES')
    expect(prompt).toContain('CATEGORY SELECTION')
    expect(prompt).toContain('CATEGORY CONSTRAINT SCOPING')
    expect(prompt.length).toBeGreaterThan(500)
  })
})
