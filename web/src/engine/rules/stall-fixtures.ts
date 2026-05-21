/**
 * Known stall states — candidate grids where the rule engine cannot make
 * progress without backtracking.  Each entry is a 9×9 array of sorted
 * candidate lists (single-element = solved cell).
 *
 * Tests in stall-fixtures.test.ts assert these solve without backtracking.
 * They FAIL until a rule is added that unlocks the puzzle — that is intentional.
 * When a fixture's test turns green, the rule set is sufficient for that puzzle.
 *
 * To add a new fixture: copy stalledCandidates from a BacktrackingRequired
 * upload (Worker logs) or from solveFromStall() diagnostic output.
 */
export const stallFixtures: { name: string; candidates: number[][][] }[] = [
  {
    name: 'puzzle103',
    // Classic sudoku, labelled "expert". Stalled at 48/81 cells solved.
    // Reported 2026-05-21. Rule set gap: technique not yet identified.
    candidates: [[[3,6,9],[2,5,6,9],[1,3,5,7,9],[1,2,3,9],[2,7],[1,6],[4],[1,2,9],[8]],[[4],[2,8,9],[1,7,9],[1,2,9],[2,7,8],[5],[3],[1,2,9],[6]],[[3,6,9],[2,6,8,9],[1,3,9],[1,2,3,9],[4],[1,6,8],[5,9],[7],[1,5]],[[3,6,9],[6,9],[3,9],[1,2],[2,8],[1,8],[7],[5],[4]],[[2],[7],[8],[5],[6],[4],[1],[3],[9]],[[5],[1],[4],[7],[3],[9],[8],[6],[2]],[[1],[4],[5,9],[6],[5,9],[7],[2],[8],[3]],[[7],[5,9],[2],[8],[1,5,9],[3],[6],[4],[1,5]],[[8],[3],[6],[4],[1,5],[2],[5,9],[1,9],[7]]],
  },
];
