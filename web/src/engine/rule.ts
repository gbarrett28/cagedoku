/**
 * SolverRule interface, RuleContext, and RuleStats.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rule` module.
 *
 * SolverRule is a structural interface — any object with the required
 * fields and an apply() method qualifies. Rules are stateless; all mutable
 * state lives in BoardState.
 */

import type { BoardState } from './boardState.js';
import type { HintResult } from './hint.js';
import type { Cell, Elimination, RuleResult, Trigger, Unit, UnitKind } from './types.js';

/** Input to a rule's apply() method. */
export interface RuleContext {
  /** null for CELL_DETERMINED and GLOBAL rules. */
  readonly unit: Unit | null;
  /** Set for CELL_DETERMINED; null otherwise. */
  readonly cell: Cell | null;
  readonly board: BoardState;
  readonly hint: Trigger;
  readonly hintDigit: number | null;
}

/** Accumulated statistics for a single rule across all solves. */
export interface RuleStats {
  calls: number;
  progress: number;
  eliminations: number;
  elapsedNs: number;
}

export function makeRuleStats(): RuleStats {
  return { calls: 0, progress: 0, eliminations: 0, elapsedNs: 0 };
}

/** Structural interface for solver rules. */
export interface SolverRule {
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly triggers: ReadonlySet<Trigger>;
  /**
   * Empty set means GLOBAL / cell-scoped (unit=null in ctx).
   * For unit-scoped rules, the set lists which UnitKind values apply.
   */
  readonly unitKinds: ReadonlySet<UnitKind>;

  apply(ctx: RuleContext): RuleResult;

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[];
}
