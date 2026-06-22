/**
 * HiddenSingle — R2: digit with exactly one possible cell in a unit → place it there.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.rules.incomplete.hidden_single` module.
 *
 * For ROW/COL/BOX: count=1 forces the sole remaining cell to hold d.
 * For CAGE: count=1 is necessary but not sufficient — d must appear in EVERY
 * feasible cage solution. If any solution omits d, d is not required.
 */

import type { HintResult } from '../hint.js';
import { KillerBoardState } from '../boardState.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

export class HiddenSingle {
  readonly name = 'HiddenSingle';
  readonly killerOnly = false;
  readonly displayName = 'Hidden Single';
  readonly description = `\
Hidden Single — a digit with only one candidate cell in a unit must go there.

If digit d has only one remaining cell C in a row, column, or box, then d must be placed in C (the unit must contain d exactly once). All other candidates can be removed from C.

For a cage, one additional condition applies: d must appear in every remaining cage solution. If any feasible solution omits d, d may not be needed in that cage position, so no placement is forced.

Proof for row/column/box (one case, exhaustive because count = 1):
  d appears in exactly one cell C in the unit → the unit constraint forces C = d → all other candidates of C are eliminated.

Proof for cage (same logic plus cage-solution check):
  count(d, cage) = 1 AND every cage solution includes d → both the unit constraint and the cage constraint force C = d.

Guards:
  ctx.unit !== null           unit context required
  ctx.hintDigit !== null      digit whose count just hit 1
  ctx.unit.distinctDigits     cage variant only: non-distinct cages allow repeats, unit argument fails
  solns.every(s => s.includes(d))  cage variant only: d absent from some solution → placement not forced`.trim();
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_ONE]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX, UnitKind.CAGE]);

  apply(ctx: RuleContext): RuleResult {
    if (!ctx.unit || ctx.hintDigit === null) return emptyResult();
    const d = ctx.hintDigit;

    if (ctx.unit.kind === UnitKind.CAGE && ctx.board instanceof KillerBoardState) {
      if (!ctx.unit.distinctDigits) return emptyResult();
      const cageIdx = ctx.unit.unitId - 27;
      const solns = ctx.board.cageSolns[cageIdx]!;
      if (!solns.length || !solns.every(s => s.includes(d))) return emptyResult();
    }

    const sole = (ctx.unit.cells as Cell[]).find(([r, c]) => ctx.board.cands(r, c).has(d));
    if (!sole) return emptyResult();
    const [r, c] = sole;
    const elims: Elimination[] = [...ctx.board.cands(r, c)]
      .filter(other => other !== d)
      .map(other => ({ cell: [r, c] as Cell, digit: other }));
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length || !ctx.unit || ctx.hintDigit === null) return [];
    const d = ctx.hintDigit;
    const sole = eliminations[0]!.cell;
    const [r, c] = sole;
    const seen = new Set<string>();
    const peerCells: Cell[] = [];
    for (const uid of ctx.board.cellUnitIds(r, c)) {
      const unit = ctx.board.units[uid]!;
      if (unit.kind === UnitKind.CAGE && !unit.distinctDigits) continue;
      for (const [pr, pc] of unit.cells as Cell[]) {
        if (pr === r && pc === c) continue;
        const key = `${pr},${pc}`;
        if (seen.has(key)) continue;
        if (ctx.board.cands(pr, pc).has(d)) { peerCells.push([pr, pc] as Cell); seen.add(key); }
      }
    }
    const peerNote = peerCells.length > 0
      ? ` Placing ${d} at ${cellLabel([r, c] as Cell)} also removes ${d} from ${peerCells.length === 1 ? '1 peer' : `${peerCells.length} peers`}: ${peerCells.map(p => cellLabel(p)).join(', ')}.`
      : '';
    const explanation = ctx.unit.kind === UnitKind.CAGE
      ? `${d} is the only candidate for ${cellLabel([r, c] as Cell)} in this cage, and ${d} is essential to every remaining cage solution. Place ${d} there by eliminating all other candidates.${peerNote}`
      : `${d} can only go in ${cellLabel([r, c] as Cell)} within ${unitLabel(ctx.unit)}. Eliminate all other candidates from that cell to place ${d}.${peerNote}`;
    return [{
      ruleName: this.name,
      displayName: 'Hidden Single',
      explanation,
      highlightCells: [sole],
      secondaryHighlightCells: (ctx.unit.cells as Cell[]).filter(([ur, uc]) => !(ur === r && uc === c)),
      eliminations,
      placement: null,
      virtualCageSuggestion: null,
      patternDigits: [d],
    }];
  }
}
