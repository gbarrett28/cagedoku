# Agent Behaviour

## Required Superpowers

These three skills **must always** be invoked at the moments described — no exceptions:

| Skill | Invoke when |
|---|---|
| `superpowers:brainstorming` | Before any new feature, significant code change, or design decision. No code is written until a design is presented and approved. |
| `superpowers:verification-before-completion` | Before claiming any task is complete, before stating tests pass, and before creating a commit or PR. |
| `superpowers:systematic-debugging` | Before attempting to fix any bug, test failure, or unexpected behaviour. Root cause first, fix second. |
| `superpowers:test-driven-development` | Before writing any implementation code for a feature or bugfix — write the failing test first. |
| `superpowers:finishing-a-development-branch` | After all implementation tasks are complete and verified, before merging/pushing — structures the merge/PR/cleanup decision. |
| `superpowers:requesting-code-review` | Before merging any feature branch — dispatches a fresh subagent reviewer with no session history for unbiased review. |
| `superpowers:receiving-code-review` | When receiving code review feedback — verify technically before implementing; never agree blindly. |

---

## Git Worktrees

Do **not** use git worktrees — not all tools work correctly inside them.
Use a feature branch in the main working directory instead.

## Token Efficiency

When there is a choice of approaches, always prefer the one that achieves the final
result with the fewest total tokens. Avoid redundant reads, intermediate explorations
that are not necessary for the task, and verbose output where concise output suffices.

When choosing a plan execution mode, always choose **inline execution** (executing-plans)
over subagent-driven execution — it uses fewer total tokens.

Never offer the visual companion feature during brainstorming — use Playwright MCP directly.

## UI Visual Verification

The Playwright MCP plugin is available for visual testing of layout and CSS changes.
Start the dev server first (`cd web && npm run dev -- --port 5175`), then use
`mcp__plugin_playwright_playwright__browser_*` tools to navigate, resize the viewport,
evaluate JS (measure element dimensions, check overflow), and take screenshots.
Use it when working on responsive layout, canvas sizing, or any visual rendering change.

## PR Review Tools

The `pr-review-toolkit` plugin provides 6 specialist review agents for targeted
pre-merge analysis — invoke individually or together:
- `pr-review-toolkit:code-reviewer` — bugs, security, quality
- `pr-review-toolkit:pr-test-analyzer` — test coverage gaps
- `pr-review-toolkit:silent-failure-hunter` — swallowed errors / bad fallbacks
- `pr-review-toolkit:type-design-analyzer` — type invariants and encapsulation
- `pr-review-toolkit:comment-analyzer` — stale / inaccurate comments
- `pr-review-toolkit:code-simplifier` — clarity and maintainability

The `coderabbit` plugin provides automated PR-level review via the CodeRabbit CLI
(`coderabbit:code-reviewer`). Useful once PRs are opened against the repo.

## Library Documentation

The context7 MCP plugin (`mcp__plugin_context7_context7__*`) fetches up-to-date library
docs. Use it when working with Vite config, Playwright APIs, TypeScript compiler options,
or OpenCV.js — prefer it over relying on training-data knowledge for external APIs.

## TypeScript Language Server

The `typescript-lsp` plugin is installed and `typescript-language-server` is available
via npx. The built-in `LSP` tool provides go-to-definition, find-references, and
compiler diagnostics. Use it to complement serena for precise cross-file type navigation.

---

# Project Overview

## What This Project Is

A browser-based coaching companion for killer sudoku. Reads newspaper puzzle images
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
load it via ToolSearch:
```
ToolSearch query: "select:mcp__serena__get_symbols_overview"
```
If serena tools do not appear in ToolSearch, the plugin is not enabled — ask the user to enable
`serena@claude-plugins-official` in Claude Code settings and restart the session before proceeding.
Do NOT fall back to filesystem tools while serena is merely disabled.

**Debug screenshots:** When the user refers to a `.png` by name only (e.g. "look in
Untitled.png"), it is at the project root. Read it with the Read tool. Never commit it.

## Core Workflow

1. **Start with overview:** Use `mcp__serena__get_symbols_overview` to understand file structure
2. **Find symbols:** Use `mcp__serena__find_symbol` to locate specific classes, functions, methods
3. **Understand relationships:** Use `mcp__serena__find_referencing_symbols` to see where code is used
4. **Search patterns:** Use `mcp__serena__search_for_pattern` when you don't know exact symbol names
5. **Edit strategically:** Use `mcp__serena__replace_symbol_body`, `mcp__serena__insert_after_symbol`, `mcp__serena__insert_before_symbol`
6. **Always:** Check for existing code structure using serena tools before writing anything new

---

# TypeScript Coding Guidelines

## Design Philosophy: Safety By Construction

**Core principle:** Prefer language features and structures that make errors **impossible** rather than just **unlikely**.

- **Type system:** Make invalid states unrepresentable through strong typing; prefer `readonly` arrays and tuples
- **Iteration:** Use `for...of` and destructuring to couple related variables; avoid raw index loops unless necessary
- **Configuration:** Single source of truth — no magic numbers scattered through code
- **Error handling:** Surface errors to the user unless there is a clear automatic resolution

## Self-Documenting Code

- Keep JSDoc comments up to date; tiered: short summary first, then detail
- Inline comments should explain WHY or WHAT, not HOW (mechanics are visible in the code)

## Type Safety

- Always use the strongest possible return type annotation
- Always use the weakest possible parameter type annotation
- Never use `any` unless the object truly can be anything at runtime
- Prefer `unknown` over `any` for external data; narrow explicitly

## Code Hygiene

- All `import` statements at the top of the file — no dynamic/inline imports
- No `* as` star imports — name every symbol explicitly
- Before removing code, use `mcp__serena__find_referencing_symbols` to verify it is unused

## Error Handling

- Surface exceptions unless there is a clear way to resolve them automatically
- Catch only for graceful degradation; always log or rethrow otherwise

---

# Branch Workflow

- All new work must be done on a **feature branch** (never commit directly to `master`).
- Name branches descriptively: `feature/short-description`.
- **Bronze gate must pass before every commit** on any branch.
- **Silver gate must pass before merging to `master`**.

## Doc Conventions

| Kind | Location | Lifecycle |
|---|---|---|
| **Spec** | `docs/specs/<name>.md` | Design intent for a feature under development. Deleted once incorporated into a live doc. |
| **Plan** | `docs/plans/<name>.md` | Step-by-step implementation plan with `- [ ]` checkboxes. Deleted once all steps are done. |
| **Live doc** | `docs/architecture.md`, `docs/image-pipeline.md`, etc. | Permanent reference; always reflects the current codebase. |

---

# Quality Gates

**CRITICAL:** Before creating any commit, you MUST automatically run the **bronze gate** checks.

## Bronze Gate (MANDATORY before every commit)

Run from the `web/` directory:

```bash
tsc --noEmit
tsc -p tsconfig.node.json --noEmit
npm test
```

**If ANY step fails, DO NOT COMMIT.**

Then verify manually — these checks are part of the gate, not optional:
- Every spec in `docs/specs/` still accurately describes the intended design. Update it if the implementation has diverged.
- Every plan in `docs/plans/` has its completed steps checked off.

**Do not commit if either doc check fails.**

## Silver Gate (REQUIRED before merging to `master`)

Run from the `web/` directory:

```bash
tsc --noEmit
npm test -- --reporter=verbose
npx playwright test
npx playwright test --config playwright.dev.config.ts
```

**If ANY step fails, DO NOT MERGE.**

Then verify manually — these checks are part of the gate, not optional:
- Every spec in `docs/specs/` (and `docs/superpowers/specs/`) has been incorporated
  into the relevant live doc (`docs/architecture.md`, `docs/image-pipeline.md`, etc.)
  with the actual implementation details — not just a pointer to the spec.
  Then **delete the spec file**.
- Every plan in `docs/plans/` (and `docs/superpowers/plans/`) has all steps completed
  — then **delete the plan file**.

**Do not merge if either doc check fails.**

After merging, **delete the feature branch**:
```bash
git branch -d feature/<name>
```

Pushing to `master` triggers GitHub Actions which auto-deploys to GitHub Pages — no
manual deploy step needed. Verify with `gh run list --limit 3`.

`playwright.config.ts` runs `app.spec.ts` and `offline.spec.ts` against `vite preview`
(production build). `playwright.dev.config.ts` runs `flow.spec.ts` against `vite dev`
because `flow.spec.ts` uses `window.__testLoad`, a hook only available in dev builds.

Run Playwright only when touching UI rendering, image pipeline, or session flow —
it runs against the production build and takes ~2–3 min.

---

# Test Specification Integrity

**CRITICAL RULE:** Tests define the specification for each module.

**When tests fail after code changes:**
1. **Assume the implementation is wrong, not the test**
2. If you believe the test is wrong, you MUST:
   - Document the spec change in detail (what changed and why)
   - Get explicit user approval for the spec change
   - Update the test with clear comments explaining the change
   - NEVER silently modify tests to make them pass

---

# Commit Conventions

- Follow Conventional Commits format: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Clear, descriptive commit messages focused on "why" not "what"
- Co-Authored-By tag if AI-assisted:
  ```
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  ```
- **Always confirm before deleting or changing anything that is not committed to git**
