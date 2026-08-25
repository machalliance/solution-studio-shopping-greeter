#!/usr/bin/env python3
"""
One-off: correct tags on an already-published Contentstack entry.

Fixes all three fashion CMS test entries — each was tagged with generic
category names ("jacket", "top", "pants", "shoes") alongside its actual
topic, which let category-tag matching alone surface it regardless of
whether the topic was actually relevant:

- "Dressing for a Rooftop Dinner Date" showed up for a "Relaxed Tailored
  Weekend look" (nothing rooftop about it) — matched via "jacket"/"shoes".
- "Smart Casual, Decoded" showed up for "Coastal Beach Casual" (a
  different style entirely) — matched via "top".
- "Finding Your Jean Fit" showed up when the "Pants" category resolved to
  SHORTS, not jeans — "pants" as a tag can't distinguish jeans from
  shorts from chinos; the category name was never a reliable proxy for
  what's actually in the slot.

Fix: drop category-name tags from all three, keep only topic-specific
tags. server.ts now also passes `intent.constraints.style` as an extra
match signal (see ContentParams.tags), so "smart casual" as a style tag
still surfaces "Smart Casual, Decoded" precisely — for a real smart-casual
outfit, not any outfit sharing a category with it. The jean-fit guide will
now show far less often (only when style/goal explicitly says jeans/denim)
— there's no reliable signal from a category alone to know if pants
resolved to actual jeans; this is a known limitation, not a bug.

Credentials: same pattern as the other scripts — CONTENTSTACK_API_KEY and
CONTENTSTACK_ENVIRONMENT from env or greeter/.env, management token on
the command line only:

  CONTENTSTACK_MANAGEMENT_TOKEN=xxxx ./scripts/retag-cms-entry.py
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

# (content_type_uid, title) → corrected tags
FIXES = [
    (
        "buying_guide",
        "Dressing for a Rooftop Dinner Date",
        ["rooftop dinner outfit", "rooftop-dinner-outfit", "occasion"],
    ),
    (
        "buying_guide",
        "Smart Casual, Decoded",
        # Namespaced style tag, not a bare "smart-casual" — that bare tag collided with the same
        # word used as a generic product-versatility descriptor on ~10 unrelated shirts, wrongly
        # surfacing this guide for e.g. "Coastal Beach Casual". server.ts sends the shopper's
        # selected style as "style:<name>", which no raw product tag can ever match by accident.
        ["style:smart casual", "style-guide"],
    ),
    (
        "how_to",
        "Finding Your Jean Fit: Slim, Straight, or Relaxed",
        ["jean-fit", "sizing", "jeans", "denim"],
    ),
]


def master_locale() -> str:
    r = requests.get(f"{BASE}/locales", headers=HEADERS, timeout=30)
    r.raise_for_status()
    for loc in r.json().get("locales", []):
        if loc.get("fallback_locale") is None:
            return loc["code"]
    sys.exit("Could not determine the stack's master locale.")


LOCALE = master_locale()

for ct, title, new_tags in FIXES:
    r = requests.get(f"{BASE}/content_types/{ct}/entries", headers=HEADERS,
                     params={"limit": 100}, timeout=30)
    r.raise_for_status()
    entry = next((e for e in r.json().get("entries", []) if e["title"] == title), None)
    if not entry:
        print(f"  ! {title}: not found in {ct} — skipped")
        continue

    r = requests.put(f"{BASE}/content_types/{ct}/entries/{entry['uid']}",
                     headers=HEADERS, params={"locale": LOCALE},
                     json={"entry": {"tags": new_tags}}, timeout=30)
    if not r.ok:
        print(f"  ! {title}: update failed — {r.status_code} {r.text}")
        continue

    r = requests.post(f"{BASE}/content_types/{ct}/entries/{entry['uid']}/publish",
                      headers=HEADERS,
                      json={"entry": {"environments": [ENV], "locales": [LOCALE]}},
                      timeout=30)
    if not r.ok:
        print(f"  ! {title}: republish failed — {r.status_code} {r.text}")
        continue
    print(f"  + {title}: tags → {new_tags} (republished)")

print("Done. No restart needed — ContentstackAdapter queries live, no caching.")
