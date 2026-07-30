/**
 * SolverRule interface, RuleContext, and RuleStats.
 *
 * SolverRule is a structural interface — any object with the required
 * fields and an apply() method qualifies. Rules are stateless; all mutable
 * state lives in KillerBoardState.
 */

import { KillerBoardState } from './boardState.js';
import type { BoardState } from './boardState.js';
import type { HintResult } from './hint.js';
import { emptyResult } from './types.js';
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

/** Convenience constructor: zeroed RuleStats for a newly registered rule. */
export function makeRuleStats(): RuleStats {
  return { calls: 0, progress: 0, eliminations: 0, elapsedNs: 0 };
}

/** Structural interface for solver rules. */
export interface SolverRule {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly priority: number;
  /** True when this rule requires killer cage constraints and must be excluded for classic puzzles. */
  readonly killerOnly: boolean;
  readonly triggers: ReadonlySet<Trigger>;
  /**
   * Empty set means GLOBAL / cell-scoped (unit=null in ctx).
   * For unit-scoped rules, the set lists which UnitKind values apply.
   */
  readonly unitKinds: ReadonlySet<UnitKind>;

  apply(ctx: RuleContext): RuleResult;

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[];
}

/** Narrows `RuleContext.board` to `KillerBoardState` for killer-only rules —
 *  `ctx.board.linearSystem`/`regions`/`cageSolns`/`spec` are then directly
 *  typed, with no cast and no further narrow inside the rule body. */
export interface KillerRuleContext extends Omit<RuleContext, 'board'> {
  readonly board: KillerBoardState;
}

/**
 * Shared base for the ten rules that require killer cage constraints
 * (`deltaConstraint`, `linearElimination`, `sumPairConstraint`,
 * `cageCandidateFilter`, `cageConfinement`, `cageIntersection`, `mustContain`,
 * `mustContainOutie`, `solutionMapFilter`, `unitPartitionFilter`).
 *
 * Performs the `ctx.board instanceof KillerBoardState` narrow exactly once —
 * in `apply`/`asHints` — and hands subclasses a `KillerRuleContext` whose
 * `board` is directly typed as `KillerBoardState`. `killerOnly` is set here so
 * it is never repeated across the ten subclasses.
 *
 * `buildEngine` (via `PuzzleState.isKiller`) already filters `killerOnly`
 * rules out of the classic rule set, so the `instanceof` branch below is
 * unreachable in practice — but the type system still requires *some* narrow
 * to expose `KillerBoardState`'s members to `applyKiller`/`asHintsKiller`,
 * and this is the one place it lives (defense in depth).
 */
export abstract class KillerOnlyRule implements SolverRule {
  readonly killerOnly = true;

  apply(ctx: RuleContext): RuleResult {
    if (!(ctx.board instanceof KillerBoardState)) return emptyResult();
    return this.applyKiller({ ...ctx, board: ctx.board });
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (!(ctx.board instanceof KillerBoardState)) return [];
    return this.asHintsKiller({ ...ctx, board: ctx.board }, eliminations);
  }

  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly priority: number;
  abstract readonly triggers: ReadonlySet<Trigger>;
  abstract readonly unitKinds: ReadonlySet<UnitKind>;
  abstract applyKiller(ctx: KillerRuleContext): RuleResult;
  abstract asHintsKiller(ctx: KillerRuleContext, eliminations: readonly Elimination[]): HintResult[];
}
