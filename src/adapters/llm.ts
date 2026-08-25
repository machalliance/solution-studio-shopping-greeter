import { generateText, generateObject } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { IntentModel } from '../types/intent.js'

/**
 * Task keys used for model routing. Both adapters read chat/fast model IDs from env vars
 * and assign them to tasks here — no task-specific logic leaks into server.ts.
 *
 * Routing:
 *   chat        → provider's chat model (Claude Sonnet / GPT-4o)  — used by streamObject in server.ts
 *   rationale   → fast model — short generative sentences (category rationale, overall summary)
 *   refinements → fast model — JSON list generation
 *   extraction  → fast model — reserved for future use; main extraction is now via streamObject
 *   spec        → fast model — translates intent into per-category tag requirements before search
 *   allocation  → fast model — structured budget allocation JSON
 *   curation    → fast model — selects specific product combinations for outfit/set cards
 */
export type LLMTask = 'chat' | 'reply' | 'extraction' | 'refinements' | 'rationale' | 'spec' | 'allocation' | 'curation'
// 'reply'  → fast model (Haiku). Used for streaming conversation replies — lower TTFT than Sonnet.
// 'chat'   → chat model (Sonnet). Used for structured extraction where accuracy matters more than speed.

/**
 * Provider-agnostic LLM interface. Implement this for any model provider.
 * The chat turn (streamObject) is handled directly in server.ts via getModel('chat')
 * to keep streaming control in one place. All post-assembly generation goes through here.
 */
export interface LLMAdapter {
  /** Returns the provider-agnostic AI SDK model instance for a given task. */
  getModel(task: LLMTask): LanguageModel
  /** Generates 9 refinement chip suggestions for the results panel. */
  generateRefinements(intent: IntentModel, categories: string[]): Promise<string[]>
  /** Rationale sentence + filter chip labels in one fast-model call (replaces two separate calls). */
  generateCategoryMeta(intent: IntentModel, category: string, productNames: string[]): Promise<{ rationale: string | undefined; filterChips: string[] }>
  /** 1–2 sentence intro for the results panel — explains what the pieces DO, not search criteria. */
  generateOverallSummary(intent: IntentModel, categories: string[]): Promise<string>
  /**
   * Translates the captured intent into per-category tag requirements and avoidances before search runs.
   * Tags use catalog vocabulary (materials, fit descriptors, colours, occasion markers)
   * and are coordinated across categories in a single call so the pool is pre-coherent.
   *
   * requiresAll: explicit user constraints visible in the intent (AND — every tag must match).
   * requiresAny: style interpretation of open signals like style label, colour, occasion (OR — at least one must match).
   * avoidances: fabrics or constructions wrong for this intent (excluded entirely).
   */
  generateStyleSpec(intent: IntentModel, categories: string[]): Promise<Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }>>
  /**
   * Selects specific product combinations to form 2–3 curated outfits/sets.
   * Reasons over product metadata (name, tags, colour, price) — no images.
   * Returns slot maps of {categoryName: productId} for each outfit.
   */
  curateOutfits(
    intent: IntentModel,
    budget: number,
    categoryProducts: { category: string; products: { id: string; name: string; brand?: string; tags: string[]; price: number; currency: string }[] }[]
  ): Promise<{ name: string; rationale: string; slots: Record<string, string> }[]>
  /**
   * Assigns collage display roles and weights to all assembled categories in one call.
   * One hero (the defining/anchor piece), supporting items, and accent (finishing touches).
   * Weight 1–10 determines proportional column width in the collage view.
   */
  assignCollageRoles(
    intent: IntentModel,
    categories: string[]
  ): Promise<Record<string, { displayRole: 'hero' | 'supporting' | 'accent'; weight: number }>>
  /**
   * Allocates a total budget across shopping categories proportionally.
   * Hero categories (outerwear, footwear, vanity) receive more; accessories receive less.
   * Sum of all returned maxPrice values ≤ totalBudget. `categories` never includes an
   * anchor item's category — that's excluded from assembly entirely before this runs.
   */
  allocateBudget(
    totalBudget: number,
    categories: string[],
    catalogStats: Record<string, { min: number; max: number; avg: number }>
  ): Promise<Record<string, number>>
  /**
   * Hard-guarantee fallback: decides shopping-list categories from the intent alone, with no
   * conversational path to omit them. Used only when the main chat turn's "show me now" override
   * fires but categories came back empty (the model asked a clarifying question instead of
   * committing to a category list that turn) — schema-enforces at least 1 category so pressing
   * "show me now" can never dead-end.
   */
  generateCategories(intent: IntentModel): Promise<string[]>
}

/**
 * Shared base implementation. Both ClaudeAdapter and OpenAIAdapter extend this,
 * keeping all prompt logic in one place. Only getModel() differs between providers.
 */
abstract class BaseAdapter implements LLMAdapter {
  abstract getModel(task: LLMTask): LanguageModel

  async curateOutfits(
    intent: IntentModel,
    budget: number,
    categoryProducts: { category: string; products: { id: string; name: string; brand?: string; tags: string[]; price: number; currency: string }[] }[]
  ): Promise<{ name: string; rationale: string; slots: Record<string, string> }[]> {
    const style = intent.constraints.style ?? 'mixed'
    const colour = intent.constraints.colourDirection ?? ''
    const fit = intent.constraints.fit ?? ''
    const categoryConstraints = intent.constraints.categoryConstraints ?? {}
    const budgetLine = budget < Infinity ? `Total budget: $${budget}` : 'No set budget limit'
    const anchorLine = intent.anchorItems?.length
      ? `Anchor items (user already owns these — build around them): ${intent.anchorItems.map(a => a.name + (a.description ? ` (${a.description})` : '')).join(', ')}`
      : ''

    const catBlocks = categoryProducts.map(({ category, products }) => {
      const lines = products.slice(0, 10).map(p =>
        `  - id:"${p.id}" ${p.brand ? `[${p.brand}] ` : ''}"${p.name}" | tags:${p.tags.slice(0, 5).join(',')} | $${p.price}`
      ).join('\n')
      return `${category}:\n${lines}`
    }).join('\n\n')

    const { object } = await generateObject({
      model: this.getModel('curation'),
      temperature: 0.3,
      schema: z.object({
        outfits: z.array(z.object({
          name: z.string().describe('3–5 word outfit/look name'),
          rationale: z.string().describe('One sentence (max 18 words) explaining why this combination works'),
          slots: z.record(z.string()).describe('Map of category name to product id'),
        })).min(1).max(3),
      }),
      prompt: `You are curating ${intent.goalType === 'style' ? 'outfit' : 'product'} combinations for a shopper.

Goal: "${intent.goal}"
Style: ${style}${colour ? ` | Colour direction: ${colour}` : ''}${fit ? ` | Fit: ${fit}` : ''}
${budgetLine}
${anchorLine}
${Object.keys(categoryConstraints).length > 0 ? `\nShopper's explicit constraints (must be honoured in EVERY outfit):\n${Object.entries(categoryConstraints).map(([cat, cc]) => `- ${cat}: ${[...(cc.requiresTags ?? []).map(t => `must include "${t}"`), ...(cc.avoidances ?? []).map(t => `avoid "${t}"`)].join(', ')}`).join('\n')}` : ''}

Available products by category (categories listed in display order, left to right):
${catBlocks}

Rules:
- Create 2 coherent combinations. A 3rd is optional if products allow a meaningfully different look.
- Style adherence is the first filter: read each product's name and tags and reject any item whose aesthetic clearly contradicts the stated style. For coastal/nautical: reject flannel, rugged outdoor, heavy-weight, heritage workwear. For earthy/minimalist: reject bold prints and loud colours. Use your fashion knowledge.
- Match colours and materials across the remaining shortlist (earthy tones together, navy with cream, linen with linen-weight fabrics).
- Try to keep at least one combination within or close to the stated budget (sum of item prices). A second can be aspirational.
- Outfits 2 and 3 must differ from outfit 1 in at least 2 categories — vary the secondary pieces (top, pants, shoes for fashion; tile, hardware for home) so each combination feels like a distinct direction, not a minor swap.
- Each combination needs: a name (3–5 words, evocative, not generic), and a rationale (one sentence, max 18 words, specific — e.g. "Earthy linen anchors the look; slim chinos sharpen it without losing the relaxed feel.").
- Use only product ids from the lists above. Every category must have exactly one id in slots.`,
    })
    return object.outfits
  }

  async generateRefinements(intent: IntentModel, categories: string[]): Promise<string[]> {
    const { text } = await generateText({
      model: this.getModel('refinements'),
      prompt: buildRefinementsPrompt(intent, categories),
      maxTokens: 256,
    })
    try {
      const parsed = JSON.parse(text.trim())
      if (Array.isArray(parsed)) return parsed.slice(0, 9)
    } catch {
      const matches = text.match(/"([^"]+)"/g)
      if (matches) return matches.slice(0, 9).map(s => s.replace(/"/g, ''))
    }
    return defaultRefinements(intent)
  }

  async generateCategoryMeta(intent: IntentModel, category: string, productNames: string[]): Promise<{ rationale: string | undefined; filterChips: string[] }> {
    const style = intent.constraints.style ?? 'the chosen style'
    const finish = intent.constraints.finish ? `, preferably in ${intent.constraints.finish}` : ''
    const products = productNames.slice(0, 4).join(', ')
    const { object } = await generateObject({
      model: this.getModel('rationale'),
      schema: z.object({
        rationale: z.string().describe('One sentence, max 18 words. No "you" — use "look for" or "pick".'),
        filterChips: z.array(z.string()).min(2).max(3),
      }),
      prompt: `Shopper: "${intent.goal}". Style: ${style}${finish}.
Category: ${category}. Products assembled: ${products}.

Return:
- rationale: ONE sentence (max 18 words) — specific advice on what to look for and why it suits the style. No "you". E.g. "Look for breathable linens in neutral tones — they carry coastal chic's relaxed effortlessness."
- filterChips: 2–3 short filter labels (1–3 words each) based on what varies in the product list. E.g. ["Brushed brass", "Under $200", "Natural wood"].`,
      maxTokens: 120,
    })
    return { rationale: object.rationale || undefined, filterChips: object.filterChips }
  }

  async generateStyleSpec(intent: IntentModel, categories: string[]): Promise<Record<string, { requiresAll: string[]; requiresAny: string[]; avoidances: string[] }>> {
    const style = intent.constraints.style ?? 'mixed'
    const colour = intent.constraints.colourDirection ?? ''
    const fit = intent.constraints.fit ?? ''
    const warmth = intent.constraints.warmth ?? ''
    const goalType = intent.goalType
    const catCC = intent.constraints.categoryConstraints ?? {}
    const globalReq = Array.isArray(intent.constraints.requiresTags) ? intent.constraints.requiresTags : []

    const categorySpec = z.object({
      requiresAll: z.array(z.string()).max(4).describe('AND — item must match every tag. Use for explicit user constraints visible in the intent.'),
      requiresAny: z.array(z.string()).min(1).max(6).describe('OR — item must match at least one tag. Use for style/occasion/colour interpretation.'),
      avoidances: z.array(z.string()).max(4),
    })
    const { object } = await generateObject({
      model: this.getModel('spec'),
      schema: z.object({ spec: z.record(categorySpec) }),
      prompt: `Translate a shopper's intent into per-category search specs.

Goal: "${intent.goal}"
Style: ${style}${colour ? ` | Colour direction: ${colour}` : ''}${fit ? ` | Fit: ${fit}` : ''}${warmth ? ` | Warmth/temperature: ${warmth}` : ''}
${globalReq.length ? `Global explicit constraints (apply to all categories): ${globalReq.join(', ')}` : ''}
${Object.keys(catCC).length ? `Category explicit constraints: ${Object.entries(catCC).map(([cat, cc]) => `${cat}: ${[...(cc.requiresTags ?? []), ...(cc.avoidances ?? []).map(a => `avoid ${a}`)].join(', ')}`).join(' | ')}` : ''}
Categories needed: ${categories.join(', ')}

For each category return THREE arrays:
- requiresAll: explicit user constraints that must ALL match (AND). Translate constraints from the intent directly — e.g. "short sleeves only" → ["short-sleeve"]. Leave empty if no explicit user constraint applies to this category.
- requiresAny: style/occasion/colour interpretation tags — at least ONE must match (OR). E.g. "Coastal Chic, warm evening" → jacket: ["linen","unstructured","cotton","light"]. Use 3–5 tags.
- avoidances: fabrics or constructions wrong for this intent — excluded entirely.

Use catalog vocabulary — not style names. E.g. not "coastal" but "linen", "unstructured", "relaxed".
Sleeve length: use "short-sleeve". Sleeveless: "sleeveless", "cami", or "tank".
${goalType === 'style'
  ? `Fashion: coordinate requiresAny tags across categories so pieces cohere.
Warmth rules — apply regardless of fabric weight:
- hot/warm → avoidances for top MUST include "mock-neck" and "turtleneck" (collar construction traps heat even in lightweight fabrics like silk-blend). Also add "merino","wool","heavy-knit" as applicable.
- cool/layered → avoidances include "sleeveless","cami","tank". requiresAny may include "layering","knit".`
  : `Home: coordinate finish/material tags across categories. If vanity is matte black, hardware avoidances exclude "brushed brass","chrome".`}

Example — coastal chic, men's, hot evening, user said "short sleeves only":
{
  "jacket": { "requiresAll": [], "requiresAny": ["linen","unstructured","light","relaxed","cotton"], "avoidances": ["heavy","wool","quilted"] },
  "top":    { "requiresAll": ["short-sleeve"], "requiresAny": ["linen","cotton","breathable","polo","poplin"], "avoidances": ["mock-neck","merino","wool"] },
  "pants":  { "requiresAll": [], "requiresAny": ["slim","chino","sand","navy","linen"], "avoidances": ["heavy","denim","flannel"] },
  "shoes":  { "requiresAll": [], "requiresAny": ["loafer","suede","tan","leather","canvas"], "avoidances": [] }
}`,
      maxTokens: 500,
    })
    return object.spec
  }

  async generateCategories(intent: IntentModel): Promise<string[]> {
    const { object } = await generateObject({
      model: this.getModel('extraction'),
      schema: z.object({
        categories: z.array(z.string()).min(1).max(8)
          .describe('Never empty — if genuinely uncertain, fall back to a sensible default set for the goalType rather than omitting categories.'),
      }),
      prompt: `A shopper pressed "show me now" before every detail was captured. Decide the shopping-list categories to assemble right now, from whatever is known so far.

AVAILABLE CATEGORIES — only use these, never invent others:
Home: vanity | faucet | mirror | lighting | tile | hardware
Fashion: jacket | top | pants | dress | shoes | belt | socks | scarf
(There is no "trousers" category — formal or tailored legwear is still the "pants" category.)

Goal: "${intent.goal}" (${intent.goalType})
Captured so far: ${JSON.stringify(intent.constraints)}

Reason the same way you would mid-conversation: pick categories that fit this specific goal and occasion, in body order (fashion: jacket/outerwear → top → pants/dress → shoes → belt/accessories; home: lighting → mirror → vanity → faucet → tile → hardware).`,
      maxTokens: 150,
    })
    return object.categories
  }

  async allocateBudget(
    totalBudget: number,
    categories: string[],
    catalogStats: Record<string, { min: number; max: number; avg: number }>
  ): Promise<Record<string, number>> {
    const rangeLines = categories.map(cat => {
      const s = catalogStats[cat]
      return s ? `- ${cat}: $${s.min}–$${s.max} (avg $${s.avg})` : `- ${cat}: unknown price range`
    }).join('\n')

    const sumOfMins = categories.reduce((sum, cat) => sum + (catalogStats[cat]?.min ?? 0), 0)

    const { object } = await generateObject({
      model: this.getModel('allocation'),
      schema: z.object({ allocation: z.record(z.number()) }),
      prompt: `Allocate a total shopping budget across categories.

Total budget: $${totalBudget}
Categories to purchase: ${categories.join(', ')}

Catalog price ranges:
${rangeLines}

Sum of cheapest options: $${sumOfMins}${sumOfMins > totalBudget ? ' — exceeds budget, set each to its minimum' : ''}

Rules:
1. Sum of all maxPrice values must be ≤ $${totalBudget}
2. Each maxPrice must be ≥ the category minimum price
3. Hero categories (outerwear, footwear, vanity, main fixture) get more; accessories get less
4. Allow splurging on one category — don't divide equally
5. For home projects: vanity and tile get larger share; hardware gets the least
6. For fashion: jacket/shoes get larger share; belt/socks get the least

Return ONLY valid JSON in the "allocation" field: {"jacket": 350, "top": 130, "shoes": 230, "belt": 90}`,
      maxTokens: 120,
    })

    const result: Record<string, number> = {}
    for (const cat of categories) {
      const alloc = object.allocation[cat]
      const raw = typeof alloc === 'number' ? Math.round(alloc) : (catalogStats[cat]?.max ?? 9999)
      const catMin = catalogStats[cat]?.min ?? 0
      result[cat] = Math.max(raw, catMin)
    }
    return result
  }

  async assignCollageRoles(intent: IntentModel, categories: string[]): Promise<Record<string, { displayRole: 'hero' | 'supporting' | 'accent'; weight: number }>> {
    const { object } = await generateObject({
      model: this.getModel('rationale'),
      schema: z.object({
        roles: z.record(z.object({
          displayRole: z.enum(['hero', 'supporting', 'accent']),
          weight: z.number().int().min(1).max(10),
        })),
      }),
      prompt: `Assign a collage display role and visual weight to each category for this shopping goal.

Goal: "${intent.goal}"
Categories: ${categories.join(', ')}

Rules:
- Exactly ONE category must be 'hero' — the primary functional anchor piece you choose first, around which everything else is built.
- 'supporting' — important pieces that complete the look or project.
- 'accent' — finishing touches, small accessories, or materials/swatches.
- weight 1–10: proportional column width in the collage. Hero: 7–9. Supporting: 4–6. Accent: 2–3.
- Hero is the piece with the most design decisions riding on it — NOT the most visually striking. For a bathroom: vanity (not mirror, not lighting). For a living room: sofa (not rug, not lamp). For an outfit: the jacket or key garment (not shoes, not belt).
- Mirrors, lighting, tile, hardware, scarves, socks, and belts are NEVER hero — they are supporting or accent.
- Return an entry for every category listed.`,
      maxTokens: 200,
    })
    return object.roles
  }

  async generateOverallSummary(intent: IntentModel, categories: string[]): Promise<string> {
    const catList = categories.join(', ')
    const { text } = await generateText({
      model: this.getModel('rationale'),
      prompt: `The shopper is putting together: "${intent.goal}".
The curated list covers these categories: ${catList}.

Write advisory text (30–45 words) that opens with "For a ${intent.goal}," and then gives confident, specific style advice — what to look for and why the pieces work together. Sound like a knowledgeable friend giving a recommendation, not a search engine.

DO NOT restate filter criteria (style tags, budget, gender). DO NOT mechanically list category names.

Fashion example: "For a rooftop dinner, the jacket is your anchor — it sets the mood and handles the evening air. A quality top keeps things relaxed, slim trousers sharpen the look, and the right shoes finish it."
Home example: "For a powder room refresh, the vanity and faucet define the space — choose those first. Mirror and lighting shift the atmosphere, tile sets the palette, and hardware ties it all together."

No quotes around the output. No preamble. Just the sentences.`,
      maxTokens: 120,
    })
    return text.trim().replace(/^["']|["']$/g, '')
  }
}

/** Claude provider. Models configured via LLM_CLAUDE_CHAT and LLM_CLAUDE_FAST env vars. */
export class ClaudeAdapter extends BaseAdapter {
  private chatModel: LanguageModel
  private fastModel: LanguageModel

  constructor(chatModelId?: string, fastModelId?: string) {
    super()
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    this.chatModel = anthropic(chatModelId ?? process.env.LLM_CLAUDE_CHAT ?? 'claude-sonnet-4-6')
    this.fastModel = anthropic(fastModelId ?? process.env.LLM_CLAUDE_FAST ?? 'claude-haiku-4-5-20251001')
  }

  getModel(task: LLMTask): LanguageModel {
    return task === 'chat' ? this.chatModel : this.fastModel
  }
}

/** OpenAI provider. Models configured via LLM_OPENAI_CHAT and LLM_OPENAI_FAST env vars. */
export class OpenAIAdapter extends BaseAdapter {
  private chatModel: LanguageModel
  private fastModel: LanguageModel

  constructor() {
    super()
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.chatModel = openai(process.env.LLM_OPENAI_CHAT ?? 'gpt-4o')
    this.fastModel = openai(process.env.LLM_OPENAI_FAST ?? 'gpt-4o-mini')
  }

  getModel(task: LLMTask): LanguageModel {
    return task === 'chat' ? this.chatModel : this.fastModel
  }
}

function buildRefinementsPrompt(intent: IntentModel, categories: string[]): string {
  const catList = categories.length ? categories.join(', ') : 'none yet'
  return `You are a shopping assistant. Generate 9 short refinement suggestions (3–5 words each) for this shopper.

Intent:
- Goal: ${intent.goal}
- Type: ${intent.goalType}
- Style: ${intent.constraints.style ?? 'not specified'}
- Budget: ${intent.constraints.budget ? `$${intent.constraints.budget}` : 'not specified'}
- Finish: ${intent.constraints.finish ?? 'not specified'}
- Colour direction: ${intent.constraints.colourDirection ?? 'not specified'}

Categories already in the curated list: ${catList}

Rules:
- For categories ALREADY in the list: suggest ways to REFINE them (e.g. "Go bolder on the mirror", "Upscale the lighting", "Try matte black faucet") — never say "add" for something already there
- Only suggest ADDING something if it is genuinely non-obvious for this project type — extras the shopper might not have thought of (e.g. heated flooring, towel warmer, in-mirror lighting). Never suggest adding things that any reasonable shopper doing this project would already expect (for a bathroom: vanity, faucet, mirror, tile, lighting, hardware are all obvious — don't suggest adding them)
- Mostly refine existing categories; only occasionally introduce a genuine extra
- Keep each suggestion 3–5 words, action-led, specific

Return ONLY a JSON array of 9 strings, no other text.`
}

function defaultRefinements(intent: IntentModel): string[] {
  if (intent.goalType === 'project') {
    return [
      'Change finish to matte black',
      'Increase budget slightly',
      'Add storage solutions',
      'Include tile options',
      'Switch to vessel sink',
      'Add heated flooring',
      'Try floating shelves',
      'Include towel warmer',
      'Add accent lighting',
    ]
  }
  return [
    'Try a bolder colour',
    'Add accessories',
    'Switch to smart casual',
    'Try monochrome look',
    'Add a statement piece',
    'Try a different silhouette',
    'Switch to earthy tones',
    'Add a blazer',
    'Try minimalist styling',
  ]
}
