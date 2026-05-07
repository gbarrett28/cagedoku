#!/usr/bin/env bash
# Download all pending training uploads from R2.
#
# Requires wrangler login (local) or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (CI).
#
# Usage: bash scripts/collect_training.sh <output_dir>

set -euo pipefail

BUCKET="cagedoku-training"
OUTPUT_DIR="${1:?Usage: $0 <output_dir>}"

mkdir -p "$OUTPUT_DIR"

echo "Listing pending uploads in R2..."
KEYS=$(python3 scripts/_r2_list.py "$BUCKET" training/)

if [ -z "$KEYS" ]; then
  echo "No pending uploads found."
  exit 0
fi

COUNT=$(echo "$KEYS" | wc -l | tr -d ' ')
echo "Found $COUNT upload(s)."

echo "$KEYS" | while IFS= read -r key; do
  filename=$(basename "$key")
  outfile="$OUTPUT_DIR/$filename"
  echo "  $key → $outfile"
  npx wrangler r2 object get "$BUCKET/$key" > "$outfile"
done

echo ""
echo "Downloaded $COUNT file(s) to $OUTPUT_DIR"
echo ""
echo "Next: retrain"
echo "  python web/train_recogniser.py --browser-weight 1000 --svm-c 100 \\"
echo "    web/browser_train.json $OUTPUT_DIR/*.json"
echo ""
echo "Then mark as processed:"
echo "  bash scripts/mark_processed.sh $OUTPUT_DIR"
