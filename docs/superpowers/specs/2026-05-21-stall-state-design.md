# Stall-State Capture, Upload, and Replay — Design

## Goal

When the rule engine cannot solve a puzzle without backtracking, capture the
exact candidate grid at the moment it stalls, upload it silently (reusing the
existing training-consent flow), and provide a test harness that can replay any
stall state against the current rule set so developers can verify whether a new
rule makes progress.

## Background

`solve()` in `engine/index.ts` already sets `usedBacktracking: true` and shows a
`BacktrackingRequired` assertion modal asking the user to file a GitHub issue manually.
That modal is confusing and error-prone. The puzzle spec uploaded to the Cloudflare
Worker captures the original cage layout but not the candidate state, so replaying
requires re-running the full rule chain — which is slow and sensitive to rule-ordering
changes. This design replaces both with a self-contained stall-state upload and a
fast replay path.

## Representation

A stall state is a `number[][][]`: a 9×9 array where each cell holds its sorted
remaining candidates. Solved cells have a single-element array; unsolved cells have
two or more. This is the minimal self-contained representation — it captures both
solved and unsolved cells and is independent of the original puzzle spec.

## Files

| Action  | File |
|---------|------|
| Modify  | `web/src/image/trainingExport.ts` |
| Modify  | `web/src/image/trainingUpload.ts` |
| Modify  | `web/src/engine/index.ts` |
| Modify  | `web/src/main.ts` |
| Create  | `web/src/engine/rules/stall-fixtures.ts` |
| Create  | `web/src/engine/rules/stall-fixtures.test.ts` |

## Component Design

### `StallStateExport` — `trainingExport.ts`

```ts
export interface StallStateExport {
  version: 1;
  exportedAt: string;
  appVersion: string;
  puzzleType: 'killer' | 'classic';
  /** 9×9 remaining candidates per cell. Single-element = solved. */
  stalledCandidates: number[][][];
}

export function buildStallStateExport(
  puzzleType: 'killer' | 'classic',
  stalledCandidates: number[][][],
): StallStateExport;
```

### Upload helpers — `trainingUpload.ts`

Two additions mirroring the existing training-upload pattern:

```ts
/** Fire-and-forget POST of a stall state — assumes consent already granted. */
export function uploadStallState(data: StallStateExport): void;

/** Check consent; upload immediately or invoke showConsentModal. */
export function initiateStallUpload(
  data: StallStateExport,
  showConsentModal: () => void,
): void;
```

`postToWorker`'s parameter union is extended to include `StallStateExport`.

### `SolveResult` and `solve()` — `engine/index.ts`

`SolveResult` gains one optional field:

```ts
export interface SolveResult {
  board: BoardState;
  usedBacktracking: boolean;
  /** Candidate grid captured before backtracking. Only set when usedBacktracking === true. */
  stalledCandidates?: number[][][];
}
```

In `solve()`, after detecting a stall and before calling `mrvBacktrack`, snapshot:

```ts
const stalledCandidates: number[][][] = Array.from({ length: 9 }, (_, r) =>
  Array.from({ length: 9 }, (_, c) => [...board.cands(r, c)].sort((a, b) => a - b))
);
```

Return `{ board, usedBacktracking: stalled, stalledCandidates: stalled ? stalledCandidates : undefined }`.

### `solveFromStall` — `engine/index.ts`

```ts
export function solveFromStall(candidates: number[][][]): SolveResult;
```

Builds a fresh `BoardState` using the trivial classic spec (all borders, one row-cage
per row, no given digits). Eliminates every digit absent from each cell's candidate
list via `engine.applyEliminations`. Calls `engine.solve()`. Returns `{ board,
usedBacktracking, stalledCandidates? }` — same shape as `solve()`.

The spec used internally does not matter for correctness because classic rules
(row/col/box) are a superset of what any sudoku puzzle needs; cage-based rules will
simply find no eliminations on the trivial cage layout.

### `main.ts`

Both `showAssertionModal(new AssertionViolation({ name: 'BacktrackingRequired', … }))` 
calls are removed.

`showTrainingConsentModal` is refactored to accept an upload callback instead of
a `TrainingExport` value, so both training data and stall states share the same modal:

```ts
// before
function showTrainingConsentModal(data: TrainingExport): void {
  onceBtn.onclick   = () => { uploadTrainingData(data); close(); };
  alwaysBtn.onclick = () => { grantConsent(); uploadTrainingData(data); close(); };
}

// after
function showTrainingConsentModal(upload: () => void): void {
  onceBtn.onclick   = () => { upload(); close(); };
  alwaysBtn.onclick = () => { grantConsent(); upload(); close(); };
}
```

Existing call site updated to `showTrainingConsentModal(() => uploadTrainingData(data))`.

After obtaining `stalledCandidates` from `SolveResult`:

```ts
const stallExport = buildStallStateExport(puzzleType, stalledCandidates);
initiateStallUpload(
  stallExport,
  () => showTrainingConsentModal(() => uploadStallState(stallExport)),
);
```

`initiateStallUpload` posts silently if consent is set; otherwise it calls
`showConsentModal` (the lambda above), which opens the existing modal. The
modal's "Send this time" and "Always send" buttons invoke the inner callback,
which calls `uploadStallState`. No new UI is needed.

### Stall fixtures — `engine/rules/stall-fixtures.ts`

```ts
export const stallFixtures: { name: string; candidates: number[][][] }[] = [
  { name: 'puzzle103', candidates: [ /* copied from Worker upload */ ] },
];
```

New entries are added manually when a stall state is retrieved from the Worker.

### Stall fixture tests — `engine/rules/stall-fixtures.test.ts`

```ts
for (const { name, candidates } of stallFixtures) {
  it(`solves '${name}' without backtracking`, () => {
    const result = solveFromStall(candidates);
    const solvedCount = /* count cells with 1 candidate */;
    expect(result.usedBacktracking).toBe(false);
    expect(solvedCount).toBe(81);
  });
}
```

These tests **fail until a rule is added that unlocks the puzzle**. They serve as
forward-looking regression tests: when they turn green, the rule set is sufficient
for that puzzle.

## Upload Flow

```
confirm puzzle
  └─ solve() stalls
       ├─ snapshot stalledCandidates
       ├─ mrvBacktrack (fills board for play)
       └─ uploadStallState(stalledCandidates, showTrainingConsentModal)
            ├─ consent cookie set → POST to Worker (silent)
            └─ no consent → show training consent modal → user grants → POST
```

No GitHub issue link. No assertion modal. The user's only interaction is the
one-time consent grant (shared with digit training).

## What Is Not In Scope

- Automatic population of `stall-fixtures.ts` from the Worker — fixtures are
  curated manually.
- Any UI for viewing or managing stall states.
- Changing the Cloudflare Worker schema validation (Worker accepts arbitrary JSON
  objects; no schema change required).
