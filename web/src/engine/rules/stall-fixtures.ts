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
export const stallFixtures: { name: string; candidates: number[][][] }[] = [];
