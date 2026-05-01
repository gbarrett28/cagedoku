# Agent Behaviour

## Token Efficiency

When there is a choice of approaches, always prefer the one that achieves the final
result with the fewest total tokens. Avoid redundant reads, intermediate explorations
that are not necessary for the task, and verbose output where concise output suffices.

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

- **`docs/rules.md`** — read before touching any rule or coaching engine component (`web/src/engine/rules/`)
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

---

# Quality Gates

**CRITICAL:** Before creating any commit, you MUST automatically run the **bronze gate** checks.

## Bronze Gate (MANDATORY before every commit)

Run from the `web/` directory:

```bash
tsc --noEmit
npm test
```

**This sequence is MANDATORY before git commit. If ANY step fails, DO NOT COMMIT.**

## Silver Gate (REQUIRED before merging to `master`)

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
