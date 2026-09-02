// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { App } from '../src/components/App'

// App owns the client half of the conversation: it posts to /api/chat, parses the SSE stream,
// and drives every state transition off those events. ChatView and ResultsView render whatever
// it decides, so these tests go through the real components and assert what a shopper sees.

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Builds a Response whose body streams the given SSE events, as /api/chat would. */
function sseResponse(events: Record<string, unknown>[], { split = false } = {}) {
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  // `split` cuts the payload mid-event to prove the buffering handles a chunk boundary that
  // does not line up with an event boundary.
  const chunks = split
    ? [bytes.slice(0, Math.floor(bytes.length / 2)), bytes.slice(Math.floor(bytes.length / 2))]
    : [bytes]
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined },
      }),
    },
  }
}

const jsonResponse = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data })

let fetchMock: ReturnType<typeof vi.fn>

/** Last JSON body posted to the given endpoint. */
function lastBodyFor(path: string) {
  const call = [...fetchMock.mock.calls].reverse().find(c => c[0] === path)
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null
}

const categoryFixture = (name: string) => ({
  name, displayName: name[0].toUpperCase() + name.slice(1), displayRole: 'supporting', weight: 5,
  products: [], scrollProducts: [], cmsContent: [], showAllUrl: `/search?q=${name}`,
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // Defaults to a benign JSON response so incidental calls a test does not stub — the
  // fire-and-forget POST /api/session/reset that "Start fresh" makes — still get a promise back.
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function startConversation(events: Record<string, unknown>[], opts?: { split?: boolean }) {
  fetchMock.mockResolvedValue(sseResponse(events, opts))
  render(<App />)
  fireEvent.click(screen.getByText('Powder room refresh'))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
}

describe('App — streaming a turn', () => {
  it('shows the streamed reply and the chips that follow it', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What ' },
      { type: 'text-delta', content: 'style?' },
      { type: 'options', kind: 'options', choices: ['Coastal', 'Scandi'] },
      { type: 'intent-update', intent: { goal: 'powder room', goalType: 'project', constraints: {}, sessionId: 's' } },
      { type: 'done' },
    ])

    await waitFor(() => expect(screen.getByText('What style?')).toBeTruthy())
    expect(screen.getByText('Coastal')).toBeTruthy()
    expect(screen.getByText('Scandi')).toBeTruthy()
  })

  it('reassembles events split across chunk boundaries', async () => {
    await startConversation([
      { type: 'text-delta', content: 'A question that spans a chunk boundary' },
      { type: 'options', kind: 'options', choices: ['Coastal', 'Scandi'] },
      { type: 'done' },
    ], { split: true })

    await waitFor(() => expect(screen.getByText('A question that spans a chunk boundary')).toBeTruthy())
    expect(screen.getByText('Coastal')).toBeTruthy()
  })

  it('ignores malformed event payloads without losing the rest of the stream', async () => {
    const good = `data: ${JSON.stringify({ type: 'text-delta', content: 'Still here' })}\n\n`
    const bad = 'data: {not json\n\n'
    const bytes = new TextEncoder().encode(bad + good)
    let sent = false
    fetchMock.mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) },
    })
    render(<App />)
    fireEvent.click(screen.getByText('Powder room refresh'))

    await waitFor(() => expect(screen.getByText('Still here')).toBeTruthy())
  })

  it('surfaces a friendly message when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    render(<App />)
    fireEvent.click(screen.getByText('Powder room refresh'))

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeTruthy())
  })

  // A 429 or 400 from /api/chat (rate limit, bad body) comes back as plain JSON, not SSE
  // framing — readSSE finds no "data: " lines in it and yields nothing, silently. Without a
  // res.ok check first, the loading spinner just cleared with no error shown to the shopper.
  it('surfaces the server error instead of silently clearing when /api/chat responds non-OK', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Too many requests — please wait a moment and try again.' }, false))
    render(<App />)
    fireEvent.click(screen.getByText('Powder room refresh'))

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeTruthy())
  })
})

describe('App — assembly and results', () => {
  const readyEvents = [
    { type: 'building' },
    {
      type: 'intent-ready',
      intent: { goal: 'powder room', goalType: 'project', constraints: { style: 'Coastal' }, sessionId: 's' },
      categories: [categoryFixture('vanity'), categoryFixture('mirror')],
      summary: 'Coastal with brass accents.',
      curatedOutfits: [],
    },
    { type: 'refinements', refinements: ['Colour', 'Finish', 'Size', 'Budget'] },
    { type: 'done' },
  ]

  it('switches to the results view and lists the assembled categories', async () => {
    await startConversation(readyEvents)

    await waitFor(() => expect(screen.getByText('Your Shopping List')).toBeTruthy())
    expect(screen.getByText('Vanity')).toBeTruthy()
    expect(screen.getByText('Mirror')).toBeTruthy()
  })

  it('chunks refinements into threes', async () => {
    await startConversation(readyEvents)
    await waitFor(() => expect(screen.getByText('Your Shopping List')).toBeTruthy())

    expect(screen.getByText('Colour')).toBeTruthy()
    expect(screen.getByText('Size')).toBeTruthy()
    expect(screen.queryByText('Budget')).toBeNull()
  })

  it('stays in the chat state when a ready event carries no categories', async () => {
    await startConversation([
      { type: 'text-delta', content: 'One more thing?' },
      { type: 'intent-ready', intent: { goal: 'g', goalType: 'project', constraints: {}, sessionId: 's' }, categories: [] },
      { type: 'done' },
    ])

    await waitFor(() => expect(screen.getByText('One more thing?')).toBeTruthy())
    expect(screen.queryByText('Your Shopping List')).toBeNull()
  })

  it('saves the session so it can be resumed', async () => {
    await startConversation(readyEvents)
    await waitFor(() => expect(screen.getByText('Your Shopping List')).toBeTruthy())

    await waitFor(() => expect(localStorage.getItem('greeter-session')).toBeTruthy())
    const saved = JSON.parse(localStorage.getItem('greeter-session')!)
    expect(saved.intent.goal).toBe('powder room')
    expect(saved.categories.map((c: any) => c.name)).toEqual(['vanity', 'mirror'])
  })
})

describe('App — selection tracking', () => {
  it('sends the clicked chip as a selection on the next turn', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What style?' },
      { type: 'options', kind: 'options', choices: ['Coastal'] },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('Coastal')).toBeTruthy())

    fireEvent.click(screen.getByText('Coastal'))

    await waitFor(() => expect(lastBodyFor('/api/chat').selections).toEqual(['Coastal']))
  })

  // A sub-direction replaces its parent family so the tag reads "Coastal Beach House"
  // rather than two separate tags.
  it('merges a sub-direction into the style family it came from', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What style?' },
      { type: 'options', kind: 'options', choices: ['Coastal'] },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('Coastal')).toBeTruthy())

    fetchMock.mockResolvedValue(sseResponse([
      { type: 'text-delta', content: 'Which direction?' },
      { type: 'options', kind: 'options', choices: ['Beach House'] },
      { type: 'done' },
    ]))
    fireEvent.click(screen.getByText('Coastal'))
    await waitFor(() => expect(screen.getByText('Beach House')).toBeTruthy())

    fireEvent.click(screen.getByText('Beach House'))

    await waitFor(() => expect(lastBodyFor('/api/chat').selections).toEqual(['Coastal Beach House']))
  })

  it('does not double the family name when the sub-direction already contains it', async () => {
    await startConversation([
      { type: 'options', kind: 'options', choices: ['Coastal'] },
      { type: 'text-delta', content: 'What style?' },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('Coastal')).toBeTruthy())

    fetchMock.mockResolvedValue(sseResponse([
      { type: 'text-delta', content: 'Which direction?' },
      { type: 'options', kind: 'options', choices: ['Coastal Modern'] },
      { type: 'done' },
    ]))
    fireEvent.click(screen.getByText('Coastal'))
    await waitFor(() => expect(screen.getByText('Coastal Modern')).toBeTruthy())

    fireEvent.click(screen.getByText('Coastal Modern'))

    await waitFor(() => expect(lastBodyFor('/api/chat').selections).toEqual(['Coastal Modern']))
  })

  it('does not record free text typed during the conversation as a selection', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What style?' },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('What style?')).toBeTruthy())

    const input = screen.getByPlaceholderText('Reply…')
    fireEvent.change(input, { target: { value: 'something coastal' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(lastBodyFor('/api/chat').messages.at(-1).content).toBe('something coastal'))
    expect(lastBodyFor('/api/chat').selections).toEqual([])
  })
})

describe('App — show me now', () => {
  it('posts to the dedicated endpoint, not the chat turn', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What style?' },
      { type: 'early-ready' },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('✦ Show Me Now')).toBeTruthy())

    fetchMock.mockResolvedValue(jsonResponse({
      intent: { goal: 'powder room', goalType: 'project', constraints: {}, sessionId: 's' },
      categories: [categoryFixture('vanity')],
      summary: 'Done.',
      curatedOutfits: [],
      refinements: [],
    }))
    fireEvent.click(screen.getByText('✦ Show Me Now'))

    await waitFor(() => expect(screen.getByText('Your Shopping List')).toBeTruthy())
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/show-me-now')).toBe(true)
  })

  it('returns to the chat with an explanation when the endpoint errors', async () => {
    await startConversation([
      { type: 'text-delta', content: 'What style?' },
      { type: 'early-ready' },
      { type: 'done' },
    ])
    await waitFor(() => expect(screen.getByText('✦ Show Me Now')).toBeTruthy())

    fetchMock.mockResolvedValue(jsonResponse({ error: 'Could not assemble results' }, false))
    fireEvent.click(screen.getByText('✦ Show Me Now'))

    await waitFor(() => expect(screen.getByText(/something went wrong putting your results together/i)).toBeTruthy())
    expect(screen.queryByText('Your Shopping List')).toBeNull()
  })
})

describe('App — session resume', () => {
  const savedSession = {
    intent: { goal: 'powder room refresh', goalType: 'project', constraints: {}, sessionId: 's' },
    categories: [categoryFixture('vanity')],
    messages: [{ role: 'user', content: 'powder room refresh' }],
    selections: ['Coastal'],
    summary: 'Saved advice.',
  }

  it('offers to continue a saved session', () => {
    localStorage.setItem('greeter-session', JSON.stringify(savedSession))
    render(<App />)

    expect(screen.getByText('Continue your project?')).toBeTruthy()
    expect(screen.getByText('powder room refresh')).toBeTruthy()
  })

  it('restores the saved results on Continue', () => {
    localStorage.setItem('greeter-session', JSON.stringify(savedSession))
    render(<App />)

    fireEvent.click(screen.getByText('Continue'))

    expect(screen.getByText('Your Shopping List')).toBeTruthy()
    expect(screen.getByText('Vanity')).toBeTruthy()
  })

  it('clears the saved session on Start fresh', () => {
    localStorage.setItem('greeter-session', JSON.stringify(savedSession))
    render(<App />)

    fireEvent.click(screen.getByText('Start fresh'))

    expect(localStorage.getItem('greeter-session')).toBeNull()
    expect(screen.getByText('What are you working on today?')).toBeTruthy()
  })

  it('skips the prompt entirely with ?resume=1', () => {
    localStorage.setItem('greeter-session', JSON.stringify(savedSession))
    window.history.replaceState({}, '', '/?resume=1')
    render(<App />)

    expect(screen.queryByText('Continue your project?')).toBeNull()
    expect(screen.getByText('Your Shopping List')).toBeTruthy()
  })

  it('falls through to the welcome state if ?resume=1 finds no session', () => {
    window.history.replaceState({}, '', '/?resume=1')
    render(<App />)

    expect(screen.getByText('What are you working on today?')).toBeTruthy()
  })
})

describe('App — host page parameters', () => {
  it('auto-sends a goal supplied by the host page', async () => {
    window.history.replaceState({}, '', '/?goal=Deck%20refinishing')
    fetchMock.mockResolvedValue(sseResponse([{ type: 'text-delta', content: 'Nice.' }, { type: 'done' }]))

    render(<App />)

    await waitFor(() => expect(lastBodyFor('/api/chat').messages[0].content).toBe('Deck refinishing'))
  })

  it('uses the clothing starting points for the clothing skin', () => {
    window.history.replaceState({}, '', '/?skin=clothing')
    render(<App />)

    expect(screen.getByText('Rooftop dinner outfit')).toBeTruthy()
    expect(screen.getByText('Get inspired')).toBeTruthy()
    expect(document.body.getAttribute('data-skin')).toBe('clothing')
  })

  it('defaults to the project skin', () => {
    render(<App />)
    expect(screen.getByText('Powder room refresh')).toBeTruthy()
    expect(document.body.getAttribute('data-skin')).toBe('project')
  })
})
