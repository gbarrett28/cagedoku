/**
 * Label helpers shared by all rule hint implementations.
 *
 */

import type { Cell } from '../types.js';
import { UnitKind } from '../types.js';
import type { Unit } from '../types.js';

export function cellLabel([r, c]: Cell): string {
  return `r${r + 1}c${c + 1}`;
}

const WINDOW_LABELS_BY_CORNER: ReadonlyMap<string, string> = new Map([
  ['1,1', 'top-left window'],
  ['5,1', 'bottom-left window'],
  ['1,5', 'top-right window'],
  ['5,5', 'bottom-right window'],
]);

export function unitLabel(unit: Unit): string {
  const cells = unit.cells as Cell[];
  switch (unit.kind) {
    case UnitKind.ROW: return `row ${cells[0]![0] + 1}`;
    case UnitKind.COL: return `col ${cells[0]![1] + 1}`;
    case UnitKind.BOX: {
      const windowLabel = WINDOW_LABELS_BY_CORNER.get(`${cells[0]![0]},${cells[0]![1]}`);
      if (windowLabel !== undefined) return windowLabel;
      const br = (cells[0]![0] / 3 | 0) + 1;
      const bc = (cells[0]![1] / 3 | 0) + 1;
      return `box (${br},${bc})`;
    }
    default: {
      const labels = cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(cellLabel);
      return `cage [${labels.join(', ')}]`;
    }
  }
}

export function unitTypeLabel(kind: UnitKind): string {
  switch (kind) {
    case UnitKind.ROW: return 'rows';
    case UnitKind.COL: return 'columns';
    case UnitKind.BOX: return 'boxes';
    default: return 'cages';
  }
}

/** Returns the unit ID of a given kind for cell (r, c). */
export function typeUnitId(kind: UnitKind, r: number, c: number): number {
  switch (kind) {
    case UnitKind.ROW: return r;
    case UnitKind.COL: return 9 + c;
    case UnitKind.BOX: return 18 + (r / 3 | 0) * 3 + (c / 3 | 0);
    default: throw new Error(`typeUnitId: unexpected kind ${kind}`);
  }
}
