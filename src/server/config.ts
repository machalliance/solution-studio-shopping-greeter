import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeAdapter, OpenAIAdapter } from '../adapters/llm.js'
import type { LLMAdapter } from '../adapters/llm.js'
import { FixtureSearchAdapter, AlgoliaAdapter } from '../adapters/search.js'
import { FixtureCMSAdapter, ContentstackAdapter } from '../adapters/cms.js'
import type { SearchAdapter } from '../adapters/search.js'
import type { CMSAdapter } from '../adapters/cms.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '../..')

export const FIXTURES_DIR      = join(ROOT, 'catalog/fixtures')
export const IMAGES_SERVE_ROOT = './catalog'
const PANEL_HTML_PATH          = join(ROOT, 'dist/panel.html')
export const STYLE_SRC         = join(ROOT, 'src/style.css')

/** Read fresh on each request so `npm run build` hot-swaps the bundle without a server restart. */
export function getPanelHtml() { return readFileSync(PANEL_HTML_PATH, 'utf-8') }

export const useFixtures = process.env.USE_FIXTURES !== 'false'
export const zeroResultsAction = (process.env.ZERO_RESULTS_ACTION ?? 'fallback') as 'fallback' | 'notice'
// Max wait for a single /api/chat LLM turn before it's treated as failed — see the streamText
// timeout guard in routes/chat.ts for why this exists.
export const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 15_000

// Supported provider keys — maps to the adapter + model used for all LLM calls.
// Switch at runtime via POST /api/provider; initial value from LLM_PROVIDER env var.
// Per-provider model config lives in env vars (LLM_CLAUDE_CHAT, LLM_OPENAI_CHAT, etc.)
export type ProviderKey = 'claude' | 'openai'

function createAdapter(provider: ProviderKey): LLMAdapter {
  switch (provider) {
    case 'openai': return new OpenAIAdapter()
    default:       return new ClaudeAdapter()
  }
}

// `activeProvider` and `llm` are reassigned by setProvider at runtime. Importers read them as
// ESM live bindings, so a provider switch is visible everywhere immediately — which is why the
// swap must go through setProvider here rather than each route holding its own copy.
export let activeProvider: ProviderKey = (process.env.LLM_PROVIDER ?? 'claude') as ProviderKey
export let llm: LLMAdapter = createAdapter(activeProvider)

/** Swaps the provider and its adapter, discarding any per-model overrides with it. */
export function setProvider(provider: ProviderKey) {
  activeProvider = provider
  llm = createAdapter(provider)
}

export const search: SearchAdapter = useFixtures
  ? new FixtureSearchAdapter()
  : new AlgoliaAdapter({
      appId: process.env.ALGOLIA_APP_ID!,
      apiKey: process.env.ALGOLIA_API_KEY!,
      indexName: process.env.ALGOLIA_INDEX_NAME!,
    })

export const cms: CMSAdapter = useFixtures
  ? new FixtureCMSAdapter()
  : new ContentstackAdapter({
      apiKey: process.env.CONTENTSTACK_API_KEY!,
      deliveryToken: process.env.CONTENTSTACK_DELIVERY_TOKEN!,
      environment: process.env.CONTENTSTACK_ENVIRONMENT!,
    })
