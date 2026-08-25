import { useEffect, useRef, useState } from 'react'
import type { CategoryResult, CuratedOutfit, IntentModel } from '../types/intent'
import { CMSCardView } from './CMSCardView'
import { CollageView } from './CollageView'

interface Props {
  categories: CategoryResult[]
  curatedOutfits: CuratedOutfit[]
  intent: IntentModel | null
  loading: boolean
  skin: string
}

export function ResultsView({ categories, curatedOutfits, intent, loading, skin }: Props) {
  const stackRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const cmsStripRef = useRef<HTMLDivElement>(null)
  const [canScrollCmsLeft, setCanScrollCmsLeft] = useState(false)
  const [canScrollCmsRight, setCanScrollCmsRight] = useState(false)

  // The stack shows exactly two curated-set cards; further sets sit below,
  // hidden until the scroll arrow (or wheel) brings them into view.
  function updateArrow() {
    const el = stackRef.current
    if (!el) return
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 8)
  }

  // The CMS strip hides its scrollbar (scrollbar-width: none) like every other scroll
  // area in this app — with no visible bar, there's otherwise no signal that more guides
  // exist off to either side. These arrows are that signal. (Right-only was a real bug —
  // once scrolled right, there was no way back.)
  function updateCmsArrow() {
    const el = cmsStripRef.current
    if (!el) return
    setCanScrollCmsLeft(el.scrollLeft > 8)
    setCanScrollCmsRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }

  useEffect(() => {
    updateArrow()
    updateCmsArrow()
  }, [curatedOutfits, categories, loading])

  function scrollDown() {
    stackRef.current?.scrollBy({ top: stackRef.current.clientHeight, behavior: 'smooth' })
  }

  function scrollCmsLeft() {
    cmsStripRef.current?.scrollBy({ left: -240, behavior: 'smooth' })
  }

  function scrollCmsRight() {
    cmsStripRef.current?.scrollBy({ left: 240, behavior: 'smooth' })
  }

  if (loading) {
    return (
      <div className="g-results">
        <SkeletonResults />
      </div>
    )
  }

  if (categories.length === 0) {
    return (
      <div className="g-results g-results-empty">
        <p className="g-results-empty-msg">No exact matches found for this style — try refining your selections.</p>
      </div>
    )
  }

  // Collect all CMS content across categories, deduplicated by uid
  const allCms = Array.from(
    new Map(
      categories.flatMap(cat => cat.cmsContent).map(c => [c.uid, c])
    ).values()
  )

  // One collage card per curated set; fall back to a single collage of top picks
  const outfits = curatedOutfits.length > 0 ? curatedOutfits : [null]

  return (
    <div className="g-results">
      {/* CMS guides strip — pinned above the collages */}
      {allCms.length > 0 && (
        <>
          <h2 className="g-collage-section-title">From our blog</h2>
          <div className="g-cms-strip-section">
          {/* Floating overlays, not reserved columns — the strip's cards start flush at the
              section's own left padding, matching the title and collage box. Each arrow only
              takes up (and occupies) space once its direction is actually scrollable. */}
          <div className="g-cms-arrow-slot g-cms-arrow-slot-left">
            {canScrollCmsLeft && (
              <button className="g-cms-scroll-arrow" onClick={scrollCmsLeft} aria-label="Show previous guides">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 18l-6-6 6-6"/>
                </svg>
              </button>
            )}
          </div>
          <div className="g-cms-strip" ref={cmsStripRef} onScroll={updateCmsArrow}>
            {allCms.map(c => <CMSCardView key={c.uid} content={c} skin={skin} />)}
          </div>
          <div className="g-cms-arrow-slot g-cms-arrow-slot-right">
            {canScrollCmsRight && (
              <button className="g-cms-scroll-arrow" onClick={scrollCmsRight} aria-label="Show more guides">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </button>
            )}
          </div>
        </div>
        </>
      )}

      <h2 className="g-collage-section-title">Some inspiration to get you started</h2>

      <div className="g-collage-stack" ref={stackRef} onScroll={updateArrow}>
        {outfits.map((outfit, oi) => {
          // Re-order each category so the curated set's product renders first
          const outfitCats = categories.map(cat => {
            const slot = outfit?.items.find(it => it.category === cat.name)
            if (!slot) return cat
            const rest = cat.products.filter(p => p.id !== slot.product.id)
            return { ...cat, products: [slot.product, ...rest] }
          })
          return (
            <section key={oi} className="g-collage-card">
              <div className="g-collage-card-head">
                <h3 className="g-collage-card-title">
                  {(outfit?.name ?? intent?.goal ?? '').replace(/^\w/, c => c.toUpperCase())}
                </h3>
                {outfit?.rationale && (
                  <span className="g-collage-card-blurb">{outfit.rationale}</span>
                )}
              </div>
              <div className="g-collage-wrap">
                <CollageView categories={outfitCats} skin={skin} />
              </div>
              <div className="g-collage-chips">
                {outfitCats.map(cat => {
                  const p = cat.products[0]
                  if (!p) return null
                  return (
                    // target="_top" — the Greeter runs inside an iframe, so a plain href
                    // would navigate just that iframe, leaving the host page frozen/blurred.
                    // ?skin=... — p.url is a bare catalog path with no idea which skin the
                    // shopper is browsing; without this the destination page defaults to
                    // skin=project (wrong accent color) regardless of the actual site.
                    <a
                      key={cat.name}
                      className="g-collage-chip"
                      href={`${p.url}?skin=${skin}`}
                      target="_top"
                    >
                      {p.name}
                      {p.price ? ` · $${p.price}` : ''}
                    </a>
                  )
                })}
                {/* Anchor items ("build around something you own") are excluded from the
                    shopping list and collage grid entirely — there's nothing to sell, so
                    nothing to search or photograph. But leaving the outfit's chip row with
                    no trace of that piece reads as an incomplete look, not a covered one.
                    A plain (unclickable — there's no product page for something we don't
                    stock) chip closes that gap without misrepresenting it as shoppable. */}
                {(intent?.anchorItems ?? []).map(a => (
                  <span key={a.name} className="g-collage-chip g-collage-chip-anchor">
                    {a.name} · yours
                  </span>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {/* Scroll-down arrow — same affordance as the original product-row arrows */}
      {canScrollDown && (
        <button className="g-stack-arrow" onClick={scrollDown} aria-label="Show more sets">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
      )}
    </div>
  )
}

function SkeletonResults() {
  return (
    <div className="g-results-skeleton">
      {[0, 1, 2].map(i => (
        <div key={i} className="g-skeleton-row">
          <div className="g-skeleton-label" />
          <div className="g-skeleton-cards">
            <div className="g-skeleton-card" />
            <div className="g-skeleton-card" />
            <div className="g-skeleton-card" />
          </div>
        </div>
      ))}
    </div>
  )
}
