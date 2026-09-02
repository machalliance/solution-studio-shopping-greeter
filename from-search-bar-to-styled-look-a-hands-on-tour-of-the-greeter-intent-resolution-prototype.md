# From Search Bar to Styled Look: A Hands-On Tour of the Greeter Intent-Resolution Prototype

*By Scott Trafford – Engineer, MACH Alliance Agent Ecosystem and Principal, Trafford Consulting*

**Explore the reference implementation:** [Greeter GitHub repo](https://github.com/machalliance/solution-studio-shopping-greeter)

---

A shopper opens a retailer's site with a goal in mind. "Something for a rooftop dinner, smart casual." "I'm redoing a tiny powder room." Almost nobody arrives at an ecommerce site already speaking its taxonomy. They arrive with an occasion, a project, or a vibe. The search bar asks them to translate that goal into keywords anyway, then hands back a ranked list of individual products with no sense of which ones belong together, no read on fit or budget, and no guidance on how to turn ten disconnected results into one finished outfit or one coherent bathroom.

That gap is structural rather than a shortcoming of any one retailer's search implementation. A search index is built to do keyword and facet matching well, and modern search engines do it fast and precisely. But "well matched to a query" and "coherent as a set" are different problems, and by default nothing sits between them. The CMS holds styling guides and how-to content, yet matching a guide to a category name is a weaker operation than matching it to what actually got returned. A search for "pants" can resolve to jeans, chinos, or shorts, and a guide written for one of those leaks into the others when the category label is all it has to go on. Getting a genuinely relevant match means waiting until the specific products are known. The result is two best-of-breed systems that never talk to each other about the one thing the shopper walked in with: what they are trying to accomplish.

Greeter is a prototype built to close that gap. It puts an intent-resolution layer in front of search and a curation layer behind it, leaving search itself to do the job it already does well.

This is the third prototype in the MACH Alliance Agent Solution Studio series. The [Product Insights Agent](https://github.com/machalliance/solution-studio-product-questions) addressed the unanswered question on a product detail page, and [B2B Order Intake](https://machalliance.org/insights-hub/from-inbox-to-erp) addressed the purchase order arriving through whatever channel a buyer could reach. Both dealt with a moment after the shopper already knew what they wanted. Greeter works the moment before that, when the goal exists but the products have not been chosen yet. The rest of this piece is written for the people who will actually run it: the engineers, architects, and technical leaders deciding whether the pattern survives contact with their own catalog, their own CMS, and their own traffic.

## What we built

Greeter is an intent-driven shopping assistant that ships as a floating widget, embeddable on any retailer site without modifying the host page. A shopper describes a goal in natural language. A short guided conversation, a handful of questions rather than a form, builds a structured intent model covering what they are shopping for, their style direction, fit, budget, color direction, and whatever else that specific goal requires.

The sequence is not fixed. Each question is chosen based on what has already been answered and what the goal actually needs next, so a fashion goal gets asked about fit before style, a home project skips past questions that do not apply to it, and the conversation never asks something it can already infer from an earlier answer. Once enough is known, the widget assembles a curated collage per outfit or project set: a hero item, supporting pieces, and accent details, chosen and visually weighted by the AI, sitting alongside CMS content matched to what the shopper is building.

Two demo scenarios exercise the two goal types the prototype supports. A home-project flow works through a powder-room refresh, coordinating vanity, faucet, mirror, lighting, tile, and hardware as one set. A fashion flow builds a rooftop-dinner outfit, including the case where a shopper says "I already own dark jeans, build around them." That category is dropped from search entirely rather than filled with a lookalike, and the owned piece still reads as part of the finished look through a non-shoppable "yours" chip in the collage. Recommending a similar item to buy when the shopper has said they already own the real thing is a missed instruction, not a helpful substitute.

![Greeter's curated results panel, showing collages, the advisory summary, and matched CMS content](docs/images/key_shot.png)

*The results panel. On the left, a plain-language advisory summary, a category-by-category shopping list, and refinement chips generated from what is actually in the results. On the right, the curated collages, each with a hero item given the most visual weight, supporting pieces around it, and small accent details.*

<!-- Second image slot: a shot of the guided conversation mid-flow, or the settings page showing per-task model overrides, would match the series convention of two to three captioned images. docs/images/ currently holds only key_shot.png. -->

## How it works

The pipeline runs in four stages, and the same code path handles both scenario types: search, retry logic, curation, and content matching. Domain judgment, such as the small set of warmth rules used for fashion, lives in the style-translation prompt rather than scattered through the routing code around it.

**Entry and intent capture.** The widget opens as a compact card over a dimmed, blurred backdrop, leaving the host page visible but set aside, and grows as the conversation needs. Answers arrive as structured choices rather than free-typed guesses at the right vocabulary, and populate an open intent record holding the goal, the goal type, and whatever constraints are relevant. A "Show Me Now" path is available at any point once enough is known, with a hard guarantee behind it: pressing it can never dead-end the conversation, even when the model would otherwise have asked one more clarifying question.

**Style translation.** Before any search runs, an LLM call translates the intent's open-ended signals (style label, color direction, warmth, venue, finish) into catalog vocabulary: a set of required tags and a set of avoidances, per category. This is the one place domain reasoning happens. The search layer stays domain-agnostic on principle.

**Search, with a retry ladder.** Each category is queried against the translated tags. When a category comes back thin, the retry ladder relaxes constraints in a fixed order, dropping the budget filter, then the style-spec tags, then the hardest constraints, always preserving anything the shopper stated explicitly and only fully relaxing on genuine emptiness. One over-specific tag cannot zero out a category on its own.

**Curation and content matching.** Once products are final, an LLM composes two coherent outfits or sets from the results, plus a third when the products support a genuinely different combination rather than a swapped item. Only then does CMS content get matched, against the tags the returned products actually carry. A guide tagged for "jeans" surfaces when a returned product is jeans, not whenever the category happens to be "pants."

Failure has designed behavior at both ends. `CHAT_TIMEOUT_MS` caps how long a single chat turn waits on the model before the shopper gets a graceful error instead of a stalled spinner. `ZERO_RESULTS_ACTION` decides what happens when a category is still empty after every retry, either relaxing the style filter and searching again or showing an empty state.

## Under the hood

### Stack and adapters

The stack is deliberately ordinary: [Hono](https://hono.dev) on Node.js, a React and TypeScript UI built with Vite, and the [Vercel AI SDK](https://sdk.vercel.ai) routed through Vercel AI Gateway, so one key covers both Claude and OpenAI and the active provider is switchable at runtime rather than fixed at deploy time.

Every external system, meaning the LLM, search, and the CMS, sits behind its own adapter interface, with a fixture implementation and a live implementation behind the identical interface. No code outside an adapter file imports a vendor SDK. Moving from local fixture data to a live Algolia index and a live Contentstack instance is a single environment flag rather than a rewrite, and that is not an aspirational claim: it is the same code path this prototype has run against real vendor accounts.

### Runtime configuration

Which model handles which task is also not a hardcoded choice. Chat, style translation, and curation are each independently configurable at runtime as free text rather than a fixed dropdown, since new models ship faster than any dropdown could track, and each is settable live from a settings page with no code change. A recurring "which model should this task use" debate became something anyone can try for themselves, per session, and compare.

The separation of concerns is enforced rather than documented. The AI reasons, handling intent parsing, layout composition, and refinement suggestions. The server orchestrates tool calls and result assembly. The adapters are the only code that touches a vendor SDK. The React component vocabulary is deliberately closed to `App`, `ChatView`, `ResultsView`, `CollageView`, and `CMSCardView`, so a new UI idea has to be justified against the existing shape of the widget before a new component type gets added. The constraint model an LLM writes into stays an open record rather than a fixed struct, so a shopper's color direction or fit preference is stored under whatever field name the model naturally reaches for, and the same code handles a fashion goal and a home-renovation goal with no schema migration in between.

## Tests and hardening

The prototype ships 356 tests across 13 files, covering intent capture, style translation, search and the retry ladder, curation and assembly, CMS matching, layout, the chat route, the "Show Me Now" path, and the React views. Line coverage is 92%, branch coverage 85%, and `npm run test:coverage` reproduces both.

QA dedicated security suite covers the parts that matter once this is reachable by someone other than its author. It asserts that the debug dumps do not leak a stored intent, that a visitor cannot rewrite the global model configuration, that the two endpoints that spend money (`/api/chat` and `/api/show-me-now`) are rate limited per client address with a stated retry-after and a window that releases, that ordinary page and status requests are not caught by that limit, that the session id is issued by the server as an unguessable `HttpOnly` cookie rather than accepted from the client, and that a `sessionId` embedded in a request body cannot reach another session's caches.

The operator surfaces, meaning the `/debug/*` dumps and the POST routes that rewrite model config, default to on outside production and off when `NODE_ENV=production`. The Docker image sets that, so the container is locked down without configuration, and `docker-compose.yml` turns the surfaces back on for local use. What is still missing is identity: those routes are gated by a single on/off flag rather than per-user access control, which is fine on a laptop and not enough anywhere public.

Two honest caveats sit alongside that. The rate limiter is in-memory, so it holds per process; a multi-instance deployment needs a shared store for the limit to mean anything globally. And the container image is a testing artifact rather than a deployable one. It is there so the prototype runs the same way on a machine without a Node toolchain, not because it is production packaging.

## What the repo gives your team

The repo is more than the running prototype. It ships a documentation set meant to take a team from "clone it" to an informed build or no-build decision without reverse-engineering the code.

- The `README` carries a Docker or plain-Node quick start. Pick whichever you already have installed; neither is a hard dependency on the other, and there is a real Dockerfile behind it.
- `docs/setup-instructions.md` covers every environment variable and the actual steps to point the prototype at live Algolia and Contentstack instead of fixtures.
- `docs/production-considerations.md` is an honest accounting of what a prototype deliberately does not handle yet, working through security, widget embedding, catalog data quality, CMS content, LLM provider and cost, personally identifiable information, observability, the session model, image hosting, and rollback.
- `docs/implementation-guide.md` turns those gaps into a sequenced backlog for moving from prototype to a real pilot.
- `docs/business-case-template.md` is a revenue and cost-model starting point for making the investment case internally.

The scope boundaries are stated rather than implied. Cart and checkout, cross-session persistence, PIM, DAM, user accounts, mobile layout, A/B testing, and real-time inventory are all explicitly out.

## Why it matters

Return to the gap this started with: two best-of-breed systems that never talk to each other about what the shopper is trying to accomplish. The point of Greeter is not the shopping widget. It is the pattern underneath it. Every vendor integration point is swappable behind one interface, with the application code never learning which vendor is answering. That is a demonstration that an intent-resolution and curation layer can sit in front of a composable stack without becoming one more point-to-point integration to maintain.

The Product Insights Agent showed what a grounded, observable agent looks like once a shopper is already on a product page. B2B Order Intake showed it on the seller side, where the formats are messier and errors flow straight into fulfillment. Greeter works the earliest moment of the three, where nothing has been chosen yet and the only thing the system has to go on is a stated goal. The tests, the rate limiting, the server-issued session, and the written-down scope boundaries are what separate a demo that ran once from something a team can start from.

## Explore the code

The prototype is MIT licensed and runs locally against bundled sample data, with no catalog or CMS accounts required to see it working end to end. You need a [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) API key, plus either Docker or Node.js 22 or later. The only required configuration change is the key.

**[Greeter GitHub repository](https://github.com/machalliance/solution-studio-shopping-greeter)**

```bash
# 1. Clone and enter the repo
git clone https://github.com/machalliance/solution-studio-shopping-greeter
cd solution-studio-shopping-greeter

# 2. Configure: set AI_GATEWAY_API_KEY=vck_... in .env
cp .env.example .env

# 3. Start it, whichever way suits your machine
docker compose up
# or
npm install && npm run build && npm run dev
```

Open `http://localhost:3003` and click the pulsing button in the bottom-right corner. The fastest way to understand the pattern is to run the rooftop-dinner scenario twice: once straight through, and once telling it you already own dark jeans. Watch how the second run drops that category from search entirely and still renders a complete look. Then open the settings page, change the curation model, and run it again to see how much of the output is the prompt and how much is the model.

