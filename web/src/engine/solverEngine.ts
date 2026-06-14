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

import { BoardState, CAGE_UNIT_OFFSET, KillerBoardState } from './boardState.js';
import type { HintResult } from './hint.js';
import type { RuleContext, RuleStats, SolverRule } from './rule.js';
import { makeRuleStats } from './rule.js';
import { NoSolnError } from '../solver/errors.js';
import { cellLabel } from './rules/_labels.js';
import {
  BoardEvent,
  Cell,
  cellKey,
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

export function toDisplayName(ruleName: string): string {
  return ruleName.replace(/([A-Z])/g, ' $1').trim();
}

function unitKindFromId(unitId: number): UnitKind {
  if (unitId < 9)  return UnitKind.ROW;
  if (unitId < 18) return UnitKind.COL;
  if (unitId < 27) return UnitKind.BOX;
  return UnitKind.CAGE;
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

/** Options shared by SolverEngine and KillerSolverEngine. */
export interface SolverEngineOptions {
  hintRules?: ReadonlySet<string>;
  /** When provided, each rule application is checked: no rule may eliminate
   *  the correct solution digit from a cell where it is still a candidate.
   *  When `onViolation` is also provided, violations call it and suppress the
   *  rule result instead of throwing. When `onViolation` is null, violations
   *  throw NoSolnError (backward-compatible). */
  goldenSolution?: readonly (readonly number[])[] | null;
  /** Called when a rule produces an elimination that contradicts the golden
   *  solution. The engine suppresses the entire rule result (no board mutation)
   *  and continues. Only has effect when `goldenSolution` is also set. */
  onViolation?: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
}

export class SolverEngine {
  readonly board: BoardState;
  readonly queue: SolverQueue;
  readonly stats: Map<string, RuleStats>;

  pendingHints: HintResult[] = [];
  appliedMutations: Array<{ruleName: string; type: string; [k: string]: unknown}> = [];
  appliedPlacements: Placement[] = [];
  appliedVirtualCages: VirtualCageAddition[] = [];

  protected readonly _triggerMap: Map<Trigger, SolverRule[]>;
  protected readonly _ruleIndex: Map<SolverRule, number>;
  private readonly _hintRules: ReadonlySet<string>;
  protected readonly _goldenSolution: readonly (readonly number[])[] | null;
  protected readonly _onViolation: ((ruleName: string, offending: readonly Elimination[]) => void) | null;
  /** True once a violation has been reported in the current solve() pass. Only the
   *  first violating rule is reported; subsequent violations are still suppressed
   *  but not reported (they may be cascades of the first bug). Reset at the start
   *  of each solve() call. */
  private _violationFired = false;

  constructor(
    board: BoardState,
    rules: SolverRule[],
    { hintRules = new Set<string>(), goldenSolution = null, onViolation = null }: SolverEngineOptions = {},
  ) {
    this.board = board;
    this.queue = new SolverQueue();
    this._ruleIndex = new Map(rules.map((r, i) => [r, i]));
    this.stats = new Map(rules.map(r => [r.name, makeRuleStats()]));
    this._hintRules = hintRules;
    this._goldenSolution = goldenSolution;
    this._onViolation = onViolation;

    this._triggerMap = new Map(Object.values(Trigger)
      .filter((v): v is Trigger => typeof v === 'number')
      .map(t => [t, [] as SolverRule[]]));
    for (const rule of rules)
      for (const trigger of rule.triggers)
        this._triggerMap.get(trigger)!.push(rule);
  }

  /** Linear-system propagation for a just-determined cell. No-op on a board
   *  with no LinearSystem; KillerSolverEngine overrides it to substitute the
   *  cell into the cage-sum equations and narrow live virtual-cage constraints. */
  protected _onCellDetermined(_cell: Cell, _val: number): void {}

  /** Reports (or throws, if no onViolation handler) when a forced/eliminated
   *  digit at (r, c) contradicts the golden solution. No-op if there is no
   *  golden solution or the digit matches it. */
  protected _checkAgainstGolden(ruleName: string, cell: Cell, digit: number): void {
    if (this._goldenSolution === null) return;
    const gold = this._goldenSolution[cell[0]]?.[cell[1]];
    if (gold === undefined || digit === gold) return;
    if (this._onViolation !== null) {
      this._onViolation(ruleName, [{ cell, digit: gold }]);
    } else {
      throw new NoSolnError(
        `${ruleName}: derived value ${digit} for r${cell[0] + 1}c${cell[1] + 1} contradicts golden solution ${gold}`,
      );
    }
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

  /**
   * Dispatch board events from a candidate removal to the work queue and linear system.
   *
   * CELL_DETERMINED events also propagate into the linear system (substitution + constraint
   * narrowing) and re-enqueue CELL_SOLVED listeners. SOLUTION_PRUNED and unit-scoped events
   * are routed to rules by trigger type and unit kind. Every event re-schedules all GLOBAL
   * rules so they see the latest board state.
   */
  private _routeEvents(events: BoardEvent[], _srcR: number, _srcC: number): void {
    for (const event of events) {
      if (event.trigger === Trigger.CELL_DETERMINED) {
        const cell = event.payload as Cell;
        const val = event.hintDigit!;
        this._onCellDetermined(cell, val);
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

  /** Cage-solution pruning for a rule's `solutionEliminations`. No-op on a board
   *  with no cage solutions; KillerSolverEngine overrides it to splice the pruned
   *  solution out of `cageSolns`, bump the cage's unit version, and enqueue
   *  SOLUTION_PRUNED/GLOBAL follow-ups. */
  protected _onSolutionElimination(_se: SolutionElimination, _ruleName: string): void {}

  /**
   * Run the rule engine to a fixed point and return the (mutated) board.
   *
   * Drains the work queue, applying each rule in priority order. Rules in `_hintRules`
   * accumulate their results in `pendingHints` instead of mutating the board. All other
   * rules write eliminations, placements, solution eliminations, and virtual cage
   * additions directly to the board and to `appliedMutations`/`appliedPlacements`/
   * `appliedVirtualCages`. Resets all accumulators on each call. Deduplicates
   * `pendingHints` before returning.
   */
  solve(): BoardState {
    this.appliedMutations = [];
    this.appliedPlacements = [];
    this.appliedVirtualCages = [];
    this.pendingHints = [];
    this._violationFired = false;

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
        // Golden check for hint rules: a hint whose eliminations contradict the
        // golden solution is unsound. Suppress it and report the violation so the
        // rule is disabled for the session.
        // Unlike always-apply rules, hint rules cannot cascade eliminations into
        // other rules, so _violationFired is not set here — every bad hint rule
        // is reported independently.
        if (this._goldenSolution !== null && result.eliminations.length > 0) {
          const offending = result.eliminations.filter(e => {
            const [r, c] = e.cell;
            const gold = this._goldenSolution![r]?.[c];
            return gold !== undefined && e.digit === gold && this.board.cands(r, c).has(gold);
          });
          if (offending.length > 0) {
            if (this._onViolation !== null) this._onViolation(item.rule.name, offending);
            continue; // suppress the bad hint
          }
        }
        this.pendingHints.push(...item.rule.asHints(ctx, result.eliminations));
      } else {
        if (this._goldenSolution !== null && result.virtualCageAdditions.length > 0) {
          const offending = result.virtualCageAdditions.find(vca => {
            const goldSum = vca.cells.reduce((sum, [r, c]) => sum + this._goldenSolution![r]![c]!, 0);
            return goldSum !== vca.total;
          });
          if (offending !== undefined) {
            if (this._onViolation !== null) {
              // Report only the first violation per solve() pass — subsequent
              // violations may be cascades of the first bug.
              if (!this._violationFired) {
                this._onViolation(item.rule.name, []);
                this._violationFired = true;
              }
              // Always suppress the entire rule result regardless of whether
              // the violation was reported.
              continue;
            } else {
              const goldSum = offending.cells.reduce((sum, [r, c]) => sum + this._goldenSolution![r]![c]!, 0);
              throw new NoSolnError(
                `${item.rule.name}: virtual cage ${offending.cells.map(c => cellLabel(c)).join('+')} = ${offending.total} ` +
                `contradicts golden solution (sums to ${goldSum})`,
              );
            }
          }
        }

        if (result.eliminations.length > 0) {
          if (this._goldenSolution !== null) {
            const offending = result.eliminations.filter(e => {
              const [r, c] = e.cell;
              const gold = this._goldenSolution![r]?.[c];
              return gold !== undefined && e.digit === gold && this.board.cands(r, c).has(gold);
            });
            if (offending.length > 0) {
              if (this._onViolation !== null) {
                // Report only the first violation per solve() pass — subsequent
                // violations may be cascades of the first bug.
                if (!this._violationFired) {
                  this._onViolation(item.rule.name, offending);
                  this._violationFired = true;
                }
                // Always suppress the entire rule result regardless of whether
                // the violation was reported.
                continue;
              } else {
                const [r, c] = offending[0]!.cell;
                const gold = offending[0]!.digit;
                throw new NoSolnError(
                  `${item.rule.name}: would eliminate correct digit ${gold} from r${r + 1}c${c + 1}`,
                );
              }
            }
          }
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
          this._onSolutionElimination(se, item.rule.name);
        for (const vca of result.virtualCageAdditions) {
          if (!(this.board instanceof KillerBoardState)) continue;
          this.board.addVirtualCage(vca.cells, vca.total, []);
          this.board.linearSystem.pendingVirtualCages.shift();

          // Seed COUNT_DECREASED/SOLUTION_PRUNED for the new unit, mirroring
          // _seedInitialState, so cage rules evaluate it within this pass.
          const newUnitId = this.board.units.length - 1;
          for (const trigger of [Trigger.COUNT_DECREASED, Trigger.SOLUTION_PRUNED]) {
            for (const rule of this._triggerMap.get(trigger) ?? []) {
              if (rule.unitKinds.size === 0 || rule.unitKinds.has(UnitKind.CAGE))
                this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!,
                  newUnitId, -1, trigger, null);
            }
          }

          this.appliedVirtualCages.push(vca);
          this.appliedMutations.push({ ruleName: item.rule.name, type: 'virtual_cage_added',
            cells: vca.cells, total: vca.total });
        }
      }
    }

    this.pendingHints = dedupHints(this.pendingHints);
    return this.board;
  }
}

// ---------------------------------------------------------------------------
// KillerSolverEngine — owns linear-system propagation and cage-solution pruning
// ---------------------------------------------------------------------------

export class KillerSolverEngine extends SolverEngine {
  override readonly board: KillerBoardState;

  constructor(board: KillerBoardState, rules: SolverRule[], opts: SolverEngineOptions = {}) {
    super(board, rules, opts);
    this.board = board;
  }

  protected override _onCellDetermined(cell: Cell, val: number): void {
    const newConstraints = this.board.linearSystem.substituteLiveRows(cell, val);
    if (newConstraints.length === 0) return;

    // Cell-set -> total for existing units, so a derived constraint is only
    // skipped as redundant when an existing unit covers the same cells *and*
    // sums to the same total. A matching cell-set with a different total is a
    // genuinely new constraint (e.g. it may contradict a corrupted cage total).
    const existingTotals = new Map<string, number>();
    for (const u of this.board.units) {
      const key = u.cells.map(cellKey).slice().sort().join('|');
      if (u.kind === UnitKind.CAGE) {
        const solns = this.board.cageSolns[u.unitId - CAGE_UNIT_OFFSET];
        if (solns && solns.length > 0) existingTotals.set(key, solns[0]!.reduce((a, b) => a + b, 0));
      } else {
        // Rows/cols/boxes always hold 1-9 exactly once, summing to 45.
        existingTotals.set(key, 45);
      }
    }
    for (const [vcells, vtotal, distinct] of newConstraints) {
      if (!distinct) continue;
      const cells = [...vcells] as Cell[];
      if (cells.length === 1) {
        this._checkAgainstGolden('DerivedVirtualCage', cells[0]!, vtotal);
      }
      const key = cells.map(cellKey).slice().sort().join('|');
      if (existingTotals.get(key) === vtotal) continue;
      existingTotals.set(key, vtotal);
      this.board.linearSystem.pendingVirtualCages.push({ cells, total: vtotal });
    }
  }

  protected override _onSolutionElimination(se: SolutionElimination, ruleName: string): void {
    const solns = this.board.cageSolns[se.cageIdx]!;
    const idx = solns.findIndex(s => s.length === se.solution.length && s.every((d, i) => d === se.solution[i]));
    if (idx < 0) return;
    solns.splice(idx, 1);
    const cageUnitId = CAGE_UNIT_OFFSET + se.cageIdx;
    this.board.unitVersions[cageUnitId]!++;
    this.appliedMutations.push({ ruleName, type: 'solution_eliminated', cageIdx: se.cageIdx, solution: se.solution });
    for (const rule of this._triggerMap.get(Trigger.SOLUTION_PRUNED) ?? [])
      this.queue.enqueueUnit(rule.priority, rule, this._ruleIndex.get(rule)!, cageUnitId,
        this.board.unitVersions[cageUnitId]! - 1, Trigger.SOLUTION_PRUNED, null);
    for (const rule of this._triggerMap.get(Trigger.GLOBAL) ?? [])
      this.queue.enqueueGlobal(rule.priority, rule, this._ruleIndex.get(rule)!);
  }
}
