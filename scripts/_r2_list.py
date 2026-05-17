#!/usr/bin/env python3
"""List R2 object keys with a given prefix, one key per line, to stdout.

Usage: python3 scripts/_r2_list.py <bucket> <prefix>

Auth: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY env vars.
"""

import os
import sys
import boto3
from botocore.exceptions import ClientError

ENDPOINT_URL = "https://b6c5bf0f26c81c4901c4434c6a3ca23f.r2.cloudflarestorage.com"


def make_client() -> boto3.client:
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <bucket> <prefix>", file=sys.stderr)
        sys.exit(1)

    bucket, prefix = sys.argv[1], sys.argv[2]
    s3 = make_client()
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                print(obj["Key"])
    except ClientError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


main()
