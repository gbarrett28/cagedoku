#!/usr/bin/env python3
"""Download R2 objects listed one key-per-line on stdin.

Usage: python3 scripts/_r2_download.py <bucket> <outdir> < keys.txt

Auth: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY env vars.
"""

import os
import sys
from pathlib import Path
import boto3
from botocore.exceptions import ClientError

ENDPOINT_URL = "https://b6c5bf0f26c81c4901c4434c6a3ca23f.r2.cloudflarestorage.com"


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bucket> <outdir>", file=sys.stderr)
        sys.exit(1)

    bucket, outdir = sys.argv[1], Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    keys = [line.strip() for line in sys.stdin if line.strip()]
    for i, key in enumerate(keys):
        # Use index-based filename to avoid colons from timestamps on Windows.
        fname = outdir / f"sample_{i:03d}.json"
        try:
            s3.download_file(bucket, key, str(fname))
            print(f"Downloaded {fname.name}  ({key})")
        except ClientError as e:
            print(f"ERROR downloading {key}: {e}", file=sys.stderr)
            sys.exit(1)


main()
