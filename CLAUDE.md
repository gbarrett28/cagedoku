# Agent Behaviour

## Methodology

This project uses [`shipwright`](https://github.com/gbarrett28/shipwright)
for engineering methodology — skill-invocation policy, quality gates,
commit/issue/doc hygiene, tool preferences, and language guidelines. It's
registered and enabled for this repo via `.claude/settings.json`. Start
with `shipwright:using-shipwright`, which carries the required-invocation
table for both `superpowers` and `shipwright` skills, the check-before-
you-build discipline, token-efficiency and plan-sprint-size guidance, and
the git-worktree caveat.

Concrete tool bindings for shipwright's generic skills, in this repo:

| Role (shipwright skill) | This repo's concrete tool |
|---|---|
| Code navigation/analysis (`tool-preferences`) | `serena` — see "Agent Protocol: Tool Use" below |
| TypeScript diagnostics (`tool-preferences`) | `typescript-lsp` plugin (`typescript-language-server` via npx); complements serena for cross-file type navigation |
| PR review (`tool-preferences`) | `pr-review-toolkit` — `code-reviewer`, `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`, `comment-analyzer`, `code-simplifier`; also `coderabbit:code-reviewer` |
| Library documentation (`tool-preferences`) | `context7` (`mcp__plugin_context7_context7__*`) — e.g. Vite config, Playwright APIs, TypeScript compiler options, OpenCV.js |
| Issue tracker (`issue-hygiene`) | GitHub Issues, via `gh` CLI / `github` MCP plugin |
| Gate scripts (`quality-gates`) | `scripts/run-bronze-gate.sh`, `scripts/run-silver-gate.sh` — see "Quality Gates" below |
| Python lint config (`python-guidelines`) | `[tool.ruff]` / `[tool.mypy]` in `pyproject.toml` |
| Visual-companion alternative (`using-shipwright`) | Playwright MCP — see "UI Visual Verification" below |

## Document Review Requests

Whenever a workflow step asks the user to review a committed document (a spec,
plan, or other doc produced via `superpowers:brainstorming` /
`superpowers:writing-plans` etc.), first `git push` the branch, then give the
user the GitHub URL to the file on that branch
(`https://github.com/gbarrett28/cagedoku/blob/<branch>/<path>`), not just the
local path.

## UI Visual Verification

The Playwright MCP plugin is available for visual testing of layout and CSS changes.
Start the dev server first (`cd web && npm run dev -- --port 5175`), then use
`mcp__plugin_playwright_playwright__browser_*` tools to navigate, resize the viewport,
evaluate JS (measure element dimensions, check overflow), and take screenshots.
Use it when working on responsive layout, canvas sizing, or any visual rendering change.

## Frontend Design Scope

**Ergonomics only — do not propose aesthetic changes.**
Layout, spacing, sizing, responsiveness, and interaction flow are in scope.
Colours, typography, visual polish, and animations are out of scope unless
the user explicitly requests them. Do not activate or follow the `frontend-design`
plugin's aesthetic direction on this project.

---

# Project Overview

## What This Project Is

A browser-based coaching companion for killer and classic sudoku. Reads newspaper puzzle images
in-browser (OpenCV.js WASM), locates the grid, detects cage borders, reads cage totals,
and guides the user through solving with candidates, logical hints, and rule-based
deductions. All processing runs client-side.

## Codebase Map

| Subsystem | Location | Notes |
|---|---|---|
| Frontend app | `web/src/main.ts` | UI, canvas rendering, event handling |
| Image pipeline | `web/src/image/` | OCR: grid location, border detection, digit recognition |
| Coaching engine | `web/src/engine/` | Board state, rules, backtracker, linear system |
| Session / actions | `web/src/session/` | State management, puzzle actions, hint delivery |
| Solver | `web/src/solver/` | Cage equations, PuzzleSpec |
| E2E tests | `web/e2e/` | Playwright tests |
| Unit tests | `web/src/**/*.test.ts` | Vitest tests co-located with source |
| Digit recogniser training | `killer_sudoku/training/` | Offline Python scripts only |
| Retraining helper | `web/train_recogniser.py` | Converts browser-exported samples to model |

## Key Reference Documents

- **`docs/architecture.md`** § *Rule Contract* — read before touching any rule or coaching engine component (`web/src/engine/rules/`)
- **`docs/architecture.md`** — read before working on the image pipeline, session lifecycle, or engine
- **`docs/ui.md`** — read before working on the frontend (`web/src/main.ts`)

---

# Coordinate Conventions

**All 2-D arrays representing the 9×9 grid MUST be row-major.**

```
grid[row][col]     ✓   first index = row (0–8, top-to-bottom)
grid[col][row]     ✗   never
```

**Function parameters that accept cell coordinates MUST be row-first:**

```ts
function foo(row: number, col: number)   ✓
function foo(col: number, row: number)   ✗  never
```

**Cell tuples** are always `[row, col]` (a `Cell = [number, number]` where index 0 is the row).

**Human-readable label** — always use `cellLabel([row, col])` from
`web/src/engine/rules/_labels.ts`. Never inline `r${r+1}c${c+1}`.

**User-facing messages** always use 1-based indexing. Internal code is 0-based; never
expose 0-based indices in UI text, error messages, or hint explanations.

**Exception — border arrays:** `borderX[col][rowGap]` and `borderY[colGap][row]` are
intentionally col-first because their two dimensions represent orthogonal geometric
quantities (a column index paired with a row-gap index, or vice versa). Do not change
these without updating the comment in `web/src/image/validation.ts` that explains why.

---

# Agent Protocol: Tool Use

**CRITICAL RULE:** For ALL code analysis, retrieval, and modification tasks, you **MUST** use the `serena` MCP tools. DO NOT
use generic filesystem tools (like `Read`, `Glob`) unless the `serena` tools are
insufficient for a non-code file (e.g., a `.yaml` or `.md`). In particular, always use
serena to read and modify TypeScript files. If the serena tools fail on `.ts`, stop
immediately and ask for the MCP server to be restarted.

**Serena is a Claude Code plugin** (`serena@claude-plugins-official`). Before using any serena tool,
load it via ToolSearch using the keyword `serena`:
```
ToolSearch query: "serena get_symbols"
```
If serena tools do not appear in ToolSearch, the plugin is not running — ask the user to check
that `serena@claude-plugins-official` is enabled and restart the session before proceeding.
Do NOT fall back to filesystem tools while serena is merely unavailable.

**Debug screenshots:** When the user refers to a `.png` by name only (e.g. "look in
Untitled.png"), it is at the project root. Read it with the Read tool. Never commit it.

## Core Workflow

1. **Start with overview:** Use serena's `get_symbols_overview` to understand file structure
2. **Find symbols:** Use serena's `find_symbol` to locate specific classes, functions, methods
3. **Understand relationships:** Use serena's `find_referencing_symbols` to see where code is used
4. **Search patterns:** Use serena's `search_for_pattern` when you don't know exact symbol names
5. **Edit strategically:** Use serena's `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`
6. **Always:** Check for existing code structure using serena tools before writing anything new

---

# Quality Gates: Concrete Commands

Gate policy (the bronze/silver contract, TDD-tests-in-bronze rule, doc-hygiene
split, branch workflow) is defined generically by `shipwright:quality-gates`.
This project's concrete implementation of that contract:

## Bronze Gate

Run the gate script from the repo root:

```bash
bash scripts/run-bronze-gate.sh
```

This runs `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test`.
If all pass it creates a one-time `.bronze-gate-ok` token that the pre-commit
hook (`scripts/hooks/pre-commit`) consumes when you commit — it blocks the
commit if no token is present. The hook also runs `tsc --noEmit` and
`tsc -p tsconfig.node.json --noEmit` automatically; `npm test` is not run in
the hook itself (too slow for every commit) but must have been run via the
script above before committing.

## Silver Gate

Run from the `web/` directory:

```bash
tsc --noEmit
npm test -- --reporter=verbose
npx playwright test
npx playwright test --config playwright.dev.config.ts
```

`playwright.config.ts` runs `app.spec.ts` and `offline.spec.ts` against `vite preview`
(production build). `playwright.dev.config.ts` runs `flow.spec.ts` against `vite dev`
because `flow.spec.ts` uses `window.__testLoad`, a hook only available in dev builds.
Run Playwright only when touching UI rendering, image pipeline, or session flow —
it runs against the production build and takes ~2–3 min.

The pre-commit hook requires a silver gate token for every commit on `master`.
The token is only created by `scripts/run-silver-gate.sh`, which actually
executes all the checks — so the token cannot be obtained without running them:

1. Run from the repo root: `bash scripts/run-silver-gate.sh`. This runs all
   code checks, then prompts to confirm doc hygiene, then creates the
   `.silver-gate-ok` token.
2. Commit immediately after (the token is consumed on first use):
   `git merge feature/<name>` (or `git commit`).

If the commit fails for any reason, re-run step 1 before retrying.

After merging, delete the feature branch: `git branch -d feature/<name>`.

Pushing to `master` triggers GitHub Actions which auto-deploys to GitHub Pages
— no manual deploy step needed. Verify with `gh run list --limit 3`.

Install the hooks once after cloning: `bash scripts/hooks/install.sh`.

`killer_sudoku`'s doc locations (`docs/superpowers/specs/`,
`docs/superpowers/plans/`) already match `shipwright:quality-gates`' defaults
— no project-specific override needed.
