import { useEffect, useRef, useState } from 'react'
import type { IntentModel, CategoryResult } from '../types/intent'
import type { AppState, Message } from './App'
import { buildDisplayTags, buildHistory } from './chatHistory'
import { chunkRefinements, postIntent } from './chatStream'
import { useTypewriter } from './useTypewriter'

interface Props {
  messages: Message[]
  streamingText: string
  initialRefinements: string[][]
  earlyReady: boolean
  loading: boolean
  refining: boolean
  appState: AppState
  intent: IntentModel | null
  categories: CategoryResult[]
  summary: string
  summaryKey: number
  pendingOptions: string[] | null
  pendingOptionsKind: 'options' | 'select' | 'topic'
  selections: string[]
  startingPoints: string[]
  cardBrand: string
  onSend: (text: string, isSelection?: boolean) => void
  onStartOver: () => void
  onClose: () => void
  onShowMe: () => void
}

export function ChatView({
  messages, streamingText, initialRefinements,
  earlyReady, loading, refining, appState, intent, categories, summary, summaryKey,
  pendingOptions, pendingOptionsKind, selections, startingPoints, cardBrand, onSend, onStartOver, onClose, onShowMe,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const [cardMinHeight, setCardMinHeight] = useState(0)
  const [inputValue, setInputValue] = useState('')

  // In card mode, record the tallest height the card has reached so it never shrinks back.
  useEffect(() => {
    if (appState === 'results') return
    const el = chatRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const h = Math.round(entry.contentRect.height)
        if (h > 0) setCardMinHeight(prev => Math.max(prev, h))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [appState])
  const [refinements, setRefinements] = useState<string[][]>(initialRefinements)
  const [chunkIndex, setChunkIndex] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  // Animates on genuine first results (summaryKey bumped); instant on refinements and restores.
  const { displayed: displayedSummary, done: summaryDone } = useTypewriter(summary, summaryKey)

  useEffect(() => {
    if (initialRefinements.length) {
      setRefinements(initialRefinements)
      setChunkIndex(0)
    }
  }, [initialRefinements])

  function submitFreeText() {
    const val = inputValue.trim()
    if (!val || loading || appState === 'assembling') return
    setInputValue('')
    // In results state, free-text refinements are recorded as selection tags
    onSend(val, appState === 'results')
  }

  function submitChip(chip: string) {
    if (loading || appState === 'assembling') return
    // "Show me now" is always a pivot action regardless of chip kind (GPT-4o emits it as 'select').
    // Exact match only — a loose substring match ("show me") also caught unrelated topic labels
    // like "Show me what you have" (the anchor-item topic), silently derailing that question.
    if (chip.trim().toLowerCase() === 'show me now') { onShowMe(); return }
    // "Budget" is a pivot topic — triggers a budget question round-trip, not a value selection
    if (chip === 'Budget') { onSend(chip, false); return }
    if (pendingOptionsKind === 'topic') {
      onSend(chip, false)  // TOPICS are pivot categories — not value selections
    } else {
      onSend(chip, true)   // OPTIONS / SELECT chips are value selections
    }
  }

  async function cycleOrFetch() {
    if (chunkIndex + 1 < refinements.length) {
      setChunkIndex(i => i + 1)
      return
    }
    if (!intent || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await postIntent('/api/refinements', intent, categories)
      const data = await res.json()
      if (Array.isArray(data.refinements) && data.refinements.length) {
        setRefinements(chunkRefinements(data.refinements))
        setChunkIndex(0)
      }
    } catch {}
    setLoadingMore(false)
  }

  const currentChunk = refinements[chunkIndex] ?? []
  const isBlocked = loading || appState === 'assembling'

  // ── Results state: shopping list nav ──
  if (appState === 'results') {
    const displayTags = buildDisplayTags(intent, selections)

    return (
      <div className="g-chat g-chat-results">
        {/* Large advisory text — typewriter animated */}
        {(displayedSummary || summary) && (
          <div className="g-advisory">
            <div className="g-advisory-label">Our Advice</div>
            <p className="g-advisory-text">
              {displayedSummary}
              {!summaryDone && <span className="g-advisory-cursor" />}
            </p>
          </div>
        )}

        {/* Tags below advisory text */}
        {displayTags.length > 0 && (
          <div className="g-intent-tags">
            {displayTags.map(t => <span key={t} className="g-intent-tag">{t}</span>)}
          </div>
        )}

        <div className="g-nav-title">Your Shopping List</div>

        <div className="g-nav-list">
          {categories.map((cat, i) => (
            <button
              key={cat.name}
              className="g-nav-item"
              onClick={() => {
                if (!cat.showAllUrl) return
                // Same-tab navigation — the floating "View my shopping list" trigger on the
                // destination page (driven by the saved session) is how the shopper gets
                // back, not a new tab.
                if (window.top) window.top.location.href = cat.showAllUrl
              }}
            >
              <span className="g-nav-num">{i + 1}</span>
              <div className="g-nav-item-body">
                <div className="g-nav-item-header">
                  <span>{cat.displayName}</span>
                  <svg className="g-nav-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </div>
                {cat.rationale && (
                  <span className="g-nav-rationale">{cat.rationale}</span>
                )}
              </div>
            </button>
          ))}
        </div>

        {currentChunk.length > 0 && (
          <div className="g-refinements">
            {currentChunk.map(chip => (
              <button key={chip} className="g-chip" onClick={() => onSend(chip)}>{chip}</button>
            ))}
            <button className="g-chip g-chip-more" disabled={loadingMore} onClick={cycleOrFetch}>
              {loadingMore ? '…' : 'More ideas'}
            </button>
          </div>
        )}

        {refining && (
          <div className="g-building">
            <span className="g-typing"><span/><span/><span/></span>
            <span>Updating results…</span>
          </div>
        )}

        <div className="g-input-row">
          <input
            ref={inputRef}
            type="text"
            className="g-input"
            placeholder="Refine your results…"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitFreeText() }}
          />
          <button className="g-send-btn" onClick={submitFreeText} disabled={!inputValue.trim() || loading || refining}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>
    )
  }

  // ── Conversation state ──

  // All complete AI-question → user-answer exchanges, plus the question being asked now.
  const { historyPairs, currentQuestion } = buildHistory(messages, streamingText)

  const isWelcome = messages.length === 0 && !loading && appState === 'chat'

  const cardStyle = cardMinHeight > 0 ? { minHeight: cardMinHeight } : undefined

  return (
    <div ref={chatRef} className="g-chat" style={cardStyle}>
      {/* Card header — the 'results' state has its own early return above and uses a global header instead */}
      <div className="g-card-head">
        <span className="g-stage-brand">{cardBrand}</span>
        <div className="g-stage-actions">
          <button className="g-stage-restart" onClick={onStartOver}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
              <path d="M3 12a9 9 0 1 1 2.64 6.36"/><path d="M3 21v-6h6"/>
            </svg>
            Start over
          </button>
          <button className="g-close-btn" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Answer tag strip — grows as answers accumulate. "Show me now" is a UI action, not
          a captured preference — excluded here so it doesn't read as an answered question. */}
      {(() => {
        const visiblePairs = historyPairs.filter(p => p.a.trim().toLowerCase() !== 'show me now')
        return (
          <div className={`g-tag-strip${visiblePairs.length > 0 ? ' has-tags' : ''}`}>
            {visiblePairs.map((pair, i) => (
              <span key={i} className="g-ans-tag">{pair.a}</span>
            ))}
          </div>
        )
      })()}

      {/* Question zone — current question large, or welcome state */}
      <div className="g-q-zone">
        {isWelcome ? (
          <>
            <div className="g-cur-q">What are you working on today?</div>
            <div className="g-chip-grid">
              {startingPoints.map(ex => (
                <button key={ex} className="g-chip" onClick={() => onSend(ex)}>{ex}</button>
              ))}
            </div>
          </>
        ) : appState === 'assembling' ? (
          <div className="g-building">
            <span className="g-typing"><span/><span/><span/></span>
            <span>Building your list…</span>
          </div>
        ) : (
          <>
            <div className="g-cur-q">
              {currentQuestion}
              {loading && !streamingText && <span className="g-typing"><span/><span/><span/></span>}
            </div>
            {pendingOptions && pendingOptions.length > 0 && !isBlocked && (
              <div className="g-chip-stack" key={pendingOptions.join('|')}>
                {pendingOptions.map(choice => (
                  <button key={choice} className="g-chip" onClick={() => submitChip(choice)}>
                    <span>{choice}</span>
                    <span className="g-chip-chev">›</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Spacer pushes Show Me + input to the bottom of the card */}
      <div className="g-chat-spacer" />

      {earlyReady && (
        <button className="g-show-me" disabled={isBlocked} onClick={onShowMe}>✦ Show Me Now</button>
      )}

      <div className="g-input-row">
        <input
          ref={inputRef}
          type="text"
          className="g-input"
          placeholder={earlyReady ? 'Answer more, or click Show Me…' : 'Reply…'}
          value={inputValue}
          disabled={isBlocked}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitFreeText() }}
        />
        <button className="g-send-btn" disabled={isBlocked || !inputValue.trim()} onClick={submitFreeText}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
