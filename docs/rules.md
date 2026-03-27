# Solver Rules

This document is the primary reference for anyone implementing or upgrading solver
rules — human or AI. It covers the full architecture, every reference type, file
conventions, testing patterns, and a complete catalogue of existing rules.

---

## Architecture overview

The solver uses a **pull-with-dirty-tracking propagation loop**. When a candidate
is removed from a cell, `BoardState.remove_candidate` emits `BoardEvent`s. The
engine routes each event to every rule subscribed to that trigger and enqueues
work items. Rules are popped from a min-heap in priority order, handed a
`RuleContext`, and return a `list[Elimination]`. The engine applies the
eliminations, which may emit further events, and the loop continues until the queue
is empty.

Two separate phases use rules:

| Phase | How rules run |
|---|---|
| **Solve** | `SolverEngine.solve()` — event-driven, rules fire reactively |
| **Hint** | `collect_hints()` — board scan, rules called once on frozen board state |

In hint mode the engine has already converged; `compute_hints` receives a
snapshot and returns all currently applicable deductions as `HintResult` objects
for the UI to display.

---

## File and directory layout

```
killer_sudoku/
└── solver/
    └── engine/
        ├── types.py              # Cell, Unit, UnitKind, Trigger, Elimination, BoardEvent
        ├── rule.py               # SolverRule protocol, RuleContext, RuleStats
        ├── hint.py               # HintResult, HintableRule protocol, collect_hints()
        ├── board_state.py        # BoardState — all mutable state, single mutation point
        ├── solver_engine.py      # Main loop, trigger routing, apply_eliminations()
        ├── work_queue.py         # Priority min-heap with deduplication
        └── rules/
            ├── __init__.py       # default_rules() — the canonical ordered rule list
            ├── naked_single.py   # one file per rule class
            ├── solved_cell_elimination.py
            ├── cage_candidate_filter.py
            └── ...

killer_sudoku/
└── api/
    └── schemas.py                # DEFAULT_ALWAYS_APPLY_RULES — cold-start defaults

tests/
└── solver/
    └── engine/
        └── rules/
            ├── test_naked_single.py   # one test file per rule
            └── ...
    └── fixtures/
        └── minimal_puzzle.py     # make_trivial_spec(), make_two_cell_cage_spec(), …
```

**Key constraint:** All imports must be at file top level — no local imports. This
is enforced by ruff rule `PLC0415`.

---

## How to upgrade a rule to hintable

A rule becomes hintable **by construction** the moment its class has a
`compute_hints` method. No list registrations are needed anywhere.

### Step 1 — Add `compute_hints` to the rule class

```python
from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.types import Cell, Elimination

class MyRule:
    ...

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return one HintResult per distinct deduction instance on this board."""
        results: list[HintResult] = []
        # scan board, find firing conditions, build HintResult objects
        return results
```

**Critical constraint from `collect_hints`:** any `HintResult` whose
`eliminations` list is entirely empty — or entirely covered by hints from
higher-priority rules — is silently dropped. Every `HintResult` you return must
have at least one elimination that no earlier rule in `default_rules()` would also
produce.

**Known limitation:** when `SolvedCellElimination` is always-apply, it pre-empts
all naked-single peer eliminations before `compute_hints` runs. `NakedSingle.
compute_hints` therefore finds no new eliminations and returns empty. NakedSingle
hints only surface when `SolvedCellElimination` is demoted to hint-only. This is
an architectural issue: NakedSingle should be a placement hint, not an elimination
hint. See Known Design Issues in `docs/COACH.md`.

### Step 2 — Build each `HintResult`

```python
HintResult(
    rule_name=self.name,           # internal ID, matches the class name attribute
    display_name="My Rule Name",   # shown in the hint list UI
    explanation="Cell r3c5 ...",   # plain English; use rNcM 1-based notation
    highlight_cells=frozenset({(r, c), ...}),  # 0-based cells to highlight
    eliminations=[Elimination(cell=(r, c), digit=d), ...],
)
```

Explanation conventions:
- Use `r{r+1}c{c+1}` for cell labels (convert from 0-based to 1-based)
- Keep the explanation concise — one to three sentences
- State: what was observed, why it forces the deduction, what is eliminated

### Step 3 — Add imports at file top (never inline)

```python
from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.types import Cell, Elimination
```

### Step 4 — Document the rule in this file

Add a section to the Rule catalogue below (see existing sections for format).

### That's it

`GET /api/settings` discovers hintable rules automatically via
`isinstance(r, HintableRule)` over `default_rules()`. The frontend config modal
populates itself from that response. No `HINTABLE_RULES` list to update, no API
changes, no frontend changes.

**Cold-start defaults** are controlled solely by `DEFAULT_ALWAYS_APPLY_RULES` in
`killer_sudoku/api/schemas.py`. Rules not listed there default to hint-only. Only
add a rule to that list when it should be auto-applied for all new sessions.

---

## How to add a completely new rule

### Step 1 — Create the rule file

`killer_sudoku/solver/engine/rules/<snake_case_name>.py`

The file must begin with a module docstring explaining what the rule does and when
it fires. Keep the class and all its helpers in this single file.

### Step 2 — Implement `SolverRule`

`SolverRule` is a structural protocol — satisfy it by having these attributes:

```python
from __future__ import annotations

from killer_sudoku.solver.engine.board_state import BoardState
from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


class MyNewRule:
    """Brief description of the rule and its trigger."""

    name = "MyNewRule"            # must match the class name exactly
    priority = <int>              # lower number = higher priority = fired first
    triggers: frozenset[Trigger] = frozenset({Trigger.<TRIGGER>})
    unit_kinds: frozenset[UnitKind] = frozenset({UnitKind.<KIND>})
    # empty frozenset() for CELL_DETERMINED or GLOBAL rules (ctx.unit is None)

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Apply the rule; return candidate removals. Must not mutate board."""
        ...

    def compute_hints(self, board: BoardState) -> list[HintResult]:
        """Return all currently applicable hints for the given board state."""
        ...
```

### Step 3 — Register in `default_rules()`

In `killer_sudoku/solver/engine/rules/__init__.py`:

1. Add a top-level import: `from killer_sudoku.solver.engine.rules.my_new_rule import MyNewRule`
2. Update the priority comment block at the top of the file
3. Insert `MyNewRule()` in the correct priority position inside `default_rules()`

The comment block is the authoritative priority table — keep it accurate.

### Step 4 — Write tests

`tests/solver/engine/rules/test_<snake_case_name>.py`

See the Testing section below for patterns.

### Step 5 — Document in this file

Add a section to the Rule catalogue below.

---

## Reference: core types

All types live in `killer_sudoku/solver/engine/types.py` and
`killer_sudoku/solver/engine/rule.py`. Import from the full package path — never
relative imports.

### `Cell`

```python
Cell = tuple[int, int]   # (row, col), both 0-based
```

Cells are always 0-based internally. Convert to 1-based only in hint explanation
strings: `f"r{r + 1}c{c + 1}"`.

### `Elimination`

```python
@dataclasses.dataclass(frozen=True)
class Elimination:
    cell: Cell    # (row, col) 0-based
    digit: int    # 1–9
```

Return these from `apply()` and include them in `HintResult.eliminations`.

### `Trigger`

```python
class Trigger(Enum):
    CELL_DETERMINED = 0  # candidates[r][c] became a singleton
    COUNT_HIT_ONE   = 1  # counts[unit][digit] just reached 1 (hidden single)
    COUNT_HIT_TWO   = 2  # counts[unit][digit] just reached 2 (pair candidate)
    COUNT_DECREASED = 3  # counts[unit][digit] decreased by any amount
    SOLUTION_PRUNED = 4  # a cage solution was eliminated
    GLOBAL          = 5  # fires when the unit queue is otherwise empty
```

`GLOBAL` rules are re-enqueued after every board change so they get a fresh pass
after cheaper rules have narrowed candidates. Use GLOBAL for expensive scans
(X-Wing, CageConfinement) that are not naturally reactive to a single unit change.

### `UnitKind`

```python
class UnitKind(Enum):
    ROW  = "row"
    COL  = "col"
    BOX  = "box"
    CAGE = "cage"
```

### `Unit`

```python
@dataclasses.dataclass(frozen=True)
class Unit:
    unit_id:        int              # see unit ID layout below
    kind:           UnitKind
    cells:          frozenset[Cell]  # 0-based (r, c) pairs
    distinct_digits: bool = True     # False for non-burb derived sum constraints
```

**Unit ID layout:**

| Range | Contents |
|---|---|
| 0–8   | Rows (unit_id = row index) |
| 9–17  | Columns (unit_id = 9 + col index) |
| 18–26 | 3×3 boxes (unit_id = 18 + (r//3)*3 + c//3) |
| 27+   | Cages (unit_id = 27 + cage_index; virtual cages follow real ones) |

To get `cage_idx` from a cage unit: `cage_idx = unit.unit_id - 27`.

### `RuleContext`

```python
@dataclasses.dataclass
class RuleContext:
    unit:       Unit | None    # the triggering unit; None for CELL_DETERMINED and GLOBAL
    cell:       Cell | None    # set only for CELL_DETERMINED
    board:      BoardState
    hint:       Trigger        # the trigger that fired
    hint_digit: int | None     # digit that triggered; None for SOLUTION_PRUNED and GLOBAL
```

**What is populated by trigger:**

| Trigger | `ctx.unit` | `ctx.cell` | `ctx.hint_digit` |
|---|---|---|---|
| `CELL_DETERMINED` | None | `(r, c)` | the sole remaining digit |
| `COUNT_HIT_ONE`   | the unit | None | the digit that hit 1 |
| `COUNT_HIT_TWO`   | the unit | None | the digit that hit 2 |
| `COUNT_DECREASED` | the unit | None | the digit that decreased |
| `SOLUTION_PRUNED` | the cage unit | None | None |
| `GLOBAL`          | None | None | None |

Use `assert ctx.unit is not None` / `assert ctx.cell is not None` before
accessing these; mypy strict requires the assertion.

---

## Reference: `BoardState` read API

`BoardState` lives in `killer_sudoku/solver/engine/board_state.py`. Rules must
**only read** from it — never call mutating methods directly.

### Candidate sets

```python
board.candidates[r][c]   # set[int] — remaining candidates for cell (r, c), 0-based
                         # len == 1 → determined; len == 0 → contradiction (NoSolnError raised)
```

### Units

```python
board.units              # list[Unit] — all units in unit-ID order
board.cell_unit_ids(r, c)  # list[int] — all unit IDs for cell (r, c)
board.row_unit_id(r)     # int — unit ID for row r
board.col_unit_id(c)     # int — unit ID for col c
board.box_unit_id(r, c)  # int — unit ID for the box containing (r, c)
board.cage_unit_id(r, c) # int — unit ID for the cage containing (r, c)
```

### Cage solutions

```python
board.cage_solns[cage_idx]   # list[frozenset[int]] — remaining valid digit sets for cage
                              # cage_idx = unit_id - 27 for any cage unit
```

Each element is one possible assignment of distinct digits to the cage cells (the
set of digits, not which cell holds which). `len == 0` means the cage is
unsolvable.

### Digit counts

```python
board.counts[unit_id][d]     # int — how many cells in unit still have digit d as a candidate
```

### Region map

```python
board.regions[r, c]          # numpy scalar — 0-based cage index for cell (r, c)
```

### Iterating cage cells

```python
cage_unit_id = board.cage_unit_id(r, c)
cage_idx = cage_unit_id - 27
cage_cells: frozenset[Cell] = board.units[cage_unit_id].cells
```

### Iterating non-cage unit peers of a cell

```python
for uid in board.cell_unit_ids(r, c):
    unit = board.units[uid]
    if unit.kind == UnitKind.CAGE:
        continue   # cage peers handled separately by cage rules
    for pr, pc in unit.cells:
        if (pr, pc) != (r, c):
            ...
```

---

## Reference: `HintResult`

```python
@dataclasses.dataclass(frozen=True)
class HintResult:
    rule_name:       str               # internal ID = self.name
    display_name:    str               # shown in the hint list
    explanation:     str               # plain English, rNcM 1-based notation
    highlight_cells: frozenset[Cell]   # 0-based cells to highlight on canvas
    eliminations:    list[Elimination] # candidate removals this hint would make
```

`collect_hints` drops any `HintResult` whose `eliminations` are entirely covered
by earlier rules. Always return non-empty `eliminations` that are genuinely new.

---

## Reference: `HintableRule` protocol

```python
@runtime_checkable
class HintableRule(Protocol):
    name: str
    def compute_hints(self, board: BoardState) -> list[HintResult]: ...
```

Any class with `name: str` and `compute_hints` satisfies this protocol — no
inheritance needed. The `isinstance(r, HintableRule)` check in the settings
router uses `@runtime_checkable` to discover all hintable rules at startup.

---

## Testing patterns

### Test file location

```
tests/solver/engine/rules/test_<snake_case_rule_name>.py
```

### Minimal board setup

```python
from killer_sudoku.solver.engine.board_state import BoardState
from tests.fixtures.minimal_puzzle import make_trivial_spec

spec = make_trivial_spec()   # 81 single-cell cages — simplest valid puzzle
bs = BoardState(spec)
```

**Available fixture factories** (all in `tests/fixtures/minimal_puzzle.py`):

| Factory | What it produces |
|---|---|
| `make_trivial_spec()` | 81 single-cell cages; every cage is already solved |
| `make_two_cell_cage_spec()` | cells (0,0)+(0,1) form one 2-cell cage (total 8) |
| `make_three_cell_cage_spec()` | cells (0,0)+(0,1)+(0,2) form one 3-cell cage (total 12) |

For rules that need custom cage geometry, build a spec directly:

```python
import numpy as np
from killer_sudoku.image.validation import validate_cage_layout
from tests.fixtures.minimal_puzzle import (
    make_trivial_cage_totals, make_trivial_border_x, make_trivial_border_y
)

totals = make_trivial_cage_totals().copy()
totals[0, 5] = 24   # cage head; other cells in cage get 0
totals[0, 6] = 0
totals[0, 7] = 0

border_x = make_trivial_border_x().copy()
border_x[0, 5] = False  # remove wall between (0,5) and (0,6) in col 0
border_x[0, 6] = False  # remove wall between (0,6) and (0,7) in col 0

spec = validate_cage_layout(totals, border_x, make_trivial_border_y())
bs = BoardState(spec)
```

**Border convention** — easily confused:

- `border_x[col, row]`: wall between rows `row` and `row+1` in column `col`
  (wall between BoardState cells `(row, col)` and `(row+1, col)`)
- `border_y[row, col]`: wall between columns `col` and `col+1` in row `row`
  (wall between BoardState cells `(row, col)` and `(row, col+1)`)

### Manually narrowing candidates

```python
bs.candidates[0][0] = {5}         # pin cell (0,0) to a single candidate
bs.candidates[0][1] = {3, 5, 7}   # restrict candidates directly
```

You can also override `board.cage_solns[cage_idx]` directly to set up specific
must-contain sets without running the full engine.

### Building `RuleContext`

```python
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Trigger

ctx = RuleContext(
    unit=bs.units[bs.row_unit_id(0)],  # for unit-scoped rules
    cell=None,
    board=bs,
    hint=Trigger.COUNT_DECREASED,
    hint_digit=5,
)

# For CELL_DETERMINED rules (ctx.unit is None):
ctx = RuleContext(
    unit=None,
    cell=(0, 0),
    board=bs,
    hint=Trigger.CELL_DETERMINED,
    hint_digit=5,
)
```

### Typical test structure

```python
def test_my_rule_eliminates_digit() -> None:
    """Rule fires when <condition>; eliminates digit D from cell (r, c)."""
    bs = BoardState(make_trivial_spec())
    # … set up board state …
    ctx = RuleContext(unit=..., cell=..., board=bs, hint=Trigger.X, hint_digit=...)
    elims = MyRule().apply(ctx)
    assert Elimination(cell=(r, c), digit=d) in elims


def test_my_rule_hint() -> None:
    """compute_hints returns a hint with the expected explanation and eliminations."""
    bs = BoardState(make_trivial_spec())
    # … set up board state …
    hints = MyRule().compute_hints(bs)
    assert len(hints) == 1
    assert Elimination(cell=(r, c), digit=d) in hints[0].eliminations
    assert "r1c1" in hints[0].explanation
```

### Running the quality gate before committing

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

All four must pass. Never commit with a failing gate.

---

## Keeping this document current

**This file is part of the implementation contract.** Update it whenever you:

- Add a new rule (add a section to the catalogue below)
- Upgrade a rule to hintable (add/update the hint behaviour and template)
- Change a rule's default mode (update the **Default** tag and cold-start note)
- Change a trigger, priority, or unit_kinds
- Rename or remove a rule

The document is read by AI agents in future sessions to understand the rules
architecture. An out-of-date `rules.md` will cause implementers to make
wrong assumptions and produce bugs. Treat it the same way you would treat
a docstring or a test — if you change behaviour, you change the doc.

---

## Rule catalogue

Rules are listed in `default_rules()` priority order. **Default** shows the
cold-start behaviour; users can change any rule's mode via the config modal.

---

### NakedSingle

**Priority:** 0 · **Trigger:** `CELL_DETERMINED` · **Default:** hint-only

**Spec:**
A cell with only one remaining candidate must hold that digit. Recognition-only:
`apply()` returns no eliminations — the engine already handled the promotion.
Exists as a named rule so the hint layer can surface it.

**Hint behaviour:**
Finds all cells with exactly one remaining candidate, bundles them into one hint,
and reports the row/col/box peer digit-eliminations that placing those digits
would produce. These eliminations are only present on the board when
`SolvedCellElimination` is demoted to hint-only — otherwise it has already applied
them and no hint fires.

**Hint template (single):**
> Cell r*N*c*M* has only one remaining candidate: *D*. It must be *D*.

**Hint template (multiple):**
> *K* naked singles: r*N*c*M* must be *D*; …

---

### SolvedCellElimination

**Priority:** 0 · **Trigger:** `CELL_DETERMINED` · **Default:** always-apply

**Spec:**
Once a cell is determined to hold digit *d*, *d* cannot appear in any other cell
of the same row, column, or 3×3 box. All peer candidates are eliminated. (Cage
peers are handled by separate cage rules.)

**Hint behaviour:**
Identical logic to `NakedSingle.compute_hints`. This method exists so the rule
can serve as hint-only when the user demotes it via the config modal. When it is
always-apply (the default), `collect_hints` skips it and `NakedSingle` covers
the hint side.

**Hint template (single):**
> Cell r*N*c*M* has only one remaining candidate: *D*. It must be *D*.

**Hint template (multiple):**
> *K* naked singles: r*N*c*M* must be *D*; …

---

### CageCandidateFilter

**Priority:** 2 · **Trigger:** `COUNT_DECREASED`, `SOLUTION_PRUNED` (CAGE) · **Default:** always-apply

**Spec:**
For each cage, the candidates of every cell in that cage must be a subset of the
union of the cage's remaining solutions. Any candidate digit that does not appear
in any valid solution for the cage is impossible and is eliminated.

Example: a 3-cell cage has only the solution {6, 8, 9}. Every cell in that cage
must have candidates drawn from {6, 8, 9}; digits 1–5 and 7 are eliminated from
all three cells.

**Hint template:**
> Cell *X* is in cage [*cells*] (total *T*). Digit *D* does not appear in any
> valid solution for this cage, so it cannot be placed there. Eliminating *D*
> from *X*.

---

### MustContainOutie

**Priority:** 4 · **Trigger:** `COUNT_DECREASED`, `SOLUTION_PRUNED` (all units) · **Default:** hint-only

**Spec:**
A cage must contain certain digits in every one of its solutions (its
"must-contain" set). When all but one cell of the cage lie inside a single row,
column, or box (the "inside cells"), and exactly one external cell in that unit
has all its candidates within the cage's must-contain set, then whichever digit
the external cell holds is blocked from every inside cell by unit-uniqueness. The
cage still needs that digit, so it must land on the one cage cell outside the unit
(the "outie"). The outie's candidates are therefore restricted to the candidates
of the external cell.

Example: cage {r1c6, r1c7, r1c8, r2c8} must contain {6, 7, 8, 9}. Cells r1c6,
r1c7, r1c8 are all in row 1; r2c8 is the outie. Cell r1c3 (outside the cage,
also in row 1) has candidates {6, 8, 9} — all within {6, 7, 8, 9}. Whichever of
{6, 8, 9} r1c3 holds, row uniqueness blocks it from r1c6, r1c7, r1c8. The cage
must therefore place that digit at r2c8. So r2c8's candidates are restricted to
{6, 8, 9}, eliminating 7.

**Hint template:**
> Cage [*cells*] must contain {*must*}. Cell *X* has candidates {*x_cands*} —
> all digits are in the cage's must-contain set. Since *X* is in *unit* along
> with cage cells *inside_cells*, whichever digit *X* holds is blocked from those
> cells by *unit* uniqueness. The cage must therefore place that digit at the outie
> *outie* (the only cage cell outside *unit*). So *outie*'s candidates are
> restricted to {*x_cands*}, eliminating *removed*.

---

### CageConfinement(n)

**Priority:** 12 · **Trigger:** `GLOBAL` · **Default:** hint-only

**Spec:**
Let n ≥ 1. Find n distinct cages C₁, …, Cₙ and n distinct units U₁, …, Uₙ of
the same type (all rows, all columns, or all boxes) such that for some digit d:

1. d is essential (must-contain) for every cage Cᵢ.
2. Every cell in ⋃ Cᵢ that still has d as a candidate lies within ⋃ Uⱼ.
3. At least one cell in (⋃ Uⱼ) \ (⋃ Cᵢ) has d as a candidate.

Then d can be eliminated from every cell in (⋃ Uⱼ) \ (⋃ Cᵢ).

**Reasoning:** U₁, …, Uₙ are pairwise disjoint (distinct units of the same
type). Each unit must contain exactly one copy of d, so ⋃ Uⱼ contains exactly n
copies. Each cage Cᵢ must contain one copy (condition 1), and every possible
placement is inside ⋃ Uⱼ (condition 2). By pigeonhole the n cages consume all n
available copies; no cell outside the cages but inside the units can hold d.

**n = 1 example:** After MustContainOutie restricts r2c8 to {6, 8, 9}, digit 7
has candidates only at r1c6, r1c7, r1c8 within cage r1c6 — all in row 1. Since 7
is essential to that cage and all its placements are in row 1, 7 is eliminated
from every other cell in row 1 outside the cage.

**n = 2 example:** Digits {6, 8, 9} are essential to both cage r1c3 and cage
r1c6; all cells of both cages lie in rows 1 and 2. Rows 1 and 2 jointly contain
exactly two copies of each of {6, 8, 9}, and both cages need one copy each.
Therefore {6, 8, 9} are eliminated from rows 1 and 2 outside these two cages.

**Complexity:** For a fixed digit and unit type the search is O(Cₙ × Uₙ) where
Cₙ = C(|cages|, n) and Uₙ = C(27, n) (9 rows + 9 cols + 9 boxes). n = 1 is
cheap; n = 2 is tractable; n ≥ 3 is expensive and hard for humans to follow.

**Hint template (n = 1):**
> Digit *d* is essential to cage [*cells*] and can only be placed in *unit* cells
> of that cage (*confined_cells*). Since *unit* must contain exactly one *d*, it
> must land in the cage. Eliminating *d* from *removed_cells*.

**Hint template (n = 2):**
> Digit *d* is essential to cages [*C₁_cells*] and [*C₂_cells*]. Every possible
> placement of *d* in either cage lies within *unit₁* or *unit₂*. Those two
> *unit_type*s contain exactly two copies of *d*, both of which are claimed by
> these cages. Eliminating *d* from *removed_cells* in *unit₁* and *unit₂*.

---

### SolutionMapFilter

**Priority:** 3 · **Trigger:** `COUNT_DECREASED`, `SOLUTION_PRUNED` (CAGE) · **Default:** hint-only

**Spec:**
For each cage, tests every remaining solution against the current per-cell
candidates using backtracking. Solutions where no feasible per-cell digit
assignment exists are pruned from `cage_solns`. Any `(cell, digit)` pair that
does not appear in any feasible assignment across all surviving solutions is
eliminated. Skips non-distinct virtual cages (handled by `MustContain`).

**Hint template:**
> Cage *X* (sum=*T*) has solutions *S₁* or *S₂* or …. [*N* solution(s) pruned.]
> Mapping feasible solutions to cells eliminates: *d* from r*R*c*C*, …

---

## Rules not yet hintable

The following rules exist in `default_rules()` but have no `compute_hints`
implementation. They **cannot** be added to always-apply via the config modal
(the modal only lists `HintableRule` instances) and produce no hints. They are
effectively inactive in the coaching app until given hint implementations.

Rules are listed in priority order:

| Rule | Priority | Trigger | Notes |
|---|---|---|---|
| `LinearElimination` | 1 | `GLOBAL` | Algebraic cage-sum linear system. Requires `include_virtual_cages=True` on `BoardState`. |
| `HiddenSingle` | 5 | `COUNT_HIT_ONE` (ROW/COL/BOX) | Digit appears in exactly one cell in a unit. |
| `CageIntersection` | 6 | `SOLUTION_PRUNED` (CAGE) | Cage must-contain digit confined to one row/col/box. |
| `MustContain` | 7 | `COUNT_DECREASED`, `SOLUTION_PRUNED` (CAGE) | Cage must-contain digit cannot appear in non-cage cells of that unit. |
| `DeltaConstraint` | 8 | `CELL_DETERMINED` | Propagates `x - y = k` difference constraints from the linear system. |
| `SumPairConstraint` | 9 | `COUNT_HIT_ONE` (CAGE) | Two cage cells summing to a fixed value restrict each other's candidates. |
| `NakedPair` | 10 | `COUNT_HIT_TWO` (ROW/COL/BOX) | Two cells share the same two candidates; eliminates from rest of unit. |
| `HiddenPair` | 10 | `COUNT_HIT_TWO` (ROW/COL/BOX) | Two digits appear in only the same two cells; eliminates other candidates from those cells. |
| `NakedHiddenTriple` | 11 | `COUNT_DECREASED` (ROW/COL/BOX) | Three-cell naked/hidden triple generalisation. |
| `NakedHiddenQuad` | 11 | `COUNT_DECREASED` (ROW/COL/BOX) | Four-cell naked/hidden quad generalisation. |
| `PointingPairs` | 12 | `GLOBAL` | Digit in a box confined to one row/col eliminates from rest of that row/col. |
| `LockedCandidates` | 12 | `GLOBAL` | Digit in a row/col confined to one box eliminates from rest of that box. |
| `UnitPartitionFilter` | 12 | `GLOBAL` | Digit group occupies a subset of a unit, eliminating from the rest. |
| `XWing` | 13 | `GLOBAL` | Digit in two rows confined to same two columns (or vice versa). |
| `Swordfish` | 14 | `GLOBAL` | Three-row/column generalisation of X-Wing. |
| `Jellyfish` | 15 | `GLOBAL` | Four-row/column generalisation of X-Wing. |
| `XYWing` | 16 | `GLOBAL` | Three-cell chain where pivot shares a candidate with each wing; eliminates from cells seeing both wings. |
| `UniqueRectangle` | 17 | `GLOBAL` | Uniqueness-based elimination: a rectangle of four cells cannot have the same two candidates in all four. |
| `SimpleColouring` | 18 | `GLOBAL` | Single-digit chain colouring to identify forced placements or contradictions. |
