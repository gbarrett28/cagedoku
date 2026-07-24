# PCA/HOG Combination Results

Training set: 800 samples. Same-distribution holdout: 200. Cross-font holdout: 10080.
Full guardian+observer corpora, gated on PCA/HOG agreement + clean solve
(see `docs/superpowers/plans/2026-07-24-pca-hog-agreement-recogniser.md`),
balanced to 100 samples/digit (80 train / 20 holdout) across all 10 digit
classes — every class reached the full cap (800 = 10×80 exactly), so the
result below isn't skewed by any single starved class.

| Combination | Same-distribution accuracy | Cross-font accuracy |
|---|---|---|
| pca_stretch | 0.5150 | 0.3089 |
| pca_letterbox | 0.5100 | 0.4066 |
| hog_stretch | 0.4700 | 0.1603 |
| hog_letterbox | 0.5050 | 0.3142 |

## Verdict

**Winner: `pca_letterbox`** — best cross-font accuracy (0.4066, well clear of
the field) and effectively tied for best same-distribution accuracy (0.5100
vs `pca_stretch`'s 0.5150, a 0.5pp gap within noise for a 200-sample
holdout). It's the only combination that's simultaneously competitive on
both axes rather than trading one off against the other.

**HOG does not win either axis, in any geometry.** This directly answers the
question raised earlier in this investigation: Task 1's validation of the
recovered HOG model showed 99.47% accuracy on `browser_train.json`, higher
than the shipped PCA model's 98.8% on the same file — and it was flagged at
the time that this comparison was likely favorable to HOG (that file is
close to HOG's own training distribution) rather than a fair, controlled
test. This experiment is the fair test, and it doesn't support switching to
HOG: `hog_letterbox` (HOG's own native geometry) trails `pca_letterbox` on
both metrics, and `hog_stretch` is the worst combination on the board by a
wide margin on cross-font accuracy (0.1603, roughly half of every other
combination).

**Geometry matters more for HOG than for PCA.** `PcaRbfRecogniser` barely
changes between stretch (0.3089 cross-font) and letterbox (0.4066) relative
to how much `HogRecogniser` swings between stretch (0.1603) and letterbox
(0.3142) — HOG's cross-font accuracy roughly doubles just from using its
native geometry instead of PCA's. This matches a historical note from the
original HOG-vs-PCA investigation flagging that the two were never fairly
compared because they'd only ever been evaluated on their own native crop
geometry — this experiment confirms that concern was well-founded: geometry
choice is a real, separable effect, not incidental to which classifier it's
paired with.

**Cross-font accuracy is much lower than same-distribution accuracy across
the board** (roughly 10-40pp lower for every combination) — expected and not
a red flag: every combination was trained exclusively on Guardian/Observer's
two typefaces, so the cross-font holdout is a genuine out-of-distribution
test by design.

**Caveat on the absolute numbers:** 51% same-distribution accuracy is far
below the shipped PCA model's normal ~98-99% on its own training data — this
reflects the training set here being deliberately small and balanced (800
samples, 80/class) to keep the comparison fair across all four combinations
and both corpora, not that `pca_letterbox` is only marginally better than
guessing in an absolute sense. `PcaRbfRecogniser.fit`'s PCA basis is fit on
per-class *mean* images (10 means, not the raw samples), so with only ~80
samples contributing to each class mean the basis itself is likely noisier
than the shipped model's (which draws its means from tens of thousands of
samples per class). The relative ranking between combinations should be
more trustworthy than the absolute accuracy figures.

**Recommendation:** if pursuing `pca_letterbox` for production, retrain it
on a larger agreement-verified sample (not capped at 100/digit) before
drawing conclusions about deployable accuracy — this experiment answers
"which combination is best," not "how good can the best combination get."
Wiring the winning combination into the shipped TypeScript app is out of
scope for this (Python-only) plan and would be a separate follow-up.
