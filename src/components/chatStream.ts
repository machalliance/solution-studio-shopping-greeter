/**
 * Client-side helpers for a /api/chat turn. Extracted from App.sendMessage, which had grown to
 * hold three unrelated concerns at once — selection bookkeeping, SSE framing, and React state
 * transitions. Only the last genuinely needs to live in the component; the two here are pure and
 * testable on their own.
 */

/**
 * The fixed step-2/3 style chips. A pick that follows one of these is a sub-direction of it
 * rather than a separate answer, so it replaces the parent instead of appending beside it —
 * the tag should read "Coastal Beach House", not "Coastal" and "Beach House".
 */
const STYLE_FAMILIES = new Set(['Scandi', 'Coastal', 'Industrial', 'Modern', 'Farmhouse',
  'Transitional', 'Japandi', 'Mediterranean', 'Minimalist', 'Preppy', 'Classic'])

/**
 * Next confirmed-selection list after the shopper picks `text`.
 * Free-typed replies (isSelection false) are not selections and leave the list untouched.
 */
export function nextSelections(prev: string[], text: string, isSelection: boolean): string[] {
  if (!isSelection) return prev
  const last = prev[prev.length - 1] ?? ''
  if (!STYLE_FAMILIES.has(last)) return [...prev, text]
  // Only prefix the family when the sub-direction doesn't already name it, so a chip like
  // "Coastal Modern" doesn't become "Coastal Coastal Modern".
  const merged = text.toLowerCase().includes(last.toLowerCase()) ? text : `${last} ${text}`
  return [...prev.slice(0, -1), merged]
}

/** Groups refinement labels into the rows of three the chip strip cycles through. */
export function chunkRefinements(refinements: string[], size = 3): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < refinements.length; i += size) chunks.push(refinements.slice(i, i + size))
  return chunks
}

/**
 * Yields each parsed event from an SSE body.
 *
 * Chunk boundaries do not line up with event boundaries, so a partial trailing block is carried
 * over to the next read rather than parsed. An unparseable block is skipped instead of aborting
 * the stream — one malformed event must not cost the shopper the rest of the turn.
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const dataLine = block.split('\n').find(l => l.startsWith('data: '))
      if (!dataLine) continue
      const raw = dataLine.slice(6).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        yield JSON.parse(raw)
      } catch { /* malformed event — skip it, keep the stream */ }
    }
  }
}
