# Coaching App Architecture

> Read this before working on the coaching API (`api/`), session lifecycle,
> frontend (`static/`), or the rules/hints integration layer. For the rules
> engine internals, see `docs/rules.md`.

---

## Design Principles

The coach is organised around **rules and highlights**:

- **Always-apply rules** run automatically on every state change, keeping
  candidates current without user intervention.
- **Hint-only rules** are surfaced on demand when the user requests hints.
  They do not modify the board automatically.

**Essential highlight** (salmon colour): digits that must appear in a cage
regardless of which valid solution is chosen. This is computed automatically
from cage solutions and cannot be overridden by the user.

**User actions** are limited to three things:
1. Enter a digit in a cell (or clear it)
2. Eliminate or restore a candidate digit in a cell
3. Eliminate or restore a solution combination for a cage

**Auto-application** is bootstrapped by two always-apply rules:
1. `CageCandidateFilter` — narrows each cell's candidates to the union of its
   cage's remaining solutions
2. `SolvedCellElimination` — eliminates a determined digit from all row/col/box
   peers

All other rules are hint-only by default. Users can promote rules to
always-apply via the config modal. New rules should start as hint-only and only
be added to `DEFAULT_ALWAYS_APPLY_RULES` once their hint is designed and tested.

---

## Session Lifecycle

```
POST /api/puzzle?newspaper=guardian  (upload image)
         │
         ▼
   OCR Review Phase
   ─────────────────────────────────────────────────────
   User edits cage totals, subdivides cages
   PATCH /api/puzzle/{id}/cage/{label}
   POST  /api/puzzle/{id}/cage/{label}/subdivide
   POST  /api/puzzle/{id}/solve  (optional preview solve)
         │
         │  POST /api/puzzle/{id}/confirm
         ▼
   Playing Phase
   ─────────────────────────────────────────────────────
   Golden solution computed; candidate grid initialised
   POST /api/puzzle/{id}/cell              enter/clear a digit
   POST /api/puzzle/{id}/undo              undo last digit entry
   POST /api/puzzle/{id}/candidates/cell   cycle a candidate
   GET  /api/puzzle/{id}/cage/{l}/solutions          view solutions
   POST /api/puzzle/{id}/cage/{l}/solutions/eliminate toggle elimination
   GET  /api/puzzle/{id}/hints             get applicable hints
   POST /api/puzzle/{id}/hints/apply       apply a hint's eliminations
   POST /api/puzzle/{id}/refresh           recompute candidates from settings
```

Sessions are identified by UUID and persisted as JSON files in the sessions
directory (default: `sessions/`). The full session state is `PuzzleState`.

---

## State Model

All types are in `killer_sudoku/api/schemas.py`.

### `PuzzleState` — complete session state

| Field | Type | Notes |
|---|---|---|
| `session_id` | `str` | UUID |
| `newspaper` | `"guardian"` \| `"observer"` | determines OCR model |
| `cages` | `list[CageState]` | label, total, cells, subdivisions, user-eliminated solutions |
| `spec_data` | `PuzzleSpecData` | serialised `PuzzleSpec` arrays for canvas rendering |
| `original_image_b64` | `str` | base64 JPEG of uploaded photo |
| `golden_solution` | `list[list[int]] \| None` | None before /confirm; 9×9 after |
| `user_grid` | `list[list[int]] \| None` | None before /confirm; 0 = unfilled cell |
| `move_history` | `list[MoveRecord]` | chronological digit entries/clears |
| `candidate_grid` | `CandidateGrid \| None` | None before /confirm |

### `CandidateGrid` — 9×9 grid of `CandidateCell`

| Field | Notes |
|---|---|
| `auto_candidates` | digits always-apply rules consider possible |
| `auto_essential` | subset of `auto_candidates` that must appear in the cage (must-contain set) |
| `user_essential` | user-promoted digits — see Known Issues #1 |
| `user_removed` | user-eliminated digits (persist across recomputation) |

**Rule A:** digits dropped from `auto_candidates` are silently removed from
`user_essential` on every recomputation.

### `CoachSettings` — persisted user preferences

`always_apply_rules: list[str]` — names of rules applied automatically on every
state change. Stored in `sessions/settings.json` (or `COACH_SESSIONS_DIR`).

`DEFAULT_ALWAYS_APPLY_RULES` in `schemas.py` is the cold-start value:
`["CageCandidateFilter", "SolvedCellElimination"]`.

---

## Rules and Hints Integration

The coaching app touches the rules engine at three points in `api/routers/puzzle.py`:

**1. Candidate computation** (`_compute_candidate_grid`): called after every
state change (`/cell`, `/undo`, `/candidates/cell`, `/confirm`, `/refresh`).
Builds a fresh board, runs always-apply rules to convergence, then derives
`auto_candidates` and `auto_essential` per cell.

**2. Hint collection** (`GET /{id}/hints`): rebuilds board state, runs
always-apply rules, then calls `collect_hints()` over all `HintableRule`
instances — skipping rules already in `always_apply` since their work is
already on the board.

**3. Config modal** (`GET /api/settings`): discovers all `HintableRule`
instances in `default_rules()` via `isinstance(r, HintableRule)`. No hardcoded
rule list anywhere in the API or frontend.

The bridge between `api/` and `solver/engine/` is `_make_board_and_engine(spec,
always_apply)` in `puzzle.py`. It derives whether virtual cages are required from
each active rule's `requires_virtual_cages` class attribute rather than
hardcoding any rule name.

For the full rules architecture — triggers, `HintResult`, `BoardState` API,
how to add or upgrade a rule — see `docs/rules.md`.

---

## API Reference

All endpoints are under `/api/`. Full request/response schemas at
`http://127.0.0.1:8000/docs`.

### Settings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings` | Current settings + catalogue of all hintable rules |
| `PATCH` | `/api/settings` | Update `always_apply_rules` |

### Puzzle — OCR review phase

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/puzzle?newspaper=...` | Upload image; run OCR; create session |
| `GET` | `/api/puzzle/{id}` | Get full `PuzzleState` |
| `PATCH` | `/api/puzzle/{id}/cage/{label}` | Correct cage total |
| `POST` | `/api/puzzle/{id}/cage/{label}/subdivide` | Split cage into sub-cages |
| `POST` | `/api/puzzle/{id}/solve` | Run batch solver; return golden solution |
| `POST` | `/api/puzzle/{id}/confirm` | Confirm layout; transition to playing phase |

### Puzzle — playing phase

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/puzzle/{id}/cell` | Enter or clear a digit |
| `POST` | `/api/puzzle/{id}/undo` | Undo last digit entry |
| `POST` | `/api/puzzle/{id}/candidates/cell` | Cycle one candidate (possible ↔ removed) |
| `POST` | `/api/puzzle/{id}/refresh` | Recompute candidates from current settings |
| `GET` | `/api/puzzle/{id}/cage/{label}/solutions` | All/impossible/user-eliminated solutions |
| `POST` | `/api/puzzle/{id}/cage/{label}/solutions/eliminate` | Toggle a cage solution |
| `GET` | `/api/puzzle/{id}/hints` | All currently applicable hints, sorted by impact |
| `POST` | `/api/puzzle/{id}/hints/apply` | Apply a hint's eliminations to candidate grid |

---

## Frontend

**Source:** `killer_sudoku/static/main.ts` (TypeScript, committed).
**Compiled output:** `killer_sudoku/static/main.js` (NOT committed — generate
before running).

```bash
npm install -g typescript   # once
tsc                         # from project root
```

The frontend is intentionally thin. It handles:
- Canvas rendering: grid lines, cage borders, digit entries, candidates,
  essential highlights
- User interactions: digit entry, candidate cycling, undo
- Config modal: reads hintable rules from `GET /api/settings`, POSTs updates
- Hint dropdown: reads hints from `GET /api/puzzle/{id}/hints`, POSTs applies

All business logic lives on the server.

---

## Developer Setup

```bash
pip install -e ".[dev]"
tsc                     # compile TypeScript (required before first run)
coach                   # start server + open browser
coach --no-browser      # start server only
# API:      http://127.0.0.1:8000
# OpenAPI:  http://127.0.0.1:8000/docs
```

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `COACH_GUARDIAN_DIR` | `guardian` | Guardian model/puzzle directory |
| `COACH_OBSERVER_DIR` | `observer` | Observer model/puzzle directory |
| `COACH_SESSIONS_DIR` | `sessions` | JSON session persistence directory |
| `COACH_HOST` | `127.0.0.1` | Bind address |
| `COACH_PORT` | `8000` | Port |

---

## Known Design Issues

Tracked bugs and design decisions requiring work:

1. **NakedSingle hints are vacuous when SolvedCellElimination is always-apply.**
   `NakedSingle.compute_hints` looks for peer eliminations that
   `SolvedCellElimination` has already applied, finds none, and returns empty.
   NakedSingle needs to be reconceived as a placement hint — highlight the cell,
   tell the user what digit to place — rather than an elimination hint.

2. **Essential highlight is partially user-controllable but should not be.**
   The candidate cycling UI allows toggling the essential state. It should only
   cycle possible ↔ impossible; the essential state is auto-computed and must not
   be user-overridable.

3. **No config option for the essential highlight.** The salmon essential
   highlight should be togglable via the config pane but currently is not.

4. **Undo is not working.** The endpoint exists and reverts `PuzzleState`, but
   the frontend `redrawGrid()` call does not reflect the change.

5. **Rule triggers are not sensitive to user candidate changes.** When the user
   manually removes a candidate via the candidate cycling UI, the always-apply
   rules do not re-fire. The engine never sees the change.

6. **Some rules narrow solution sets internally without reflecting this in the
   candidate view.** A rule may prune `board.cage_solns` during `apply()` without
   emitting the corresponding `SOLUTION_PRUNED` events, causing the candidate
   display to show digits the solver considers eliminated.

7. **19 rules in `default_rules()` have no `compute_hints` and cannot be
   promoted via the config modal.** They are effectively dead in the coaching
   context. They should either receive hint implementations or be removed from
   `default_rules()`. See `docs/rules.md` Rule catalogue for the full list.
