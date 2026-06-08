/**
 * Tests for KillerOnlyRule — the shared `instanceof KillerBoardState` narrow
 * for all ten killer-only rules (spec: cage-free-board-state-for-classic §2.1).
 */

import { describe, expect, it } from 'vitest';
import { BoardState, KillerBoardState } from './boardState.js';
import { KillerOnlyRule } from './rule.js';
import type { KillerRuleContext, RuleContext } from './rule.js';
import type { HintResult } from './hint.js';
import { emptyResult, Trigger, UnitKind } from './types.js';
import type { Cell, Elimination, RuleResult } from './types.js';
import { makeTrivialSpec } from './fixtures.js';

class StubKillerRule extends KillerOnlyRule {
  readonly name = 'StubKillerRule';
  readonly displayName = 'Stub Killer Rule';
  readonly description = '';
  readonly priority = 1;
  readonly triggers: ReadonlySet<Trigger> = new Set([Trigger.GLOBAL]);
  readonly unitKinds: ReadonlySet<UnitKind> = new Set();

  applyKiller(_ctx: KillerRuleContext): RuleResult {
    return { ...emptyResult(), eliminations: [{ cell: [0, 0] as Cell, digit: 1 }] };
  }

  asHintsKiller(_ctx: KillerRuleContext, _eliminations: readonly Elimination[]): HintResult[] {
    return [{
      ruleName: this.name,
      displayName: this.displayName,
      explanation: 'stub',
      highlightCells: [],
      eliminations: [],
      placement: null,
      virtualCageSuggestion: null,
    }];
  }
}

function ctxFor(board: RuleContext['board']): RuleContext {
  return { unit: null, cell: null, board, hint: Trigger.GLOBAL, hintDigit: null };
}

describe('KillerOnlyRule — defense-in-depth narrow', () => {
  it('apply returns emptyResult() when ctx.board is a plain BoardState', () => {
    const rule = new StubKillerRule();
    expect(rule.apply(ctxFor(new BoardState()))).toEqual(emptyResult());
  });

  it('asHints returns [] when ctx.board is a plain BoardState', () => {
    const rule = new StubKillerRule();
    expect(rule.asHints(ctxFor(new BoardState()), [])).toEqual([]);
  });

  it('apply delegates to applyKiller when ctx.board is a KillerBoardState', () => {
    const rule = new StubKillerRule();
    const result = rule.apply(ctxFor(new KillerBoardState(makeTrivialSpec())));
    expect(result.eliminations).toEqual([{ cell: [0, 0], digit: 1 }]);
  });

  it('asHints delegates to asHintsKiller when ctx.board is a KillerBoardState', () => {
    const rule = new StubKillerRule();
    const hints = rule.asHints(ctxFor(new KillerBoardState(makeTrivialSpec())), []);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.ruleName).toBe('StubKillerRule');
  });
});
