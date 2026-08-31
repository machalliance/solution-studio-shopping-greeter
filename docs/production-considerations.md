# Production Considerations
## Greeter — Moving from Prototype to Deployment

This document describes what the prototype deliberately does not address, and what an
organization would need to resolve before embedding the Greeter in a real retailer site with
real shoppers. It is intended for technical teams and decision-makers evaluating the path from
demo to production.

The prototype is designed to show what is possible — a working, end-to-end intent-driven
shopping experience that runs in one command with no catalog or CMS accounts required (a Vercel
AI Gateway account is the one exception — it's needed for the conversation itself), and that
scales to live vendor data by changing one flag. It succeeds at that goal. What it does not do
is carry the security, operational, and data-governance expectations of a widget embedded on a
real commercial storefront, receiving real shopper input, and quoting from a real product
catalog. The gaps described here are deliberate. Closing them is the work of a production
implementation.

This is the risk/scope briefing — for the sequenced task backlog that closes these gaps (written
for the engineers doing the work, not the decision-maker evaluating whether to invest), see
`docs/implementation-guide.md`.

---

## Security

**API keys live in a plain `.env` file.** `AI_GATEWAY_API_KEY`, `ALGOLIA_API_KEY`, and
`CONTENTSTACK_DELIVERY_TOKEN` are all loaded at process startup via Node's built-in
`--env-file-if-exists` flag (there's no `dotenv` dependency — see the `dev`/`start` scripts in
`package.json`). This is fine for local development. In production, secrets should live in a
dedicated secrets manager — HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, or
equivalent — pulled at deploy/startup time, not read from a file on disk. The one thing already
done right here: write-scoped credentials (`ALGOLIA_ADMIN_KEY`, `CONTENTSTACK_MANAGEMENT_TOKEN`)
are deliberately kept *out* of `.env` entirely and passed to the seed scripts on the command line
only — the running server never holds anything more privileged than a read-only key for either
vendor. LLM calls route through Vercel AI Gateway on the one `AI_GATEWAY_API_KEY` — worth
confirming the Gateway account actually has access to whichever model `LLM_PROVIDER` selects
before launch, not just that a key is present: some Gateway accounts' free tier covers OpenAI
but returns `403 Forbidden` for Claude specifically, encountered directly during this project's
own development.

**The debug and settings routes have no authentication.** `server.ts` exposes
`/debug/intents`, `/debug/events`, `/debug/requests`, and `/debug/raw` with no access control of
any kind — `/debug/intents` returns every active shopper's captured goal and constraints, in
plain JSON, to anyone who requests the URL. `POST /api/provider` lets anyone switch the entire
server's active LLM provider. `host/settings.html` (a provider/data-mode switcher) sits behind
the same nothing. None of this is a problem while the server is only reachable on
`localhost` for development — it becomes a real exposure the moment this is deployed anywhere a
shopper's browser can also reach it, since nothing distinguishes "the developer debugging this"
from "anyone on the internet."

**`/api/chat` has no rate limiting.** It drives every LLM call the widget makes — confirmed by
inspection of every route in `server.ts` — with no throttle in place. This is both a
cost-exposure and an availability concern: a single abusive or malfunctioning client could drive
unbounded LLM spend or degrade the experience for every other shopper on the same server.

**Widget iframe security has no configuration yet.** See **Widget Embedding** below — this is
substantial enough to warrant its own section rather than a bullet here.

---

## Widget Embedding

This is the one category of concern the Greeter has that a typical backend service does not,
because the Greeter's primary interface is a piece of UI that runs *inside a page the Greeter
does not control.*

**The widget is a chromeless iframe, by design.** `host/index.html`'s `openGreeterPanel()`
creates a full-bleed, transparent, `border:none` iframe pointed at `/panel`, deliberately owning
100% of its own visual chrome (backdrop, card, results panel) rather than the host page framing
it in a box. This is the pattern proven across all three mockup host pages
(`index.html`, `product.html`, `search.html`, `guide.html`). A real retailer's page adopting
this pattern needs to reserve a full-viewport, transparent iframe slot for it — not a fixed-size
box, which was an earlier, since-abandoned design in this same prototype.

**Every outbound link inside the widget must carry `target="_top"` — this was a real,
already-fixed bug, not a hypothetical.** Because the widget runs in an iframe, a plain `<a
href>` with no target navigates only the iframe, leaving the real host page behind it frozen
mid-transition — the shopper sees the destination page open cramped inside the small iframe
frame while the actual browser tab shows nothing changing. Every product/search/guide link
built by the React app (`CollageView.tsx`, `ResultsView.tsx`, `CMSCardView.tsx`,
`buildShowAllUrl()`'s callers) sets this explicitly today. Any future link added to this
codebase, or any code on the retailer's host page that intercepts or rewrites widget-generated
navigation, needs to preserve this.

**The session-resume mechanism depends on same-origin `localStorage`.** The floating trigger's
"View my shopping list" behavior reads `localStorage['greeter-session']` directly from the host
page's own origin. In the current mockup, this works because the host pages and the `/panel`
iframe are served by the same Hono server (genuinely same-origin). If a real deployment serves
the Greeter from a different origin than the retailer's own domain — a very likely production
topology — this mechanism needs to be redesigned; cross-origin pages cannot read each other's
`localStorage`, `postMessage`-based session handoff would be needed instead.

**CSP and framing headers are unconfigured today.** Neither the mockup host pages nor the
Greeter's own responses currently set `Content-Security-Policy` or `X-Frame-Options` headers —
there was never a need to, since everything is same-origin in the demo. A real retailer's own
CSP must explicitly permit framing the Greeter's origin (`frame-src`), and the Greeter's
responses need headers appropriate to being iframed cross-origin from an origin it doesn't
control. Neither side of this integration has been built or tested yet.

**The retailer's own page can affect the widget in ways this prototype has never had to survive.**
A real retailer's page brings its own CSS (potential z-index conflicts with the widget's fixed
positioning), its own CSP (which may block the widget's fonts, if self-hosted fonts aren't used,
or its API calls if not explicitly allowed), and its own analytics or tag-manager scripts (which
may observe or interfere with the widget's DOM independently of anything the Greeter itself
does). The mockup host pages are deliberately simple and have never exercised any of this.

---

## Catalog Data Quality

**Fixture data is curated; a real catalog will not be.** The demo's product data
(`catalog/fixtures/algolia-*.json`) has deliberately clean, compound tags (`dark-indigo`, not
`dark`) because the search and spec-translation logic matches tags by exact string equality —
this is not a fuzzy match. A real catalog's tagging conventions were very likely never designed
with this in mind. A concrete, already-encountered failure mode from this exact codebase: an
LLM-derived search constraint of `["dark","slim"]` for "slim dark indigo jeans" returned zero
results against fixture data using only compound tags like `dark-indigo` — the same failure
mode will recur against any real catalog with inconsistent or non-compound tagging, and no
amount of prompt engineering on the Greeter's side fixes a catalog that simply doesn't carry the
attributes the spec LLM needs to reason about.

**Category taxonomy is coarser in the fixture catalog than a shopper's mental model.** Confirmed
by inspection this session: skirts are filed as a *tag* (`'skirt'`) inside the `dress` category
rather than getting a category of their own, and shorts are filed as a tag inside `pants`
alongside actual trousers/jeans/chinos. The app's intent model already handles this reasonably —
`dress` correctly covers "dress or skirt" and only removes `top` from the shopping list for an
actual one-piece dress, not for a skirt (which still needs one) — but the underlying catalog
convention itself, if carried unchanged into a real deployment, means "shorts" or "a skirt" is a
tag search within a broader category, not a first-class one. Worth a deliberate decision, not an
inherited accident, when shaping a real catalog. Relatedly — asking for "a mix of skirts and
pants" is a known, deliberately deferred limitation: `pants` and `dress` can appear as separate
shopping-list categories, but outfit curation currently requires every category to appear in
every curated look, so it can't yet treat them as alternatives within one look (some outfits
pants, others a skirt). Judged not worth fixing for a prototype — a real pilot should revisit if
this scenario turns out to matter to actual shoppers.

**The category list itself is hardcoded — new categories need a code change, not just new
data, and this is worse than it sounds.** Confirmed directly this session: the host mockup's own
quick-example buttons offer "Deck refinishing," "Kitchen backsplash," and "New flooring"
alongside "Powder room refresh," but only the bathroom categories (vanity, faucet, mirror,
lighting, tile, hardware) have any catalog data *or* are even selectable — the available-category
list is a fixed string, duplicated in two source files, both stating "only use these, never
invent others." A real retailer seeding new home-project categories would see nothing change,
because the LLM is structurally barred from ever picking a category outside this hardcoded list.
This means "add more products" is not sufficient advice for expanding beyond the demo's current
scope (bathroom fixtures for home projects, the existing fashion categories) — it needs a code
change first, to derive the available category list from the catalog itself rather than a
hand-written enum.

**The seed script is a one-time load, not a sync mechanism.** `scripts/seed-algolia.py` batch-
uploads fixture JSON to a live index once (safe to re-run — `objectID`s are preserved so it
updates in place rather than duplicating) — there is no ongoing sync, webhook, or scheduled job
anywhere in this repository. Keeping a live index current against a real, changing catalog is
entirely unbuilt and is an organizational commitment, not just a one-time integration task.

**`ZERO_RESULTS_ACTION` is a narrower safety net than it sounds.** It governs only the
`/api/search` browse-page endpoint: `fallback` (the default) relaxes the style facet and
re-queries once if a search returns zero results; anything else leaves the empty result for the
client to render as a "no results" state. This is separate from the main widget's own
per-category retry ladder in `assembleResults()` (four progressively looser retries culminating
in a guarantee that no category is left permanently empty) — the two systems solve a similar
problem in different places and shouldn't be conflated when reasoning about how the app behaves
under real, imperfect catalog data.

---

## CMS Content

**The fixture CMS entries are a demonstration of the mechanism, not content to ship.**
`scripts/seed-contentstack.py` creates the three content types (`buying_guide`, `how_to`,
`project_guide`) and publishes fixture entries as a starting format reference — real, on-brand,
accurate editorial content for a specific retailer's actual product mix is work no script can
do. This is genuinely operational work, comparable in kind to keeping catalog data current: it
doesn't stop being necessary once the technical integration is done.

**Getting content tagging right matters as much as writing good copy.** The adapter connects
content to results by tag overlap against category, the shopper's freeform goal text
(lowercased centrally — Contentstack's `$in` match is case-sensitive, and goal text has no
guaranteed casing), the selected style (namespaced `style:<name>` specifically so it can't
collide with an ordinary product-descriptor tag that happens to share a word), and the actual
returned products' own tags. Two real, already-fixed bugs from this exact codebase illustrate
the stakes of getting this wrong: content leaking into unrelated occasions because tag matching
was too coarse, and a category-specific guide being silently starved out because two
session-global guides filled the result limit before the adapter ever queried the content type
that guide lived in. Whoever authors real content needs to understand this model, not just
write good copy and assume tagging is a formality.

**Guide thumbnail generation has a cross-provider dependency worth calling out explicitly.**
`scripts/generate-cms-images.py` generates one editorial/lifestyle photo per CMS entry via the
OpenAI images API. **This script requires `OPENAI_API_KEY` regardless of which `LLM_PROVIDER`
is chosen for the conversational experience** — a production deployment running entirely on
Claude still needs an OpenAI account for this one specific, one-time step.

**The image-slug convention is duplicated across three files that must stay in sync.** An entry
with `url: "/how-to/find-your-jean-fit"` maps to `/images/guides/find-your-jean-fit.png` by
convention (last URL segment = filename) — this exact logic is independently implemented in
`CMSCardView.tsx`, `host/guide.html`, and `generate-cms-images.py` itself, with no single
source of truth — a change to the convention in one file silently breaks the other two.

---

## LLM Provider and Cost

**Provider choice is a production decision the demo deliberately defers.** The LLM adapter
supports both Claude (`LLM_PROVIDER=claude`, the default) and OpenAI, switchable at startup and
at runtime via `POST /api/provider` (which, per **Security** above, needs to be locked down
before this is publicly reachable — an unauthenticated runtime provider switch is not a decision
any production deployment should leave open). Both route through Vercel AI Gateway rather than
either vendor directly — one credential covers both, and Gateway's own dashboard is worth
checking as a potential source of the cost/usage visibility called out below, rather than
building that from scratch. The real provider choice — cost, latency, output quality for this
specific conversational and extraction workload, and each vendor's data processing terms — still
needs to be made deliberately for the pilot, not left at whatever `.env.example` ships.

**Two distinct model slots exist per provider, serving different jobs.** `LLM_CLAUDE_CHAT` /
`LLM_OPENAI_CHAT` back the main conversational and extraction turn — the highest-stakes,
lowest-tolerance-for-latency call. `LLM_CLAUDE_FAST` / `LLM_OPENAI_FAST` back everything else:
spec translation (turning "coastal, warm evening" into catalog-vocabulary search tags), outfit
curation, budget allocation, category rationale text, refinement chip generation, and the
overall summary. A cost projection that only accounts for the chat model and ignores how many
"fast" calls a single conversation triggers (potentially several, layered in parallel across
categories) will materially undercount real spend.

**Token usage isn't logged anywhere today** — per call, per task type, or per conversation. Cost
visibility at real traffic volume needs to be built before volume makes it matter.

---

## Personally Identifiable Information

**Shopper input reaches the LLM provider's API verbatim, via an additional intermediary.** The
shopper's freeform goal text (`intent.goal`) is interpolated directly into multiple prompts — the
curation prompt, the category-rationale prompt, the spec-translation prompt, and others — sent to
whichever provider is active. This is core to how the app works, not a bug, but it means real
shopper-typed text (which could incidentally include identifying details a shopper volunteers
unprompted) leaves this system and reaches Anthropic's or OpenAI's API. Unlike a direct
integration, this traffic now also transits Vercel AI Gateway on its way there — a real
additional party in the data flow, not merely a routing detail. Both the Gateway's own data
processing terms and each underlying model provider's should be reviewed directly against your
organization's data governance requirements before this handles real shopper queries — this
document is not the place to characterize any of their policies, since that's a live commitment
that should be verified at the source, not summarized secondhand.

**The in-memory session model limits, but doesn't eliminate, the PII surface.** The intent
model lives in an in-memory `Map` for the life of the server process (see **Session Model and
State**) — no persistent shopper-data store to secure, encrypt, or purge on a schedule. What
*does* persist, in a sense, is whatever the LLM provider itself retains per its own policy — a
question this document can't answer on the provider's behalf.

**A retailer's own analytics may observe the widget independently of anything the Greeter
does.** If the retailer's host page runs its own analytics or tag-manager scripts (mentioned
as a placeholder concept in earlier planning for this project, but nothing in this codebase
implements or integrates with any analytics platform), those scripts can observe DOM
interactions with the widget the same way they'd observe any other page element, entirely
outside the Greeter's own knowledge or control. This is worth being explicit about with any
retailer partner, since it's easy to assume "the Greeter's data handling" covers the whole
picture when it may not.

---

## Observability

**Logging today is unstructured stdout, confirmed by inspection.** `server.ts` contains 30
separate `console.log`/`console.error` calls with inconsistent bracketed prefixes (`[spec]`,
`[budget]`, `[anchor]`, and others) — no structured fields, no log levels, no aggregation. Error
handling is entirely local too, spread across 28 individual `try`/`catch` blocks with their own
per-call fallback behavior, with no global error-handling middleware in the Hono app. This works
for reading logs live during development and doesn't scale to operating a real deployment.

**Both live adapters fail silently.** `AlgoliaAdapter.query()` returns an empty array on any
non-`ok` response; the pattern repeats for CMS calls. This means a real vendor outage on either
side shows up to a shopper only as unexpectedly thin or empty results — indistinguishable from
"the catalog genuinely doesn't have this" — with nothing in the current logging to surface *why*
results dried up, unless someone is actively watching stdout when it happens.

**`/health` already exists and is a reasonable foundation.** It reports fixture mode, active
provider, and session count. Nothing currently polls it — there's no orchestration or
monitoring layer wired up yet (the prototype runs as a plain Node process). What's missing is
both that polling and anything acting *on* a health-check failure or an elevated adapter error
rate — today, nothing pages anyone.

---

## Session Model and State

**Session state is in-memory only — an explicit, deliberate scope decision, not an oversight.**
The intent model (`goal`, `constraints`, `anchorItems`) lives entirely in an in-memory `Map`,
keyed by a client-generated session id, for the life of the Node process. A server restart or
redeploy clears every active session with no recovery path —
worth being explicit about with pilot stakeholders, since a deploy during active shopping hours
would be experienced by every shopper mid-conversation as the widget silently forgetting
everything.

**The `localStorage` resume mechanism can point at a session that no longer exists
server-side.** A shopper who leaves and returns later (after a restart happened in between) will
see the floating trigger correctly offer "View my shopping list" — the client-side session id is
still there — but the server-side `IntentModel` it refers to is gone. The resume flow re-fetches
against a session id the server has never heard of; confirming what actually happens in that
specific case (a fresh empty conversation? a visible error?) is worth doing deliberately rather
than discovering it live during a pilot.

**Statelessness is a genuine production advantage, not only a limitation.** With no database and
no server-side session affinity requirement beyond the life of a single request, horizontal
scaling behind a load balancer is straightforward — any instance can serve any request. The cost
of that simplicity is that "resume after restart" and "resume on a different instance" are the
same unsolved problem, and both are explicitly out of scope for this prototype.

---

## Image Hosting

**Fixture-mode images are served by the Greeter itself, and that's a demo convenience, not a
production pattern.** `app.use('/images/*', serveStatic(...))` serves product and CMS-guide
images directly from the running server, root `./catalog`. Catalog fixture files deliberately
use relative image paths (`/images/jacket-001.jpg`,
never an absolute `http://localhost:*` URL) specifically so a production catalog can point those
same paths at a real CDN instead — but making that substitution, plus the image optimization and
cache strategy that come with a real CDN, is unbuilt production work, not something the relative-
path convention does automatically.

---

## Rollback and Recovery

**The stateless architecture makes rollback simpler here than in a typical production
service, not harder.** With no database and no migration history to reconcile, a previous
deployed version can be redeployed with no data-consistency concerns beyond the in-memory
sessions it loses (see **Session Model and State**). This is a genuine advantage inherited from
the same design choice that limits session persistence.

**There is no deployment strategy yet, because there is no deployment infrastructure yet.**
The prototype runs as a plain Node process (`npm run build` once, then `npm start`) with no
orchestration layer of any kind — restarting it directly replaces whatever was running, with a
gap in availability while it comes back up. Fine for local development; not something to do
against a process serving a real, embedded widget. A real deployment needs the new version
validated before traffic switches to it (blue/green, canary, or whatever your infrastructure
supports), which is Phase 1 infrastructure work covered in the implementation guide, not
something this prototype's current setup provides.

**Fixture data changes require a full restart, and that's specific to fixture mode.**
`FixtureSearchAdapter` and `FixtureCMSAdapter` cache their JSON at process startup; a JSON
fixture edit needs a server restart to take effect. This is irrelevant once a pilot
actually runs on `USE_FIXTURES=false` — the live adapters query Algolia/Contentstack fresh on
every request, with no caching layer of their own to invalidate.

---

## Production-Grade Design at the Core

None of the above should be read as a reason to avoid this approach. The prototype makes sound
architectural choices that carry directly into production.

The three-adapter pattern (LLM, search, CMS) means every integration point can be swapped
without touching the pipeline that orchestrates them — the exact same server-side code that
assembles results from fixture JSON assembles them from a live Algolia index and a live
Contentstack stack, verified by nothing more than flipping `USE_FIXTURES`. This is what makes
the zero-credential demo experience possible in the first place, and it's the same property that
makes a real integration additive rather than a rewrite.

The result-assembly retry ladder — four progressively looser search attempts, ending in a hard
guarantee that no shopping-list category is ever left silently, permanently empty — was built in
direct response to real failure modes discovered during this project's own development, not
designed in the abstract. That same instinct (never let a partial failure produce a silently
broken experience) is exactly the posture a production deployment needs against a real, messier
catalog.

The CMS content-matching model, imperfect as real content authoring will make demands on it,
is built around a genuine insight: a category name alone can't tell whether "Pants" resolved to
jeans, shorts, or chinos, so content matching waits until the actual products are known before
matching guides to them. That's a harder, more correct design than matching content by category
name alone, adopted specifically because the easier version produced real content-leakage bugs
during this project's own testing.

The anchor-item handling — "build around something you own" — reflects an unusually honest
product instinct for an AI shopping assistant: rather than quietly recommending a similar-but-
different item to buy in place of something the shopper already has, that category is excluded
from the shopping list entirely, with the owned item still visually represented in the outfit as
an explicitly unshoppable placeholder. That's the right instinct to carry into a real deployment,
where a shopper trusting the assistant's recommendations matters more than filling every slot in
a layout.

The path from prototype to production is real work. But it is well-scoped work, and the
architecture — three swappable adapters, a result-assembly pipeline that fails gracefully rather
than silently, and a data model that already distinguishes "the shopper's own item" from "an
item to sell" — is designed to support it.

