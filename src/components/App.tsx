import { useState, useEffect, useCallback, useRef } from 'react'
import type { IntentModel, CategoryResult, CuratedOutfit } from '../types/intent'
import { ChatView } from './ChatView'
import { ResultsView } from './ResultsView'
import { nextSelections, chunkRefinements, readSSE, postIntent } from './chatStream'

export type AppState = 'chat' | 'assembling' | 'results'

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

const STORAGE_KEY = 'greeter-session'

interface SavedSession {
  intent: IntentModel
  categories: CategoryResult[]
  curatedOutfits?: CuratedOutfit[]
  messages: Message[]
  selections: string[]
  summary?: string
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveSession(data: SavedSession) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {}
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
  // Fire-and-forget: a failed reset leaves stale server state, which is the old behaviour, and
  // is not worth blocking the shopper's fresh start on.
  fetch('/api/session/reset', { method: 'POST' }).catch(() => {})
}

// The session id is issued by the server as an HttpOnly cookie and travels automatically on
// every request — see src/server/session.ts. The client neither generates nor sends one: a
// client-supplied id was trusted by the server, so anyone could read another session's work.
// "Start fresh" therefore cannot drop the id itself, and clearing local state alone was not
// enough: the server keeps the intent and assembled categories under that same cookie, and
// chat.ts prefers its stored categories over what the client sends, so the next conversation
// was silently treated as a refinement of the one the shopper just abandoned. It now asks the
// server to clear its side too — see POST /api/session/reset.

export function App() {
  const params = new URLSearchParams(location.search)
  const initialGoal = params.get('goal') ?? ''
  const skin = params.get('skin') ?? 'project'
  // Set by the host page's "View my shopping list" floating trigger (shown instead of the
  // normal entry CTA whenever a saved session exists) — jumps straight to the last results
  // state, skipping the Continue/Start-fresh prompt entirely.
  const resumeParam = params.get('resume') === '1'

  useEffect(() => {
    document.body.setAttribute('data-skin', skin)
  }, [skin])

  const [appState, setAppState] = useState<AppState>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [intent, setIntent] = useState<IntentModel | null>(null)
  const [categories, setCategories] = useState<CategoryResult[]>([])
  const [curatedOutfits, setCuratedOutfits] = useState<CuratedOutfit[]>([])
  const [summary, setSummary] = useState('')
  const [summaryKey, setSummaryKey] = useState(0)  // incremented only on first fresh results
  const summaryAnimatedRef = useRef(false)          // prevents re-animation on refinements
  const [initialRefinements, setInitialRefinements] = useState<string[][]>([])
  const [earlyReady, setEarlyReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refining, setRefining] = useState(false)  // re-assembly in results state
  const [pendingOptions, setPendingOptions] = useState<{ choices: string[]; kind: 'options' | 'select' | 'topic' } | null>(null)
  const [showContinue, setShowContinue] = useState(() => !!loadSession() && !resumeParam)
  const [savedSummary] = useState(() => loadSession()?.intent.goal ?? '')

  // Chip selections — ground truth for what the user has explicitly chosen.
  // A ref holds the live value so sendMessage always sees it without being a dependency.
  const selectionsRef = useRef<string[]>(loadSession()?.selections ?? [])
  const [selections, setSelections] = useState<string[]>(selectionsRef.current)

  const [streamingText, setStreamingText] = useState('')

  function resetState() {
    clearSession()
    setAppState('chat')
    setRefining(false)
    setMessages([])
    setIntent(null)
    setCategories([])
    setCuratedOutfits([])
    setSummary('')
    setSummaryKey(0)
    summaryAnimatedRef.current = false
    setInitialRefinements([])
    setEarlyReady(false)
    setStreamingText('')
    setShowContinue(false)
    selectionsRef.current = []
    setSelections([])
  }

  const startFresh = useCallback(() => {
    resetState()
  }, [])

  const resumeSession = useCallback(() => {
    const session = loadSession()
    if (!session) return
    setIntent(session.intent)
    setCategories(session.categories)
    if (session.curatedOutfits) setCuratedOutfits(session.curatedOutfits)
    setMessages(session.messages)
    selectionsRef.current = session.selections ?? []
    setSelections(selectionsRef.current)
    if (session.summary) setSummary(session.summary)
    summaryAnimatedRef.current = true  // restored — skip animation
    setAppState('results')
    setShowContinue(false)
  }, [])

  // ?resume=1 shortcut: jump straight to the saved session's results, no Continue prompt.
  // Falls through to the normal welcome state if the session is missing (e.g. cleared
  // between page load and the trigger being clicked) rather than getting stuck.
  useEffect(() => {
    if (resumeParam) resumeSession()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (appState === 'results' && intent && categories.length) {
      saveSession({ intent, categories, curatedOutfits: curatedOutfits.length ? curatedOutfits : undefined, messages, selections, summary })
    }
  }, [appState, intent, categories, curatedOutfits, messages, selections])

  const sendMessage = useCallback(async (text: string, isSelection = false) => {
    // Record chip selections immediately — before the API call so the server gets them.
    const updatedSelections = nextSelections(selectionsRef.current, text, isSelection)
    if (isSelection) {
      selectionsRef.current = updatedSelections
      setSelections(updatedSelections)
    }

    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setStreamingText('')
    setLoading(true)
    setPendingOptions(null)
    // Immediately show dots when refining from results state
    if (categories.length > 0) setRefining(true)

    let assistantText = ''

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          intent,
          selections: updatedSelections,
          // Include assembled categories so the server can re-assemble after a restart
          categories: categories.map(c => c.name),
        }),
      })

      if (!res.body) throw new Error('No response body')

      for await (const event of readSSE(res.body)) {
        switch (event.type) {
          case 'text-delta':
            assistantText += event.content
            setStreamingText(t => t + event.content)
            break
          case 'options':
            if (Array.isArray(event.choices) && event.choices.length) {
              setPendingOptions({ choices: event.choices, kind: event.kind ?? 'options' })
            }
            break
          case 'early-ready':
            setEarlyReady(true)
            break
          case 'assembling':
          case 'building':
            // In results state, stay in results and show an inline indicator.
            // Switching to 'assembling' would hide the results panel, which is jarring.
            if (appState === 'results') {
              setRefining(true)
            } else {
              setAppState('assembling')
            }
            break
          case 'intent-update':
            if (event.intent) setIntent(event.intent)
            break
          case 'intent-ready':
            if (event.intent) setIntent(event.intent)
            if (event.summary) {
              setSummary(event.summary)
              if (!summaryAnimatedRef.current) {
                summaryAnimatedRef.current = true
                setSummaryKey(k => k + 1)
              }
            }
            setRefining(false)
            if (event.categories?.length) {
              setCategories(event.categories)
              if (event.curatedOutfits?.length) setCuratedOutfits(event.curatedOutfits)
              setAppState('results')
            } else {
              setAppState('chat')
            }
            break
          case 'error':
            // Same rule as the 'building'/'assembling' case above: a failure during a
            // refinement (already in results) must not pop the compact card back open over
            // the collage — that's what this bug looked like from the outside. Stay in
            // results, clear the "Updating results..." indicator, and surface the error as
            // a chat message instead. Only pre-results errors (no collage to preserve yet)
            // fall back to the compact card.
            setRefining(false)
            if (appState !== 'results') setAppState('chat')
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `⚠️ ${event.message ?? 'Something went wrong — please try again.'}`,
            }])
            break
          case 'refinements':
            if (event.refinements?.length) {
              setInitialRefinements(chunkRefinements(event.refinements))
            }
            break
        }
      }
    } catch (err) {
      // Committed as a message, not into streamingText: the unconditional setStreamingText('')
      // below clears that before it can render, so a failed turn used to leave the shopper
      // looking at a blank card with no error and no way to tell the request had died.
      // Matches how the 'error' SSE event above surfaces the same class of failure.
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '⚠️ Something went wrong — please try again.',
      }])
      console.error(err)
    }

    if (assistantText) {
      setMessages(prev => [...prev, { role: 'assistant', content: assistantText }])
    }
    setStreamingText('')
    setLoading(false)
    setAppState(prev => prev === 'assembling' ? 'chat' : prev)
  }, [messages, intent, categories])

  // Dedicated "Show me now" action — NOT a chat message, deliberately. It never goes through
  // the conversational LLM turn (streamObject/TurnSchema in /api/chat); it posts straight to
  // /api/show-me-now, which assembles results directly from whatever intent is captured so
  // far with its own hard-guarantee fallback. Both UI triggers (the quick-action chip and the
  // dedicated button in ChatView.tsx) call this exact same function — there is only one code
  // path for this action, not two that can silently diverge.
  const showMeNow = useCallback(async () => {
    setAppState('assembling')
    setPendingOptions(null)
    try {
      const res = await postIntent('/api/show-me-now', intent, categories)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`)

      setIntent(data.intent)
      setCategories(data.categories)
      if (data.curatedOutfits?.length) setCuratedOutfits(data.curatedOutfits)
      if (data.summary) {
        setSummary(data.summary)
        if (!summaryAnimatedRef.current) {
          summaryAnimatedRef.current = true
          setSummaryKey(k => k + 1)
        }
      }
      if (data.refinements?.length) setInitialRefinements(chunkRefinements(data.refinements))
      setAppState('results')
    } catch (err) {
      console.error('[show me now]', err)
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Something went wrong putting your results together — please try again.' }])
      setAppState('chat')
    }
  }, [intent, categories])

  const autoStarted = useRef(false)
  useEffect(() => {
    if (initialGoal && !showContinue && !autoStarted.current) {
      autoStarted.current = true
      sendMessage(initialGoal)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (showContinue) {
    return (
      <div className="g-continue-screen">
        <div className="g-continue-card">
          <div className="g-continue-title">Continue your project?</div>
          {savedSummary && <div className="g-continue-desc">{savedSummary}</div>}
          <button className="g-btn-primary" onClick={resumeSession}>Continue</button>
          <button className="g-btn-ghost" onClick={startFresh}>Start fresh</button>
        </div>
      </div>
    )
  }

  const startingPoints: Record<string, string[]> = {
    project: ['Powder room refresh', 'Deck refinishing', 'Kitchen backsplash', 'New flooring'],
    clothing: ['Rooftop dinner outfit', 'Weekend look', 'Work from office', 'Wedding guest'],
  }

  // Mirrors the host page's heroCta copy per skin (host/index.html skins.<skin>.heroCta) —
  // the conversation-state card header names itself the same way the entry CTA that opened
  // it did, instead of the generic "Greeter".
  const CARD_BRAND: Record<string, string> = {
    project: 'Start a project',
    clothing: 'Get inspired',
  }

  function closePanel() {
    try {
      // Prefer the host's own cleanup (removes the wrap AND clears the backdrop blur it
      // applied to its own page). Fall back to a bare removal for any host that embeds
      // this widget without defining that helper — the widget must still work unmodified.
      const parentWin = window.parent as unknown as { closeGreeterPanel?: () => void }
      if (typeof parentWin.closeGreeterPanel === 'function') {
        parentWin.closeGreeterPanel()
      } else {
        (window.parent.document.getElementById('greeter-panel-wrap') as HTMLElement | null)?.remove()
      }
    } catch {}
  }

  const progressPct =
    appState === 'results' || appState === 'assembling' ? 100 :
    Math.min(90, messages.filter(m => m.role === 'user').length * 25)

  const isCardMode = appState === 'chat' || appState === 'assembling'

  const panel = (
    <div className={`g-panel ${appState === 'results' ? 'g-panel-split' : 'g-panel-chat-only'}`}>
      <ChatView
        messages={messages}
        streamingText={streamingText}
        initialRefinements={initialRefinements}
        earlyReady={earlyReady}
        loading={loading}
        refining={refining}
        appState={appState}
        intent={intent}
        categories={categories}
        summary={summary}
        summaryKey={summaryKey}
        pendingOptions={pendingOptions?.choices ?? null}
        pendingOptionsKind={pendingOptions?.kind ?? 'options'}
        selections={selections}
        startingPoints={startingPoints[skin] ?? startingPoints.project}
        cardBrand={CARD_BRAND[skin] ?? CARD_BRAND.project}
        onSend={sendMessage}
        onStartOver={startFresh}
        onClose={closePanel}
        onShowMe={showMeNow}
      />
      {appState !== 'chat' && (
        <ResultsView
          categories={categories}
          curatedOutfits={curatedOutfits}
          intent={intent}
          loading={appState === 'assembling'}
          skin={skin}
        />
      )}
    </div>
  )

  // Card mode already gives its own small floating .g-chat its rounded/shadowed
  // treatment directly (see .g-shell-card .g-chat in style.css) — the panel renders
  // as-is. Results mode has no equivalent self-styled element (it's a wide split view,
  // not one card), so it needs its own frame: rounded corners, shadow, capped width,
  // centered — matching the same "floats over a dimmed/blurred backdrop" language as
  // card mode, now that the host page no longer provides that box (see openGreeterPanel
  // in host/*.html — the iframe is intentionally full-bleed/transparent so the app's own
  // backdrop can reach the real page through it; that same iframe used to double as a
  // large white rounded box for results mode "for free", which vanished with it).
  return (
    <div className={`g-shell${isCardMode ? ' g-shell-card' : ''}`}>
      {isCardMode ? panel : (
        <div className="g-results-frame">
          <div className="g-stage-header">
            <span className="g-stage-brand">Shopping List & Inspiration</span>
            <div className="g-stage-actions">
              <button className="g-stage-restart" onClick={startFresh}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
                  <path d="M3 12a9 9 0 1 1 2.64 6.36"/><path d="M3 21v-6h6"/>
                </svg>
                Start over
              </button>
              <button className="g-close-btn" onClick={closePanel} aria-label="Close">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="g-progress-track">
            <div className="g-progress-fill" style={{width: `${progressPct}%`}} />
          </div>
          {panel}
        </div>
      )}
    </div>
  )
}
