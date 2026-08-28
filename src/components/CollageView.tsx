import type { CategoryResult } from '../types/intent'

interface Props {
  categories: CategoryResult[]
  skin: string
}

export function CollageView({ categories, skin }: Props) {
  const hero      = categories.filter(c => c.displayRole === 'hero')
  const supporting = categories.filter(c => c.displayRole === 'supporting')
  const accent    = categories.filter(c => c.displayRole === 'accent')

  // Supporting items split across two columns so no column has more than 2 stacked items —
  // but only once there are enough of them to need splitting. 2 or fewer already fit in one
  // column together; splitting them anyway (e.g. pants+shoes → pants alone, shoes elsewhere)
  // isolates one item for no reason. This happens whenever there's no jacket (top becomes
  // hero, leaving only pants+shoes as 'supporting') — pants would end up alone, disconnected
  // from everything else, instead of paired with shoes right next to the hero.
  const mid = supporting.length > 2 ? Math.ceil(supporting.length / 2) : supporting.length
  const sup1    = supporting.slice(0, mid)
  const sup2raw = supporting.slice(mid)

  // A lone sup2 item next to an accent column looks side-by-side. Fold it in.
  const foldIntoAccent = sup2raw.length === 1 && accent.length > 0
  const sup2       = foldIntoAccent ? [] : sup2raw
  const accentItems = foldIntoAccent ? [...sup2raw, ...accent] : accent

  const heroW = hero.reduce((s, c) => s + c.weight, 0)
  const supW  = supporting.length ? Math.max(...supporting.map(c => c.weight)) : 0
  const accW  = accent.length ? Math.max(...accent.map(c => c.weight)) : 0

  const cols: { items: CategoryResult[]; flex: number }[] = []
  if (sup1.length)        cols.push({ items: sup1,        flex: supW })
  if (hero.length)        cols.push({ items: hero,        flex: heroW })
  if (sup2.length)        cols.push({ items: sup2,        flex: supW })
  if (accentItems.length) cols.push({ items: accentItems, flex: Math.max(accW, 3) })

  if (cols.length === 0) return null

  return (
    <div className="g-collage">
      {cols.map((col, ci) => (
        <div key={ci} className="g-collage-col" style={{ flex: col.flex }}>
          {col.items.map(cat => {
            const p = cat.products[0]
            const img = p?.images[0]
            // With a product: link the cell to its product page. target="_top" is required —
            // the Greeter itself runs inside an iframe, so a plain href here would navigate
            // just that iframe (leaving the host page behind it frozen/blurred), not the
            // actual tab. The floating "View my shopping list" trigger on the destination
            // page (driven by the saved session in localStorage) is how the shopper gets
            // back, not a new tab + close-tab link. ?skin=... — p.url is a bare catalog path
            // with no idea which skin the shopper is browsing; without this the destination
            // page defaults to skin=project (wrong accent color) regardless of the actual site.
            if (!p) {
              return <div key={cat.name} className="g-collage-item"><div className="g-collage-empty" /></div>
            }
            return (
              <a
                key={cat.name}
                className="g-collage-item"
                href={`${p.url}?skin=${skin}`}
                target="_top"
              >
                {img
                  ? <img src={img} alt={p.name} />
                  : <div className="g-collage-empty" />
                }
                <span className="g-collage-pill">
                  {p.name}
                  {p.price ? ` · $${p.price}` : ''}
                </span>
              </a>
            )
          })}
        </div>
      ))}
    </div>
  )
}
