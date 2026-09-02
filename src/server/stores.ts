import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { IntentModel } from '../types/intent.js'

// Session stores — keyed by sessionId. In-memory only; cleared on server restart.
// Not suitable for multi-instance deployments without a shared store (Redis, etc.).
export const intentStore = new Map<string, IntentModel>()

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
export interface CachedSpec { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }
export const specCache = new Map<string, Record<string, { key: string; spec: CachedSpec }>>()
export const budgetCache = new Map<string, { key: string; allocation: Record<string, number> }>()

// Last curated outfits per session — fed back into curateOutfits() as context so it can bias
// toward keeping pieces the shopper didn't just ask to change, rather than freely re-picking
// everything (including categories the shopper never mentioned) on every refinement turn.
export const curatedOutfitCache = new Map<string, { name: string; slots: Record<string, string> }[]>()

// Debug stores — bounded to avoid unbounded growth in long-running instances.
// /debug/* endpoints read these; they are not part of the production data path.
const MAX_DEBUG_SESSIONS = 100
export const lastEvents = new Map<string, { type: string; size: number; categoriesLen?: number }[]>()
export const rawReplies = new Map<string, { ts: string; provider: string; text: string }>()
export const requestLog: { ts: string; sessionId: string; msgCount: number; clientCats: string }[] = []

export function pruneDebugStores() {
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
export const categoryStore = new Map<string, string[]>()

// earlyCategories caches the category list from isEarlyReady turns so that a
// "Show Me Now" press can skip the LLM call entirely and go straight to assembly.
export const earlyCategories = new Map<string, string[]>()

try {
  if (existsSync(CATEGORY_STORE_PATH)) {
    const saved = JSON.parse(readFileSync(CATEGORY_STORE_PATH, 'utf-8')) as Record<string, string[]>
    for (const [k, v] of Object.entries(saved)) categoryStore.set(k, v)
    console.log(`[categoryStore] restored ${categoryStore.size} sessions from disk`)
  }
} catch { /* start empty if corrupt */ }

/**
 * Removes one session from every store. Backs POST /api/session/reset — see the note there for
 * why clearing the client alone was not enough. Debug stores are included so a reset shopper's
 * captured turns stop showing up in /debug/*; requestLog is not, being a global ring buffer
 * rather than per-session state.
 */
export function clearSessionState(sessionId: string) {
  intentStore.delete(sessionId)
  categoryStore.delete(sessionId)
  earlyCategories.delete(sessionId)
  specCache.delete(sessionId)
  budgetCache.delete(sessionId)
  curatedOutfitCache.delete(sessionId)
  lastEvents.delete(sessionId)
  rawReplies.delete(sessionId)
  saveCategoryStore()
}

export function saveCategoryStore() {
  try {
    writeFileSync(CATEGORY_STORE_PATH, JSON.stringify(Object.fromEntries(categoryStore)))
  } catch { /* non-fatal */ }
}
