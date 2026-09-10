import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the shipped catalog against third-party brand data coming back.
 *
 * Every product record used to carry a real, currently-trading company in its `brand` field,
 * attached to an invented product, an invented price and generated photography. That data was
 * removed, but the catalog is produced by a separate generator project whose own fix is not yet
 * in place, so the next regeneration can reintroduce it — and a later hand-edit can too. Nothing
 * in CI noticed the first time.
 *
 * Two independent checks, because the two failure modes look different:
 *
 *   1. Structural — no `brand` field on any shipped record. This catches a regenerated catalog
 *      wholesale, whatever values it happens to carry. `brand` remains a supported *field*
 *      (SHOW_BRAND exists for operators pointing the app at their own catalog); what must not
 *      ship is brand data in *these* files.
 *
 *   2. Digest sweep — none of the removed values may reappear in any text field. This catches a
 *      partial cleanup, which is what actually happened once: the obvious fields were cleaned
 *      while one value survived in a url slug and another in a tag and an imagePrompt. Check 1
 *      cannot see that shape of miss.
 *
 * The guarded values are stored as truncated SHA-256 digests, not as text, so this repo does not
 * itself publish an inventory of third-party marks. That is a disclosure choice, not a security
 * one — short digests are brute-forceable and are not meant to be secret. Diagnosability is
 * unaffected: on failure the assertion prints the offending file, record, field and the matching
 * text, which is what a maintainer needs to act.
 *
 * Two of the removed values are omitted from the digest set because they are also ordinary
 * product copy (a construction noun and a fabric verb), and guarding them would fail on
 * innocent wording forever. One further limitation is accepted deliberately: a single-word fragment of
 * a multi-word value cannot be guarded when that word is also a garment type the catalog uses
 * legitimately. Both are judgement, not oversight — a value whose distinctive word is
 * also a product noun needs review rather than a regex.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'catalog/fixtures')

/** Truncated SHA-256 of each guarded value, normalised as `normalise()` below produces. */
const GUARDED_DIGESTS = new Set([
  '00cde63195b11c9b', '023d28906f2c7e56', '045137b4e7b5c8b5', '04545216b2607c80',
  '0681c0b3731722d0', '06dcdcc5c3c3fe4c', '08bb42a30ca57f34', '08c461ad70fce6c7',
  '09b0d1fe6b245c07', '0a40fe697021812c', '0c69d773538aa665', '0dfd925499686d26',
  '15dbdaf93d1b48a0', '1638b58d602047f7', '16ec9e273c66753b', '199c60b7f0e6bcf0',
  '19e37495f85ea601', '1a637788c9e469bd', '1b31cf9d1eea79c4', '1bad4ee2e7a8e61e',
  '1cad0e04b09ec077', '1ec6da0d8ec56f60', '1faf23fc4ed5880a', '2261f7589ba97250',
  '27b10d70f8506ad5', '2c39e9f55946b530', '2c7e72618e50b6bf', '2e207bdc8f4f02ba',
  '318d297e7555b952', '35580c025440f584', '396299af92a28c10', '3983a371ecd6de78',
  '39df2da36f18a484', '3a536bd98e03ea07', '3f59748228c663bc', '3fcbb7a803182423',
  '41981e8c46530549', '46059a877da0c090', '48eef5c927697532', '493b3028d4514ea9',
  '49cce02a3d6abb69', '4afed26c712ad555', '4c9886c623963308', '4d0becbf40a7dd5f',
  '4f4a9410ffcdf895', '54d5dbf0124e59af', '56d9ca75aa50d686', '5b444f0556160f20',
  '5d1937860f651310', '6a930006ef296ea0', '6dfec840e961278f', '6e148a721c69de11',
  '76dd3d97a001f07f', '77a45f25d31a81b8', '78e823e2d1f90431', '7c3a61b7be383490',
  '7d5fe0ccdadcd4e9', '7e1e6f3892d7aa80', '83e10a5828783e99', '8599ac6a652b9a76',
  '8724c31a229e5df4', '87e32155c8150c9c', '89545023a146481f', '8eda8ea599a97ffd',
  '9297d9cf5ef65c9b', '92d110ecfc8017a0', '94fff346cc28cb55', '9bc5b3b598063fd4',
  '9be28bbe03fa7c43', '9f051630e7e5f3ab', 'a19886f4e4a4def5', 'a23a77770ca5072f',
  'a3ab747d76de03ff', 'a51c468704584733', 'a644fa8bceb16f06', 'a9a7fb042648f912',
  'ac0ea3f64534dfc2', 'ad0bb0d2c91df176', 'af2a30a366e3a070', 'b14ee5d26668d849',
  'b20ec2134677398d', 'b41884d9660e8ae2', 'b47fb46b2c8b392a', 'b787a7c537ba7bdd',
  'b9da7da9a35ba228', 'ba0c14bbd680748f', 'bc0f71db4433a69e', 'bf51ca17d40c6506',
  'c20178b5ec253ad3', 'c33425542548ec25', 'c48b3042fead475e', 'c863f1a4c8af3a3e',
  'cc98764ac015c840', 'cdca2e093a9ab8cc', 'ce72595ea8a7c4f4', 'ce8556b4d728a987',
  'cecd49b5a17c8cc4', 'cfbc44304f6f8847', 'd038282da4d98b33', 'd14c6f371dc2a3e9',
  'd40e0a7adf993cc8', 'd655bf6e28b44e4b', 'd70bc8b4433eab4e', 'd92a67ed99102dc3',
  'ddf44129a1acb538', 'dfe2740f9eb1d987', 'e0075f65ca4bd3ee', 'e6047c3e6ebaced2',
  'e9c8940508a72c44', 'ec8b56c54a9c6c7f', 'ed6d9d73a0a466a3', 'f41f2c785e15ca0c',
  'f4397b4805e00143', 'f98994ea9fb2edfe', 'fae0694da83ad615', 'fb8f21fc2d38e15c',
  'fc056f6701e9914e', 'fd09da605e5804b3', 'fd40025b96c2b4d9',])

/** Longest guarded value in tokens — the sweep needs n-grams up to this length to match. */
const MAX_TOKENS = 4

/**
 * Canonical token form. Apostrophes, periods and ampersands are dropped rather than replaced
 * so punctuation styling cannot slip a value past ("X.Y.Z." and "XYZ" normalise alike); every
 * other separator, hyphens in url slugs included, becomes a token break.
 */
function normalise(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’.&]/g, '')
    .replace(/[^a-z0-9À-ɏ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Every 1..MAX_TOKENS-word window of `text`, so multi-word values match as phrases. */
function ngrams(text: string): string[] {
  const toks = normalise(text)
  const out: string[] = []
  for (let n = 1; n <= MAX_TOKENS; n++) {
    for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(' '))
  }
  return out
}

const TEXT_FIELDS = [
  'name', 'description', 'imagePrompt', 'url', 'style', 'finish', 'colourFamily', 'category',
  'brand', 'title', 'summary',
] as const

interface Rec { objectID?: string; uid?: string; [k: string]: unknown }

function fixtureFiles(prefix: string): string[] {
  return readdirSync(FIXTURES).filter(f => f.startsWith(prefix) && f.endsWith('.json'))
}

function records(file: string): Rec[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, file), 'utf-8'))
  return parsed.hits ?? parsed.entries ?? []
}

/** Everything on a record a value could be written into, as `field -> text`. */
function textOf(rec: Rec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of TEXT_FIELDS) if (rec[f]) out[f] = String(rec[f])
  if (Array.isArray(rec.tags)) out.tags = rec.tags.join(' ')
  return out
}

describe('the shipped catalog carries no brand data', () => {
  it('has records to sweep, so the checks below cannot pass vacuously', () => {
    const total = fixtureFiles('algolia-').reduce((n, f) => n + records(f).length, 0)
    expect(total).toBeGreaterThan(150)
    expect(GUARDED_DIGESTS.size).toBeGreaterThan(100)
  })

  it('has no brand field on any product record', () => {
    const offenders: string[] = []
    for (const file of fixtureFiles('algolia-')) {
      for (const rec of records(file)) {
        if (rec.brand !== undefined && String(rec.brand).trim() !== '') {
          offenders.push(`${file} ${rec.objectID} brand=${JSON.stringify(rec.brand)}`)
        }
      }
    }
    expect(
      offenders,
      'Product records carry a brand value again. The shipped catalog is fictional and must not ' +
      'attach real companies to invented products and prices — see catalog/README.md and NOTICE. ' +
      'If this came from regenerating the catalog, the generator needs the same fix.\n' +
      offenders.join('\n'),
    ).toEqual([])
  })
})

describe('no removed brand value reappears in catalog text', () => {
  for (const prefix of ['algolia-', 'contentstack-']) {
    it(`finds none in ${prefix}* fixtures`, () => {
      const offenders: string[] = []
      for (const file of fixtureFiles(prefix)) {
        for (const rec of records(file)) {
          const id = rec.objectID ?? rec.uid ?? '?'
          for (const [field, text] of Object.entries(textOf(rec))) {
            for (const gram of ngrams(text)) {
              if (GUARDED_DIGESTS.has(digest(gram))) {
                offenders.push(`${file} ${id} .${field} — matched "${gram}" in: ${text.slice(0, 100)}`)
              }
            }
          }
        }
      }
      expect(
        offenders,
        'A brand value that was removed from the catalog is back in its text. Check url slugs, ' +
        'tags and imagePrompt as well as the obvious fields — that mix is what the first pass ' +
        'missed. The matched phrase is quoted above. If it is genuinely ordinary product copy ' +
        'rather than a company, drop its digest from GUARDED_DIGESTS and note why.\n' +
        offenders.join('\n'),
      ).toEqual([])
    })
  }
})
