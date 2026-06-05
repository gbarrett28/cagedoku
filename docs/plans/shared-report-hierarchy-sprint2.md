# Sprint 2: Shared report hierarchy — web integration

Goal: update the web to import from shared, simplify trainingUpload.ts,
wire report objects through engine.ts and triggerValidator.ts, make the
sync script dynamic. Subsumes the pending claude/fix-rule-regression-action fixes.

## Deliverable

- `web/src/image/trainingUpload.ts` — imports shared types; no duplicate interfaces
- `web/src/session/engine.ts` — constructs shared report objects for violations
- `web/src/engine/triggerValidator.ts` — returns `RuleBugReport | TriggerMissReport`
- `web/src/engine/rules/ruleBugFixture.ts` — deleted; web imports from shared
- `web/scripts/sync-rule-fixtures.js` — rule list derived from `defaultRules()`
- Silver gate passes

---

## Steps

- [ ] 1. Update `web/tsconfig.json` — add `../shared/src/**/*` to include
- [ ] 2. Update `web/src/image/trainingUpload.ts`
       — delete WorkerRuleBugReport, TriggerMissReport, PuzzleReportBase, StallReport
       — import from shared; keep consent helpers + postToWorker + submit functions
- [ ] 3. Update `web/src/session/engine.ts`
       — onViolation: construct RuleBugReport object, call submitRuleBugReport
       — runTriggerValidation: use report objects from triggerValidator
- [ ] 4. Update `web/src/engine/triggerValidator.ts`
       — return { misses: TriggerMissReport[], violations: RuleBugReport[] }
         instead of raw TriggerMiss/TriggerViolation objects
- [ ] 5. Update `web/src/engine/triggerValidator.test.ts` — match new return types
- [ ] 6. Delete `web/src/engine/rules/ruleBugFixture.ts`
- [ ] 7. Update `web/src/engine/rules/__fixtures__/index.ts`
       — import RuleBugFixture from shared instead
- [ ] 8. Update all rule test files that import RuleBugFixture
- [ ] 9. Rewrite `web/scripts/sync-rule-fixtures.js`
       — derive RULE_NAMES from defaultRules() via vite-node import
       — use fixtureToTypeScript() from shared for fixture serialisation
       — derive disabled rules regex update from shared (removes the file-rewrite bug)
- [ ] 10. Add shared validator tests in `web/src/shared-reports.test.ts`
        — parseAnyReport round-trips each report type
        — assertNeverReport exhaustiveness
- [ ] 11. Update `web/src/image/trainingUpload.test.ts` — adjust imports
- [ ] 12. Silver gate — tsc + tests + Playwright
