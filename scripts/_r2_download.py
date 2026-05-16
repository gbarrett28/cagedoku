#!/usr/bin/env python3
"""Download R2 objects listed one key-per-line on stdin.

Usage: python3 scripts/_r2_download.py <bucket> <outdir> < keys.txt

Auth: CLOUDFLARE_API_TOKEN env var (CI) or wrangler OAuth config (local).
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "b6c5bf0f26c81c4901c4434c6a3ca23f")

_WRANGLER_CONFIG_CANDIDATES = [
    Path(os.environ.get("APPDATA", ""), "xdg.config", ".wrangler", "config", "default.toml"),
    Path.home() / ".config" / ".wrangler" / "config" / "default.toml",
    Path.home() / ".wrangler" / "config" / "default.toml",
]


def _get_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token
    for path in _WRANGLER_CONFIG_CANDIDATES:
        if path.exists():
            m = re.search(r'^oauth_token\s*=\s*"([^"]+)"',
                          path.read_text(encoding="utf-8"), re.MULTILINE)
            if m:
                return m.group(1)
    return ""


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bucket> <outdir>", file=sys.stderr)
        sys.exit(1)

    bucket, outdir = sys.argv[1], Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    token = _get_token()
    if not token:
        print("ERROR: no Cloudflare token. Run 'npx wrangler login' or set CLOUDFLARE_API_TOKEN.",
              file=sys.stderr)
        sys.exit(1)

    keys = [line.strip() for line in sys.stdin if line.strip()]
    for i, key in enumerate(keys):
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
            f"/r2/buckets/{bucket}/objects/{urllib.parse.quote(key, safe='')}"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        # Use index-based name to avoid Windows-illegal colon characters in timestamps.
        fname = outdir / f"sample_{i:03d}.json"
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                fname.write_bytes(resp.read())
            print(f"Downloaded {fname.name}  ({key})")
        except urllib.error.HTTPError as e:
            print(f"ERROR downloading {key}: {e.code} {e.read().decode()}", file=sys.stderr)
            sys.exit(1)


main()
