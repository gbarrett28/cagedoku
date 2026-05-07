# Remote Training Data Collection — Design Spec

**Date:** 2026-05-07
**Status:** Draft — pending implementation plan

---

## Overview

The app currently lets users export labelled digit thumbnails as a local JSON download.
This spec replaces that manual flow with automatic, consent-gated upload to a Cloudflare
Worker that stores data in R2 and notifies the developer via a single persistent GitHub
Issue. Subsequent uploads add comments to the same issue rather than opening new ones.

The developer goal is to accumulate real-newspaper digit samples from multiple users,
retrain the recogniser periodically, and deploy an improved model.

**Phase 1 (this spec):** manual retrain workflow — collect from R2, retrain, redeploy
by hand.

**Phase 2 (this spec, not built first):** scheduled GitHub Actions workflow that
downloads from R2, retrains, validates accuracy, and commits the updated model
automatically.

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
       ├─ consent modal (when no cookie)
       └─ fire-and-forget POST → Worker

Cloudflare Worker  (worker/src/index.ts)
  ├─ schema validation → 400 if invalid
  ├─ R2 list check     → 429 if pending count >= MAX_PENDING_UPLOADS
  ├─ R2 PUT            → training/<exportedAt>-<uuid>.json
  └─ POST /issues/{GITHUB_ISSUE_NUMBER}/comments → 200

Cloudflare R2 bucket  (killer-sudoku-training)
  └─ one object per upload, key = training/<exportedAt>-<uuid>.json

GitHub Issues
  └─ one permanent pre-opened thread; each upload adds a comment
     processed uploads: R2 object deleted + ✅ reaction added to the comment
     issue stays open indefinitely; no KV needed
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
  7. POST /issues/{GITHUB_ISSUE_NUMBER}/comments
  8. Return 200
```

CORS headers must allow `https://<owner>.github.io` (and optionally `http://localhost:*`
for dev, gated on `ENVIRONMENT=development`).

### Schema validation (`src/validate.ts`)

Validates that the payload is a `TrainingExport` (version === 1, arrays present,
sampleCount matches samples.length, each sample has a `digit` 0–9 and a `pixels` array
of exactly 4096 numbers in range 0–255). Rejects anything that fails — bad data must
not reach R2.

### GitHub Issue — initial body

```markdown
## New training data available

| Field | Value |
|---|---|
| Sample count | {sampleCount} |
| Puzzle type  | {puzzleType} |
| App version  | {appVersion} |
| Uploaded at  | {exportedAt} |
| R2 key       | `training/{exportedAt}-{uuid}.json` |

Subsequent uploads will be added as comments on this issue.
To collect all pending uploads and retrain, see the Developer Workflow in the spec.
```

### GitHub Issue — comment body (subsequent uploads)

```markdown
**New upload** — {sampleCount} samples ({puzzleType}), app {appVersion}, {exportedAt}
R2 key: `training/{exportedAt}-{uuid}.json`
```

### Environment variables and secrets

| Name | Kind | Description |
|---|---|---|
| `GITHUB_TOKEN` | Secret | Fine-grained PAT: `issues: write` on this repo only |
| `GITHUB_REPO` | Var | `owner/repo` — `gbarrett28/cagedoku` |
| `GITHUB_ISSUE_NUMBER` | Var | Number of the pre-opened training thread issue |
| `MAX_PENDING_UPLOADS` | Var | Integer cap on R2 objects before 429; default `50` |
| `ENVIRONMENT` | Var | `production` or `development` (controls CORS) |

### `wrangler.toml` (outline)

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

---

## Phase 1 — Developer Workflow (manual)

### When the GitHub Issue gains a new comment

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
5. Delete processed R2 objects (resets the pending count for the 429 gate):
   ```
   wrangler r2 object delete killer-sudoku-training training/<key>
   ```
6. Add a ✅ reaction to each processed comment on the GitHub Issue
   (via `gh api /repos/{owner}/{repo}/issues/comments/{id}/reactions -f content='+1'`).

The issue remains open permanently. The ✅ reactions and R2 deletions are the record
that an upload has been processed. The KV key is never reset.

A helper script (`scripts/collect_training.sh`) should automate steps 1–2 and 5–6.

---

## Phase 2 — Scheduled Retrain Workflow

### Overview

A GitHub Actions workflow runs on a weekly cron schedule (and can be triggered manually
via `workflow_dispatch`). It downloads all pending R2 objects, retrains the recogniser,
validates accuracy against the existing baseline, and commits the updated model if the
accuracy check passes. On completion it closes the tracking issue and resets the KV key.

### Workflow — `.github/workflows/retrain.yml`

```
on:
  schedule: cron '0 3 * * 0'   # 03:00 UTC every Sunday
  workflow_dispatch:

steps:
  1. Checkout repo
  2. Set up Python + install dependencies (scikit-learn, numpy, etc.)
  3. Install wrangler (npm install -g wrangler)
  4. List R2 objects (prefix=training/)
       none found → exit early, no commit
  5. Download all objects to /tmp/training/
  6. python web/train_recogniser.py --browser-weight 1000 --svm-c 100
       web/browser_train.json /tmp/training/*.json
  7. python killer_sudoku/training/evaluate.py
       compare new model accuracy to baseline stored in web/browser_train.json
       regression detected → open a GitHub Issue flagging the failure, exit 1
  8. git commit web/public/num_recogniser.{json,bin}
  9. git push
 10. Merge new samples into web/browser_train.json, commit
 11. Delete processed R2 objects
 12. Add ✅ reaction to each processed comment:
       gh api /repos/gbarrett28/cagedoku/issues/comments/{id}/reactions -f content='+1'
 13. Issue stays open; no further cleanup needed
```

### Additional secrets required for Phase 2

| Name | Kind | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Repo secret | Wrangler API token (R2 + KV read/write/delete) |
| `CLOUDFLARE_ACCOUNT_ID` | Repo secret | Cloudflare account ID |

The existing `GITHUB_TOKEN` provided automatically by Actions is sufficient for git push,
issue close, and opening failure issues — no additional PAT needed.

### Accuracy baseline

`evaluate.py` compares the new model's per-digit accuracy against the scores recorded in
`web/browser_train.json` (or a separate `accuracy_baseline.json` if preferred). Any
digit whose accuracy drops by more than a configurable threshold (e.g. 2%) triggers a
regression failure.

---

## Infrastructure Setup (one-time)

1. Pre-open the permanent training thread issue in GitHub — done:
   https://github.com/gbarrett28/cagedoku/issues/1
2. Create R2 bucket: `wrangler r2 bucket create cagedoku-training`
3. Create a fine-grained GitHub PAT with `issues: write` scoped to `gbarrett28/cagedoku`
4. Store PAT as Worker secret: `wrangler secret put GITHUB_TOKEN`
5. Set `GITHUB_ISSUE_NUMBER` in `wrangler.toml` to the pre-opened issue number
6. Add `VITE_TRAINING_WORKER_URL=https://cagedoku-training.<account>.workers.dev`
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
9. *(Phase 2 only)* Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as
   repository secrets for the retrain workflow.

---

## Out of Scope

- Deduplication of identical samples across uploads
- Admin endpoint to clear the KV key via HTTP (use `wrangler kv` CLI instead)
- Opt-out / data deletion mechanism (no PII is collected, so GDPR exposure is minimal;
  revisit if the app is used in the EU at scale)
