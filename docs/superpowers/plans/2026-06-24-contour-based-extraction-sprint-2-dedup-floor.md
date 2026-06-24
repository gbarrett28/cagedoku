# browser_train.json Dedup + Floor Re-baseline (Sprint 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate exact byte-identical samples in `web/browser_train.json` (which are
over-counted under `--browser-weight 1000`), then re-baseline `numberRecognition.test.ts`'s
regression floor using content-hash identity instead of array index/count, so the test keeps
meaning something precise after the underlying sample set changes.

**Architecture:** A reusable Node script reports every currently-misclassified
`browser_train.json` sample by content hash (stable across reordering/dedup). Run it before
and after deduping + retraining; the post-dedup failure set must be a subset of the pre-dedup
one (same known issue, possibly fewer duplicates of it — never a brand new failure). The test
file then asserts against a frozen `Set` of those hashes instead of a hardcoded count.

**Tech Stack:** Node (`node:crypto`, vite-node), Python (dedup script), vitest, pytest.

## Global Constraints

- Requires Sprint 3 (`docs/superpowers/plans/2026-06-24-contour-based-extraction-sprint-1-implementation.md`)
  complete and verified first — this plan assumes `web/public/num_recogniser.bin`/`.json`
  is that sprint's retrained model.
- Per CLAUDE.md's Test Specification Integrity rule: this plan changes what
  `numberRecognition.test.ts` asserts. That change was discussed and approved by the user
  during brainstorming on 2026-06-24 (see
  `docs/superpowers/specs/2026-06-24-contour-based-extraction-design.md`) — this plan
  documents the mechanism, not a new approval request.
- Never use `--no-verify`. Never bypass the pre-commit hook.
- The bronze gate currently fails (pre-existing, diagnosed in Sprint 3's plan) — this
  sprint's Task 7 is what restores it to passing, and is where the combined Sprint 3 + 4
  commit happens.

---

### Task 1: Write the failure-hash reporting script

**Files:**
- Create: `web/scripts/report-browser-train-failures.ts`

**Interfaces:**
- Produces: a script printing one sha256 hex hash per line (sorted) to stdout for every
  misclassified sample, human-readable `hash  index=N expected=X got=Y` detail to stderr.
  Consumed by Tasks 2 and 5 (run once before dedup, once after).

- [x] **Step 1: Write the script**

```ts
#!/usr/bin/env vite-node
/**
 * Reports every browser_train.json sample the current model misclassifies,
 * identified by content hash (sha256 of the raw pixel array) rather than
 * array index -- hash identity survives reordering and deduplication of the
 * underlying fixture, where index does not.
 *
 * Usage (from web/):
 *   npx vite-node scripts/report-browser-train-failures.ts [path/to/browser_train.json]
 *
 * stdout: one sha256 hex hash per line, sorted -- intended for `sort`/`comm`
 *   comparison between runs (e.g. before/after a dedup + retrain).
 * stderr: human-readable detail per failure, plus a summary count.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadNumRecogniser, recognise } from '../src/image/numberRecognition.js';

interface TrainingSample { digit: number; pixels: number[] }
interface TrainingFile { samples: TrainingSample[] }

function sha256(pixels: number[]): string {
  return createHash('sha256').update(Buffer.from(pixels)).digest('hex');
}

function main(): void {
  const trainPath = resolve(process.argv[2] ?? join('browser_train.json'));
  const pub = join('public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  const rec = loadNumRecogniser(
    bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest,
  );

  const { samples }: TrainingFile = JSON.parse(readFileSync(trainPath, 'utf-8'));
  const imgs = samples.map(s => new Uint8Array(s.pixels));
  const results = recognise(rec, imgs);

  const failureHashes: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (results[i]!.label !== samples[i]!.digit) {
      const hash = sha256(samples[i]!.pixels);
      failureHashes.push(hash);
      console.error(`${hash}  index=${i} expected=${samples[i]!.digit} got=${results[i]!.label}`);
    }
  }
  failureHashes.sort();
  console.error(`\n${failureHashes.length}/${samples.length} failures`);
  for (const h of failureHashes) console.log(h);
}

main();
```

- [x] **Step 2: Smoke-test it runs**

Run (from `web/`): `npx vite-node scripts/report-browser-train-failures.ts`
Expected: prints failure detail lines to stderr and a sorted hash list to stdout, ending
with a `N/8362 failures` summary line. (This script is operational tooling, not unit
tested — consistent with this repo's other one-off `scripts/*.ts` files such as
`debug-fixture.ts`, none of which have test files.)

- [x] **Step 3: Commit**

```bash
git add web/scripts/report-browser-train-failures.ts
git commit -m "$(cat <<'EOF'
feat: add a content-hash-based browser_train.json failure reporter

Reusable tool for the dedup + floor re-baseline: identifies failing
samples by sha256 of their pixel array so the failure set can be
compared across a dedup + retrain even though array indices shift.
EOF
)"
```

---

### Task 2: Capture pre-dedup failure hashes

**Files:** none modified — this records a snapshot for Task 5's comparison.

- [x] **Step 1: Run the reporter against the current (pre-dedup) fixture**

Run (from `web/`):

```bash
npx vite-node scripts/report-browser-train-failures.ts > /tmp/pre_dedup_failure_hashes.txt
```

Expected: the file contains 9 hash lines (matching the 9 known failures from Sprint 3's
verification: sample indices 3062, 3091, 7804, 7825, 7846, 7867, 7888, 7909, 7959, all
digit 7 misread as 1). Keep this file — Task 5 compares against it.

---

### Task 3: Write and run the dedup script

**Files:**
- Create: `web/dedupe_browser_train.py`
- Create: `tests/test_dedupe_browser_train.py`

**Interfaces:**
- Produces: `dedupe_samples(samples: list[dict]) -> tuple[list[dict], int]` — pure function,
  returns `(deduped_samples, num_duplicates_removed)`. Also a `main()` CLI entry point.

- [x] **Step 1: Write the failing tests**

Create `tests/test_dedupe_browser_train.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from dedupe_browser_train import dedupe_samples


def test_dedupe_samples_drops_exact_duplicates_keeping_first():
    samples = [
        {"digit": 7, "pixels": [1, 2, 3]},
        {"digit": 7, "pixels": [1, 2, 3]},  # exact duplicate
        {"digit": 1, "pixels": [4, 5, 6]},
    ]
    deduped, n_removed = dedupe_samples(samples)
    assert n_removed == 1
    assert deduped == [
        {"digit": 7, "pixels": [1, 2, 3]},
        {"digit": 1, "pixels": [4, 5, 6]},
    ]


def test_dedupe_samples_keeps_distinct_samples_with_same_digit():
    samples = [
        {"digit": 2, "pixels": [1, 1, 1]},
        {"digit": 2, "pixels": [2, 2, 2]},
    ]
    deduped, n_removed = dedupe_samples(samples)
    assert n_removed == 0
    assert deduped == samples


def test_dedupe_samples_handles_empty_list():
    deduped, n_removed = dedupe_samples([])
    assert deduped == []
    assert n_removed == 0
```

- [x] **Step 2: Run tests to verify they fail**

Run (from repo root): `pytest tests/test_dedupe_browser_train.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'dedupe_browser_train'`.

- [x] **Step 3: Write the dedup script**

Create `web/dedupe_browser_train.py`:

```python
"""
Deduplicate exact byte-identical samples in browser_train.json.

Usage:
    python web/dedupe_browser_train.py [path/to/browser_train.json]

Drops exact duplicate (digit, pixels) entries, keeping the first occurrence,
and rewrites the file in place. Duplicate browser-exported crops get
multiply-counted under --browser-weight, pulling the SVM boundary harder
than the underlying evidence (one real crop, captured more than once)
actually warrants.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def dedupe_samples(samples: list[dict]) -> tuple[list[dict], int]:
    """Drop exact pixel-duplicate samples, keeping first occurrence.

    Returns (deduped_samples, num_duplicates_removed).
    """
    seen: set[str] = set()
    deduped: list[dict] = []
    for sample in samples:
        digest = hashlib.sha256(bytes(sample['pixels'])).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        deduped.append(sample)
    return deduped, len(samples) - len(deduped)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('web/browser_train.json')
    data = json.loads(path.read_text(encoding='utf-8'))
    deduped, n_removed = dedupe_samples(data['samples'])
    print(f"{path}: {len(data['samples'])} -> {len(deduped)} samples ({n_removed} duplicates removed)")
    data['samples'] = deduped
    data['sampleCount'] = len(deduped)
    path.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')


if __name__ == '__main__':
    main()
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_dedupe_browser_train.py -v`
Expected: PASS (3 tests).

- [x] **Step 5: Run the dedup script on the real fixture**

Run (from repo root): `python web/dedupe_browser_train.py`
Expected: prints `web/browser_train.json: 8362 -> N samples (8362-N duplicates removed)`
and rewrites the file. Record the printed `N` — it is the new total sample count needed
for Task 6.

- [x] **Step 6: Commit**

```bash
git add web/dedupe_browser_train.py tests/test_dedupe_browser_train.py web/browser_train.json
git commit -m "$(cat <<'EOF'
fix: deduplicate exact byte-identical samples in browser_train.json

Duplicate crops were getting multiply-counted under --browser-weight,
pulling the SVM's 1-vs-7 boundary harder than the underlying evidence
(the same real crop, captured more than once) actually warrants.
EOF
)"
```

---

### Task 4: Retrain on the deduped fixture

**Files:** none modified (retrain only).

- [x] **Step 1: Retrain with the established recipe**

Run (from repo root):

```bash
python web/train_recogniser.py --browser-weight 1000 --svm-c 100 --max-per-class 1500 --no-synthetic --dither 18 guardian/guardian_train_sq.json observer/observer_train_sq.json
```

`--browser-file` defaults to `web/browser_train.json` — now the deduped version from Task 3.
Expected: completes, writes `web/public/num_recogniser.bin`/`.json`.

- [x] **Step 2: Verify guardian/observer accuracy didn't regress**

Run (from `web/`): `npx vitest run src/image/_diag_bulk_accuracy.test.ts --reporter=verbose`
Expected: guardian ≥ 99.76%, observer ≥ 95.13% (Sprint 3's verified levels). If lower: STOP,
invoke `superpowers:systematic-debugging` — the dedup should only affect the
`browser_train.json`-weighted boundary, not bulk-data accuracy broadly; a regression here
would be unexpected and needs root-causing before continuing.

---

### Task 5: Capture post-dedup failure hashes and verify the subset gate

**Files:** none modified — verification only.

- [x] **Step 1: Run the reporter against the deduped fixture**

Run (from `web/`):

```bash
npx vite-node scripts/report-browser-train-failures.ts > /tmp/post_dedup_failure_hashes.txt
```

- [x] **Step 2: Verify the subset gate**

Run:

```bash
sort /tmp/pre_dedup_failure_hashes.txt > /tmp/pre_sorted.txt
sort /tmp/post_dedup_failure_hashes.txt > /tmp/post_sorted.txt
comm -23 /tmp/post_sorted.txt /tmp/pre_sorted.txt
```

Expected: **no output**. Any line printed is a hash that fails post-dedup but did not fail
pre-dedup — a new, unrelated regression. **If this happens, STOP — do not proceed to Task
6.** Invoke `superpowers:systematic-debugging` to find out why before continuing; do not
add a newly-appeared failure to the test's known-failure set without understanding it
first (that would be exactly the silent-test-patching CLAUDE.md's Test Specification
Integrity rule forbids).

A same-size or smaller post-dedup failure set (fewer hashes in
`post_dedup_failure_hashes.txt` than `pre_dedup_failure_hashes.txt`) is the expected,
accepted outcome — duplicates of a known-hard sample no longer over-weighting the
boundary may resolve some of them.

---

### Task 6: Re-baseline `numberRecognition.test.ts` with content-hash identity

**Files:**
- Modify: `web/src/image/numberRecognition.test.ts`

**Interfaces:**
- Produces: `KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string>`, `sha256(pixels: number[]): string`,
  `unexpectedFailures(subset: TrainingSample[]): string[]` — replaces
  `KNOWN_PERMANENT_FAILURES`/`KNOWN_FAILURES_BY_DIGIT`.

- [x] **Step 1: Replace the known-failures block and both test bodies**

Use serena's `find_symbol`/`get_symbols_overview` on
`web/src/image/numberRecognition.test.ts` to confirm current line ranges, then replace from
the `import { readFileSync } from 'node:fs';` line's import block through the end of the
`describe` block with:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadNumRecogniser, recognise } from './numberRecognition.js';
import type { NumRecogniser } from './numberRecognition.js';

// ---------------------------------------------------------------------------
// Load model and training data once for the suite
// ---------------------------------------------------------------------------

interface TrainingSample {
  digit: number;
  pixels: number[];
}
interface TrainingFile {
  sampleCount: number;
  samples: TrainingSample[];
}

let rec: NumRecogniser;
let samples: TrainingSample[];

beforeAll(() => {
  const pub = join(process.cwd(), 'public');
  const bin = readFileSync(join(pub, 'num_recogniser.bin'));
  const manifest = JSON.parse(readFileSync(join(pub, 'num_recogniser.json'), 'utf-8'));
  rec = loadNumRecogniser(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest);

  const trainFile: TrainingFile = JSON.parse(
    readFileSync(join(process.cwd(), 'browser_train.json'), 'utf-8'),
  );
  samples = trainFile.samples;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(pixels: number[]): string {
  return createHash('sha256').update(Buffer.from(pixels)).digest('hex');
}

function runOnSamples(subset: TrainingSample[]): { correct: number; total: number; errors: string[] } {
  const imgs = subset.map(s => new Uint8Array(s.pixels));
  const results = recognise(rec, imgs);
  let correct = 0;
  const errors: string[] = [];
  for (let i = 0; i < subset.length; i++) {
    if (results[i]!.label === subset[i]!.digit) {
      correct++;
    } else {
      errors.push(`sample ${i}: expected ${subset[i]!.digit}, got ${results[i]!.label} (confident=${results[i]!.confident})`);
    }
  }
  return { correct, total: subset.length, errors };
}

/** Failures whose content hash is not in KNOWN_FAILURE_SAMPLE_HASHES -- a regression. */
function unexpectedFailures(subset: TrainingSample[]): string[] {
  const imgs = subset.map(s => new Uint8Array(s.pixels));
  const results = recognise(rec, imgs);
  const unexpected: string[] = [];
  for (let i = 0; i < subset.length; i++) {
    if (results[i]!.label !== subset[i]!.digit) {
      const hash = sha256(subset[i]!.pixels);
      if (!KNOWN_FAILURE_SAMPLE_HASHES.has(hash)) {
        unexpected.push(
          `sample ${i}: expected ${subset[i]!.digit}, got ${results[i]!.label} (hash=${hash})`,
        );
      }
    }
  }
  return unexpected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Known-permanent failures
//
// browser_train.json samples are frozen, already-cropped 64x64 pixel arrays
// captured historically through whatever crop logic was live in-browser at
// capture time -- there is no raw image to re-crop, so no future crop fix
// can retroactively repair these. Identified by content hash (sha256 of the
// raw pixel array), not array index -- index is not stable across dedup or
// regeneration of this fixture, hash identity is. See
// docs/superpowers/specs/2026-06-24-contour-based-extraction-design.md for
// how this set was captured (report-browser-train-failures.ts, before/after
// the dedup + retrain in that same sprint, gated on the post-dedup set being
// a subset of the pre-dedup one).
// ---------------------------------------------------------------------------
const KNOWN_FAILURE_SAMPLE_HASHES: ReadonlySet<string> = new Set([
  // PASTE one line per hash from /tmp/post_dedup_failure_hashes.txt (Task 5),
  // each annotated with its expected->got detail from that same script's
  // stderr output, e.g.:
  // '3f2a...e91c', // digit 7 -> 1
]);

describe('digit recogniser — TypeScript HOG inference on training data', () => {
  it('loads model without error', () => {
    expect(rec).toBeDefined();
    expect(rec.hog).toBeDefined();
    expect(rec.classifier).toBeDefined();
  });

  it('achieves at least total - knownFailures.size accuracy, with no unexpected failures', () => {
    const { correct, total, errors } = runOnSamples(samples);
    const pct = ((correct / total) * 100).toFixed(1);
    if (errors.length > 0) {
      console.error(`\nMispredictions (${errors.length}/${total}):`);
      errors.forEach(e => console.error('  ' + e));
    }
    console.log(`\nAccuracy: ${correct}/${total} (${pct}%)`);

    const unexpected = unexpectedFailures(samples);
    expect(unexpected, `Unexpected new failures (hash not in KNOWN_FAILURE_SAMPLE_HASHES):\n${unexpected.join('\n')}`)
      .toEqual([]);

    const floor = total - KNOWN_FAILURE_SAMPLE_HASHES.size;
    expect(correct, `Expected at least ${floor}/${total} correct; failures:\n${errors.join('\n')}`)
      .toBeGreaterThanOrEqual(floor);
  });

  it('reports per-digit accuracy with no unexpected failures in any digit group', () => {
    const byDigit = new Map<number, TrainingSample[]>();
    for (const s of samples) {
      if (!byDigit.has(s.digit)) byDigit.set(s.digit, []);
      byDigit.get(s.digit)!.push(s);
    }
    const rows: string[] = [];
    const allUnexpected: string[] = [];
    for (const [digit, group] of [...byDigit.entries()].sort((a, b) => a[0] - b[0])) {
      const { correct, total } = runOnSamples(group);
      const pct = ((correct / total) * 100).toFixed(0);
      rows.push(`  digit ${digit}: ${correct}/${total} (${pct}%)`);
      allUnexpected.push(...unexpectedFailures(group));
    }
    console.log('\nPer-digit accuracy:\n' + rows.join('\n'));
    expect(allUnexpected, `Unexpected failures:\n${allUnexpected.join('\n')}`).toEqual([]);
  });
});

// Note: guardian_train_sq.json / observer_train_sq.json are deliberately not
// tested here. /guardian/ and /observer/ are entirely gitignored (the source
// .jpg files cannot be committed), so any test depending on them only ever
// runs on a machine that has manually run extract_guardian_samples.py — it
// can never be a real CI/bronze-gate check. Those datasets are bulk training
// input only; browser_train.json (committed, hand-verified) is the ground
// truth this test enforces.
```

Populate `KNOWN_FAILURE_SAMPLE_HASHES` from `/tmp/post_dedup_failure_hashes.txt` (stdout,
one hash per line) cross-referenced with that same run's stderr detail
(`hash  index=N expected=X got=Y`) for the trailing comment on each entry.

- [x] **Step 2: Run the test**

Run (from `web/`): `npx vitest run src/image/numberRecognition.test.ts --reporter=verbose`
Expected: all 3 tests pass — `unexpected` is empty in both tests (every failure's hash is
in `KNOWN_FAILURE_SAMPLE_HASHES`, by construction from Task 5's captured set) and `correct
>= total - KNOWN_FAILURE_SAMPLE_HASHES.size`.

- [x] **Step 3: Type-check**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors.

---

### Task 7: Full verification, combined commit, push

**Files:** none modified.

- [x] **Step 1: Run the full bronze gate**

Run (from repo root): `bash scripts/run-bronze-gate.sh`
Expected: PASS — `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, and `npm test` all
green. This is the first clean bronze gate since the floor regression was discovered;
Sprint 3's commits and this sprint's work land together now.

- [x] **Step 2: Stage and commit everything from both sprints not yet committed**

```bash
git status --short
```

Confirm what remains uncommitted (expect: `web/public/num_recogniser.bin`/`.json` from the
Task 4 retrain, `web/src/image/numberRecognition.test.ts` from Task 6, and any earlier
Sprint 3 step whose commit was deferred). Then:

```bash
git add web/public/num_recogniser.bin web/public/num_recogniser.json web/src/image/numberRecognition.test.ts
git commit -m "$(cat <<'EOF'
test: re-baseline numberRecognition.test.ts on content-hash identity

Replaces the index/count-based known-failures floor with a frozen set
of content hashes, captured via report-browser-train-failures.ts
before and after the browser_train.json dedup, gated on the post-dedup
failure set being a subset of the pre-dedup one (verified -- no new
failures introduced). Retrained model reflects both this sprint's
dedup and Sprint 3's contour-based extraction fix.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [x] **Step 3: Verify**

```bash
git log --oneline -8
git status --short
```

Expected: a clean working tree (aside from any deliberately-kept `.bak` files from Sprint
2/3 investigations, which are untracked and can stay until the user confirms they're no
longer needed for rollback).

- [x] **Step 4: Push**

```bash
git push
```

---

## Spec Coverage Check

- Pre-dedup hash capture: Task 2. ✓
- Dedup script + tests: Task 3. ✓
- Retrain on deduped fixture: Task 4. ✓
- Post-dedup hash capture + subset gate: Task 5. ✓
- Test re-baseline on content-hash identity: Task 6. ✓
- Full verification + combined commit: Task 7. ✓
- CLAUDE.md Test Specification Integrity (documented reasoning, explicit prior user
  approval, no silent patching): satisfied via the spec doc + this plan's explicit
  subset-gate STOP condition. ✓
