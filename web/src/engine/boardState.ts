/**
 * BoardState — plain row/col/box sudoku skeleton shared by classic and killer
 * boards. KillerBoardState (below) extends it with cage modelling.
 *
 * The classic/killer split keeps classic boards free of cage machinery (see
 * `docs/superpowers/specs/2026-06-07-cage-free-board-state-for-classic.md`).
 *
 * Rules read from this object but must never mutate it directly.
 * All mutations go through removeCandidate() (or, on KillerBoardState,
 * removeCageSolution()).
 */

import { solSums, solDiffs } from '../solver/equation.js';
import type { DiffSolution } from '../solver/equation.js';
import { NoSolnError } from '../solver/errors.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import type { CageConstraints } from './backtracker.js';
import { LinearSystem } from './linearSystem.js';
import {
  BoardEvent,
  Cell,
  Elimination,
  Trigger,
  Unit,
  UnitKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Unit layout constants: units[] is partitioned as rows / cols / boxes / cages
// ---------------------------------------------------------------------------

export const ROW_UNIT_OFFSET = 0;   // indices 0–8
export const COL_UNIT_OFFSET = 9;   // indices 9–17
export const BOX_UNIT_OFFSET = 18;  // indices 18–26
export const CAGE_UNIT_OFFSET = 27; // indices 27+

// ---------------------------------------------------------------------------
// Precomputed box cell lists: boxCells[b] = all cells in box b (0-based)
// ---------------------------------------------------------------------------

function buildBoxCells(): readonly (readonly Cell[])[] {
  return Array.from({length: 9}, (_, b) => {
    const cells: Cell[] = [];
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++)
        cells.push([(b / 3 | 0) * 3 + dr, (b % 3) * 3 + dc] as Cell);
    return cells;
  });
}

const BOX_CELLS: readonly (readonly Cell[])[] = buildBoxCells();

// ---------------------------------------------------------------------------
// KillerBoardState
// ---------------------------------------------------------------------------

export class BoardState {
  readonly units: Unit[];
  /** candidates[r][c] = set of remaining digits for cell (r, c). Use cands(r,c) for safe read access. */
  candidates: Set<number>[][];
  /** counts[unitId][digit] = number of cells in that unit still having digit. Use count(uid,d) for safe read access. */
  counts: number[][];
  unitVersions: number[];

  private _cellUnitIds: number[][][]; // [9][9] → list of unit_ids

  constructor() {
    this.units = [];
    this._cellUnitIds = Array.from({length: 9}, () => Array.from({length: 9}, () => []));
    this.candidates = Array.from({length: 9}, () =>
      Array.from({length: 9}, () => new Set(Array.from({length: 9}, (_, i) => i + 1))));
    this.counts = [];
    this.unitVersions = [];

    for (let r = 0; r < 9; r++)
      this._addUnit({ unitId: ROW_UNIT_OFFSET + r, kind: UnitKind.ROW,
        cells: Array.from({length: 9}, (_, c) => [r, c] as Cell), distinctDigits: true });
    for (let c = 0; c < 9; c++)
      this._addUnit({ unitId: COL_UNIT_OFFSET + c, kind: UnitKind.COL,
        cells: Array.from({length: 9}, (_, r) => [r, c] as Cell), distinctDigits: true });
    for (let b = 0; b < 9; b++)
      this._addUnit({ unitId: BOX_UNIT_OFFSET + b, kind: UnitKind.BOX, cells: BOX_CELLS[b]!, distinctDigits: true });
  }

  // ── Safe read accessors (invariant: 9×9 board and nUnits always initialised) ─

  /** Candidates for cell (r, c). Indices are always 0–8 by solver invariant. */
  cands(r: number, c: number): Set<number> { return this.candidates[r]![c]!; }

  /** Count of cells in unit uid that still have digit d (d ∈ [1..9]; index 0 is unused). */
  count(uid: number, d: number): number { return this.counts[uid]![d]!; }

  // ── Unit ID accessors ────────────────────────────────────────────────────

  rowUnitId(r: number): number { return ROW_UNIT_OFFSET + r; }
  colUnitId(c: number): number { return COL_UNIT_OFFSET + c; }
  boxUnitId(r: number, c: number): number { return BOX_UNIT_OFFSET + (r / 3 | 0) * 3 + (c / 3 | 0); }
  cellUnitIds(r: number, c: number): number[] { return this._cellUnitIds[r]![c]!; }

  /**
   * Returns eliminations to apply to all peers of (r, c) when it is determined
   * to hold digit d — i.e. d removed from every other cell sharing a row, col,
   * box, or distinct-digit cage with (r, c).
   *
   * Used by NakedSingle and by buildEngine for unconditional placement propagation.
   */
  peerEliminations(r: number, c: number, d: number): Elimination[] {
    const seen = new Set<string>();
    const elims: Elimination[] = [];
    for (const uid of this.cellUnitIds(r, c)) {
      const unit = this.units[uid]!;
      if (unit.kind === UnitKind.CAGE && !unit.distinctDigits) continue;
      for (const [pr, pc] of unit.cells as Cell[]) {
        if (pr === r && pc === c) continue;
        const key = `${pr},${pc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.cands(pr, pc).has(d)) elims.push({ cell: [pr, pc] as Cell, digit: d });
      }
    }
    return elims;
  }

  // ── Mutation ─────────────────────────────────────────────────────────────

  /**
   * Remove digit d from candidates[r][c]; update counts, versions, emit events.
   *
   * This is the single mutation point for candidate sets. Steps:
   *  1. Remove d from candidates[r][c]
   *  2. Decrement counts[unitId][d] for all units containing (r, c)
   *  3. Emit COUNT_DECREASED / COUNT_HIT_TWO / COUNT_HIT_ONE as counts change
   *  4. Emit CELL_DETERMINED if candidates[r][c] becomes a singleton
   *  5. Raise NoSolnError if candidates[r][c] would become empty
   *
   * KillerBoardState overrides this to additionally prune cage solutions —
   * the same template-method shape as cageConstraints() below.
   */
  removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const cands = this.cands(r, c);
    if (!cands.has(d)) return [];
    if (cands.size === 1) throw new NoSolnError(`Cannot remove last candidate ${d} from (${r},${c})`);

    cands.delete(d);
    const events: BoardEvent[] = [];

    for (const uid of this.cellUnitIds(r, c)) {
      const prev = this.count(uid, d);
      const next = prev - 1;
      this.counts[uid]![d] = next;
      this.unitVersions[uid]!++;
      events.push({ trigger: Trigger.COUNT_DECREASED, payload: uid, hintDigit: d });
      if (next === 2) events.push({ trigger: Trigger.COUNT_HIT_TWO, payload: uid, hintDigit: d });
      else if (next === 1) events.push({ trigger: Trigger.COUNT_HIT_ONE, payload: uid, hintDigit: d });
    }

    if (cands.size === 1) {
      const sole = nextInSet(cands);
      events.push({ trigger: Trigger.CELL_DETERMINED, payload: [r, c] as Cell, hintDigit: sole });
    }

    return events;
  }

  /**
   * Reduce candidates[r][c] to exactly the given set for every cell, removing
   * everything else via removeCandidate (so KillerBoardState's cage-solution
   * pruning runs correctly). Used to replay a RuleBugFixture's stalledCandidates
   * onto a freshly constructed board.
   */
  restoreCandidates(candidates: readonly (readonly (readonly number[])[])[]): void {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const keep = new Set(candidates[r]![c]!);
        for (const d of [...this.cands(r, c)]) {
          if (!keep.has(d)) this.removeCandidate(r, c, d);
        }
      }
    }
  }

  /**
   * Cage-sum data for the MRV backtracker's validity check, or null when this
   * board has no cages. Plain BoardState always returns null — mrvBacktrack's
   * search() then degrades to pure row/col/box backtracking (cageTotal empty
   * ⟹ cageValid's `if (total === undefined) return true` short-circuit).
   */
  /**
   * Cells outside the standard row/col/box that share an extra distinct-digit
   * constraint with (r, c) — e.g. Big Apple window peers. Empty for a plain
   * board; overridden by BigAppleBoardState.
   */
  extraPeers(_r: number, _c: number): readonly Cell[] { return []; }

  cageConstraints(): CageConstraints | null { return null; }

  /**
   * Register a new unit: append it to `units` and extend `counts` /
   * `unitVersions` / the per-cell unit-ID lookup to cover it.
   *
   * This is the single place that keeps those three parallel arrays in sync
   * with `units` — shared by the row/col/box construction above,
   * KillerBoardState's cage construction, and addVirtualCage.
   */
  protected _addUnit(unit: Unit): void {
    this.units.push(unit);
    const countsRow = new Array<number>(10).fill(0);
    for (let d = 1; d <= 9; d++)
      countsRow[d] = unit.cells.filter(([r, c]) => this.cands(r, c).has(d)).length;
    this.counts.push(countsRow);
    this.unitVersions.push(0);
    for (const [r, c] of unit.cells) this._cellUnitIds[r]![c]!.push(unit.unitId);
  }
}

// ---------------------------------------------------------------------------
// KillerBoardState — adds cage modelling: cage units, cage-solution tracking,
// the linear system, and virtual cages derived from it
// ---------------------------------------------------------------------------

export class KillerBoardState extends BoardState {
  readonly spec: PuzzleSpec;
  /** regions[r][c] = 0-based cage index */
  readonly regions: number[][];
  /** cage_solns[cage_idx] = remaining feasible digit sets for that cage */
  cageSolns: number[][][];
  readonly linearSystem: LinearSystem;

  constructor(spec: PuzzleSpec, { includeVirtualCages = true } = {}) {
    super();
    this.spec = spec;

    // Convert regions to 0-based (spec uses 1-based cage IDs)
    // Indices are loop-bounded 0–8, so [r]![c]! are always valid.
    this.regions = Array.from({length: 9}, (_, r) =>
      Array.from({length: 9}, (__, c) => spec.regions[r]![c]! - 1));
    const nCages = Math.max(...this.regions.flat()) + 1;

    // Build cage cell lists (0-based index)
    const cageCellsList: Cell[][] = Array.from({length: nCages}, () => []);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        cageCellsList[this.regions[r]![c]!]!.push([r, c] as Cell);

    // Real cage units (27+)
    for (let idx = 0; idx < nCages; idx++)
      this._addUnit({ unitId: CAGE_UNIT_OFFSET + idx, kind: UnitKind.CAGE, cells: cageCellsList[idx]!, distinctDigits: true });

    // Real cage solutions via sol_sums
    this.cageSolns = cageCellsList.map(cells => {
      let total = 0;
      for (const [r, c] of cells) {
        const v = spec.cageTotals[r]![c]!;
        if (v !== 0) { total = v; break; }
      }
      return solSums(cells.length, 0, total);
    });

    // Build LinearSystem (this is the expensive step)
    this.linearSystem = new LinearSystem(spec, { deriveVirtualCages: includeVirtualCages });

    // Add virtual cage units from the linear system
    for (const { cells: vcells, total: vtotal, distinct, precomputedSolns: precompSolns } of includeVirtualCages ? this.linearSystem.virtualCages : []) {
      const vunitId = this.units.length;
      const cells = vcells as Cell[];
      this._addUnit({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });
      if (precompSolns !== null) {
        this.cageSolns.push(precompSolns);
      } else {
        this.cageSolns.push(solSums(cells.length, 0, vtotal));
      }
    }
  }

  cageUnitId(r: number, c: number): number { return CAGE_UNIT_OFFSET + this.regions[r]![c]!; }

  override removeCandidate(r: number, c: number, d: number): BoardEvent[] {
    const events = super.removeCandidate(r, c, d);
    if (events.length === 0) return events; // d wasn't a candidate — nothing changed, nothing to prune

    // Prune cage solutions for all cage units containing this cell
    for (const uid of this.cellUnitIds(r, c)) {
      if (this.units[uid]!.kind === UnitKind.CAGE) {
        events.push(...this._pruneCageSolutions(uid - CAGE_UNIT_OFFSET, r, c, d));
      }
    }

    return events;
  }

  removeCageSolution(cageIdx: number, solution: readonly number[]): BoardEvent {
    const solns = this.cageSolns[cageIdx]!;
    const idx = solns.findIndex(s => s.length === solution.length && s.every((d, i) => d === solution[i]));
    if (idx >= 0) solns.splice(idx, 1);
    const cageUnitId = CAGE_UNIT_OFFSET + cageIdx;
    return { trigger: Trigger.SOLUTION_PRUNED, payload: cageUnitId, hintDigit: null };
  }

  private _pruneCageSolutions(cageIdx: number, _r: number, _c: number, d: number): BoardEvent[] {
    const cageUnit = this.units[CAGE_UNIT_OFFSET + cageIdx]!;
    // If d is still possible somewhere in the cage, nothing to prune
    if (cageUnit.cells.some(([cr, cc]) => this.cands(cr, cc).has(d))) return [];
    // Remove all solutions containing d
    const toRemove = this.cageSolns[cageIdx]!.filter(s => s.includes(d));
    return toRemove.map(s => this.removeCageSolution(cageIdx, s));
  }

  /**
   * Builds { cageOf, cageTotal, cageCells } from this.spec — the same
   * extraction mrvBacktrack used to perform inline (now moved here so the
   * backtracker can ask the board for its constraints generically).
   */
  override cageConstraints(): CageConstraints {
    const cageOf = Array.from({length: 9}, () => new Array<number>(9).fill(0));
    const cageTotal = new Map<number, number>();
    const cageCells = new Map<number, Cell[]>();

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cid = this.spec.regions[r]![c]!; // 1-based
        cageOf[r]![c] = cid;
        if (!cageCells.has(cid)) cageCells.set(cid, []);
        cageCells.get(cid)!.push([r, c] as Cell);
        const t = this.spec.cageTotals[r]![c]!;
        if (t !== 0) cageTotal.set(cid, t);
      }
    }

    return { cageOf, cageTotal, cageCells };
  }

  /**
   * Add a user-acknowledged virtual cage as a new cage unit.
   *
   * @param cells - cells that form the cage (row-major Cell tuples)
   * @param total - the cage sum constraint
   * @param eliminatedSolns - solutions the user has already ruled out; pre-filtered from the generated solution list
   * @param distinct - whether digits must be distinct within the cage (default true)
   */
  addVirtualCage(
    cells: readonly Cell[],
    total: number,
    eliminatedSolns: readonly (readonly number[])[],
    { distinct = true, negativeCells, eliminatedDiffSolns }: {
      distinct?: boolean;
      negativeCells?: readonly Cell[];
      eliminatedDiffSolns?: readonly DiffSolution[];
    } = {},
  ): void {
    const vunitId = this.units.length;

    if (negativeCells && negativeCells.length > 0) {
      // Diff cage: populate cageSolns with combined sorted digit arrays so that
      // CageCandidateFilter and SolutionMapFilter work correctly.
      // Combined [pos ∪ neg] is sound: any digit absent from all combined solutions
      // cannot appear in any cage cell regardless of role.
      const negKeys = new Set(negativeCells.map(([r, c]) => `${r},${c}`));
      const posCount = cells.length - negKeys.size;
      const negCount = negKeys.size;
      const diffKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
      const elimSet = new Set((eliminatedDiffSolns ?? []).map(diffKey));
      const solns = solDiffs(posCount, negCount, total)
        .filter(s => !elimSet.has(diffKey(s)))
        .map(s => [...s.pos, ...s.neg].sort((a, b) => a - b));
      this.cageSolns.push(solns);
    } else {
      const elimSet = new Set(eliminatedSolns.map(s => s.slice().sort().join(',')));
      const solns = solSums(cells.length, 0, total)
        .filter(s => !elimSet.has(s.slice().sort().join(',')));
      this.cageSolns.push(solns);
    }

    this._addUnit({ unitId: vunitId, kind: UnitKind.CAGE, cells, distinctDigits: distinct });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextInSet<T>(s: Set<T>): T {
  return s.values().next().value as T;
}

/** Validate that a fully-solved board satisfies row/col/box constraints (cages are skipped — validate separately). */
export function validateSolution(board: KillerBoardState): string[] {
  const violations: string[] = [];
  for (const unit of board.units) {
    if (unit.kind === UnitKind.CAGE) continue; // cage validation is separate
    const digits = unit.cells.map(([r, c]) => nextInSet(board.cands(r, c)));
    const uniq = new Set(digits);
    if (uniq.size !== 9 || ![...uniq].every(d => d >= 1 && d <= 9))
      violations.push(`Unit ${unit.unitId} (${UnitKind[unit.kind]}) has duplicate or invalid digits`);
  }
  return violations;
}

/** Intersection of all sets, returned as a sorted array. */
export function intersectAll(sets: ReadonlySet<number>[]): number[] {
  if (sets.length === 0) return [];
  return [...sets[0]!].filter(d => sets.every(s => s.has(d))).sort((a, b) => a - b);
}
