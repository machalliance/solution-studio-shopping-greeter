#!/usr/bin/env python3
"""
Seed the live Contentstack stack from the catalog fixtures.

Creates the three content types the Greeter's ContentstackAdapter queries
(buying_guide, how_to, project_guide), then creates and publishes one
entry per fixture record (fixtures/contentstack-*.json). Idempotent:
existing content types are kept, and entries are matched by title so
re-running never duplicates.

Entry tags are set from the fixture — the adapter matches entries whose
tags overlap with the category, the shopper's goal, the selected style
(namespaced "style:<name>"), and the actual returned products' own tags,
so tags are what connect content to results. Keep tags lowercase — the
match is case-sensitive.

Credentials:
  CONTENTSTACK_API_KEY and CONTENTSTACK_ENVIRONMENT are read from the
  environment, falling back to greeter/.env. The MANAGEMENT token is
  deliberately NOT read from greeter/.env — the server only needs the
  delivery token. Pass it just for this run:

    CONTENTSTACK_MANAGEMENT_TOKEN=xxxx ./seed-contentstack.py

  Non-US stacks: set CONTENTSTACK_REGION=eu (or azure-na / azure-eu).
  NOTE: the Greeter's delivery adapter targets cdn.contentstack.io (US) —
  if your stack is in another region, cms.ts needs the matching CDN host.
"""

import json
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).parent          # greeter/scripts
GREETER_ENV = HERE.parent / ".env"    # greeter/.env
FIXTURES_DIR = HERE.parent / "catalog" / "fixtures"

REGION_HOSTS = {
    "na":       "https://api.contentstack.io",
    "eu":       "https://eu-api.contentstack.com",
    "azure-na": "https://azure-na-api.contentstack.com",
    "azure-eu": "https://azure-eu-api.contentstack.com",
}

CONTENT_TYPES = {
    "buying_guide":  "Buying Guide",
    "how_to":        "How To",
    "project_guide": "Project Guide",
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
    """The stack's actual master language code — not assumed to be en-us,
    since org-level defaults vary. Entry create/publish calls must use
    this exact code or Contentstack rejects them (error_code 141)."""
    r = requests.get(f"{BASE}/locales", headers=HEADERS, timeout=30)
    r.raise_for_status()
    locales = r.json().get("locales", [])
    for loc in locales:
        if loc.get("fallback_locale") is None:
            return loc["code"]
    if locales:
        return locales[0]["code"]
    sys.exit("Could not determine the stack's master locale (GET /v3/locales returned none).")


LOCALE = master_locale()
print(f"stack master locale: {LOCALE}")


def ensure_content_type(uid: str, title: str) -> None:
    r = requests.get(f"{BASE}/content_types/{uid}", headers=HEADERS, timeout=30)
    if r.status_code == 200:
        print(f"content type '{uid}' exists")
        return
    # is_page left unset (defaults false): "url" stays a plain custom field.
    # is_page:true makes Contentstack auto-manage a *system* "url" field
    # derived from url_pattern, which collides with our own "url" field of
    # the same uid — that mismatch is what the 422 on entry-create was.
    schema = {
        "content_type": {
            "title": title,
            "uid": uid,
            "schema": [
                {"display_name": "Title", "uid": "title", "data_type": "text",
                 "mandatory": True, "unique": True},
                {"display_name": "URL", "uid": "url", "data_type": "text"},
                {"display_name": "Summary", "uid": "summary", "data_type": "text",
                 "field_metadata": {"multiline": True}},
                {"display_name": "Read Time", "uid": "read_time", "data_type": "text"},
                {"display_name": "Icon", "uid": "icon", "data_type": "text"},
            ],
        }
    }
    r = requests.post(f"{BASE}/content_types", headers=HEADERS, json=schema, timeout=30)
    if not r.ok:
        sys.exit(f"content type '{uid}' creation failed: {r.status_code} {r.text}")
    print(f"content type '{uid}' created")


def existing_titles(ct: str) -> set[str]:
    r = requests.get(f"{BASE}/content_types/{ct}/entries", headers=HEADERS,
                     params={"limit": 100}, timeout=30)
    if r.status_code != 200:
        return set()
    return {e["title"] for e in r.json().get("entries", [])}


def create_and_publish(ct: str, fixture: dict) -> None:
    entry = {
        "title": fixture["title"],
        "url": fixture["url"],
        "summary": fixture.get("summary", ""),
        "read_time": fixture.get("read_time", ""),
        "icon": fixture.get("icon", "book"),
        "tags": fixture.get("tags", []),
    }
    r = requests.post(f"{BASE}/content_types/{ct}/entries",
                      headers=HEADERS, params={"locale": LOCALE},
                      json={"entry": entry}, timeout=30)
    if not r.ok:
        print(f"  ! {fixture['title']}: create failed — {r.status_code} {r.text}")
        return
    uid = r.json()["entry"]["uid"]
    r = requests.post(f"{BASE}/content_types/{ct}/entries/{uid}/publish",
                      headers=HEADERS,
                      json={"entry": {"environments": [ENV], "locales": [LOCALE]}},
                      timeout=30)
    if not r.ok:
        print(f"  ! {fixture['title']}: publish failed — {r.status_code} {r.text}")
        return
    print(f"  + {fixture['title']} (published)")


for uid, title in CONTENT_TYPES.items():
    ensure_content_type(uid, title)

for f in sorted(FIXTURES_DIR.glob("contentstack-*.json")):
    entries = json.load(open(f))["entries"]
    by_type: dict[str, list[dict]] = {}
    for e in entries:
        by_type.setdefault(e["content_type_uid"], []).append(e)
    for ct, items in by_type.items():
        if ct not in CONTENT_TYPES:
            print(f"skipping unknown content type '{ct}' in {f.name}")
            continue
        have = existing_titles(ct)
        for item in items:
            if item["title"] in have:
                print(f"  = {item['title']} (already exists)")
            else:
                create_and_publish(ct, item)

print("Done. Greeter needs USE_FIXTURES=false + delivery token in .env, then a restart —")
print(".env is only read at process startup, so a running server won't pick up the change.")
