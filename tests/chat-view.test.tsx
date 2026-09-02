// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ChatView } from '../src/components/ChatView'
import type { IntentModel, CategoryResult } from '../src/types/intent'
import type { AppState, Message } from '../src/components/App'

// ChatView is prop-driven, so these are behaviour tests rather than snapshots: what the shopper
// can click, what gets sent back up, and which of the two very different render paths
// (conversation card vs results nav) they end up in.

// jsdom has no ResizeObserver; the card-height effect installs one unconditionally.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

type ChatViewProps = React.ComponentProps<typeof ChatView>

function makeHandlers() {
  return {
    onSend: vi.fn<ChatViewProps['onSend']>(),
    onStartOver: vi.fn<ChatViewProps['onStartOver']>(),
    onClose: vi.fn<ChatViewProps['onClose']>(),
    onShowMe: vi.fn<ChatViewProps['onShowMe']>(),
  }
}

let handlers: ReturnType<typeof makeHandlers>

function category(name: string, extra: Partial<CategoryResult> = {}): CategoryResult {
  return {
    name,
    displayName: name[0].toUpperCase() + name.slice(1),
    displayRole: 'supporting',
    weight: 5,
    products: [],
    scrollProducts: [],
    cmsContent: [],
    showAllUrl: `/search?q=${name}`,
    ...extra,
  }
}

function renderChat(overrides: Partial<ChatViewProps> = {}) {
  const props: ChatViewProps = {
    messages: [],
    streamingText: '',
    initialRefinements: [],
    earlyReady: false,
    loading: false,
    refining: false,
    appState: 'chat' as AppState,
    intent: null,
    categories: [],
    summary: '',
    summaryKey: 0,
    pendingOptions: null,
    pendingOptionsKind: 'options',
    selections: [],
    startingPoints: ['Powder room refresh', 'Deck refinishing'],
    cardBrand: 'Start a project',
    ...handlers,
    ...overrides,
  }
  return render(<ChatView {...props} />)
}

const msg = (role: Message['role'], content: string): Message => ({ role, content })

beforeEach(() => {
  handlers = makeHandlers()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

describe('ChatView — welcome state', () => {
  it('offers the starting points and sends the one clicked', () => {
    renderChat()
    expect(screen.getByText('What are you working on today?')).toBeTruthy()

    fireEvent.click(screen.getByText('Deck refinishing'))

    expect(handlers.onSend).toHaveBeenCalledWith('Deck refinishing')
  })

  it('leaves the welcome state once a message exists', () => {
    renderChat({ messages: [msg('user', 'powder room')] })
    expect(screen.queryByText('What are you working on today?')).toBeNull()
  })

  it('shows the brand name it was given', () => {
    renderChat({ cardBrand: 'Get inspired' })
    expect(screen.getByText('Get inspired')).toBeTruthy()
  })
})

describe('ChatView — conversation state', () => {
  it('shows the streaming text as the current question while it arrives', () => {
    renderChat({ messages: [msg('user', 'powder room')], streamingText: 'What style?' })
    expect(screen.getByText('What style?')).toBeTruthy()
  })

  it('falls back to the last assistant message once streaming settles', () => {
    renderChat({ messages: [msg('user', 'powder room'), msg('assistant', 'What style?')] })
    expect(screen.getByText('What style?')).toBeTruthy()
  })

  it('shows each answer as a tag', () => {
    renderChat({
      messages: [msg('user', 'powder room'), msg('assistant', 'What style?'), msg('user', 'Coastal')],
      streamingText: 'And your budget?',
    })
    expect(screen.getByText('powder room')).toBeTruthy()
    expect(screen.getByText('Coastal')).toBeTruthy()
  })

  it('never shows "Show me now" as an answered question', () => {
    renderChat({
      messages: [msg('user', 'powder room'), msg('assistant', 'What style?'), msg('user', 'Show me now')],
      streamingText: 'Building',
    })
    expect(screen.getByText('powder room')).toBeTruthy()
    expect(screen.queryByText('Show me now')).toBeNull()
  })

  it('shows the assembling indicator instead of a question', () => {
    renderChat({ appState: 'assembling', messages: [msg('user', 'powder room')] })
    expect(screen.getByText('Building your list…')).toBeTruthy()
  })

  it('wires start-over and close to their handlers', () => {
    renderChat()
    fireEvent.click(screen.getByText('Start over'))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(handlers.onStartOver).toHaveBeenCalled()
    expect(handlers.onClose).toHaveBeenCalled()
  })
})

describe('ChatView — chip semantics', () => {
  const withChips = (kind: 'options' | 'select' | 'topic', choices: string[]) =>
    renderChat({
      messages: [msg('user', 'x'), msg('assistant', 'Pick one')],
      pendingOptions: choices,
      pendingOptionsKind: kind,
    })

  it('treats an options chip as a value selection', () => {
    withChips('options', ['Coastal', 'Scandi'])
    fireEvent.click(screen.getByText('Coastal'))
    expect(handlers.onSend).toHaveBeenCalledWith('Coastal', true)
  })

  it('treats a topic chip as a pivot, not a value', () => {
    withChips('topic', ['Colour direction', 'Show me now'])
    fireEvent.click(screen.getByText('Colour direction'))
    expect(handlers.onSend).toHaveBeenCalledWith('Colour direction', false)
  })

  it('routes "Show me now" to the dedicated action regardless of chip kind', () => {
    withChips('select', ['Show me now'])
    fireEvent.click(screen.getByText('Show me now'))
    expect(handlers.onShowMe).toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  // A loose substring match once caught this label and derailed the anchor-item question.
  it('does not route a merely similar label to the show-me action', () => {
    withChips('topic', ['Show me what you have'])
    fireEvent.click(screen.getByText('Show me what you have'))
    expect(handlers.onShowMe).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('Show me what you have', false)
  })

  it('treats Budget as a pivot topic even among value chips', () => {
    withChips('options', ['Budget'])
    fireEvent.click(screen.getByText('Budget'))
    expect(handlers.onSend).toHaveBeenCalledWith('Budget', false)
  })

  it('hides chips while a turn is in flight', () => {
    renderChat({
      messages: [msg('user', 'x'), msg('assistant', 'Pick one')],
      pendingOptions: ['Coastal'],
      loading: true,
    })
    expect(screen.queryByText('Coastal')).toBeNull()
  })
})

describe('ChatView — free text input', () => {
  it('sends trimmed input and clears the field', () => {
    renderChat({ messages: [msg('assistant', 'Anything else?')] })
    const input = screen.getByPlaceholderText('Reply…') as HTMLInputElement

    fireEvent.change(input, { target: { value: '  navy please  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(handlers.onSend).toHaveBeenCalledWith('navy please', false)
    expect(input.value).toBe('')
  })

  it('ignores an empty or whitespace-only submission', () => {
    renderChat({ messages: [msg('assistant', 'Anything else?')] })
    const input = screen.getByPlaceholderText('Reply…')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('blocks input entirely while assembling', () => {
    renderChat({ appState: 'assembling' })
    expect((screen.getByPlaceholderText('Reply…') as HTMLInputElement).disabled).toBe(true)
  })

  it('marks a results-state refinement as a selection', () => {
    renderChat({ appState: 'results', categories: [category('top')] })
    const input = screen.getByPlaceholderText('Refine your results…')

    fireEvent.change(input, { target: { value: 'no black' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(handlers.onSend).toHaveBeenCalledWith('no black', true)
  })
})

describe('ChatView — show me now button', () => {
  it('stays hidden until the turn is flagged early-ready', () => {
    renderChat({ messages: [msg('assistant', 'What style?')] })
    expect(screen.queryByText('✦ Show Me Now')).toBeNull()
  })

  it('triggers the dedicated show-me action when clicked', () => {
    renderChat({ messages: [msg('assistant', 'What style?')], earlyReady: true })
    fireEvent.click(screen.getByText('✦ Show Me Now'))
    expect(handlers.onShowMe).toHaveBeenCalled()
  })

  it('is disabled while a turn is in flight', () => {
    renderChat({ messages: [msg('assistant', 'What style?')], earlyReady: true, loading: true })
    expect((screen.getByText('✦ Show Me Now') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ChatView — results state', () => {
  const intent: IntentModel = {
    goal: 'powder room',
    goalType: 'project',
    constraints: { style: 'Coastal', budget: 'Under $2,000', finish: 'Brass' },
    sessionId: 's1',
  }

  it('lists the assembled categories in order with their rationales', () => {
    renderChat({
      appState: 'results',
      categories: [category('vanity', { rationale: 'anchors the room' }), category('mirror')],
    })
    expect(screen.getByText('Your Shopping List')).toBeTruthy()
    expect(screen.getByText('Vanity')).toBeTruthy()
    expect(screen.getByText('anchors the room')).toBeTruthy()
    expect(screen.getByText('Mirror')).toBeTruthy()
  })

  it('renders the captured constraints as tags in the preferred order', () => {
    renderChat({ appState: 'results', intent, categories: [category('vanity')] })
    const tags = [...document.querySelectorAll('.g-intent-tag')].map(e => e.textContent)
    expect(tags).toEqual(['Coastal', 'Under $2,000', 'Brass'])
  })

  it('omits placeholder and no-preference constraint values', () => {
    renderChat({
      appState: 'results',
      intent: { ...intent, constraints: { style: 'Coastal', fit: 'No preference', budget: '<budget>' } },
      categories: [category('vanity')],
    })
    const tags = [...document.querySelectorAll('.g-intent-tag')].map(e => e.textContent)
    expect(tags).toEqual(['Coastal'])
  })

  it('appends selections that are not already constraint tags, skipping UI actions', () => {
    renderChat({
      appState: 'results',
      intent,
      selections: ['Coastal', 'Beach House', 'Show me now'],
      categories: [category('vanity')],
    })
    const tags = [...document.querySelectorAll('.g-intent-tag')].map(e => e.textContent)
    expect(tags).toContain('Beach House')
    expect(tags).not.toContain('Show me now')
    expect(tags.filter(t => t === 'Coastal')).toHaveLength(1)
  })

  it('shows the advisory summary', () => {
    renderChat({ appState: 'results', summary: 'Coastal with brass accents.', categories: [category('vanity')] })
    expect(screen.getByText('Coastal with brass accents.')).toBeTruthy()
  })

  it('shows the refining indicator during a re-assembly', () => {
    renderChat({ appState: 'results', refining: true, categories: [category('vanity')] })
    expect(screen.getByText('Updating results…')).toBeTruthy()
  })
})

describe('ChatView — refinement chips', () => {
  const base = {
    appState: 'results' as AppState,
    categories: [category('top')],
    intent: { goal: 'g', goalType: 'style', constraints: {}, sessionId: 's' } as IntentModel,
  }

  it('shows the first chunk and sends a clicked chip as free text', () => {
    renderChat({ ...base, initialRefinements: [['Colour', 'Fabric'], ['Fit']] })
    fireEvent.click(screen.getByText('Colour'))
    expect(handlers.onSend).toHaveBeenCalledWith('Colour')
  })

  it('cycles to the next chunk before fetching more', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderChat({ ...base, initialRefinements: [['Colour'], ['Fit']] })

    fireEvent.click(screen.getByText('More ideas'))

    expect(screen.getByText('Fit')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches a fresh set once the chunks run out', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ refinements: ['A', 'B', 'C', 'D'] }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    renderChat({ ...base, initialRefinements: [['Colour']] })

    fireEvent.click(screen.getByText('More ideas'))

    await waitFor(() => expect(screen.getByText('A')).toBeTruthy())
    expect(fetchSpy).toHaveBeenCalledWith('/api/refinements', expect.objectContaining({ method: 'POST' }))
    // Chunked in threes, so the fourth is held back for the next cycle.
    expect(screen.queryByText('D')).toBeNull()
  })

  it('leaves the current chips in place when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    renderChat({ ...base, initialRefinements: [['Colour']] })

    fireEvent.click(screen.getByText('More ideas'))

    await waitFor(() => expect((screen.getByText('More ideas') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText('Colour')).toBeTruthy()
  })
})
