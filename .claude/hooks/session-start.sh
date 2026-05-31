#!/bin/bash
set -euo pipefail

# Only run in Claude Code cloud environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install web dependencies
cd "$CLAUDE_PROJECT_DIR/web"
npm install

# Sync @playwright/test to match the pre-installed Chromium revision.
# No-op when the revision already matches; self-heals when the environment
# is updated to provide a newer browser (see issue #134).
node scripts/sync-playwright-to-env.js
