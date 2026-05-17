#!/usr/bin/env python3
"""Delete R2 objects listed one key-per-line on stdin.

Usage: python3 scripts/_r2_delete.py <bucket> < keys.txt

Auth: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY env vars.
"""

import os
import sys
import boto3
from botocore.exceptions import ClientError

ENDPOINT_URL = "https://b6c5bf0f26c81c4901c4434c6a3ca23f.r2.cloudflarestorage.com"


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <bucket>", file=sys.stderr)
        sys.exit(1)

    bucket = sys.argv[1]
    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    keys = [line.strip() for line in sys.stdin if line.strip()]
    for key in keys:
        try:
            s3.delete_object(Bucket=bucket, Key=key)
            print(f"Deleted {key}")
        except ClientError as e:
            print(f"ERROR deleting {key}: {e}", file=sys.stderr)
            sys.exit(1)


main()
