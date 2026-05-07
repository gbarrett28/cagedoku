# Remote Training Data Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual training-data export with automatic, consent-gated upload to a Cloudflare Worker that stores samples in R2 and comments on a permanent GitHub Issue thread.

**Architecture:** The browser extracts training data at cage-total confirmation, shows a consent modal if no cookie is set, then fires a POST to a Cloudflare Worker. The Worker validates the payload, rejects it if 50+ unprocessed uploads exist in R2, stores it, and adds a comment to GitHub Issue #1. Phase 2 adds a weekly GitHub Actions workflow that retrains the model automatically.

**Tech Stack:** TypeScript (Vitest tests), Cloudflare Workers (TypeScript), Cloudflare R2, GitHub Issues API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-05-07-remote-training-data-design.md`

---

## File Map

### Phase 1 — Browser changes

| File | Action | Purpose |
|---|---|---|
| `web/src/session/types.ts` | Modify | Remove `cellThumbs` from `PuzzleSpecData` |
| `web/src/session/specUtils.ts` | Modify | Remove `cellThumbs` parameter from `specToData()` |
| `web/src/session/actions.ts` | Modify | Surface `cellThumbs` through `UploadResult`; remove from `specToData()` call |
| `web/src/image/trainingUpload.ts` | Create | Consent cookie helpers + fire-and-forget upload |
| `web/src/image/trainingUpload.test.ts` | Create | Unit tests for trainingUpload |
| `web/src/main.ts` | Modify | Remove `handleExport`; add `pendingCellThumbs`; wire consent modal |
| `web/index.html` | Modify | Remove export button; add consent `<dialog>` |
| `.env.production` | Create | `VITE_TRAINING_WORKER_URL` (gitignored) |
| `.github/workflows/pages.yml` | Modify | Inject `VITE_TRAINING_WORKER_URL` secret into build |

### Phase 1 — Cloudflare Worker

| File | Action | Purpose |
|---|---|---|
| `worker/package.json` | Create | Worker npm project |
| `worker/tsconfig.json` | Create | Worker TypeScript config |
| `worker/wrangler.toml` | Create | Worker + R2 config |
| `worker/src/validate.ts` | Create | `isTrainingExport()` type guard |
| `worker/src/validate.test.ts` | Create | Validation unit tests |
| `worker/src/index.ts` | Create | Fetch handler |

### Phase 2 — Automated retraining

| File | Action | Purpose |
|---|---|---|
| `scripts/collect_training.sh` | Create | List/download R2 objects, react to comments |
| `.github/workflows/retrain.yml` | Create | Weekly scheduled retrain workflow |

---

## Phase 1 — Data Collection

### Task 1: Remove cellThumbs from session state

**Files:**
- Modify: `web/src/session/types.ts`
- Modify: `web/src/session/specUtils.ts`
- Modify: `web/src/session/actions.ts`

- [ ] **Step 1: Remove `cellThumbs` from `PuzzleSpecData`**

In `web/src/session/types.ts`, find the `PuzzleSpecData` interface and delete the `cellThumbs` line:

```typescript
// Before:
export interface PuzzleSpecData {
  readonly regions: number[][];
  readonly cageTotals: number[][];
  /** Thumbnails from the digit recogniser, keyed "row,col". May be absent for classic puzzles or test fixtures. */
  readonly cellThumbs?: ReadonlyMap<string, Uint8Array[]>;
}

// After:
export interface PuzzleSpecData {
  readonly regions: number[][];
  readonly cageTotals: number[][];
}
```

- [ ] **Step 2: Remove `cellThumbs` parameter from `specToData()`**

In `web/src/session/specUtils.ts`, update `specToData()`:

```typescript
// Before:
export function specToData(
  spec: PuzzleSpec,
  cellThumbs: ReadonlyMap<string, Uint8Array[]> = new Map(),
): PuzzleSpecData {
  return {
    regions: spec.regions.map(row => [...row]),
    cageTotals: spec.cageTotals.map(row => [...row]),
    cellThumbs,
  };
}

// After:
export function specToData(spec: PuzzleSpec): PuzzleSpecData {
  return {
    regions: spec.regions.map(row => [...row]),
    cageTotals: spec.cageTotals.map(row => [...row]),
  };
}
```

- [ ] **Step 3: Surface `cellThumbs` through `UploadResult` and fix `uploadPuzzle()`**

In `web/src/session/actions.ts`, update `UploadResult` and `uploadPuzzle()`:

```typescript
// Update UploadResult interface (around line 70):
export interface UploadResult {
  state: PuzzleState;
  warpedImageUrl: string | null;
  warning: string | null;
  cellThumbs: ReadonlyMap<string, Uint8Array[]>;
}
```

In `uploadPuzzle()`, change the `specToData` call and the return value (around lines 141-156):

```typescript
  const state: PuzzleState = {
    specData: specToData(spec),   // no cellThumbs arg
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...settings.alwaysApplyRules],
    goldenSolution: null,
    puzzleType: result.puzzleType,
    givenDigits: result.givenDigits,
    originalImageUrl,
    warpedImageUrl,
  };

  setState(state);
  return { state, warpedImageUrl, warning, cellThumbs: result.cellThumbs };
```

Also update `loadSpecDirect()` to include `cellThumbs` in its return (it has no thumbnails, so use an empty map):

```typescript
export function loadSpecDirect(spec: PuzzleSpec): UploadResult {
  const settings = loadSettings();
  const state: PuzzleState = {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...settings.alwaysApplyRules],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
  setState(state);
  return { state, warpedImageUrl: null, warning: null, cellThumbs: new Map() };
}
```

- [ ] **Step 4: Type-check**

Run from `web/`:
```
npx tsc --noEmit
```
Expected: no errors. If `cellThumbs` is still referenced anywhere (e.g. a test file), remove the reference there too.

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```
git add web/src/session/types.ts web/src/session/specUtils.ts web/src/session/actions.ts
git commit -m "refactor: remove cellThumbs from PuzzleSpecData; surface through UploadResult"
```

---

### Task 2: Remove export button and handleExport from UI

**Files:**
- Modify: `web/src/main.ts`
- Modify: `web/index.html`

- [ ] **Step 1: Delete `handleExport()` and its button listener from `main.ts`**

Remove the entire `handleExport` function (around lines 451–464):

```typescript
// DELETE this entire function:
function handleExport(): void {
  if (currentState === null) return;
  const { cellThumbs = new Map(), cageTotals } = currentState.specData;
  const data = extractTrainingData(cellThumbs, cageTotals, currentState.puzzleType, defaultImagePipelineConfig().numberRecognition.subres);
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `training-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${data.sampleCount} training sample${data.sampleCount !== 1 ? 's' : ''}`);
}
```

Remove the button listener (around line 872):
```typescript
// DELETE this line:
el<HTMLButtonElement>('export-btn').addEventListener('click', () => { void handleExport(); });
```

Remove the `export-btn` hidden toggle from `renderPlayingMode` (around line 420):
```typescript
// DELETE this line:
el<HTMLButtonElement>('export-btn').hidden = !isKiller || state.warpedImageUrl === null;
```

- [ ] **Step 2: Remove the inline auto-download block from `handleConfirm()`**

In `handleConfirm()`, remove lines 728–743 (the auto-download block). Leave everything else in `handleConfirm()` intact:

```typescript
// DELETE this block from handleConfirm():
// Fire-and-forget training export — only when the user has corrected something,
// so unedited OCR results (which may contain errors) are never written to disk.
if (draftEdited && exportPuzzleType !== 'classic') {
  const data = extractTrainingData(exportThumbs, exportTotals, exportPuzzleType, exportSubres);
  if (data.sampleCount > 0) {
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `training-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${data.sampleCount} training sample${data.sampleCount !== 1 ? 's' : ''}`);
  }
}
```

Also remove the four `const export*` capture lines at the top of `handleConfirm()` (lines 702–706) — they will be replaced in Task 5:

```typescript
// DELETE these four lines from handleConfirm():
const exportThumbs   = currentState.specData.cellThumbs ?? new Map();
const exportTotals   = currentState.specData.cageTotals;
const exportPuzzleType = currentState.puzzleType;
const exportSubres   = defaultImagePipelineConfig().numberRecognition.subres;
```

Do NOT remove the import of `extractTrainingData` yet — it will be re-used in Task 5.

- [ ] **Step 3: Remove export button from `index.html`**

In `web/index.html`, find and delete:
```html
<button id="export-btn" class="btn-secondary" hidden>Export training data</button>
```

- [ ] **Step 4: Type-check and test**

```
npx tsc --noEmit && npm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add web/src/main.ts web/index.html
git commit -m "feat: remove manual training export button and auto-download"
```

---

### Task 3: Create trainingUpload.ts

**Files:**
- Create: `web/src/image/trainingUpload.ts`
- Create: `web/src/image/trainingUpload.test.ts`

- [ ] **Step 1: Write failing tests**

Create `web/src/image/trainingUpload.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Cookie helpers operate on document.cookie — jsdom provides this in tests.

describe('hasConsent', () => {
  beforeEach(() => {
    // Clear all cookies before each test.
    document.cookie.split(';').forEach(c => {
      const key = c.split('=')[0]!.trim();
      document.cookie = `${key}=; max-age=0`;
    });
  });

  it('returns false when no consent cookie exists', async () => {
    const { hasConsent } = await import('./trainingUpload.js');
    expect(hasConsent()).toBe(false);
  });

  it('returns true when training_consent=granted cookie is set', async () => {
    document.cookie = 'training_consent=granted';
    const { hasConsent } = await import('./trainingUpload.js');
    expect(hasConsent()).toBe(true);
  });

  it('returns false when cookie has different value', async () => {
    document.cookie = 'training_consent=declined';
    const { hasConsent } = await import('./trainingUpload.js');
    expect(hasConsent()).toBe(false);
  });
});

describe('grantConsent', () => {
  beforeEach(() => {
    document.cookie.split(';').forEach(c => {
      const key = c.split('=')[0]!.trim();
      document.cookie = `${key}=; max-age=0`;
    });
  });

  it('sets the consent cookie so hasConsent() returns true', async () => {
    const { hasConsent, grantConsent } = await import('./trainingUpload.js');
    expect(hasConsent()).toBe(false);
    grantConsent();
    expect(hasConsent()).toBe(true);
  });
});

describe('uploadTrainingData', () => {
  it('calls fetch with the worker URL and JSON body when URL is defined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));
    // Simulate VITE_TRAINING_WORKER_URL being set via import.meta.env
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');

    const { uploadTrainingData } = await import('./trainingUpload.js');
    const fakeData = {
      version: 1 as const,
      exportedAt: '2026-05-07T00:00:00.000Z',
      appVersion: 'test',
      puzzleType: 'killer' as const,
      subres: 128,
      thumbnailSize: 64,
      sampleCount: 1,
      samples: [{ digit: 3, pixels: new Array(4096).fill(0) }],
    };
    uploadTrainingData(fakeData);
    // Fire-and-forget: fetch is called but we don't await the result.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test-worker.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('does not call fetch when VITE_TRAINING_WORKER_URL is not set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');

    const { uploadTrainingData } = await import('./trainingUpload.js');
    uploadTrainingData({
      version: 1, exportedAt: '', appVersion: '', puzzleType: 'killer',
      subres: 128, thumbnailSize: 64, sampleCount: 0, samples: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test -- trainingUpload
```
Expected: FAIL — `trainingUpload.js` does not exist.

- [ ] **Step 3: Implement `trainingUpload.ts`**

Create `web/src/image/trainingUpload.ts`:

```typescript
import type { TrainingExport } from './trainingExport.js';

const CONSENT_COOKIE = 'training_consent';
const WORKER_URL = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;

export function hasConsent(): boolean {
  return document.cookie.split(';').some(c => c.trim() === `${CONSENT_COOKIE}=granted`);
}

export function grantConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=granted; max-age=31536000; SameSite=Strict`;
}

export function uploadTrainingData(data: TrainingExport): void {
  if (!WORKER_URL) return;
  void fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {
    // Fire-and-forget: silently discard network errors.
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test -- trainingUpload
```
Expected: all pass.

- [ ] **Step 5: Full test suite**

```
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```
git add web/src/image/trainingUpload.ts web/src/image/trainingUpload.test.ts
git commit -m "feat: add trainingUpload module with consent cookie and fire-and-forget POST"
```

---

### Task 4: Add consent modal to index.html

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add the consent `<dialog>` to `index.html`**

After the last existing `</dialog>` tag in `web/index.html`, add:

```html
<dialog id="training-consent-modal">
  <h2>Help improve digit recognition</h2>
  <p>The digit images extracted from your puzzle will be sent anonymously &mdash;
     64&times;64&nbsp;pixel thumbnails of cage total numbers only.
     No puzzle layout, personal information, or newspaper image is included.</p>
  <div class="modal-actions">
    <button id="training-consent-once-btn">Send this time</button>
    <button id="training-consent-always-btn">Always send</button>
    <button id="training-consent-skip-btn" class="btn-secondary">Skip</button>
  </div>
</dialog>
```

- [ ] **Step 2: Type-check**

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```
git add web/index.html
git commit -m "feat: add training consent dialog to index.html"
```

---

### Task 5: Wire upload into handleConfirm

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: Add imports and `pendingCellThumbs` module variable**

At the top of `web/src/main.ts`, add the two new imports alongside the existing image imports:

```typescript
import { hasConsent, grantConsent, uploadTrainingData } from './image/trainingUpload.js';
```

Near the top of `main.ts` where the other module-level state variables are declared, add:

```typescript
let pendingCellThumbs = new Map<string, Uint8Array[]>();
```

- [ ] **Step 2: Capture `cellThumbs` from `uploadPuzzle()` result in `handleProcess()`**

In `handleProcess()`, update the destructuring to capture `cellThumbs` and store it:

```typescript
async function handleProcess(): Promise<void> {
  const fileInput = el<HTMLInputElement>('file-input');
  if (!fileInput.files || fileInput.files.length === 0) { setStatus('Please select an image file.', true); return; }
  setLoading(true);
  try {
    const { state, warpedImageUrl, warning, cellThumbs } = await uploadPuzzle(fileInput.files[0]!);
    pendingCellThumbs = new Map(cellThumbs);
    applyUploadResult(state, warpedImageUrl, warning);
  } catch (e) {
    setStatus(`Processing failed: ${String(e)}`, true);
  }
  finally { setLoading(false); }
}
```

- [ ] **Step 3: Add upload trigger inside `handleConfirm()` and clear `pendingCellThumbs`**

In `handleConfirm()`, after `renderPlayingMode(playing)` and `setStatus('')` (around line 726), add the upload trigger. Replace the deleted auto-download block with:

```typescript
    // Trigger training upload when the user confirmed a killer puzzle with edits.
    if (draftEdited && currentState.puzzleType !== 'classic') {
      const data = extractTrainingData(
        pendingCellThumbs,
        currentState.specData.cageTotals,
        currentState.puzzleType,
        defaultImagePipelineConfig().numberRecognition.subres,
      );
      pendingCellThumbs = new Map(); // discard thumbnails — no longer needed
      if (data.sampleCount > 0) {
        if (hasConsent()) {
          uploadTrainingData(data);
        } else {
          showTrainingConsentModal(data);
        }
      }
    } else {
      pendingCellThumbs = new Map();
    }
```

- [ ] **Step 4: Add `showTrainingConsentModal()` function**

Add this function near the other modal functions in `main.ts`:

```typescript
function showTrainingConsentModal(data: import('./image/trainingExport.js').TrainingExport): void {
  const modal = el<HTMLDialogElement>('training-consent-modal');

  const onceBtn   = el<HTMLButtonElement>('training-consent-once-btn');
  const alwaysBtn = el<HTMLButtonElement>('training-consent-always-btn');
  const skipBtn   = el<HTMLButtonElement>('training-consent-skip-btn');

  const cleanup = (): void => { modal.close(); };

  onceBtn.onclick = () => { uploadTrainingData(data); cleanup(); };
  alwaysBtn.onclick = () => { grantConsent(); uploadTrainingData(data); cleanup(); };
  skipBtn.onclick = () => { cleanup(); };

  modal.showModal();
}
```

- [ ] **Step 5: Type-check**

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 7: Manual smoke test**

Start the dev server:
```
npm run dev
```
Open the app, load a killer puzzle image, edit a cage total, confirm. Verify:
- The training consent modal appears.
- "Send this time" closes the modal without setting a cookie.
- Loading another puzzle and confirming shows the modal again.
- "Always send" closes the modal and sets `training_consent=granted` (check Application → Cookies in DevTools).
- Subsequent puzzles skip the modal and upload silently (check Network tab for a POST to the worker URL — it will fail in dev since the worker isn't running, which is expected).
- "Skip" dismisses the modal with no upload and no cookie.

- [ ] **Step 8: Commit**

```
git add web/src/main.ts
git commit -m "feat: wire training upload into handleConfirm with consent modal"
```

---

### Task 6: Cloudflare Worker — validate.ts

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/src/validate.ts`
- Create: `worker/src/validate.test.ts`

- [ ] **Step 1: Create worker project**

```
mkdir worker && mkdir worker/src
```

Create `worker/package.json`:

```json
{
  "name": "cagedoku-training-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.0.0"
  }
}
```

Create `worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts"]
}
```

Install dependencies:
```
cd worker && npm install
```

- [ ] **Step 2: Write failing validation tests**

Create `worker/src/validate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isTrainingExport } from './validate.js';

const validSample = { digit: 3, pixels: new Array(4096).fill(128) };

const validExport = {
  version: 1,
  exportedAt: '2026-05-07T00:00:00.000Z',
  appVersion: '2026-05-07 10:00',
  puzzleType: 'killer',
  subres: 128,
  thumbnailSize: 64,
  sampleCount: 1,
  samples: [validSample],
};

describe('isTrainingExport', () => {
  it('accepts a valid TrainingExport', () => {
    expect(isTrainingExport(validExport)).toBe(true);
  });

  it('rejects null', () => {
    expect(isTrainingExport(null)).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(isTrainingExport({ ...validExport, version: 2 })).toBe(false);
  });

  it('rejects when sampleCount does not match samples.length', () => {
    expect(isTrainingExport({ ...validExport, sampleCount: 99 })).toBe(false);
  });

  it('rejects a sample with digit out of range', () => {
    const bad = { digit: 10, pixels: new Array(4096).fill(0) };
    expect(isTrainingExport({ ...validExport, samples: [bad], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with wrong pixel count', () => {
    const bad = { digit: 1, pixels: new Array(100).fill(0) };
    expect(isTrainingExport({ ...validExport, samples: [bad], sampleCount: 1 })).toBe(false);
  });

  it('rejects a sample with pixel value out of range', () => {
    const bad = { digit: 1, pixels: new Array(4096).fill(256) };
    expect(isTrainingExport({ ...validExport, samples: [bad], sampleCount: 1 })).toBe(false);
  });

  it('rejects missing fields', () => {
    const { samples: _s, ...noSamples } = validExport;
    expect(isTrainingExport(noSamples)).toBe(false);
  });

  it('accepts puzzleType classic', () => {
    expect(isTrainingExport({ ...validExport, puzzleType: 'classic' })).toBe(true);
  });

  it('rejects unknown puzzleType', () => {
    expect(isTrainingExport({ ...validExport, puzzleType: 'unknown' })).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```
cd worker && npm test
```
Expected: FAIL — `validate.js` does not exist.

- [ ] **Step 4: Implement `validate.ts`**

Create `worker/src/validate.ts`:

```typescript
export interface TrainingSample {
  digit: number;
  pixels: number[];
}

export interface TrainingExport {
  version: 1;
  exportedAt: string;
  appVersion: string;
  puzzleType: 'killer' | 'classic';
  subres: number;
  thumbnailSize: number;
  sampleCount: number;
  samples: TrainingSample[];
}

export function isTrainingExport(value: unknown): value is TrainingExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  if (v['version'] !== 1) return false;
  if (typeof v['exportedAt'] !== 'string') return false;
  if (typeof v['appVersion'] !== 'string') return false;
  if (v['puzzleType'] !== 'killer' && v['puzzleType'] !== 'classic') return false;
  if (typeof v['subres'] !== 'number') return false;
  if (typeof v['thumbnailSize'] !== 'number') return false;
  if (typeof v['sampleCount'] !== 'number') return false;
  if (!Array.isArray(v['samples'])) return false;
  if (v['sampleCount'] !== v['samples'].length) return false;

  for (const s of v['samples'] as unknown[]) {
    if (!isSample(s)) return false;
  }
  return true;
}

function isSample(value: unknown): value is TrainingSample {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s['digit'] !== 'number' || s['digit'] < 0 || s['digit'] > 9) return false;
  if (!Array.isArray(s['pixels'])) return false;
  if (s['pixels'].length !== 4096) return false;
  for (const p of s['pixels'] as unknown[]) {
    if (typeof p !== 'number' || p < 0 || p > 255) return false;
  }
  return true;
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```
cd worker && npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```
git add worker/
git commit -m "feat: add Cloudflare Worker project with TrainingExport validation"
```

---

### Task 7: Cloudflare Worker — index.ts

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.ts`

- [ ] **Step 1: Create `wrangler.toml`**

Create `worker/wrangler.toml`:

```toml
name = "cagedoku-training"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "TRAINING_BUCKET"
bucket_name = "cagedoku-training"

[vars]
GITHUB_REPO = "gbarrett28/cagedoku"
GITHUB_ISSUE_NUMBER = "1"
MAX_PENDING_UPLOADS = "50"
ENVIRONMENT = "production"
```

- [ ] **Step 2: Create the fetch handler**

Create `worker/src/index.ts`:

```typescript
import { isTrainingExport } from './validate.js';
import type { TrainingExport } from './validate.js';

export interface Env {
  TRAINING_BUCKET: R2Bucket;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_ISSUE_NUMBER: string;
  MAX_PENDING_UPLOADS: string;
  ENVIRONMENT: string;
}

const ALLOWED_ORIGINS_PROD = /^https:\/\/[a-z0-9-]+\.github\.io$/;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed =
    env.ENVIRONMENT === 'development'
      ? true
      : origin !== null && ALLOWED_ORIGINS_PROD.test(origin);

  return allowed && origin !== null
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    : {};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    const ct = request.headers.get('Content-Type') ?? '';
    if (!ct.includes('application/json')) {
      return new Response('Bad request', { status: 400, headers });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400, headers });
    }

    if (!isTrainingExport(body)) {
      return new Response('Bad request', { status: 400, headers });
    }

    const data: TrainingExport = body;
    const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);

    const listed = await env.TRAINING_BUCKET.list({
      prefix: 'training/',
      limit: maxPending + 1,
    });
    if (listed.objects.length >= maxPending) {
      return new Response('Too many pending uploads', { status: 429, headers });
    }

    const key = `training/${data.exportedAt}-${crypto.randomUUID()}.json`;
    await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        appVersion: data.appVersion,
        puzzleType: data.puzzleType,
        sampleCount: String(data.sampleCount),
      },
    });

    await postGitHubComment(env, data, key);

    return new Response('OK', { status: 200, headers });
  },
};

async function postGitHubComment(env: Env, data: TrainingExport, key: string): Promise<void> {
  const body =
    `**New upload** — ${data.sampleCount} samples (${data.puzzleType}), ` +
    `app ${data.appVersion}, ${data.exportedAt}\n` +
    `R2 key: \`${key}\``;

  await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${env.GITHUB_ISSUE_NUMBER}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cagedoku-training-worker',
      },
      body: JSON.stringify({ body }),
    },
  );
}
```

- [ ] **Step 3: Type-check the worker**

```
cd worker && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```
git add worker/src/index.ts worker/wrangler.toml
git commit -m "feat: implement Cloudflare Worker fetch handler with R2 storage and GitHub Issue comments"
```

---

### Task 8: Infrastructure setup and CI

**Files:**
- Create: `.env.production` (do not commit — add to `.gitignore`)
- Modify: `.github/workflows/pages.yml`

- [ ] **Step 1: Create R2 bucket**

Run once from any terminal with `wrangler` installed:
```
wrangler r2 bucket create cagedoku-training
```

- [ ] **Step 2: Create a fine-grained GitHub PAT**

Go to GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token.
- Repository access: `gbarrett28/cagedoku` only
- Permissions: Issues → Read and write
- Expiry: 1 year (or no expiry)

Copy the token value.

- [ ] **Step 3: Store the PAT as a Worker secret**

```
cd worker && wrangler secret put GITHUB_TOKEN
```
Paste the token when prompted.

- [ ] **Step 4: Deploy the worker**

```
cd worker && wrangler deploy
```
Note the deployed URL, e.g. `https://cagedoku-training.<account>.workers.dev`.

- [ ] **Step 5: Add `VITE_TRAINING_WORKER_URL` to gitignore and create `.env.production`**

Check if `.env.production` is already in `.gitignore`. If not, add it:
```
echo ".env.production" >> web/.gitignore
```

Create `web/.env.production`:
```
VITE_TRAINING_WORKER_URL=https://cagedoku-training.<account>.workers.dev
```
Replace `<account>` with your Cloudflare account subdomain.

- [ ] **Step 6: Add `TRAINING_WORKER_URL` as a GitHub Actions secret**

Go to `https://github.com/gbarrett28/cagedoku/settings/secrets/actions` → New repository secret.
- Name: `TRAINING_WORKER_URL`
- Value: `https://cagedoku-training.<account>.workers.dev`

- [ ] **Step 7: Update `pages.yml` to inject the worker URL at build time**

In `.github/workflows/pages.yml`, update the Build step to pass the secret as an env var:

```yaml
      - name: Build
        working-directory: web
        env:
          VITE_TRAINING_WORKER_URL: ${{ secrets.TRAINING_WORKER_URL }}
        run: npm run build
```

- [ ] **Step 8: Commit the workflow change**

```
git add .github/workflows/pages.yml
git commit -m "ci: inject VITE_TRAINING_WORKER_URL into GitHub Pages build"
```

- [ ] **Step 9: End-to-end smoke test**

Push the branch to GitHub and let the Pages workflow build and deploy. Once deployed:
1. Open the live app at `https://gbarrett28.github.io/cagedoku/`.
2. Load a killer puzzle, edit a cage total, confirm.
3. The consent modal should appear.
4. Click "Send this time" — check the Network tab for a POST to the worker URL with status 200.
5. Check GitHub Issue #1 at `https://github.com/gbarrett28/cagedoku/issues/1` — a new comment should appear within a few seconds.
6. Check the R2 bucket: `wrangler r2 object list cagedoku-training --prefix training/`.

---

## Phase 2 — Automated Retraining

> **Do not implement Phase 2 until Phase 1 is deployed and has collected at least one real upload.**

### Task 9: collect_training.sh helper script

**Files:**
- Create: `scripts/collect_training.sh`

- [ ] **Step 1: Create the script**

Create `scripts/collect_training.sh`:

```bash
#!/usr/bin/env bash
# Download all pending training uploads from R2 and mark their GitHub Issue
# comments as processed (✅ reaction). Outputs downloaded JSON file paths to stdout.
#
# Usage: bash scripts/collect_training.sh <output_dir>
# Example: bash scripts/collect_training.sh /tmp/training

set -euo pipefail

BUCKET="cagedoku-training"
REPO="gbarrett28/cagedoku"
OUTPUT_DIR="${1:?Usage: $0 <output_dir>}"

mkdir -p "$OUTPUT_DIR"

echo "Listing pending uploads in R2..."
KEYS=$(wrangler r2 object list "$BUCKET" --prefix training/ --json 2>/dev/null \
  | python3 -c "import sys,json; [print(o['key']) for o in json.load(sys.stdin).get('objects',[])]")

if [ -z "$KEYS" ]; then
  echo "No pending uploads found."
  exit 0
fi

echo "$KEYS" | while IFS= read -r key; do
  filename=$(basename "$key")
  outfile="$OUTPUT_DIR/$filename"
  echo "Downloading $key → $outfile"
  wrangler r2 object get "$BUCKET" "$key" --file "$outfile"
done

echo ""
echo "Downloaded $(echo "$KEYS" | wc -l | tr -d ' ') file(s) to $OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  python web/train_recogniser.py --browser-weight 1000 --svm-c 100 \\"
echo "    web/browser_train.json $OUTPUT_DIR/*.json"
echo ""
echo "After retraining and verifying accuracy, delete processed R2 objects:"
echo "  bash scripts/delete_processed.sh $OUTPUT_DIR"
```

Create `scripts/delete_processed.sh`:

```bash
#!/usr/bin/env bash
# Delete R2 objects whose local files are in the given directory, then add
# ✅ reactions to the corresponding GitHub Issue #1 comments.
#
# Usage: bash scripts/delete_processed.sh <dir_of_downloaded_files>

set -euo pipefail

BUCKET="cagedoku-training"
REPO="gbarrett28/cagedoku"
ISSUE=1
DIR="${1:?Usage: $0 <dir_of_downloaded_files>}"

for jsonfile in "$DIR"/*.json; do
  [ -f "$jsonfile" ] || continue
  filename=$(basename "$jsonfile")
  key="training/$filename"

  echo "Deleting R2 object: $key"
  wrangler r2 object delete "$BUCKET" "$key"
done

echo "Fetching GitHub Issue #$ISSUE comments to react to..."
COMMENTS=$(gh api "/repos/$REPO/issues/$ISSUE/comments" --jq '.[] | "\(.id) \(.body)"')

echo "$COMMENTS" | while IFS=' ' read -r id rest; do
  if echo "$rest" | grep -q 'training/'; then
    echo "Adding ✅ reaction to comment $id"
    gh api "/repos/$REPO/issues/comments/$id/reactions" \
      -f content='+1' > /dev/null 2>&1 || true
  fi
done

echo "Done."
```

- [ ] **Step 2: Make scripts executable**

```
chmod +x scripts/collect_training.sh scripts/delete_processed.sh
```

- [ ] **Step 3: Commit**

```
git add scripts/collect_training.sh scripts/delete_processed.sh
git commit -m "feat: add collect_training and delete_processed helper scripts"
```

---

### Task 10: Scheduled retrain workflow

**Files:**
- Create: `.github/workflows/retrain.yml`

- [ ] **Step 1: Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets**

Go to `https://github.com/gbarrett28/cagedoku/settings/secrets/actions`:
- Add `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with R2 read/write/delete and Workers KV permissions.
- Add `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID (found in the Cloudflare dashboard sidebar).

- [ ] **Step 2: Create `retrain.yml`**

Create `.github/workflows/retrain.yml`:

```yaml
name: Retrain digit recogniser

on:
  schedule:
    - cron: '0 3 * * 0'   # 03:00 UTC every Sunday
  workflow_dispatch:

permissions:
  contents: write
  issues: write

jobs:
  retrain:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python dependencies
        run: |
          pip install scikit-learn numpy scipy pillow matplotlib

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install wrangler
        run: npm install -g wrangler

      - name: List pending R2 uploads
        id: list
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          KEYS=$(wrangler r2 object list cagedoku-training --prefix training/ --json 2>/dev/null \
            | python3 -c "import sys,json; keys=[o['key'] for o in json.load(sys.stdin).get('objects',[])]; print('\n'.join(keys)); print(f'count={len(keys)}')" \
            | tee /tmp/r2_keys.txt | tail -1)
          echo "$KEYS" >> "$GITHUB_OUTPUT"

      - name: Exit early if no pending uploads
        if: steps.list.outputs.count == '0'
        run: |
          echo "No pending uploads — nothing to retrain."
          exit 0

      - name: Download pending uploads
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          mkdir -p /tmp/training
          grep -v '^count=' /tmp/r2_keys.txt | while IFS= read -r key; do
            filename=$(basename "$key")
            wrangler r2 object get cagedoku-training "$key" --file "/tmp/training/$filename"
          done

      - name: Retrain
        run: |
          python web/train_recogniser.py \
            --browser-weight 1000 --svm-c 100 \
            web/browser_train.json /tmp/training/*.json

      - name: Evaluate accuracy
        id: eval
        run: |
          # Compare new model against baseline eval_report.json if it exists.
          # If no baseline exists, skip comparison (first retrain).
          if [ -f web/public/eval_report.json ]; then
            python -m killer_sudoku.training.evaluate \
              --puzzle-dir killer_sudoku/guardian \
              --compare web/public/eval_report.json
          else
            echo "No baseline eval_report.json — skipping accuracy comparison."
          fi

      - name: Open failure issue and abort on regression
        if: failure() && steps.eval.conclusion == 'failure'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh issue create \
            --title "Retrain regression detected $(date -u +%Y-%m-%d)" \
            --body "The scheduled retrain workflow detected an accuracy regression. See the failed run for details." \
            --label "bug"
          exit 1

      - name: Commit updated model
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add web/public/num_recogniser.json web/public/num_recogniser.bin
          git diff --cached --quiet || git commit -m "chore: retrain digit recogniser with new browser samples"
          git push

      - name: Merge samples into browser_train.json
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          python - <<'EOF'
          import json, glob, pathlib
          base = pathlib.Path('web/browser_train.json')
          data = json.loads(base.read_text()) if base.exists() else {"version": 1, "samples": []}
          for f in glob.glob('/tmp/training/*.json'):
              incoming = json.loads(pathlib.Path(f).read_text())
              data['samples'].extend(incoming.get('samples', []))
          data['sampleCount'] = len(data['samples'])
          base.write_text(json.dumps(data, separators=(',', ':')))
          EOF
          git add web/browser_train.json
          git diff --cached --quiet || git commit -m "chore: merge new browser samples into browser_train.json"
          git push

      - name: Delete processed R2 objects
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          grep -v '^count=' /tmp/r2_keys.txt | while IFS= read -r key; do
            wrangler r2 object delete cagedoku-training "$key"
          done

      - name: React to processed GitHub Issue comments
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api /repos/gbarrett28/cagedoku/issues/1/comments --jq '.[].id' | \
          while IFS= read -r comment_id; do
            body=$(gh api "/repos/gbarrett28/cagedoku/issues/comments/$comment_id" --jq '.body')
            if echo "$body" | grep -q 'training/'; then
              gh api "/repos/gbarrett28/cagedoku/issues/comments/$comment_id/reactions" \
                -f content='+1' > /dev/null 2>&1 || true
            fi
          done
```

- [ ] **Step 3: Commit**

```
git add .github/workflows/retrain.yml
git commit -m "feat: add scheduled weekly retrain workflow (Phase 2)"
```

- [ ] **Step 4: Manual trigger test**

Go to `https://github.com/gbarrett28/cagedoku/actions/workflows/retrain.yml` and click "Run workflow". Verify it exits early with "No pending uploads" if R2 is empty. After a real upload arrives, run again and verify end-to-end.

---

## Self-review notes (spec coverage check)

| Spec requirement | Covered by |
|---|---|
| `cellThumbs` removed from session state | Task 1 |
| Export Training button removed | Task 2 |
| Inline auto-download removed | Task 2 |
| `trainingUpload.ts` with consent cookie helpers | Task 3 |
| Consent modal with three buttons | Tasks 4, 5 |
| Cookie set for "Always send"; not set for "Send this time" / "Skip" | Task 3, 5 |
| Fire-and-forget POST, errors swallowed | Task 3 |
| Worker schema validation → 400 | Task 6 |
| R2 list cap → 429 | Task 7 |
| R2 PUT with metadata | Task 7 |
| GitHub Issue comment on each upload | Task 7 |
| CORS restricted to github.io | Task 7 |
| `VITE_TRAINING_WORKER_URL` absent → no upload in dev | Task 3 |
| pages.yml injects worker URL | Task 8 |
| R2 bucket created | Task 8 |
| GitHub PAT (`issues: write`) stored as Worker secret | Task 8 |
| Helper scripts for manual Phase 1 workflow | Task 9 |
| Weekly scheduled retrain workflow | Task 10 |
| Accuracy regression check → failure issue | Task 10 |
| ✅ reactions on processed comments | Tasks 9, 10 |
