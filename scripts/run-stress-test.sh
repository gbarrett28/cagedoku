#!/usr/bin/env bash
# Stress-test the production image pipeline against a corpus of puzzle images.
#
# Usage:
#   bash scripts/run-stress-test.sh <puzzle-dir> [workers]
#
#   puzzle-dir   Directory containing .jpg / .png puzzle images (absolute or
#                relative to the repo root).
#   workers      Parallel Playwright workers (default: 4). Each worker compiles
#                OpenCV.js WASM once (~60 s) and processes its share of images
#                sequentially. Memory: ~450 MB per worker.
#
# Output:
#   <puzzle-dir>/eval_report.json — aggregate results + per-image records +
#   prioritised work queue sorted by (unsolved_cells, total_candidates).
#
# Examples:
#   bash scripts/run-stress-test.sh classic_guardian 4
#   bash scripts/run-stress-test.sh classic_guardian/diabolical 2
set -euo pipefail

PUZZLE_DIR=${1:?Usage: run-stress-test.sh <puzzle-dir> [workers]}
WORKERS=${2:-4}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PUZZLE_DIR_ABS="$(cd "${PUZZLE_DIR}" && pwd -P)"

IMAGE_COUNT=$(find "${PUZZLE_DIR_ABS}" -maxdepth 1 \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
PER_WORKER=$(( (IMAGE_COUNT + WORKERS - 1) / WORKERS ))

echo "Stress test: ${IMAGE_COUNT} images, ${WORKERS} workers (~${PER_WORKER} images/worker)"
echo "WASM cold-compile: ~60 s per worker (workers run in parallel)"
echo ""

cd "${REPO_ROOT}/web"
STRESS_PUZZLE_DIR="${PUZZLE_DIR_ABS}" \
PLAYWRIGHT_PIPELINE_TESTS=1 \
  npx playwright test \
    --config playwright.config.ts \
    stress.spec.ts \
    --workers="${WORKERS}"

cd "${REPO_ROOT}"
node scripts/merge-stress-results.mjs "${PUZZLE_DIR_ABS}"
