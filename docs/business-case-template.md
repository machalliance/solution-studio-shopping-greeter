# Business Case Template
## Greeter — Revenue Lift and API Cost Model

This template helps a retailer estimate the potential revenue lift and ongoing API cost of
deploying the Greeter. It is a planning tool, not a guarantee — the default figures are drawn
from published research on personalization broadly, not from a measurement of the Greeter
itself. Replace them with your own data, and treat the projections here as a starting
hypothesis to validate, not a forecast to bank on. **Read Attribution and Measurement before
presenting any figure from this document to a decision-maker.**

---

## The business case in one sentence

The Greeter replaces keyword search with intent capture: a shopper describes a goal and
receives a curated shopping list spanning multiple relevant categories, rather than a list of
products matching one search term. The hypothesis is that this lifts both average order value
and conversion rate in the sessions where a shopper actually engages with it.

---

## Inputs

### Monthly eligible sessions
Sessions on the specific pages where the Greeter is deployed — not your total site traffic.
This comes from your own analytics; there is no meaningful industry default for "how many of a
retailer's sessions land on a page with the widget," since it depends entirely on where you
choose to place it.

### Greeter adoption rate
The percentage of eligible sessions where a shopper actually opens the widget and completes at
least one exchange. No citable industry benchmark exists for this specific interaction
pattern — it's a new-enough pattern that there's no established baseline to point to. Start
with a conservative estimate (this template uses 10% in its worked example) and replace it with
your own measured rate after the widget has been live for a few weeks.

### Current average order value (AOV)
Your own figure. No default — this varies too much by retailer and category to generalize.

### Current conversion rate
Your own figure. No default for your specific store, but as directional context: established
ecommerce stores typically convert in the 2.5–3% range (see **Sources**).

### Expected AOV lift in Greeter-assisted sessions
**Default 10%, range 5–15%.** Source: McKinsey, "Next in Personalization 2021" — personalization
most often drives 5–15% revenue lift, with company-level results spanning 5–25% depending on
sector and execution maturity. The Greeter's specific mechanism for this: project- and
goal-based intent capture surfaces complementary categories a single-product keyword search
would never return — a shopper who types "redoing a tiny powder room" gets a vanity, faucet,
mirror, lighting, tile, and hardware recommendation together, not whichever single item they
happened to search for first.

### Expected conversion rate lift in Greeter-assisted sessions
**Default 5%, range 3–8%.** Source: same McKinsey study. This is deliberately the more
conservative of the two lift figures — conversion is influenced by price, trust, shipping
terms, and urgency, none of which the Greeter touches. Better product discovery can reduce
abandonment from "I couldn't find what I was looking for," but it cannot overcome a shopper who
was never going to buy at your price point.

---

## What the model calculates

**Greeter sessions per month** = eligible sessions × adoption rate

**Incremental monthly revenue** =
&nbsp;&nbsp;Greeter sessions × (baseline conversion rate × (1 + conversion lift)) × (baseline AOV × (1 + AOV lift))
&nbsp;&nbsp;− Greeter sessions × baseline conversion rate × baseline AOV

In plain terms: revenue from Greeter-assisted sessions *with* the lift applied, minus what
those same sessions would have generated at your current baseline conversion rate and AOV. The
difference is the model's estimate of incremental revenue attributable to the Greeter.

**Annual incremental revenue** = monthly × 12

---

## API cost

This section has no equivalent in a typical ecommerce feature — the Greeter's variable cost per
shopper interaction is real and worth budgeting for. The figures below are derived directly
from this codebase (`src/adapters/llm.ts`, `src/server.ts`), not estimated in the abstract, and
from Anthropic's current published pricing at the time of writing.

**LLM calls route through Vercel AI Gateway, not directly to Anthropic — this does not change
the figures below.** Confirmed directly against Vercel's own pricing documentation: on the paid
tier, "AI Gateway charges no markup and no platform fee on tokens — you pay the provider's list
price," including when bringing your own provider key. The per-token rates cited throughout this
section are the same either way. What Gateway *does* change: the account needs to be on the paid
tier for a production deployment — the free tier covers a restricted model subset with lower
rate limits, and can exclude Claude access specifically depending on the account while still
permitting OpenAI models on the same key. Budget for a paid-tier Gateway account, not just an
Anthropic API key.

**What actually happens in a session, traced from the code:**

The conversation itself runs on the *chat* model (`LLM_CLAUDE_CHAT`, default `claude-sonnet-4-6`)
— one call per shopper message, each resending the full system prompt (a fixed ~1,860-token
prompt, measured directly from `src/agent/intent.ts`'s `buildChatPrompt`) plus the growing
conversation history, since there's no server-side conversation memory — confirmed by inspection
of `src/server.ts`, which resends the full `messages` array from the client on every turn. A
typical direct path — the three fields
required before results can assemble (style, fit, budget) — takes 4 total exchanges: the
shopper's opening message plus three answered clarifying questions.

At the transition to results, a burst of separate calls run on the *fast* model
(`LLM_CLAUDE_FAST`, default `claude-haiku-4-5-20251001`) — measured precisely from the actual
prompt templates in `src/adapters/llm.ts`, for a typical 5-category result set (matching both of this
prototype's own demo scenarios):

| Call | Fires | Purpose |
|---|---|---|
| `generateStyleSpec` | once | translates style/warmth/colour into per-category search tags |
| `allocateBudget` | once | splits the total budget across categories |
| `generateCategoryMeta` | once per category (5×) | rationale + filter chips per shopping-list row |
| `assignCollageRoles` | once | hero/supporting/accent layout assignment |
| `generateOverallSummary` | once | the advisory paragraph shown at the top of results |
| `curateOutfits` | once | selects and names 2–3 curated combinations |
| `generateRefinements` | once | 9 refinement-chip suggestions, generated automatically |

That's **11 fast-model calls per result assembly** — every one of them, plus the reason each
exists, verified directly against `src/server.ts`'s assembly flow, not assumed from a
simplified sketch of what the app "probably" does. If a shopper refines their results (swaps an
item, asks for something different), most of this assembly re-runs — but `generateStyleSpec` and
`allocateBudget` skip re-calling the model entirely when a refinement doesn't touch the inputs
they depend on (e.g. a pants-only refinement doesn't re-trigger spec/budget work for jacket, top,
shoes, and belt), so a typical narrow refinement costs somewhat *less* than 11 fresh calls, not
the same 11 again.

**Per-session cost, two scenarios — measured from real Gateway billing data, not estimated
from prompt templates.** Vercel AI Gateway tracks the cost, model, and token usage of every
request it serves and exposes it via `GET /v1/report`, with no code changes needed in this app
to capture it — queried directly against this project's own account for this document:

| Model | Real calls (2026-08-26 to 2026-08-27) | Real total cost | Real avg cost/call |
|---|---|---|---|
| Claude Sonnet 4.6 (chat) | 165 | \$3.098268 | **\$0.01878** |
| Claude Haiku 4.5 (fast) | 711 | \$1.266993 | **\$0.00178** |

This is a blended average across a real, mixed sample of actual development/testing traffic —
short conversations, long ones, refinements, edge-case testing — not one clean, isolated
session. If anything that makes it a *more* realistic baseline than a single scripted scenario,
not a less rigorous one. Applying these real per-call averages to the same call-count structure
traced above:

*Short session* — 4 chat calls + 11 fast calls:
4 × \$0.01878 + 11 × \$0.00178 ≈ **\$0.095**

*Extended session* — 7 chat calls + 22 fast calls (one refinement cycle):
7 × \$0.01878 + 22 × \$0.00178 ≈ **\$0.171**

**Approximately \$0.09 to \$0.17 per Greeter session.** Treat the extended-session figure as an
upper bound rather than typical: it assumes 22 fresh fast-model calls, but a narrow refinement
(touching only one category) often skips re-calling `generateStyleSpec` and `allocateBudget` for
the categories that didn't change, so a real refinement session usually costs less than that
figure implies.

**Monthly cost at scale.** The session-volume column below is illustrative round numbers only —
1,000 / 5,000 / 10,000 were not derived from any retailer's real traffic or an industry
benchmark (a search for one came up empty; see **Methodology notes**, point 5). 5,000 is chosen
deliberately to match the **Sensitivity scenarios** section's own worked example below (50,000
eligible sessions × 10% adoption); 1,000 and 10,000 simply bracket it to show how cost scales.
Replace this column with your own expected Greeter-session volume from the **Inputs** section
above.

| Sessions/month | Cost range |
|---|---|
| 1,000 (illustrative) | \$95 – \$171 |
| 5,000 (matches the Sensitivity scenarios example below) | \$474 – \$853 |
| 10,000 (illustrative) | \$947 – \$1,707 |

**Net incremental revenue** = incremental monthly revenue (from **What the model calculates**)
− monthly API cost at your expected session volume.

**Contentstack and Algolia are not included above.** Both carry costs on paid plans, but neither
is token-based or meaningfully attributable per Greeter session — a retailer's Algolia and
Contentstack costs depend on their overall plan tier and total call volume across their whole
stack, of which the Greeter's share is one contributor among potentially many other uses of the
same accounts. The Vercel AI Gateway cost — Anthropic or OpenAI's list-price token
cost, passed through at no markup (see above), depending which provider is chosen; see
`docs/production-considerations.md` — is the one variable cost that scales directly and
exclusively with Greeter usage.

---

## Attribution and Measurement

**Read this before presenting any number above to a decision-maker.**

The figures in this document are not a measurement — they're a projection built from published
research on personalization broadly, applied to this specific product's mechanism. Unlike a
directly observable saving (an order either auto-processed or it didn't), a shopper who uses the
Greeter and then purchases may well have purchased anyway. There is no way to know the
counterfactual from the Greeter's own data alone.

**The only way to measure actual lift is a controlled A/B test** comparing Greeter-assisted
sessions against a matched control group that never sees the widget, on the same pages, over
the same period.

**What your analytics platform needs to do this:**
- Tag every session where a shopper opens the widget (a session-level property, set the moment
  `openGreeterPanel()` fires — see `host/index.html`) as distinct from sessions on the same page
  that never engage with it.
- Track AOV and conversion rate separately for tagged vs. untagged sessions, ideally with a
  true randomized holdout (the widget deliberately hidden from a control cohort) rather than
  simply comparing "used it" vs. "didn't," since shoppers who choose to engage may differ
  systematically from those who don't (see **Methodology notes**, point 3).
- This instrumentation lives entirely on the retailer's side — the Greeter itself has no
  cross-session analytics of any kind (see `docs/production-considerations.md`).

**A 30-day pilot measurement plan, at minimum:**
1. Instrument session tagging and a control cohort before launch, not after.
2. Run for at least 30 days to average out day-of-week and promotional-calendar noise.
3. Compare AOV and conversion rate, tagged vs. control, with enough session volume in both
   groups to be statistically meaningful at your traffic level — a low-traffic page may need
   longer than 30 days to reach a reliable sample.
4. Only then replace the McKinsey-sourced default lift figures in this template with your own
   measured numbers.

---

## Sensitivity scenarios

Using illustrative example inputs — 50,000 monthly eligible sessions, 10% adoption (5,000
Greeter sessions/month), a 2.75% baseline conversion rate (the midpoint of the established-store
range cited in Sources), and a \$150 baseline AOV. **Replace these four inputs with your own
figures; only the lift percentages themselves come from McKinsey.**

| Scenario | AOV lift | Conversion lift | Incremental monthly revenue | Incremental annual revenue |
|---|---|---|---|---|
| Conservative | 5% | 3% | \$1,681 | \$20,171 |
| Base case | 10% | 5% | \$3,197 | \$38,363 |
| Optimistic | 15% | 8% | \$4,991 | \$59,895 |

At this illustrative volume (5,000 sessions/month), API cost runs **\$474–\$853/month** (measured
from real Gateway billing data — see **API cost** above) — worth comparing directly against the
incremental revenue figures above before this is presented as a clean win. Even in the
conservative scenario, the projected incremental revenue (\$1,681/month) still comfortably
exceeds the API cost range, but the margin is a great deal tighter than it looks
once you're no longer comparing revenue lift against zero.

---

## What this model does not include

- **Return rate reduction** — a shopper who was guided to the right items plausibly returns
  fewer of them, but there's no cited benchmark specific enough to this mechanism to model it.
- **Repeat purchase / retention lift** — a better discovery experience may improve the odds a
  shopper returns, but this compounds over a timeframe this template doesn't attempt to project.
- **Customer service cost reduction** — fewer "which one do I need" support queries is a
  plausible second-order effect, unmeasured here.
- **Staff time redirected from manual product guidance** — relevant mainly for retailers with an
  in-store or live-chat advisory function the Greeter could partially substitute for; too
  organization-specific to generalize.

None of these are modeled because they require organization-specific data this template cannot
generalize. They represent additional value not captured in the figures above — in the same
direction the B2B pipeline's equivalent document notes for its own unmodeled savings.

---

## Methodology notes

1. **Lift applies to Greeter-assisted sessions only, not all site traffic.** The model
   deliberately does not claim any effect on shoppers who never open the widget.
2. **The McKinsey figures are for personalization broadly, not guided/intent-capture shopping
   specifically.** No primary-source data exists specifically for this interaction pattern at
   the time of writing — this is the central limitation of this entire model, not a minor
   caveat.
3. **Selection bias is not controlled for.** Shoppers who choose to open and engage with the
   Greeter may differ systematically from those who don't — more purchase-intent, more
   research-oriented, or simply further along in their decision already. A true A/B test with a
   randomized (not self-selected) control group addresses this; this model does not.
4. **API costs are ongoing and volume-dependent, and will drift from the figures here.** The
   per-call cost figures are real, measured Gateway billing data for this project's account over
   one specific date range (see **API cost** above) — not a permanent constant. Model version
   changes, prompt changes, average session length, and provider pricing changes can all move
   these numbers going forward — re-derive them periodically (the same `GET /v1/report` query
   used here, over a fresh date range) rather than treating this document's figures as fixed.
5. **No industry benchmark exists for "eligible session" volume, and a search for one came up
   empty.** A search for ecommerce traffic-by-store-size benchmarks turned up a plausible-looking
   figure that didn't survive checking its cited sources directly — neither source actually
   contained the number being attributed to it. Rather than cite something that doesn't hold up,
   the session-volume figures in **Monthly cost at scale** and **Sensitivity scenarios** are
   labeled as what they are: illustrative round numbers, not a researched or measured baseline.
   This matches what **Inputs** already says about this figure — it comes from your own
   analytics, because there genuinely isn't a generalizable industry number for it.

---

## Sources

| Data point | Figure used | Source | Date | URL |
|---|---|---|---|---|
| Personalization revenue lift | 5–15%, base 10% | McKinsey, "Next in Personalization 2021" | Nov 2021 | https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights/the-value-of-getting-personalization-right-or-wrong-is-multiplying |
| Personalization revenue lift (reiterated) | 5–15% | McKinsey, "What is personalization?" | 2023 | https://www.mckinsey.com/featured-insights/mckinsey-explainers/what-is-personalization |
| Marketing ROI improvement | 10–30% | McKinsey, "Next in Personalization 2021" | Nov 2021 | https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights/the-value-of-getting-personalization-right-or-wrong-is-multiplying |
| Cross-selling ecommerce revenue contribution | 10–30% of revenue | Forrester Research | — | https://www.forrester.com |
| Ecommerce conversion rate baseline | 2.5–3%, established stores | Convertibles, 2026 | Jul 2026 | https://convertibles.dev/blogs/optimization/increase-ecommerce-conversion-rate |
| Anthropic API pricing — Claude Sonnet 4.6 | \$3/MTok input, \$15/MTok output | Anthropic (Claude Platform docs) | Fetched live for this document | https://platform.claude.com/docs/en/about-claude/pricing |
| Anthropic API pricing — Claude Haiku 4.5 | \$1/MTok input, \$5/MTok output | Anthropic (Claude Platform docs) | Fetched live for this document | https://platform.claude.com/docs/en/about-claude/pricing |
| Vercel AI Gateway pricing — confirms no markup on paid-tier token cost | "no markup and no platform fee on tokens... you pay the provider's list price" | Vercel (AI Gateway docs) | Page last updated 2026-08-23; fetched live for this document | https://vercel.com/docs/ai-gateway/pricing |

The Forrester cross-selling figure is used as supporting context for the multi-category
discovery mechanism in **Expected AOV lift**, not as a direct model input — no specific lift
percentage from Forrester is used in the calculations above.

---

## Disclaimer

This template is provided for illustrative planning purposes. Every input without a stated
default should be replaced with your organization's actual data before this is presented to
decision-makers. The lift figures are drawn from published research on personalization broadly
— they describe what similar-in-kind initiatives have achieved elsewhere, not a measurement of
the Greeter itself, and are not a guarantee of the outcome your organization will achieve. The
only way to convert this from a projection into a measurement is the A/B test described in
**Attribution and Measurement** — treat that section as load-bearing, not optional reading.
