# Agent Behaviour

## Token Efficiency

When there is a choice of approaches, always prefer the one that achieves the final
result with the fewest total tokens. Avoid redundant reads, intermediate explorations
that are not necessary for the task, and verbose output where concise output suffices.

---

# Project Overview

## What This Project Is

A browser-based coaching companion for killer sudoku. Reads newspaper puzzle images,
locates the grid via contour detection, detects cage borders using format-agnostic
anchored k-means clustering, reads cage totals, and guides the user through solving
with candidates, logical hints, and rule-based deductions.

## Codebase Map

| Subsystem | Package | Reference |
|---|---|---|
| Puzzle discovery | `training/scrape_puzzles.py`, `training/status.py` | code |
| Image pipeline | `image/` | `docs/architecture.md` |
| Training pipeline | `training/` | `docs/architecture.md` |
| Image pipeline debug | `training/debug_border_strips.py`, `training/debug_borders.py` | CLI tools — strip positions and border decisions on the warped image |
| Batch solver | `solver/grid.py`, `solver/equation.py`, `output/`, `main.py` | code |
| Coaching engine | `solver/engine/` | `docs/rules.md` |
| Coaching app | `api/`, `static/` | `docs/architecture.md`, `docs/ui.md` |

## Key Reference Documents

- **`docs/rules.md`** — read before touching any rule, hint, or coaching engine component (`solver/engine/`)
- **`docs/architecture.md`** — read before working on the coaching API, session lifecycle, image pipeline, or training pipeline (`api/`, `static/`, `image/`, `training/`)
- **`docs/ui.md`** — read before working on the frontend (`static/`)

## Predecessor Project

`../kill_sudoku` is an older, unpackaged predecessor with no git history. It contains
code that was **not** carried over into this rewrite and should be reviewed before
being discarded. Do not delete `kill_sudoku` until that review is complete.

---

# Import Patterns and Project Structure

## Directory Structure

```
killer_sudoku/                  # Project root
├── killer_sudoku/              # Package
│   ├── api/                    # FastAPI coaching app
│   │   ├── routers/            # puzzle.py, settings.py — API route handlers
│   │   ├── app.py              # Application factory + coach entry point
│   │   ├── config.py           # CoachConfig (COACH_* env vars)
│   │   ├── schemas.py          # Pydantic models; DEFAULT_ALWAYS_APPLY_RULES
│   │   ├── session.py          # JSON session store
│   │   └── settings.py         # SettingsStore (always-apply rule config)
│   ├── image/                  # OCR pipeline: grid location, border detection, number recognition
│   ├── output/                 # Solution image rendering (batch solver)
│   ├── solver/
│   │   ├── engine/             # Event-driven coaching engine
│   │   │   └── rules/          # One .py file per rule
│   │   ├── grid.py             # Batch solver — constraint propagation
│   │   ├── equation.py         # Batch solver — cage equations + sol_sums()
│   │   └── puzzle_spec.py      # Shared: cage layout → PuzzleSpec
│   ├── static/                 # Frontend assets
│   │   ├── main.ts             # TypeScript source (committed)
│   │   ├── main.js             # Compiled output (NOT committed — run tsc)
│   │   └── index.html, styles.css
│   ├── training/               # Puzzle scraping + ML model training
│   └── main.py                 # Batch solver entry point
├── tests/
├── docs/
└── pyproject.toml
```

## Import Statement Rules

**One form only — always use the full `killer_sudoku.` prefix:**

```python
from killer_sudoku.solver.grid import Grid, ProcessingError
from killer_sudoku.solver.equation import Equation
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.output.sol_image import SolImage
```

This rule applies to **all** code: package modules, tests, and scripts.

## Common Mistakes to Avoid

- ❌ **WRONG**: `from grid import Grid` — bare import without `killer_sudoku.` prefix
- ❌ **WRONG**: `from .grid import Grid` — avoid relative imports; use full path for clarity
- ❌ **WRONG**: `from inp_image import *` — star imports are prohibited throughout
- ❌ **WRONG**: `from equation import *` — same problem
- ❌ **WRONG**: Using `dict` or `Any` on FastAPI endpoint signatures
- ✅ **CORRECT**: `from killer_sudoku.solver.grid import Grid`
- ✅ **CORRECT**: Pydantic response models on all FastAPI endpoints

---

## Web API

The coaching app is fully implemented in `killer_sudoku/api/`. See `docs/architecture.md`
(Coaching App section) for the complete architecture. The TypeScript frontend source is in
`killer_sudoku/static/main.ts`; compile with `tsc` before running (output `main.js`
is not committed). Interactive API docs at `http://127.0.0.1:8000/docs` when running.

---

# Agent Protocol: Tool Use

**CRITICAL RULE:** For ALL code analysis, retrieval, and modification tasks, you **MUST** use the `serena` MCP tools. DO NOT
use generic filesystem tools (like `Read`, `Glob`) unless the `serena` tools explicitly fail or are
insufficient for a non-code file (e.g., a `.yaml` or `.txt`).

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

# Python Coding Guidelines

## Design Philosophy: Safety By Construction

**Core principle:** Prefer language features and structures that make errors **impossible** rather than just **unlikely**.

Apply this across all coding decisions:
- **Type system:** Make invalid states unrepresentable through strong typing
- **Iteration:** Couple related variables structurally (zip, enumerate) so they cannot misalign
- **Configuration:** Single source of truth eliminates inconsistency by construction
- **Error handling:** Surface errors that cannot be automatically resolved, handle only when resolution is clear

## Self-Documenting Code

- Make sure docstrings exist and keep them up to date
- The docstring should be tiered: short summary first, then detailed explanation
- Target the docstring for consumption by an LLM as well as a human
- Inline comments should explain WHAT the code is doing, not HOW — describe function, not mechanics

## Memory Safety

**Avoid subscripting (`[]`) to prevent out-of-bounds access and variable misalignment:**

- **Couple related variables at iteration level**, not through shared indices:
  - ❌ Bad: `for i in range(len(xs)): x = xs[i]; y = ys[i]`
  - ✅ Good: `for x, y in zip(xs, ys)`

- **Bind index and value together when both are needed:**
  - ❌ Bad: `for i in range(len(xs)): x = xs[i]`
  - ✅ Good: `for i, x in enumerate(xs)`

- **Use iteration tools to avoid index arithmetic:**
  - ❌ Bad: `for i in range(len(xs)-1): current = xs[i]; next = xs[i+1]`
  - ✅ Good: `for current, next in itertools.pairwise(xs)`

- **Create and use lazy iterators wherever possible** to avoid loading full datasets into memory

## Type Safety

- Always declare variables with the strongest possible type annotation
- Always give method parameters the weakest possible type annotation
- Always give method return the strongest possible type annotation
- Never use `Any` unless the object truly can be anything at runtime
- No `if TYPE_CHECKING` imports — find a proper dependency graph solution instead
- No string literal types — analyse the dependency graph and use proper types

## Central Configuration

- Give each separate module its own configuration dataclass
- Reference module configurations from a global configuration
- Take values from the configuration structure rather than using default parameter values (e.g. thresholds)
- Add all path names to the central configuration and follow the pattern for creating paths as properties

## Module-Level Side Effects

**CRITICAL:** The current codebase initialises objects and runs code at module import time
(e.g. `OBRDR`, `O1DBR`, `NUM_REC` in `inp_image.py`; `collect_status()` in `main.py`).
This pattern is **prohibited** in all new and refactored code:

- All initialisation must be deferred to explicit entry points or factory functions
- Module import must never trigger file I/O, network access, or computation
- Use lazy initialisation patterns where startup cost is significant

## API Design

- When using FastAPI, **always use Pydantic types on the API** — never raw `dict` or `Any`
- Define request/response models in a dedicated `schemas.py`
- Do as little as possible in frontend HTML/JS — push logic to the backend server
- CORS is configured for development — restrict origins in production

## Code Hygiene

- **NEVER use local (inline) imports** — all `import` statements must be at the top of the file. This is enforced by ruff rule `PLC0415` and is non-negotiable. There are no exceptions.
- **No star imports** — `from module import *` is prohibited everywhere. Name every symbol explicitly.
- Before committing changes, check for and remove unused top-level functions and variables
- Use `mcp__serena__find_referencing_symbols` to verify whether code is referenced before removing

## Error Handling

- Surface exceptions to be dealt with by the user unless there is a clear way to fix the root cause automatically
- Exceptions may be silently handled only where a computed value is explicitly "best effort"

## Cross-Platform Compatibility

**All code, tools, and workflows must work identically across Windows, macOS, and Linux:**

- **Use `python -m <tool>` prefix** for all Python tools:
  - ✅ Good: `python -m ruff check`, `python -m mypy killer_sudoku`
  - ❌ Bad: `ruff check`, `mypy killer_sudoku` (may fail on some platforms)

- **Use `pathlib.Path`** for all file paths — never string concatenation
- No platform-specific shell commands in automation
- Don't use strange characters unnecessarily: UnicodeEncodeError will occur on Windows

---

# Branch Workflow

- All new work must be done on a **feature branch** (never commit directly to `master`).
- Name branches descriptively: `feature/short-description`.
- **Bronze gate must pass before every commit** on any branch.
- **Silver gate must pass before merging to `master`**, and before any direct commit on `master`.

---

# Quality Gates

**CRITICAL:** Before creating any commit, you MUST automatically run the **bronze gate** checks.

## Bronze Gate (MANDATORY before every commit)

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

**This sequence is MANDATORY before git commit. If ANY step fails, DO NOT COMMIT.**

## Image Pipeline Regression (~10–15 min)

```bash
python -m pytest tests/image/test_pipeline_regression.py -v
```

Processes all available puzzle images (465 Guardian + 424 Observer = 889 total).
Run deliberately when touching `image/`, `border_clustering.py`, or `cell_scan.py` —
too slow for routine bronze-gate use.

## Silver Gate (REQUIRED — full codebase pass)

```bash
python -m ruff check killer_sudoku/    # No --ignore flags, full check
python -m mypy --strict killer_sudoku/ # Entire package tree
```

**Rationale:** Changes to shared utilities can affect code throughout the codebase
even if those files don't appear modified. Silver gate catches this. It is also the
bar required before merging to `master` or committing directly on `master`.

If complexity warnings appear (PLR091x), refactor the code — DO NOT add `# noqa`.

---

# Silver Gate: Legitimate `# noqa` Usage

**The following are the ONLY legitimate uses of `# noqa`:**

1. **FastAPI Dependency Injection (B008)** — Framework requirement
   ```python
   async def endpoint(
       db: Session = Depends(get_db),  # noqa: B008
   ) -> Response:
   ```

2. **Best-Effort Exception Handling (E722)** — Graceful degradation only
   ```python
   try:
       count = len(work)
   except:  # noqa: E722
       # Best effort: non-critical operation, graceful degradation
       count = None
   ```

3. **Type Hint Parameters (ARG001)** — IDE type inference only
   ```python
   def load[T](path: Path, expected_type: type[T] | None = None) -> T:  # noqa: ARG001
       # expected_type used only for type inference, not in function body
   ```

4. **Library Configuration Management (PLW0603)** — Standard configuration pattern
   ```python
   def configure(...) -> None:
       global _config  # noqa: PLW0603
       # Standard library config pattern (like logging.basicConfig)
   ```

**All other `# noqa` uses are prohibited.** Fix the underlying code instead.

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
