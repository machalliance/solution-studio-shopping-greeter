// Composition root: builds the Hono app, mounts the routes, and starts the server.
// The two large handlers live in ./server/routes; everything they share (adapters, session
// stores, catalog stats, assembly) lives in ./server/*. This file re-exports the pieces the
// test suite and any external caller reach for, so the module's public surface is unchanged
// by the split.
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IntentModel } from './types/intent.js'
import {
  ROOT, FIXTURES_DIR, IMAGES_SERVE_ROOT, STYLE_SRC, getPanelHtml, useFixtures, zeroResultsAction,
  activeProvider, llm, search, cms, setProvider, type ProviderKey,
} from './server/config.js'
import { catalogStats, buildCatalogStats } from './server/catalogStats.js'
import { intentStore, lastEvents, rawReplies, requestLog } from './server/stores.js'
import { registerChatRoute } from './server/routes/chat.js'
import { registerShowMeNowRoute } from './server/routes/showMeNow.js'

export { assembleResults, buildCuratedOutfits, parseBudgetUpperBound } from './server/assemble.js'
export type { ProviderKey } from './server/config.js'
export type { CategoryStats, CatalogStats } from './server/catalogStats.js'

buildCatalogStats().catch(err => console.error('[catalog] build failed:', err))

export const app = new Hono()

app.get('/health', c => c.json({ ok: true, fixtures: useFixtures, provider: activeProvider, intents: intentStore.size, catalogCategories: Object.keys(catalogStats).length }))
app.get('/api/catalog-stats', c => c.json(catalogStats))
app.post('/api/catalog-stats/refresh', async c => {
  await buildCatalogStats()
  return c.json({ ok: true, categories: Object.keys(catalogStats) })
})
app.get('/debug/intents', c => c.json(Object.fromEntries(intentStore)))
app.get('/debug/events', c => c.json(Object.fromEntries(lastEvents)))
app.get('/debug/requests', c => c.json(requestLog))
app.get('/debug/raw', c => c.json(Object.fromEntries(rawReplies)))
const SWATCH_WRAP_JS = `(function(){
  function wrap(img){
    if(img.parentElement&&img.parentElement.classList.contains('g-swatch'))return;
    var d=document.createElement('div');
    d.className='g-swatch';
    img.parentNode.insertBefore(d,img);
    d.appendChild(img);
  }
  function scan(root){
    if(root.querySelectorAll)root.querySelectorAll('img.g-swatch-img').forEach(wrap);
  }
  new MutationObserver(function(ms){
    ms.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1)return;
        if(n.matches&&n.matches('img.g-swatch-img'))wrap(n);else scan(n);
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});
})();`

app.get('/panel', c => {
  const liveCss = readFileSync(STYLE_SRC, 'utf-8')
  const html = getPanelHtml()
    .replace('</head>', `<style>${liveCss}</style></head>`)
    .replace('</body>', `<script>${SWATCH_WRAP_JS}</script></body>`)
  return c.html(html, 200, { 'Cache-Control': 'no-store' })
})
app.get('/', async c => c.html(await readFile(join(ROOT, 'host/index.html'), 'utf-8')))
app.get('/search', async c => c.html(await readFile(join(ROOT, 'host/search.html'), 'utf-8')))
app.get('/products/:slug', async c => c.html(await readFile(join(ROOT, 'host/product.html'), 'utf-8')))
const noCache = { 'Cache-Control': 'no-store' }
app.get('/settings',     async c => c.html(await readFile(join(ROOT, 'host/settings.html'), 'utf-8'), 200, noCache))

app.get('/api/product/:slug', c => {
  const slug = c.req.param('slug')
  const targetUrl = '/products/' + slug
  try {
    const files = readdirSync(FIXTURES_DIR).filter(f => f.startsWith('algolia-') && f.endsWith('.json'))
    for (const file of files) {
      const raw = readFileSync(join(FIXTURES_DIR, file), 'utf-8')
      const data = JSON.parse(raw)
      const hit = data.hits?.find((h: { url: string }) => h.url === targetUrl)
      if (hit) return c.json(hit)
    }
  } catch {}
  return c.json({ error: 'not found' }, 404)
})

// Goes through the live `cms` adapter (fixture or Contentstack, per USE_FIXTURES) — unlike
// /api/product above, which reads fixture files directly. This route exists specifically to
// prove the CMS entry a shopper lands on is the real one, live or not.
app.get('/api/guide', async c => {
  const url = c.req.query('url') ?? ''
  const entry = url ? await cms.getByUrl(url).catch(() => null) : null
  return entry ? c.json(entry) : c.json({ error: 'not found' }, 404)
})

app.get('/api/search', async c => {
  const category = c.req.query('q') ?? ''
  const style    = c.req.query('style') ?? ''
  const maxPrice = c.req.query('maxPrice') ?? ''
  const fit      = c.req.query('fit') ?? ''
  const facets: Record<string, string | number> = {}
  if (style)    facets.style    = style
  if (fit)      facets.fit      = fit
  if (maxPrice) { const n = parseInt(maxPrice); if (!isNaN(n)) facets.maxPrice = n }
  let results = await search.query({ category, facets, limit: 100 }).catch(() => [])
  let styleRelaxed = false
  if (zeroResultsAction === 'fallback' && results.length === 0 && facets.style) {
    const noStyle = { ...facets }
    delete noStyle.style
    results = await search.query({ category, facets: noStyle, limit: 100 }).catch(() => [])
    styleRelaxed = results.length > 0
  }
  return c.json({ hits: results, nbHits: results.length, styleRelaxed, requestedStyle: facets.style ?? null })
})

app.post('/api/refinements', async c => {
  const { intent, categories } = await c.req.json<{ intent: IntentModel; categories?: string[] }>()
  const refinements = await llm.generateRefinements(intent, categories ?? []).catch(() => [] as string[])
  return c.json({ refinements })
})

app.get('/api/provider', c => c.json({ provider: activeProvider }))

app.get('/api/env-status', c => c.json({
  gatewayKey:  !!process.env.AI_GATEWAY_API_KEY,
  useFixtures: useFixtures,
}))

app.post('/api/provider', async c => {
  const { provider } = await c.req.json<{ provider: ProviderKey }>()
  const valid: ProviderKey[] = ['claude', 'openai']
  if (!valid.includes(provider)) return c.json({ error: 'Unknown provider' }, 400)
  setProvider(provider)
  console.log(`[provider] switched to ${provider}`)
  return c.json({ provider: activeProvider })
})

// Free-text 'chat' model override — not a fixed list, any model ID the active provider's
// Gateway recognizes works. Not pre-validated: a bad ID just fails naturally on the next
// chat call, same as any other LLM error. Resets to the adapter's own default whenever the
// provider switches (Claude/OpenAI model IDs are different namespaces).
app.get('/api/chat-model', c => c.json({ model: llm.chatModelOverride }))

app.post('/api/chat-model', async c => {
  const { model } = await c.req.json<{ model: string }>()
  if (!model || typeof model !== 'string' || !model.trim()) return c.json({ error: 'Model ID required' }, 400)
  llm.chatModelOverride = model.trim()
  console.log(`[chat-model] switched to ${llm.chatModelOverride}`)
  return c.json({ model: llm.chatModelOverride })
})

// Same free-text pattern as /api/chat-model, independently for 'spec' and 'curation'.
app.get('/api/spec-model', c => c.json({ model: llm.specModelOverride }))

app.post('/api/spec-model', async c => {
  const { model } = await c.req.json<{ model: string }>()
  if (!model || typeof model !== 'string' || !model.trim()) return c.json({ error: 'Model ID required' }, 400)
  llm.specModelOverride = model.trim()
  console.log(`[spec-model] switched to ${llm.specModelOverride}`)
  return c.json({ model: llm.specModelOverride })
})

app.get('/api/curation-model', c => c.json({ model: llm.curationModelOverride }))

app.post('/api/curation-model', async c => {
  const { model } = await c.req.json<{ model: string }>()
  if (!model || typeof model !== 'string' || !model.trim()) return c.json({ error: 'Model ID required' }, 400)
  llm.curationModelOverride = model.trim()
  console.log(`[curation-model] switched to ${llm.curationModelOverride}`)
  return c.json({ model: llm.curationModelOverride })
})

/**
 * Unified schema for every agent turn — generated in a single streamText+Output call.
 * The model streams `reply` first, then populates chips, delta, isReady, and categories
 * in the same response. No extraction phase needed.
 */
// Conversation and assembly endpoints — the two largest handlers, each in its own module.
registerChatRoute(app)
registerShowMeNowRoute(app)


app.use('/assets/*', serveStatic({ root: './dist' }))
app.use('/images/*', serveStatic({ root: IMAGES_SERVE_ROOT }))

// Generic CMS-entry fallback — matches any path not claimed by a route above. A CMS entry's
// `url` field can be any prefix (/guides/…, /how-to/…, /tools/…, whatever gets typed into
// Contentstack); rather than hardcoding known prefixes as separate routes, ANY unmatched path
// is checked against the live cms adapter by its exact url, and rendered with the one shared
// template if found. Skips /api/* (those should 404 as JSON, not fall through here) and any
// path with a file extension (favicon.ico, etc.) to avoid a live CMS lookup on every stray request.
app.get('*', async c => {
  const path = c.req.path
  if (path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(path)) return c.notFound()
  const entry = await cms.getByUrl(path).catch(() => null)
  if (!entry) return c.notFound()
  return c.html(await readFile(join(ROOT, 'host/guide.html'), 'utf-8'))
})

// Skipped under Vitest so tests can import `app` and drive it through app.request()
// without binding a port.
if (!process.env.VITEST) {
  const port = Number(process.env.PORT) || 3003
  serve({ fetch: app.fetch, port }, info => {
    console.log(`Greeter running → http://localhost:${info.port}`)
    console.log(`  Fixtures: ${useFixtures}`)
    console.log(`  Provider: ${activeProvider}`)
  })
}
