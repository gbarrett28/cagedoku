/**
 * UnitPartitionFilter — R12: cross-cage compatibility filter for partitioned units.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.unit_partition_filter` module.
 *
 * When cages partition a row, column, or box into known-sum groups, eliminates
 * cage solutions inconsistent with those groups. Uses DFS + propagation with a
 * node budget to avoid exponential blowup.
 *
 * Fires as GLOBAL.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';
import type { Unit } from '../types.js';

const MAX_PARTITION_CAGE_SIZE = 4;
const MAX_NODES = 200;

type SubCage = [Cell[], number[][]]; // [cells, solutions]
type Partition = SubCage[];

interface _Match {
  unit: Unit;
  partition: Partition;
  crossCages: SubCage[];
  eliminations: Elimination[];
}

function findPartition(remaining: Set<string>, cells: Cell[], subCages: SubCage[]): Partition | null {
  if (!remaining.size) return [];
  const sorted = [...cells].filter(([r,c]) => remaining.has(`${r},${c}`)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if (!sorted.length) return null;
  const target = `${sorted[0]![0]},${sorted[0]![1]}`;
  for (const [sc, solns] of subCages) {
    if (!sc.some(([r,c]) => `${r},${c}` === target)) continue;
    const newRemaining = new Set([...remaining].filter(k => !sc.some(([r,c]) => `${r},${c}` === k)));
    const newSubCages = subCages.filter(([c2]) => !c2.some(([r,c]) => sc.some(([sr,sc]) => sr===r && sc===c)));
    const result = findPartition(newRemaining, cells, newSubCages);
    if (result !== null) return [[sc, solns], ...result];
  }
  return null;
}

class CapHitError extends Error {}

function crossValidCombos(partition: Partition, maxNodes: number): Set<string>[] {
  const n = partition.length;
  const validPerCage: Set<string>[] = Array.from({length: n}, () => new Set());
  let nodes = 0;

  function solnKey(s: number[]): string { return s.slice().sort((a,b)=>a-b).join(','); }

  function dfs(idx: number, filtered: number[][][]): boolean {
    if (idx === n) return true;
    const solns = filtered[idx]!;
    if (!solns.length) return false;
    const isForced = solns.length === 1;
    let foundValid = false;
    for (const soln of solns) {
      if (!isForced) {
        nodes++;
        if (nodes > maxNodes) {
          for (const s of solns) validPerCage[idx]!.add(solnKey(s));
          for (let j = idx + 1; j < n; j++) for (const s of filtered[j]!) validPerCage[j]!.add(solnKey(s));
          throw new CapHitError();
        }
      }
      const solnSet = new Set(soln);
      const newFiltered = filtered.map((f, j) =>
        j > idx ? f.filter(s => !s.some(d => solnSet.has(d))) : f
      );
      try {
        const sub = dfs(idx + 1, newFiltered);
        if (sub) { validPerCage[idx]!.add(solnKey(soln)); foundValid = true; }
      } catch (e) {
        if (e instanceof CapHitError) { validPerCage[idx]!.add(solnKey(soln)); throw e; }
      }
    }
    return foundValid;
  }

  try { dfs(0, partition.map(([, solns]) => solns)); } catch { /* cap hit — conservative */ }
  return validPerCage;
}

function expandCellLevel(
  partition: Partition,
  validPerCage: Set<string>[],
  crossCages: SubCage[],
  candidates: Set<number>[][],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>(partition.flatMap(([cells]) => cells.map(([r,c]) => [`${r},${c}`, new Set<number>()])));

  function permutations(arr: number[]): number[][] {
    if (arr.length <= 1) return [arr];
    return arr.flatMap((v, i) => permutations([...arr.slice(0,i), ...arr.slice(i+1)]).map(p => [v, ...p]));
  }

  function dfs(idx: number, current: Map<string, number>, used: Set<number>): void {
    if (idx === partition.length) {
      for (const [key, digit] of current) result.get(key)!.add(digit);
      return;
    }
    const [cells, ] = partition[idx]!;
    const sortedCells = [...cells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    for (const solnKey of validPerCage[idx]!) {
      const digits = solnKey.split(',').map(Number);
      if (digits.some(d => used.has(d))) continue;
      for (const perm of permutations(digits)) {
        if (!perm.every((d, i) => candidates[sortedCells[i]![0]]![sortedCells[i]![1]]!.has(d))) continue;
        const cellAsn = new Map(sortedCells.map(([r,c], i) => [`${r},${c}`, perm[i]!]));
        const newCurrent = new Map([...current, ...cellAsn]);
        let ok = true;
        for (const [ccCells, ccSolns] of crossCages) {
          if (!ccCells.every(([r,c]) => newCurrent.has(`${r},${c}`))) continue;
          const assigned = [...ccCells].map(([r,c]) => newCurrent.get(`${r},${c}`)!).sort((a,b)=>a-b).join(',');
          if (!ccSolns.some(s => s.slice().sort((a,b)=>a-b).join(',') === assigned)) { ok = false; break; }
        }
        if (ok) dfs(idx + 1, newCurrent, new Set([...used, ...digits]));
      }
    }
  }

  dfs(0, new Map(), new Set());
  return result;
}

export class UnitPartitionFilter {
  readonly name = 'UnitPartitionFilter';
  readonly description =
    'When cages partition a row, column, or box into known-sum groups, eliminates cage solutions inconsistent with those groups.';
  readonly priority = 12;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  private _iterMatches(board: RuleContext['board']): _Match[] {
    const matches: _Match[] = [];
    for (const unit of board.units) {
      if (unit.kind !== UnitKind.ROW && unit.kind !== UnitKind.COL && unit.kind !== UnitKind.BOX) continue;
      const unitCells = unit.cells as Cell[];
      const unitCellSet = new Set(unitCells.map(([r,c]) => `${r},${c}`));

      const subCages: SubCage[] = [];
      for (const other of board.units) {
        if (other.kind !== UnitKind.CAGE) continue;
        const otherCells = other.cells as Cell[];
        if (!otherCells.every(([r,c]) => unitCellSet.has(`${r},${c}`))) continue;
        const cageIdx = other.unitId - 27;
        const solns = board.cageSolns[cageIdx]!;
        if (solns.length) subCages.push([otherCells, solns]);
      }
      subCages.sort((a, b) => a[1].length - b[1].length);

      const allRemaining = new Set(unitCells.map(([r,c]) => `${r},${c}`));
      const partition = findPartition(allRemaining, unitCells, subCages);
      if (!partition || partition.length <= 1) continue;
      if (partition.some(([cells]) => cells.length > MAX_PARTITION_CAGE_SIZE)) continue;

      const partitionCellSets = partition.map(([cells]) => new Set(cells.map(([r,c])=>`${r},${c}`)));
      const crossCages = subCages.filter(([cells]) => !partitionCellSets.some(ps => cells.every(([r,c]) => ps.has(`${r},${c}`))));

      const validPerCage = crossValidCombos(partition, MAX_NODES);
      const validCellDigits = expandCellLevel(partition, validPerCage, crossCages, board.candidates);

      const elims: Elimination[] = [];
      for (const [key, valid] of validCellDigits) {
        const [r, c] = key.split(',').map(Number) as [number, number];
        for (const d of board.cands(r, c)) {
          if (!valid.has(d)) elims.push({ cell: [r, c] as Cell, digit: d });
        }
      }
      // Deduplicate
      const seen = new Set<string>();
      const dedupElims = elims.filter(e => {
        const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`; if (seen.has(k)) return false; seen.add(k); return true;
      });
      if (dedupElims.length) matches.push({ unit, partition, crossCages, eliminations: dedupElims });
    }
    return matches;
  }

  apply(ctx: RuleContext): RuleResult {
    const elims = this._iterMatches(ctx.board).flatMap(m => m.eliminations);
    const seen = new Set<string>();
    const dedup = elims.filter(e => { const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { ...emptyResult(), eliminations: dedup };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    return this._iterMatches(ctx.board).map(m => {
      const uLbl = unitLabel(m.unit);
      const n = m.partition.length;
      const cageDescs = m.partition.map(([cells, solns]) => {
        const cellStr = [...cells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(cellLabel).join(', ');
        return `[${cellStr}] (${solns.length} solutions)`;
      }).join('; ');
      const crossNote = m.crossCages.length
        ? ` Additional sum constraints from ${m.crossCages.length} virtual cage${m.crossCages.length !== 1 ? 's' : ''} within ${uLbl} further limit valid assignments.`
        : '';
      const nElims = m.eliminations.length;
      return {
        ruleName: this.name,
        displayName: 'Unit Partition Filter',
        explanation: `All 9 cells of ${uLbl} are completely covered by ${n} cages: ${cageDescs}. These cages must collectively assign each digit 1–9 exactly once across ${uLbl} — no digit can repeat.${crossNote} Checking all compatible combinations of cage solutions, ${nElims} candidate${nElims !== 1 ? 's' : ''} cannot appear in any valid assignment and can be eliminated.`,
        highlightCells: m.partition.flatMap(([cells]) => cells),
        eliminations: m.eliminations,
        placement: null,
        virtualCageSuggestion: null,
      };
    });
  }
}
