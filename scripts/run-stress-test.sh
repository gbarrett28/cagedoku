#!/usr/bin/env bash
# Stress-test the production image pipeline against a corpus of puzzle images.
#
# Usage:
#   bash scripts/run-stress-test.sh <puzzle-dir> [workers] [--copy-stalls <dest>]
#
#   puzzle-dir   Directory containing .jpg / .png puzzle images (absolute or
#                relative to the repo root).
#   workers      Parallel Playwright workers (default: 4). Each worker compiles
#                OpenCV.js WASM once (~60 s) and processes its share of images
#                sequentially. Memory: ~450 MB per worker.
#   --copy-stalls <dest>
#                After the run, copy any *.stall.json files written alongside
#                the puzzle images into <dest> (e.g. web/stall-fixtures).
#                Existing files with the same name are overwritten.
#                Omitting this flag leaves the stall files in the puzzle dir.
#
# Output:
#   <puzzle-dir>/eval_report.json — aggregate results + per-image records +
#   prioritised work queue sorted by (unsolved_cells, total_candidates).
#
# Examples:
#   bash scripts/run-stress-test.sh guardian 4
#   bash scripts/run-stress-test.sh guardian 4 --copy-stalls web/stall-fixtures
set -euo pipefail

PUZZLE_DIR=${1:?Usage: run-stress-test.sh <puzzle-dir> [workers] [--copy-stalls <dest>]}
WORKERS=4
COPY_STALLS_DEST=""
shift

# Optional positional workers count (must be a plain integer)
if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
  WORKERS="$1"
  shift
fi

# Named flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy-stalls)
      COPY_STALLS_DEST="${2:?--copy-stalls requires a destination directory}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PUZZLE_DIR_ABS="$(cd "${PUZZLE_DIR}" && pwd -P)"

IMAGE_COUNT=$(find "${PUZZLE_DIR_ABS}" -maxdepth 1 \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
PER_WORKER=$(( (IMAGE_COUNT + WORKERS - 1) / WORKERS ))

echo "Stress test: ${IMAGE_COUNT} images, ${WORKERS} workers (~${PER_WORKER} images/worker)"
echo "WASM cold-compile: ~60 s per worker (workers run in parallel)"
echo ""

cd "${REPO_ROOT}/web"
STRESS_PUZZLE_DIR="${PUZZLE_DIR_ABS}" \
  npx playwright test \
    --config playwright.stress.config.ts \
    --workers="${WORKERS}"

cd "${REPO_ROOT}"
node scripts/merge-stress-results.mjs "${PUZZLE_DIR_ABS}"

# Copy stall fixtures to the repo directory if --copy-stalls was given.
if [[ -n "${COPY_STALLS_DEST}" ]]; then
  DEST_ABS="$(mkdir -p "${COPY_STALLS_DEST}" && cd "${COPY_STALLS_DEST}" && pwd -P)"
  STALL_FILES=( "${PUZZLE_DIR_ABS}"/*.stall.json )
  if [[ -e "${STALL_FILES[0]}" ]]; then
    cp "${STALL_FILES[@]}" "${DEST_ABS}/"
    echo "Copied ${#STALL_FILES[@]} stall fixture(s) to ${DEST_ABS}/"
  else
    echo "No stall fixtures to copy."
  fi
fi
