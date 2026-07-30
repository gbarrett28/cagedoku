/**
 * NakedPair — R7: two cells locked to the same two candidates → eliminate from unit peers.
 *
 * When exactly two cells in a ROW/COL/BOX share the same two candidates and no
 * others, those two digits can be removed from all other cells in that unit.
 */

import type { BoardState } from '../boardState.js';
import type { HintResult } from '../hint.js';
import type { RuleContext } from '../rule.js';
import { Cell, Elimination, emptyResult, RuleResult, Trigger, Unit, UnitKind } from '../types.js';
import { cellLabel, unitLabel } from './_labels.js';

/** A naked pair found in one or more units, keyed by its own two cells. */
interface DistinctPair {
  readonly c1: Cell;
  readonly c2: Cell;
  readonly dLo: number;
  readonly dHi: number;
  readonly units: Unit[];
}

export class NakedPair {
  readonly name = 'NakedPair';
  readonly killerOnly = false;
  readonly displayName = 'Naked Pair';
  readonly description = `\
Naked Pair — two cells in a unit locked to the same two candidates exclude those digits from all other cells.

If cells A and B in a unit each have exactly two candidates {d1, d2} and nothing else, then d1 and d2 must go in A and B (one each, in some order). No other cell in the unit can hold either digit.

Proof (two cases, exhaustive because A must hold one of {d1, d2}):
  Case A = d1: B must be d2 (only remaining candidate). Neither d1 nor d2 is available elsewhere.
  Case A = d2: B must be d1. Same conclusion.
Either way, d1 and d2 are consumed by A and B, so every other cell in the unit can eliminate both.

Guards:
  cands(A).size === 2        A must be a bivalue cell
  cands(A).size === cands(B).size  B must also be bivalue
  cands(A) ⊆ cands(B)       both cells share the same pair (set equality follows from equal-size subset)`.trim();
  readonly priority = 6;
  // COUNT_HIT_TWO: catches pairs where a digit's unit-count reaches 2 (fast path).
  // GLOBAL: catches pairs where both digits have unit-count > 2 but two cells have
  //   narrowed to exactly the same two candidates (e.g. {1,5} in r6c0 and r6c6 while
  //   1 or 5 also appear in other cells of the unit).
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.COUNT_HIT_TWO, Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set([UnitKind.ROW, UnitKind.COL, UnitKind.BOX]);

  private _findPairInCells(board: BoardState, cells: readonly Cell[]): [Cell, Cell, number, number] | null {
    const twos = (cells as Cell[]).filter(([r, c]) => board.cands(r, c).size === 2);
    for (let i = 0; i < twos.length - 1; i++) {
      const c1 = twos[i]!;
      const cands1 = board.cands(c1[0], c1[1]);
      for (let j = i + 1; j < twos.length; j++) {
        const c2 = twos[j]!;
        const cands2 = board.cands(c2[0], c2[1]);
        let same = true;
        for (const d of cands1) { if (!cands2.has(d)) { same = false; break; } }
        if (same) {
          const [dLo, dHi] = [...cands1].sort((a, b) => a - b) as [number, number];
          return [c1, c2, dLo, dHi];
        }
      }
    }
    return null;
  }

  private _activeUnits(ctx: RuleContext): readonly Unit[] {
    if (ctx.unit !== null) return [ctx.unit];
    return ctx.board.units.filter(u => this.unitKinds.has(u.kind));
  }

  /**
   * Groups the pair found in each active unit by its two cells, so a pair that
   * satisfies more than one unit at once (e.g. a row-pair that is also a
   * box-pair) collapses into a single entry instead of being reported twice.
   */
  private _distinctPairs(ctx: RuleContext): DistinctPair[] {
    const found = new Map<string, DistinctPair>();
    for (const unit of this._activeUnits(ctx)) {
      const pair = this._findPairInCells(ctx.board, unit.cells);
      if (!pair) continue;
      const [c1, c2, dLo, dHi] = pair;
      const key = `${c1[0]},${c1[1]}-${c2[0]},${c2[1]}`;
      const entry = found.get(key);
      if (entry) entry.units.push(unit);
      else found.set(key, { c1, c2, dLo, dHi, units: [unit] });
    }
    return [...found.values()];
  }

  /** Union of cells from all of a pair's units, excluding the pair's own two cells. */
  private _peerCells(pair: DistinctPair): Cell[] {
    const c1k = `${pair.c1[0]},${pair.c1[1]}`, c2k = `${pair.c2[0]},${pair.c2[1]}`;
    const seen = new Set<string>();
    const peers: Cell[] = [];
    for (const unit of pair.units) {
      for (const [r, c] of unit.cells as Cell[]) {
        const key = `${r},${c}`;
        if (key === c1k || key === c2k || seen.has(key)) continue;
        seen.add(key);
        peers.push([r, c] as Cell);
      }
    }
    return peers;
  }

  apply(ctx: RuleContext): RuleResult {
    const elims: Elimination[] = [];
    for (const pair of this._distinctPairs(ctx)) {
      for (const [r, c] of this._peerCells(pair)) {
        if (ctx.board.cands(r, c).has(pair.dLo)) elims.push({ cell: [r, c] as Cell, digit: pair.dLo });
        if (ctx.board.cands(r, c).has(pair.dHi)) elims.push({ cell: [r, c] as Cell, digit: pair.dHi });
      }
    }
    return { ...emptyResult(), eliminations: elims };
  }

  asHints(ctx: RuleContext, eliminations: Elimination[]): HintResult[] {
    if (!eliminations.length) return [];
    const hints: HintResult[] = [];
    for (const pair of this._distinctPairs(ctx)) {
      const peerCells = this._peerCells(pair);
      const peerKeys = new Set(peerCells.map(([r, c]) => `${r},${c}`));
      const ownElims = eliminations.filter(e =>
        (e.digit === pair.dLo || e.digit === pair.dHi) && peerKeys.has(`${e.cell[0]},${e.cell[1]}`));
      if (!ownElims.length) continue;
      const unitsLabel = pair.units.map(unitLabel).join(' and ');
      const unitOrUnits = pair.units.length > 1 ? 'those units' : 'that unit';
      hints.push({
        ruleName: this.name,
        displayName: 'Naked Pair',
        explanation: `${cellLabel(pair.c1)} and ${cellLabel(pair.c2)} both have only {${pair.dLo},${pair.dHi}} as candidates in ${unitsLabel}. These digits can be eliminated from all other cells in ${unitOrUnits}.`,
        highlightCells: [pair.c1, pair.c2],
        eliminations: ownElims,
        placement: null,
        virtualCageSuggestion: null,
      });
    }
    return hints;
  }
}
