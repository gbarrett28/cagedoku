/**
 * Brute-force rule trigger validator.
 *
 * After the rule engine reaches a fixed point, calls every active rule against
 * every plausible context (all units, all singleton cells, global) — bypassing
 * the trigger/queue system — to detect cases where a rule would produce
 * actionable candidate eliminations that were never applied.
 *
 * A "trigger miss" means the trigger routing failed to enqueue the rule for a
 * context where its apply() would have made progress. This complements the
 * existing wrong-elimination detector (which catches rules that fire but produce
 * incorrect results).
 */

import type { BoardState } from './boardState.js';
import type { RuleContext, SolverRule } from './rule.js';
import { Cell, RuleResult, Trigger, UnitKind } from './types.js';

/** One detected trigger miss: a rule that found actionable progress a given context. */
export interface TriggerMiss {
  readonly ruleName: string;
  /** Human-readable context identifier, e.g. "GLOBAL" or "COUNT_DECREASED:ROW:3". */
  readonly missedContext: string;
  /** Candidate eliminations that are still actionable on the board. */
  readonly eliminations: ReadonlyArray<{ readonly cell: [number, number]; readonly digit: number }>;
}

function triggerLabel(t: Trigger): string {
  return Trigger[t] ?? String(t);
}

function unitKindLabel(k: UnitKind): string {
  return UnitKind[k] ?? String(k);
}

/**
 * Filter a rule result to the eliminations that are still actionable on `board`
 * (the digit is still present in the cell's candidate set) and that do NOT
 * contradict `golden` (wrong-rule bugs are handled by the existing violation
 * detector and should not be double-reported here).
 *
 * Returns an empty array when any elimination in the result would remove a
 * golden digit — the entire context is skipped so only clean misses are reported.
 */
function actionableEliminations(
  result: RuleResult,
  board: BoardState,
  golden: readonly (readonly number[])[] | null,
): Array<{ cell: [number, number]; digit: number }> {
  if (result.eliminations.length === 0) return [];

  if (golden !== null) {
    // If any elimination would remove the correct digit, the rule itself is wrong —
    // skip the entire context; the violation detector handles wrong rules.
    const hasGoldenViolation = result.eliminations.some(e => {
      const [r, c] = e.cell;
      const g = golden[r]?.[c];
      return g !== undefined && e.digit === g && board.cands(r, c).has(g);
    });
    if (hasGoldenViolation) return [];
  }

  return result.eliminations
    .filter(e => board.cands(e.cell[0], e.cell[1]).has(e.digit))
    .map(e => ({ cell: e.cell as [number, number], digit: e.digit }));
}

/**
 * Run every rule in `rules` against every plausible context without going through
 * the trigger/queue system. Returns trigger misses: rules whose apply() produces
 * actionable candidate eliminations that were not applied by the normal solve pass.
 *
 * Call this after `SolverEngine.solve()` reaches a fixed point. An empty return
 * value means the trigger system fired all rules correctly for the current board.
 *
 * @param board         Post-solve board state (read-only; not mutated).
 * @param rules         Active rules to check (disabled and puzzle-excluded rules omitted).
 * @param goldenSolution  When provided, contexts that would violate the golden solution
 *                        are skipped (those are wrong-rule bugs, not trigger misses).
 */
export function findTriggerMisses(
  board: BoardState,
  rules: readonly SolverRule[],
  goldenSolution: readonly (readonly number[])[] | null = null,
): TriggerMiss[] {
  const misses: TriggerMiss[] = [];

  for (const rule of rules) {
    for (const trigger of rule.triggers) {

      if (trigger === Trigger.GLOBAL) {
        const ctx: RuleContext = {
          unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null,
        };
        let result: RuleResult;
        try { result = rule.apply(ctx); } catch { continue; }
        const elims = actionableEliminations(result, board, goldenSolution);
        if (elims.length > 0)
          misses.push({ ruleName: rule.name, missedContext: 'GLOBAL', eliminations: elims });

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
            const elims = actionableEliminations(result, board, goldenSolution);
            if (elims.length > 0)
              misses.push({
                ruleName: rule.name,
                missedContext: `${triggerLabel(trigger)}:r${r + 1}c${c + 1}`,
                eliminations: elims,
              });
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
          const elims = actionableEliminations(result, board, goldenSolution);
          if (elims.length > 0)
            misses.push({
              ruleName: rule.name,
              missedContext: `${triggerLabel(trigger)}:${unitKindLabel(unit.kind)}:${unit.unitId}`,
              eliminations: elims,
            });
        }
      }
    }
  }

  return misses;
}
