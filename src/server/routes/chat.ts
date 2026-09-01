import type { Hono } from 'hono'
import { getSessionId, type AppEnv } from '../session.js'
import { rateLimit } from '../rateLimit.js'
import { streamSSE } from 'hono/streaming'
import { streamText, Output } from 'ai'
import { z } from 'zod/v3';
import { buildChatPrompt } from '../../agent/intent.js'
import type { IntentModel, CategoryResult } from '../../types/intent.js'
import { CHAT_TIMEOUT_MS, activeProvider, llm } from '../config.js'
import { catalogStats } from '../catalogStats.js'
import {
  intentStore, lastEvents, rawReplies, requestLog, pruneDebugStores,
  categoryStore, earlyCategories, saveCategoryStore,
} from '../stores.js'
import { assembleResults, buildCuratedOutfits } from '../assemble.js'

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

/** Registers the conversational turn endpoint. */
export function registerChatRoute(app: Hono<AppEnv>) {
  app.post('/api/chat', rateLimit, async c => {
    const body = await c.req.json<{
      messages: { role: 'user' | 'assistant'; content: string }[]
      intent: IntentModel | null
      selections?: string[]
      categories?: string[]
    }>()

    const { messages, selections = [], categories: clientCategories } = body
    // From the session cookie only — see session.ts. A body-supplied id is ignored.
    const sessionId = getSessionId(c)
    const logEntry = { ts: new Date().toISOString(), sessionId, msgCount: messages.length, clientCats: clientCategories?.join(',') ?? 'none' }
    requestLog.push(logEntry)
    if (requestLog.length > 50) requestLog.shift()
    console.log(`[chat] request received — session: ${sessionId}, msgs: ${messages.length}, clientCats: ${logEntry.clientCats}`)
    // The client may send an intent when the server has none (e.g. after a restart). Its own
    // sessionId field is overwritten with the cookie's: assembleResults keys the per-session
    // spec, budget and outfit caches on it, and the show-me-now fast path below hands this
    // object straight to assembly, so a caller-chosen id there would reach another session's
    // cached work.
    const carried = intentStore.get(sessionId) ?? body.intent ?? null
    const prevStored: IntentModel | null = carried ? { ...carried, sessionId } : null

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
}
