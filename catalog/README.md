# Catalog data

Everything under `fixtures/` and `images/` is fictional demo data for this prototype:

- Product names, prices, and descriptions are invented, not sourced from any retailer.
- Product photography is AI-generated (see each fixture's `imagePrompt` field and
  `images/generated.json`).
- No product record carries a `brand` value. Earlier revisions named real, currently-trading
  companies here; those were removed, because an invented product at an invented price
  illustrated by a generated photograph is not something to publish under someone else's
  name. Nothing in the demo depends on them — the catalog reads as a set of house brands.
  `tests/catalog-brand-guard.test.ts` fails the build if brand data reappears.

`brand` is still a supported *field*: set `SHOW_BRAND=true` to display it and feed it to
curation when you point the app at your own catalog, which may legitimately have brands of
its own. It does nothing against the fixtures above, which have none.

If you re-seed a live Algolia index from an older export, check it for brand values too —
`USE_FIXTURES=false` serves whatever the index holds, not what is in this directory.

See `NOTICE` at the repo root for how this relates to the MIT license.
