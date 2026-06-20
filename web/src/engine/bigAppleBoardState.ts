/**
 * BigAppleBoardState — classic board plus 4 offset 3×3 "window" regions.
 *
 * Big Apple Sudoku (aka Hyper Sudoku / Windoku): classic sudoku rules plus 4
 * extra non-aligned 3×3 regions, each requiring digits 1-9 exactly once.
 * Windows reuse UnitKind.BOX (not a new enum value) so every rule already
 * gating on UnitKind.BOX automatically covers them — see docs/big-apple-sudoku.md.
 */

import { BoardState } from './boardState.js';
import { Cell, UnitKind } from './types.js';

// 0-based top-left corner of each window, in row-major reading order.
export const WINDOW_STARTS: readonly (readonly [number, number])[] = [
  [1, 1], // top-left
  [5, 1], // bottom-left
  [1, 5], // top-right
  [5, 5], // bottom-right
];

function buildWindowCells(r0: number, c0: number): readonly Cell[] {
  const cells: Cell[] = [];
  for (let dr = 0; dr < 3; dr++)
    for (let dc = 0; dc < 3; dc++)
      cells.push([r0 + dr, c0 + dc] as Cell);
  return cells;
}

export class BigAppleBoardState extends BoardState {
  private readonly _windowPeers: Cell[][][];

  constructor() {
    super();
    this._windowPeers = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [] as Cell[]));
    for (const [r0, c0] of WINDOW_STARTS) {
      const cells = buildWindowCells(r0, c0);
      this._addUnit({ unitId: this.units.length, kind: UnitKind.BOX, cells, distinctDigits: true });
      for (const [r, c] of cells) {
        this._windowPeers[r]![c] = cells.filter(([r2, c2]) => !(r2 === r && c2 === c));
      }
    }
  }

  override extraPeers(r: number, c: number): readonly Cell[] {
    return this._windowPeers[r]![c]!;
  }
}
