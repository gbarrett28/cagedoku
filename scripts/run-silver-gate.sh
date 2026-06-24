#!/bin/bash
# Run all silver gate checks. Creates .silver-gate-ok if everything passes.
# Run this before merging to master; the pre-commit hook will consume the token.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB="$REPO_ROOT/web"
TOKEN="$REPO_ROOT/.silver-gate-ok"

fail() { echo ""; echo "SILVER GATE FAILED: $1"; exit 1; }

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

echo ""
echo "--- npm run build (required for playwright production tests) ---"
npm run build || fail "npm run build"

echo ""
echo "--- playwright test (production build, incl. pipeline tests) ---"
# app.spec.ts/offline.spec.ts gate their real-opencv.js pipeline tests behind
# PLAYWRIGHT_PIPELINE_TESTS=1 (cold WASM compile is slow in headless Chromium,
# ~20-40s) -- without this, the silver gate silently skips them every run.
PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test || fail "npx playwright test"

echo ""
echo "--- playwright test --config playwright.dev.config.ts ---"
PLAYWRIGHT_PIPELINE_TESTS=1 npx playwright test --config playwright.dev.config.ts || fail "npx playwright test (dev)"

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
