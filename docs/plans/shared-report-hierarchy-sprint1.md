# Sprint 1: Shared report hierarchy — shared package + worker

Goal: create `shared/` package with the full type hierarchy and update the
worker to use it. Web is untouched in this sprint.

## Deliverable

- `shared/src/` — all report interfaces + namespaces, fixture type,
  `AnyReport` union, `parseAnyReport()`, exhaustiveness guard
- `worker/src/index.ts` — rewritten to switch-dispatch over `AnyReport`;
  `validate.ts` deleted
- Worker type-checks clean; web type-checks clean; all existing tests pass

---

## Design

### Type hierarchy

```
shared/src/
  grid.ts                  — Grid, CandidateGrid type aliases
  report.ts                — GitHubAction, ReproductionBundle
  reports/
    TrainingExport.ts      — interface + namespace (no ReportBase; no userAgent/reportedAt)
    PuzzleSpecExport.ts    — interface + namespace
    StallStateExport.ts    — interface + namespace (extends ReportBase)
    FeedbackReport.ts      — interface + namespace (extends ReportBase)
    RuleBugReport.ts       — interface + namespace (extends PuzzleRuleReport)
    TriggerMissReport.ts   — interface + namespace (extends PuzzleRuleReport)
    PuzzleRuleReport.ts    — abstract interface base for rule reports
    index.ts               — AnyReport union, parseAnyReport, assertNeverReport
  fixture.ts               — RuleBugFixture interface, fixtureToTypeScript()
  index.ts                 — re-export all
shared/tsconfig.json
```

### Namespace pattern (per report type)

```ts
export interface RuleBugReport extends PuzzleRuleReport {
  readonly reportType: 'rule-bug';
  readonly offendingEliminations: readonly { ... }[];
}
export namespace RuleBugReport {
  export function is(v: unknown): v is RuleBugReport { ... }
  export function storageKey(r: RuleBugReport, uuid: string): string
  export function r2Metadata(r: RuleBugReport): Record<string, string>
  export function githubAction(_r: RuleBugReport, _key: string): null
  export function toFixture(r: RuleBugReport): RuleBugFixture
  export function reproduce(r: RuleBugReport): ReproductionBundle
}
```

### Worker dispatch (replaces if/else chain)

```ts
const report = parseAnyReport(body);
if (!report) return new Response('Bad request: unrecognised schema', ...);
switch (report.reportType) {
  case 'training-export': { ... break; }
  ...
  default: { const _: never = report; throw new Error('unhandled'); }
}
```

### reportType discriminant mapping

| Current schema                     | New reportType        |
|------------------------------------|-----------------------|
| version:1 + samples[]              | 'training-export'     |
| version:2 + borderX/borderY        | 'puzzle-spec'         |
| version:1 + stalledCandidates only | 'stall'               |
| version:3 + feedbackType           | 'feedback'            |
| version:4 feedbackType:'rule-bug'  | 'rule-bug'            |
| version:5 feedbackType:'trigger-miss' | 'trigger-miss'     |

Validators check the new `reportType` field. Backward compat: existing R2
data is read by sync-rule-fixtures.js (not re-validated), so no migration needed.

### FeedbackReport special case

- `storageKey()` returns `null` (not stored in R2)
- `githubAction()` returns `{ kind: 'issue', title, body, labels }` (creates issue)

---

## Steps

- [ ] 1. Create `shared/tsconfig.json`
- [ ] 2. Create `shared/src/grid.ts` — Grid, CandidateGrid type aliases
- [ ] 3. Create `shared/src/report.ts` — GitHubAction union, ReportBase interface, PuzzleRuleReport interface, ReproductionBundle
- [ ] 4. Create `shared/src/reports/TrainingExport.ts`
- [ ] 5. Create `shared/src/reports/PuzzleSpecExport.ts`
- [ ] 6. Create `shared/src/reports/StallStateExport.ts`
- [ ] 7. Create `shared/src/reports/FeedbackReport.ts`
- [ ] 8. Create `shared/src/reports/RuleBugReport.ts`
- [ ] 9. Create `shared/src/reports/TriggerMissReport.ts`
- [ ] 10. Create `shared/src/reports/index.ts` — AnyReport, parseAnyReport, assertNeverReport
- [ ] 11. Create `shared/src/fixture.ts` — RuleBugFixture, fixtureToTypeScript()
- [ ] 12. Create `shared/src/index.ts` — re-export all
- [ ] 13. Update `worker/tsconfig.json` — include shared/src
- [ ] 14. Rewrite `worker/src/index.ts` — switch dispatch over AnyReport
- [ ] 15. Delete `worker/src/validate.ts`
- [ ] 16. Bronze gate — tsc (both projects) + npm test
