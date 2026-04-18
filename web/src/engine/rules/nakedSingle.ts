/**
 * NakedSingle — R1a: cell with a single candidate receives that digit.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.naked_single` module.
 *
 * Fires on CELL_DETERMINED (ctx.cell and ctx.hintDigit set by the engine when
 * a candidate set collapses to a singleton). Returns a Placement; the engine
 * records it in appliedPlacements for the UI to consume.
 */

import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import {
  Elimination,
  emptyResult,
  RuleResult,
  Trigger,
  UnitKind,
} from '../types.js';

export class NakedSingle {
  readonly name = 'NakedSingle';
  readonly description =
    'When a cell has only one remaining candidate, that digit must go there.';
  readonly priority = 0;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.CELL_DETERMINED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    if (ctx.cell === null || ctx.hintDigit === null) return emptyResult();
    return { ...emptyResult(), placements: [{ cell: ctx.cell, digit: ctx.hintDigit }] };
  }

  asHints(ctx: RuleContext, _eliminations: Elimination[]): HintResult[] {
    if (ctx.cell === null || ctx.hintDigit === null) return [];
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    return [{
      ruleName: this.name,
      displayName: 'Naked Single',
      explanation: `Cell r${r + 1}c${c + 1} has only one remaining candidate: ${d}. Place ${d} there.`,
      highlightCells: [ctx.cell],
      eliminations: [],
      placement: [r, c, d],
      virtualCageSuggestion: null,
    }];
  }
}
