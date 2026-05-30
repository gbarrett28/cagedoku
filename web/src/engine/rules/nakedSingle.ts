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
  Cell,
  Elimination,
  emptyResult,
  RuleResult,
  Trigger,
  UnitKind,
} from '../types.js';
import { cellLabel } from './_labels.js';

export class NakedSingle {
  readonly name = 'NakedSingle';
  readonly displayName = 'Naked Single';
  readonly description = `\
Naked Single — a cell reduced to one candidate must hold that digit.

When all other digits have been eliminated from a cell, the remaining candidate is the cell's value by exhaustion: every digit from 1–9 must appear exactly once in the cell's row, column, and box, so the last possible digit is forced.

Proof: Let C have candidates = {d}. Every other digit d' ≠ d has already been eliminated from C (by row, column, box, or cage constraints). Therefore C = d.

Guards:
  ctx.cell !== null      engine sets this only when CELL_DETERMINED fires
  ctx.hintDigit !== null engine sets this to the sole remaining candidate`.trim();
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
      ? ` This also removes ${d} from ${peerCells.length === 1 ? '1 peer' : `${peerCells.length} peers`}: ${peerCells.map(p => cellLabel(p)).join(', ')}.`
      : '';
    return [{
      ruleName: this.name,
      displayName: 'Naked Single',
      explanation: `Cell ${cellLabel([r, c] as Cell)} has only one remaining candidate: ${d}. Place ${d} there.${peerNote}`,
      highlightCells: [[r, c] as Cell, ...peerCells],
      eliminations: [],
      placement: [r, c, d],
      virtualCageSuggestion: null,
    }];
  }
}
