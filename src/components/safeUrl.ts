// Escaping alone does not make a URL safe to put in href/src: React escapes attribute values,
// but that only stops the attribute being broken out of — `javascript:alert(1)` needs no quote
// break-out to fire. Catalog/CMS `url` and `images` values are as untrusted as the rest of the
// record they come from (live Algolia/Contentstack data under USE_FIXTURES=false), so only
// same-origin-relative paths and explicit http(s) URLs are allowed through; anything else
// degrades to no link/image. Mirrors host/search.html and host/product.html's safeUrl() —
// keep those in sync if this changes.
export function safeUrl(u: string | undefined | null): string {
  const s = String(u ?? '').trim()
  if (/^\/(?!\/)/.test(s)) return s
  return /^https?:\/\//i.test(s) ? s : ''
}
