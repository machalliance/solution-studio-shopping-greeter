#!/usr/bin/env python3
"""
One-off: create three fashion CMS entries directly in Contentstack, for
testing that the live ContentstackAdapter surfaces content on a real
clothing demo run. These live ONLY in Contentstack — no local fixture
file, unlike the seeded home-category guides.

The adapter queries `tags: { $in: [category, goal] }` per category row
(cms.ts → ContentstackAdapter.getContent). `category` is the canonical
clothing category name (jacket/top/pants/shoes/...); `goal` is the
shopper's raw intent.goal text, which is freeform and unreliable to tag
against exactly — so each entry is tagged with the category names it
should surface under, plus the goal phrase as a bonus attempt.

Credentials: same pattern as seed-contentstack.py — CONTENTSTACK_API_KEY
and CONTENTSTACK_ENVIRONMENT from env or greeter/.env, management token
passed on the command line only:

  CONTENTSTACK_MANAGEMENT_TOKEN=xxxx ./scripts/add-fashion-cms-entries.py
"""

import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).parent
GREETER_ENV = HERE.parent / ".env"

REGION_HOSTS = {
    "na":       "https://api.contentstack.io",
    "eu":       "https://eu-api.contentstack.com",
    "azure-na": "https://azure-na-api.contentstack.com",
    "azure-eu": "https://azure-eu-api.contentstack.com",
}


def env_or_dotenv(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    if GREETER_ENV.exists():
        for line in GREETER_ENV.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or None
    return None


API_KEY = env_or_dotenv("CONTENTSTACK_API_KEY")
ENV     = env_or_dotenv("CONTENTSTACK_ENVIRONMENT")
MGMT    = os.environ.get("CONTENTSTACK_MANAGEMENT_TOKEN")
REGION  = os.environ.get("CONTENTSTACK_REGION", "na")

if not all([API_KEY, ENV, MGMT]):
    sys.exit("Need CONTENTSTACK_API_KEY + CONTENTSTACK_ENVIRONMENT (env or "
             "greeter/.env) and CONTENTSTACK_MANAGEMENT_TOKEN (env only).")

BASE = f"{REGION_HOSTS[REGION]}/v3"
HEADERS = {
    "api_key": API_KEY,
    "authorization": MGMT,
    "Content-Type": "application/json",
}


def master_locale() -> str:
    r = requests.get(f"{BASE}/locales", headers=HEADERS, timeout=30)
    r.raise_for_status()
    for loc in r.json().get("locales", []):
        if loc.get("fallback_locale") is None:
            return loc["code"]
    sys.exit("Could not determine the stack's master locale.")


LOCALE = master_locale()
print(f"stack master locale: {LOCALE}")

ENTRIES = [
    {
        "content_type_uid": "buying_guide",
        "title": "Smart Casual, Decoded",
        "url": "/guides/smart-casual-decoded",
        "summary": "What \"smart casual\" actually means item by item — the line between "
                    "polished and overdressed, and how to hit it with a jacket and the right top.",
        "read_time": "4 min",
        "icon": "book",
        # No category tags (jacket/top) — those made this leak into ANY outfit with a top or
        # jacket, regardless of whether it was actually smart casual (e.g. Coastal Beach Casual).
        # Also no BARE "smart-casual" tag — that word is a common product-versatility descriptor
        # on many shirts regardless of the shopper's selected style, so a bare tag collided with
        # unrelated outfits the same way the category tags did. server.ts sends the shopper's
        # actual selected style namespaced as "style:<name>", which no raw product tag can match
        # by accident — that's the only signal this entry should match on.
        "tags": ["style:smart casual", "style-guide"],
    },
    {
        "content_type_uid": "buying_guide",
        "title": "Dressing for a Rooftop Dinner Date",
        "url": "/guides/rooftop-dinner-date-outfit",
        "summary": "Evening rooftop venues run warmer than they look on the way up and cooler "
                    "once the sun's down — how to layer a jacket and pick shoes that work both ways.",
        "read_time": "5 min",
        "icon": "book",
        # Occasion-specific — no category tags (jacket/shoes). Those made this leak into every
        # jacket-or-shoes outfit regardless of occasion. Relies on the goal-phrase match only.
        "tags": ["rooftop dinner outfit", "rooftop-dinner-outfit", "occasion"],
    },
    {
        "content_type_uid": "how_to",
        "title": "Finding Your Jean Fit: Slim, Straight, or Relaxed",
        "url": "/how-to/find-your-jean-fit",
        "summary": "A quick way to tell which fit is actually yours, and why the size on the "
                    "tag matters less than where the fabric sits at the knee and ankle.",
        "read_time": "3 min",
        "icon": "ruler",
        # No "pants" category tag — "pants" resolves to shorts, chinos, or trousers just as
        # often as jeans, and a jean-fit guide showing up next to beach shorts is wrong. Relies
        # on the goal/style text actually mentioning jeans or denim — shows less often, but only
        # when genuinely relevant. There's no reliable way to know a category resolved to jeans
        # specifically without knowing the chosen products, which this tag-based match can't see.
        "tags": ["jean-fit", "sizing", "jeans", "denim"],
    },
    {
        "content_type_uid": "buying_guide",
        "title": "Coastal Style, Decoded",
        "url": "/guides/coastal-style-decoded",
        "summary": "Coastal reads as relaxed, not sloppy — light fabrics, a soft palette, and a "
                    "silhouette that moves easily between a beach walk and a waterfront dinner.",
        "read_time": "4 min",
        "icon": "book",
        # Namespaced style tags, not bare "coastal" — intent.constraints.style always ends up as
        # the specific sub-direction the shopper picked (e.g. "Coastal Beach Casual"), never the
        # bare parent family "Coastal", so this covers the sub-directions the prompt's own coastal
        # examples produce (agent/intent.ts: "Coastal → Beach Casual | Resort Wear | Coastal Chic
        # | Nautical") with the parent name prepended, matching how App.tsx actually combines them.
        "tags": [
            "style:coastal beach casual", "style:coastal resort wear",
            "style:coastal chic", "style:coastal nautical", "style-guide",
        ],
    },
]


def existing_titles(ct: str) -> set[str]:
    r = requests.get(f"{BASE}/content_types/{ct}/entries", headers=HEADERS,
                     params={"limit": 100}, timeout=30)
    if r.status_code != 200:
        return set()
    return {e["title"] for e in r.json().get("entries", [])}


for entry in ENTRIES:
    ct = entry["content_type_uid"]
    if entry["title"] in existing_titles(ct):
        print(f"  = {entry['title']} (already exists)")
        continue

    body = {k: v for k, v in entry.items() if k != "content_type_uid"}
    r = requests.post(f"{BASE}/content_types/{ct}/entries",
                      headers=HEADERS, params={"locale": LOCALE},
                      json={"entry": body}, timeout=30)
    if not r.ok:
        print(f"  ! {entry['title']}: create failed — {r.status_code} {r.text}")
        continue
    uid = r.json()["entry"]["uid"]

    r = requests.post(f"{BASE}/content_types/{ct}/entries/{uid}/publish",
                      headers=HEADERS,
                      json={"entry": {"environments": [ENV], "locales": [LOCALE]}},
                      timeout=30)
    if not r.ok:
        print(f"  ! {entry['title']}: publish failed — {r.status_code} {r.text}")
        continue
    print(f"  + {entry['title']} (published)")

print("Done. No restart needed — ContentstackAdapter queries live, no caching.")
