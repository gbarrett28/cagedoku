#!/usr/bin/env python3
"""List R2 object keys with a given prefix.

Uses the Cloudflare REST API (wrangler v4 removed 'r2 object list').
Prints one key per line to stdout.

Usage: python3 scripts/_r2_list.py <bucket> <prefix>

Auth (in priority order):
  1. CLOUDFLARE_API_TOKEN env var  (CI / GitHub Actions)
  2. wrangler OAuth token from ~/.config/wrangler/... (local login)
"""

import json
import os
import subprocess
import sys
import urllib.request

ACCOUNT_ID = "b6c5bf0f26c81c4901c4434c6a3ca23f"


def get_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if token:
        return token
    # Fall back to extracting the OAuth token from the wrangler config.
    try:
        result = subprocess.run(
            ["npx", "wrangler", "whoami", "--json"],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(result.stdout)
        return data.get("oauth_token", "")
    except Exception:
        return ""


def list_objects(bucket: str, prefix: str) -> list[str]:
    token = get_token()
    if not token:
        print("ERROR: no Cloudflare API token found. Run 'wrangler login' or set CLOUDFLARE_API_TOKEN.", file=sys.stderr)
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

    objects = data.get("result", {}).get("objects", [])
    return [obj["key"] for obj in objects]


if __name__ == "__main__":
    import urllib.parse
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bucket> <prefix>", file=sys.stderr)
        sys.exit(1)
    for key in list_objects(sys.argv[1], sys.argv[2]):
        print(key)
