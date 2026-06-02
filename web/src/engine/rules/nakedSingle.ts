/**
 * NakedSingle — R1: cell with a single candidate receives that digit, and that
 * digit is removed from all row/col/box/distinct-cage peers.
 *
 * Combines the former NakedSingle (placement) and CellSolutionElimination (peer
 * elimination) into a single rule so both effects are always applied together.
 *
 * Fires on CELL_DETERMINED (ctx.cell and ctx.hintDigit set by the engine when
 * a candidate set collapses to a singleton). Returns a Placement and all peer
 * Eliminations in one RuleResult.
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
Naked Single — a cell reduced to one candidate must hold that digit, and that digit
is eliminated from all peers in shared rows, columns, boxes, and distinct-digit cages.

When all other digits have been eliminated from a cell, the remaining candidate is the
cell's value by exhaustion. Once placed, the digit cannot appear in any peer cell that
shares a unit with it.

Proof: Let C have candidates = {d}. Every other digit d' ≠ d has already been eliminated
from C. Therefore C = d. For any peer P sharing a unit U with C: if d ∈ candidates(P),
the unit constraint would require two occurrences of d in U — contradiction. Therefore d
can be eliminated from every such P.

Guards:
  ctx.cell !== null      engine sets this only when CELL_DETERMINED fires
  ctx.hintDigit !== null engine sets this to the sole remaining candidate`.trim();
  readonly priority = 0;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.CELL_DETERMINED]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  apply(ctx: RuleContext): RuleResult {
    if (ctx.cell === null || ctx.hintDigit === null) return emptyResult();
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    return { ...emptyResult(), placements: [{ cell: ctx.cell, digit: d }], eliminations: ctx.board.peerEliminations(r, c, d) };
  }

  asHints(ctx: RuleContext, eliminations: readonly Elimination[]): HintResult[] {
    if (ctx.cell === null || ctx.hintDigit === null) return [];
    const [r, c] = ctx.cell;
    const d = ctx.hintDigit;
    const peerNote = eliminations.length > 0
      ? ` This also removes ${d} from ${eliminations.length === 1 ? '1 peer' : `${eliminations.length} peers`}: ${eliminations.map(e => cellLabel(e.cell)).join(', ')}.`
      : '';
    return [{
      ruleName: this.name,
      displayName: 'Naked Single',
      explanation: `Cell ${cellLabel([r, c] as Cell)} has only one remaining candidate: ${d}. Place ${d} there.${peerNote}`,
      highlightCells: [[r, c] as Cell],
      eliminations,
      placement: [r, c, d],
      virtualCageSuggestion: null,
    }];
  }
}
