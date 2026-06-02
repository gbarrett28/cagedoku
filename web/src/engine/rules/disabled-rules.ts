export const DISABLED_RULES: readonly string[] = [];

/**
 * Rules that have no meaning for classic (non-killer) sudoku — they depend on
 * cage sum constraints and produce confusing or vacuous hints when the puzzle
 * has no killer cages.
 */
export const CLASSIC_EXCLUDED_RULES: ReadonlySet<string> = new Set([
  'CageCandidateFilter',
  'CageIntersection',
  'SolutionMapFilter',
  'MustContain',
  'MustContainOutie',
  'DeltaConstraint',
  'SumPairConstraint',
  'CageConfinement',
  'UnitPartitionFilter',
  'LinearElimination',
]);
