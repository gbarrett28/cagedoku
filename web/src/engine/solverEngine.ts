/**
 * SolverEngine — main loop, apply_eliminations, trigger routing.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.solver_engine` module.
 *
 * Pull-with-dirty-tracking propagation engine. Constructs a trigger → [rule]
 * map at startup. apply_eliminations routes BoardEvents to the work queue.
 * The main loop pops items, skips stale unit-scoped items, calls rule.apply(),
 * and feeds eliminations back through apply_eliminations.
 *
 * Both classic and killer sudoku use the same engine. Classic puzzles simply
 * have empty cage_solns (cage_total = 0 → solSums returns []), so all
 * cage-specific rules become no-ops naturally.
 */

import { BoardState, CAGE_UNIT_OFFSET } from './boardState.js';
import type { HintResult } from './hint.js';
import type { RuleContext, RuleStats, SolverRule } from './rule.js';
import { makeRuleStats } from './rule.js';
import { solSums } from '../solver/equation.js';
import {
  BoardEvent,
  Cell,
  Elimination,
  Placement,
  SolutionElimination,
  Trigger,
  UnitKind,
  VirtualCageAddition,
  hasProgress,
} from './types.js';
import { isStale, SolverQueue } from './workQueue.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function unitKindFromId(unitId: number): UnitKind {
  if (unitId < 9)  return UnitKind.ROW;
  if (unitId < 18) return UnitKind.COL;
  if (unitId < 27) return UnitKind.BOX;
  return UnitKind.CAGE;
}

function filterSumRange(
  cells: readonly Cell[],
  total: number,
  candidates: Set<number>[][],
): Elimination[] {
  const c = (r: number, col: number): Set<number> => candidates[r]![col]!;
  const elims: Elimination[] = [];
  for (let i = 0; i < cells.length; i++) {
    const others = cells.filter((_, j) => j !== i);
    const minOthers = others.reduce((s, [r, col]) => s + Math.min(...c(r, col)), 0);
    const maxOthers = others.reduce((s, [r, col]) => s + Math.max(...c(r, col)), 0);
    const [r, col] = cells[i]!;
    for (const d of c(r, col)) {
      if (!(minOthers + d <= total && total <= maxOthers + d))
        elims.push({ cell: cells[i]!, digit: d });
    }
  }
  return elims;
}

function filterSumConstraint(
  cells: readonly Cell[],
  total: number,
  candidates: Set<number>[][],
): Elimination[] {
  const c = (r: number, col: number): Set<number> => candidates[r]![col]!;
  const solns = solSums(cells.length, 0, total);
  if (solns.length === 0) return [];

  const candUnion = new Set(solns.flat());
  const sortedCells = [...cells].sort(([r1, c1], [r2, c2]) => {
    const a = [...c(r1, c1)].filter(d => candUnion.has(d)).length;
    const b = [...c(r2, c2)].filter(d => candUnion.has(d)).length;
    return a - b;
  });

  const perCellPossible = new Map<string, Set<number>>(cells.map(cell => [`${cell[0]},${cell[1]}`, new Set()]));

  function bt(idx: number, remaining: Set<number>): boolean {
    if (idx === sortedCells.length) return true;
    const [r, col] = sortedCells[idx]!;
    let found = false;
    for (const d of [...c(r, col)].filter(d => remaining.has(d))) {
      remaining.delete(d);
      if (bt(idx + 1, remaining)) {
        perCellPossible.get(`${r},${col}`)!.add(d);
        found = true;
      }
      remaining.add(d);
    }
    return found;
  }

  for (const soln of solns) bt(0, new Set(soln));

  return cells.flatMap(([r, col]) =>
    [...c(r, col)].filter(d => !perCellPossible.get(`${r},${col}`)!.has(d))
      .map(digit => ({ cell: [r, col] as Cell, digit }))
  );
}

function dedupHints(hints: HintResult[]): HintResult[] {
  const seenElims = new Set<string>();
  const seenPlacements = new Set<string>();
  const seenVc = new Set<string>();
  const result: HintResult[] = [];
  for (const h of hints) {
    if (h.virtualCageSuggestion !== null) {
      const key = JSON.stringify(h.virtualCageSuggestion);
      if (!seenVc.has(key)) { seenVc.add(key); result.push(h); }
      continue;
    }
    if (h.placement !== null) {
      const key = JSON.stringify(h.placement);
      if (!seenPlacements.has(key)) { seenPlacements.add(key); result.push(h); }
      continue;
    }
    const newElims = h.eliminations.filter(e => {
      const k = `${e.cell[0]},${e.cell[1]}:${e.digit}`;
      if (seenElims.has(k)) return false;
      seenElims.add(k);
      return true;
    });
    if (newElims.length > 0)
      result.push({ ...h, eliminations: newElims });
  }
  return result;
}

// ---------------------------------------------------------------------------
// SolverEngine
// ---------------------------------------------------------------------------

export class SolverEngine {
  readonly board: BoardState;
  readonly queue: SolverQueue;
  readonly stats: Map<string, RuleStats>;

  pendingHints: HintResult[] = [];
  appliedMutations: Array<{ruleName: string; type: string; [k: string]: unknown}> = [];
  appliedPlacements: Placement[] = [];
  appliedVirtualCages: VirtualCageAddition[] = [];

  private readonly _triggerMap: Map<Trigger, SolverRule[]>;
  private readonly _ruleIndex: Map<SolverRule, number>;
  private readonly _hintRules: ReadonlySet<string>;
  private readonly _linearSystemActive: boolean;

  constructor(
    board: BoardState,
    rules: SolverRule[],
    { linearSystemActive = true, hintRules = new Set<string>() }: {
      linearSystemActive?: boolean;
      hintRules?: ReadonlySet<string>;
    } = {},
  ) {
    this.board = board;
    this.queue = new SolverQueue();
    this._ruleIndex = new Map(rules.map((r, i) => [r, i]));
    this.stats = new Map(rules.map(r => [r.name, makeRuleStats()]));
    this._hintRules = hintRules;
    this._linearSystemActive = linearSystemActive;

    this._triggerMap = new Map(Object.values(Trigger)
      .filter((v): v is Trigger => typeof v === 'number')
      .map(t => [t, [] as SolverRule[]]));
    for (const rule of rules)
      for (const trigger of rule.triggers)
        this._triggerMap.get(trigger)!.push(rule);
  }

  applyEliminations(eliminations: readonly Elimination[]): void {
    for (const elim of eliminations) {
      const [r, c] = elim.cell;
      if (!this.board.cands(r, c).has(elim.digit)) continue;
      if (this.board.cands(r, c).size <= 1) continue;
      const events = this.board.removeCandidate(r, c, elim.digit);
      this._routeEvents(events, r, c);
    }
  }

  private _routeEvents(events: BoardEvent[], _srcR: number, _srcC: number): void {
    for (const event of events) {
      if (event.trigger === Trigger.CELL_DETERMINED) {
        const cell = event.payload as Cell;
        const val = event.hintDigit!;
        if (this._linearSystemActive) {
          const newElims = this.board.linearSystem.substituteCell(cell, val);
          if (newElims.length > 0) this.applyEliminations(newElims);
          const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
          for (const [vcells, vtotal, distinct] of newConstraints) {
            const cellList = [...vcells];
            if (cellList.length === 1) {
              const [lr, lc] = cellList[0]!;
              for (let d = 1; d <= 9; d++) {
                if (d !== vtotal && this.board.cands(lr, lc).has(d))
                  this.applyEliminations([{ cell: cellList[0]!, digit: d }]);
              }
            } else if (distinct) {
              this.applyEliminations(filterSumConstraint(cellList as Cell[], vtotal, this.board.candidates));
            } else {
              this.applyEliminations(filterSumRange(cellList as Cell[], vtotal, this.board.candidates));
            }
          }
        }
        for (const rule of this._triggerMap.get(Trigger.CELL_DETERMINED) ?? [])
          this.queue.enqueueCell(0, rule, this._ruleIndex.get(rule)!, cell, Trigger.CELL_DETERMINED, val);
        for (const rule of this._triggerMap.get(Trigger.CELL_SOLVED) ?? [])
          this.queue.enqueueCell(0, rule, this._ruleIndex.get(rule)!, cell, Trigger.CELL_SOLVED, val);
      } else if (event.trigger === Trigger.SOLUTION_PRUNED) {
        const uid = event.payload as number;
        for (const rule of this._triggerMap.get(Trigger.SOLUTION_PRUNED) ?? [])
          this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!, uid,
            this.board.unitVersions[uid]! - 1, Trigger.SOLUTION_PRUNED, null);
      } else {
        const uid = event.payload as number;
        const kind = unitKindFromId(uid);
        for (const rule of this._triggerMap.get(event.trigger) ?? []) {
          if (rule.unitKinds.size === 0 || rule.unitKinds.has(kind))
            this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!, uid,
              this.board.unitVersions[uid]! - 1, event.trigger, event.hintDigit);
        }
      }
      // Re-schedule all GLOBAL rules on every board change
      for (const rule of this._triggerMap.get(Trigger.GLOBAL) ?? [])
        this.queue.enqueueGlobal(rule.priority, rule, this._ruleIndex.get(rule)!);
    }
  }

  private _seedInitialState(): void {
    const seedTriggers = new Set([Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]);
    for (const unit of this.board.units) {
      for (const trigger of seedTriggers) {
        for (const rule of this._triggerMap.get(trigger) ?? []) {
          if (rule.unitKinds.size === 0 || rule.unitKinds.has(unit.kind))
            this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!, unit.unitId,
              -1, trigger, null);
        }
      }
    }
  }

  private _applyGlobalRuleDefault(se: SolutionElimination, ruleName: string): void {
    const solns = this.board.cageSolns[se.cageIdx]!;
    const idx = solns.findIndex(s => s.length === se.solution.length && s.every((d, i) => d === se.solution[i]));
    if (idx < 0) return;
    solns.splice(idx, 1);
    const cageUnitId = CAGE_UNIT_OFFSET + se.cageIdx;
    this.board.unitVersions[cageUnitId]!++;
    this.appliedMutations.push({ ruleName, type: 'solution_eliminated', cageIdx: se.cageIdx });
    for (const rule of this._triggerMap.get(Trigger.SOLUTION_PRUNED) ?? [])
      this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!, cageUnitId,
        this.board.unitVersions[cageUnitId]! - 1, Trigger.SOLUTION_PRUNED, null);
    for (const rule of this._triggerMap.get(Trigger.GLOBAL) ?? [])
      this.queue.enqueueGlobal(rule.priority, rule, this._ruleIndex.get(rule)!);
  }

  solve(): BoardState {
    this.appliedMutations = [];
    this.appliedPlacements = [];
    this.appliedVirtualCages = [];
    this.pendingHints = [];

    this._seedInitialState();
    for (const rule of this._triggerMap.get(Trigger.GLOBAL) ?? [])
      this.queue.enqueueGlobal(rule.priority, rule, this._ruleIndex.get(rule)!);

    while (!this.queue.empty()) {
      const item = this.queue.pop();
      if (isStale(item, this.board.unitVersions)) continue;

      const unit = item.unitId !== null ? this.board.units[item.unitId] ?? null : null;
      const ctx: RuleContext = {
        unit,
        cell: item.cell,
        board: this.board,
        hint: item.trigger,
        hintDigit: item.hintDigit,
      };

      const t0 = performance.now();
      const result = item.rule.apply(ctx);
      const elapsed = (performance.now() - t0) * 1e6; // to nanoseconds
      const stats = this.stats.get(item.rule.name)!;
      stats.calls++;
      if (hasProgress(result)) stats.progress++;
      stats.eliminations += result.eliminations.length;
      stats.elapsedNs += elapsed;

      if (this._hintRules.has(item.rule.name)) {
        this.pendingHints.push(...item.rule.asHints(ctx, result.eliminations));
      } else {
        if (result.eliminations.length > 0) {
          for (const e of result.eliminations)
            this.appliedMutations.push({ ruleName: item.rule.name, type: 'candidate_removed',
              row: e.cell[0], col: e.cell[1], digit: e.digit });
          this.applyEliminations(result.eliminations);
        }
        for (const p of result.placements) {
          this.appliedPlacements.push(p);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'placement',
            row: p.cell[0], col: p.cell[1], digit: p.digit });
        }
        for (const se of result.solutionEliminations)
          this._applyGlobalRuleDefault(se, item.rule.name);
        for (const vca of result.virtualCageAdditions) {
          this.appliedVirtualCages.push(vca);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'virtual_cage_added' });
        }
      }
    }

    this.pendingHints = dedupHints(this.pendingHints);
    return this.board;
  }
}
