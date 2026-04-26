#!/usr/bin/env bash
# build-opencv-wsl.sh — build a minimal opencv.js (core + imgproc only) inside WSL.
#
# Usage (from WSL):
#   bash /mnt/c/Users/geoff/PycharmProjects/killer_sudoku/web/scripts/build-opencv-wsl.sh
#
# Output: web/public/opencv.js (~2-3 MB, replaces the standard 10 MB build)
#
# Why core+imgproc only?  All operations used by the image pipeline live in
# these two modules: findContours, approxPolyDP, getPerspectiveTransform,
# warpPerspective, adaptiveThreshold, matchTemplate, boundingRect, contourArea,
# cvtColor, GaussianBlur, resize.
#
# Expected build time: 60-90 minutes on a modern CPU.

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────
PROJECT_DIR="/mnt/c/Users/geoff/PycharmProjects/killer_sudoku/web/public"
BUILD_BASE="$HOME/opencv-js-build"
LOG="$BUILD_BASE/build.log"
EMSDK_VERSION="3.1.61"          # known-good with OpenCV 4.10.0
OPENCV_TAG="4.10.0"

mkdir -p "$BUILD_BASE"
exec > >(tee -a "$LOG") 2>&1     # all output to stdout AND log file
echo "=== $(date) — starting opencv.js minimal build ==="

# ── System deps ─────────────────────────────────────────────────────────────
echo "--- installing system deps ---"
apt-get update -qq
apt-get install -y cmake build-essential ninja-build python3-pip

# ── Emscripten SDK ──────────────────────────────────────────────────────────
echo "--- setting up emsdk $EMSDK_VERSION ---"
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
echo "--- cloning opencv $OPENCV_TAG ---"
if [ ! -d "$BUILD_BASE/opencv/.git" ]; then
    git clone --depth 1 --branch "$OPENCV_TAG" \
        https://github.com/opencv/opencv.git "$BUILD_BASE/opencv"
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "--- building opencv.js (core+imgproc) ---"
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
    --cmake_option="-DWITH_WEBP=OFF"

# ── Copy output ───────────────────────────────────────────────────────────────
OUTPUT="$BUILD_BASE/build/bin/opencv.js"
echo "--- copying output to web/public ---"
ls -lh "$OUTPUT"
cp "$OUTPUT" "$PROJECT_DIR/opencv.js"
ls -lh "$PROJECT_DIR/opencv.js"

echo "=== $(date) — done. opencv.js written to $PROJECT_DIR/opencv.js ==="
