/**
 * Rule effects as data: each mutation carries its own `apply`, so dispatch
 * lives on the value itself rather than in an external switch. The only
 * type-keyed switch in this module is `RuleMutation.revive`, used to
 * reconstruct mutations after a JSON round-trip (JSON.stringify drops the
 * `apply` closure).
 */

import { PuzzleState } from './types.js';
import type { KillerPuzzleState, VirtualCage } from './types.js';
import type { Cell } from '../engine/types.js';

export interface RuleMutation {
  readonly type: string;
  apply(state: PuzzleState): PuzzleState;
}

/** One rule's worth of mutations shown and applied in the auto-apply animation. */
export interface RuleStep {
  readonly ruleName: string;
  readonly displayName: string;
  readonly highlightCells: readonly Cell[];
  readonly mutations: readonly RuleMutation[];
}

// ---------------------------------------------------------------------------
// PlaceDigitMutation
// ---------------------------------------------------------------------------

export interface PlaceDigitMutation extends RuleMutation {
  readonly type: 'placeDigit';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}

export namespace PlaceDigitMutation {
  export function apply(m: Omit<PlaceDigitMutation, 'apply'>, state: PuzzleState): PuzzleState {
    const userGrid = state.userGrid.map(row => [...row]);
    userGrid[m.row]![m.col] = m.digit;
    return { ...state, userGrid };
  }
}

// ---------------------------------------------------------------------------
// EliminateCandidateMutation
// ---------------------------------------------------------------------------

export interface EliminateCandidateMutation extends RuleMutation {
  readonly type: 'eliminateCandidate';
  readonly row: number;
  readonly col: number;
  readonly digit: number;
}

export namespace EliminateCandidateMutation {
  export function apply(m: Omit<EliminateCandidateMutation, 'apply'>, state: PuzzleState): PuzzleState {
    return {
      ...state,
      userRemovedCandidates: [...state.userRemovedCandidates, [m.row, m.col, m.digit]],
    };
  }
}

// ---------------------------------------------------------------------------
// AddVirtualCageMutation
// ---------------------------------------------------------------------------

export interface AddVirtualCageMutation extends RuleMutation {
  readonly type: 'addVirtualCage';
  readonly cage: VirtualCage;
}

export namespace AddVirtualCageMutation {
  export function apply(m: Omit<AddVirtualCageMutation, 'apply'>, state: PuzzleState): PuzzleState {
    if (!PuzzleState.isKiller(state)) {
      throw new Error('AddVirtualCageMutation can only be applied to a killer puzzle state');
    }
    const next: KillerPuzzleState = { ...state, virtualCages: [...state.virtualCages, m.cage] };
    return next;
  }
}

// ---------------------------------------------------------------------------
// EliminateCageSolutionMutation
// ---------------------------------------------------------------------------

export interface EliminateCageSolutionMutation extends RuleMutation {
  readonly type: 'eliminateCageSolution';
  readonly cageId: string;
  readonly solution: readonly number[];
}

export namespace EliminateCageSolutionMutation {
  export function apply(m: Omit<EliminateCageSolutionMutation, 'apply'>, state: PuzzleState): PuzzleState {
    if (!PuzzleState.isKiller(state)) {
      throw new Error('EliminateCageSolutionMutation can only be applied to a killer puzzle state');
    }
    const idx = state.cageStates.findIndex(c => c.label === m.cageId);
    if (idx === -1) {
      throw new Error(`EliminateCageSolutionMutation: no cage with label '${m.cageId}'`);
    }
    const cageStates = state.cageStates.map((c, i) =>
      i === idx ? { ...c, userEliminatedSolns: [...c.userEliminatedSolns, m.solution] } : c,
    );
    const next: KillerPuzzleState = { ...state, cageStates };
    return next;
  }
}

// ---------------------------------------------------------------------------
// RuleMutation factories and revive
// ---------------------------------------------------------------------------

export namespace RuleMutation {
  export function placeDigit(row: number, col: number, digit: number): PlaceDigitMutation {
    const data = { type: 'placeDigit' as const, row, col, digit };
    return { ...data, apply: (state: PuzzleState) => PlaceDigitMutation.apply(data, state) };
  }

  export function eliminateCandidate(row: number, col: number, digit: number): EliminateCandidateMutation {
    const data = { type: 'eliminateCandidate' as const, row, col, digit };
    return { ...data, apply: (state: PuzzleState) => EliminateCandidateMutation.apply(data, state) };
  }

  export function addVirtualCage(cage: VirtualCage): AddVirtualCageMutation {
    const data = { type: 'addVirtualCage' as const, cage };
    return { ...data, apply: (state: PuzzleState) => AddVirtualCageMutation.apply(data, state) };
  }

  export function eliminateCageSolution(cageId: string, solution: readonly number[]): EliminateCageSolutionMutation {
    const data = { type: 'eliminateCageSolution' as const, cageId, solution };
    return { ...data, apply: (state: PuzzleState) => EliminateCageSolutionMutation.apply(data, state) };
  }

  /**
   * Reconstructs a mutation from its JSON-deserialized data. JSON.stringify
   * drops the `apply` closure that factories attach, so persisted mutations
   * (in `Turn`/`ApplyHintAction`, written to localStorage) must be revived
   * before `.apply()` can be called again. This switch is the only
   * type-keyed dispatch in the module — every other call site uses
   * `mutation.apply(state)` directly.
   */
  export function revive(data: { type: string; [k: string]: unknown }): RuleMutation {
    switch (data.type) {
      case 'placeDigit':
        return placeDigit(data['row'] as number, data['col'] as number, data['digit'] as number);
      case 'eliminateCandidate':
        return eliminateCandidate(data['row'] as number, data['col'] as number, data['digit'] as number);
      case 'addVirtualCage':
        return addVirtualCage(data['cage'] as VirtualCage);
      case 'eliminateCageSolution':
        return eliminateCageSolution(data['cageId'] as string, data['solution'] as readonly number[]);
      default:
        throw new Error(`RuleMutation.revive: unknown mutation type '${data.type}'`);
    }
  }
}
