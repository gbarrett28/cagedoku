# Python Bit-Exact Port — Sprint 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Python reference pipeline onto `feature/python-bitexact-port` and give the TS pipeline a tested WASM-leak monitor, so Sprint 2 can build the per-image bit-check harness on top of both.

**Architecture:** Task 1 restores four Python packages (`api/`, `output/`, `solver/`, `image/`) and the corpus-evaluator script unchanged from `feature/python-baseline` — these are the reference oracle, not something this effort modifies. Task 2 ports a WASM `cv.Mat` leak monitor (`installCvMonitors`) from the parked `feature/adaptive-c-default-6` branch (commit `ea7f144`) into `web/src/session/store.ts`, and wires its three window-exposed accessors into every `__reportOutcome` call in `web/src/main.ts`.

**Tech Stack:** Python 3.12 (pytest, ruff, mypy), TypeScript/Vitest, opencv.js (WASM).

## Global Constraints

- Bronze gate (`bash scripts/run-bronze-gate.sh`, from repo root) must pass before every commit: `tsc --noEmit`, `tsc -p tsconfig.node.json --noEmit`, `npm test` (from `web/`), `ruff check .`, `mypy . --ignore-missing-imports` (from repo root).
- `python -m pytest tests/` must also be run and pass for Task 1 — bronze gate does not run pytest.
- The four Python packages copied in Task 1 (`killer_sudoku/api/`, `killer_sudoku/output/`, `killer_sudoku/solver/`, `killer_sudoku/image/`) must be copied **unchanged** — no edits. They are the reference oracle for the whole port effort (per the approved spec, `docs/superpowers/specs/2026-07-21-python-bitexact-port-design.md`).
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: Restore the Python reference pipeline

**Files:**
- Create (copied verbatim from `feature/python-baseline`, no edits):
  `killer_sudoku/api/__init__.py`, `killer_sudoku/api/app.py`, `killer_sudoku/api/config.py`,
  `killer_sudoku/api/routers/__init__.py`, `killer_sudoku/api/routers/puzzle.py`,
  `killer_sudoku/api/routers/settings.py`, `killer_sudoku/api/schemas.py`,
  `killer_sudoku/api/session.py`, `killer_sudoku/api/settings.py`,
  `killer_sudoku/output/__init__.py`, `killer_sudoku/output/sol_image.py`,
  `killer_sudoku/solver/**` (all files — `__init__.py`, `equation.py`, `grid.py`,
  `puzzle_spec.py`, `types.py`, and everything under `engine/`),
  `killer_sudoku/image/**` (`__init__.py`, `border_clustering.py`, `border_detection.py`,
  `cell_scan.py`, `config.py`, `grid_location.py`, `inp_image.py`, `number_recognition.py`,
  `validation.py`),
  `killer_sudoku/scripts/__init__.py`, `killer_sudoku/scripts/evaluate_corpus.py`,
  `tests/test_evaluate_corpus.py`, `tests/test_inp_image_diagnostics.py`
- Modify: `pyproject.toml` (ruff `per-file-ignores` for the four restored packages —
  no dependency changes needed, `opencv-python-headless`/`scikit-learn`/`joblib`/`fastapi`
  etc. are already listed), `stubs/sklearn/decomposition.pyi` (adds `mean_`,
  `n_features_in_`, and `npt.ArrayLike` parameter types to the `PCA` stub)

**Interfaces:**
- Produces: `killer_sudoku.image.inp_image.InpImage` (constructor: `filepath: Path,
  config: ImagePipelineConfig, num_recogniser: CayenneNumber`; static factory
  `InpImage.make_num_recogniser() -> CayenneNumber`), `killer_sudoku.image.config.ImagePipelineConfig`
  (default-constructible, `ImagePipelineConfig()`), `killer_sudoku.scripts.evaluate_corpus`
  (CLI script) — these are what Sprint 2's `bitcheck_dump.py` will import.

- [ ] **Step 1: Copy the four Python packages and evaluator script from `feature/python-baseline`**

```bash
git checkout feature/python-baseline -- \
  killer_sudoku/api \
  killer_sudoku/output \
  killer_sudoku/solver \
  killer_sudoku/image \
  killer_sudoku/scripts \
  tests/test_evaluate_corpus.py \
  tests/test_inp_image_diagnostics.py \
  pyproject.toml \
  stubs/sklearn/decomposition.pyi
git status --short
```

Expected: a long list of new files under `killer_sudoku/api/`, `killer_sudoku/output/`,
`killer_sudoku/solver/`, `killer_sudoku/image/`, `killer_sudoku/scripts/`, plus the two
new test files and two modified files (`pyproject.toml`, `stubs/sklearn/decomposition.pyi`).

- [ ] **Step 2: Run pytest to confirm the restored packages import and their tests pass**

```bash
python -m pytest tests/test_evaluate_corpus.py tests/test_inp_image_diagnostics.py -v
```

Expected: all tests PASS. If any import fails (`ModuleNotFoundError`), it means a file
under `killer_sudoku/api/` or `killer_sudoku/output/` was missed in Step 1 — re-check
against `git diff master feature/python-baseline --stat -- killer_sudoku/` for
completeness rather than adding new code.

- [ ] **Step 3: Run the full pytest suite to confirm no collateral breakage**

```bash
python -m pytest tests/ -v
```

Expected: all tests PASS (existing tests for `killer_sudoku/training/` etc. plus the
two new files from Step 2).

- [ ] **Step 4: Run the bronze gate**

```bash
bash scripts/run-bronze-gate.sh
```

Expected: `=== Bronze gate: code checks passed ===` and `.bronze-gate-ok` token created.
This runs `ruff check .` and `mypy . --ignore-missing-imports` over the newly-restored
Python files too (the `pyproject.toml` per-file-ignores from Step 1 are what make this
pass cleanly rather than flooding with legacy-code lint errors).

- [ ] **Step 5: Commit**

```bash
git add killer_sudoku/api killer_sudoku/output killer_sudoku/solver killer_sudoku/image \
  killer_sudoku/scripts tests/test_evaluate_corpus.py tests/test_inp_image_diagnostics.py \
  pyproject.toml stubs/sklearn/decomposition.pyi
git commit -m "$(cat <<'EOF'
feat: restore Python reference image pipeline from feature/python-baseline

Brings killer_sudoku/api, output, solver, and image packages onto this
branch unchanged, as the bit-exact reference oracle for the TS port.
None of this Python code is modified by this effort.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Port the WASM `cv.Mat` leak monitor

**Files:**
- Modify: `web/src/session/store.ts` (add `installCvMonitors`, wire into `loadCV`)
- Modify: `web/src/session/store.test.ts` (add coverage for `installCvMonitors`)
- Modify: `web/src/main.ts` (extend `ReportOutcomeFn`, add `metricsPayload()`, spread
  it into all 9 `__reportOutcome` call sites)

**Interfaces:**
- Consumes: `OpenCVModule` / `Cv` type from `web/src/image/opencv.ts` (already exists,
  unchanged by this task).
- Produces: `installCvMonitors(cv: Cv, win?: Record<string, unknown>): void` — exported
  from `store.ts`, installs `window.__cvLiveMats(): number`,
  `window.__cvHeapBytes(): number`, `window.__cvAllocBytes(): number`. Sprint 2's
  `bitcheck-dump.ts` will call `window.__cvLiveMats()` before/after processing each
  image.

- [ ] **Step 1: Write the failing tests for `installCvMonitors`**

Add to the end of `web/src/session/store.test.ts` (after the existing
`describe('telemetry failure queue', ...)` block, and add `installCvMonitors` to the
existing `import { ... } from './store.js'` at the top of the file):

```ts
import type { OpenCVModule } from '../image/opencv.js';

function makeFakeCv(heapSize = 0): OpenCVModule {
  class FakeMat { delete(): void {} }
  class FakeMatVector {
    delete(): void {}
    get(_i: number): FakeMat { return new FakeMat(); }
  }
  return {
    Mat: FakeMat,
    MatVector: FakeMatVector,
    HEAPU8: new Uint8Array(heapSize),
  } as unknown as OpenCVModule;
}

describe('installCvMonitors', () => {
  it('exposes __cvLiveMats, __cvHeapBytes, __cvAllocBytes on the window object', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect(typeof win['__cvLiveMats']).toBe('function');
    expect(typeof win['__cvHeapBytes']).toBe('function');
    expect(typeof win['__cvAllocBytes']).toBe('function');
  });

  it('starts with zero live mats', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect((win['__cvLiveMats'] as () => number)()).toBe(0);
  });

  it('increments count on new Mat() and decrements on delete()', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    const m = new (cv.Mat as new () => { delete(): void })();
    expect(live()).toBe(1);
    m.delete();
    expect(live()).toBe(0);
  });

  it('increments count on new MatVector() and decrements on delete()', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    const v = new (cv.MatVector as new () => { delete(): void })();
    expect(live()).toBe(1);
    v.delete();
    expect(live()).toBe(0);
  });

  it('counts MatVector.get() accessor mats separately', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    type MV = { delete(): void; get(i: number): { delete(): void } };
    const v = new (cv.MatVector as new () => MV)();
    expect(live()).toBe(1);

    const m = v.get(0);
    expect(live()).toBe(2);

    m.delete();
    expect(live()).toBe(1);

    v.delete();
    expect(live()).toBe(0);
  });

  it('reports HEAPU8 byteLength as __cvHeapBytes', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(4096), win);
    expect((win['__cvHeapBytes'] as () => number)()).toBe(4096);
  });

  it('returns -1 for __cvAllocBytes when _mallinfo is absent', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect((win['__cvAllocBytes'] as () => number)()).toBe(-1);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd web && npx vitest run src/session/store.test.ts
```

Expected: FAIL — `installCvMonitors` is not exported from `./store.js`.

- [ ] **Step 3: Implement `installCvMonitors` in `web/src/session/store.ts`**

Append to the end of `web/src/session/store.ts`:

```ts
/**
 * Installs WASM leak monitors on the cv module and exposes three diagnostic
 * functions on the window object:
 *
 *   window.__cvLiveMats()  — count of cv.Mat / cv.MatVector objects not yet .delete()d
 *   window.__cvHeapBytes() — current WASM heap watermark (cv.HEAPU8.byteLength)
 *   window.__cvAllocBytes() — bytes currently allocated by dlmalloc (-1 if unavailable)
 *
 * Called once immediately after cv is ready. The second parameter defaults to
 * window and is overridable for unit testing.
 */
export function installCvMonitors(
  cv: Cv,
  win: Record<string, unknown> = window as unknown as Record<string, unknown>,
): void {
  let liveMats = 0;
  const m = cv as unknown as Record<string, unknown>;

  // Patch MatVector.prototype.get before wrapping the constructor so the patch
  // applies to every instance. Each accessor-returned Mat is a separate WASM
  // allocation that needs .delete().
  const OrigMatVec = m['MatVector'] as { prototype: { get(i: number): { delete(): void } } };
  const origGet = OrigMatVec.prototype.get;
  OrigMatVec.prototype.get = function (i: number) {
    liveMats++;
    const mat = origGet.call(this, i) as { delete(): void };
    const origDel = mat.delete.bind(mat);
    mat.delete = () => { liveMats--; origDel(); };
    return mat;
  };

  // Wrap Mat constructor.
  const OrigMat = m['Mat'] as new (...a: unknown[]) => { delete(): void };
  m['Mat'] = new Proxy(OrigMat, {
    construct(target, args) {
      liveMats++;
      const inst = Reflect.construct(target, args) as { delete(): void };
      const origDel = inst.delete.bind(inst);
      inst.delete = () => { liveMats--; origDel(); };
      return inst;
    },
  });

  // Wrap MatVector constructor.
  const OrigMatVector = m['MatVector'] as new (...a: unknown[]) => { delete(): void };
  m['MatVector'] = new Proxy(OrigMatVector, {
    construct(target, args) {
      liveMats++;
      const inst = Reflect.construct(target, args) as { delete(): void };
      const origDel = inst.delete.bind(inst);
      inst.delete = () => { liveMats--; origDel(); };
      return inst;
    },
  });

  win['__cvLiveMats'] = (): number => liveMats;
  win['__cvHeapBytes'] = (): number => {
    const heapu8 = m['HEAPU8'] as Uint8Array | undefined;
    return heapu8?.byteLength ?? -1;
  };
  win['__cvAllocBytes'] = (): number => {
    try {
      const mallinfo = m['_mallinfo'] as (() => number) | undefined;
      if (!mallinfo) return -1;
      const ptr = mallinfo();
      const heap32 = m['HEAP32'] as Int32Array | undefined;
      // dlmalloc struct: uordblks (total allocated bytes) is field index 7
      return heap32?.[(ptr >> 2) + 7] ?? -1;
    } catch { return -1; }
  };
}
```

Then wire it into `loadCV`'s WASM-ready callback (inside `web/src/session/store.ts`,
the `script.onload` handler): change

```ts
        .then((module: Cv) => { console.log('[CV] ready'); _cv = module; resolve(_cv); })
```

to

```ts
        .then((module: Cv) => {
          console.log('[CV] ready');
          _cv = module;
          installCvMonitors(_cv);
          resolve(_cv);
        })
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd web && npx vitest run src/session/store.test.ts
```

Expected: PASS (all 7 new tests plus existing `telemetry failure queue` tests).

- [ ] **Step 5: Extend `ReportOutcomeFn` and add `metricsPayload()` in `web/src/main.ts`**

In `web/src/main.ts`, change the `ReportOutcomeFn` type (currently ending at
`givenDigits?: number[][] | null | undefined;`) to add three optional fields:

```ts
type ReportOutcomeFn = (o: {
  bucket: string; reason: string; puzzleType: string | null;
  detectedBigApple: boolean; specHash: string | null;
  fallbackUsed: boolean; specError: string | null;
  parseElapsedMs: number; solveElapsedMs: number;
  /** Present only when window.__reportContourTree is set */
  contourTree?: ContourInfo[] | null | undefined;
  selectedNumbers?: BRect[] | undefined;
  outerGridBR?: BRect | null | undefined;
  borderX?: boolean[][] | null | undefined;
  borderY?: boolean[][] | null | undefined;
  cageTotals?: number[][] | null | undefined;
  givenDigits?: number[][] | null | undefined;
  /** WASM leak monitors — present when installCvMonitors() has run */
  liveMats?: number | undefined;
  heapBytes?: number | undefined;
  allocBytes?: number | undefined;
}) => void;
```

Then add a new function immediately after `timingPayload` (which ends
`return { parseElapsedMs, solveElapsedMs, fallbackUsed, specError }; }`):

```ts
function metricsPayload(): { liveMats: number; heapBytes: number; allocBytes: number } {
  const win = window as unknown as Record<string, unknown>;
  return {
    liveMats: (win['__cvLiveMats'] as (() => number) | undefined)?.() ?? -1,
    heapBytes: (win['__cvHeapBytes'] as (() => number) | undefined)?.() ?? -1,
    allocBytes: (win['__cvAllocBytes'] as (() => number) | undefined)?.() ?? -1,
  };
}
```

- [ ] **Step 6: Spread `metricsPayload()` into every `__reportOutcome` call**

All 9 call sites in `web/src/main.ts` end their object literal with a
`...timingPayload(...)` spread on its own line, immediately followed by a `});` line
(at whatever indentation that call site uses). Use serena's `replace_content` in
regex mode to add `...metricsPayload(),` right after each one, in a single pass:

```
pattern (regex):  ^(\s*)(\.\.\.timingPayload\([^\n]*\),)$
replacement:       $1$2\n$1...metricsPayload(),
```

Apply across `web/src/main.ts` with `replace_all` semantics (all 9 occurrences).
After applying, spot-check with:

```bash
grep -n "timingPayload\|metricsPayload" web/src/main.ts
```

Expected: 9 occurrences of `...timingPayload(` each immediately followed by a line
containing `...metricsPayload(),` — 18 matching lines total (plus the two function
definitions from Step 5, and the `ReportOutcomeFn` type's mention).

- [ ] **Step 7: Run the full TS check and test suite**

```bash
cd web && npx tsc --noEmit && npm test
```

Expected: no type errors, all tests PASS (this exercises the 9 modified call sites'
surrounding logic, though the fake `Cv` used by existing `main.ts`/`inpImage.test.ts`
mocks won't have `installCvMonitors` run against them — `metricsPayload()`'s
`?? -1` defaults handle that case, which is exactly what the "unavailable" tests in
Step 1 cover for the monitor functions themselves).

- [ ] **Step 8: Run the bronze gate**

```bash
cd /path/to/repo/root && bash scripts/run-bronze-gate.sh
```

Expected: `=== Bronze gate: code checks passed ===` and `.bronze-gate-ok` token created.

- [ ] **Step 9: Commit**

```bash
git add web/src/session/store.ts web/src/session/store.test.ts web/src/main.ts
git commit -m "$(cat <<'EOF'
feat: port WASM cv.Mat leak monitor from feature/adaptive-c-default-6

Ports installCvMonitors (window.__cvLiveMats/__cvHeapBytes/__cvAllocBytes)
from commit ea7f144 on the parked feature/adaptive-c-default-6 branch,
where it diagnosed and fixed a leak that had degraded corpus clean rate
from ~94% to ~37%. Wires it into every __reportOutcome call via a new
metricsPayload() helper so the evaluator's existing live_mats/heap_bytes/
alloc_bytes columns (already present in corpus-db.ts) start receiving
real data. Sprint 2's per-image bitcheck harness will assert
__cvLiveMats() returns to its pre-image value after each image.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After this sprint

Both the Python reference pipeline and the memory-leak monitor are in place and
independently verified (pytest + bronze gate for Task 1; vitest + bronze gate for
Task 2). Sprint 2 (a separate plan, written after this one is executed) builds the
per-image bit-check harness (`bitcheck_dump.py`, `bitcheck-dump.ts`,
`bitcheck_diff.py`) on top of both, and runs it end-to-end on
`classic_guardian/easy/killer_sudoku_0.jpg`.
