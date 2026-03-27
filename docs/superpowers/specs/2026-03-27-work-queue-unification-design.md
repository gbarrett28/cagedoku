# Work Queue Unification — Design Spec

**Date:** 2026-03-27
**Status:** Approved — ready for implementation planning
**Approach:** C — layer-by-layer, always shippable (four independent slices)

---

## Motivation

The coaching app currently runs two parallel code paths:

1. `_compute_candidate_grid` — builds an engine with only always-apply rules, runs it to
   convergence, stores the result as `CandidateGrid` / `CandidateCell` in the session.
2. `collect_hints` — calls `compute_hints()` on each hint-only rule as a separate board scan
   after convergence.

These two paths can disagree. A hint-only rule's `compute_hints()` may see a board state
that differs subtly from what the engine produced. The rules' `apply()` and `compute_hints()`
methods are also a duplicated code path — they can drift from each other.

The batch solver and coaching app each build their own `SolverEngine` with different rule
sets, giving no guarantee they agree on what is deducible.

**Goal:** a single engine that drives everything. The only difference between batch-solving
and coaching is whether a hint-only rule's output is applied or buffered as a pending hint.

---

## Principles

1. **The engine is the only mechanism that mutates candidates.** No parallel
   candidate-computation path exists.
2. **Always-apply rules drain and commit. Hint-only rules fire and buffer.** One engine,
   two output channels.
3. **Session state = user decisions + turn history.** Solver state is always recomputed
   from spec + user decisions. The turn history enables undo.
4. **Essential highlighting is derived, not stored.** Must-contain sets are computed at
   display time from `cage_solns`, scoped to real cages only.
5. **Virtual cages are user-discovered, not auto-injected.** The engine only adds cage
   units for virtual cages already in `user_virtual_cages`. The `LinearSystem` is an
   internal computation service for rules; it does not automatically inject cage units.
6. **Every mutation is annotated with its source.** Three-way: `"auto:<RuleName>"`,
   `"user:manual"`, or `"user:hint:<RuleName>"`.

---

## Minimal solver state

The solver state that must be stored or known to reproduce the exact board at any point:

| State | Type | Notes |
|---|---|---|
| Cell candidates | `candidates[r][c]: set[int]` | Not derivable from anything else |
| Real cage solutions | `cage_solns[cage_idx]: list[frozenset[int]]` | SolutionMapFilter pruning is not re-derivable from candidates alone |
| Virtual cage solutions | `cage_solns[virtual_idx]: list[frozenset[int]]` | Same; only for user-acknowledged virtual cages |

Everything else is a derivable optimisation:
- `counts[unit][d]` — O(n) recompute from candidates + units
- `unit_versions` — rebuilt fresh each engine instantiation
- `_cell_unit_ids` — lookup table, built from units
- `LinearSystem.delta_pairs` (live) — re-derivable by running LinearSystem from spec and
  substituting all currently-determined cells
- `LinearSystem.live_rows` — same

**Implication:** the session does not need to serialise `BoardState`. It stores only user
decisions (the inputs). The engine recomputes solver state on every request by replaying
those inputs.

---

## Session state model

Replaces `CandidateGrid` / `CandidateCell` / `auto_candidates` / `user_essential`.

```python
class UserAction(BaseModel):
    """One atomic user-initiated change."""
    type: Literal[
        "place_digit",        # user entered a digit in a cell
        "remove_digit",       # user cleared a placed digit
        "remove_candidate",   # user manually eliminated a candidate
        "eliminate_cage_soln",         # user eliminated a real cage solution
        "eliminate_virtual_cage_soln", # user eliminated a virtual cage solution
        "add_virtual_cage",   # user acknowledged a sum equation (manual or hint-accepted)
        "apply_hint",         # user accepted an elimination/placement hint
    ]
    # Fields present depend on type:
    row: int | None = None
    col: int | None = None
    digit: int | None = None
    cage_idx: int | None = None        # real cage index (cage_idx = unit_id - 27)
    virtual_cage_key: str | None = None  # stable key for a virtual cage (see below)
    solution: list[int] | None = None  # frozenset serialised as sorted list
    virtual_cage_cells: list[tuple[int, int]] | None = None
    virtual_cage_total: int | None = None
    hint_eliminations: list[tuple[int, int, int]] | None = None  # (row, col, digit)
    hint_placement: tuple[int, int, int] | None = None           # (row, col, digit)
    source: str  # "user:manual" | "user:hint:<RuleName>"


class AutoMutation(BaseModel):
    """One candidate or solution change produced by an always-apply rule."""
    rule_name: str                # e.g. "CellSolutionElimination"
    type: Literal["candidate_removed", "solution_eliminated", "virtual_cage_added"]
    row: int | None = None
    col: int | None = None
    digit: int | None = None
    cage_idx: int | None = None
    solution: list[int] | None = None


class Turn(BaseModel):
    """One user action and all auto-apply rule cascades it triggered."""
    user_action: UserAction
    auto_mutations: list[AutoMutation]
    # Board snapshot at end of this turn (candidates + cage_solns) for O(1) undo.
    # Stored as a compact serialisation; see BoardSnapshot below.
    snapshot: BoardSnapshot


class PuzzleState(BaseModel):
    # ... existing spec_data, cages, user_grid fields ...
    history: list[Turn] = []
    # user_virtual_cages: derived from history (all add_virtual_cage actions), not
    # stored separately — reconstructed on each request from history.
```

**Undo semantics:** pop `history[-1]`. Current board = `history[-2].snapshot` (or fresh
`BoardState` if history is empty). No engine replay needed.

**Virtual cage key:** a stable string identifying a virtual cage — e.g.
`"r1c1,r1c2,r2c3:17"` (sorted cell coordinates + total). Used to match hints to
existing `user_virtual_cages` entries and to reference them in `UserAction`.

**Source annotation values:**
- `"user:manual"` — direct user action (digit entry, candidate elimination, cage solution
  elimination, manual virtual cage construction)
- `"user:hint:RuleName"` — user accepted a hint produced by rule `RuleName`
- `"auto:RuleName"` — recorded in `AutoMutation.rule_name` (not in `UserAction.source`)

---

## Slice 1 — Engine unification

**Goal:** delete `compute_hints()` / `collect_hints()` / `HintableRule`. The engine
produces hints as a by-product of firing hint-only rules.

### Changes to `SolverEngine`

`SolverEngine.__init__` gains:
```python
hint_rules: frozenset[str] = frozenset()
# Names of rules whose apply() results should be buffered as hints, not applied.
```

`self.pending_hints: list[HintResult]` — accumulates buffered results.

In the main loop, after popping a work item:
```python
if item.rule.name in self.hint_rules:
    # Fire the rule but buffer results as hints
    eliminations = item.rule.apply(ctx)
    if eliminations:
        hint = item.rule.as_hint(ctx, eliminations)
        self.pending_hints.append(hint)
    # Do NOT call apply_eliminations
else:
    eliminations = item.rule.apply(ctx)
    if eliminations:
        self.apply_eliminations(eliminations)
```

### `as_hint()` method on rules

Rules that want rich hint text implement:
```python
def as_hint(self, ctx: RuleContext, eliminations: list[Elimination]) -> HintResult:
    """Convert a firing apply() result into a HintResult for coaching display."""
    ...
```

Rules without `as_hint` get a default wrapper in the engine:
```python
HintResult(
    rule_name=rule.name,
    display_name=rule.name,
    explanation=f"{rule.name} eliminated {len(eliminations)} candidate(s).",
    highlight_cells=frozenset(e.cell for e in eliminations),
    eliminations=eliminations,
)
```

### Batch solver vs coaching engine

```python
# Batch solve — all rules drain:
engine = SolverEngine(board, rules=all_rules(), hint_rules=frozenset())

# Coaching — hint-only rules buffer:
hint_rule_names = frozenset(
    r.name for r in default_rules() if r.name not in always_apply
)
engine = SolverEngine(board, rules=default_rules(), hint_rules=hint_rule_names)
```

The hints endpoint reads `engine.pending_hints` after convergence. `collect_hints()` and
the `HintableRule` protocol are deleted.

### Files changed

- `solver_engine.py` — add `hint_rules`, `pending_hints`, conditional buffering
- `rule.py` — add optional `as_hint()` to protocol (with default implementation)
- `hint.py` — delete `collect_hints`, `HintableRule`; keep `HintResult`
- All six rule files — remove `compute_hints()`; add `as_hint()` where rich text needed
- `api/routers/puzzle.py` — hints endpoint reads `engine.pending_hints`
- Tests — update hint assertions to use `pending_hints`

---

## Slice 2 — Session store simplification

**Goal:** delete `CandidateGrid` / `CandidateCell` / `auto_candidates` / `user_essential`.
Replace `_compute_candidate_grid` with `_build_engine`.

### `_build_engine(state, always_apply)`

```python
def _build_engine(
    state: PuzzleState,
    always_apply: frozenset[str],
) -> tuple[BoardState, SolverEngine]:
    spec = _data_to_spec(state.spec_data)
    # 1. Fresh BoardState — real cages only, no LinearSystem virtual cages auto-injected
    board = BoardState(spec, include_virtual_cages=False)
    # 2. Add user-acknowledged virtual cages as additional cage units
    for vc in _user_virtual_cages(state):
        board.add_virtual_cage(vc.cells, vc.total, vc.eliminated_solns)
    # 3. Build engine
    hint_rule_names = frozenset(
        r.name for r in default_rules() if r.name not in always_apply
    )
    engine = SolverEngine(board, rules=default_rules(), hint_rules=hint_rule_names)
    # 4. Apply user grid (placed digits)
    engine.apply_eliminations(_user_eliminations(board, state.user_grid))
    # 5. Apply user-manually-removed candidates
    engine.apply_eliminations([
        Elimination(cell=(r, c), digit=d)
        for (r, c, d) in _user_removed(state)
    ])
    # 6. Run to convergence
    engine.solve()
    return board, engine
```

`_user_virtual_cages(state)` and `_user_removed(state)` are derived from `state.history`.

### `BoardState.add_virtual_cage()`

New method on `BoardState`:
```python
def add_virtual_cage(
    self,
    cells: frozenset[Cell],
    total: int,
    eliminated_solns: list[frozenset[int]],
) -> None:
    """Add a user-acknowledged virtual cage as a cage unit."""
    ...
```

Adds the cage unit, initialises `cage_solns` from `sol_sums`, then removes
`eliminated_solns` entries.

### `/candidates` response

Built from `board.candidates` and `board.cage_solns` after `_build_engine` completes.
Per-cage `must_contain` (intersection of remaining solutions) computed at serialisation
time — not stored.

### Files changed

- `api/schemas.py` — delete `CandidateGrid`, `CandidateCell`; add `Turn`, `UserAction`,
  `AutoMutation`, `BoardSnapshot`, `VirtualCage`
- `api/routers/puzzle.py` — replace `_compute_candidate_grid` and `_make_board_and_engine`
  with `_build_engine`; all endpoints use `_build_engine`
- `board_state.py` — add `add_virtual_cage()`
- `session.py` — update serialisation to handle new `PuzzleState` schema
- Tests — update to use new session schema; assert on `board.candidates` not
  `CandidateGrid`

---

## Slice 3 — Essential highlighting

**Goal:** remove `auto_essential` and `user_essential` from the frontend and API.
Essential candidates are highlighted automatically from `cage_solns`.

### API change

`/candidates` response per-cell payload gains no new field. Instead the response gains
a per-cage section:

```json
{
  "cells": [...],
  "cages": [
    {
      "cage_idx": 0,
      "cells": [[0,0],[0,1],[0,2]],
      "total": 15,
      "solutions": [[6,8,9],[5,8,9],...],
      "must_contain": [8,9]
    },
    ...
  ]
}
```

The frontend computes which cells to highlight by joining each cell to its cage's
`must_contain` set. No stored annotation needed.

### Frontend change

Remove the `user_essential` toggle and any "mark as essential" UI. The essential
highlight is always computed from `must_contain`. Colour/style the essential highlight
distinctly from the selected-candidate highlight.

### Files changed

- `api/schemas.py` — add `CageInfo` to candidates response
- `api/routers/puzzle.py` — populate `cages` in candidates response
- `static/main.ts` — remove `user_essential`; derive essential highlight from
  `cages[*].must_contain`

---

## Slice 4 — Virtual cage UI and user-management

**Goal:** users can discover, inspect, and interact with virtual cages (sum equations).
Virtual cages are never auto-injected — the user discovers them via a hintable rule or
manual cage arithmetic.

### `SumEquation` rule (new, replaces `LinearElimination` in coaching)

`SumEquation` is a hintable rule that queries `LinearSystem` for derivable sum equations
not yet in `user_virtual_cages`. When it fires (hint-only by default):

```
Hint: "Cells r1c1, r1c2, r2c3 must sum to 17 — this follows from the cage
       structure. You can use this constraint to narrow candidates."
```

Accepting the hint adds the virtual cage to `user_virtual_cages` with source
`"user:hint:SumEquation"`.

When `SumEquation` is always-apply, virtual cages are auto-added. Users who want
the system to handle this automatically can enable it in the config modal.

`LinearElimination` (the batch-solver version) remains in `incomplete_rules()` and
continues to use the full LinearSystem for maximum batch-solve power — it is not
the same as `SumEquation`.

### `DeltaConstraint` interaction

`DeltaConstraint` continues to use `LinearSystem.delta_pairs` internally. This is
independent of which virtual cages are in `user_virtual_cages`. The LinearSystem is
still built at `BoardState` construction time as an internal computation service; it
just does not automatically inject cage units.

### Cell inspection UI

Selecting a cell opens an inspection panel showing:

1. **Real cage section:**
   - Cage cells, total, remaining solutions
   - Must-contain set ("must include: 8, 9")
   - Eliminate-solution gesture (checkbox per solution)

2. **Virtual cages section** (one entry per `user_virtual_cage` containing this cell):
   - Cells, total, remaining solutions for that virtual cage
   - Must-contain set for that virtual cage (inline, not board-wide)
   - Eliminate-solution gesture

Virtual cage entries are selectable — selecting one highlights its cells on the board.

### Manual virtual cage construction

A separate UI gesture (e.g. "new sum group" button or multi-cell selection + total entry)
allows the user to define a virtual cage manually. This records a `UserAction` with
`type="add_virtual_cage"` and `source="user:manual"`.

### `virtual_cage_key`

A virtual cage is identified by its canonical key: sorted cell list + total, e.g.
`"0,0:0,1:1,2:17"`. This key is stable across sessions. When a `SumEquation` hint is
accepted, the key is used to check for duplicate addition.

### Files changed

- `solver/engine/rules/sum_equation.py` — new rule
- `solver/engine/rules/__init__.py` — add `SumEquation` to `default_rules()`
- `board_state.py` — `LinearSystem` built but no auto-injection (already changed in
  Slice 2)
- `api/schemas.py` — `VirtualCage` already added in Slice 2
- `api/routers/puzzle.py` — handle `add_virtual_cage` and
  `eliminate_virtual_cage_soln` user actions
- `static/main.ts` — cell inspection panel; virtual cage section; manual sum group UI

---

## Undo model

Each `Turn` in `history` bundles one user action with all auto-apply cascades it
triggered, plus a board snapshot at the end.

```
history: [
  Turn(user_action=place_digit(r3,c4,5), auto_mutations=[...], snapshot=...),
  Turn(user_action=eliminate_cage_soln(cage=2, soln={3,7}), auto_mutations=[...], snapshot=...),
  ...
]
```

**Undo:** `history.pop()`. Current board state = `history[-1].snapshot` (or initial
state if history is empty). The snapshot is a compact serialisation of
`candidates[9][9]` (as 9×9 lists of sorted digit lists) and `cage_solns` (per cage,
list of sorted-digit lists).

**What a single undo rolls back:**
- The user action (e.g. digit placement, hint acceptance, candidate elimination)
- All auto-apply rule cascades that followed from it (from `auto_mutations`)

This is the natural transaction boundary: the user did one thing; the engine reacted.
Undoing means the user's action did not happen.

**Auto-mutation recording:** after `engine.solve()` returns in `_build_engine`, the
engine exposes `self.applied_mutations: list[AutoMutation]` — the ordered list of every
`apply_eliminations` call that came from an always-apply rule (not from user inputs).
These are recorded into `Turn.auto_mutations`.

**Source annotation summary:**

| Scenario | Source value |
|---|---|
| Always-apply rule fired | `"auto:CellSolutionElimination"` etc. (in `AutoMutation.rule_name`) |
| User placed a digit | `"user:manual"` |
| User removed a candidate manually | `"user:manual"` |
| User accepted an elimination hint | `"user:hint:MustContainOutie"` etc. |
| User accepted a placement hint | `"user:hint:NakedSingle"` |
| User accepted a virtual cage hint | `"user:hint:SumEquation"` |
| User constructed virtual cage manually | `"user:manual"` |

---

## Implementation order

Slices 1 and 2 can proceed in parallel (different layers). Slices 3 and 4 depend on
Slice 2.

Recommended order within each slice: engine changes first, then API, then frontend.
Each slice ends with all tests passing and the system deployable.

**Slice 1 risks:**
- Rules need `as_hint()` for rich text; the default wrapper is a safety net but real
  rules should have proper implementations
- `NakedSingle` already has rich hint text — use it as the template for `as_hint()`

**Slice 2 risks:**
- Session migration: existing sessions use the old `CandidateGrid` schema. Provide a
  migration path or require a session reset (acceptable for dev; decide for prod)
- `_user_virtual_cages` and `_user_removed` reconstruction from history must be correct

**Slice 4 risks:**
- `LinearSystem` virtual cage count can be large; `SumEquation` rule needs to be
  selective about which equations are most useful to hint (prioritise short cell lists,
  tightest constraints)

---

## What is deleted

| Deleted | Replaced by |
|---|---|
| `CandidateGrid`, `CandidateCell` | `BoardSnapshot` in `Turn.snapshot` |
| `auto_candidates` field | `board.candidates` after `_build_engine` |
| `user_essential` field | Frontend derives from `cages[*].must_contain` |
| `auto_essential` field | Same |
| `_compute_candidate_grid()` | `_build_engine()` |
| `_make_board_and_engine()` | `_build_engine()` |
| `collect_hints()` | `engine.pending_hints` |
| `HintableRule` protocol | `as_hint()` method on rules (optional) |
| `compute_hints()` on all rules | `as_hint()` on rules that need rich text |
| `include_virtual_cages=True` auto-inject | `board.add_virtual_cage()` from session |

---

## Open questions (to resolve during implementation)

1. **Session migration strategy** — hard reset (clear existing sessions) or schema
   migration? Decide before Slice 2 lands.
2. **`SumEquation` hint prioritisation** — which sum equations to hint first? Shortest
   cell lists? Tightest must-contain sets? Needs a scoring heuristic.
3. **Board snapshot compactness** — candidates + cage_solns per turn may be large.
   Consider only snapshotting at the real cage solutions level and recomputing candidates
   cheaply. Benchmark before optimising.
4. **`LinearElimination` in `incomplete_rules()`** — does it remain as the batch-solver
   version of `SumEquation`, or do they share a common core? Decide during Slice 4.
