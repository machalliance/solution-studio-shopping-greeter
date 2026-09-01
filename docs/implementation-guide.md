# Implementation Guide
## Greeter — Prototype to Pilot Backlog

This guide is structured as a sequenced backlog of tasks for moving the Greeter from a working
prototype to a production-adjacent pilot — a real deployment embedded in a real retailer site,
running against a live Algolia index and live Contentstack content, with operators able to
validate the experience against real shopper traffic. Tasks are organized into four phases.
Each task includes a scope and priority in the format (Scope · Priority) — scope runs Small (a
day or less), Medium (two to five days), Large (one to two weeks), or Extra Large (more than
two weeks); priority is Required or Recommended. Dependencies are noted inline.

"Production-adjacent" means: real catalog and content data, a real embed on a real page, close
monitoring — but not full hardening across every dimension simultaneously. The goal of a pilot
is to validate the shopping experience against real inventory and real shoppers before
committing to a broader rollout.

This is the execution plan — for the risk/scope briefing this backlog exists to close (written
for a decision-maker evaluating whether to invest, not for the engineers doing the work), see
`docs/production-considerations.md`.

---

## Phase 1 — Security and Infrastructure
*Prerequisite work before this is embedded on a real, publicly-reachable retailer page.*

---

### Secrets Management

**1.1.1 — Migrate API keys to a secrets manager** (Medium · Required)
`AI_GATEWAY_API_KEY`, `ALGOLIA_API_KEY`, `CONTENTSTACK_DELIVERY_TOKEN`, and the rest of `.env`
currently live in a plain file, loaded at process startup via Node's built-in
`--env-file-if-exists` flag (see the `dev`/`start` scripts in `package.json` — there's no
`dotenv` dependency). In production these should move to a secrets manager — HashiCorp Vault,
AWS Secrets Manager, Azure Key Vault, or equivalent — pulled at deploy/startup time rather than
baked into a file on disk. LLM calls (both Claude and OpenAI) route through Vercel AI Gateway on
one key — there's no separate Anthropic/OpenAI credential to manage, one less secret than a
direct-API setup would need.

**1.1.2 — Keep write-scoped credentials out of the pipeline entirely** (Small · Required)
This is already the convention for the seed scripts (`ALGOLIA_ADMIN_KEY`,
`CONTENTSTACK_MANAGEMENT_TOKEN` are read from shell environment only, never from `.env`) — worth
preserving deliberately as the app moves to a real secrets manager, not just as an accident of
how the scripts happen to be written today. The running server should never hold write-scoped
credentials for either vendor; it only ever reads.

---

### Network Security

**1.2.1 — Enable TLS on the public-facing endpoint** (Medium · Required)
The Greeter serves both the widget and the mockup host pages from one Hono server on a single
port (`3003` by default, via `PORT`). In any real deployment this sits behind TLS termination —
typically at a load balancer or ingress layer in front of wherever the process actually runs.

**1.2.2 — Replace the admin flag with real access control** (Medium · Required)
*Partially addressed in the prototype.* `/debug/intents`, `/debug/events`, `/debug/requests`,
`/debug/raw` and the `POST` routes that rewrite global model config are now mounted only when
`ENABLE_ADMIN_ROUTES` is on — default **on** in development, **off** when `NODE_ENV=production`
(which the Docker image sets), returning `404` rather than `403` so a public deployment does not
advertise them. That removes the outright exposure: `/debug/intents` previously returned every
active session's full `IntentModel` — goal text, captured constraints, anchor items — to anyone
who requested the URL.

What remains is that this is one on/off switch, not access control. There is no way to let an
operator debug a running production instance without re-exposing those routes to everyone. The
production task is to put identity-based auth or network restriction (VPN, IP allowlist, SSO)
in front of them, so the flag can stay on where it is genuinely needed.

**1.2.3 — Restrict `/settings`** (Small · Required)
`host/settings.html` is a provider/data-mode switcher driving `/api/provider` and the model
override routes. Those routes are now behind `ENABLE_ADMIN_ROUTES` (1.2.2), so the page stops
functioning in production rather than reconfiguring runtime behaviour for every shopper — but
the page itself is still served unauthenticated at `/settings`, and the underlying routes work
for anyone whenever the flag is on. Same resolution as 1.2.2: VPN, IP allowlist, or basic auth
in front of both, so the surface can be used where it is needed without being open.

**1.2.4 — Move rate limiting to the edge** (Small · Recommended)
*Partially addressed in the prototype.* `/api/chat` and `/api/show-me-now` — the two endpoints
that drive LLM spend — are now capped at `RATE_LIMIT_MAX` per client per `RATE_LIMIT_WINDOW_MS`
(20/minute by default), returning `429` with `Retry-After`.

Two limits make this insufficient on its own. The counter is an in-memory `Map`, so it is per
process and does nothing once the service is horizontally scaled — precisely the deployment
shape the stateless architecture otherwise encourages. And the client identity it keys on is the
first `X-Forwarded-For` hop, which a direct caller can set freely. Production wants this enforced
at the ingress (WAF, API gateway) or backed by a shared store, with the in-process limiter kept
as a backstop rather than the only control.

---

### Authentication

**1.3.1 — Decide whether `/settings` needs real identity-based auth for the pilot** (Small ·
Recommended) *depends on 1.2.3*
This codebase has no user/operator concept — no login and no roles. There is a session cookie,
but it is anonymous identity for continuity, not authentication: it distinguishes one browser
from another and nothing more. For a single-retailer pilot, an IP allowlist or basic auth in
front of `/settings` and the debug routes is likely sufficient; full SSO is probably
over-engineering at this stage. Revisit if multiple people need distinct access levels.

---

### CSP and Iframe Security

**1.4.1 — Configure CSP headers for the embedding retailer's real domain** (Medium · Required)
The widget's embedding pattern (see `host/index.html`'s `openGreeterPanel()`) creates a
full-bleed, transparent, chromeless iframe pointed at `/panel`. The mockup host pages currently
carry no `Content-Security-Policy` or `X-Frame-Options` headers at all — they're static HTML
served with no special headers by Hono's static file serving. Before this embeds on a real
retailer's actual domain, both sides need explicit configuration: the retailer's page needs a
CSP that permits framing the Greeter's origin, and the Greeter's own responses need headers
appropriate to being iframed cross-origin from a real production domain (rather than the
same-origin mockup pattern used today, where the host pages and the widget are served by the
same Hono server).

**1.4.2 — Verify the `localStorage['greeter-session']` resume pattern under the real embedding
domain** (Small · Required) *depends on 1.4.1*
The "View my shopping list" resume flow reads `localStorage['greeter-session']` directly from
the host page's own origin — confirmed by inspection of `host/index.html`. This only works
because, in the current mockup, host pages and the `/panel` iframe are same-origin (one Hono
server). If the pilot embeds the widget from a *different* origin than the retailer's own domain
(e.g. the Greeter hosted separately and iframed in), this resume mechanism needs to be
re-verified — cross-origin `localStorage` isn't shared, and the whole "come back later" flow
depends on it being readable from the host page.

**1.4.3 — Re-verify every outbound link still uses `target="_top"`** (Small · Required)
This was a real, already-fixed bug this session, not a hypothetical: a plain `<a href>` inside
the widget's iframe navigates only the iframe, leaving the real host page frozen. Every
outbound link (`CollageView.tsx`, `ResultsView.tsx`, `CMSCardView.tsx`, `buildShowAllUrl()`'s
callers) currently sets `target="_top"` explicitly. Worth a deliberate regression check against
the *real* retailer page once embedded there, since a real page's own JS or CSP could interact
with iframe navigation differently than the mockup does.

---

### Deployment Infrastructure

**1.5.1 — Choose and build a real deployment artifact** (Extra Large · Required)
The prototype deliberately runs as a plain Node process (`npm run build` once, then `npm run
dev` or `npm start`) — there is no Dockerfile or container image anywhere in this repo today.
That's the right call for local development and for handing the repo to someone else to run on
their own machine (see `docs/production-considerations.md`'s framing on this), but a real pilot
embedded on a live retailer page needs a proper deployment artifact — a container image, a
platform-specific build (Vercel, Cloud Run, a managed Node buildpack), or whatever your existing
infrastructure standardizes on. If a container image is the right choice for your platform, build
one fresh with a multi-stage pattern (build the Vite bundle in one stage, copy only
`node_modules`, `dist/`, `src/`, `host/`, and `package.json` into a slim runtime stage) rather
than reintroducing dev-oriented bind mounts.

**1.5.2 — Confirm the deployment target loads `.env` the way the app expects** (Small ·
Required) *depends on 1.5.1*
The app reads environment variables via Node's built-in `--env-file-if-exists` flag (see the
`dev`/`start` scripts in `package.json`) — there's no `dotenv` dependency, and no other
environment-loading mechanism. Confirm whatever platform you deploy to either sets real
environment variables directly (the more common pattern for most PaaS/container platforms,
and preferable once secrets move to a secrets manager per 1.1.1) or that an actual `.env` file
reaches the running process — don't assume one mechanism works without checking.

---

## Phase 2 — Data and Integration
*Moving from fixture JSON to real catalog and content data — the Greeter's primary integration
work.*

---

### Catalog Data (Algolia)

**2.1.1 — Prepare a real product catalog in Algolia's expected shape** (Large · Required)
The fixture files (`catalog/fixtures/algolia-*.json`) show the exact shape `AlgoliaAdapter`
expects per product: `objectID`, `category`, `style`, `fit`, `tags`, `price`, `images`, `url`,
plus optional fields like `colourHex`. A real catalog needs the same shape — critically, **tags
must be compound/specific** (`dark-indigo`, not `dark`) since search matching is exact-string,
not fuzzy; this was a real bug this session where an LLM-guessed bare tag like `"dark"` returned
zero results against a real catalog using only compound tags.

**Category taxonomy is coarser in the fixture catalog than a shopper's mental model** — worth
deciding deliberately for a real catalog, not inherited by accident. Confirmed by inspection this
session: the fixture data files skirts as a *tag* (`'skirt'`) inside the `dress` category rather
than a category of its own (there's no separate `skirt` category at all), and files shorts as a
tag inside `pants` alongside actual trousers/jeans/chinos. The app's own intent model already
understands `dress` as covering "dress or skirt" and correctly treats it as replacing `top`+
`pants` only for an actual one-piece dress, not for a skirt (which still needs a top) — but the
underlying catalog taxonomy itself, if carried into a real deployment unchanged, means a shopper
asking for "shorts" or "a skirt" is really searching a tag within a broader category, not a
first-class category. Decide whether a real catalog should give these their own categories or
keep this convention before seeding.

**2.1.1a — The category list is hardcoded, not derived from the catalog — adding a new home
category requires a code change, not just new data** (Medium · Required)
Confirmed directly this session: the host mockup's own quick-example buttons include "Deck
refinishing," "Kitchen backsplash," and "New flooring" alongside "Powder room refresh," but only
the bathroom categories (vanity, faucet, mirror, lighting, tile, hardware) have any catalog data
*or* are even reachable — the available-category list is a fixed string, duplicated in two
places (`agent/intent.ts` and `llm.ts`'s `generateCategories()`), both stating "only use these,
never invent others." Seeding a real catalog with new home-project categories (decking
materials, backsplash tile, flooring) would still produce nothing, because the LLM is
structurally barred from ever selecting a category outside this hardcoded list — this is a code
gap, not a data gap, and needs fixing before Phase 2's data work can support project types
beyond bathrooms. The fix should derive the available list from the actual catalog
(`catalogStats`, already computed server-side at startup from real data) rather than a
hand-written enum, so new categories become available by seeding data alone, the way the rest of
this pipeline is designed to work.

**2.1.2 — Seed and configure the live Algolia index** (Medium · Required) *depends on 2.1.1*
`scripts/seed-algolia.py` batch-uploads all `catalog/fixtures/algolia-*.json` records to the
index named by `ALGOLIA_INDEX_NAME`, and applies the facet settings the adapter depends on
(`category`, `style`, `fit`, `tags` as `filterOnly` facets — no numeric facet needed for price,
since Algolia's `numericFilters` works on any numeric field automatically). Needs a write-scoped
`ALGOLIA_ADMIN_KEY` passed on the command line, never stored in `.env`. Re-running is safe —
`objectID`s are preserved, so uploads update in place rather than duplicating.

**2.1.3 — Define an ongoing catalog sync strategy** (Medium · Required) *depends on 2.1.2*
The seed script is a one-time/manual bulk load. A pilot running against a real, changing catalog
needs a defined process for keeping the index current — a scheduled re-sync, a webhook from the
retailer's PIM, or a lighter-weight incremental update path. This isn't built yet in any form; it
needs to be decided based on how often the pilot retailer's catalog actually changes.

**2.1.4 — Validate search quality against the real catalog** (Small · Required) *depends on
2.1.2*
Run both demo scenarios (see Phase 4) against the real, seeded index and confirm every category
returns usable results. The retry ladder in `assembleResults()` (five progressively looser
retries, ending in a hard guarantee that no category stays permanently empty) was tuned against
fixture data's tag vocabulary — a real catalog with a different tagging convention may behave
differently and is worth observing directly rather than assuming it transfers.

---

### CMS Content (Contentstack)

**2.2.1 — Create real editorial content in Contentstack** (Large · Required)
`scripts/seed-contentstack.py` creates the three content types the adapter queries
(`buying_guide`, `how_to`, `project_guide`) and publishes fixture entries as a starting point,
but real content — accurate to the pilot retailer's actual product mix and brand voice — is
editorial work, not something a script can generate. The fixture entries are a *format*
reference, not content to ship as-is.

**2.2.2 — Get tags right — this is what connects content to results** (Medium · Required)
*depends on 2.2.1*
The adapter matches content by tag overlap against category, the shopper's goal text
(lowercased centrally in the adapter — Contentstack's `$in` match is case-sensitive), the
selected style (namespaced `style:<name>` specifically to avoid collision with ordinary product
descriptor tags), and the actual returned products' own tags. Getting this wrong caused real,
already-fixed bugs this session (content leaking into unrelated occasions/styles, and a
category-specific guide being starved out because two session-global guides filled the result
limit before the adapter ever queried the content type it lived in — see
`scripts/retag-cms-entry.py` and the case/type-starvation fixes in `cms.ts`). Content authors
need to understand this tagging model, not just write good copy.

**2.2.3 — Generate real guide thumbnail images** (Medium · Required) *depends on 2.2.1*
`scripts/generate-cms-images.py` pulls the live entry list from Contentstack and generates one
editorial/lifestyle photo per entry via the OpenAI images API — deliberately not the product
photography pipeline, whose prompts are wrong for this (white background, product-only). **This
script needs `OPENAI_API_KEY` regardless of which `LLM_PROVIDER` the pilot actually runs on** —
if the production LLM choice is Claude, an OpenAI key is still required for this one-time image
generation step. Idempotent — safe to re-run after adding entries.

**2.2.4 — Define an editorial workflow for ongoing content maintenance** (Medium · Recommended)
There's no CMS-side workflow tooling in this repo beyond the seed/retag scripts — content
updates happen by editing Contentstack directly or re-running scripts. Worth deciding who owns
new guide creation, tagging review, and thumbnail regeneration as an ongoing operational
process, not a one-time setup task.

---

### LLM Provider Configuration

**2.3.1 — Choose the production `LLM_PROVIDER` and model versions** (Small · Required)
The adapter supports both Claude and OpenAI, switchable via `LLM_PROVIDER` at startup and
`/api/provider` at runtime (see 1.2.2 for why that runtime switch needs to be locked down before
launch). Both providers route through Vercel AI Gateway on one `AI_GATEWAY_API_KEY`.
`LLM_CLAUDE_CHAT`/`LLM_CLAUDE_FAST` and `LLM_OPENAI_CHAT`/`LLM_OPENAI_FAST` pin specific model
versions for the main conversation turn versus the eight faster background tasks (spec
translation, curation, budget allocation, rationale generation, refinements, category-meta,
overall-summary, and the show-me-now category fallback). This is a real cost/quality tradeoff
worth deciding deliberately rather than leaving at whatever default shipped in `.env.example`.

**2.3.1a — Confirm the production Gateway account has Claude access, not just OpenAI** (Small ·
Required)
Encountered directly this session, not hypothetical: some Vercel AI Gateway accounts' free tier
covers OpenAI models but returns `403 Forbidden — "Free tier users do not have access to this
model"` for Claude specifically, while OpenAI calls on the same key succeed. If `LLM_PROVIDER`
is set to `claude` (the default) against an account without paid credits, every chat turn fails.
Verify Claude access on the actual production `AI_GATEWAY_API_KEY` before launch, not just that
the key is present — `GET /api/env-status`'s `gatewayKey: true` only confirms a key is
configured, not that it has access to the chosen model.

**2.3.2 — Confirm `ZERO_RESULTS_ACTION` behavior is right for the pilot** (Small · Required)
This only governs the `/api/search` browse endpoint (the "shop all" search page), not the main
result-assembly pipeline, which has its own separate four-step retry ladder. `fallback` (the
default) relaxes the style facet and re-queries once if a search returns zero results; anything
else falls through with `nbHits: 0` for the client to render as an empty state. Confirm which
behavior is right for the pilot's search page specifically — this is a narrower, separate
concern from the collage-assembly retries.

---

### Image Hosting

**2.4.1 — Move product images to the retailer's own CDN** (Medium · Required)
In fixture/dev mode, images are served directly by the Greeter itself
(`app.use('/images/*', serveStatic(...))`, root `./catalog`). A pilot embedding on a real
retailer site should serve product images from the retailer's own CDN instead — update the
`images` URLs in the seeded Algolia records to point there, rather than routing image traffic
through the Greeter's own server.

---

## Phase 3 — Observability and Operations
*Making the system visible and measurable before real shopper traffic arrives — the Greeter has
no order-submission step, so this phase carries proportionally more weight than a commerce
pipeline's, since watching conversation and result-assembly health is the primary signal of
whether the pilot is working.*

---

### Logging

**3.1.1 — Replace plain console logging with structured JSON** (Small · Required)
The server modules (`server.ts` plus `src/server/**`) currently have 41 separate
`console.log`/`console.error`/`console.warn` calls, all plain text with
inconsistent prefixes (`[spec]`, `[budget]`, `[demo]`, `[anchor]`, etc.) — no structured format,
no log levels, no consistent fields. This should move to structured JSON with consistent field
names (session id, event type, timing) before it needs to be queried or alerted on at any scale.

**3.1.2 — Forward logs to a central aggregation system** (Small · Required) *depends on 3.1.1*
Once structured, forward to whatever log platform the pilot retailer already uses — Datadog,
CloudWatch, or equivalent. There's no aggregation today; everything goes to stdout.

---

### Metrics and Alerting

**3.2.1 — Instrument core conversation and assembly metrics** (Medium · Required)
Nothing is currently instrumented as metrics — only ad hoc console logs. Worth exposing:
conversations started per period, "show me now" usage rate, categories returned empty after all
retries (a direct signal of catalog coverage gaps — see 4.4), LLM call latency per task type,
and CMS/search adapter error rates.

**3.2.2 — Track LLM API cost** (Small · Recommended)
There's no token-usage logging anywhere today. The Greeter makes several LLM calls per
conversation across nine distinct task types (chat, extraction, refinements, rationale, spec,
allocation, curation, plus the category-meta and overall-summary calls) — worth logging token
usage per call type and projecting monthly cost at the pilot's expected traffic before committing
to a model choice (see 2.3.1).

**3.2.3 — Configure alerting on service health and adapter errors** (Small · Recommended)
`/health` already exists and reports fixture mode, active provider, and session count — a
reasonable basis for a health check, though nothing currently polls it (there's no container
orchestration layer wired up yet — see 1.5.1). Whatever deployment infrastructure gets chosen
should poll it and alert *on* health check failures, and on elevated Algolia/Contentstack error
rates — both adapters currently fail silently (`if (!res.ok) return []` in the Algolia adapter;
similar patterns elsewhere), so a live outage on
either vendor would show up only as unexpectedly empty results, not as a visible error signal,
unless something is watching for it.

**3.2.4 — Add rate limiting** (see 1.2.4 — listed there as a security concern, but it's an
availability one too)

---

## Phase 4 — Pilot Operations and Tuning
*Running against a real embed, real catalog, and real shoppers.*

---

### Embedding and Launch

**4.1.1 — Embed the widget on the real retailer page** (Large · Required) *depends on Phase 1
CSP/iframe tasks*
Follow the pattern already proven in the mockup host pages: a chromeless, full-bleed, transparent
iframe pointed at `/panel`, plus a floating trigger button that checks
`localStorage['greeter-session']` to decide whether to show the normal entry CTA or "View my
shopping list." This needs to be re-validated against the real page's actual CSS, z-index stack,
and CSP — the mockup's assumptions (same-origin, no competing fixed-position elements) may not
hold on a real, more complex retailer page.

**4.1.2 — Validate both demo scenarios against real data end to end** (Medium · Required)
*depends on 2.1.4, 2.2.2*
Run "Redoing a tiny powder room" (project/home scenario) and "Need an outfit for a rooftop
dinner" (style/fashion scenario, including the anchor-item flow — building around something the
shopper already owns) against the real, seeded catalog and CMS. Confirm categories assemble with
real products, CMS guides surface correctly, and the anchor-item exclusion (a category the
shopper already owns is fully excluded from the shopping list and collage, not narrow-searched)
still behaves correctly against real catalog tag vocabulary.

---

### Defining Success

**4.2.1 — Define what a successful shopper interaction looks like** (Small · Required)
The Greeter has no confidence-score or threshold system of any kind — this was confirmed by
inspection, not assumed. There's nothing analogous to tune the way a commerce pipeline tunes
auto-submit thresholds. The equivalent pilot question is qualitative: does the shopper reach a
complete, coherent set of results in a reasonable number of turns? Do refinements produce
sensible narrowing? Concrete, measurable proxies worth defining before launch: conversation
completion rate (reaches results vs. abandoned), "show me now" usage rate as a proxy for
conversation friction, and category-empty rate (see 3.2.1) as a proxy for catalog/content
coverage gaps.

**4.2.2 — Review catalog coverage systematically** (Medium · Required) *depends on 4.1.2*
Walk through the realistic range of goals a shopper might describe against the pilot retailer's
actual catalog, and check whether every reasonable category can be filled. The retry ladder
guarantees a category is never *silently* empty after all five retries collapse — but a category
that only fills via the loosest retry (dropping style/spec tags entirely) is a signal that the
real catalog's tagging doesn't yet support the style-driven search this app is built around, not
a success.

**4.2.3 — Review CMS content relevance** (Small · Required) *depends on 2.2.1*
Confirm the guide strip surfaces genuinely relevant content for the pilot retailer's actual
product mix and goal types — not leftover fixture-era content that happened to get seeded and
never revisited.

---

### Session Scope

**4.3.1 — Document the in-memory-only session model's pilot implications** (Small · Required)
This is an explicit, deliberate scope decision, not a gap to close before pilot: intent models
live in an in-memory `Map` for the life of the server process, with no cross-session
persistence. A shopper who closes the tab and returns later resumes via the
`localStorage['greeter-session']` + `/panel?resume=1` mechanism *as long as the server process
hasn't restarted* — a deploy or crash during the pilot loses all in-flight sessions with no
recovery path. Worth documenting this plainly for pilot stakeholders rather than letting it
surface as a surprise mid-pilot, and deciding whether that's acceptable for the pilot's duration
or whether it changes the deployment cadence (e.g. avoiding deploys during active shopping
hours).

---

## Sequencing Summary

| Phase | Focus | Key dependency | Suggested duration |
|---|---|---|---|
| 1 — Security & Infrastructure | Lock down debug/admin surfaces, TLS, iframe/CSP | None | Weeks 1–2 |
| 2 — Data & Integration | Real catalog and CMS content live | Phase 1 substantially complete | Weeks 2–5 |
| 3 — Observability & Operations | Structured logging, metrics, alerting | Parallel with Phase 2 | Weeks 2–4 |
| 4 — Pilot Operations | Real embed, real traffic, coverage review | Phases 1–3 complete | Weeks 5–7 |

A realistic path from prototype to a running pilot is five to seven weeks. The dominant variable
is Phase 2: how much real editorial CMS content needs to be authored, and how clean the real
catalog's tag vocabulary is relative to what the search/spec pipeline expects.

---

## What Is Out of Scope for a Pilot

- Cross-session persistence beyond the current `localStorage` + in-memory resume pattern (a real
  database-backed session store)
- Cart or checkout functionality
- PIM, DAM, or shopper account integration
- Mobile-optimised layout (desktop-first by design)
- A/B testing or real-time inventory sync
- Full identity-based authentication/RBAC for the settings and debug surfaces (an IP
  allowlist/basic-auth approach is treated as sufficient for a single-retailer pilot — see 1.3.1)
- Distributed tracing across the search → spec → curation → CMS call chain
- Automated catalog sync beyond a manually-triggered or scheduled re-run of the seed script

A successful pilot validates the core loop — conversation → intent capture → result assembly
against real catalog and content — against one real retailer's actual data and actual shoppers.
Broader multi-retailer or multi-region rollout is scoped for the next phase.

