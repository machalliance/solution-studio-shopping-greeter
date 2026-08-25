export interface SearchParams {
  category: string
  facets: Record<string, string | number>
  avoidances?: string[]    // tags / name fragments to exclude
  requiresAll?: string[]   // AND — item must match every tag. From explicit user constraints.
  requiresAny?: string[]   // OR  — item must match at least one tag. From style interpretation.
  limit: number
  offset?: number
}

export interface AlgoliaHit {
  objectID: string
  name: string
  brand?: string
  price: number
  currency: string
  category: string
  style?: string
  fit?: string           // "mens" | "womens" | "unisex"
  finish?: string
  width?: number
  tags: string[]         // matched by the spec-derived requiresAll/requiresAny/avoidances filters
  images: string[]
  url: string
  inStock: boolean
  colourOptions?: string[]
  colourHex?: string
  colourFamily?: string  // present in fixture data; not interpreted by any adapter
  description?: string
  rationale?: string     // fixture-level rationale copy (overridden by LLM-generated version)
}

export interface AlgoliaResponse {
  hits: AlgoliaHit[]
  nbHits: number
  page: number
  nbPages: number
  hitsPerPage: number
  processingTimeMS: number
  query: string
}
