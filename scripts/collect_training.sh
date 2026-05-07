#!/usr/bin/env bash
# Download all pending training uploads from R2.
# Prints the path of each downloaded file to stdout.
#
# Usage: bash scripts/collect_training.sh <output_dir>
# Example: bash scripts/collect_training.sh /tmp/training

set -euo pipefail

BUCKET="cagedoku-training"
OUTPUT_DIR="${1:?Usage: $0 <output_dir>}"

mkdir -p "$OUTPUT_DIR"

echo "Listing pending uploads in R2..."
KEYS=$(wrangler r2 object list "$BUCKET" --prefix training/ --json 2>/dev/null \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for obj in data.get('objects', []):
    print(obj['key'])
")

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
  wrangler r2 object get "$BUCKET" "$key" --file "$outfile"
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
