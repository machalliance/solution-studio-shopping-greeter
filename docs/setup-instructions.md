# Greeter — Setup Instructions

Greeter is an intent-driven shopping assistant prototype for the MACH Alliance Agent Solution
Studio. A shopper describes a goal in natural language; the assistant runs a short guided
conversation, then assembles a curated collage of products — hero, supporting, and accent
items chosen and weighted by the AI — alongside matched CMS content. It ships embedded as a
floating widget on a mockup retailer site.

---

## Prerequisites

- **Node.js 22+** — enforced via `engines` in `package.json`. If you need to manage multiple
  Node versions, [nvm](https://github.com/nvm-sh/nvm) is a straightforward way to install it
  without needing root.
- **A [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) API key.** LLM calls (both Claude
  and OpenAI) are routed through Gateway — one key covers both providers, no separate Anthropic
  or OpenAI account needed. This is the only account you need to get the demo running end to
  end.

> ⚠️ **You do NOT need an Algolia or Contentstack account to run the demo.** By default
> (`USE_FIXTURES=true`), Greeter serves product and content data from JSON fixture files
> already checked into the repo (`catalog/fixtures/`) — no external search or CMS account is
> required. Algolia and Contentstack accounts are only needed if you want to run against live
> vendor data (`USE_FIXTURES=false`) — see **Algolia setup** and **CMS setup** below.

---

## Quick start

```bash
cd greeter
cp .env.example .env
```

Open `.env` and set at minimum:

```env
AI_GATEWAY_API_KEY=vck_...
```

(`LLM_PROVIDER` defaults to `claude`; set `LLM_PROVIDER=openai` instead if you'd rather run on
OpenAI — same `AI_GATEWAY_API_KEY` covers both, nothing else to change. See **Environment
variables** below.)

Then:

```bash
npm install
npm run build
npm run dev
```

The build step is one-time — it compiles the React widget into `dist/`, which the server reads
directly; re-run it after editing anything in `src/components/`. `npm run dev` hot-reloads
server-side TypeScript changes instantly. The app listens on `http://localhost:<PORT>`
(set `PORT` in `.env`).

**You should see:**
- `npm run build` completes, then `npm run dev` prints `Greeter running → http://localhost:<PORT>`.
- Visiting the app in your browser shows a mockup retailer homepage ("The Project Store" /
  "The Clothing Store" — switchable via a demo-skin toggle at the top of the page).
- A pulsing floating button in the bottom-right corner opens the Greeter widget.

---

## Environment variables

All variables are documented in `.env.example`. Copy it to `.env` and fill in what you need —
nothing outside `USE_FIXTURES=true` mode is required to run the demo.

### Vercel AI Gateway / LLM

| Variable | Controls | Required? |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway access — routes calls to both Claude and OpenAI through one key. Get one from your [Vercel dashboard](https://vercel.com/dashboard) under the AI Gateway product (requires a Vercel account; a free tier exists, but note it may not include Claude model access on every account — see **Troubleshooting** below). | Required. |
| `LLM_PROVIDER` | Which provider is active at startup — `claude` or `openai`. Runtime-switchable afterward via `POST /api/provider`, which is an operator-only route — see `ENABLE_ADMIN_ROUTES` below. | Optional — defaults to `claude`. |
| `LLM_CLAUDE_CHAT` | Model id used for the main conversation/extraction turn (quality matters more than speed here). | Optional — defaults to `claude-sonnet-4-6` in code if unset. |
| `LLM_CLAUDE_FAST` | Model id used for everything else (rationale text, refinement chips, spec translation, budget allocation, curation) — a faster/cheaper model. | Optional — defaults to `claude-haiku-4-5-20251001` in code if unset. |
| `LLM_OPENAI_CHAT` | Model id for the main conversation turn under the OpenAI provider. | Optional — defaults to `gpt-4o` in code if unset. |
| `LLM_OPENAI_FAST` | Model id for fast/background tasks under the OpenAI provider. | Optional — defaults to `gpt-4o-mini` in code if unset. |

### Search — Algolia (optional, live mode only)

| Variable | Controls | Required? |
|---|---|---|
| `ALGOLIA_APP_ID` | Your Algolia application ID (Algolia dashboard → Settings → API Keys). | Only if `USE_FIXTURES=false`. |
| `ALGOLIA_API_KEY` | A **search-only** API key (not the admin key — the running app only ever reads). | Only if `USE_FIXTURES=false`. |
| `ALGOLIA_INDEX_NAME` | The index name the live adapter queries. Must match the index you seed — see **Algolia setup**. | Only if `USE_FIXTURES=false`. |

### CMS — Contentstack (optional, live mode only)

| Variable | Controls | Required? |
|---|---|---|
| `CONTENTSTACK_API_KEY` | Your Contentstack stack API key (Contentstack dashboard → Settings → Stack). | Only if `USE_FIXTURES=false`. |
| `CONTENTSTACK_DELIVERY_TOKEN` | A **read-only delivery token** for the stack/environment (the running app only ever reads content). | Only if `USE_FIXTURES=false`. |
| `CONTENTSTACK_ENVIRONMENT` | The Contentstack environment name to query (e.g. `production`, `development`). | Only if `USE_FIXTURES=false`. |

### Data mode and behavior

| Variable | Controls | Required? |
|---|---|---|
| `USE_FIXTURES` | `true` (default) serves product/content data from `catalog/fixtures/` JSON files with no external accounts. `false` switches both search and CMS to the live Algolia/Contentstack adapters. | Optional — defaults to `true`. |
| `ZERO_RESULTS_ACTION` | Governs the `/api/search` browse-page endpoint specifically (not the main widget's result assembly, which has its own separate retry logic): `fallback` (default) relaxes the style filter and searches again if a query returns zero results; anything else leaves it empty for the client to render as a "no results" state. | Optional — defaults to `fallback`. |
| `CHAT_TIMEOUT_MS` | Maximum wait for a single `/api/chat` model turn before it is treated as failed, so a provider hiccup surfaces as a graceful error rather than a spinner that never resolves. | Optional — defaults to `15000`. |
| `PORT` | The port the app listens on. | Optional. |
| `SHOW_BRAND` | Whether a product's `brand` is displayed and fed to the curation model. Off by default, and the bundled fixtures carry no brand values either way — see [`catalog/README.md`](../catalog/README.md). Turn it on when pointing the app at your own catalog, which may legitimately have brands of its own. | Optional — defaults to off. |
| `CATEGORY_STORE_PATH` | Where the assembled-category store is written. Defaults to a per-checkout filename inside the system temp directory, created mode `0600`; the path stays stable across restarts of the same checkout so it can find its own prior save, without being one shared name every checkout on the machine would collide on. Set it to take explicit control. | Optional. |

### Access control and abuse limits

| Variable | Controls | Required? |
|---|---|---|
| `ENABLE_ADMIN_ROUTES` | Whether the operator-only routes are mounted: the `/debug/*` dumps and the `POST` routes that rewrite global model config (`/api/provider`, `/api/chat-model`, `/api/spec-model`, `/api/curation-model`, `/api/catalog-stats/refresh`). When disabled they return `404` rather than `403`, so a public deployment does not advertise them. | Optional — defaults to **on** when `NODE_ENV` is anything but `production`, and **off** when it is `production` (which the Docker image sets). Set explicitly to override. |
| `RATE_LIMIT_MAX` | Requests allowed per client per window on the three endpoints that spend money (`/api/chat`, `/api/show-me-now`, `/api/refinements`). Exceeding it returns `429` with a `Retry-After` header. Set to `0` as a deliberate hard kill-switch during an incident. | Optional — defaults to `20`. |
| `RATE_LIMIT_WINDOW_MS` | Length of that window. | Optional — defaults to `60000`. |
| `TRUST_PROXY` | Which address the limiter counts against. Unset, it uses the connection's socket address, which a direct caller cannot rewrite. Set to `true`, it uses the first `X-Forwarded-For` hop instead — **required behind a reverse proxy**, where every request otherwise arrives from the proxy's own address and all callers share a single bucket. Only set it when the proxy overwrites that header rather than appending to it, and when the app is not reachable directly: a caller who can reach it directly can then set the header freely. | Optional — defaults to off. |

> The limiter is in-memory and therefore **per process** — it does nothing across multiple
> instances. It is a cost guard for a single-instance prototype, not a security boundary: even
> with the default socket-address key, an attacker with a pool of addresses is not stopped.
> `host/settings.html` drives the model-config routes, so it only functions while
> `ENABLE_ADMIN_ROUTES` is on.

---

## Algolia setup

Skip this section entirely if you're running with the default `USE_FIXTURES=true` — fixtures
already contain the same product data.

1. **Create an Algolia application and index.** Name the index whatever you like, but it must
   exactly match `ALGOLIA_INDEX_NAME` in your `.env`.
2. **Seed the index** using `scripts/seed-algolia.py`. This pushes the JSON fixture files in
   `catalog/fixtures/algolia-*.json` into your live index, plus facet settings — the same
   files the app reads in fixtures mode, so fixtures-mode and live-mode always reflect the
   same data. It needs a **write-scoped admin key**, which is intentionally *not* read from
   `.env` — pass it on the command line only, so it's never at rest in a config file:
   ```bash
   ALGOLIA_ADMIN_KEY=xxxx ./scripts/seed-algolia.py
   ```
   (Read-only config — app ID, index name — is still read from `.env`/`greeter/.env`.)
3. **Confirm the index is populated** — either check the Algolia dashboard directly, or once
   the app is running with `USE_FIXTURES=false`, hit its own search proxy:
   ```bash
   curl "http://localhost:<PORT>/api/search?q=pants"
   ```
   A non-empty `hits` array confirms both the index and the app's connection to it.
4. **Rules or Synonyms**: the repo defines none. The app relies entirely on `category`,
   `style`, and `fit` facet filters plus tag-based AND/OR matching (`requiresAll`/
   `requiresAny`) computed server-side — no Algolia-side Rules or Synonyms configuration is
   required or expected.

---

## CMS setup (Contentstack)

Skip this section entirely if you're running with the default `USE_FIXTURES=true`.

1. **Create a Contentstack stack and environment.** Note the stack API key and the environment
   name you create — these become `CONTENTSTACK_API_KEY` and `CONTENTSTACK_ENVIRONMENT`.
2. **Create a delivery token** scoped to that environment (read-only) — this becomes
   `CONTENTSTACK_DELIVERY_TOKEN`.
3. **Create the content types and publish entries** using `scripts/seed-contentstack.py`. This
   creates the three content types the app expects (`buying_guide`, `how_to`,
   `project_guide`) and publishes the entries from `catalog/fixtures/contentstack-*.json`. It
   needs a **management token**, passed on the command line only (same pattern as Algolia —
   never stored in `.env`):
   ```bash
   CONTENTSTACK_MANAGEMENT_TOKEN=xxxx ./scripts/seed-contentstack.py
   ```
4. **Optional extra content**: `scripts/add-fashion-cms-entries.py` adds a handful of
   fashion-specific test entries (for the rooftop-dinner demo scenario) that don't exist in
   the base fixture set. Same credential pattern.
5. **Optional thumbnail images**: not needed for the seeded entries — `catalog/images/guides/`
   already ships a generated editorial photo for each one. The generator that produced them
   (`scripts/generate-cms-images.py`) is deliberately not part of this repo, so if you add
   your own CMS entries you supply their images yourself. Only the naming convention matters:
   an entry with url `/guides/rooftop-dinner-date-outfit` is served
   `/images/guides/rooftop-dinner-date-outfit.png`, i.e. the last path segment plus `.png`.
   A missing file is non-fatal — the hero image hides itself and the guide still renders.
6. **Confirm content is being served** — with `USE_FIXTURES=false` and the app running, visit
   any guide URL from your seeded entries (e.g. `http://localhost:<PORT>/how-to/find-your-jean-fit`),
   or query the API directly:
   ```bash
   curl "http://localhost:<PORT>/api/guide?url=/how-to/find-your-jean-fit"
   ```

---

## Running the demo

1. Visit the app in your browser. Use the "Demo skin" toggle at the top to switch between "The
   Project Store" (home-improvement) and "The Clothing Store" (fashion) mockups.
2. Click the pulsing floating button, bottom-right. A compact card opens asking "What are you
   working on today?"
3. **Worked example** (home project): click one of the quick-example buttons in the card —
   "Powder room refresh", "Deck refinishing", "Kitchen backsplash", or "New flooring" — and the
   conversation starts immediately with that goal. Or type your own, e.g. *"Redoing a tiny
   powder room — about 4×5 feet"*. The assistant asks a short series of clarifying questions
   (style, budget, room size) — answer via the chip options or free text. Once enough is
   captured, click **Show me now** (or answer through to completion) to see the assembled
   results: a shopping list of categories (vanity, faucet, mirror, lighting, tile, hardware) on
   the left, and curated product collages plus matched CMS guides on the right.

   > ⚠️ **Only "Powder room refresh" has real supporting catalog data today.** The fixture
   > catalog's home-project categories are bathroom fixtures only (vanity, faucet, mirror,
   > lighting, tile, hardware), and the category list itself is fixed in code — "Deck
   > refinishing," "Kitchen backsplash," and "New flooring" will still start a conversation, but
   > won't assemble a sensible result.
4. **Try the other built-in scenario**: start over, switch to "The Clothing Store" skin, and
   click one of its quick-example buttons — "Rooftop dinner outfit", "Weekend look", "Work from
   office", or "Wedding guest" — or type your own fashion goal, e.g. *"Need an outfit for a
   rooftop dinner — smart casual"*.
5. **Inspecting the generated intent model** — there's no admin UI, but the server exposes
   plain debug JSON endpoints:
   - `GET /debug/intents` — every session's current `IntentModel` (goal, constraints,
     anchor items), keyed by session id
   - `GET /debug/events` — the most recent chat turn's stream event log, per session
   - `GET /debug/requests` — a rolling log of recent `/api/chat` requests
   - `GET /debug/raw` — raw LLM replies per session
   - `GET /api/env-status` — which API keys are actually configured, and whether fixtures or
     live mode is active (handy for confirming your `.env` took effect)
   - `GET /health` — overall status, active provider, fixture mode, and session count

   > ⚠️ **None of the `/debug/*` routes (or `POST /api/provider`) have any authentication.**
   > They're fine on `localhost` for local development, but `/debug/intents` returns every
   > active shopper's captured goal and constraints in plain JSON to anyone who requests the
   > URL — do not deploy this anywhere publicly reachable without putting these
   > routes behind an access control layer first.

---

## Session data

Session state (`IntentModel` per shopper) lives in an in-memory `Map` inside the running Node
process (`intentStore` in `src/server/stores.ts`), keyed by the session id the server issues as
an `HttpOnly` cookie on first request. A `sessionId` sent by the client is ignored.

**To inspect captured intent data**, query the debug endpoint directly. This requires
`ENABLE_ADMIN_ROUTES` to be on — the default in development, but off under
`NODE_ENV=production`, where the route returns `404`:
```bash
curl http://localhost:<PORT>/debug/intents
```
This returns the full in-memory map as JSON — one entry per active session, showing the goal,
constraints, and any anchor items captured so far.

**To reset session data for a clean demo run**, you have a few options:
- Click **↺ Clear session** at the top of the homepage (`host/index.html`) — clears the
  browser's `localStorage['greeter-session']` entry so the widget's floating trigger reverts to
  its normal entry state instead of offering to resume a prior session.
- Or click **Start fresh** inside the widget itself — same effect, from within the conversation.
- Restart the server process (`Ctrl+C`, then `npm run dev` again) — clears all in-memory state
  instantly.

Note that clearing the client-side session pointer doesn't delete the *old* session's entry from
server memory — it just sits unused until the server restarts.

---

## Troubleshooting

**Algolia returns no results**
- Confirm you're actually in live mode: `curl http://localhost:<PORT>/api/env-status` — check
  `useFixtures` is `false`. If it's still `true`, your `.env` change didn't take effect (see
  next point).
- If you changed `.env` while the server was already running, restart it — `.env` is only read
  at process startup (Node's `--env-file-if-exists` flag), so a running process won't pick up
  the change on its own.
- Confirm `ALGOLIA_INDEX_NAME` exactly matches the index you seeded, and that
  `scripts/seed-algolia.py` actually completed without error.
- Confirm `ALGOLIA_API_KEY` is a search key, not an admin key used for the wrong purpose (the
  running app only searches; seeding needs the separate `ALGOLIA_ADMIN_KEY` passed to the
  script directly, never stored in `.env`).

**CMS content not loading**
- Same first check: `useFixtures` must be `false` in `/api/env-status`, and the server must
  have been restarted after any `.env` change.
- Confirm `CONTENTSTACK_ENVIRONMENT` matches the environment your entries were actually
  published to — an unpublished entry, or one published to a different environment, won't be
  returned by the delivery API.
- Confirm `scripts/seed-contentstack.py` completed successfully and created all three content
  types (`buying_guide`, `how_to`, `project_guide`).

**LLM / Gateway errors**
- Missing key: confirm `AI_GATEWAY_API_KEY` is set in `.env` and the server was restarted
  after adding it. `GET /api/env-status` reports whether the server sees a key at all
  (`gatewayKey: true/false`) — useful for confirming a `.env` change actually took effect,
  same restart caveat as the Algolia/CMS checks above.
- Wrong model name: `LLM_CLAUDE_CHAT` / `LLM_CLAUDE_FAST` / `LLM_OPENAI_CHAT` /
  `LLM_OPENAI_FAST` must be valid, currently-available model ids — an invalid id fails at
  request time with a `404 Not Found`, not at startup (confirmed directly against Gateway).
- `403 Forbidden` / `"Free tier users do not have access to this model"`: some Gateway
  accounts' free tier covers OpenAI models but not Claude. Add paid credits to the Vercel
  account behind your `AI_GATEWAY_API_KEY` (the error body includes a direct top-up link), or
  switch to the OpenAI provider (`LLM_PROVIDER=openai`) in the meantime.
- `429` rate-limit errors, or other quota issues, surface directly from Gateway; check usage
  under the AI Gateway product in your Vercel dashboard.
- `POST /api/provider` lets you switch between `claude` and `openai` at runtime without
  restarting, if you want to try the other provider quickly.

**Port already in use**
- Something else is already using port 80 on your machine. Set `PORT=<other-port>` in `.env`
  and restart.

**Session data "not persisting"**
- This is expected, not a bug — see **Session data** above. Sessions are in-memory by design;
  a server restart always clears everything.

