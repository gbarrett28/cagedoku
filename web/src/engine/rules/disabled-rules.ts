/**
 * Rule names that have confirmed bugs and must not be activated in deployed builds.
 *
 * Each entry here means the rule produced an elimination that contradicted
 * the known golden solution on at least one real puzzle. Corresponding stall
 * fixtures live in __fixtures__/index.ts; their tests are skipped while the
 * rule is listed here.
 *
 * To re-enable a rule after fixing it:
 *  1. Remove its name from this array.
 *  2. Change the corresponding fixture tests from it.skip → it.
 *  3. Run the bronze gate — all fixture tests must be green.
 *  4. Commit on a feature branch and open a PR.
 */
export const DISABLED_RULES: readonly string[] = [];
