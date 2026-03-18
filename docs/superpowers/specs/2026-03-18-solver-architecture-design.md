# Solver Architecture Design

**Date:** 2026-03-18
**Status:** Approved for implementation planning

---

## Motivation

The current solver (`Grid.solve`) applies 13 rules in a fixed sequence inside a monolithic
loop. This works well — 461/465 Guardian and 413/424 Observer puzzles are solved by
propagation alone — but 10 Observer CheatTimeouts and 1 Guardian CheatTimeout indicate
the solver hands off too much unresolved state to the CSP fallback. The architecture also
makes it hard to add rules, tune ordering, or gather statistics.

Goals in priority order:
1. **Complete** — eliminate all CheatTimeouts by implementing missing rules
2. **Fast** — minimise solve time through smart rule scheduling
3. **Extensible** — new rules are easy to add; scheduling is data-driven

---

## Architecture decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Propagation model | Pull with dirty tracking | Same effective efficiency as push at sudoku scale; much simpler |
| Cascade placement | Yes — CELL_DETERMINED at priority 0 | Immediately chase naked-single chains before any other rule |
| Board state counts | Maintained incrementally on every removal | O(1) trigger detection; enables hint_digit on every call |
| Rule interface | Declarative self-describing (typed trigger set) | Enables learning; rules declare what they listen to |
| Linear system | Always-active component, not a fallback rule | Cheap enough (microseconds); subsumes window equations and difference constraints |

---

## Core types

### Units

A `Unit` is a typed, indexed group of cells. There are four kinds:

```
UnitKind: ROW | COL | BOX | CAGE
```

Global unit IDs: rows 0–8, columns 9–17, boxes 18–26, cages 27+. Each cell `(r, c)` belongs
to exactly four units: one of each kind. A `Unit` exposes its `frozenset[Cell]` and its
`UnitKind`.

### Triggers

```python
class Trigger(Enum):
    CELL_DETERMINED = 0    # sq_poss[r][c] became a singleton
    COUNT_HIT_ONE   = 1    # counts[unit][digit] just reached 1
    COUNT_HIT_TWO   = 2    # counts[unit][digit] just reached 2
    COUNT_DECREASED = 3    # counts[unit][digit] decreased (any amount)
    SOLUTION_PRUNED = 4    # a cage solution was eliminated
    GLOBAL          = 5    # fires when unit queue is otherwise empty
```

### Elimination

A value object representing a single inference:

```
Elimination(cell: Cell, digit: int)
```

Placing a digit is expressed as eliminating all other candidates from that cell — a batch
of up to 8 eliminations. The engine handles batches atomically.

---

## Board state

```
BoardState:
    candidates: array[9][9] of set[int]           # per-cell candidate sets
    counts: array[n_units][10] of int              # counts[unit_id][digit]
    cage_solns: list[list[frozenset[int]]]         # remaining valid cage assignments
    regions: array[9][9] of int                    # cage ID per cell
    linear_system: LinearSystem                    # live matrix (see below)
```

`BoardState.remove_candidate(r, c, d) -> list[tuple[Trigger, unit_id, digit]]` is the
**single mutation point**. It:

1. Removes `d` from `candidates[r][c]`
2. Decrements `counts[unit_id][d]` for all four units containing `(r, c)`
3. Updates the linear system (substitutes if `candidates[r][c]` became singleton)
4. Checks which triggers fired for each affected unit and returns them
5. Raises `NoSolnError` if any cell's candidate set becomes empty

The board state does not know about rules or the queue.

### The count structure

`counts[unit_id][digit]` is the number of cells in that unit that still have `digit` as a
candidate. Key invariants maintained at all times:

- `counts[unit][d] == 1` ↔ digit `d` is a hidden single in that unit
- `counts[unit][d] == 2` ↔ digit `d` is a hidden/naked pair candidate in that unit
- `counts[unit][d] == 0` ↔ digit `d` has been placed in that unit (or impossible)

Trigger thresholds are checked inside `remove_candidate`; the caller receives typed events.

---

## Linear system

The linear system is a first-class component of `BoardState`, not a rule. It is:

- **Built at setup** from all row, column, box, and cage sum equations
- **Reduced at setup** by Gaussian elimination over the rationals → initial constraints,
  difference pairs, and any directly-determined cells
- **Updated incrementally** on every `CELL_DETERMINED` event: the known value is
  substituted into all equations containing that cell; if this reduces any equation to a
  single unknown, that cell is immediately determined and `CELL_DETERMINED` is emitted

This subsumes both the current `add_equns`/`add_equns_r` window-equation construction and
the DFFS difference-constraint mechanism. Both were special cases of Gaussian elimination
over subsets of the available equations.

A **GLOBAL fallback** pass re-runs full Gaussian elimination on the residual system when the
unit queue empties without solving the puzzle. This catches multi-variable linear
combinations that incremental substitution misses.

---

## Rule interface

```python
class SolverRule(Protocol):
    name: str
    priority: int                     # lower = cheaper = runs first
    triggers: frozenset[Trigger]      # what activates this rule
    unit_kinds: frozenset[UnitKind]   # which unit types this rule applies to
                                       # (empty set = GLOBAL rule, receives all units)

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        ...
```

### RuleContext

```python
@dataclass
class RuleContext:
    unit: Unit                # the unit being processed (None for GLOBAL rules)
    board: BoardState         # full read access
    hint: Trigger             # which trigger fired
    hint_digit: int | None    # digit involved, if known (e.g. COUNT_HIT_ONE fires for d=5)
```

`hint_digit` allows rules to search only the changed digit rather than all nine. For example,
when `COUNT_HIT_ONE` fires for digit 5 in row 3, `HiddenSingle.apply` checks only digit 5.

### RuleStats

```python
@dataclass
class RuleStats:
    calls: int = 0            # times apply() was invoked
    progress: int = 0         # times at least one Elimination was returned
    eliminations: int = 0     # total eliminations across all calls
    elapsed_ns: int = 0       # total wall time

    @property
    def hit_rate(self) -> float:
        return self.progress / self.calls if self.calls else 0.0

    @property
    def utility(self) -> float:
        # yield per unit cost; used for priority calibration
        cost = self.elapsed_ns / self.calls if self.calls else 1.0
        return (self.eliminations / self.calls if self.calls else 0.0) / cost
```

---

## Engine

### Work item

The unit of scheduling is:

```
WorkItem(priority: int, rule: SolverRule, unit_id: int, trigger: Trigger, hint_digit: int | None)
```

The priority queue is a min-heap keyed on `(priority, rule.name, unit_id)`. Two items for
the same `(rule, unit_id)` pair are deduplicated: only one item is kept, with the lower
priority and the most recent trigger/hint.

### Version tracking

Each unit has an integer version counter that increments on any candidate removal in that
unit. A work item records the unit version at enqueue time. When popped, if the unit's
current version equals the recorded version, no changes have occurred since enqueue — skip
without calling the rule.

### Main loop

```
initialise:
    build BoardState from PuzzleSpec
    build and reduce LinearSystem → emit any initial Eliminations
    apply_eliminations(initial_eliminations)           # cascade from linear setup
    enqueue (GLOBAL sentinel) for initial global pass

while queue not empty:
    item = queue.pop()
    if unit_version_unchanged(item):
        continue                                       # stale, skip
    eliminations = item.rule.apply(RuleContext(...))
    stats[item.rule].record(eliminations)
    apply_eliminations(eliminations)                   # fires triggers, enqueues new work
    if queue contains only GLOBAL items and not fully_solved:
        run_global_rules()                             # X-Wing, full linear re-elimination

return BoardState
```

### apply_eliminations

```
apply_eliminations(eliminations):
    for cell, digit in eliminations:
        events = board.remove_candidate(cell, digit)
        for trigger, unit_id, hint_digit in events:
            if trigger == CELL_DETERMINED:
                for rule in trigger_map[CELL_DETERMINED]:
                    enqueue(priority=0, rule, unit_id, trigger, hint_digit)
            else:
                for rule in trigger_map[trigger]:
                    if unit_kind(unit_id) in rule.unit_kinds:
                        enqueue(rule.priority, rule, unit_id, trigger, hint_digit)
```

`CELL_DETERMINED` items always get `priority=0` regardless of the rule's nominal priority,
ensuring the cascade fires before anything else.

---

## Rule inventory

| # | Name | Priority | Triggers | Unit kinds | Status |
|---|------|----------|----------|------------|--------|
| R1 | Naked Single | 0 | `CELL_DETERMINED` | all | existing |
| R2 | Hidden Single | 1 | `COUNT_HIT_ONE` | all | existing |
| R3 | Cage Intersection | 2 | `COUNT_DECREASED`, `SOLUTION_PRUNED` | CAGE | existing |
| R4 | Solution Map Filter | 3 | `COUNT_DECREASED`, `SOLUTION_PRUNED` | CAGE | existing |
| R5 | Must-Contain | 4 | `COUNT_DECREASED` | all | existing |
| R7 | Naked Pair | 6 | `COUNT_HIT_TWO` | ROW, COL, BOX | **new** |
| R8 | Hidden Pair | 7 | `COUNT_HIT_TWO` | ROW, COL, BOX | existing |
| R9 | Naked/Hidden Triple | 8 | `COUNT_DECREASED` | ROW, COL, BOX | **new** |
| R10 | Pointing Pairs | 9 | `COUNT_DECREASED` | BOX | **new** |
| R12 | X-Wing | 11 | `GLOBAL` | — | **new** |
| R13 | Linear System | setup + 0.5 + `GLOBAL` | `CELL_DETERMINED`, `GLOBAL` | — | **elevated** |

Rules R6 (Difference Constraints) and R11 (Window Equations) are removed as standalone
rules — both are subsumed by the always-active Linear System component.

### Notes on new rules

**Naked Pair (R7)**: when exactly two cells in a unit share the same two candidates,
eliminate those candidates from all other cells. `hint_digit` narrows the search to the
changed digit's two candidate cells.

**Naked/Hidden Triple (R9)**: when three cells in a unit contain only candidates from a
set of three digits (naked), or three digits each appear in exactly three cells (hidden),
apply the corresponding elimination. `COUNT_DECREASED` trigger with no specific threshold;
runs after pairs.

**Pointing Pairs (R10)**: when a digit within a box is confined to cells lying in one row
or column, eliminate that digit from the rest of that row or column. An explicit
BOX-scoped rule is cheaper and more targeted than relying on Must-Contain (R5) to catch
this case.

**X-Wing (R12)**: when a digit's candidates in two rows are confined to the same two
columns (or vice versa), eliminate that digit from all other cells in those columns. GLOBAL
only — requires scanning across all rows simultaneously.

**Naked/Hidden Quad**: not included. In killer sudoku, cage constraints and the linear
system provide independent elimination paths that make quads redundant in practice. If
CheatTimeouts persist after R7–R13 are implemented, quads are the first candidate to add.

---

## Learning

### Offline priority calibration

After each evaluation run, `RuleStats` per rule are written to a persistent
`solver_stats.json` file. A calibration step computes `utility = yield_rate / cost_index`
for each rule and suggests priority adjustments: low-utility rules relative to their
priority slot are demoted; high-utility rules are promoted. Calibration is run offline
and the result updates default priorities in `SolverConfig`. Bounds prevent any rule from
being starved.

### Online sequence affinity

`RuleStats` also tracks a `TransitionMatrix: dict[rule_id, dict[rule_id, int]]` — how
often rule B made progress in the same solve after rule A made progress. After calibration
this becomes a conditional probability P(B makes progress | A just made progress). During
solving, when rule A makes an elimination, queued rules with high affinity for A get their
effective priority temporarily boosted — they jump the queue for the current cascade.

### Count-driven skip conditions

Rules receive `hint_digit` and can return immediately if the current unit state makes
progress impossible without scanning. For example, `NakedPair` receiving `hint_digit=5`
checks only whether digit 5's two candidate cells share a second digit — O(1) rather than
O(C(9,2)). This is structural rather than learned, but it is the per-digit targeted
re-evaluation the count structure enables.

---

## Migration

### What changes

| Component | Change |
|-----------|--------|
| `Grid.solve` | Replaced by the new `SolverEngine` |
| `Grid.add_equns`, `add_equns_r` | Replaced by `LinearSystem` setup |
| `Grid.elim_must` (DFFS part) | Replaced by `LinearSystem` incremental substitution |
| `Equation.avoid` / `sol_maps` | Become `SolutionMapFilter` and `CageIntersection` rules |
| `Grid.elim_must` (must-contain part) | Becomes `MustContain` rule |
| Hidden singles / pairs in solve loop | Become `HiddenSingle` / `HiddenPair` rules |

### What stays

| Component | Status |
|-----------|--------|
| `PuzzleSpec` | Unchanged — input to the new engine |
| `SolImage` | Unchanged — output from the new engine |
| `Equation` (data structure) | Kept as cage equation representation |
| `sol_sums` | Kept for enumerating valid cage assignments |
| `Grid.cheat_solve` | Kept as CSP fallback; called when engine returns unsolved state |
| `validate_cage_layout` | Unchanged |

The new engine is introduced as `killer_sudoku/solver/engine.py`. `Grid` is retained as a
thin wrapper that calls `engine.solve(spec)` and falls back to `cheat_solve` if needed,
preserving the existing interface for `main.py` and tests.
