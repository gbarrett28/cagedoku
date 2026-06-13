# `PuzzleState.cageBoundaries` / `PuzzleState.cageLabels` Design

**Date:** 2026-06-13
**Branch:** TBD (new feature branch for implementation)

## Goal

Add two pure `PuzzleState` namespace functions that consolidate the killer-cage
geometry currently computed inline (with `isKiller`/`specData` checks) in
`main.ts`'s `drawCageBorders` and `drawCageTotals`. Classic returns `[]` from
both. This is the next slice of the §6 "Display methods" remaining work from
`docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`.

## Scope

This sprint covers **only** `cageBoundaries` and `cageLabels` — the two
genuinely new pure-geometry extractions. `cageDisplay`/`virtualCageDisplay`
are **not** part of this sprint: `candidatesFromBoard()`
(`session/actions.ts`) already returns `cages`/`virtualCages` arrays shaped
almost exactly like the spec's `CageRender`/`VirtualCageRender` (label, cells,
total, solutions, allSolutions, autoImpossible, userEliminated, mustContain).
That existing shape will be documented as satisfying the spec's intent and
marked shipped without further code changes.

## New types

Added to `web/src/session/types.ts`, alongside `RenderColour`/`CellRender`:

```typescript
/** A single edge of the grid where a cage boundary should be drawn. */
export interface BorderSegment {
  readonly row: number;    // 0-8
  readonly col: number;    // 0-8
  readonly edge: 'bottom' | 'right'; // boundary on this cell's bottom or right edge
}

/** A cage-total label anchored at a cage's head cell. */
export interface CageLabelRender {
  readonly row: number;  // 0-8, head cell of the cage
  readonly col: number;  // 0-8
  readonly total: number;
}
```

## `cageBoundaries(state): readonly BorderSegment[]`

- Classic (`!PuzzleState.isKiller(state)`) → `[]`.
- Killer: iterate `state.specData.regions` (9×9, 0-based cage indices). For
  each cell `(r,c)`:
  - if `r < 8` and `regions[r][c] !== regions[r+1][c]`, emit
    `{ row: r, col: c, edge: 'bottom' }`.
  - if `c < 8` and `regions[r][c] !== regions[r][c+1]`, emit
    `{ row: r, col: c, edge: 'right' }`.
- This is a direct port of `drawCageBorders`'s non-draft branch — same
  comparisons, same edges, emitted as data instead of drawn immediately.

## `cageLabels(state): readonly CageLabelRender[]`

- Classic → `[]`.
- Killer: iterate `state.specData.cageTotals` (9×9); for each cell with
  `total !== 0`, emit `{ row: r, col: c, total }`. Direct port of
  `drawCageTotals`'s totals loop, minus the canvas drawing.

## `main.ts` changes

- `drawCageBorders`'s non-draft branch (the `else` branch, lines ~301-322) is
  replaced by:
  ```typescript
  for (const seg of PuzzleState.cageBoundaries(state)) {
    if (seg.edge === 'bottom') {
      const y = MARGIN + (seg.row + 1) * CELL;
      ctx.beginPath(); ctx.moveTo(MARGIN + seg.col * CELL, y); ctx.lineTo(MARGIN + (seg.col + 1) * CELL, y); ctx.stroke();
    } else {
      const x = MARGIN + (seg.col + 1) * CELL;
      ctx.beginPath(); ctx.moveTo(x, MARGIN + seg.row * CELL); ctx.lineTo(x, MARGIN + (seg.row + 1) * CELL); ctx.stroke();
    }
  }
  ```
  The **draft branch is untouched** — it operates on local
  `draftBorderX`/`draftBorderY` UI state during OCR review, which isn't part
  of `PuzzleState`.
- `drawCageTotals`'s body is replaced by:
  ```typescript
  for (const label of PuzzleState.cageLabels(state)) {
    const x = MARGIN + label.col * CELL + 2;
    const y = MARGIN + label.row * CELL + 2;
    const text = String(label.total);
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 1, y - 1, tw + 2, TOTAL_FONT_PX + 1);
    ctx.fillStyle = '#111';
    ctx.fillText(text, x, y);
  }
  ```
  (font setup unchanged, runs before the loop).
- Both functions keep their `isKiller`/empty-array early-return behaviour
  implicitly (empty array → loop body never runs), so no explicit `isKiller`
  check remains in either function.

## Testing

New `describe('PuzzleState.cageBoundaries')` / `describe('PuzzleState.cageLabels')`
blocks in `engine.test.ts`:
- Killer fixture (`makeState()`, which uses a known `regions`/`cageTotals`
  shape from `engine/fixtures.ts`) produces the expected segments/labels.
- Classic fixture (`PuzzleState.createClassic(...)`) returns `[]` for both.

## Docs

- Add a `### PuzzleState.cageBoundaries / cageLabels` subsection to
  `docs/architecture.md`, alongside the existing `candidateDisplay` subsection.
- Update `docs/superpowers/specs/2026-06-06-puzzle-state-redesign.md`:
  - Move `cageBoundaries`/`cageLabels` from "Remaining work" to "Shipped".
  - Add a note that `cageDisplay`/`virtualCageDisplay` are satisfied by
    `candidatesFromBoard`'s existing `cages`/`virtualCages` output (pointing
    to `candidatesFromBoard` in `session/actions.ts`) and mark them shipped
    too.
  - Remaining work after this sprint: §7 Serialization, §8 Out of scope only.
