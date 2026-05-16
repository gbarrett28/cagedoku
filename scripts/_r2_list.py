#!/usr/bin/env python3
"""List R2 object keys with a given prefix.

Uses the Cloudflare REST API (wrangler v4 removed 'r2 object list').
Prints one key per line to stdout.

Usage: python3 scripts/_r2_list.py <bucket> <prefix>

Auth (in priority order):
  1. CLOUDFLARE_API_TOKEN env var  (CI / GitHub Actions)
  2. wrangler OAuth token read from its config TOML  (local login)
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNT_ID = "b6c5bf0f26c81c4901c4434c6a3ca23f"

# Candidate wrangler config paths (checked in order).
_WRANGLER_CONFIG_CANDIDATES = [
    Path(os.environ.get("APPDATA", ""), "xdg.config", ".wrangler", "config", "default.toml"),
    Path.home() / ".config" / ".wrangler" / "config" / "default.toml",
    Path.home() / ".wrangler" / "config" / "default.toml",
]


def _read_wrangler_oauth_token() -> str:
    for path in _WRANGLER_CONFIG_CANDIDATES:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            m = re.search(r'^oauth_token\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if m:
                return m.group(1)
    return ""


def get_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token
    return _read_wrangler_oauth_token()


def list_objects(bucket: str, prefix: str) -> list[str]:
    token = get_token()
    if not token:
        print(
            "ERROR: no Cloudflare token found. "
            "Run 'npx wrangler login' or set CLOUDFLARE_API_TOKEN.",
            file=sys.stderr,
        )
        sys.exit(1)

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
        f"/r2/buckets/{bucket}/objects?prefix={urllib.parse.quote(prefix)}"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"ERROR: Cloudflare API {e.code}: {body}", file=sys.stderr)
        sys.exit(1)

    result = data.get("result", [])
    if isinstance(result, list):
        return [obj["key"] for obj in result]
    return [obj["key"] for obj in result.get("objects", [])]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bucket> <prefix>", file=sys.stderr)
        sys.exit(1)
    for key in list_objects(sys.argv[1], sys.argv[2]):
        print(key)
