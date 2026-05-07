# Remote Training Data Collection — Design Spec

**Date:** 2026-05-07
**Status:** Draft — pending implementation plan

---

## Overview

The app currently lets users export labelled digit thumbnails as a local JSON download.
This spec replaces that manual flow with automatic, consent-gated upload to a Cloudflare
Worker that stores data in R2 and notifies the developer via a GitHub Issue.

The developer goal is to accumulate real-newspaper digit samples from multiple users,
retrain the recogniser periodically, and deploy an improved model.

**Immediate scope (this spec):** manual retrain workflow — collect, download, retrain,
redeploy by hand.

**Future goal (not in scope):** automated retrain pipeline triggered by the Worker
(GitHub Actions downloads from R2, runs `train_recogniser.py`, verifies accuracy against
`browser_train.json`, commits updated model on pass).

---

## What Is Removed

- `cellThumbs` field removed from session / spec state — thumbnails are no longer stored
  beyond the moment of cage-total confirmation.
- "Export Training Data" button removed from the solution screen.
- The inline training-export call in the puzzle-export flow is also removed.

---

## Components

```
Browser (GitHub Pages)
  └─ trainingUpload.ts
       ├─ consent cookie check
       ├─ consent modal (on first upload per session without cookie)
       └─ fire-and-forget POST → Worker

Cloudflare Worker  (worker/src/index.ts)
  ├─ schema validation → 400 if invalid
  ├─ R2 list check     → 429 if pending count >= MAX_PENDING_UPLOADS
  ├─ R2 PUT            → training/<ISO-timestamp>-<uuid>.json
  ├─ KV get PENDING_ISSUE
  │    ├─ absent → GitHub Issues POST + KV PUT PENDING_ISSUE (30-day TTL)
  │    └─ present → silent
  └─ 200

Cloudflare R2 bucket  (killer-sudoku-training)
  └─ one object per upload, key = training/<timestamp>-<uuid>.json

Cloudflare KV namespace  (killer-sudoku-notifications)
  └─ PENDING_ISSUE  — present means a notification issue is already open

GitHub Issues
  └─ one issue per notification window; body contains metadata + R2 key list
```

---

## Browser Changes

### Trigger point

`extractTrainingData()` is called immediately when the user confirms cage totals
(the same point where it was previously called for the local download).
The `TrainingExport` object is constructed, uploaded, then discarded — it is not
stored anywhere in session state.

### `web/src/image/trainingUpload.ts`  (new file)

Responsibilities:
- `hasConsent(): boolean` — checks for `training_consent=granted` cookie.
- `grantConsent(): void` — writes `training_consent=granted; max-age=31536000; SameSite=Strict`.
- `uploadTrainingData(data: TrainingExport): void` — fire-and-forget `fetch` POST to
  `VITE_TRAINING_WORKER_URL`. Swallows all errors silently (never blocks the UI).
  Returns immediately without awaiting; the user proceeds to the solution screen
  regardless of upload outcome.

The Worker URL is injected at build time via `VITE_TRAINING_WORKER_URL` in `.env.production`.
If the variable is absent (local dev), upload is skipped entirely.

### Consent modal

Displayed when `extractTrainingData()` is called and `hasConsent()` returns false.
The modal is non-blocking: the solution screen is unaffected regardless of the user's
choice.

```
┌─────────────────────────────────────────────────────┐
│  Help improve digit recognition                     │
│                                                     │
│  The digit images extracted from your puzzle will   │
│  be sent anonymously — 64×64 pixel thumbnails of    │
│  cage total numbers only. No puzzle layout,         │
│  personal information, or newspaper image is        │
│  included.                                          │
│                                                     │
│  [Send this time]  [Always send]  [Skip]            │
└─────────────────────────────────────────────────────┘
```

| Button | Uploads? | Cookie set? | Next puzzle |
|---|---|---|---|
| Send this time | Yes | No | Modal appears again |
| Always send | Yes | Yes (1 year) | Silent upload |
| Skip | No | No | Modal appears again |

The modal is rendered as a `<dialog>` element, styled consistently with the existing UI.

---

## Cloudflare Worker

### Directory

```
worker/
  src/
    index.ts        — fetch handler
    validate.ts     — TrainingExport schema guard
  wrangler.toml
  package.json
  tsconfig.json
```

### Request handling (`src/index.ts`)

```
POST /
  1. Reject non-POST → 405
  2. Reject non-JSON Content-Type → 400
  3. Parse body; reject malformed JSON → 400
  4. Validate schema (isTrainingExport) → 400 if invalid
  5. List R2: prefix=training/, limit=MAX_PENDING_UPLOADS+1
       count >= MAX_PENDING_UPLOADS → 429 (silent to user)
  6. R2 PUT: key=training/<exportedAt>-<uuid>.json
       customMetadata: { appVersion, puzzleType, sampleCount }
  7. KV GET: PENDING_ISSUE
       absent  → GitHub Issues POST + KV PUT (TTL = 30 days)
       present → skip
  8. Return 200
```

CORS headers must allow `https://<owner>.github.io` (and optionally `http://localhost:*`
for dev, gated on `ENVIRONMENT=development`).

### Schema validation (`src/validate.ts`)

Validates that the payload is a `TrainingExport` (version === 1, arrays present,
sampleCount matches samples.length, each sample has a `digit` 0–9 and a `pixels` array
of exactly 4096 numbers in range 0–255). Rejects anything that fails — bad data must
not reach R2.

### GitHub Issue body

```markdown
## New training data available

| Field | Value |
|---|---|
| Sample count | {sampleCount} |
| Puzzle type | {puzzleType} |
| App version | {appVersion} |
| Uploaded at | {exportedAt} |
| R2 key | `training/{timestamp}-{uuid}.json` |

To collect all pending uploads, run:
```
wrangler r2 object list killer-sudoku-training --prefix training/
```
Then download each key and pass to `train_recogniser.py`.
After retraining, clear the notification flag:
```
wrangler kv key delete --namespace-id <id> PENDING_ISSUE
```
```

### Environment variables and secrets

| Name | Kind | Description |
|---|---|---|
| `GITHUB_TOKEN` | Secret | Fine-grained PAT: `issues: write` on this repo only |
| `GITHUB_REPO` | Var | `owner/repo` string, e.g. `gbarrett28/killer-sudoku` |
| `MAX_PENDING_UPLOADS` | Var | Integer cap on R2 objects before 429; default `50` |
| `ENVIRONMENT` | Var | `production` or `development` (controls CORS) |

### `wrangler.toml` (outline)

```toml
name = "killer-sudoku-training"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "TRAINING_BUCKET"
bucket_name = "killer-sudoku-training"

[[kv_namespaces]]
binding = "NOTIFICATION_KV"
id = "<namespace-id>"

[vars]
GITHUB_REPO = "gbarrett28/killer-sudoku"
MAX_PENDING_UPLOADS = "50"
ENVIRONMENT = "production"
```

---

## Developer Workflow

### When a GitHub Issue appears

1. List all pending uploads:
   ```
   wrangler r2 object list killer-sudoku-training --prefix training/
   ```
2. Download each object:
   ```
   wrangler r2 object get killer-sudoku-training training/<key> --file <key>.json
   ```
3. Retrain:
   ```
   python web/train_recogniser.py --browser-weight 1000 --svm-c 100 \
     web/browser_train.json <key1>.json <key2>.json ...
   ```
4. Verify accuracy (existing evaluate scripts), commit updated model files.
5. Clear the notification flag so the next upload triggers a new issue:
   ```
   wrangler kv key delete --namespace-id <id> PENDING_ISSUE
   ```
6. Close the GitHub Issue.

A helper script (`scripts/collect_training.sh`) should be added to automate steps 1–2.

---

## Infrastructure Setup (one-time)

1. Create R2 bucket: `wrangler r2 bucket create killer-sudoku-training`
2. Create KV namespace: `wrangler kv namespace create killer-sudoku-notifications`
3. Add KV namespace ID to `wrangler.toml`
4. Create a fine-grained GitHub PAT with `issues: write` scoped to this repo only
5. Store PAT: `wrangler secret put GITHUB_TOKEN`
6. Add `VITE_TRAINING_WORKER_URL=https://killer-sudoku-training.<account>.workers.dev`
   to `.env.production` (not committed; injected in CI via GitHub Actions secret)
7. Add `TRAINING_WORKER_URL` as a repository secret in GitHub Actions
8. Update `.github/workflows/pages.yml` — add `env` to the Build step:
   ```yaml
   - name: Build
     working-directory: web
     env:
       VITE_TRAINING_WORKER_URL: ${{ secrets.TRAINING_WORKER_URL }}
     run: npm run build
   ```

---

## Out of Scope

- Automated retrain pipeline (future Approach C)
- Deduplication of identical samples across uploads
- Admin endpoint to clear the KV flag via HTTP (use `wrangler kv` CLI instead)
- Opt-out / data deletion mechanism (no PII is collected, so GDPR exposure is minimal;
  revisit if the app is used in the EU at scale)
