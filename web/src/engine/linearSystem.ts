/**
 * LinearSystem — Gaussian elimination and virtual cage derivation.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.linear_system` module.
 *
 * Builds a linear system over Q from all row/col/box/cage sum equations,
 * reduces to RREF using exact rational arithmetic, then extracts:
 *  - initialEliminations: cells whose digit is determined at setup
 *  - deltaPairs: (cell_p, cell_q, delta) where value[p] - value[q] = delta
 *  - sumPairs: (cell_a, cell_b, total) where value[a] + value[b] = total
 *  - virtualCages: derived sum constraints (burb and non-burb)
 */

import { solSums } from '../solver/equation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import type { Cell, Elimination } from './types.js';

// ---------------------------------------------------------------------------
// Exact rational arithmetic
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

class Frac {
  readonly n: number;
  readonly d: number; // always positive

  constructor(n: number, d = 1) {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(Math.abs(n), d);
    this.n = n / g;
    this.d = d / g;
  }

  add(b: Frac): Frac { return new Frac(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b: Frac): Frac { return new Frac(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b: Frac): Frac { return new Frac(this.n * b.n, this.d * b.d); }
  div(b: Frac): Frac { return new Frac(this.n * b.d, this.d * b.n); }
  eq(b: Frac): boolean { return this.n === b.n && this.d === b.d; }
  isZero(): boolean { return this.n === 0; }
  isInteger(): boolean { return this.d === 1; }
  toInt(): number { return this.n; }

  static readonly ZERO = new Frac(0);
  static readonly ONE  = new Frac(1);
}

// ---------------------------------------------------------------------------
// Sparse row: cell-key → coefficient
// ---------------------------------------------------------------------------

type SparseRow = Map<string, Frac>;

function cellKey(cell: Cell): string { return `${cell[0]},${cell[1]}`; }
function keyToCell(k: string): Cell {
  const i = k.indexOf(',');
  return [parseInt(k.slice(0, i), 10), parseInt(k.slice(i + 1), 10)] as Cell;
}

// ---------------------------------------------------------------------------
// Virtual cage type
// (cells, total, distinctDigits, precomputedSolns | null)
// precomputedSolns=null → BoardState calls solSums; list → use directly (non-burb)
// ---------------------------------------------------------------------------

export type VirtualCage = readonly [readonly Cell[], number, boolean, number[][] | null];

// ---------------------------------------------------------------------------
// Internal equation used during reduce_derive / non-burb derivation
// ---------------------------------------------------------------------------

interface DeriveEq {
  cells: Set<string>;
  total: number;
  solns: number[][];
}

// ---------------------------------------------------------------------------
// LinearSystem
// ---------------------------------------------------------------------------

export class LinearSystem {
  initialEliminations: Elimination[] = [];
  deltaPairs: Array<readonly [Cell, Cell, number]> = [];
  sumPairs:   Array<readonly [Cell, Cell, number]> = [];
  virtualCages: VirtualCage[] = [];

  private _pairsByCell:    Map<string, Array<readonly [Cell, Cell, number]>> = new Map();
  private _sumPairsByCell: Map<string, Array<readonly [Cell, Cell, number]>> = new Map();

  private _liveRows:   Map<number, SparseRow> = new Map();
  private _liveRhs:    Map<number, Frac>       = new Map();
  private _liveByCell: Map<string, Set<number>> = new Map();
  private _nextRid = 0;

  constructor(spec: PuzzleSpec, { deriveVirtualCages = true } = {}) {
    const varIndex = new Map<string, number>();
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        varIndex.set(cellKey([r, c] as Cell), r * 9 + c);

    const rows: Frac[][] = [];

    function addEq(cells: Cell[], total: number): void {
      const row = new Array<Frac>(82).fill(Frac.ZERO);
      for (const cell of cells) row[varIndex.get(cellKey(cell))!] = Frac.ONE;
      row[81] = new Frac(total);
      rows.push(row);
    }

    // Row, col, box constraints each sum to 45
    for (let r = 0; r < 9; r++)
      addEq(Array.from({length: 9}, (_, c) => [r, c] as Cell), 45);
    for (let c = 0; c < 9; c++)
      addEq(Array.from({length: 9}, (_, r) => [r, c] as Cell), 45);
    for (let b = 0; b < 9; b++) {
      const r0 = (b / 3 | 0) * 3, c0 = (b % 3) * 3;
      const bCells: Cell[] = [];
      for (let dr = 0; dr < 3; dr++)
        for (let dc = 0; dc < 3; dc++)
          bCells.push([r0 + dr, c0 + dc] as Cell);
      addEq(bCells, 45);
    }

    // Cage equations
    const cageCellsMap = new Map<number, Cell[]>();
    const cageTotalsMap = new Map<number, number>();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cid = spec.regions[r]![c]!;
        if (!cageCellsMap.has(cid)) cageCellsMap.set(cid, []);
        cageCellsMap.get(cid)!.push([r, c] as Cell);
        const v = spec.cageTotals[r]![c]!;
        if (v !== 0) cageTotalsMap.set(cid, v);
      }
    }
    const realCageCellSets = new Set<string>();
    for (const cells of cageCellsMap.values())
      realCageCellSets.add(cells.map(cellKey).sort().join('|'));
    for (const [cid, cells] of cageCellsMap) {
      const total = cageTotalsMap.get(cid) ?? 0;
      if (total > 0) addEq(cells, total);
    }

    // Gaussian elimination to RREF
    const nRows = rows.length;
    let pivotRow = 0;
    for (let pivotCol = 0; pivotCol < 81; pivotCol++) {
      if (pivotRow >= nRows) break;
      let found = -1;
      for (let i = pivotRow; i < nRows; i++) {
        if (!rows[i]![pivotCol]!.isZero()) { found = i; break; }
      }
      if (found < 0) continue;
      [rows[pivotRow], rows[found]] = [rows[found]!, rows[pivotRow]!];
      const pivotRowArr = rows[pivotRow]!;
      const scale = pivotRowArr[pivotCol]!;
      for (let j = 0; j <= 81; j++) pivotRowArr[j] = pivotRowArr[j]!.div(scale);
      for (let i = 0; i < nRows; i++) {
        if (i === pivotRow || rows[i]![pivotCol]!.isZero()) continue;
        const factor = rows[i]![pivotCol]!;
        const rowI = rows[i]!;
        for (let j = 0; j <= 81; j++)
          rowI[j] = rowI[j]!.sub(factor.mul(pivotRowArr[j]!));
      }
      pivotRow++;
    }

    const idxToCell = new Map<number, Cell>();
    for (const [k, idx] of varIndex) idxToCell.set(idx, keyToCell(k));

    for (const row of rows) {
      const nonzero: Array<[number, Frac]> = [];
      for (let j = 0; j < 81; j++) {
        if (!row[j]!.isZero()) nonzero.push([j, row[j]!]);
      }
      const rhs = row[81]!;
      if (nonzero.length === 0) continue;

      if (nonzero.length === 1) {
        const [j, coeff] = nonzero[0]!;
        const valFrac = rhs.div(coeff);
        if (valFrac.isInteger()) {
          const val = valFrac.toInt();
          if (val >= 1 && val <= 9) {
            const cell = idxToCell.get(j)!;
            for (let d = 1; d <= 9; d++) {
              if (d !== val) this.initialEliminations.push({ cell, digit: d });
            }
          }
        }
      } else if (nonzero.length === 2) {
        const [jp, cp] = nonzero[0]!, [jq, cq] = nonzero[1]!;
        if (cp.eq(Frac.ONE) && cq.eq(new Frac(-1)) && rhs.isInteger()) {
          this._addDeltaPair(idxToCell.get(jp)!, idxToCell.get(jq)!, rhs.toInt());
        } else if (cp.eq(new Frac(-1)) && cq.eq(Frac.ONE) && rhs.isInteger()) {
          this._addDeltaPair(idxToCell.get(jq)!, idxToCell.get(jp)!, -rhs.toInt());
        } else {
          this._maybeAddVirtualCage(nonzero, rhs, idxToCell, realCageCellSets);
        }
      } else {
        this._maybeAddVirtualCage(nonzero, rhs, idxToCell, realCageCellSets);
      }

      if (nonzero.length >= 2) {
        const rid = this._nextRid++;
        const rd: SparseRow = new Map(nonzero.map(([j, c]): [string, Frac] => [cellKey(idxToCell.get(j)!), c!]));
        this._liveRows.set(rid, rd);
        this._liveRhs.set(rid, rhs);
        for (const [ck] of rd) {
          if (!this._liveByCell.has(ck)) this._liveByCell.set(ck, new Set());
          this._liveByCell.get(ck)!.add(rid);
        }
      }
    }

    for (const pair of this.deltaPairs) {
      const [p, q] = pair;
      for (const k of [cellKey(p), cellKey(q)]) {
        if (!this._pairsByCell.has(k)) this._pairsByCell.set(k, []);
        this._pairsByCell.get(k)!.push(pair);
      }
    }

    this._deriveSumPairs();

    if (deriveVirtualCages) {
      this._deriveNonburbVirtualCages(spec, realCageCellSets, cageCellsMap, cageTotalsMap);
      this._deriveOverlappingDeltaPairs(cageCellsMap, cageTotalsMap);
    }
  }

  // ── Public methods ───────────────────────────────────────────────────────

  pairsForCell(cell: Cell): Array<readonly [Cell, Cell, number]> {
    return [...(this._pairsByCell.get(cellKey(cell)) ?? [])];
  }

  sumPairsForCell(cell: Cell): Array<readonly [Cell, Cell, number]> {
    return [...(this._sumPairsByCell.get(cellKey(cell)) ?? [])];
  }

  substituteCell(cell: Cell, value: number): Elimination[] {
    const ck = cellKey(cell);
    const eliminations: Elimination[] = [];

    for (const pair of this._pairsByCell.get(ck) ?? []) {
      const [p, q, delta] = pair;
      const pk = cellKey(p);
      const idx = this.deltaPairs.indexOf(pair);
      if (idx >= 0) this.deltaPairs.splice(idx, 1);
      const other = pk === ck ? q : p;
      const otherKey = cellKey(other);
      const otherPairs = this._pairsByCell.get(otherKey);
      if (otherPairs) { const oi = otherPairs.indexOf(pair); if (oi >= 0) otherPairs.splice(oi, 1); }
      const otherVal = pk === ck ? value - delta : value + delta;
      if (otherVal >= 1 && otherVal <= 9) {
        for (let d = 1; d <= 9; d++) {
          if (d !== otherVal) eliminations.push({ cell: other, digit: d });
        }
      }
    }
    this._pairsByCell.delete(ck);

    for (const pair of this._sumPairsByCell.get(ck) ?? []) {
      const [a, , total] = pair;
      const ak = cellKey(a);
      const idx = this.sumPairs.indexOf(pair);
      if (idx >= 0) this.sumPairs.splice(idx, 1);
      const other = ak === ck ? pair[1] : a;
      const otherKey = cellKey(other);
      const otherPairs = this._sumPairsByCell.get(otherKey);
      if (otherPairs) { const oi = otherPairs.indexOf(pair); if (oi >= 0) otherPairs.splice(oi, 1); }
      const otherVal = total - value;
      if (otherVal >= 1 && otherVal <= 9) {
        for (let d = 1; d <= 9; d++) {
          if (d !== otherVal) eliminations.push({ cell: other, digit: d });
        }
      }
    }
    this._sumPairsByCell.delete(ck);

    return eliminations;
  }

  substituteLiveRows(cell: Cell, value: number): Array<readonly [readonly Cell[], number, boolean]> {
    const ck = cellKey(cell);
    const rowIds = [...(this._liveByCell.get(ck) ?? [])];
    this._liveByCell.delete(ck);
    const constraints: Array<readonly [readonly Cell[], number, boolean]> = [];
    const seen = new Set<string>();

    for (const rid of rowIds) {
      const rowDict = this._liveRows.get(rid);
      if (!rowDict) continue;
      this._liveRows.delete(rid);
      const rowRhs = this._liveRhs.get(rid)!;
      this._liveRhs.delete(rid);

      const cellCoeff = rowDict.get(ck)!;
      rowDict.delete(ck);
      const newRhs = rowRhs.sub(cellCoeff.mul(new Frac(value)));

      for (const [ok] of rowDict) this._liveByCell.get(ok)?.delete(rid);
      if (rowDict.size === 0) continue;

      const newRid = this._nextRid++;
      this._liveRows.set(newRid, rowDict);
      this._liveRhs.set(newRid, newRhs);
      for (const [ok] of rowDict) {
        if (!this._liveByCell.has(ok)) this._liveByCell.set(ok, new Set());
        this._liveByCell.get(ok)!.add(newRid);
      }

      if (rowDict.size === 1) {
        const [firstEntry] = rowDict;
        const [rck, coeff] = firstEntry!;
        const valFrac = newRhs.div(coeff);
        if (valFrac.isInteger()) {
          const detVal = valFrac.toInt();
          if (detVal >= 1 && detVal <= 9 && !seen.has(rck)) {
            seen.add(rck);
            constraints.push([[keyToCell(rck)], detVal, true]);
          }
        }
      } else if ([...rowDict.values()].every(c => c.eq(Frac.ONE))) {
        if (newRhs.isInteger()) {
          const total = newRhs.toInt();
          if (total >= 1 && total <= 45) {
            const vcells = [...rowDict.keys()].map(keyToCell);
            const vkey = [...rowDict.keys()].sort().join('|');
            if (!seen.has(vkey)) {
              seen.add(vkey);
              constraints.push([vcells as Cell[], total, isBurb(vcells as Cell[])]);
            }
          }
        }
      }
    }

    return constraints;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private _addDeltaPair(p: Cell, q: Cell, delta: number): void {
    const pair: readonly [Cell, Cell, number] = [p, q, delta];
    this.deltaPairs.push(pair);
    for (const k of [cellKey(p), cellKey(q)]) {
      if (!this._pairsByCell.has(k)) this._pairsByCell.set(k, []);
      this._pairsByCell.get(k)!.push(pair);
    }
  }

  private _addSumPair(a: Cell, b: Cell, total: number): void {
    const pair: readonly [Cell, Cell, number] = [a, b, total];
    this.sumPairs.push(pair);
    for (const k of [cellKey(a), cellKey(b)]) {
      if (!this._sumPairsByCell.has(k)) this._sumPairsByCell.set(k, []);
      this._sumPairsByCell.get(k)!.push(pair);
    }
  }

  private _cellSetKey(cells: readonly Cell[]): string {
    return cells.map(cellKey).sort().join('|');
  }

  private _maybeAddVirtualCage(
    nonzero: Array<[number, Frac]>,
    rhs: Frac,
    idxToCell: Map<number, Cell>,
    realCageCellSets: Set<string>,
  ): void {
    if (!nonzero.every(([, c]) => c.eq(Frac.ONE))) return;
    if (!rhs.isInteger() || rhs.toInt() <= 0) return;
    const cells = nonzero.map(([j]) => idxToCell.get(j)!);
    const key = this._cellSetKey(cells);
    if (realCageCellSets.has(key) || !isBurb(cells)) return;
    this.virtualCages.push([cells, rhs.toInt(), true, null]);
  }

  private _deriveSumPairs(): void {
    const covered = new Set<string>();
    for (const [p, q] of this.deltaPairs) covered.add(this._cellSetKey([p, q]));
    for (const [cells] of this.virtualCages)
      if (cells.length === 2) covered.add(this._cellSetKey(cells as Cell[]));

    const rids = [...this._liveRows.keys()];
    for (let ii = 0; ii < rids.length; ii++) {
      const rowI = this._liveRows.get(rids[ii]!)!;
      const rhsI = this._liveRhs.get(rids[ii]!)!;
      for (let jj = ii + 1; jj < rids.length; jj++) {
        const rowJ = this._liveRows.get(rids[jj]!)!;
        const rhsJ = this._liveRhs.get(rids[jj]!)!;
        const merged = new Map<string, Frac>(rowI);
        for (const [ck, coeff] of rowJ)
          merged.set(ck, (merged.get(ck) ?? Frac.ZERO).add(coeff));
        const nonzero = [...merged].filter(([, c]) => !c.isZero());
        if (nonzero.length !== 2) continue;
        if (!nonzero[0]![1]!.eq(Frac.ONE) || !nonzero[1]![1]!.eq(Frac.ONE)) continue;
        const totalFrac = rhsI.add(rhsJ);
        if (!totalFrac.isInteger()) continue;
        const total = totalFrac.toInt();
        if (total < 2 || total > 18) continue; // sum of two digits 1-9
        const cells = nonzero.map(([ck]) => keyToCell(ck)) as [Cell, Cell];
        const pairKey = this._cellSetKey(cells);
        if (covered.has(pairKey)) continue;
        covered.add(pairKey);
        this._addSumPair(cells[0], cells[1], total);
      }
    }
  }

  private _deriveNonburbVirtualCages(
    _spec: PuzzleSpec,
    realCageCellSets: Set<string>,
    cageCellsMap: Map<number, Cell[]>,
    cageTotalsMap: Map<number, number>,
  ): void {
    const nineSolns = solSums(9, 0, 45);
    const eqs: DeriveEq[] = [];

    const rowSets = Array.from({length: 9}, (_, r) =>
      new Set(Array.from({length: 9}, (__, c) => cellKey([r, c] as Cell))));
    const colSets = Array.from({length: 9}, (_, c) =>
      new Set(Array.from({length: 9}, (__, r) => cellKey([r, c] as Cell))));
    const boxCellSets = Array.from({length: 9}, (_, b) => {
      const s = new Set<string>();
      for (let dr = 0; dr < 3; dr++)
        for (let dc = 0; dc < 3; dc++)
          s.add(cellKey([(b / 3 | 0) * 3 + dr, (b % 3) * 3 + dc] as Cell));
      return s;
    });

    const cloneSolns = () => nineSolns.map(s => [...s]);
    for (const r of rowSets) eqs.push({cells: r, total: 45, solns: cloneSolns()});
    for (const c of colSets) eqs.push({cells: c, total: 45, solns: cloneSolns()});
    for (const b of boxCellSets) eqs.push({cells: b, total: 45, solns: cloneSolns()});

    const cageOf  = new Map<string, Set<string>>();
    const totalOf = new Map<string, number>();
    for (const [cid, cells] of cageCellsMap) {
      const total = cageTotalsMap.get(cid) ?? 0;
      if (total > 0) {
        const fc = new Set(cells.map(cellKey));
        for (const cell of cells) {
          cageOf.set(cellKey(cell as Cell), fc);
          totalOf.set(cellKey(cell as Cell), total);
        }
        eqs.push({cells: fc, total, solns: solSums(cells.length, 0, total).map(s => [...s])});
      }
    }

    const seenSw = new Set<string>(eqs.map(e => [...e.cells].sort().join('|')));
    for (const [cells] of this.virtualCages)
      seenSw.add(this._cellSetKey(cells as Cell[]));

    const pushDerived = (fcvr: Set<string>, sm: number) => {
      const key = [...fcvr].sort().join('|');
      if (seenSw.has(key) || realCageCellSets.has(key)) return;
      seenSw.add(key);
      const cells = [...fcvr].map(keyToCell) as Cell[];
      eqs.push({cells: fcvr, total: sm, solns: solSums(cells.length, 0, sm).map(s => [...s])});
      this.virtualCages.push([cells, sm, true, null]);
    };

    const allLines = [...rowSets, ...[...rowSets].reverse(), ...colSets, ...[...colSets].reverse()];
    for (const [f, sm] of this._addEqunsLine(allLines.slice(0, 18), cageOf, totalOf)) pushDerived(f, sm);
    for (const [f, sm] of this._addEqunsLine(allLines.slice(18), cageOf, totalOf)) pushDerived(f, sm);
    for (const [f, sm] of this._addEqunsBox(boxCellSets, cageOf, totalOf)) pushDerived(f, sm);

    for (const [cells, vtotal, distinct] of this.virtualCages) {
      if (distinct) {
        const key = this._cellSetKey(cells as Cell[]);
        if (!seenSw.has(key)) {
          seenSw.add(key);
          const fc = new Set(cells.map(c => cellKey(c as Cell)));
          eqs.push({cells: fc, total: vtotal, solns: solSums(cells.length, 0, vtotal).map(s => [...s])});
        }
      }
    }

    const initialCellSets = new Set<string>(eqs.map(e => [...e.cells].sort().join('|')));
    LinearSystem._reduceDerive(eqs);

    const seen = new Set<string>([...initialCellSets, ...seenSw]);
    for (const eq of eqs) {
      if (eq.cells.size === 0 || eq.solns.length === 0) continue;
      const key = [...eq.cells].sort().join('|');
      if (seen.has(key)) continue;
      const cells = [...eq.cells].map(keyToCell) as Cell[];
      const distinct = isBurb(cells);
      if (!distinct) {
        const must = eq.solns.reduce<Set<number> | null>((acc, s) => {
          if (acc === null) return new Set(s);
          return new Set(s.filter(d => acc!.has(d)));
        }, null);
        if (!must || must.size === 0) continue;
      }
      seen.add(key);
      this.virtualCages.push([cells, eq.total, distinct, eq.solns.map(s => [...s])]);
    }
  }

  private _addEqunsLine(
    line: Set<string>[],
    cageOf: Map<string, Set<string>>,
    totalOf: Map<string, number>,
  ): Array<[Set<string>, number]> {
    const equns: Array<[Set<string>, number]> = [];
    let rf = 0, rb = 0, cvr = new Set<string>(), sm = 0;
    while (rf < line.length) {
      for (const ck of line[rf]!) {
        if (!cvr.has(ck)) {
          const cage = cageOf.get(ck);
          if (cage) { for (const x of cage) cvr.add(x); sm += totalOf.get(ck)!; }
        }
      }
      rf++;
      while (rb < line.length && line[rb]!.isSubsetOf(cvr)) {
        for (const x of line[rb]!) cvr.delete(x);
        sm -= 45;
        rb++;
      }
      rf = Math.max(rf, rb);
      if (sm > 0 && cvr.size > 0 && isBurb([...cvr].map(keyToCell) as Cell[]))
        equns.push([new Set(cvr), sm]);
    }
    return equns;
  }

  private _addEqunsBox(
    boxCellSets: Set<string>[],
    cageOf: Map<string, Set<string>>,
    totalOf: Map<string, number>,
  ): Array<[Set<string>, number]> {
    const equns: Array<[Set<string>, number]> = [];
    const seenEq = new Set<string>();

    const recurse = (box: number, cvr: Set<string>, sm: number, subtracted: Set<number>, visited: Set<number>): void => {
      visited = new Set(visited); visited.add(box);
      for (const ck of boxCellSets[box]!) {
        if (!cvr.has(ck)) {
          const cage = cageOf.get(ck);
          if (cage) { for (const x of cage) cvr.add(x); sm += totalOf.get(ck)!; }
        }
      }
      for (let b = 0; b < 9; b++) {
        if (!subtracted.has(b) && boxCellSets[b]!.isSubsetOf(cvr)) {
          subtracted = new Set(subtracted); subtracted.add(b);
          sm -= 45;
          for (const x of boxCellSets[b]!) cvr.delete(x);
        }
      }
      if (sm !== 0 && cvr.size > 0) {
        const cells = [...cvr].map(keyToCell) as Cell[];
        const key = [...cvr].sort().join('|');
        if (!seenEq.has(key) && isBurb(cells)) { seenEq.add(key); equns.push([new Set(cvr), sm]); }
      }
      const bi = box / 3 | 0, bj = box % 3;
      for (const [di, dj] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const ni = bi + di, nj = bj + dj;
        if (ni >= 0 && ni < 3 && nj >= 0 && nj < 3) {
          const nb = ni * 3 + nj;
          if (!visited.has(nb) && !boxCellSets[nb]!.isDisjointFrom(cvr))
            recurse(nb, new Set(cvr), sm, subtracted, visited);
        }
      }
    };

    for (let start = 0; start < 9; start++) recurse(start, new Set(), 0, new Set(), new Set());
    return equns;
  }

  private static _reduceDerive(eqs: DeriveEq[]): void {
    let reduced = true;
    while (reduced) {
      reduced = false;
      const active = eqs.filter(e => e.cells.size > 0).sort((a, b) => a.cells.size - b.cells.size);
      for (let i = 0; i < active.length; i++) {
        const ei = active[i]!;
        for (let j = i + 1; j < active.length; j++) {
          const ej = active[j]!;
          if (ei.cells.isSubsetOf(ej.cells)) {
            ej.cells = ej.cells.difference(ei.cells);
            ej.total -= ei.total;
            const eiSets = ei.solns.map(s => new Set(s));
            const newSolns: number[][] = [];
            for (const os of eiSets)
              for (const ss of ej.solns)
                if ([...os].every(d => ss.includes(d))) newSolns.push(ss.filter(d => !os.has(d)));
            ej.solns = newSolns;
            reduced = true;
          }
        }
      }
    }
  }

  private _deriveOverlappingDeltaPairs(
    cageCellsMap: Map<number, Cell[]>,
    cageTotalsMap: Map<number, number>,
  ): void {
    const allEqs: Array<[readonly Cell[], number]> = [];
    for (const [cid, cells] of cageCellsMap) {
      const total = cageTotalsMap.get(cid) ?? 0;
      if (total > 0) allEqs.push([cells, total]);
    }
    for (const vc of this.virtualCages) allEqs.push([vc[0] as Cell[], vc[1]]);

    const existing = new Set<string>();
    for (const [p, q] of this.deltaPairs) existing.add(this._cellSetKey([p, q]));

    for (let i = 0; i < allEqs.length; i++) {
      const [cells1, total1] = allEqs[i]!;
      const set1 = new Set(cells1.map(cellKey));
      for (let j = i + 1; j < allEqs.length; j++) {
        const [cells2, total2] = allEqs[j]!;
        const set2 = new Set(cells2.map(cellKey));
        const shared = new Set([...set1].filter(k => set2.has(k)));
        if (shared.size === 0) continue;
        const left  = [...set1].filter(k => !shared.has(k));
        const right = [...set2].filter(k => !shared.has(k));
        if (left.length !== 1 || right.length !== 1) continue;
        const pairKey = [left[0]!, right[0]!].sort().join('|');
        if (existing.has(pairKey)) continue;
        existing.add(pairKey);
        const delta = total1 - total2;
        if (delta >= 0) this._addDeltaPair(keyToCell(left[0]!), keyToCell(right[0]!), delta);
        else            this._addDeltaPair(keyToCell(right[0]!), keyToCell(left[0]!), -delta);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared set utilities
// ---------------------------------------------------------------------------

function isBurb(cells: readonly Cell[]): boolean {
  if (cells.length === 0) return false;
  if (new Set(cells.map(c => c[0])).size === 1) return true;
  if (new Set(cells.map(c => c[1])).size === 1) return true;
  return new Set(cells.map(c => `${c[0] / 3 | 0},${c[1] / 3 | 0}`)).size === 1;
}
