import type { Context } from 'hono'
import { z } from 'zod/v3';

/**
 * Runtime validation for the three request bodies that reach a paid LLM.
 *
 * The handlers used to read their bodies with `c.req.json<{...}>()`, which is a TypeScript cast
 * and nothing more — erased at compile time, so every field arrived unchecked. Two consequences
 * mattered: `messages` was forwarded to streamText at any size, and `categories` drove a
 * `Promise.all` fan-out in assembleResults with no bound, so one request could become thousands
 * of search and LLM calls. rateLimit caps requests, not the work inside one, so it did not help.
 *
 * Categories are truncated rather than rejected: the list is a client-side optimisation (it lets
 * the server re-assemble after a restart without a fresh conversation), so a too-long one is
 * worth ignoring the tail of, not worth failing the shopper's turn over. Everything else is a
 * hard reject — a malformed `messages` array has no sensible salvage.
 *
 * `intent` is passed through unvalidated. Modelling IntentModel in zod is a much larger change
 * than this one, and it is not the exposure: it is bounded by the schemas the LLM itself is held
 * to, and its sessionId is already overwritten with the cookie's in both handlers.
 */

/** Matches the cap the model's own category schema enforces — see generateCategories in llm.ts. */
export const MAX_CATEGORIES = 8
const MAX_MESSAGES = 60
const MAX_MESSAGE_CHARS = 4_000
const MAX_SELECTIONS = 50

const CategoryList = z.array(z.string().max(80))
  .transform(cats => cats.slice(0, MAX_CATEGORIES))
  .optional()

export const ChatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_MESSAGE_CHARS),
  })).min(1).max(MAX_MESSAGES),
  intent: z.any().nullable().optional(),
  selections: z.array(z.string().max(200)).max(MAX_SELECTIONS).optional(),
  categories: CategoryList,
})

export const ShowMeNowBody = z.object({
  intent: z.any().nullable().optional(),
  categories: CategoryList,
})

export const RefinementsBody = z.object({
  intent: z.any(),
  categories: CategoryList,
})

/**
 * Parses and validates a JSON body. Returns the parsed value, or null after writing a 400 —
 * callers `return response` on null. Malformed JSON lands here too: c.req.json() throws on it,
 * and an unhandled throw in these handlers is a 500 for what is plainly a client error.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<{ data: z.infer<T>; response: null } | { data: null; response: Response }> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { data: null, response: c.json({ error: 'Malformed JSON body' }, 400) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || 'body'
    return { data: null, response: c.json({ error: `Invalid request: ${where} — ${issue?.message}` }, 400) }
  }
  return { data: parsed.data, response: null }
}
