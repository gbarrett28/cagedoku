/**
 * Active rule set for the coaching engine.
 *
 * Priority order (ascending = higher priority = fired first):
 *  0  NakedSingle             — CELL_DETERMINED
 *  0  CellSolutionElimination — CELL_SOLVED
 *  1  HiddenSingle            — COUNT_HIT_ONE
 *  1  LinearElimination       — GLOBAL
 *  2  CageCandidateFilter     — SOLUTION_PRUNED
 *  2  CageIntersection        — COUNT_DECREASED / SOLUTION_PRUNED
 *  3  SolutionMapFilter       — COUNT_DECREASED / SOLUTION_PRUNED
 *  4  MustContain             — COUNT_DECREASED
 *  4  MustContainOutie        — COUNT_DECREASED / SOLUTION_PRUNED
 *  5  DeltaConstraint         — COUNT_DECREASED
 *  5  SumPairConstraint       — COUNT_DECREASED / CELL_DETERMINED
 *  6  NakedPair               — COUNT_HIT_TWO
 *  7  HiddenPair              — COUNT_HIT_TWO
 *  8  NakedHiddenTriple       — COUNT_DECREASED
 *  9  NakedHiddenQuad         — COUNT_DECREASED
 *  9  PointingPairs           — COUNT_DECREASED
 * 11  LockedCandidates        — COUNT_DECREASED
 * 12  CageConfinement         — GLOBAL
 * 12  UnitPartitionFilter     — GLOBAL
 * 13  XWing                   — GLOBAL
 * 14  Swordfish               — GLOBAL
 * 15  Jellyfish               — GLOBAL
 * 16  XYWing                  — GLOBAL
 * 17  UniqueRectangle         — GLOBAL
 * 18  SimpleColouring         — GLOBAL
 */

import type { SolverRule } from '../rule.js';
import { CageCandidateFilter } from './cageCandidateFilter.js';
import { CageConfinement } from './cageConfinement.js';
import { CageIntersection } from './cageIntersection.js';
import { CellSolutionElimination } from './cellSolutionElimination.js';
import { DeltaConstraint } from './deltaConstraint.js';
import { HiddenPair } from './hiddenPair.js';
import { HiddenSingle } from './hiddenSingle.js';
import { Jellyfish } from './jellyfish.js';
import { LinearElimination } from './linearElimination.js';
import { LockedCandidates } from './lockedCandidates.js';
import { MustContain } from './mustContain.js';
import { MustContainOutie } from './mustContainOutie.js';
import { NakedHiddenQuad } from './nakedHiddenQuad.js';
import { NakedHiddenTriple } from './nakedHiddenTriple.js';
import { NakedPair } from './nakedPair.js';
import { NakedSingle } from './nakedSingle.js';
import { PointingPairs } from './pointingPairs.js';
import { SimpleColouring } from './simpleColouring.js';
import { SolutionMapFilter } from './solutionMapFilter.js';
import { SumPairConstraint } from './sumPairConstraint.js';
import { Swordfish } from './swordfish.js';
import { UniqueRectangle } from './uniqueRectangle.js';
import { UnitPartitionFilter } from './unitPartitionFilter.js';
import { XWing } from './xWing.js';
import { XYWing } from './xyWing.js';

export {
  CageCandidateFilter,
  CageConfinement,
  CageIntersection,
  CellSolutionElimination,
  DeltaConstraint,
  HiddenPair,
  HiddenSingle,
  Jellyfish,
  LinearElimination,
  LockedCandidates,
  MustContain,
  MustContainOutie,
  NakedHiddenQuad,
  NakedHiddenTriple,
  NakedPair,
  NakedSingle,
  PointingPairs,
  SimpleColouring,
  SolutionMapFilter,
  SumPairConstraint,
  Swordfish,
  UniqueRectangle,
  UnitPartitionFilter,
  XWing,
  XYWing,
};

/**
 * Return one fresh instance of every rule, sorted by priority.
 * Lower priority value = higher priority = fired first by the engine.
 * Ties are broken by declaration order above.
 */
export function defaultRules(): SolverRule[] {
  const rules: SolverRule[] = [
    new NakedSingle(),
    new CellSolutionElimination(),
    new HiddenSingle(),
    new LinearElimination(),
    new CageCandidateFilter(),
    new CageIntersection(),
    new SolutionMapFilter(),
    new MustContain(),
    new MustContainOutie(),
    new DeltaConstraint(),
    new SumPairConstraint(),
    new NakedPair(),
    new HiddenPair(),
    new NakedHiddenTriple(),
    new NakedHiddenQuad(),
    new PointingPairs(),
    new LockedCandidates(),
    new CageConfinement(),
    new UnitPartitionFilter(),
    new XWing(),
    new Swordfish(),
    new Jellyfish(),
    new XYWing(),
    new UniqueRectangle(),
    new SimpleColouring(),
  ];
  return rules.sort((a, b) => a.priority - b.priority);
}
