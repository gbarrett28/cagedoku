# Sprint B: `PuzzleState.candidateDisplay()` Design

## Context

Per `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md` §6 "Display methods",
remaining work includes extracting cell/candidate rendering attributes into
`namespace PuzzleState`. The original §6 listed five methods
(`candidateDisplay`, `cageBoundaries`, `cageLabels`, `cageDisplay`,
`virtualCageDisplay`); this sprint implements **`candidateDisplay`** only. The
remaining four are cage-geometry/virtual-cage concerns and are deferred to a
later sprint.

**Overall goal (per CLAUDE.md and project direction):** move case analysis
(killer vs classic, given vs user-placed, duplicate detection, must-contain
highlighting) into `PuzzleState`/board methods so that `main.ts`'s drawing
code becomes dumb — it reads attributes and draws, with no puzzle-type or
correctness logic of its own. This reduces the risk of bugs where a case
isn't propagated correctly, by containing each case's logic in one place.

## Scope

**In scope:** `PuzzleState.candidateDisplay(state, board): readonly CellRender[][]`,
consolidating the per-cell digit/candidate attribute logic currently spread
across `drawDigits` (`main.ts:362-395`) and `drawCandidates` (`main.ts:397-435`).

**Out of scope (deferred):**
- `drawHintDigitMarkers` (`main.ts:442-499`) — depends on `activeHintItem`,
  a transient UI-interaction value, not `PuzzleState`.
- `drawUnderlays` (`main.ts:185-273`) — selection/highlight/colouring overlays,
  all UI-only state (`selectedCell`, `hintColourGroups`, `cellColours`,
  `virtualCageSelection`, etc.).
- `cageBoundaries`, `cageLabels`, `cageDisplay`, `virtualCageDisplay` — cage
  geometry and virtual-cage panel rendering; a separate sprint.

## Types

Added to `web/src/session/types.ts`:

```typescript
/** Visual colour category for a rendered digit or candidate. */
export type RenderColour = 'black' | 'blue' | 'red' | 'grey' | 'essential';

export interface CandidateRender {
  readonly digit: number;          // 1-9
  readonly visible: boolean;       // true if digit is a live candidate (board.cands has it)
  readonly strikethrough: boolean; // true if user manually removed this candidate
  readonly colour: RenderColour;   // 'essential' if must-contain for its cage, else 'grey'
}

export interface CellRender {
  /** Non-null if this cell has a placed digit (given or user-entered). */
  readonly placed: { readonly digit: number; readonly colour: RenderColour; readonly locked: boolean } | null;
  /** Empty if `placed !== null`. One entry per digit 1-9 that is either a live or user-removed candidate. */
  readonly candidates: readonly CandidateRender[];
}
```

Notes:
- `CandidateRender[]` only includes digits that are either currently a
  candidate (`visible: true`) or were user-removed (`strikethrough: true`,
  `visible: false`). Digits eliminated by the solver (never user-removed, not
  in `board.cands`) are omitted entirely — this matches current `drawCandidates`
  behaviour, which only draws candidates or user-removed strikes, never solver
  eliminations.
- `colour: 'essential'` applies only to `visible` candidates whose digit is in
  the must-contain set for that cell's cage (from `board.cageConstraints()`).
  For classic puzzles (`board.cageConstraints() === null`), no candidate is
  ever `'essential'`.
- `placed.colour`:
  - `'red'` if this cell's digit duplicates another in its row/column/box
    (existing `findDuplicateCells` logic, ported in).
  - `'blue'` if `state.goldenSolution !== null` and the cell is not a given
    digit (i.e. it was filled in via reveal/solve, not part of the original
    puzzle).
  - `'black'` otherwise.
- `placed.locked`:
  - For killer puzzles: always `false` (killer has no "given digits" — the
    grid starts empty).
  - For classic puzzles: `true` iff the cell is a given digit
    (`state.givenDigits?.[r]?.[c] > 0`).

## Function signature

```typescript
export namespace PuzzleState {
  export function candidateDisplay(state: PuzzleState, board: BoardState): readonly CellRender[][];
}
```

Returns a 9×9 array (row-major, per project convention). Pure function of
`state` and `board` — no UI state, no module-level mutable variables.

## `main.ts` call sites

**`drawDigits`** (`main.ts:362-395`) becomes:

```typescript
function drawDigits(ctx: CanvasRenderingContext2D, state: PuzzleState, board: BoardState): void {
  const display = PuzzleState.candidateDisplay(state, board);
  ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const { placed } = display[r]![c]!;
      if (placed === null) continue;
      ctx.fillStyle = colourToCss(placed.colour);
      ctx.fillText(String(placed.digit), MARGIN + c * CELL + CELL / 2, MARGIN + r * CELL + CELL / 2);
    }
  }
}
```

The duplicate-highlight fill (`rgba(220, 38, 38, 0.15)` background squares,
`main.ts:367-374`) stays in `drawDigits` — it's a cell-background underlay, not
a digit attribute, but it can derive its cell set from
`display[r][c].placed?.colour === 'red'` instead of calling
`findDuplicateCells` directly.

**`drawCandidates`** (`main.ts:397-435`) becomes:

```typescript
function drawCandidates(
  ctx: CanvasRenderingContext2D,
  state: PuzzleState,
  board: BoardState,
  showEss: boolean,
): void {
  const display = PuzzleState.candidateDisplay(state, board);
  const CAND_TOP = 13;
  const SUB_W = CELL / 3; const SUB_H = (CELL - CAND_TOP) / 3;
  ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      for (const cand of display[r]![c]!.candidates) {
        const subRow = Math.floor((cand.digit - 1) / 3); const subCol = (cand.digit - 1) % 3;
        const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
        const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
        if (cand.strikethrough) {
          ctx.fillStyle = '#d1d5db'; ctx.fillText(String(cand.digit), cx, cy);
          const hw = SUB_W * 0.35;
          ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cx - hw, cy); ctx.lineTo(cx + hw, cy); ctx.stroke();
        } else if (cand.visible) {
          ctx.fillStyle = (cand.colour === 'essential' && showEss) ? '#cc5a45' : '#888';
          ctx.fillText(String(cand.digit), cx, cy);
        }
      }
    }
  }
}
```

Note `showEss` (a UI toggle) stays a `main.ts`-only concern — `candidateDisplay`
always reports the true `'essential'` colour; `main.ts` decides whether to
render it differently when `showEss` is off.

A small `colourToCss(c: RenderColour): string` helper maps
`'black' → '#000'`, `'blue' → '#2563eb'`, `'red' → '#dc2626'` (the two colours
`drawDigits` needs; `'grey'`/`'essential'` are candidate-only and handled
inline in `drawCandidates` as today).

**`drawGrid`** (`main.ts:501-530`) computes a cheap board via
`buildEngine(state, { skipSolve: true }).board` and always calls `drawDigits`
with it (see "Resolved" section below for why `skipSolve: true` is sufficient
for `.placed`). `drawCandidates` continues to be called only
`if (showCands && currentBoard !== null && state.goldenSolution !== null)`,
using the fully-solved `currentBoard` (see below).

## Testing

New `describe('PuzzleState.candidateDisplay', ...)` block in
`web/src/session/engine.test.ts`:
- Empty cell with live candidates → `placed: null`, `candidates` includes
  those digits with `visible: true, strikethrough: false`.
- User-removed candidate → appears with `visible: false, strikethrough: true`.
- Solver-eliminated digit (not in `board.cands`, not user-removed) → absent
  from `candidates`.
- Given digit (classic) → `placed.locked === true`, `colour: 'black'`.
- User-placed digit, no golden solution → `placed.locked === false`,
  `colour: 'black'`.
- User-placed digit with `goldenSolution` set, not a given → `colour: 'blue'`.
- Duplicate digit in a row → `colour: 'red'` for both cells.
- Killer puzzle, candidate in cage's must-contain set → `colour: 'essential'`.
- Classic puzzle → no candidate is ever `'essential'`.

## Resolved: `board` availability at `drawGrid` call sites

`candidateDisplay(state, board)` always requires a `board` (for
`candidates[].visible`/`strikethrough`/`'essential'`), but `drawDigits` only
reads `.placed`, which depends solely on `state` (digits, duplicates,
`goldenSolution`, `givenDigits`) — it is unaffected by which `board` is passed.

Two-tier approach, both via `buildEngine` (`session/engine.ts`):
- **`drawDigits`** (called unconditionally from `drawGrid`): `drawGrid` computes
  `const board = buildEngine(state, { skipSolve: true }).board` — cheap (no
  rule-solving pass, same option already used by `computeAnimationCandidates`)
  — and passes it to `drawDigits`. Its `.candidates` output is unused and
  irrelevant to correctness.
- **`drawCandidates`** (called only when `showCandidates`): continues to need
  the fully-solved board. Add `export function computeBoard(state: PuzzleState):
  BoardState { return buildEngine(state).board; }` to `session/actions.ts`
  (thin wrapper, same pattern as `computeCandidates`). `main.ts` adds a
  module-level `currentBoard: BoardState | null`, set alongside
  `currentCandidates` in `fetchCandidates` via `computeBoard(currentState)`.
  `drawCandidates` is called only when `currentBoard !== null` (mirroring the
  existing `currentCandidates !== null` guard) and uses `currentBoard`.
