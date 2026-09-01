import { describe, it, expect } from 'vitest'
import { nextSelections, chunkRefinements, readSSE } from '../src/components/chatStream'
import { buildConstraintTags, buildDisplayTags, buildHistory } from '../src/components/chatHistory'
import type { IntentModel } from '../src/types/intent'
import type { Message } from '../src/components/App'

const msg = (role: Message['role'], content: string): Message => ({ role, content })

const intentWith = (constraints: IntentModel['constraints']): IntentModel => ({
  goal: 'g', goalType: 'style', constraints, sessionId: 's',
})

describe('nextSelections', () => {
  it('leaves the list untouched for free-typed text', () => {
    expect(nextSelections(['Coastal'], 'something navy', false)).toEqual(['Coastal'])
  })

  it('appends a pick that does not follow a style family', () => {
    expect(nextSelections(['Under $400'], "Women's", true)).toEqual(['Under $400', "Women's"])
  })

  it('appends to an empty list', () => {
    expect(nextSelections([], 'Coastal', true)).toEqual(['Coastal'])
  })

  it('merges a sub-direction into the family it followed', () => {
    expect(nextSelections(['Coastal'], 'Beach House', true)).toEqual(['Coastal Beach House'])
  })

  it('does not repeat the family when the sub-direction already names it', () => {
    expect(nextSelections(['Coastal'], 'Coastal Modern', true)).toEqual(['Coastal Modern'])
  })

  it('matches the family name case-insensitively when deciding whether to prefix', () => {
    expect(nextSelections(['Coastal'], 'coastal chic', true)).toEqual(['coastal chic'])
  })

  it('only merges into the most recent entry', () => {
    expect(nextSelections(['Coastal', 'Under $400'], 'Beach House', true))
      .toEqual(['Coastal', 'Under $400', 'Beach House'])
  })

  it('merges only once — the combined value is no longer a bare family', () => {
    const first = nextSelections(['Coastal'], 'Beach House', true)
    expect(nextSelections(first, 'Warm evening', true))
      .toEqual(['Coastal Beach House', 'Warm evening'])
  })
})

describe('chunkRefinements', () => {
  it('groups into rows of three', () => {
    expect(chunkRefinements(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c'], ['d', 'e']])
  })

  it('returns nothing for an empty list', () => {
    expect(chunkRefinements([])).toEqual([])
  })

  it('keeps a short list as a single row', () => {
    expect(chunkRefinements(['a'])).toEqual([['a']])
  })
})

describe('readSSE', () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoded = chunks.map(c => new TextEncoder().encode(c))
    let i = 0
    return {
      getReader: () => ({
        read: async () => i < encoded.length
          ? { done: false, value: encoded[i++] }
          : { done: true, value: undefined },
      }),
    } as unknown as ReadableStream<Uint8Array>
  }

  const collect = async (s: ReadableStream<Uint8Array>) => {
    const out: Record<string, any>[] = []
    for await (const e of readSSE(s)) out.push(e)
    return out
  }

  it('yields each event in order', async () => {
    const events = await collect(streamOf(
      'data: {"type":"text-delta","content":"hi"}\n\ndata: {"type":"done"}\n\n',
    ))
    expect(events).toEqual([{ type: 'text-delta', content: 'hi' }, { type: 'done' }])
  })

  it('reassembles an event split across chunks', async () => {
    const events = await collect(streamOf('data: {"type":"text-de', 'lta","content":"hi"}\n\n'))
    expect(events).toEqual([{ type: 'text-delta', content: 'hi' }])
  })

  it('reassembles a multi-byte character split across chunks', async () => {
    const full = new TextEncoder().encode('data: {"type":"t","content":"✦"}\n\n')
    let i = 0
    const chunks = [full.slice(0, 30), full.slice(30)]
    const stream = {
      getReader: () => ({
        read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
      }),
    } as unknown as ReadableStream<Uint8Array>
    expect(await collect(stream)).toEqual([{ type: 't', content: '✦' }])
  })

  it('skips a malformed event without dropping the rest', async () => {
    const events = await collect(streamOf(
      'data: {broken\n\ndata: {"type":"done"}\n\n',
    ))
    expect(events).toEqual([{ type: 'done' }])
  })

  it('ignores blocks with no data line, blank payloads and the [DONE] sentinel', async () => {
    const events = await collect(streamOf(
      ': keep-alive\n\ndata: \n\ndata: [DONE]\n\ndata: {"type":"done"}\n\n',
    ))
    expect(events).toEqual([{ type: 'done' }])
  })

  it('drops a trailing event that never terminated', async () => {
    // No closing blank line — the stream ended mid-event, so it was never complete.
    expect(await collect(streamOf('data: {"type":"done"}'))).toEqual([])
  })
})

describe('buildConstraintTags', () => {
  it('returns nothing without an intent', () => {
    expect(buildConstraintTags(null)).toEqual([])
  })

  it('orders known keys by the display order, not insertion order', () => {
    expect(buildConstraintTags(intentWith({ budget: 'Under $400', style: 'Coastal', fit: "Women's" })))
      .toEqual(['Coastal', "Women's", 'Under $400'])
  })

  it('appends unknown keys after the known ones', () => {
    expect(buildConstraintTags(intentWith({ somethingElse: 'Custom', style: 'Coastal' })))
      .toEqual(['Coastal', 'Custom'])
  })

  it('skips placeholder and no-preference values', () => {
    expect(buildConstraintTags(intentWith({
      style: 'Coastal', fit: 'No preference', budget: '<budget>', venue: 'unknown',
    }))).toEqual(['Coastal'])
  })

  it('de-duplicates repeated values across keys', () => {
    expect(buildConstraintTags(intentWith({ style: 'Coastal', styleFamily: 'Coastal' })))
      .toEqual(['Coastal'])
  })

  it('ignores non-string constraint values', () => {
    expect(buildConstraintTags(intentWith({
      style: 'Coastal',
      categoryConstraints: { top: { requiresTags: ['linen'] } },
      avoidances: ['black'],
    }))).toEqual(['Coastal'])
  })
})

describe('buildDisplayTags', () => {
  it('appends selections not already covered by a constraint', () => {
    expect(buildDisplayTags(intentWith({ style: 'Coastal' }), ['Coastal', 'Beach House']))
      .toEqual(['Coastal', 'Beach House'])
  })

  it('matches an existing constraint case- and whitespace-insensitively', () => {
    expect(buildDisplayTags(intentWith({ style: 'Coastal' }), ['  coastal  ']))
      .toEqual(['Coastal'])
  })

  it('never shows UI actions as preferences', () => {
    expect(buildDisplayTags(intentWith({ style: 'Coastal' }), ['Show me now', 'More ideas']))
      .toEqual(['Coastal'])
  })

  it('works with no intent at all', () => {
    expect(buildDisplayTags(null, ['Beach House'])).toEqual(['Beach House'])
  })
})

describe('buildHistory', () => {
  it('is empty before anything is said', () => {
    expect(buildHistory([], '')).toEqual({ historyPairs: [], currentQuestion: '' })
  })

  it('pairs the opening message with the implicit first question', () => {
    expect(buildHistory([msg('user', 'powder room')], 'What style?')).toEqual({
      historyPairs: [{ q: 'What are you working on?', a: 'powder room' }],
      currentQuestion: 'What style?',
    })
  })

  it('treats the streaming text as the current question and everything else as history', () => {
    const { historyPairs, currentQuestion } = buildHistory(
      [msg('user', 'powder room'), msg('assistant', 'What style?'), msg('user', 'Coastal')],
      'Budget?',
    )
    expect(currentQuestion).toBe('Budget?')
    expect(historyPairs.map(p => p.a)).toEqual(['powder room', 'Coastal'])
  })

  it('uses the last assistant message as the current question once settled', () => {
    const { historyPairs, currentQuestion } = buildHistory(
      [msg('user', 'powder room'), msg('assistant', 'What style?'), msg('user', 'Coastal'), msg('assistant', 'Budget?')],
      '',
    )
    expect(currentQuestion).toBe('Budget?')
    expect(historyPairs.map(p => p.a)).toEqual(['powder room', 'Coastal'])
  })

  it('still shows the opening answer while waiting for the first reply', () => {
    expect(buildHistory([msg('user', 'powder room')], '')).toEqual({
      historyPairs: [{ q: 'What are you working on?', a: 'powder room' }],
      currentQuestion: '',
    })
  })

  it('truncates a long question label', () => {
    const long = 'x'.repeat(80)
    const { historyPairs } = buildHistory(
      [msg('user', 'a'), msg('assistant', long), msg('user', 'b')],
      'next',
    )
    expect(historyPairs[1].q).toHaveLength(52)
    expect(historyPairs[1].q.endsWith('…')).toBe(true)
  })

  it('does not pair two consecutive messages from the same role', () => {
    const { historyPairs } = buildHistory(
      [msg('user', 'a'), msg('assistant', 'q1'), msg('assistant', 'q2')],
      'streaming',
    )
    expect(historyPairs).toEqual([{ q: 'What are you working on?', a: 'a' }])
  })
})
