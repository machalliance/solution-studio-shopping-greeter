export interface IntentModel {
  goal: string
  goalType: 'project' | 'style'
  constraints: {
    // categoryConstraints is the one structured, non-tag value — explicitly typed here
    // rather than folded into the open string/string[] bag below, since every consumer
    // needs its real shape (server.ts, llm.ts). Previously typed away with `as Record<...>`
    // casts at every read/write site; this is the actual shape, not a widening.
    categoryConstraints?: Record<string, { requiresTags?: string[]; requiresAny?: string[]; avoidances?: string[] }>
    // Open record — every other key the model writes is kept. Known keys (style, budget,
    // finish, colourDirection) are read by search/CMS adapters; all keys are shown in the
    // tag strip (buildConstraintTags in ChatView.tsx, which already skips non-string values).
    [key: string]: string | string[] | Record<string, { requiresTags?: string[]; requiresAny?: string[]; avoidances?: string[] }> | undefined
  }
  anchorItems?: AnchorItem[]
  inspoImageSignals?: ImageSignals
  sessionId: string
}

export interface AnchorItem {
  name: string
  description?: string
  imageUrl?: string
  // Canonical category this item belongs to (e.g. "pants") — the shopper already owns
  // this, so its category is excluded from the shopping list and collage entirely rather
  // than shown as a normal buyable recommendation. Matches a categoryConstraints key.
  category?: string
}

export interface ImageSignals {
  colours: string[]
  styles: string[]
  notes: string
}

export interface CategoryResult {
  name: string
  displayName: string
  displayRole: 'hero' | 'supporting' | 'accent'  // collage layout role — assigned by LLM
  weight: number                                   // 1–10 visual prominence within role
  products: SearchResult[]       // first 4–5 cards
  scrollProducts: SearchResult[] // remaining, shown in horizontal scroll
  cmsContent: ContentResult[]
  showAllUrl: string
  rationale?: string             // LLM-generated "look for X because..." sentence
  filterChips?: string[]         // LLM-generated attribute filters (finish, material, price)
}

export interface SearchResult {
  id: string
  name: string
  brand?: string
  price: number
  currency: string
  category: string
  colourHex?: string
  images: string[]
  url: string
  tags: string[]
  rationale?: string
  inStock: boolean
}

export interface CuratedOutfit {
  name: string
  rationale: string
  budgetStatus: 'on-budget' | 'aspirational'
  totalPrice: number
  items: { category: string; product: SearchResult }[]
}

export interface ContentResult {
  uid: string
  title: string
  url: string
  contentType: string
  summary: string
  tags: string[]
  readTime?: string
  icon: string
}
