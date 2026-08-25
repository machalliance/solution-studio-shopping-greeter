#!/usr/bin/env python3
"""
Seed the live Algolia index from the catalog fixtures.

Uploads every record from fixtures/algolia-*.json (objectIDs preserved, so
re-running updates in place — no duplicates) and configures the index
facets the Greeter's AlgoliaAdapter filters on: category, style, fit,
tags, plus numeric price.

Credentials:
  ALGOLIA_APP_ID and ALGOLIA_INDEX_NAME are read from the environment,
  falling back to greeter/.env. The ADMIN (write) key is deliberately NOT
  read from greeter/.env — the server only ever needs the search-only key.
  Pass it just for this run:

    ALGOLIA_ADMIN_KEY=xxxx ./seed-algolia.py
"""

import json
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).parent          # greeter/scripts
GREETER_ENV = HERE.parent / ".env"    # greeter/.env
FIXTURES_DIR = HERE.parent / "catalog" / "fixtures"


def env_or_dotenv(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    if GREETER_ENV.exists():
        for line in GREETER_ENV.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or None
    return None


APP_ID    = env_or_dotenv("ALGOLIA_APP_ID")
INDEX     = env_or_dotenv("ALGOLIA_INDEX_NAME")
ADMIN_KEY = os.environ.get("ALGOLIA_ADMIN_KEY")

if not all([APP_ID, INDEX, ADMIN_KEY]):
    sys.exit("Need ALGOLIA_APP_ID + ALGOLIA_INDEX_NAME (env or greeter/.env) "
             "and ALGOLIA_ADMIN_KEY (env only). See file header.")

BASE = f"https://{APP_ID}.algolia.net/1/indexes/{INDEX}"
HEADERS = {
    "X-Algolia-Application-Id": APP_ID,
    "X-Algolia-API-Key": ADMIN_KEY,
    "Content-Type": "application/json",
}

# ── Index settings: declare the facets the adapter filters on ──────────
settings = {
    "attributesForFaceting": [
        "filterOnly(category)",
        "filterOnly(style)",
        "filterOnly(fit)",
        "filterOnly(tags)",
    ],
}
r = requests.put(f"{BASE}/settings", headers=HEADERS, json=settings, timeout=30)
r.raise_for_status()
print(f"settings applied to index '{INDEX}'")

# ── Batch upload all fixture records ───────────────────────────────────
hits = []
for f in sorted(FIXTURES_DIR.glob("algolia-*.json")):
    hits.extend(json.load(open(f))["hits"])

requests_body = {
    "requests": [{"action": "updateObject", "body": h} for h in hits]
}
r = requests.post(f"{BASE}/batch", headers=HEADERS, json=requests_body, timeout=120)
r.raise_for_status()
print(f"uploaded {len(hits)} records → index '{INDEX}'")
print("Done. Greeter needs USE_FIXTURES=false + search-only key in .env, then a restart —")
print(".env is only read at process startup, so a running server won't pick up the change.")
