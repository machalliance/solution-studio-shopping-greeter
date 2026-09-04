import { describe, it, expect } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Output-escaping regression tests for the three mockup host pages.
 *
 * These pages build their markup as template strings and assign it to innerHTML. Catalog
 * records (search.html, product.html) and CMS entries (guide.html) are interpolated straight
 * in, and originally none of it was escaped — a product whose `name` contained
 * `<img src=x onerror=...>` executed it. With USE_FIXTURES=false those records come from
 * Algolia and Contentstack rather than from this repo, so the fields are genuinely untrusted.
 *
 * The pages are loaded from disk and their real scripts are executed, rather than the templates
 * being reimplemented here: a test that duplicated the markup would keep passing after someone
 * dropped an unescaped field back into the actual page.
 *
 * Detection is structural rather than execution-based. jsdom does not fetch images, so an
 * `onerror` payload would not fire here even if it were live; asserting that the payload never
 * becomes an element — and survives as text — catches the bug without depending on that.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Several vectors at once: element injection, attribute break-out, and a javascript: URL. */
const PAYLOAD = `<img src=x onerror="window.__xss=1">`
const ATTR_BREAKOUT = `" onmouseover="window.__xss=1" x="`
const JS_URL = `javascript:window.__xss=1`

interface LoadResult {
  dom: JSDOM
  doc: Document
  win: Window & { __xss?: number }
}

/**
 * Loads one host page in jsdom with its inline scripts running and `fetch` stubbed to hand
 * back `payload` for any request. Resolves once the page's own fetch chain has settled.
 */
async function loadPage(file: string, path: string, payload: unknown): Promise<LoadResult> {
  const html = readFileSync(join(ROOT, 'host', file), 'utf-8')

  // The pages pull in a CDN stylesheet and a webfont; jsdom is left with resource loading off
  // (the default) so neither is fetched. Errors from that are noise, not signal.
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {})

  const dom = new JSDOM(html, {
    url: `http://localhost:3003${path}`,
    runScripts: 'dangerously',
    // setSkin() drives its transition through requestAnimationFrame, which jsdom only
    // provides in visual mode. Without this the skin setup throws and no page ever renders.
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      ;(window as any).__xss = 0
      ;(window as any).fetch = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(payload),
        })
    },
  })

  // Let the page's fetch().then() chain and any rAF callbacks flush.
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))

  return { dom, doc: dom.window.document, win: dom.window as any }
}

/**
 * The assertions every page shares once it has rendered an attacker-controlled record.
 *
 * Inline handlers are checked for the payload's marker rather than for their mere presence:
 * these pages legitimately ship `onerror="this.style.display='none'"` on their own image tags,
 * so a blanket `[onerror]` assertion would fail on correct markup.
 */
function expectInert({ doc, win }: LoadResult) {
  // Nothing executed.
  expect(win.__xss).toBe(0)
  // The payload never became an element.
  expect(doc.querySelector('img[src="x"]')).toBeNull()
  // No event-handler attribute anywhere carries the injected script. Only `on*` attributes are
  // checked: the payload legitimately survives as inert text elsewhere — inside a quoted `alt`,
  // or percent-encoded inside a URL — and that is the fix working, not a finding.
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (!attr.name.toLowerCase().startsWith('on')) continue
      expect(attr.value).not.toContain('__xss')
    }
  }
  // No javascript: URL survived into a link or image.
  for (const el of doc.querySelectorAll('a[href], img[src]')) {
    const url = el.getAttribute('href') ?? el.getAttribute('src') ?? ''
    expect(url.toLowerCase().startsWith('javascript:')).toBe(false)
  }
}

describe('search.html escapes the catalog records it renders', () => {
  const hostile = {
    hits: [{
      id: 'x-1',
      name: `Hostile ${PAYLOAD}`,
      brand: `Brand ${PAYLOAD}`,
      description: `Desc ${PAYLOAD}`,
      category: `mirror${ATTR_BREAKOUT}`,
      price: 100,
      currency: 'USD',
      images: [JS_URL],
      url: JS_URL,
      tags: [PAYLOAD],
      inStock: true,
    }],
    nbHits: 1,
    styleRelaxed: false,
    requestedStyle: null,
  }

  it('renders a hostile product name as text, not markup', async () => {
    const page = await loadPage('search.html', '/search?q=mirror', hostile)
    expectInert(page)
    expect(page.doc.body.textContent).toContain(PAYLOAD)
  })

  it('still escapes the query-string labels it always escaped', async () => {
    const page = await loadPage(
      'search.html',
      `/search?q=${encodeURIComponent(PAYLOAD)}&style=${encodeURIComponent(PAYLOAD)}`,
      { hits: [], nbHits: 0, styleRelaxed: false, requestedStyle: null },
    )
    expectInert(page)
  })
})

describe('product.html escapes the catalog record it renders', () => {
  const hostile = {
    id: 'x-2',
    name: `Hostile ${PAYLOAD}`,
    brand: `Brand ${PAYLOAD}`,
    description: `Desc ${PAYLOAD}`,
    category: `vanity${ATTR_BREAKOUT}`,
    price: 200,
    currency: 'USD',
    images: [JS_URL],
    url: JS_URL,
    tags: [PAYLOAD, 'safe-tag'],
    inStock: true,
  }

  it('renders a hostile product as text, not markup', async () => {
    const page = await loadPage('product.html', '/products/hostile-item', hostile)
    expectInert(page)
    expect(page.doc.body.textContent).toContain(PAYLOAD)
  })

  it('escapes the slug in the not-found state', async () => {
    const page = await loadPage('product.html', '/products/nope', { error: 'not found' })
    expectInert(page)
  })
})

describe('guide.html escapes the CMS entry it renders', () => {
  const hostile = {
    title: `Hostile ${PAYLOAD}`,
    summary: `Summary ${PAYLOAD}`,
    url: `/guides/../../${PAYLOAD}`,
    contentType: `buying_guide${ATTR_BREAKOUT}`,
    readTime: `5 min ${PAYLOAD}`,
    icon: `book${ATTR_BREAKOUT}`,
    tags: [PAYLOAD, 'safe-tag'],
  }

  it('renders a hostile CMS entry as text, not markup', async () => {
    const page = await loadPage('guide.html', '/guides/hostile', hostile)
    expectInert(page)
    expect(page.doc.body.textContent).toContain(PAYLOAD)
  })

  it('keeps a hostile entry url inside the hero image path segment', async () => {
    const page = await loadPage('guide.html', '/guides/hostile', hostile)
    const hero = page.doc.querySelector('.guide-hero img')
    // The convention is /images/guides/<one segment>.png — the payload must not escape it.
    expect(hero?.getAttribute('src')).toMatch(/^\/images\/guides\/[^/]*\.png$/)
  })

  it('escapes the request path in the not-found state', async () => {
    const page = await loadPage('guide.html', '/guides/nope', { error: 'not found' })
    expectInert(page)
  })
})
