#!/bin/bash
# Run this AFTER completing all silver gate checks to create the one-time
# token that allows the next non-interactive push to master to proceed.
#
# Usage (agent):
#   1. Run all silver gate code checks and doc-hygiene steps (see CLAUDE.md)
#   2. bash scripts/hooks/confirm-silver-gate.sh
#   3. git push origin master

REPO_ROOT="$(git rev-parse --show-toplevel)"
TOKEN="$REPO_ROOT/.silver-gate-ok"

echo ""
echo "Silver gate confirmation — have you completed ALL of the following?"
echo ""
echo "  Code checks (from web/):"
echo "    □ tsc --noEmit"
echo "    □ npm test -- --reporter=verbose"
echo "    □ npx playwright test"
echo "    □ npx playwright test --config playwright.dev.config.ts"
echo ""
echo "  Doc hygiene:"
echo "    □ Every spec in docs/specs/ incorporated into live docs, DELETED"
echo "    □ Every spec in docs/superpowers/specs/ incorporated, DELETED"
echo "    □ Every plan in docs/plans/ fully completed, DELETED"
echo "    □ Every plan in docs/superpowers/plans/ fully completed, DELETED"
echo "    □ Every plan in ~/.claude/plans/ fully completed, DELETED"
echo "    □ Live docs (architecture.md, ui.md, …) updated with actual details"
echo ""

touch "$TOKEN"
echo "Token created. Run 'git push origin master' within the next 30 minutes."
echo ""
