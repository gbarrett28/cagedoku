#!/usr/bin/env bash
# Downloads the standard single-file OpenCV.js build into web/public/.
# Run from the web/ directory: bash scripts/download-opencv.sh
#
# The single-file build (~10 MB) embeds the WASM binary — no separate
# opencv.wasm is required.  Replace with a custom minimal build later
# (core + imgproc only, ~2–3 MB) once the app is verified working.
#
# Usage: bash scripts/download-opencv.sh [version]
# Default version: 4.10.0

set -euo pipefail

VERSION="${1:-4.10.0}"
DEST="$(dirname "$0")/../public/opencv.js"
URL="https://docs.opencv.org/${VERSION}/opencv.js"

echo "Downloading OpenCV.js ${VERSION} from ${URL}..."
curl -L --retry 3 --retry-delay 2 -o "${DEST}" "${URL}"
echo "Saved to ${DEST} ($(wc -c < "${DEST}") bytes)"
