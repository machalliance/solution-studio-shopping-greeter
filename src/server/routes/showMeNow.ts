import type { Hono } from 'hono'
import type { IntentModel, CategoryResult } from '../../types/intent.js'
import { llm } from '../config.js'
import { intentStore, categoryStore, earlyCategories, saveCategoryStore } from '../stores.js'
import { assembleResults, buildCuratedOutfits } from '../assemble.js'

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
export function registerShowMeNowRoute(app: Hono) {
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
}
