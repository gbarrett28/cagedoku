#!/bin/bash
set -euo pipefail

# Only run in the Claude Code cloud environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install npm dependencies for the web package
npm --prefix web install

# Sync @playwright/test to the revision pre-installed at /opt/pw-browsers.
# No-op if the revision already matches; self-heals when the environment
# updates its browser. See docs/architecture.md § "E2E Test Environment".
node web/scripts/sync-playwright-to-env.js
