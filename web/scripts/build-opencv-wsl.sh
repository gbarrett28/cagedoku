#!/usr/bin/env bash
# build-opencv-wsl.sh — build a minimal opencv.js (core + imgproc, function whitelist) in WSL.
#
# Run from WSL terminal (not PowerShell):
#   bash /mnt/c/Users/geoff/PycharmProjects/killer_sudoku/web/scripts/build-opencv-wsl.sh
#
# What it does:
#   1. Installs cmake, ninja, python3 if absent
#   2. Clones emsdk 3.1.61 (known-good with OpenCV 4.10.0) into ~/opencv-js-build/
#   3. Clones OpenCV 4.10.0 (shallow) into ~/opencv-js-build/
#   4. Builds opencv.js with:
#      - Only core+imgproc modules compiled  (reduces C++ compilation scope)
#      - Function whitelist from opencv-whitelist.json  (reduces WASM entry points)
#      - Emscripten DCE removes all unreachable code     (reduces binary size)
#   5. Copies result to web/public/opencv.js
#
# Why the whitelist matters:
#   Without it, gen2.py emits JS wrappers for every function in core+imgproc
#   (~hundreds of entry points). With only the ~20 functions we actually call as
#   roots, Emscripten's dead-code eliminator can strip Fourier, Hough, histograms,
#   morphology, optical flow, and everything else we don't use.
#   Expected output: ~1-2 MB (vs ~4 MB without whitelist).
#
# After a successful build:
#   git add web/public/opencv.js
#   git commit -m "feat: minimal opencv.js with function whitelist"
#   git push

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$(realpath "$SCRIPT_DIR/../public")"
WHITELIST="$SCRIPT_DIR/opencv-whitelist.json"
BUILD_BASE="$HOME/opencv-js-build"
LOG="$BUILD_BASE/build.log"
EMSDK_VERSION="3.1.61"
OPENCV_TAG="4.10.0"

mkdir -p "$BUILD_BASE"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date) — opencv.js minimal build (core+imgproc + whitelist) ==="
echo "    whitelist  → $WHITELIST"
echo "    output     → $OUTPUT_DIR/opencv.js"

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

# ── Check whether build_js.py supports --white_list ─────────────────────────
echo "--- checking build_js.py options ---"
cd "$BUILD_BASE/opencv"
if python3 platforms/js/build_js.py --help 2>&1 | grep -q "white.list"; then
  WHITELIST_ARG="--white_list $WHITELIST"
  echo "    whitelist flag supported — using $WHITELIST"
else
  # Older versions: pass via CMake binding generator flags
  WHITELIST_ARG="--cmake_option=-DOPENCV_JS_BINDINGS_GENERATOR_FLAGS=--jinja2"
  echo "    WARNING: --white_list not found in help; trying CMake flag path"
  echo "    Check ~/opencv-js-build/build.log if the output is still large"
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "--- building (30-60 min first run) ---"
# Remove previous build output so CMake reconfigures cleanly with new flags
rm -rf "$BUILD_BASE/build"

# shellcheck disable=SC2086
python3 platforms/js/build_js.py "$BUILD_BASE/build" \
  --build_wasm \
  $WHITELIST_ARG \
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
echo "--- output ---"
ls -lh "$OUTPUT"
cp "$OUTPUT" "$OUTPUT_DIR/opencv.js"
ls -lh "$OUTPUT_DIR/opencv.js"

echo ""
echo "=== $(date) — done ==="
echo ""
echo "If the file is still ~4 MB, the whitelist format may need adjusting."
echo "Check: python3 ~/opencv-js-build/opencv/platforms/js/build_js.py --help"
echo "Also check: python3 ~/opencv-js-build/opencv/platforms/js/gen2.py --help"
