# From Search Bar to Styled Look: A Hands-On Tour of the Greeter Intent-Resolution Prototype

*By Scott Trafford – Engineer, MACH Alliance Agent Ecosystem and Principal, Trafford Consulting*

---

A shopper opens a retailer's site with a goal, not a SKU. "Something for a rooftop dinner,
smart casual." "I'm redoing a tiny powder room." Nobody arrives at an e-commerce site already
speaking its taxonomy — they arrive with an occasion, a project, a vibe. The search bar asks
them to translate that goal into keywords anyway, then hands back a ranked list of individual
products with no sense of which ones belong together, no read on their fit or budget, and no
guidance on how to turn ten disconnected results into one finished outfit or one coherent
bathroom.

That gap isn't a shortcoming of any one retailer's search implementation. It's structural.
A search index is built to do keyword and facet matching well — that's its job, and modern
search engines do it fast and precisely. But "well-matched to a query" and "coherent as a set"
are different problems, and nothing sits between them by default. The CMS holds styling guides
and how-to content, but matching a guide to a category name isn't the same as matching it to
what actually got returned — a "Pants" search can resolve to jeans, chinos, or shorts, and a
guide written for one of those leaks into the others if all it has to go on is the category.
Getting a genuinely relevant match means waiting to know the specific products first, not
querying earlier and matching on a broader label. The result is two best-of-breed systems that
never actually talk to each other about the one thing the shopper came in with: what they're
trying to accomplish.

Greeter is a prototype built to close exactly that gap — not by replacing search, but by
putting an intent-resolution layer in front of it, and a curation layer behind it.

## What we built

Greeter is an intent-driven shopping assistant that ships as a floating widget, embeddable on
any retailer site without modifying the host page. A shopper describes a goal in natural
language. A short guided conversation — a handful of questions, not a form — builds a
structured intent model: what they're shopping for, their style direction, fit, budget, colour
direction, and whatever else is relevant to that specific goal. It isn't a fixed sequence
asked the same way every time; each question is chosen based on what's already been answered
and what the goal actually needs next, so a fashion goal gets asked about fit before style, a
home project skips straight past questions that don't apply to it, and the conversation never
asks something it can already infer from an earlier answer. Once enough is known, the
widget assembles a curated collage per outfit or project set: a hero item, supporting pieces,
and accent details, chosen and visually weighted by the AI, sitting alongside CMS content
actually matched to what the shopper is building, not just to the category name.

Two demo scenarios exercise the two goal types the prototype supports: a home-project flow
(a powder-room refresh, working through vanity, faucet, mirror, lighting, tile, and hardware
as a coordinated set) and a fashion flow (a rooftop-dinner outfit, including handling for a
shopper who says "I already own dark jeans, build around them" — the anchor item gets excluded
from the shopping list entirely rather than recommended-around, and still reads as part of the
finished look via a non-shoppable "yours" chip in the collage).

![Greeter's curated results panel — collages, advisory summary, and matched CMS content](key_shot.png)

## How it works

The pipeline runs in four stages, and the same code path — search, retry logic, curation,
content matching — handles both scenario types. Domain judgment, like a minimal, tailored set of
warmth rules for fashion, lives in the style-translation prompt, not scattered through the
routing code around it.

**Entry and intent capture.** The widget opens as a compact card over a dimmed, blurred
backdrop — the host page is still visible, just set aside — and grows as the conversation
needs. Answers arrive as structured
choices (chips), not free-typed guesses at the right vocabulary, and populate an open intent
record: goal, goal type, and whatever constraints are actually relevant to that goal. A "Show
Me Now" path is available at any point once enough is known, with a hard guarantee behind it —
pressing it can never dead-end the conversation, even if the model would otherwise have asked
one more clarifying question first.

**Style translation.** Before any search runs, an LLM call translates the intent's open-ended
signals — style label, colour direction, warmth, venue, finish — into catalog vocabulary: per
category, a set of required tags and a set of avoidances. This is the one place domain
reasoning happens; the search layer stays domain-agnostic on principle.

**Search, with a retry ladder that never gives up.** Each category is queried against the
translated tags. If a category comes back thin, the retry ladder relaxes constraints in a fixed
order — drop the budget filter, then the style-spec tags, then the hardest constraints — always
preserving anything the shopper stated explicitly, and only fully relaxing on genuine
emptiness. A category never just comes back empty because one over-specific tag zeroed it out.

**Curation and content matching.** Once products are finalized, an LLM composes two coherent
outfits or sets from the results, plus a third when the products actually support a genuinely
different combination, not just a swapped item — real alternatives, not variations on the same
look. Only after products are finalized does CMS content get matched, against the actual
tags the returned products carry, not just the category name — a guide tagged for "jeans"
surfaces only when a returned product is actually jeans, not whenever the category happens to
be "pants."

## An owned item, excluded, not substituted

Not every category in the shopping list is meant to be shopped. When a shopper says they're
building around something they already own, that category is removed from search entirely —
not narrowed, not matched to a similar-but-different product. Recommending a lookalike item to
buy when the shopper explicitly said they already own the real thing isn't a helpful
substitute, it's a missed instruction. The collage still reads as a complete look: the owned
piece shows up as an unclickable chip, labeled "yours," alongside the real shoppable ones.

## What the shopper sees

The widget opens as a compact card floating over a dimmed, blurred backdrop — the host page is
still visible behind it, just set aside, not replaced.

Once results are ready, the compact card gives way to a split panel. On the left: an advisory
paragraph written in plain language (not a restatement of the filters just applied), a
category-by-category shopping list that opens straight into a pre-filtered search page for
that category, and refinement chips generated from what's actually in the results — three at a
time, with a "more ideas" option to cycle through additional suggestions rather than a fixed
list. On the right: the curated collages themselves, each one laid out with a hero item, given
the most visual weight, supporting pieces around it, and small accent details — a layout the AI
assigns per set, not a fixed template — with a CMS guide strip pinned above the collages and
product chips below each one that link out to the real product page, same tab, since the widget
itself lives inside an iframe.

## Under the hood

The stack is deliberately ordinary: [Hono](https://hono.dev) on Node.js, a React + TypeScript
UI built with Vite, the [Vercel AI SDK](https://sdk.vercel.ai) routed through Vercel AI
Gateway — one key covers both Claude and OpenAI, and the active provider is switchable at
runtime, not baked in at deploy time.

Every external system — the LLM, search, CMS — sits behind its own adapter interface, with a
fixture implementation and a live implementation behind the identical interface. Nothing outside
an adapter file ever imports a vendor SDK directly. Switching from local fixture data to a live
Algolia index and a live Contentstack instance is a single environment flag, not a rewrite —
and that isn't an aspirational claim, it's the same code path this prototype has actually run
against real vendor accounts.

Which LLM model handles which task is not a hardcoded choice either. Chat, style-translation, and
curation are each independently configurable at runtime — free text, not a fixed dropdown,
since new models ship faster than any dropdown could track — settable live from a settings page
with zero code change. What used to be a recurring "which model should this task use" debate
became something anyone can just try for themselves, per session, and compare.

The separation of concerns is enforced, not just documented: the AI reasons — intent parsing,
layout composition, refinement suggestions — the server orchestrates the tool calls and result
assembly, and the adapters are the only code that ever touches a vendor SDK directly. The React
component vocabulary is deliberately closed — `App`, `ChatView`, `ResultsView`, `CollageView`,
`CMSCardView`, and nothing else — specifically so a new UI idea has to be justified against the
existing shape of the widget before a new component type gets added, rather than accreting
one-off components indefinitely. And the constraint model an LLM writes into stays an open
record rather than a fixed struct — a shopper's colour direction or fit preference gets stored
under whatever field name the model naturally reaches for, so the same code handles a fashion
goal and a home-renovation goal without a schema migration in between.

## What the repo gives your team

The repo isn't just the running prototype. It ships with the documentation set meant to take a
team from "clone it" to an informed build/no-build decision without reverse-engineering the
code:

- A `README` with a Docker-or-plain-Node quick start — pick whichever you already have
  installed, neither is a hard dependency on the other, and there's a real Dockerfile behind
  it, not just documentation implying one exists.
- `docs/setup-instructions.md` — every environment variable, and the actual steps to point the
  prototype at live Algolia and Contentstack instead of fixtures.
- `docs/business-case-template.md`, `docs/implementation-guide.md`, and
  `docs/production-considerations.md` — a revenue/cost-model starting point, a phased backlog
  for moving from prototype to a real pilot, and an honest accounting of what a prototype
  deliberately doesn't handle yet (auth on the debug routes, cross-session persistence, and
  more) and what closing each gap actually involves.

## Why it matters

The point of Greeter isn't the shopping widget itself — it's the pattern underneath it. Every
vendor integration point is swappable behind one interface, with the application code never
the wiser about which vendor is actually answering. That's not a proof-of-concept married to
one search vendor and one CMS; it's a demonstration that an intent-resolution and curation
layer can sit in front of a genuinely composable MACH stack without becoming one more
point-to-point integration to maintain.

Before publishing, the prototype went through a full pass with five separate open-source
security and quality tools — static analysis, dependency and container vulnerability scanning,
and two independent secret scanners — with the findings written up rather than just asserted.
That's a small thing on its own, but it's the difference between "a demo that ran once" and
something a team can actually start from.

## Explore the code

The repo is public: **[github.com/machalliance/solution-studio-shopping-greeter](https://github.com/machalliance/solution-studio-shopping-greeter)**.

```bash
git clone https://github.com/machalliance/solution-studio-shopping-greeter
cd solution-studio-shopping-greeter
cp .env.example .env
# set AI_GATEWAY_API_KEY in .env

docker compose up
# — or, without Docker —
npm install && npm run build && npm run dev
```

No catalog or CMS accounts required to see it working end to end — it runs against local sample
data by default, and scales to live vendor data by changing one flag when you're ready.
