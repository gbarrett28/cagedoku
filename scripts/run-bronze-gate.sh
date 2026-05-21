#!/bin/bash
# Run all bronze gate checks. Creates .bronze-gate-ok if everything passes.
# The pre-commit hook on feature branches will consume the token.
#
# Usage: bash scripts/run-bronze-gate.sh

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB="$REPO_ROOT/web"
TOKEN="$REPO_ROOT/.bronze-gate-ok"

fail() { echo ""; echo "BRONZE GATE FAILED: $1"; exit 1; }

echo ""
echo "=== Bronze gate: code checks ==="
echo ""

cd "$WEB"

echo "--- tsc --noEmit ---"
npx tsc --noEmit || fail "tsc --noEmit"

echo ""
echo "--- tsc -p tsconfig.node.json --noEmit ---"
npx tsc -p tsconfig.node.json --noEmit || fail "tsc -p tsconfig.node.json --noEmit"

echo ""
echo "--- npm test ---"
npm test || fail "npm test"

echo ""
echo "=== Bronze gate: code checks passed ==="
echo ""
echo "  Also verify:"
echo "    □ Every spec in docs/specs/ still accurately describes the design"
echo "    □ Every plan in docs/plans/ has completed steps ticked"
echo ""

touch "$TOKEN"
echo "Bronze gate passed. Token created — run 'git commit' now."
echo ""
