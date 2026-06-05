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

## Plan Sprint Size

When writing an implementation plan, **strongly prefer** breaking it into sprints of at
most ~3 hours of inline execution tokens. Sprints are separate plan files, each
producing working, independently-testable software.

- If a spec covers multiple independent subsystems, each subsystem is its own sprint.
- If a single subsystem exceeds ~3 hours, break it at a natural integration point
  (e.g., after the data layer is done and tested, before the UI layer).
- Only combine into a single sprint when splitting would produce code that cannot be
  meaningfully tested on its own (rare — usually a sign the design needs refinement).

This is a strong preference, not an absolute rule: if a feature is genuinely simpler
to implement atomically and the token cost is low, a single sprint is fine.

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

## OO Over Discriminated Unions

**Strong preference: use the namespace-merging pattern instead of bare discriminated unions** whenever a type has per-variant behaviour.

### Why

A bare discriminated union (`type Foo = A | B | C`) scatters behaviour into switch statements elsewhere in the codebase. The compiler cannot enforce that every variant is handled in every dispatch site. The result is:

- Silent fallthrough (`default: return state`) — new variants do nothing, no compile error
- External metadata that drifts (`Set<string>`, `string[]` tracking which variants have a property)
- Behaviour spread across multiple files, far from the type definition

### The namespace-merging pattern

Keep the type as plain data (serialisable, no class instances) and put per-variant static methods in a same-name namespace:

```typescript
// Each variant is a named interface + namespace
export interface PlaceDigitAction {
  readonly type: 'placeDigit';
  readonly row: number; readonly col: number; readonly digit: number;
}
export namespace PlaceDigitAction {
  export function apply(a: PlaceDigitAction, state: PuzzleState): PuzzleState { ... }
}

// The union gets its own namespace with an exhaustiveness guard
export type UserAction = PlaceDigitAction | RemoveDigitAction | ...;
export namespace UserAction {
  export function apply(action: UserAction, state: PuzzleState): PuzzleState {
    switch (action.type) {
      case 'placeDigit': return PlaceDigitAction.apply(action, state);
      // ...
      default: assertNeverAction(action);  // compile error on missing case
    }
  }
}
```

The compiler now **enforces** that every variant defines all required methods. Adding a new variant without updating every dispatch function is a type error.

### When a property belongs on the type itself

If code elsewhere maintains a `Set<string>` or `string[]` to track which variants of a type have a given property — that is a red flag. The property belongs on the type. Example: `CLASSIC_EXCLUDED_RULES: Set<string>` should be `rule.killerOnly: boolean` on `SolverRule`.

### When a plain discriminated union is still fine

- Very small, stable unions (2–3 variants) with no per-variant behaviour
- Pure structural narrowing with no dispatch (e.g. `type GitHubAction = CommentAction | IssueAction`)
- When all dispatch is in a single, focused location and the union will never grow

### Warning signs to refactor

- Any `default: return x` (silent fallthrough) in a switch over a union discriminant
- An external `Set<string>` / `string[]` tracking which variants of a type have a property
- More than one `switch` / `if-else` chain dispatching on the same discriminant across the codebase
- Behaviour relevant to a type variant living in a different file from the type definition

## Type Safety

- Always use the strongest possible return type annotation
- Always use the weakest possible parameter type annotation
- Never use `any` unless the object truly can be anything at runtime
- Prefer `unknown` over `any` for external data; narrow explicitly

## Code Hygiene

- All `import` statements at the top of the file — no dynamic/inline imports
- No `* as` star imports — name every symbol explicitly
- Before removing code, use serena's `find_referencing_symbols` to verify it is unused

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

## Bronze Gate (MANDATORY before every commit on a feature branch)

Run the gate script from the repo root:

```bash
bash scripts/run-bronze-gate.sh
```

This runs `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test`.
If all pass it creates a one-time `.bronze-gate-ok` token that the pre-commit hook
consumes when you commit. **The hook blocks the commit if no token is present.**

Also verify manually (not automated):
- Every spec in `docs/specs/` still accurately describes the intended design.
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

### Doc hygiene (mandatory — do not skip)

**Specs** — check all three locations:
- `docs/specs/`
- `docs/superpowers/specs/`

For each spec file found: the implementation details must be written into the
relevant live doc (`docs/architecture.md`, `docs/ui.md`, `docs/image-pipeline.md`,
etc.) with concrete descriptions of what was actually built — not a summary or a
pointer back to the spec. Once incorporated, **delete the spec file**.

**Plans** — check all three locations:
- `docs/plans/`
- `docs/superpowers/plans/`
- `~/.claude/plans/`  ← session-scoped plans created by the agent during work

For each plan file found: every `- [ ]` step must be ticked. Once all steps are
complete, **delete the plan file**. A plan with unchecked steps means work is
unfinished — do not merge.

**Do not merge if any spec or plan file remains.**

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

## Pre-commit Hook

A `pre-commit` git hook (`scripts/hooks/pre-commit`) enforces the appropriate gate
for the branch being committed to. Every commit on `master` is therefore a verified
state, which makes `git bisect` reliable.

| Branch | Gate enforced |
|---|---|
| `master` / `main` | Silver gate — blocks until confirmed (see below) |
| Any feature branch | Bronze gate — runs `tsc` checks automatically; blocks on failure |

### Feature branches (bronze gate)

The hook runs `tsc --noEmit` and `tsc -p tsconfig.node.json --noEmit` automatically.
If either fails the commit is blocked. `npm test` is not run in the hook (too slow
for every commit) but **must** have been run before committing — see Bronze Gate above.

### Master — commit sequence (MANDATORY for agent and human)

The pre-commit hook requires a silver gate token for every commit on master.
The token is only created by `scripts/run-silver-gate.sh`, which actually
executes all the checks — so the token cannot be obtained without running them.

Steps every time you commit to `master` (including merge commits):

1. Run the silver gate script from the repo root:
   ```bash
   bash scripts/run-silver-gate.sh
   ```
   This runs all code checks, then prompts to confirm doc hygiene, then
   creates the `.silver-gate-ok` token.
2. Commit immediately after (the token is consumed on first use):
   ```bash
   git merge feature/<name>   # or git commit
   ```

If the commit fails for any reason, re-run step 1 before retrying.

**Never use `--no-verify`** to bypass the hook.

Install the hooks once after cloning:
```bash
bash scripts/hooks/install.sh
```

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
