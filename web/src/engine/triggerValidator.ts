/**
 * Brute-force rule trigger validator.
 *
 * After the rule engine reaches a fixed point, calls every active rule against
 * every plausible context (all units, all singleton cells, global) — bypassing
 * the trigger/queue system — to detect two classes of problem:
 *
 *  • Trigger miss   — the rule would produce valid eliminations that weren't
 *                     applied, meaning the trigger/queue system failed to
 *                     enqueue it for a context where it had progress.
 *
 *  • Brute-force violation — the rule would eliminate a golden-solution digit,
 *                     but its trigger never fires so the normal engine violation
 *                     detector (onViolation in SolverEngine) never sees it.
 *                     Without this path, such rules silently escape detection.
 */

import type { KillerBoardState } from './boardState.js';
import type { RuleContext, SolverRule } from './rule.js';
import { Cell, RuleResult, Trigger, UnitKind } from './types.js';

/** A rule that found actionable valid progress that was not applied. */
export interface TriggerMiss {
  readonly ruleName: string;
  /** Human-readable context identifier, e.g. "GLOBAL" or "COUNT_DECREASED:ROW:3". */
  readonly missedContext: string;
  /** Candidate eliminations that are still actionable on the board. */
  readonly eliminations: ReadonlyArray<{ readonly cell: [number, number]; readonly digit: number }>;
}

/**
 * A rule whose brute-force result contains a golden-solution violation.
 * The rule's trigger never fires (trigger miss), so the normal onViolation
 * path in SolverEngine never catches it — this is the only detection point.
 */
export interface TriggerViolation {
  readonly ruleName: string;
  /** Context where the violation was found. */
  readonly missedContext: string;
  /** Eliminations that would remove a correct golden digit. */
  readonly offendingEliminations: ReadonlyArray<{ readonly cell: [number, number]; readonly digit: number }>;
}

export interface TriggerValidationResult {
  readonly misses: readonly TriggerMiss[];
  readonly violations: readonly TriggerViolation[];
}

function triggerLabel(t: Trigger): string {
  return Trigger[t] ?? String(t);
}

function unitKindLabel(k: UnitKind): string {
  return UnitKind[k] ?? String(k);
}

/**
 * Classify the eliminations from a rule result into violations (removing a
 * golden digit) and actionable misses (removing a non-golden digit that is
 * still present in the board).
 *
 * If any violation is present the context is tainted: the actionable list is
 * left empty so a mixed result is not reported as a miss — it is only filed
 * as a violation.
 */
function classifyEliminations(
  result: RuleResult,
  board: KillerBoardState,
  golden: readonly (readonly number[])[] | null,
): {
  violations: Array<{ cell: [number, number]; digit: number }>;
  actionable: Array<{ cell: [number, number]; digit: number }>;
} {
  if (result.eliminations.length === 0) return { violations: [], actionable: [] };

  const violations: Array<{ cell: [number, number]; digit: number }> = [];

  if (golden !== null) {
    for (const e of result.eliminations) {
      const [r, c] = e.cell;
      const g = golden[r]?.[c];
      if (g !== undefined && e.digit === g && board.cands(r, c).has(g))
        violations.push({ cell: e.cell as [number, number], digit: e.digit });
    }
  }

  // Tainted context: report only the violation, not any coincidental valid elims.
  if (violations.length > 0) return { violations, actionable: [] };

  const actionable = result.eliminations
    .filter(e => board.cands(e.cell[0], e.cell[1]).has(e.digit))
    .map(e => ({ cell: e.cell as [number, number], digit: e.digit }));

  return { violations: [], actionable };
}

/**
 * Run every rule in `rules` against every plausible context without going through
 * the trigger/queue system. Returns trigger misses (valid progress not applied) and
 * brute-force violations (golden-solution contradictions whose trigger never fired).
 *
 * Call this after `SolverEngine.solve()` reaches a fixed point.
 *
 * @param board          Post-solve board state (read-only; not mutated).
 * @param rules          Active rules to check (disabled and puzzle-excluded rules omitted).
 * @param goldenSolution When provided, used to classify eliminations as violations vs. misses.
 */
export function findTriggerMisses(
  board: KillerBoardState,
  rules: readonly SolverRule[],
  goldenSolution: readonly (readonly number[])[] | null = null,
): TriggerValidationResult {
  const misses: TriggerMiss[] = [];
  const violations: TriggerViolation[] = [];

  for (const rule of rules) {
    for (const trigger of rule.triggers) {

      if (trigger === Trigger.GLOBAL) {
        const ctx: RuleContext = {
          unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null,
        };
        let result: RuleResult;
        try { result = rule.apply(ctx); } catch { continue; }
        const { violations: v, actionable } = classifyEliminations(result, board, goldenSolution);
        if (v.length > 0)
          violations.push({ ruleName: rule.name, missedContext: 'GLOBAL', offendingEliminations: v });
        else if (actionable.length > 0)
          misses.push({ ruleName: rule.name, missedContext: 'GLOBAL', eliminations: actionable });

      } else if (trigger === Trigger.CELL_DETERMINED || trigger === Trigger.CELL_SOLVED) {
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            const cands = board.cands(r, c);
            if (cands.size !== 1) continue;
            const digit = [...cands][0]!;
            const ctx: RuleContext = {
              unit: null, cell: [r, c] as Cell, board, hint: trigger, hintDigit: digit,
            };
            let result: RuleResult;
            try { result = rule.apply(ctx); } catch { continue; }
            const context = `${triggerLabel(trigger)}:r${r + 1}c${c + 1}`;
            const { violations: v, actionable } = classifyEliminations(result, board, goldenSolution);
            if (v.length > 0)
              violations.push({ ruleName: rule.name, missedContext: context, offendingEliminations: v });
            else if (actionable.length > 0)
              misses.push({ ruleName: rule.name, missedContext: context, eliminations: actionable });
          }
        }

      } else {
        // Unit-scoped trigger (COUNT_DECREASED, COUNT_HIT_ONE, COUNT_HIT_TWO, SOLUTION_PRUNED).
        for (const unit of board.units) {
          if (rule.unitKinds.size > 0 && !rule.unitKinds.has(unit.kind)) continue;
          const ctx: RuleContext = {
            unit, cell: null, board, hint: trigger, hintDigit: null,
          };
          let result: RuleResult;
          try { result = rule.apply(ctx); } catch { continue; }
          const context = `${triggerLabel(trigger)}:${unitKindLabel(unit.kind)}:${unit.unitId}`;
          const { violations: v, actionable } = classifyEliminations(result, board, goldenSolution);
          if (v.length > 0)
            violations.push({ ruleName: rule.name, missedContext: context, offendingEliminations: v });
          else if (actionable.length > 0)
            misses.push({ ruleName: rule.name, missedContext: context, eliminations: actionable });
        }
      }
    }
  }

  return { misses, violations };
}
