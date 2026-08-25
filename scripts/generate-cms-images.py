#!/usr/bin/env python3
"""
Generate one thumbnail image per CMS guide/how-to entry.

Reads the live entry list straight from Contentstack (not a locally-duplicated
list — avoids drift from whatever's actually published) across all three
content types, then generates one editorial/lifestyle photo per entry from
its title + summary.

No Contentstack schema change needed: images are served by URL convention.
An entry with url "/guides/rooftop-dinner-date-outfit" maps to
<...>/images/guides/rooftop-dinner-date-outfit.png — see slugFromUrl() in
CMSCardView.tsx and host/guide.html, which must stay in sync with this.

Written to BOTH catalog/images/guides/ (used when CATALOG_PATH is set) and
host/images/guides/ (the embedded fallback used when it's unset — the default).
Skipping this mirror is what left host/images/guides/ empty after Docker was
removed: CATALOG_PATH was always set under Docker, so the embedded fallback
path never actually got exercised until it was the only path left.

Idempotent: skips generation for any entry that already has a catalog image,
so it's safe to re-run after adding new CMS entries — only fills gaps. Still
backfills the host/images/guides/ mirror on every run, even for skipped entries,
so a partially-mirrored set never stays partial.

Credentials: CONTENTSTACK_API_KEY, CONTENTSTACK_DELIVERY_TOKEN,
CONTENTSTACK_ENVIRONMENT and OPENAI_API_KEY from env or greeter/.env.

Usage:
  ./scripts/generate-cms-images.py
  ./scripts/generate-cms-images.py --force   # regenerate even if a file exists
"""

import base64
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).parent          # greeter/scripts
GREETER_ENV = HERE.parent / ".env"    # greeter/.env
IMAGES_DIR = HERE.parent / "catalog" / "images" / "guides"
EMBEDDED_IMAGES_DIR = HERE.parent / "host" / "images" / "guides"

CONTENT_TYPES = ["buying_guide", "how_to", "project_guide"]


def env_or_dotenv(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    if GREETER_ENV.exists():
        for line in GREETER_ENV.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or None
    return None


CS_API_KEY = env_or_dotenv("CONTENTSTACK_API_KEY")
CS_TOKEN   = env_or_dotenv("CONTENTSTACK_DELIVERY_TOKEN")
CS_ENV     = env_or_dotenv("CONTENTSTACK_ENVIRONMENT")
OPENAI_KEY = env_or_dotenv("OPENAI_API_KEY")

if not all([CS_API_KEY, CS_TOKEN, CS_ENV, OPENAI_KEY]):
    sys.exit("Need CONTENTSTACK_API_KEY, CONTENTSTACK_DELIVERY_TOKEN, "
             "CONTENTSTACK_ENVIRONMENT, OPENAI_API_KEY (env or greeter/.env).")


def slug_from_url(url: str) -> str:
    parts = [p for p in (url or "").split("/") if p]
    return parts[-1] if parts else "default"


def fetch_all_entries() -> list[dict]:
    entries = []
    for ct in CONTENT_TYPES:
        url = f"https://cdn.contentstack.io/v3/content_types/{ct}/entries"
        r = requests.get(url, headers={"api_key": CS_API_KEY, "access_token": CS_TOKEN},
                         params={"environment": CS_ENV, "limit": 100}, timeout=30)
        if not r.ok:
            print(f"  ! failed to list {ct}: {r.status_code} {r.text}")
            continue
        entries.extend(r.json().get("entries", []))
    return entries


def generate_image(title: str, summary: str) -> bytes:
    prompt = (
        f"A photographic, editorial lifestyle image illustrating an advice article "
        f"titled \"{title}\". {summary} "
        f"Natural lighting, real photographic realism (not illustration or 3D render), "
        f"magazine-editorial composition, no text, no logos, no watermarks, no visible "
        f"human faces, square 1:1 composition."
    )
    r = requests.post(
        "https://api.openai.com/v1/images/generations",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={"model": "gpt-image-2", "prompt": prompt, "n": 1, "size": "1024x1024", "quality": "medium"},
        timeout=120,
    )
    if not r.ok:
        raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:300]}")
    data = r.json()["data"][0]
    if "b64_json" in data:
        return base64.b64decode(data["b64_json"])
    img = requests.get(data["url"], timeout=60)
    img.raise_for_status()
    return img.content


if __name__ == "__main__":
    force = "--force" in sys.argv
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    EMBEDDED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    entries = fetch_all_entries()
    print(f"Found {len(entries)} CMS entries across {', '.join(CONTENT_TYPES)}\n")

    for entry in entries:
        slug = slug_from_url(entry.get("url", ""))
        dest = IMAGES_DIR / f"{slug}.png"
        embedded_dest = EMBEDDED_IMAGES_DIR / f"{slug}.png"

        if dest.exists() and not force:
            if not embedded_dest.exists():
                embedded_dest.write_bytes(dest.read_bytes())
                print(f"  = {entry['title']} (image exists, backfilled host/images/guides/ mirror)")
            else:
                print(f"  = {entry['title']} (image exists, skipped)")
            continue

        try:
            png_bytes = generate_image(entry["title"], entry.get("summary", ""))
            dest.write_bytes(png_bytes)
            embedded_dest.write_bytes(png_bytes)
            print(f"  + {entry['title']} → {dest.name} (+ host/images/guides mirror)")
        except Exception as e:
            print(f"  ! {entry['title']}: {e}")

    print(f"\nDone. Images written to {IMAGES_DIR}")
    print(f"and mirrored to {EMBEDDED_IMAGES_DIR}.")
    print("No rebuild needed — served at /images/guides/<slug>.png from whichever")
    print("directory IMAGES_SERVE_ROOT resolves to (catalog/ if CATALOG_PATH is set, host/ if not).")
