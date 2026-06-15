/**
 * Active rule set for the coaching engine.
 *
 * Priority order (ascending = higher priority = fired first):
 *  0  NakedSingle             — CELL_DETERMINED (placement + peer eliminations)
 *  1  HiddenSingle            — COUNT_HIT_ONE
 *  1  LinearElimination       — GLOBAL
 *  1  DerivedVirtualCage      — GLOBAL
 *  2  CageCandidateFilter     — SOLUTION_PRUNED
 *  2  CageIntersection        — COUNT_DECREASED / SOLUTION_PRUNED
 *  3  SolutionMapFilter       — COUNT_DECREASED / SOLUTION_PRUNED
 *  4  MustContain             — COUNT_DECREASED
 *  4  MustContainOutie        — COUNT_DECREASED / SOLUTION_PRUNED
 *  5  DeltaConstraint         — COUNT_DECREASED
 *  5  SumPairConstraint       — COUNT_DECREASED / CELL_DETERMINED
 *  6  NakedPair               — COUNT_HIT_TWO
 *  7  HiddenPair              — COUNT_HIT_TWO
 *  8  NakedTriple             — COUNT_DECREASED
 *  9  HiddenTriple            — COUNT_DECREASED
 * 10  NakedQuad               — COUNT_DECREASED
 * 11  HiddenQuad              — COUNT_DECREASED
 * 12  PointingPairs           — COUNT_DECREASED
 * 14  LockedCandidates        — COUNT_DECREASED
 * 15  CageConfinement         — GLOBAL
 * 15  UnitPartitionFilter     — GLOBAL
 * 16  XWing                   — GLOBAL
 * 17  Swordfish               — GLOBAL
 * 18  Jellyfish               — GLOBAL
 * 19  XYWing                  — GLOBAL
 * 20  UniqueRectangle         — GLOBAL
 * 21  SimpleColouring         — GLOBAL
 * 22  XYZWing                 — GLOBAL
 * 23  WWing                   — COUNT_HIT_TWO
 * 24  Skyscraper              — GLOBAL
 * 25  TwoStringKite           — GLOBAL
 */

import type { SolverRule } from '../rule.js';
import { CageCandidateFilter } from './cageCandidateFilter.js';
import { CageConfinement } from './cageConfinement.js';
import { CageIntersection } from './cageIntersection.js';
import { DeltaConstraint } from './deltaConstraint.js';
import { DerivedVirtualCage } from './derivedVirtualCage.js';
import { HiddenPair } from './hiddenPair.js';
import { HiddenQuad } from './hiddenQuad.js';
import { HiddenSingle } from './hiddenSingle.js';
import { HiddenTriple } from './hiddenTriple.js';
import { Jellyfish } from './jellyfish.js';
import { LinearElimination } from './linearElimination.js';
import { LockedCandidates } from './lockedCandidates.js';
import { MustContain } from './mustContain.js';
import { MustContainOutie } from './mustContainOutie.js';
import { NakedPair } from './nakedPair.js';
import { NakedQuad } from './nakedQuad.js';
import { NakedSingle } from './nakedSingle.js';
import { NakedTriple } from './nakedTriple.js';
import { PointingPairs } from './pointingPairs.js';
import { SimpleColouring } from './simpleColouring.js';
import { SolutionMapFilter } from './solutionMapFilter.js';
import { SumPairConstraint } from './sumPairConstraint.js';
import { Swordfish } from './swordfish.js';
import { UniqueRectangle } from './uniqueRectangle.js';
import { UnitPartitionFilter } from './unitPartitionFilter.js';
import { XWing } from './xWing.js';
import { XYWing } from './xyWing.js';
import { XYZWing } from './xyzWing.js';
import { WWing } from './wWing.js';
import { Skyscraper } from './skyscraper.js';
import { TwoStringKite } from './twoStringKite.js';

export {
  CageCandidateFilter,
  CageConfinement,
  CageIntersection,
  DeltaConstraint,
  DerivedVirtualCage,
  HiddenPair,
  HiddenQuad,
  HiddenSingle,
  HiddenTriple,
  Jellyfish,
  LinearElimination,
  LockedCandidates,
  MustContain,
  MustContainOutie,
  NakedPair,
  NakedQuad,
  NakedSingle,
  NakedTriple,
  PointingPairs,
  SimpleColouring,
  SolutionMapFilter,
  SumPairConstraint,
  Swordfish,
  UniqueRectangle,
  UnitPartitionFilter,
  XWing,
  XYWing,
  XYZWing,
  WWing,
  Skyscraper,
  TwoStringKite,
};

/**
 * Return one fresh instance of every rule, sorted by priority.
 * Lower priority value = higher priority = fired first by the engine.
 * Ties are broken by declaration order above.
 */
export function defaultRules(): SolverRule[] {
  const rules: SolverRule[] = [
    new NakedSingle(),
    new HiddenSingle(),
    new LinearElimination(),
    new DerivedVirtualCage(),
    new CageCandidateFilter(),
    new CageIntersection(),
    new SolutionMapFilter(),
    new MustContain(),
    new MustContainOutie(),
    new DeltaConstraint(),
    new SumPairConstraint(),
    new NakedPair(),
    new HiddenPair(),
    new NakedTriple(),
    new HiddenTriple(),
    new NakedQuad(),
    new HiddenQuad(),
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
    new XYZWing(),
    new WWing(),
    new Skyscraper(),
    new TwoStringKite(),
  ];
  return rules.sort((a, b) => a.priority - b.priority);
}
