import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { streamText, Output } from 'ai'
import { z } from 'zod/v3';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeAdapter, OpenAIAdapter } from './adapters/llm.js'
import type { LLMAdapter } from './adapters/llm.js'
import { FixtureSearchAdapter, AlgoliaAdapter } from './adapters/search.js'
import { FixtureCMSAdapter, ContentstackAdapter } from './adapters/cms.js'
import { buildChatPrompt, categoryDisplayName } from './agent/intent.js'
import { buildSearchFacets, buildShowAllUrl } from './agent/layout.js'
import type { SearchAdapter } from './adapters/search.js'
import type { CMSAdapter } from './adapters/cms.js'
import type { IntentModel, CategoryResult, CuratedOutfit } from './types/intent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const FIXTURES_DIR       = join(ROOT, 'catalog/fixtures')
const IMAGES_SERVE_ROOT  = './catalog'

// Supported provider keys — maps to the adapter + model used for all LLM calls.
// Switch at runtime via POST /api/provider; initial value from LLM_PROVIDER env var.
// Per-provider model config lives in env vars (LLM_CLAUDE_CHAT, LLM_OPENAI_CHAT, etc.)
export type ProviderKey = 'claude' | 'openai'

function createAdapter(provider: ProviderKey): LLMAdapter {
  switch (provider) {
    case 'openai': return new OpenAIAdapter()
    default:       return new ClaudeAdapter()
  }
}

let activeProvider: ProviderKey = (process.env.LLM_PROVIDER ?? 'claude') as ProviderKey
let llm: LLMAdapter = createAdapter(activeProvider)

const PANEL_HTML_PATH = join(ROOT, 'dist/panel.html')
const STYLE_SRC       = join(ROOT, 'src/style.css')
// Read fresh on each request so `npm run build` hot-swaps the bundle without a server restart.
function getPanelHtml() { return readFileSync(PANEL_HTML_PATH, 'utf-8') }

const useFixtures = process.env.USE_FIXTURES !== 'false'
const zeroResultsAction = (process.env.ZERO_RESULTS_ACTION ?? 'fallback') as 'fallback' | 'notice'
// Max wait for a single /api/chat LLM turn before it's treated as failed — see the
// streamText timeout guard below for why this exists.
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 15_000
const search: SearchAdapter = useFixtures
  ? new FixtureSearchAdapter()
  : new AlgoliaAdapter({
      appId: process.env.ALGOLIA_APP_ID!,
      apiKey: process.env.ALGOLIA_API_KEY!,
      indexName: process.env.ALGOLIA_INDEX_NAME!,
    })

const cms: CMSAdapter = useFixtures
  ? new FixtureCMSAdapter()
  : new ContentstackAdapter({
      apiKey: process.env.CONTENTSTACK_API_KEY!,
      deliveryToken: process.env.CONTENTSTACK_DELIVERY_TOKEN!,
      environment: process.env.CONTENTSTACK_ENVIRONMENT!,
    })

// ── Catalog price stats ────────────────────────────────────────────────────────
// Built at startup by querying the search adapter for every category.
// Injected into LLM prompts so budget options are calibrated to real products.
// In production: FixtureSearchAdapter → AlgoliaAdapter, same interface, no code change.

export interface CategoryStats { min: number; max: number; avg: number; count: number }
export type CatalogStats = Record<string, CategoryStats>

const catalogStats: CatalogStats = {}

async function buildCatalogStats(): Promise<void> {
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

buildCatalogStats().catch(err => console.error('[catalog] build failed:', err))

// ──────────────────────────────────────────────────────────────────────────────

// Session stores — keyed by sessionId. In-memory only; cleared on server restart.
// Not suitable for multi-instance deployments without a shared store (Redis, etc.).
const intentStore = new Map<string, IntentModel>()

// generateStyleSpec() and allocateBudget() are both LLM calls with real sampling variance —
// calling them fresh on every assembleResults() means a category the shopper never mentioned
// can still drift to a different product turn to turn, purely from that variance, not from
// any actual change to its constraints. Caching per session, keyed on the exact inputs each
// call actually depends on, makes untouched categories genuinely stable: same inputs → same
// cached spec/allocation → same search → same top result. A real input change (any signal
// feeding these two calls) naturally produces a different key, so a real refinement still
// recomputes correctly — this only suppresses re-sampling identical inputs.
// Keyed per category, not as one blob for the whole spec — a categoryConstraints change to
// ONE category (e.g. a "pants" refinement) must not invalidate the cached spec for every
// other category too, or the "only touched categories change" guarantee breaks immediately.
const specCache = new Map<string, Record<string, { key: string; spec: { requiresAll: string[]; requiresAny: string[]; avoidances: string[] } }>>()
const budgetCache = new Map<string, { key: string; allocation: Record<string, number> }>()

// Last curated outfits per session — fed back into curateOutfits() as context so it can bias
// toward keeping pieces the shopper didn't just ask to change, rather than freely re-picking
// everything (including categories the shopper never mentioned) on every refinement turn.
const curatedOutfitCache = new Map<string, { name: string; slots: Record<string, string> }[]>()

// Debug stores — bounded to avoid unbounded growth in long-running instances.
// /debug/* endpoints read these; they are not part of the production data path.
const MAX_DEBUG_SESSIONS = 100
const lastEvents = new Map<string, { type: string; size: number; categoriesLen?: number }[]>()
const rawReplies = new Map<string, { ts: string; provider: string; text: string }>()
const requestLog: { ts: string; sessionId: string; msgCount: number; clientCats: string }[] = []

function pruneDebugStores() {
  if (lastEvents.size > MAX_DEBUG_SESSIONS) {
    const oldest = lastEvents.keys().next().value
    if (oldest) lastEvents.delete(oldest)
  }
  if (rawReplies.size > MAX_DEBUG_SESSIONS) {
    const oldest = rawReplies.keys().next().value
    if (oldest) rawReplies.delete(oldest)
  }
}

// categoryStore persists assembled category lists to disk (the host's real /tmp) so they
// survive tsx watch restarts during local development. Stored categories let the server
// re-assemble results after a restart without a fresh conversation.
const CATEGORY_STORE_PATH = '/tmp/greeter-categoryStore.json'
const categoryStore = new Map<string, string[]>()

// earlyCategories caches the category list from isEarlyReady turns so that a
// "Show Me Now" press can skip the LLM call entirely and go straight to assembly.
const earlyCategories = new Map<string, string[]>()
try {
  if (existsSync(CATEGORY_STORE_PATH)) {
    const saved = JSON.parse(readFileSync(CATEGORY_STORE_PATH, 'utf-8')) as Record<string, string[]>
    for (const [k, v] of Object.entries(saved)) categoryStore.set(k, v)
    console.log(`[categoryStore] restored ${categoryStore.size} sessions from disk`)
  }
} catch { /* start empty if corrupt */ }

function saveCategoryStore() {
  try {
    writeFileSync(CATEGORY_STORE_PATH, JSON.stringify(Object.fromEntries(categoryStore)))
  } catch { /* non-fatal */ }
}

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
  activeProvider = provider
  llm = createAdapter(provider)
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
const TurnSchema = z.object({
  reply: z.string()
    .describe('Your conversational response. Plain text only — no markdown, no bullets. 2 sentences max.'),
  chips: z.object({
    kind: z.enum(['options', 'select', 'topic'])
      .describe('"options" for style/aesthetic choices or sub-directions, "select" for factual picks (size/budget/fit), "topic" for pivot refinement topics only'),
    choices: z.array(z.string()).min(2).max(8)
      .describe('The options you are offering the shopper in this reply, each 1–4 words'),
  }).nullable()
    .describe('The options you are offering the shopper in this reply. Populate whenever the reply presents specific choices (style families, sub-directions, sizes, budgets, topics). Use null only for genuinely open-ended questions with no enumerable options.'),
  delta: z.object({
    goal: z.string().nullable().describe('Short phrase describing the shopping goal'),
    goalType: z.enum(['project', 'style']).nullable().describe('"project" for room/renovation, "style" for fashion/outfit'),
    style: z.string().nullable().describe('The shopper\'s current style direction, as specific as what they\'ve actually confirmed — e.g. "Smart casual" if that\'s all they\'ve picked, or "City Smart" once they\'ve picked that sub-direction. This drives style-aware product/outfit reasoning, so more specific is better once it\'s known.'),
    styleFamily: z.string().nullable().describe('The broad style family from the fixed step-2/3 options only (e.g. "Smart casual", "Coastal", "Minimalist", "Preppy", "Classic" for fashion; "Scandi", "Coastal", "Industrial", "Modern", "Farmhouse", "Japandi", "Transitional" for home) — set ONCE, the turn the shopper picks it, in exactly that wording. Never change it afterward, even when they later refine to a sub-direction (that goes in `style` above, not here) — this field must stay pinned to the original family for the life of the conversation, since it is used to look up real catalog data that only recognizes these fixed names, not invented sub-direction labels.'),
    fit: z.string().nullable().describe('Confirmed fit: "Men\'s", "Women\'s", or "No preference"'),
    budget: z.string().nullable().describe('Total budget label e.g. "$1,000–$2,000", "Under $400"'),
    colourDirection: z.string().nullable().describe('Colour direction e.g. "Earthy tones", "Neutral palette"'),
    warmth: z.string().nullable().describe('"Warm evening", "Might get cool", or "Definitely need a layer"'),
    venue: z.string().nullable().describe('"Indoor", "Outdoor", or "Ceremony outside, reception inside"'),
    finish: z.string().nullable().describe('Material finish e.g. "Matte black", "Brushed nickel"'),
    roomSize: z.string().nullable().describe('Room size e.g. "Tiny (under 35 sq ft)"'),
    vanityWidth: z.string().nullable().describe('Vanity width e.g. "Up to 24in"'),
    avoidances: z.array(z.string()).describe('Global exclusion filter — applied to all categories. Empty array if none mentioned this turn. Use when no category noun is mentioned e.g. "no logos", "avoid bright colours".'),
    requiresTags: z.array(z.string()).describe('Global positive filter — applied to all categories. Return the FULL current set of requirements (not just new ones this turn) — this replaces, not adds to, what was captured before. Empty array if none. Use when no category noun is mentioned e.g. "only linen", "only slim fit".'),
    categoryConstraints: z.array(z.object({
      category: z.string().describe('Canonical category name, e.g. "pants", "top", "jacket", "shoes".'),
      requiresTags: z.array(z.string()).describe('AND filter for this category — the product must match EVERY tag listed. Only put multiple tags here when they all describe the SAME single product (e.g. a fit descriptor plus one garment sub-type). Empty array if none.'),
      requiresAny: z.array(z.string()).describe('OR filter for this category — the product must match AT LEAST ONE tag listed. Use this whenever the shopper names two or more sibling sub-types as acceptable alternatives (e.g. "jeans or chinos", "boots or trainers") — those tags describe DIFFERENT products, not one product that is both, so they must never go in requiresTags together (a product cannot be both jeans and chinos — that AND-filter would match nothing). Empty array if none.'),
      avoidances: z.array(z.string()).describe('Exclusion filter for this category. Empty array if none.'),
    })).describe('Category-scoped filters. Empty array if the shopper named no specific category this turn. One entry per category they named. Map their word to the canonical category name (e.g. "pants"/"jeans"/"trousers" → "pants", "shirt"/"top"/"blouse" → "top", "jacket"/"blazer"/"coat" → "jacket", "shoes"/"boots"/"trainers" → "shoes"). If the word they used names a specific sub-type within that category rather than being a plain synonym for it (e.g. "jeans"/"denim" vs. "trousers"/"chinos" within pants; "boots"/"trainers"/"sandals" within shoes), keep that word as a filter too — mapping it to the category alone and then dropping it loses the one thing the shopper actually asked to narrow down to. The AND/OR choice matters: one sub-type + a fit/style descriptor go in requiresTags together (AND — same product needs both). Two or more sibling sub-types go in requiresAny (OR — any one of them is acceptable), never requiresTags. E.g. "slim pants only" → [{ category: "pants", requiresTags: ["slim"], requiresAny: [], avoidances: [] }]. "slim jeans only" → [{ category: "pants", requiresTags: ["slim", "jeans"], requiresAny: [], avoidances: [] }] (AND — one product, slim AND jeans). "jeans and chinos" / "give me both jeans and chinos options" → [{ category: "pants", requiresTags: [], requiresAny: ["jeans", "chinos"], avoidances: [] }] (OR — never combine sibling sub-types in requiresTags). "no black tops" → [{ category: "top", requiresTags: [], requiresAny: [], avoidances: ["black"] }].'),
    anchorItem: z.object({
      name: z.string(),
      description: z.string().nullable(),
      category: z.string().describe('Canonical category this item belongs to (same key used in categoryConstraints, e.g. "pants"). The shopper already owns this — it must be excluded from the shopping list and collage, not shown as something to buy.'),
    }).nullable().describe('An item the user already owns and wants to build around. Null unless the shopper mentioned one.'),
  }).nullable()
    .describe('Values confirmed in THIS turn only. Use null for any field not explicitly confirmed by the shopper this turn — never guess or infer a value that was not actually said. Use null for the whole object if nothing was confirmed this turn.'),
  isEarlyReady: z.boolean()
    .describe('Set true once 2+ constraints are captured — enables the Show Me button. For fashion goals, never set before fit (mens/womens) is known: results are unusable without it. Set false if not applicable — always include this field.'),
  isReady: z.boolean()
    .describe('Set true ONLY when all required fields are captured AND user confirms or says "show me". Fashion requires: style + fit + budget. Home requires: style + budget. Set false if not ready — always include this field.'),
  categories: z.array(z.string())
    .describe('Shopping list in body order (fashion: jacket→top→pants→shoes; home: lighting→mirror→vanity→faucet→tile→hardware). Empty array unless isReady=true or isEarlyReady=true, in which case required. Categories display left-to-right representing top-to-bottom on the body or logical project sequence.'),
})


app.post('/api/chat', async c => {
  const body = await c.req.json<{
    messages: { role: 'user' | 'assistant'; content: string }[]
    sessionId: string
    intent: IntentModel | null
    selections?: string[]
    categories?: string[]
  }>()

  const { messages, sessionId, selections = [], categories: clientCategories } = body
  const logEntry = { ts: new Date().toISOString(), sessionId, msgCount: messages.length, clientCats: clientCategories?.join(',') ?? 'none' }
  requestLog.push(logEntry)
  if (requestLog.length > 50) requestLog.shift()
  console.log(`[chat] request received — session: ${sessionId}, msgs: ${messages.length}, clientCats: ${logEntry.clientCats}`)
  const prevStored = intentStore.get(sessionId) ?? body.intent ?? null

  return streamSSE(c, async s => {
    const sessionLog: { type: string; size: number; categoriesLen?: number }[] = []
    lastEvents.set(sessionId, sessionLog)
    const write = async (data: Record<string, unknown>) => {
      const json = JSON.stringify(data)
      const entry: { type: string; size: number; categoriesLen?: number } = { type: String(data.type), size: json.length }
      if (data.type === 'intent-ready' && Array.isArray(data.categories)) entry.categoriesLen = data.categories.length
      sessionLog.push(entry)
      return s.writeSSE({ data: json })
    }

    try {
      const earlyPrevCategories = categoryStore.get(sessionId) ?? (clientCategories?.length ? clientCategories : undefined)
      const lastUserText = (messages.at(-1)?.content ?? '').toLowerCase()
      // Matches the exact chip-triggered phrase and any free-typed variant of it.
      // "show me" alone is too broad — it also matched unrelated topic labels like
      // "Show me what you have" (the anchor-item topic), forcing isReady with no
      // categories to assemble and stranding the conversation.
      const isShowMeNow = /\bshow me now\b/i.test(lastUserText)

      // ── Show Me Now fast path ─────────────────────────────────────────────
      // If we have cached categories from the isEarlyReady turn, skip the LLM
      // call entirely: emit a canned reply from the intent data and go straight
      // to assembly. This eliminates both the chat-reply delay and the dual dots.
      const smCatsInitial = isShowMeNow ? (earlyCategories.get(sessionId) ?? earlyPrevCategories) : undefined
      if (smCatsInitial?.length && prevStored) {
        let smCats = smCatsInitial
        const goal = prevStored.goal || 'your list'
        const goalType = prevStored.goalType ?? 'style'
        const canned = goalType === 'project'
          ? `Here's your ${goal} shopping list — let's get you set up.`
          : `Here's what I've put together for your ${goal}.`
        await write({ type: 'text-delta', content: canned })
        await write({ type: 'building' })

        intentStore.set(sessionId, prevStored)
        let smResults: CategoryResult[] = []
        let smSummary = ''
        try {
          ;[smResults, smSummary] = await Promise.all([
            assembleResults(prevStored, smCats),
            llm.generateOverallSummary(prevStored, smCats).catch(() => ''),
          ])
        } catch (err) { console.error('[SMN fast path error]', err) }

        // Hard guarantee: the cached category list can be stale (from an earlier point in
        // the conversation) and no longer resolve to anything — retry with a fresh list
        // before giving up, rather than silently stranding the shopper. This exact gap (no
        // fallback here, unlike the main path below) was a real, confirmed dead-end.
        if (smResults.length === 0) {
          console.warn('[SMN fast path] assembly empty, retrying with fresh categories')
          try {
            smCats = await llm.generateCategories(prevStored)
            ;[smResults, smSummary] = await Promise.all([
              assembleResults(prevStored, smCats),
              llm.generateOverallSummary(prevStored, smCats).catch(() => ''),
            ])
          } catch (err) { console.error('[SMN fast path retry error]', err) }
        }

        if (smResults.length > 0) {
          categoryStore.set(sessionId, smCats)
          saveCategoryStore()
          earlyCategories.delete(sessionId)
          const smCurated = await buildCuratedOutfits(prevStored, smResults).catch(() => [])
          await write({ type: 'intent-ready', intent: prevStored, categories: smResults, summary: smSummary, curatedOutfits: smCurated })
          llm.generateRefinements(prevStored, smCats)
            .then(r => write({ type: 'refinements', refinements: r }))
            .catch(() => {})
        } else {
          await write({ type: 'intent-update', intent: prevStored })
        }
        await write({ type: 'done' })
        return
      }

      // ── Early building signal (normal path) ───────────────────────────────
      // Emit before the LLM call when we already know this turn will assemble results.
      if (earlyPrevCategories != null || isShowMeNow) {
        await write({ type: 'building' })
      }

      // ── Single streamText+Output call: reply + chips generated together ───────
      // The model streams `reply` first (partialOutputStream tracks it character by character),
      // then populates chips, delta, isReady, and categories in the same response.
      const result = streamText({
        model: llm.getModel('chat'),
        output: Output.object({ schema: TurnSchema }),
        instructions: buildChatPrompt(prevStored, selections, catalogStats, clientCategories ?? []),
        messages,
      })

      // A provider/gateway hiccup (rate limit, transient outage) can leave the underlying
      // stream open with no chunk ever arriving — partialObjectStream then never resolves
      // or rejects on its own, so the request would otherwise hang indefinitely with the
      // shopper stuck on a loading state. This timeout turns that into a normal thrown
      // error, caught by the try/catch below like any other failure. Configurable because
      // "too long" depends on the model/provider in play — CHAT_TIMEOUT_MS in .env, default
      // below chosen so a shopper never stares at a stalled spinner for more than ~15s.
      let replyText = ''
      let prevReplyLen = 0
      let chipsPreviewSent = false
      const turn = await Promise.race([
        (async () => {
          for await (const partial of result.partialOutputStream) {
            const cur = partial.reply ?? ''
            if (cur.length > prevReplyLen) {
              await write({ type: 'text-delta', content: cur.slice(prevReplyLen) })
              replyText += cur.slice(prevReplyLen)
              prevReplyLen = cur.length
            }
            // Preview chips as soon as `delta` starts appearing in the partial object — proof
            // `chips` has fully closed, not a heuristic. The model generates tokens strictly
            // in order, so `"delta":` cannot appear in the stream before `chips` (the
            // preceding schema field) has been completely, validly generated — unlike a
            // length-stability check across chunks, this can't fire on a still-growing or
            // still-mid-string array. Re-tried 2026-08-28 after the stability-check version
            // (tried the same day) produced two confirmed bugs — a truncated option and a
            // missing pivot topic — both shown to the shopper before the model had actually
            // finished. Measured to cost no latency vs. the stability-check version it
            // replaces (~0.7s gap either way) — see [[greeter_topic_chip_early_preview_bug]].
            if (!chipsPreviewSent && partial.delta !== undefined && partial.chips?.kind
                && partial.chips.choices && partial.chips.choices.length >= 2) {
              chipsPreviewSent = true
              await write({ type: 'options', kind: partial.chips.kind, choices: partial.chips.choices })
            }
          }
          return result.output
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`LLM response timed out after ${CHAT_TIMEOUT_MS}ms`)), CHAT_TIMEOUT_MS)),
      ])
      rawReplies.set(sessionId, { ts: new Date().toISOString(), provider: activeProvider, text: JSON.stringify(turn) })
      pruneDebugStores()
      console.log(`[turn] provider=${activeProvider} isReady=${turn.isReady} isEarlyReady=${turn.isEarlyReady} chips=${JSON.stringify(turn.chips?.choices)} delta=${JSON.stringify(turn.delta)}`)

      // ── Build updated intent ───────────────────────────────────────────────
      // Merge delta fields from this turn onto the accumulated intent.
      // Only fields that were explicitly set in delta are applied.
      // delta itself is nullable, but every field within it is required (nullable/empty-array
      // rather than optional) — so the fallback needs every key, not a bare {}.
      const d = turn.delta ?? {
        goal: null, goalType: null, style: null, styleFamily: null, fit: null, budget: null,
        colourDirection: null, warmth: null, venue: null, finish: null,
        roomSize: null, vanityWidth: null, avoidances: [], requiresTags: [],
        categoryConstraints: [], anchorItem: null,
      }
      const deltaConstraints: IntentModel['constraints'] = {}
      if (d.style)           deltaConstraints.style           = d.style
      // styleFamily is server-enforced sticky, not just prompt instruction (same pattern as the
      // anchor-item exclusion below) — once set, a real catalog lookup depends on it staying
      // exactly the fixed family name the shopper originally picked, so a later turn can never
      // overwrite it, even if the model forgets the "never change it" instruction.
      if (d.styleFamily && !prevStored?.constraints.styleFamily) deltaConstraints.styleFamily = d.styleFamily
      if (d.fit)             deltaConstraints.fit             = d.fit
      if (d.budget)          deltaConstraints.budget          = d.budget
      if (d.colourDirection) deltaConstraints.colourDirection = d.colourDirection
      if (d.warmth)          deltaConstraints.warmth          = d.warmth
      if (d.venue)           deltaConstraints.venue           = d.venue
      if (d.finish)          deltaConstraints.finish          = d.finish
      if (d.roomSize)        deltaConstraints.roomSize        = d.roomSize
      if (d.vanityWidth)     deltaConstraints.vanityWidth     = d.vanityWidth
      // avoidances (exclusion list): safe to union — more exclusions can't create a
      // contradiction. requiresTags (AND filter, search.ts's requiresAll uses .every()):
      // NOT unioned — accumulating "requirements" that were actually the shopper changing
      // their mind would silently zero out search results, worse than losing a stale value.
      // Stays replace-based, relying on the model restating the full current set (per its
      // schema description) rather than a mechanical guarantee.
      if (d.avoidances?.length) {
        const prevAvoidances = Array.isArray(prevStored?.constraints.avoidances) ? prevStored.constraints.avoidances : []
        deltaConstraints.avoidances = [...new Set([...prevAvoidances, ...d.avoidances])]
      }
      if (d.requiresTags?.length) deltaConstraints.requiresTags = d.requiresTags
      if (d.categoryConstraints?.length) {
        const prev = prevStored?.constraints.categoryConstraints ?? {}
        const merged: Record<string, { requiresTags?: string[], requiresAny?: string[], avoidances?: string[] }> = { ...prev }
        for (const { category, requiresTags, requiresAny, avoidances } of d.categoryConstraints) {
          const existing = merged[category] ?? {}
          merged[category] = {
            // requiresTags (AND): same replace-based asymmetry as the global fields above.
            // requiresAny (OR): safe to union like avoidances — more alternatives can only
            // widen a match, never zero one out the way accumulating AND tags would.
            requiresTags: requiresTags.length ? requiresTags : existing.requiresTags,
            requiresAny:  [...new Set([...(existing.requiresAny ?? []), ...requiresAny])],
            avoidances:   [...new Set([...(existing.avoidances ?? []), ...avoidances])],
          }
        }
        deltaConstraints.categoryConstraints = merged
      }

      const rawConstraints = { ...(prevStored?.constraints ?? {}), ...deltaConstraints }
      // Strip placeholder values the LLM emits when a constraint is unknown
      const cleanConstraints: typeof rawConstraints = {}
      for (const [k, v] of Object.entries(rawConstraints)) {
        if (typeof v === 'string' && (/unknown/i.test(v) || /^<[^>]+>$/.test(v.trim()))) continue
        cleanConstraints[k as keyof typeof rawConstraints] = v as any
      }

      const updatedIntent: IntentModel = {
        goal:      d.goal      ?? prevStored?.goal      ?? '',
        goalType:  d.goalType  ?? prevStored?.goalType  ?? 'project',
        constraints: cleanConstraints,
        // Replace-by-category, not append: a later mention of the same category is a
        // correction (e.g. "actually they're navy, not dark"), not a second, separate item.
        anchorItems: [
          ...(prevStored?.anchorItems ?? []).filter(a => a.category !== d.anchorItem?.category),
          ...(d.anchorItem ? [{ name: d.anchorItem.name, description: d.anchorItem.description ?? undefined, category: d.anchorItem.category }] : []),
        ],
        sessionId,
      }
      console.log(`[chat] constraints: ${JSON.stringify(updatedIntent.constraints)}`)
      intentStore.set(sessionId, updatedIntent)

      // ── Budget gate ────────────────────────────────────────────────────────
      // Schema enforcement ensures chips and isReady are always present, but the model
      // can still set isReady=true before capturing budget. One clean check handles all cases.
      const budgetChoices = updatedIntent.goalType === 'style'
        ? ['Under $400', '$400–$800', '$800–$1,500', 'No set limit']
        : ['Under $1,000', '$1,000–$2,500', '$2,500–$5,000', 'Over $5,000']

      let chips = turn.chips
      let isReady = turn.isReady

      // "Show me now" is an explicit user override — force assembly regardless of LLM hesitation.
      if (isShowMeNow && !isReady) {
        isReady = true
        console.log('[show me now] server override: forcing isReady=true')
      }

      if (isReady && !updatedIntent.constraints.budget && !isShowMeNow) {
        isReady = false
        chips = { kind: 'select', choices: budgetChoices }
        console.log('[budget gate] isReady without budget — deferred, injecting chips')
      }

      // ── Emit Q&A chips and early-ready signal ─────────────────────────────
      // Skip if this is exactly what the in-loop preview above already sent — the common
      // case, since the budget gate only rewrites chips in the one specific isReady-without-
      // budget path. Only actually re-emit when the final chips differ from the preview.
      const chipsMatchPreview = chipsPreviewSent && chips
        && JSON.stringify(chips.choices) === JSON.stringify(turn.chips?.choices) && chips.kind === turn.chips?.kind
      if (!isReady && chips && chips.choices.length > 0 && !chipsMatchPreview) {
        await write({ type: 'options', kind: chips.kind, choices: chips.choices })
      }
      if (!isReady && turn.isEarlyReady) {
        await write({ type: 'early-ready' })
        if (turn.categories?.length) earlyCategories.set(sessionId, turn.categories)
      }

      // ── Assembly ───────────────────────────────────────────────────────────
      // Assemble results when isReady=true (fresh), or when results were previously
      // assembled for this session (refinement mode — re-run with updated constraints).
      const prevCategories = categoryStore.get(sessionId) ?? (clientCategories?.length ? clientCategories : undefined)
      const isRefinement = prevCategories != null && !isReady
      const shouldAssemble = isReady || isRefinement

      if (shouldAssemble) {
        // When "show me now" forced isReady, also try earlyCategories as fallback for categories
        const smEarlyFallback = isShowMeNow ? earlyCategories.get(sessionId) : undefined
        let cats = turn.categories?.length ? turn.categories
          : (smEarlyFallback?.length ? smEarlyFallback : (prevCategories ?? []))

        // Hard guarantee: "show me now" must never dead-end. If every other source came back
        // empty (the model asked a clarifying question instead of committing to categories that
        // turn), make one dedicated schema-enforced call whose only job is picking categories —
        // no conversational path lets it come back empty.
        if (isShowMeNow && cats.length === 0) {
          try {
            cats = await llm.generateCategories(updatedIntent)
            console.log(`[show me now] categories fallback call returned: ${JSON.stringify(cats)}`)
          } catch (err) {
            console.error('[show me now] categories fallback call failed:', err)
          }
        }
        // Guaranteed exclusion, not just a prompt instruction: an anchor item's category is
        // something the shopper already owns, so it must never appear in the shopping list or
        // collage regardless of what the model returned in `cats` this turn.
        const anchorCategories = new Set((updatedIntent.anchorItems ?? []).map(a => a.category).filter(Boolean))
        if (anchorCategories.size > 0) {
          const before = cats.length
          cats = cats.filter(c => !anchorCategories.has(c))
          if (cats.length !== before) console.log(`[anchor] excluded owned-item categories from shopping list: ${[...anchorCategories].join(', ')}`)
        }
        console.log(`[chat] ${isRefinement ? 'refinement' : 'isReady'}, categories: ${JSON.stringify(cats)}`)

        if (!earlyPrevCategories && !isShowMeNow) {
          await write({ type: 'building' })
        }

        let categoryResults: CategoryResult[] = []
        let overallSummary = ''
        if (cats.length) {
          try {
            [categoryResults, overallSummary] = await Promise.all([
              assembleResults(updatedIntent, cats),
              llm.generateOverallSummary(updatedIntent, cats).catch(() => ''),
            ])
          } catch (err) {
            console.error('[assembleResults error]', err)
          }
        }
        console.log(`[chat] assembleResults returned ${categoryResults.length} rows`)

        if (categoryResults.length > 0) {
          categoryStore.set(sessionId, cats)
          saveCategoryStore()
          const curatedOutfits = await buildCuratedOutfits(updatedIntent, categoryResults).catch(() => [])
          await write({ type: 'intent-ready', intent: updatedIntent, categories: categoryResults, summary: overallSummary, curatedOutfits })
          llm.generateRefinements(updatedIntent, cats)
            .then(refinements => write({ type: 'refinements', refinements }))
            .catch(() => {})
        } else {
          console.warn('[chat] no results assembled — falling back to intent-update')
          await write({ type: 'intent-update', intent: updatedIntent })
        }
      } else {
        await write({ type: 'intent-update', intent: updatedIntent })
      }

      await write({ type: 'done' })
    } catch (err) {
      // Full detail stays server-side only — the shopper gets ChatView's generic fallback
      // text (event.message omitted here on purpose), never raw provider/billing internals.
      console.error('[chat error]', err)
      await write({ type: 'error' })
    }
  });
})

// Dedicated "Show me now" endpoint — deliberately NOT part of the conversational chat turn.
// The old mechanism sent "Show me now" as a literal chat message and relied on a regex
// (`isShowMeNow` in /api/chat) plus a server-side override to force assembly — fragile by
// construction, and it had a real, confirmed dead-end: a "fast path" for when categories were
// already cached from an earlier isEarlyReady moment had no hard-guarantee fallback of its own,
// so if its own assembleResults() call ever returned empty, it wrote intent-update and returned
// with no retry — silently stranding the shopper with no error and no way forward. Both UI
// triggers (the quick-action chip and the dedicated button, see ChatView.tsx) call the exact
// same client function, which posts here — one deterministic path, always guaranteed to reach
// either real results or a clear error, never a silent dead end.
app.post('/api/show-me-now', async c => {
  const body = await c.req.json<{ sessionId: string; intent: IntentModel | null; categories?: string[] }>()
  const { sessionId } = body
  const intent = body.intent ?? intentStore.get(sessionId) ?? null
  if (!intent) return c.json({ error: 'No intent captured yet for this session' }, 400)

  intentStore.set(sessionId, intent)

  try {
    // Category source priority: categories already assembled this session (refinement) →
    // cached from an earlier isEarlyReady moment → a dedicated schema-enforced call (min 1
    // category, no conversational path to return empty) as the unconditional last resort.
    let cats = body.categories?.length ? body.categories
      : (categoryStore.get(sessionId)?.length ? categoryStore.get(sessionId)! : (earlyCategories.get(sessionId) ?? []))

    if (cats.length === 0) {
      cats = await llm.generateCategories(intent)
    }

    const anchorCategories = new Set((intent.anchorItems ?? []).map(a => a.category).filter(Boolean))
    if (anchorCategories.size > 0) cats = cats.filter(cat => !anchorCategories.has(cat))

    let categoryResults: CategoryResult[] = []
    let overallSummary = ''
    ;[categoryResults, overallSummary] = await Promise.all([
      assembleResults(intent, cats),
      llm.generateOverallSummary(intent, cats).catch(() => ''),
    ])

    // Hard guarantee: if assembly still came back empty (e.g. a stale cached category no
    // longer resolves to anything), retry once with a fresh category list before giving up —
    // this is the exact safety net the old fast path was missing.
    if (categoryResults.length === 0) {
      console.warn('[show-me-now] assembly returned empty, retrying with fresh categories')
      cats = await llm.generateCategories(intent)
      if (anchorCategories.size > 0) cats = cats.filter(cat => !anchorCategories.has(cat))
      ;[categoryResults, overallSummary] = await Promise.all([
        assembleResults(intent, cats),
        llm.generateOverallSummary(intent, cats).catch(() => ''),
      ])
    }

    if (categoryResults.length === 0) {
      return c.json({ error: 'Could not assemble results — please try again' }, 500)
    }

    categoryStore.set(sessionId, cats)
    saveCategoryStore()
    earlyCategories.delete(sessionId)

    const [curatedOutfits, refinements] = await Promise.all([
      buildCuratedOutfits(intent, categoryResults).catch(() => []),
      llm.generateRefinements(intent, cats).catch(() => []),
    ])

    return c.json({ intent, categories: categoryResults, summary: overallSummary, curatedOutfits, refinements })
  } catch (err) {
    console.error('[show-me-now error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

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
    (async (): Promise<Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }>> => {
      if (!hasSpecSignal) return {}
      const prevEntries = specCache.get(intent.sessionId) ?? {}
      const stale = categories.filter(cat => prevEntries[cat]?.key !== specKeyFor(cat))
      if (stale.length === 0) {
        const reused: Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }> = {}
        for (const cat of categories) reused[cat] = prevEntries[cat].spec
        return reused
      }
      const fresh = await llm.generateStyleSpec(intent, categories).catch(err => {
        console.error('[spec] generation failed, proceeding without:', err)
        return {} as Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }>
      })
      console.log('[spec]', JSON.stringify(fresh), '| stale categories recomputed:', stale.join(', '))
      const merged: Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }> = {}
      const nextEntries: Record<string, { key: string; spec: { requiresAll: string[]; requiresAny: string[]; avoidances: string[] } }> = {}
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
