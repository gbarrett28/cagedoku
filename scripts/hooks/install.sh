#!/bin/bash
# Install project git hooks from scripts/hooks/ into .git/hooks/.
# Run once after cloning: bash scripts/hooks/install.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  [[ "$name" == "install.sh" ]] && continue
  cp "$hook" "$HOOKS_DST/$name"
  chmod +x "$HOOKS_DST/$name"
  echo "Installed: .git/hooks/$name"
done

echo "Done."
