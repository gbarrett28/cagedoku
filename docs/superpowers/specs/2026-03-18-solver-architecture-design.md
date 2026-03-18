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

### BoardEvent

The typed return value from `BoardState` mutation methods:

```python
@dataclass(frozen=True)
class BoardEvent:
    trigger: Trigger
    payload: tuple[int, int] | int   # Cell (r, c) for CELL_DETERMINED; unit_id otherwise
    hint_digit: int | None           # digit involved, or None for SOLUTION_PRUNED
```

`apply_eliminations` consumes `list[BoardEvent]` from `remove_candidate` and
`list[BoardEvent]` from `remove_cage_solution`, routing each event to the queue by
inspecting `event.trigger`.

---

## Board state

```
BoardState:
    candidates: array[9][9] of set[int]           # per-cell candidate sets
    counts: array[n_units][10] of int              # counts[unit_id][digit]
    cage_solns: list[list[frozenset[int]]]         # remaining valid cage assignments
    regions: array[9][9] of int                    # cage ID per cell
    linear_system: LinearSystem                    # live matrix (see below)
    unit_versions: array[n_units] of int          # incremented on every candidate removal
                                                   # in that unit; used for stale-item detection
```

`BoardState.remove_candidate(r, c, d) -> list[BoardEvent]` is the **single mutation point**.
It:

1. Removes `d` from `candidates[r][c]`
2. Decrements `counts[unit_id][d]` for all four units containing `(r, c)`
3. Updates the linear system (substitutes if `candidates[r][c]` became singleton)
4. Prunes any cage solution for the cage containing `(r, c)` that assigns `d` to cell
   `(r, c)`: calls `_prune_cage_solutions(cage_id, r, c, d)` internally and appends
   `BoardEvent(SOLUTION_PRUNED, cage_unit_id, None)` for each removed solution
5. Checks which other triggers fired and appends those events:
   - `BoardEvent(CELL_DETERMINED, (r, c), d)` if `candidates[r][c]` became a singleton
   - `BoardEvent(COUNT_HIT_ONE, unit_id, d)` / `BoardEvent(COUNT_HIT_TWO, unit_id, d)` /
     `BoardEvent(COUNT_DECREASED, unit_id, d)` for each of the four containing units
6. Raises `NoSolnError` if any cell's candidate set becomes empty

`BoardState.remove_cage_solution(cage_id: int, solution: frozenset[int]) -> BoardEvent`
removes `solution` from `cage_solns[cage_id]` (by value, not by index — uses `.remove()`)
and returns `BoardEvent(SOLUTION_PRUNED, cage_unit_id, None)`. Called exclusively by
`_prune_cage_solutions` (internal to `BoardState`).

**Rules must not call `BoardState` mutators directly.** All mutation is mediated through
`apply_eliminations` → `remove_candidate`. R4's `apply()` returns only `list[Elimination]`;
the engine applies those eliminations through the normal path, which triggers further cage
solution pruning inside `remove_candidate`. There is no secondary event path.

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
the linear-sum part of the DFFS mechanism — both are special cases of Gaussian elimination.

However, **difference pairs** of the form `x − y = δ` that Gaussian elimination finds
cannot be applied by further Gaussian steps; they require candidate narrowing:
`candidates[p] ∩= {m − δ | m ∈ candidates[q]}` applied iteratively until fixed-point.
This is handled by the reinstated **DeltaConstraint rule (R6)**: LinearSystem produces
the set of active delta pairs at setup and updates it as cells are determined; R6 fires on
`COUNT_DECREASED` and propagates candidate restrictions for each pair involving the
changed unit.

A **GLOBAL fallback** pass re-runs full Gaussian elimination on the residual system when the
unit queue empties without solving the puzzle. This catches multi-variable linear
combinations that incremental substitution misses.

### LinearSystem API used by R6

```python
class LinearSystem:
    delta_pairs: list[tuple[Cell, Cell, int]]
    # Active difference pairs (p, q, delta) meaning candidates[p] - candidates[q] = delta.
    # Pairs are removed when both cells are determined.

    def pairs_for_cell(self, cell: Cell) -> list[tuple[Cell, Cell, int]]:
        # Returns all active delta pairs where cell is either p or q.
        # Backed by a per-cell index for O(k) lookup where k is pairs per cell.
        ...
```

R6 receives `ctx.unit` (a set of cells) and calls `linear_system.pairs_for_cell(c)` for
each cell `c` in `ctx.unit`, collecting relevant pairs, then applies candidate narrowing
for each pair. Pairs where neither cell is in `ctx.unit` are not processed.

---

## Rule interface

```python
class SolverRule(Protocol):
    name: str
    priority: int                     # lower = cheaper = runs first
    triggers: frozenset[Trigger]      # what activates this rule
    unit_kinds: frozenset[UnitKind]   # which unit types this rule applies to
                                       # (empty set = GLOBAL rule; unit=None in RuleContext)

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        ...
```

### RuleContext

```python
@dataclass
class RuleContext:
    unit: Unit | None         # the unit being processed; None for CELL_DETERMINED and GLOBAL
    cell: Cell | None         # set for CELL_DETERMINED; None for unit-scoped and GLOBAL rules
    board: BoardState         # full read access
    hint: Trigger             # which trigger fired
    hint_digit: int | None    # digit involved, if known (e.g. COUNT_HIT_ONE fires for d=5)
```

`hint_digit` allows rules to search only the changed digit rather than all nine. For example,
when `COUNT_HIT_ONE` fires for digit 5 in row 3, `HiddenSingle.apply` checks only digit 5.

For `CELL_DETERMINED`: `unit=None`, `cell=(r, c)`, `hint_digit=digit`. The NakedSingle rule
(R1) uses `cell` to place the digit; DeltaConstraint (R6) also fires on CELL_DETERMINED
and uses `cell` to substitute the known value into active delta pairs.

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

Work items have two forms depending on whether the trigger is cell-scoped or unit-scoped:

```
# Unit-scoped (all triggers except CELL_DETERMINED and GLOBAL)
WorkItem(priority: int, rule: SolverRule, unit_id: int, unit_version: int,
         trigger: Trigger, hint_digit: int | None)

# Cell-scoped (CELL_DETERMINED only) — no version tracking
WorkItem(priority: int = 0, rule: SolverRule, cell: Cell,
         trigger: CELL_DETERMINED, hint_digit: int)

# GLOBAL (no unit or cell) — no version tracking
WorkItem(priority: int, rule: SolverRule, trigger: GLOBAL, hint_digit: None)
```

`unit_version` records `board.unit_versions[unit_id]` at the time of enqueue. The
`unit_version_unchanged(item)` check in the main loop compares this against
`board.unit_versions[item.unit_id]`; equal means no candidate was removed in that unit
since the item was enqueued — the rule can be skipped.

The priority queue is a min-heap. Deduplication keys:
- Unit-scoped items: `(rule, unit_id)` — one item per rule/unit pair; lower priority wins
- Cell-scoped items: `(rule, cell)` — one item per rule/cell pair
- GLOBAL items: `(rule,)` — one item per GLOBAL rule

### Version tracking

Each unit has an integer version counter that increments on any candidate removal in that
unit. A work item records the unit version at enqueue time. When popped, if the unit's
current version equals the recorded version, no changes have occurred since enqueue — skip
without calling the rule.

**CELL_DETERMINED and GLOBAL items are never version-skipped.** CELL_DETERMINED items
represent a specific one-time event (a cell's candidates became a singleton) and must
always be processed. GLOBAL items have no associated unit, so no version applies; they are
always run when dequeued.

### Main loop

```
initialise:
    build BoardState from PuzzleSpec
    build and reduce LinearSystem → emit any initial Eliminations
    apply_eliminations(initial_eliminations)           # cascade from linear setup
    enqueue (GLOBAL sentinel) for initial global pass

while queue not empty:
    item = queue.pop()
    # CELL_DETERMINED and GLOBAL items are never version-skipped (see Version tracking)
    if item.trigger not in (CELL_DETERMINED, GLOBAL) and unit_version_unchanged(item):
        continue                                       # stale, skip
    eliminations = item.rule.apply(RuleContext(...))
    stats[item.rule].record(eliminations)
    apply_eliminations(eliminations)                   # fires triggers, enqueues new work
    # GLOBAL items are processed through the normal loop — no separate function needed.
    # When the queue contains only GLOBAL items, they are popped and applied as usual;
    # eliminations from X-Wing or linear re-elimination feed back into apply_eliminations.

return BoardState
```

### apply_eliminations

```
apply_eliminations(eliminations):
    for cell, digit in eliminations:
        events = board.remove_candidate(cell, digit)   # list[BoardEvent]
        for event in events:
            if event.trigger == CELL_DETERMINED:
                # event.payload is the cell (r, c) — not a unit ID
                for rule in trigger_map[CELL_DETERMINED]:
                    enqueue(priority=0, rule, cell=event.payload, trigger=CELL_DETERMINED,
                            hint_digit=event.hint_digit)
            elif event.trigger == SOLUTION_PRUNED:
                # event.payload is cage_unit_id; hint_digit is None
                unit_id = event.payload
                for rule in trigger_map[SOLUTION_PRUNED]:
                    enqueue(rule.priority, rule, unit_id, SOLUTION_PRUNED, None)
            else:
                # event.payload is unit_id; filter rules by unit kind
                unit_id = event.payload
                for rule in trigger_map[event.trigger]:
                    if unit_kind(unit_id) in rule.unit_kinds:
                        enqueue(rule.priority, rule, unit_id, event.trigger,
                                event.hint_digit)
```

`CELL_DETERMINED` items always get `priority=0` regardless of the rule's nominal priority,
ensuring the cascade fires before anything else. No `unit_kinds` filter is applied to
CELL_DETERMINED rules — they are cell-scoped and their `unit_kinds` field is unused.
`SOLUTION_PRUNED` events come from within `remove_candidate` (cage solution pruning is
inline) and are routed to all rules in `trigger_map[SOLUTION_PRUNED]` (R3 and R4).

---

## Rule inventory

| # | Name | Priority | Triggers | Unit kinds | Status |
|---|------|----------|----------|------------|--------|
| R1 | Naked Single | 0 | `CELL_DETERMINED` | — (cell-scoped) | existing |
| R2 | Hidden Single | 1 | `COUNT_HIT_ONE` | all | existing |
| R3 | Cage Intersection | 2 | `COUNT_DECREASED`, `SOLUTION_PRUNED` | CAGE | existing |
| R4 | Solution Map Filter | 3 | `COUNT_DECREASED`, `SOLUTION_PRUNED` | CAGE | existing |
| R5 | Must-Contain | 4 | `COUNT_DECREASED` | all | existing |
| R6 | Delta Constraint | 5 | `COUNT_DECREASED`, `CELL_DETERMINED` | all | **reinstated** |
| R7 | Naked Pair | 6 | `COUNT_HIT_TWO` | ROW, COL, BOX | **new** |
| R8 | Hidden Pair | 7 | `COUNT_HIT_TWO` | ROW, COL, BOX | existing |
| R9 | Naked/Hidden Triple | 8 | `COUNT_DECREASED` | ROW, COL, BOX | **new** |
| R10 | Pointing Pairs | 9 | `COUNT_DECREASED` | BOX | **new** |
| ~~R11~~ | ~~Window Equations~~ | — | — | — | removed (subsumed by LinearSystem) |
| R12 | X-Wing | 11 | `GLOBAL` | — | **new** |

**LinearSystem** is a `BoardState` component, not a `SolverRule` — it does not appear in
the rule table and does not go through the priority queue. It is active at setup (builds
and Gaussian-reduces the equation system), on every `remove_candidate` call (incremental
substitution), and as a GLOBAL pass when the queue empties.

### Notes on reinstated and new rules

**Delta Constraint (R6)**: the LinearSystem finds all difference pairs `x − y = δ` after
Gaussian elimination at setup and updates the live set as cells are determined. R6 applies
candidate narrowing for each pair: `candidates[p] ∩= {m − δ | m ∈ candidates[q]}`, run
to fixed-point. Fires on `COUNT_DECREASED` (any unit touching either cell in a pair) and
on `CELL_DETERMINED` (substitutes the known value directly). This is distinct from
Gaussian elimination — it is iterative candidate filtering over integer domains.

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
CheatTimeouts persist after R6–R12 are implemented, quads are the first candidate to add.

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
| `Grid.elim_must` (DFFS linear part) | Replaced by `LinearSystem` setup + incremental substitution |
| `Grid.elim_must` (DFFS delta pairs) | Replaced by `DeltaConstraint` (R6) |
| `Equation.avoid` | Becomes internal logic of `SolutionMapFilter` (R4) |
| `sol_maps` | Becomes internal logic of `SolutionMapFilter` (R4) |
| `Grid.elim_must` (must-contain part) | Becomes `MustContain` rule (R5) |
| Hidden singles / pairs in solve loop | Become `HiddenSingle` (R2) / `HiddenPair` (R8) rules |

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
