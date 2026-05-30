#!/bin/bash
# Run all silver gate checks. Creates .silver-gate-ok if everything passes.
# Run this before merging to master; the pre-commit hook will consume the token.
#
# Usage: bash scripts/run-silver-gate.sh [--skip-playwright]
#
# Playwright tests are skipped automatically when no browser binary is found in
# the Playwright cache (e.g. in the Claude Code cloud environment). Pass
# --skip-playwright explicitly to force-skip regardless.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB="$REPO_ROOT/web"
TOKEN="$REPO_ROOT/.silver-gate-ok"

fail() { echo ""; echo "SILVER GATE FAILED: $1"; exit 1; }

# Detect whether Playwright browser binaries are available.
# The cache location can be overridden by PLAYWRIGHT_BROWSERS_PATH; otherwise
# Playwright defaults to ~/.cache/ms-playwright.
_pw_cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
_run_playwright=true
for _arg in "$@"; do
  [ "$_arg" = "--skip-playwright" ] && _run_playwright=false
done
if [ "$_run_playwright" = "true" ] && \
   { [ ! -d "$_pw_cache" ] || [ -z "$(ls -A "$_pw_cache" 2>/dev/null)" ]; }; then
  _run_playwright=false
  echo "(Playwright browser cache not found at $_pw_cache — skipping browser tests."
  echo " Install browsers with 'npx playwright install' or pass --skip-playwright to suppress.)"
fi

echo ""
echo "=== Silver gate: code checks ==="
echo ""

cd "$WEB"

echo "--- tsc --noEmit ---"
npx tsc --noEmit || fail "tsc --noEmit"

echo ""
echo "--- tsc -p tsconfig.node.json --noEmit ---"
npx tsc -p tsconfig.node.json --noEmit || fail "tsc -p tsconfig.node.json --noEmit"

echo ""
echo "--- npm test --reporter=verbose ---"
npm test -- --reporter=verbose || fail "npm test"

if [ "$_run_playwright" = "true" ]; then
  echo ""
  echo "--- playwright test (production build) ---"
  npx playwright test || fail "npx playwright test"

  echo ""
  echo "--- playwright test --config playwright.dev.config.ts ---"
  npx playwright test --config playwright.dev.config.ts || fail "npx playwright test (dev)"
else
  echo ""
  echo "--- playwright test (SKIPPED — no browser available) ---"
fi

echo ""
echo "=== Silver gate: code checks passed ==="
echo ""
echo "=== Silver gate: doc hygiene (manual) ==="
echo ""
echo "  Verify each item before continuing:"
echo ""
echo "  Specs — incorporate into live docs then DELETE:"
echo "    docs/specs/"
echo "    docs/superpowers/specs/"
echo ""
echo "  Plans — all steps ticked then DELETE:"
echo "    docs/plans/"
echo "    docs/superpowers/plans/"
echo "    ~/.claude/plans/"
echo ""
echo "  Live docs reflect what was actually built:"
echo "    docs/architecture.md  docs/ui.md  docs/image-pipeline.md  …"
echo ""

if [ -t 1 ]; then
  read -rp "Doc hygiene complete? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    fail "doc hygiene not confirmed"
  fi
else
  echo "(Non-interactive — skipping doc-hygiene prompt. Confirm manually.)"
fi

touch "$TOKEN"
echo ""
echo "Silver gate passed. Token created — run 'git merge / git commit' now."
echo ""
