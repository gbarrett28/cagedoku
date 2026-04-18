/**
 * BoardState — all mutable solver state for one puzzle.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.board_state` module.
 *
 * Rules read from this object but must never mutate it directly.
 * All mutations go through remove_candidate() or remove_cage_solution().
 *
 * Classic and killer sudoku share this data structure:
 *  - Killer: cage_totals populated → cage_solns from sol_sums
 *  - Classic: cage_totals all-zero → cage_solns all empty → cage rules are no-ops
 */

import { solSums } from '../solver/equation.js';
import { NoSolnError } from '../solver/errors.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import { LinearSystem } from './linearSystem.js';
import {
  BoardEvent,
  Cell,
  Trigger,
  Unit,
  UnitKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Precomputed box cell lists: boxCells[b] = all cells in box b (0-based)
// ---------------------------------------------------------------------------

function buildBoxCells(): readonly (readonly Cell[])[] {
  return Array.from({length: 9}, (_, b) => {
    const cells: Cell[] = [];
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++)
        cells.push([(b / 3 | 0) * 3 + dr, (b % 3) * 3 + dc] as unknown as Cell);
    return cells;
  });
}

const BOX_CELLS: readonly (readonly Cell[])[] = buildBoxCells();

// ---------------------------------------------------------------------------
// BoardState
// ---------------------------------------------------------------------------

export class BoardState {
  readonly spec: PuzzleSpec;
  readonly units: Unit[];
  /** candidates[r][c] = set of remaining digits for cell (r, c) */
  candidates: Set<number>[][];
  /** counts[unitId][digit] = number of cells in that unit still having digit */
  counts: number[][];
  unitVersions: number[];
  /** cage_solns[cage_idx] = remaining feasible digit sets for that cage */
  cageSolns: number[][][];
  /** regions[r][c] = 0-based cage index */
  regions: number[][];
  linearSystem: LinearSystem;

  private _cellUnitIds: number[][][]; // [9][9] → list of unit_ids

  constructor(spec: PuzzleSpec, { includeVirtualCages = true } = {}) {
    this.spec = spec;

    // Convert regions to 0-based (spec uses 1-based cage IDs)
    this.regions = Array.from({length: 9}, (_, r) =>
      Array.from({length: 9}, (__, c) => spec.regions[r][c] - 1));
    const nCages = Math.max(...this.regions.flat()) + 1;

    // Build cage cell lists (0-based index)
    const cageCellsList: Cell[][] = Array.from({length: nCages}, () => []);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        cageCellsList[this.regions[r][c]].push([r, c] as unknown as Cell);

    // Build unit list: rows 0-8, cols 9-17, boxes 18-26, real cages 27+
    this.units = [];
    for (let r = 0; r < 9; r++)
      this.units.push({ unitId: r, kind: UnitKind.ROW,
        cells: Array.from({length: 9}, (_, c) => [r, c] as unknown as Cell), distinctDigits: true });
    for (let c = 0; c < 9; c++)
      this.units.push({ unitId: 9 + c, kind: UnitKind.COL,
        cells: Array.from({length: 9}, (_, r) => [r, c] as unknown as Cell), distinctDigits: true });
    for (let b = 0; b < 9; b++)
      this.units.push({ unitId: 18 + b, kind: UnitKind.BOX, cells: BOX_CELLS[b], distinctDigits: true });
    for (let idx = 0; idx < nCages; idx++)
      this.units.push({ unitId: 27 + idx, kind: UnitKind.CAGE, cells: cageCellsList[idx], distinctDigits: true });

    // Real cage solutions via sol_sums
    this.cageSolns = cageCellsList.map(cells => {
      let total = 0;
      for (const [r, c] of cells) {
        const v = spec.cageTotals[r][c];
        if (v !== 0) { total = v; break; }
      }
      return solSums(cells.length, 0, total);
    });

    // Build LinearSystem (this is the expensive step)
    this.linearSystem = new LinearSystem(spec, { deriveVirtualCages: includeVirtualCages });

    // Add virtual cage units from the linear system
    for (const [vcells, vtotal, distinct, precompSolns] of includeVirtualCages ? this.linearSystem.virtualCages : []) {
      const vunitId = this.units.length;
      const cells = vcells as unknown as Cell[];
      this.units.push({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });
      if (precompSolns !== null) {
        this.cageSolns.push(precompSolns);
      } else {
        this.cageSolns.push(solSums(cells.length, 0, vtotal));
      }
    }

    const nUnits = this.units.length;

    // Per-cell unit ID lookup
    this._cellUnitIds = Array.from({length: 9}, () => Array.from({length: 9}, () => []));
    for (const unit of this.units)
      for (const [r, c] of unit.cells)
        this._cellUnitIds[r][c].push(unit.unitId);

    // Candidates: start full (all digits 1-9)
    this.candidates = Array.from({length: 9}, () =>
      Array.from({length: 9}, () => new Set(Array.from({length: 9}, (_, i) => i + 1))));

    // Counts: digit appears in all cells of each unit initially
    this.counts = Array.from({length: nUnits}, (_, uid) => {
      const row = new Array<number>(10).fill(0);
      for (let d = 1; d <= 9; d++) row[d] = this.units[uid].cells.length;
      return row;
    });

    this.unitVersions = new Array<number>(nUnits).fill(0);
  }

  // ── Unit ID accessors ────────────────────────────────────────────────────

  rowUnitId(r: number): number { return r; }
  colUnitId(c: number): number { return 9 + c; }
  boxUnitId(r: number, c: number): number { return 18 + (r / 3 | 0) * 3 + (c / 3 | 0); }
  cageUnitId(r: number, c: number): number { return 27 + this.regions[r][c]; }
  cellUnitIds(r: number, c: number): number[] { return this._cellUnitIds[r][c]; }

  // ── Mutation ─────────────────────────────────────────────────────────────

  /**
   * Remove digit d from candidates[r][c]; update counts, versions, emit events.
   *
   * This is the single mutation point for candidate sets. Steps:
   *  1. Remove d from candidates[r][c]
   *  2. Decrement counts[unitId][d] for all units containing (r, c)
   *  3. Emit COUNT_DECREASED / COUNT_HIT_TWO / COUNT_HIT_ONE as counts change
   *  4. Emit CELL_DETERMINED if candidates[r][c] becomes a singleton
   *  5. Prune cage solutions that are now impossible
   *  6. Raise NoSolnError if candidates[r][c] would become empty
   */
  removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const cands = this.candidates[r][c];
    if (!cands.has(d)) return [];
    if (cands.size === 1) throw new NoSolnError(`Cannot remove last candidate ${d} from (${r},${c})`);

    cands.delete(d);
    const events: BoardEvent[] = [];

    for (const uid of this.cellUnitIds(r, c)) {
      const prev = this.counts[uid][d];
      const next = prev - 1;
      this.counts[uid][d] = next;
      this.unitVersions[uid]++;
      events.push({ trigger: Trigger.COUNT_DECREASED, payload: uid, hintDigit: d });
      if (next === 2) events.push({ trigger: Trigger.COUNT_HIT_TWO, payload: uid, hintDigit: d });
      else if (next === 1) events.push({ trigger: Trigger.COUNT_HIT_ONE, payload: uid, hintDigit: d });
    }

    if (cands.size === 1) {
      const sole = next(cands);
      events.push({ trigger: Trigger.CELL_DETERMINED, payload: [r, c] as unknown as Cell, hintDigit: sole });
    }

    // Prune cage solutions for all cage units containing this cell
    for (const uid of this.cellUnitIds(r, c)) {
      if (this.units[uid].kind === UnitKind.CAGE) {
        events.push(...this._pruneCageSolutions(uid - 27, r, c, d));
      }
    }

    return events;
  }

  removeCageSolution(cageIdx: number, solution: readonly number[]): BoardEvent {
    const solns = this.cageSolns[cageIdx];
    const idx = solns.findIndex(s => s.length === solution.length && s.every((d, i) => d === solution[i]));
    if (idx >= 0) solns.splice(idx, 1);
    const cageUnitId = 27 + cageIdx;
    return { trigger: Trigger.SOLUTION_PRUNED, payload: cageUnitId, hintDigit: null };
  }

  private _pruneCageSolutions(cageIdx: number, r: number, c: number, d: number): BoardEvent[] {
    const cageUnit = this.units[27 + cageIdx];
    // If d is still possible somewhere in the cage, nothing to prune
    if (cageUnit.cells.some(([cr, cc]) => this.candidates[cr][cc].has(d))) return [];
    // Remove all solutions containing d
    const toRemove = this.cageSolns[cageIdx].filter(s => s.includes(d));
    return toRemove.map(s => this.removeCageSolution(cageIdx, s));
  }

  /**
   * Add a user-acknowledged virtual cage as a new cage unit.
   */
  addVirtualCage(
    cells: readonly Cell[],
    total: number,
    eliminatedSolns: readonly (readonly number[])[],
    { distinct = true } = {},
  ): void {
    const vunitId = this.units.length;
    this.units.push({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });

    const elimSet = new Set(eliminatedSolns.map(s => s.slice().sort().join(',')));
    const solns = solSums(cells.length, 0, total)
      .filter(s => !elimSet.has(s.slice().sort().join(',')));
    this.cageSolns.push(solns);

    const countsRow = new Array<number>(10).fill(0);
    for (let d = 1; d <= 9; d++)
      countsRow[d] = cells.filter(([r, c]) => this.candidates[r][c].has(d)).length;
    this.counts.push(countsRow);
    this.unitVersions.push(0);

    for (const [r, c] of cells) this._cellUnitIds[r][c].push(vunitId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function next<T>(s: Set<T>): T {
  return s.values().next().value as T;
}

/** Validate that a fully-solved board satisfies all row/col/box constraints. */
export function validateSolution(board: BoardState): string[] {
  const violations: string[] = [];
  for (const unit of board.units) {
    if (unit.kind === UnitKind.CAGE) continue; // cage validation is separate
    const digits = unit.cells.map(([r, c]) => next(board.candidates[r][c]));
    const uniq = new Set(digits);
    if (uniq.size !== 9 || ![...uniq].every(d => d >= 1 && d <= 9))
      violations.push(`Unit ${unit.unitId} (${UnitKind[unit.kind]}) has duplicate or invalid digits`);
  }
  return violations;
}
