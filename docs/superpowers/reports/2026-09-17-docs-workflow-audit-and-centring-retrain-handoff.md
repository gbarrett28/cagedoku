# Docs/Workflow Audit and Digit-Recogniser Centring Retrain — Handoff

**Repo:** `gbarrett28/cagedoku`
**Branch:** `claude/docs-workflow-inconsistencies-b6lf5q` (pushed to origin, not merged)
**Working tree:** clean as of the last check on this branch — no uncommitted experiment artifacts

## Commits on the branch (oldest → newest, on top of `86f0efe`)

1. `e618c52` — docs: fix stale workflow-trigger and infra descriptions
2. `2080750` — fix: sync `--recognition-input-mode` default with the deployed model
3. `6af4814` — fix: sync `--class-mean-residual-components` default with the deployed model
4. `cad47a0` — docs: fix stale `letterbox-centered` deploy claim in `image-pipeline.md`

---

## Part 1: Docs + CI workflow audit (done)

Fixed real inconsistencies in `docs/architecture.md`, `docs/python-scripts-inventory.md`, `CLAUDE.md`/`AGENTS.md`:

- `retrain.yml` was documented as running "every 8 hours" — actually `workflow_dispatch`-only since its schedule was disabled 2026-07-30 (after an unmonitored run shipped a bad model). Also opens a PR now instead of pushing to master.
- `puzzle-spec-review.yml` was documented as manual-only — actually runs on an 8-hourly schedule.
- Infrastructure secrets table was missing `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, listed a stale `CLOUDFLARE_ACCOUNT_ID` (actually hardcoded in `worker-deploy.yml`, not a secret).
- `CLAUDE.md`/`AGENTS.md` codebase map was missing the `worker/` (Cloudflare Worker) subsystem.

**Live CI problem found (unresolved, not fixable from a Claude Code session):** `puzzle-spec-review.yml` and `rule-regression.yml` fail on every scheduled run with R2 `AccessDenied` (ListObjectsV2/DeleteObject). Bisected to a specific window (2026-08-08 16:30 → 2026-08-09 01:35 UTC) against the *same commit* — proof it's an external Cloudflare R2 token/permission change, not a code regression. Needs a fix in the Cloudflare R2 dashboard (token scope/rotation), outside any Claude Code session's reach, local or remote.

---

## Part 2: Digit recogniser retrain investigation (active)

Started from: "run the digit retrainer by hand, first check it's up to date with the recent greyscale digit recogniser" (the 2026-08-20 deploy, commit `68dfe0d`).

### Bug 1 (fixed, committed)

`web/train_recogniser.py --recognition-input-mode` hardcoded default `"binary"` while the deployed model is `"gray"`. Added `deployed_recognition_input_mode()` (mirrors the existing `deployed_warp_strategy()` pattern) and wired it as the default.

### Bug 2 (fixed, committed)

`--class-mean-residual-components` hardcoded default `-1` (disabled → 39-feature basis) while the deployed model uses 50 residual components (89-feature basis, per `docs/image-pipeline.md`'s "Cluster-mean PCA recogniser" section). Added `deployed_class_mean_residual_components()`, same pattern.

### Residual gap found (unresolved)

Even after both fixes, a retrain using byte-identical `corpus_train.json`/`manual_label_overrides.json` and byte-identical code (all RNG seeded, fully deterministic) still underperforms the deployed model specifically on digit 0 (91% vs ~99.75%, all other digits 100%). Leading theory: unpinned system fonts (used for synthetic sample generation) differ between the environment this was investigated in and whatever trained the deployed model — untested/unconfirmed.

### Tested and rejected: `--no-synthetic --dither 0`

Scored 100% on the in-repo `numberRecognition.test.ts` corpus check, but that check evaluates against `corpus_train.json` itself — the exact file just trained on — so 100% there is memorization, not generalization. Confirmed by testing against 3 real user-uploaded PDF puzzles (not in the training corpus): this config produced the **worst** result of everything tested — all 3 puzzles hit the hard failure mode ("each cage needs exactly one total in its valid range"). Reverted.

### Centring investigation (the live thread)

- The deployed model uses plain `letterbox` (no centring). Confirmed a real doc bug in `docs/image-pipeline.md` (self-contradicted on this point) — fixed and committed.
- Git-history trace: `letterbox-centered` (deterministic ink-mass centring, "to avoid a degree of freedom") was deployed 2026-07-31 → 2026-08-20. On 2026-08-20 (`68dfe0d`), both the deployed model **and** `corpus_train.json`'s cached pixels were switched to plain `letterbox` in one coordinated change. The design/plan docs specifying centring were deleted the same day (`de9be9d`, "docs: retire completed greyscale design") **without ever recording why centring was dropped** — no reasoning trail anywhere in the repo. No commit in that whole work-stream carries a Claude/Codex attribution trailer (unlike several other interleaved commits from the same window), so who/what made that call is undetermined from the repo alone.
- Tried to re-test centring directly: **blocked**. `corpus_train.json`'s 4000 samples (including all 400 digit-0 ones) are all pre-baked/canonical, tagged `warpStrategy: "letterbox"`, with no raw crop fields — requesting `letterbox-centered` just excludes them (confirmed: only 1291/4819 merged samples survived, **zero** digit-0 samples).
- Raw crops needed for a proper centred retrain live in `corpus.db`'s `cell_reads.source_pixels`/`gray_pixels` columns (per `docs/corpus-db.md`) — but `corpus.db` and the puzzle-image corpus needed to regenerate it were not available in the cloud sandbox this investigation ran in. R2 credentials for pulling telemetry were also absent there (and independently confirmed broken for 2 of 3 CI workflows — worth re-verifying they still work at all).
- **Decision:** continue this work locally, at `C:\Users\geoff\PycharmProjects\killer_sudoku`, which has real access to `corpus.db` and the puzzle corpus.

---

## Next steps (local)

1. `git fetch origin claude/docs-workflow-inconsistencies-b6lf5q && git checkout claude/docs-workflow-inconsistencies-b6lf5q`
2. Rebuild `corpus_train.json` from `corpus.db`'s raw `cell_reads.source_pixels`/`gray_pixels`, warped with `letterbox-centered` — same approach as commit `bcff761` ("rebuild corpus_train.json from source_pixels with centered warping"); check that commit for the exact export script/approach used.
3. Retrain matching the original (deleted) plan's Step 2 exactly:
   ```
   python web/train_recogniser.py --recogniser pca --browser-weight 1000 --warp-strategy letterbox-centered --no-synthetic --dither 0
   ```
4. Validate: `npx vitest run src/image/numberRecognition.test.ts` (check digit-0 accuracy specifically), `npx vite-node scripts/regen-failure-hashes.ts` once satisfied, and ideally the real gate — build + `evaluate-corpus.ts` against `eval-fixtures/`/`eval-baseline.json` (not runnable from the cloud sandbox this investigation ran in).
5. If folding in R2 telemetry (`training/` prefix via `scripts/_r2_list.py`/`_r2_download.py`): verify `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` actually work first, given the confirmed `AccessDenied` failures elsewhere.
6. Commit any model change to the same branch (not merge) for review, following the pattern already established — bronze gate (`bash scripts/run-bronze-gate.sh`) required before each commit, per the repo's pre-commit hook.
