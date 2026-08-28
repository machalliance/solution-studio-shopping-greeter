# Greeter

An intent-driven shopping assistant prototype for the **MACH Alliance Agent Solution Studio**.

A shopper describes a goal in natural language. The assistant runs a short guided
conversation, builds a structured intent model, then assembles a curated collage of
products — hero, supporting, and accent items chosen and weighted by the AI — alongside
matched CMS content. It ships as a floating widget embedded on a mockup retailer site.

---

## Quick start

You need Node.js 22+ and a [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) API key.
Nothing else is required — Greeter runs entirely against local sample data by default, no
other accounts needed to see it working end to end.

```bash
git clone <this-repo>
cd greeter
cp .env.example .env
```

Open `.env` and set:

```env
AI_GATEWAY_API_KEY=vck_...
```

Then:

```bash
npm install
npm run build
npm run dev
```

(The build step is one-time — it compiles the React widget into `dist/`, which the server reads
directly. `npm run dev` hot-reloads server-side TypeScript changes instantly; re-run `npm run
build` after editing anything in `src/components/`.)

Visit `http://localhost:<PORT>` (set in `.env`). Click the pulsing floating button,
bottom-right, to open the widget.

For the full setup guide — every environment variable explained, running against live
Algolia/Contentstack instead of fixtures, and troubleshooting — see
[`docs/setup-instructions.md`](docs/setup-instructions.md).

---

## Stack

| Layer | Technology |
|---|---|
| Backend | [Hono](https://hono.dev) on Node.js |
| UI | React + TypeScript, built with Vite |
| Host mockup site | Static HTML |
| Agentic framework | [Vercel AI SDK](https://sdk.vercel.ai) |
| LLM | Claude (Anthropic) or OpenAI, via Vercel AI Gateway — runtime-switchable |
| Search | Local JSON fixtures (default) or [Algolia](https://algolia.com) |
| CMS | Local JSON fixtures (default) or [Contentstack](https://contentstack.com) |

Search and CMS each swap via a single `USE_FIXTURES` flag — the same adapter interface backs
both the fixture and live implementations, so the app behaves identically either way.

---

## Project structure

```
greeter/
  src/
    adapters/     # LLM, search, and CMS adapters — the only place vendor SDKs are imported
    agent/        # Prompt construction and layout/URL-building logic
    components/   # React widget UI
    types/        # Shared TypeScript types
    server.ts     # Hono server — all routes
  catalog/        # Fixture data + product/CMS images
  scripts/        # Seed and content-generation scripts for live Algolia/Contentstack
  host/           # Static mockup retailer pages the widget embeds into
  docs/           # Setup instructions
```

---

## Documentation

- **[`docs/setup-instructions.md`](docs/setup-instructions.md)** — full setup guide: every
  environment variable, running against live Algolia/Contentstack, seeding data, and
  troubleshooting.

---

## Scope

Explicitly out of scope for this prototype:

- Cart or checkout functionality
- Cross-session persistence — the intent model is in-memory only; it does not survive a
  server restart
- PIM, DAM, or user account integration
- Mobile-optimised layout (desktop first)
- A/B testing or real-time inventory
- Authentication on the debug/admin routes (`/debug/*`, `/api/provider`) — fine on `localhost`,
  but do not deploy this anywhere publicly reachable without adding access control first
