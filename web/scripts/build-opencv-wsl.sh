#!/usr/bin/env bash
# build-opencv-wsl.sh — build a minimal opencv.js (core + imgproc only) in WSL.
#
# Run from WSL terminal (not PowerShell):
#   bash /mnt/c/Users/geoff/PycharmProjects/killer_sudoku/web/scripts/build-opencv-wsl.sh
#
# What it does:
#   1. Installs cmake, ninja, python3 if absent
#   2. Clones emsdk 3.1.61 (known-good with OpenCV 4.10.0) into ~/opencv-js-build/
#   3. Clones OpenCV 4.10.0 (shallow) into ~/opencv-js-build/
#   4. Builds opencv.js with only core+imgproc — ~1.5-2 MB vs ~4 MB standard build
#   5. Copies result to web/public/opencv.js
#
# Subsequent runs reuse the existing emsdk and source checkouts (incremental).
# Expected time: 30-60 min first run, a few minutes if re-running after a change.
#
# After a successful build, commit web/public/opencv.js to git so CI uses it
# directly (the workflow already skips the download when the file is present).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$(realpath "$SCRIPT_DIR/../public")"
BUILD_BASE="$HOME/opencv-js-build"
LOG="$BUILD_BASE/build.log"
EMSDK_VERSION="3.1.61"
OPENCV_TAG="4.10.0"

mkdir -p "$BUILD_BASE"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date) — opencv.js minimal build (core+imgproc) ==="
echo "    output → $OUTPUT_DIR/opencv.js"

# ── System deps ──────────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi

echo "--- checking system deps ---"
MISSING=""
command -v cmake  >/dev/null 2>&1 || MISSING="$MISSING cmake"
command -v ninja  >/dev/null 2>&1 || MISSING="$MISSING ninja-build"
command -v python3 >/dev/null 2>&1 || MISSING="$MISSING python3"
if [ -n "$MISSING" ]; then
  echo "Installing:$MISSING"
  $SUDO apt-get update -qq
  # shellcheck disable=SC2086
  $SUDO apt-get install -y $MISSING build-essential
fi

# ── Emscripten SDK ───────────────────────────────────────────────────────────
echo "--- emsdk $EMSDK_VERSION ---"
if [ ! -d "$BUILD_BASE/emsdk/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$BUILD_BASE/emsdk"
fi
cd "$BUILD_BASE/emsdk"
./emsdk install  "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source ./emsdk_env.sh
echo "emcc: $(emcc --version | head -1)"

# ── OpenCV source ────────────────────────────────────────────────────────────
echo "--- opencv $OPENCV_TAG ---"
if [ ! -d "$BUILD_BASE/opencv/.git" ]; then
  git clone --depth 1 --branch "$OPENCV_TAG" \
    https://github.com/opencv/opencv.git "$BUILD_BASE/opencv"
fi

# ── Build ────────────────────────────────────────────────────────────────────
# Modules: core (Mat, arithmetic, geometry), imgproc (contours, threshold,
#           perspective, template matching), js (JS/WASM bindings).
# Image codecs (JPEG, PNG, TIFF, WEBP) excluded — the app receives raw
# ImageData from the browser, no codec decoding required in WASM.
echo "--- building (this takes 30-60 min on first run) ---"
cd "$BUILD_BASE/opencv"
python3 platforms/js/build_js.py "$BUILD_BASE/build" \
  --build_wasm \
  --cmake_option="-DBUILD_LIST=core,imgproc,js" \
  --cmake_option="-DCMAKE_BUILD_TYPE=Release" \
  --cmake_option="-DBUILD_TESTS=OFF" \
  --cmake_option="-DBUILD_PERF_TESTS=OFF" \
  --cmake_option="-DBUILD_EXAMPLES=OFF" \
  --cmake_option="-DWITH_JPEG=OFF" \
  --cmake_option="-DWITH_PNG=OFF" \
  --cmake_option="-DWITH_TIFF=OFF" \
  --cmake_option="-DWITH_WEBP=OFF" \
  --cmake_option="-DWITH_LAPACK=OFF" \
  --cmake_option="-DWITH_EIGEN=OFF"

# ── Copy output ──────────────────────────────────────────────────────────────
OUTPUT="$BUILD_BASE/build/bin/opencv.js"
echo "--- copying output ---"
ls -lh "$OUTPUT"
cp "$OUTPUT" "$OUTPUT_DIR/opencv.js"
ls -lh "$OUTPUT_DIR/opencv.js"

echo ""
echo "=== $(date) — done ==="
echo ""
echo "Next steps:"
echo "  1. Test: cd /mnt/c/.../killer_sudoku/web && npm run dev"
echo "  2. Commit: git add web/public/opencv.js && git commit -m 'feat: minimal opencv.js (core+imgproc)'"
echo "  3. Push: git push  — CI will use the committed file, skipping the download step"
