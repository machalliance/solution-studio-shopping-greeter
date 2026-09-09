// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { safeUrl } from '../src/components/safeUrl'
import { CollageView } from '../src/components/CollageView'
import { CMSCardView } from '../src/components/CMSCardView'
import { ResultsView } from '../src/components/ResultsView'
import type { CategoryResult, SearchResult, ContentResult } from '../src/types/intent'

/**
 * Regression coverage for the same class of bug tests/host-page-escaping.test.ts covers on the
 * static host pages: a catalog/CMS record's own `url` field interpolated straight into an
 * anchor's href with no guard. React escapes the attribute, but that only stops it being broken
 * out of — a `javascript:` URL needs no quote break-out to execute, same as the host pages'
 * original bug. Reachable under USE_FIXTURES=false, where the record comes from Algolia/
 * Contentstack rather than from this repo.
 */

const JS_URL = 'javascript:window.__xss=1'

afterEach(cleanup)

describe('safeUrl()', () => {
  it('passes through a same-origin relative path', () => {
    expect(safeUrl('/products/tan-suede-penny-loafer')).toBe('/products/tan-suede-penny-loafer')
  })
  it('passes through an explicit http(s) URL', () => {
    expect(safeUrl('https://example.com/p/1')).toBe('https://example.com/p/1')
  })
  it('strips a javascript: URL', () => {
    expect(safeUrl(JS_URL)).toBe('')
  })
  it('strips a protocol-relative URL (not same-origin)', () => {
    expect(safeUrl('//evil.example/p/1')).toBe('')
  })
  it('strips undefined/null/empty', () => {
    expect(safeUrl(undefined)).toBe('')
    expect(safeUrl(null)).toBe('')
    expect(safeUrl('')).toBe('')
  })
})

const product = (url: string): SearchResult => ({
  id: 'p1', name: 'Test Product', price: 100, currency: 'USD',
  category: 'top', images: [], url, tags: [], inStock: true,
})

const category = (url: string): CategoryResult => ({
  name: 'top', displayName: 'Top', displayRole: 'hero', weight: 8,
  products: [product(url)], scrollProducts: [], cmsContent: [], showAllUrl: '/search?q=top',
})

const content = (url: string): ContentResult => ({
  uid: 'c1', title: 'Test Guide', url, contentType: 'how_to', summary: '', tags: [],
})

describe('widget href wiring', () => {
  it('CollageView never renders a javascript: href for a product', () => {
    const { container } = render(<CollageView categories={[category(JS_URL)]} skin="project" />)
    const anchors = [...container.querySelectorAll('a')]
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) expect(a.getAttribute('href')).not.toContain('javascript:')
  })

  it('CMSCardView never renders a javascript: href for a CMS entry', () => {
    const { container } = render(<CMSCardView content={content(JS_URL)} skin="project" />)
    const a = container.querySelector('a')
    expect(a).toBeTruthy()
    expect(a!.getAttribute('href')).not.toContain('javascript:')
  })

  it('ResultsView never renders a javascript: href in a collage product chip', () => {
    const { container } = render(
      <ResultsView categories={[category(JS_URL)]} curatedOutfits={[]} intent={null} loading={false} skin="project" />
    )
    const anchors = [...container.querySelectorAll('a.g-collage-chip')]
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) expect(a.getAttribute('href')).not.toContain('javascript:')
  })
})
