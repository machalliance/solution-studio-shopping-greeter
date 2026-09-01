import type { IntentModel } from '../types/intent'
import type { Message } from './App'

/**
 * Pure view-model helpers for ChatView. Both were inline in the component body, where they made
 * up most of its branching but have nothing to do with rendering — they are functions of the
 * props alone, and testable as such.
 */

// Preferred display order for constraint tags.
// Keys not in this list appear last, in insertion order.
const TAG_ORDER = ['style', 'fit', 'gender', 'warmth', 'layering', 'temperature',
  'colourDirection', 'colorPreference', 'colourPreference', 'color', 'colour', 'colorDirection',
  'budget', 'roomSize', 'size', 'vanityWidth', 'finish', 'venue']

/** A value the model emitted because it had nothing real to say — never shown as an answer. */
const isPlaceholder = (v: string) => /no preference|unknown/i.test(v) || /^<[^>]+>$/.test(v.trim())

/** Captured constraints as display tags, preferred keys first, de-duplicated by value. */
export function buildConstraintTags(intent: IntentModel | null): string[] {
  if (!intent?.constraints) return []
  const c = intent.constraints
  const ordered: string[] = []
  const seen = new Set<string>()

  const add = (v: unknown) => {
    if (typeof v !== 'string' || !v || isPlaceholder(v) || seen.has(v)) return
    ordered.push(v)
    seen.add(v)
  }

  for (const key of TAG_ORDER) add(c[key])
  for (const v of Object.values(c)) add(v)
  return ordered
}

export interface HistoryPair {
  q: string
  a: string
}

const FIRST_QUESTION = 'What are you working on?'

const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

/**
 * Splits the transcript into completed question/answer pairs plus the question currently being
 * asked. The opening user message has no assistant question before it, so it is paired with the
 * implicit prompt the host page asked.
 *
 * Two cases: mid-stream, where the current question is still arriving in `streamingText` and
 * every committed message is history; and settled, where the current question is the last
 * committed assistant message.
 */
export function buildHistory(messages: Message[], streamingText: string): {
  historyPairs: HistoryPair[]
  currentQuestion: string
} {
  const pairsFrom = (msgs: Message[]): HistoryPair[] => {
    const pairs: HistoryPair[] = []
    if (msgs.length > 0 && msgs[0].role === 'user') {
      pairs.push({ q: FIRST_QUESTION, a: msgs[0].content })
    }
    for (let i = 1; i + 1 < msgs.length; i += 2) {
      if (msgs[i].role === 'assistant' && msgs[i + 1].role === 'user') {
        pairs.push({ q: truncate(msgs[i].content, 52), a: msgs[i + 1].content })
      }
    }
    return pairs
  }

  if (streamingText) {
    return { historyPairs: pairsFrom(messages), currentQuestion: streamingText }
  }

  const lastAsstIdx = messages.map(m => m.role).lastIndexOf('assistant')
  if (lastAsstIdx < 0) {
    // The shopper has spoken but no answer has landed yet.
    return { historyPairs: pairsFrom(messages), currentQuestion: '' }
  }
  return {
    historyPairs: pairsFrom(messages.slice(0, lastAsstIdx)),
    currentQuestion: messages[lastAsstIdx].content,
  }
}

/**
 * Tags shown above the shopping list: captured constraints, then any confirmed selection not
 * already represented. UI actions are not preferences and never appear.
 */
export function buildDisplayTags(intent: IntentModel | null, selections: string[]): string[] {
  const constraintTags = buildConstraintTags(intent)
  const constraintSet = new Set(constraintTags.map(t => t.toLowerCase().trim()))
  const extras = selections.filter(s =>
    s && !constraintSet.has(s.toLowerCase().trim()) && !/show me now|more ideas/i.test(s)
  )
  return [...constraintTags, ...extras]
}
