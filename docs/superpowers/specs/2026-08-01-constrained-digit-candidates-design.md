# Constrained Digit Candidates — Design

## Motivation

The digit recogniser currently classifies every crop — given (classic) clue digits and
killer cage-total digits alike — against the full 0-9 label space, then relies entirely
on post-hoc validation (`validateCageLayout`'s cage-sum range check) to catch structurally
impossible results after the fact. But the constraints that make a result "structurally
impossible" are almost always known *before* classification runs:

- A classic given digit is never 0.
- A killer cage's total must fall within `cageSumRange(cageSize)` (`web/src/engine/types.ts`),
  and cage size is known from border detection, which already runs before cage totals are
  read (`buildCageTotals` in `web/src/image/inpImage.ts` already receives border info).
- The number of digits in a total (1 or 2) is known from crop/contour geometry, independent
  of what those digits turn out to be.

This session's investigation into residual PCA-recogniser failures found several cases
where the correct label was structurally excluded from possibility (a "0" total-digit
crop, or a given-digit crop that's never actually 0) but the recogniser still considered
it as a candidate, occasionally losing to a visually similar but structurally-impossible
digit. Restricting the candidate label set per crop *before* classification, rather than
validating the reconstructed total *after*, removes those wrong answers from being
possible at all — and, done properly, also reduces work: fewer templates to compare in
the template-match fast path, and fewer classes (hence fewer pairwise comparisons and
kernel evaluations) in the RBF fallback.

## Architecture

Thread an optional per-crop candidate-restriction parameter through the existing
recognition call chain. No new pipeline stages, no reordering — cage/border detection
already precedes cage-total reading today.

```
PcaRecogniser.recognise(imgs: Uint8Array[], allowedLabels?: (ReadonlySet<number> | undefined)[])
```

`allowedLabels`, when provided, is parallel to `imgs` — one entry per crop.
`undefined` (either the whole parameter, or an individual entry) means "unrestricted",
so every existing caller (tests, any future caller that doesn't have restriction context)
keeps working unchanged with no behavioural difference.

Restriction changes which labels are *eligible to win*, not how scores/votes are
computed for eligible labels:

- **Template-match fast path**: skip templates whose label isn't in the crop's allowed
  set, for both the best-match search and the margin (runner-up) search.
- **RBF fallback**: restrict the classifier itself to the crop's allowed classes —
  skip kernel evaluations against disallowed classes' support vectors, and only run
  pairwise comparisons between pairs of allowed classes. This is not just an
  optimization: it's also more correct, since a sample's vote count for an allowed
  class no longer gets diluted by pairwise comparisons against classes we already know
  are structurally impossible.

## New components

1. **`computeCageSizes(borderX: boolean[][], borderY: boolean[][]): number[][]`**
   (`web/src/image/validation.ts`, exported) — a `(9×9)` grid of cage sizes, one per
   cell. Extracted from the union-find cage-membership logic currently inlined in
   `validateCageLayout`; `validateCageLayout` is refactored to call it too, removing
   the duplication rather than leaving two copies.

2. **`allowedDigitsForPosition(cageSize: number, digitIndex: number, digitCount: number): ReadonlySet<number>`**
   (new, likely `web/src/image/numberRecognition.ts` alongside the other cage-total
   reading logic) — a pure function using `cageSumRange(cageSize)` to enumerate every
   valid total for that cage size with exactly `digitCount` digits, then collect which
   digit can appear at `digitIndex` (0 = tens/only digit, 1 = units) across that set.

3. **`buildCageTotals`** (`web/src/image/inpImage.ts`) gains a `cageSizes: number[][]`
   parameter. Its caller (`parsePuzzleImage`) computes `cageSizes` once via
   `computeCageSizes`, from the same `bestBorderX`/`bestBorderY` already in scope
   where `brdrs` is built today. Inside the per-cell loop, before calling
   `recognise(sums)`, build `allowedLabels` from `allowedDigitsForPosition` for each
   crop in `sums` and pass it through — `digitCount` is simply `sums.length` (1 or 2),
   already known at this call site with no new detection logic required.

4. **`readClassicDigits`** passes a fixed single-entry restriction
   (`[new Set([1,2,3,4,5,6,7,8,9])]`) to its single-crop `recognise()` call — no cage
   context needed, given digits are unconditionally 1-9.

5. **`ovoVote` / `rbfPredictWithConfidence`** (`numberRecognition.ts`) gain an optional
   per-sample allowed-classes parameter. When present for a given sample, that sample's
   kernel evaluations and pairwise comparisons are computed only against/among its
   allowed classes, rather than the full class set with post-hoc filtering. RBF-fallback
   batches in this codebase are always small (0-2 crops per cell), so when any
   restriction is present in a batch, samples are processed against their own reduced
   support-vector/pair set rather than sharing one all-classes computation across the
   batch — simple and correct, with no meaningful loss of batching efficiency at this
   scale.

6. **`HogRecogniser.recognise()`** accepts the same `allowedLabels` parameter (required
   by the shared `NumRecogniser` abstract signature) but ignores it — `HogRecogniser` is
   not deployed (superseded by `PcaRecogniser`, see `project_digit_recogniser_investigation`
   history) and doesn't warrant restriction-logic investment. It stays trivially
   type-correct without behaviour change.

## Data flow

Unchanged pipeline order. `parsePuzzleImage` already detects borders before calling
`buildCageTotals`; it now also derives `cageSizes` from those same borders (via
`computeCageSizes`) and passes it alongside the existing `brdrs` parameter.
`readClassicDigits` needs no new inputs — its restriction is a fixed constant.

## Safety and edge cases

- **The true answer is always inside a correctly-computed restriction.** A cage's real
  total structurally must fall in `cageSumRange(cageSize)` by the rules of killer
  sudoku; a real clue digit is never 0. Restricting to structurally-valid candidates
  cannot exclude a correct answer, given correct upstream cage-size/border detection.
- **If border detection is itself wrong**, the derived `cageSizes` (hence the
  restriction) could be wrong, and restriction could now exclude the true digit —
  a new way for a border-detection bug to affect digit reading, where previously the
  two were more independent. In practice this doesn't add a new *undetected* failure
  class: a wrong cage size already breaks the existing post-hoc `validateCageLayout`
  check regardless, so the failure still surfaces as `notSolved` — it may simply
  surface via a different symptom (a garbled total) than before (a range-violation
  error). This is validated empirically via full-corpus evaluation, per this session's
  established practice, before considering the change safe to ship.
- **Restriction sets are never empty by construction** — `cageSumRange` and the
  given-digit `{1..9}` set are non-empty for every valid cage size (1-9) and digit
  position.

## Testing

- Unit tests for `computeCageSizes` and `allowedDigitsForPosition`, exhaustive over
  cage sizes 1-9 and both digit positions (small, pure, easy to test completely).
- Extend `numberRecognition.test.ts` to cover restricted template-match and restricted
  RBF-fallback behaviour, including the "restriction changes the winner" case (a crop
  whose unrestricted top pick is disallowed).
- Full corpus re-evaluation (`evaluate-corpus.ts`) before/after, comparing clean rate
  and checking for zero regressions, matching the rigor already established this
  session for the template-threshold fix.

## Non-goals

- **No joint multi-digit decoding.** Each crop in a multi-digit total is still
  classified independently (with its own restricted candidate set) — no combined
  scoring across a total's digit positions. Per-position restriction already captures
  most of the benefit; any residual invalid combination is still caught by the
  existing post-hoc `validateCageLayout` check.
- **No HogRecogniser restriction logic** (see component 6).
- **No change to the template-match threshold/margin values** (`tau=0.74`,
  `margin=0.04`) shipped earlier this session — this is an orthogonal improvement.
