#!/usr/bin/env bash
# Delete R2 objects for files in the given directory, then add ✅ reactions
# to their corresponding GitHub Issue #1 comments.
#
# Run this AFTER verifying the retrained model is accurate.
#
# Usage: bash scripts/mark_processed.sh <dir_of_downloaded_files>

set -euo pipefail

BUCKET="cagedoku-training"
REPO="gbarrett28/cagedoku"
ISSUE=1
DIR="${1:?Usage: $0 <dir_of_downloaded_files>}"

echo "Deleting processed R2 objects..."
for jsonfile in "$DIR"/*.json; do
  [ -f "$jsonfile" ] || { echo "No .json files found in $DIR"; exit 1; }
  filename=$(basename "$jsonfile")
  key="training/$filename"
  echo "  deleting $key"
  wrangler r2 object delete "$BUCKET" "$key"
done

echo ""
echo "Reacting to processed GitHub Issue comments..."
gh api "/repos/$REPO/issues/$ISSUE/comments" --jq '.[].id' | \
while IFS= read -r comment_id; do
  body=$(gh api "/repos/$REPO/issues/comments/$comment_id" --jq '.body // ""')
  if echo "$body" | grep -q 'training/'; then
    echo "  ✅ comment $comment_id"
    gh api "/repos/$REPO/issues/comments/$comment_id/reactions" \
      -f content='+1' > /dev/null
  fi
done

echo ""
echo "Done. R2 objects deleted and comments reacted."
