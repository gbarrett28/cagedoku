"""Builds a manual-review tick sheet for the deployed HOG recogniser's least confident digit crops.

By default the crop pool is every classic-sudoku given-digit crop from
puzzles that failed evaluation with reason "duplicate given digits" (see
corpus.db, populated by web/scripts/evaluate-corpus.ts) -- these are real
corpus images where a misread given digit produced an impossible row/col/box
duplicate, so the wrong crop is guaranteed to be among that puzzle's givens.

Output is a self-contained HTML file: open it in a browser, click through
each crop confirming the top prediction, the runner-up, or typing the
correct digit (or "-" for a bad/non-digit crop), then click Download. Feed
the downloaded JSON back with apply_review_corrections.py, which merges it
into killer_sudoku/training/manual_label_overrides.json -- the next
train_combinations.py run picks these up automatically.
"""

import argparse
import base64
import dataclasses
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import HogRecogniser

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.training.agreement_pool import (
    _make_hog_recogniser,
    apply_manual_overrides,
    build_full_corpus_pool,
    resolve_corpus_name,
    sample_key,
)
from killer_sudoku.training.balanced_sample import balanced_split
from killer_sudoku.training.digit_rects import locate_classic_digit_rects
from killer_sudoku.training.train_combinations import train_and_evaluate

_WIN_SIZE = 64
_DISPLAY_SIZE = 256
DEFAULT_DB_PATH = Path("corpus.db")
DEFAULT_OVERRIDES_PATH = Path("killer_sudoku/training/manual_label_overrides.json")


@dataclasses.dataclass(frozen=True)
class ReviewCandidate:
    corpus: str
    source_name: str
    row: int
    col: int
    crop: npt.NDArray[np.uint8]
    current_label: int


@dataclasses.dataclass(frozen=True)
class ScoredCandidate:
    id: str
    current_label: int
    pred_label: int
    pred_second_label: int
    confidence: float
    margin: float
    # Bare base64 PNG of the RAW (unwarped) crop -- not a data: URI, since
    # this is reused both for tick-sheet display and, verbatim, as a new
    # AgreedSample.crop if the candidate ends up in the overrides file.
    crop_png_b64: str


def flagged_puzzle_paths(
    git_hash: str,
    reason: str = "duplicate given digits",
    db_path: Path = DEFAULT_DB_PATH,
) -> list[tuple[str, str, Path]]:
    """Returns flagged puzzles as (corpus, content_hash, absolute_path).

    Includes every puzzle that failed evaluation under git_hash with the
    given notSolved reason.
    """
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            """
            SELECT p.corpus, p.content_hash, p.path
            FROM evaluations e JOIN puzzles p ON e.puzzle_hash = p.content_hash
            WHERE e.git_hash = ? AND e.bucket = 'notSolved' AND e.reason = ?
            ORDER BY p.corpus, p.path
            """,
            (git_hash, reason),
        ).fetchall()
    finally:
        conn.close()
    return [(corpus, content_hash, Path(path)) for corpus, content_hash, path in rows]


def crops_from_flagged_puzzles(
    flagged: list[tuple[str, str, Path]],
) -> list[ReviewCandidate]:
    """Extracts every classic given-digit crop from each flagged puzzle image.

    Copies images into a scratch dir first -- named by content_hash rather than
    original filename -- InpImage(..., rework=True) rewrites .jpk/status.pkl
    wherever it's pointed, and these paths point directly at the live corpus
    directories; content-hash naming also sidesteps any cross-directory
    filename collisions among the flagged set.

    The corpus label on each resulting ReviewCandidate is resolved from the
    source path via agreement_pool.resolve_corpus_name, NOT taken from the
    `corpus` element of `flagged` (that comes from corpus.db, which only
    ever records "guardian"/"observer" and can't tell a classic_guardian
    puzzle from a real guardian one living in a same-named file). A puzzle
    outside every registered corpus directory (e.g.
    classic_guardian/expert/, which DEFAULT_CORPORA deliberately excludes to
    avoid filename collisions with classic_guardian/easy/) can't be turned
    into a trainable sample at all -- it's skipped, not an error.
    """
    hog = _make_hog_recogniser()
    candidates: list[ReviewCandidate] = []
    skipped_unregistered = 0
    with tempfile.TemporaryDirectory(prefix="flagged_puzzle_scratch_") as scratch:
        scratch_dir = Path(scratch)
        config = ImagePipelineConfig(puzzle_dir=scratch_dir, rework=True)
        for _corpus, content_hash, src in flagged:
            try:
                resolved_corpus = resolve_corpus_name(src)
            except ValueError:
                skipped_unregistered += 1
                continue
            dest = scratch_dir / f"{content_hash[:16]}.jpg"
            shutil.copy(src, dest)
            inp = InpImage(dest, config, hog)
            if inp.spec_error is not None or inp.warped_blk is None:
                continue
            if inp.puzzle_type != "classic" or inp.given_digits is None:
                continue
            rects = locate_classic_digit_rects(
                inp.warped_blk, config.subres, inp.given_digits > 0
            )
            for dr in rects:
                x0, y0 = float(dr.rect[:, 0].min()), float(dr.rect[:, 1].min())
                x1, y1 = float(dr.rect[:, 0].max()), float(dr.rect[:, 1].max())
                crop = np.asarray(
                    inp.warped_blk[int(y0) : int(y1), int(x0) : int(x1)], dtype=np.uint8
                )
                if crop.size == 0:
                    continue
                candidates.append(
                    ReviewCandidate(
                        corpus=resolved_corpus,
                        source_name=src.name,
                        row=dr.row,
                        col=dr.col,
                        crop=crop,
                        current_label=int(inp.given_digits[dr.row, dr.col]),
                    )
                )
    if skipped_unregistered:
        print(f"Skipped {skipped_unregistered} flagged puzzle(s) outside every registered corpus directory.")
    return candidates


def ovo_predictions(
    scores: npt.NDArray[np.float64], classes: npt.NDArray[np.int32],
) -> tuple[npt.NDArray[np.int32], npt.NDArray[np.int32], npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Reconstructs OVO vote-based predictions from sklearn's decision_function.

    `scores` is decision_function_shape="ovo" output: for i<j (class-index
    order), a positive value at pair-column (i,j) means class i's pairwise
    classifier won, negative means class j won -- this mirrors
    web/src/image/numberRecognition.ts's rbfPredictWithConfidence, which
    reimplements the same vote-counting by hand for browser inference.

    Returns (best_label, second_label, confidence, margin). confidence is
    votes[best] / (n_classes - 1) -- the same metric the deployed model uses
    to decide Recognition.confident -- but with only n_classes possible
    levels it saturates at 1.0 for the vast majority of real crops (this
    architecture hits 100% same-distribution accuracy), so it alone can't
    usefully rank "least confident" among a mostly-1.0 pool. margin is the
    raw decision_function value between the winning and runner-up class
    specifically -- a continuous secondary signal that still separates a
    razor-thin 9/9 vote sweep from a landslide one.
    """
    n_samples = scores.shape[0]
    n_classes = len(classes)
    votes = np.zeros((n_samples, n_classes), dtype=np.int32)
    pair_score = np.zeros((n_samples, n_classes, n_classes), dtype=np.float64)
    pair = 0
    for i in range(n_classes):
        for j in range(i + 1, n_classes):
            wins_i = scores[:, pair] > 0
            votes[wins_i, i] += 1
            votes[~wins_i, j] += 1
            pair_score[:, i, j] = scores[:, pair]
            pair_score[:, j, i] = -scores[:, pair]
            pair += 1

    best_idx = votes.argmax(axis=1)
    votes_wo_best = votes.copy()
    votes_wo_best[np.arange(n_samples), best_idx] = -1
    second_idx = votes_wo_best.argmax(axis=1)

    confidence = votes[np.arange(n_samples), best_idx].astype(np.float64) / (n_classes - 1)
    margin = np.abs(pair_score[np.arange(n_samples), best_idx, second_idx])
    classes_arr = np.asarray(classes)
    return classes_arr[best_idx], classes_arr[second_idx], confidence, margin


def score_candidates(
    candidates: list[tuple[str, int, npt.NDArray[np.uint8]]],
    recogniser: HogRecogniser,
    model: dict[str, Any],
) -> list[ScoredCandidate]:
    """Scores (id, current_label, crop) triples against a fitted hog_letterbox model."""
    if not candidates:
        return []
    warp_fn = recogniser.warp_from_rect
    warped = np.stack(
        [warp_fn(0, 0, c.shape[1], c.shape[0], c, _WIN_SIZE) for _, _, c in candidates]
    )
    features = recogniser.extract_features(warped)
    svc = model["clf"]
    scores = svc.decision_function(features)
    best_label, second_label, confidence, margin = ovo_predictions(scores, svc.classes_)

    predicted = svc.predict(features)
    if not np.array_equal(best_label, predicted):
        raise AssertionError(
            "OVO vote reconstruction disagrees with svc.predict() -- "
            "confidence ranking would be unreliable"
        )

    return [
        ScoredCandidate(
            id=candidates[i][0],
            current_label=candidates[i][1],
            pred_label=int(best_label[i]),
            pred_second_label=int(second_label[i]),
            confidence=float(confidence[i]),
            margin=float(margin[i]),
            # The RAW (unwarped) crop -- reused verbatim as a brand new
            # AgreedSample.crop if this candidate ends up in the manual
            # overrides file, so it must not be the letterboxed 64x64
            # version the model was scored on (that would double-warp it
            # relative to every other sample in the pool).
            crop_png_b64=_encode_png_b64(candidates[i][2]),
        )
        for i in range(len(candidates))
    ]


def least_confident(scored: list[ScoredCandidate], count: int) -> list[ScoredCandidate]:
    # confidence alone saturates at 1.0 for most real crops (see
    # ovo_predictions), so margin breaks ties among the tied-at-max items --
    # smallest margin first surfaces the genuinely razor-thin predictions.
    return sorted(scored, key=lambda c: (c.confidence, c.margin))[:count]


def fit_deployed_hog_model() -> tuple[HogRecogniser, dict[str, Any]]:
    """Refits the hog_letterbox combination exactly as train_combinations.py's main() does.

    SVC.fit is deterministic, so given the same corpus and overrides file
    this reproduces the deployed web/public/num_recogniser.bin model
    bit-for-bit.
    """
    samples = build_full_corpus_pool()
    if DEFAULT_OVERRIDES_PATH.exists():
        overrides = json.loads(DEFAULT_OVERRIDES_PATH.read_text(encoding="utf-8"))
        samples, _mismatched = apply_manual_overrides(samples, overrides)
    split = balanced_split(samples, per_digit=100, holdout_fraction=0.2, seed=0)
    train = [(s.label, s.crop) for s in split.train]
    holdout = [(s.label, s.crop) for s in split.holdout]
    _results, fitted_models = train_and_evaluate(train, holdout, [])
    recogniser, model = fitted_models["hog_letterbox"]
    if not isinstance(recogniser, HogRecogniser):
        raise TypeError(f"hog_letterbox combination fitted a {type(recogniser).__name__}, not HogRecogniser")
    return recogniser, model


def _encode_png_b64(img: npt.NDArray[np.uint8]) -> str:
    _ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_tick_sheet(items: list[ScoredCandidate]) -> str:
    items_json = json.dumps(
        [
            {
                "id": it.id,
                "currentLabel": it.current_label,
                "predLabel": it.pred_label,
                "predSecondLabel": it.pred_second_label,
                "confidence": round(it.confidence, 4),
                "margin": round(it.margin, 4),
                "image": "data:image/png;base64," + it.crop_png_b64,
            }
            for it in items
        ]
    )
    return _TEMPLATE.replace("__ITEMS_JSON__", items_json)


def write_candidates_file(items: list[ScoredCandidate], out_path: Path) -> None:
    """Writes the companion file read by apply_review_corrections.py.

    For every reviewed candidate, this carries everything needed to build a
    manual-overrides entry (identity, the label the pipeline assigned at
    review time, and the crop pixels themselves) without re-running the
    image pipeline.
    """
    payload = {
        it.id: {
            "expectedPrior": it.current_label,
            "cropPng": it.crop_png_b64,
            "puzzleType": "classic",
        }
        for it in items
    }
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Digit review tick sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 0 16px 64px; background: #fafafa; color: #111; }
  header { position: sticky; top: 0; background: #fafafa; padding: 12px 0; border-bottom: 1px solid #ddd; z-index: 1; }
  #progress { font-weight: 600; }
  button#download { padding: 6px 14px; font-weight: 600; cursor: pointer; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
  .card { border: 2px solid #ccc; border-radius: 6px; padding: 8px; background: #fff; }
  .card.done { border-color: #2e7d32; background: #f1f8f1; }
  .card img { width: 100%; height: auto; image-rendering: pixelated; border: 1px solid #eee; }
  .meta { font-size: 12px; color: #666; margin: 4px 0; }
  .row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  button.opt { border: 1px solid #999; background: #f5f5f5; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 13px; }
  button.opt.primary { flex: 1; font-weight: 600; }
  button.opt.digit { width: 28px; padding: 4px 0; }
  button.opt.chosen { background: #2e7d32; color: #fff; border-color: #2e7d32; }
  .status { font-size: 12px; color: #2e7d32; font-weight: 600; margin-top: 4px; min-height: 14px; }
</style>
</head>
<body>
<header>
  <span id="progress"></span>
  <button id="download">Download results</button>
</header>
<div id="grid"></div>
<script>
const ITEMS = __ITEMS_JSON__;
const FP = ITEMS.length + ':' + (ITEMS[0] ? ITEMS[0].id : '') + ':' + (ITEMS[ITEMS.length - 1] ? ITEMS[ITEMS.length - 1].id : '');
let answers = {};
try {
  if (localStorage.getItem('tickSheetFingerprint') === FP) {
    answers = JSON.parse(localStorage.getItem('tickSheetAnswers') || '{}');
  }
} catch (e) {}

function saveAnswers() {
  try {
    localStorage.setItem('tickSheetFingerprint', FP);
    localStorage.setItem('tickSheetAnswers', JSON.stringify(answers));
  } catch (e) {}
  updateProgress();
}

function updateProgress() {
  document.getElementById('progress').textContent = Object.keys(answers).length + ' / ' + ITEMS.length + ' answered';
}

function cardHtml(item, idx) {
  const chosen = answers[item.id];
  const optBtn = (value, label, extraClass) => {
    const isChosen = chosen !== undefined && String(chosen) === String(value);
    return '<button class="opt ' + (extraClass || '') + (isChosen ? ' chosen' : '') +
      '" data-idx="' + idx + '" data-value="' + value + '">' + label + '</button>';
  };
  let digitButtons = '';
  for (let d = 0; d <= 9; d++) digitButtons += optBtn(d, String(d), 'digit');
  digitButtons += optBtn('exclude', '-', 'digit exclude');
  return (
    '<div class="card' + (chosen !== undefined ? ' done' : '') + '" id="card-' + idx + '">' +
      '<img src="' + item.image + '" alt="digit crop">' +
      '<div class="meta">current: ' + item.currentLabel + ' &middot; conf: ' + item.confidence + ' &middot; margin: ' + item.margin + '</div>' +
      '<div class="row">' +
        optBtn(item.predLabel, 'Confirm ' + item.predLabel, 'primary') +
        optBtn(item.predSecondLabel, 'Confirm ' + item.predSecondLabel, 'primary') +
      '</div>' +
      '<div class="row digits">' + digitButtons + '</div>' +
      '<div class="status">' + (chosen !== undefined ? 'answered: ' + chosen : '') + '</div>' +
    '</div>'
  );
}

function renderAll() {
  document.getElementById('grid').innerHTML = ITEMS.map(cardHtml).join('');
  updateProgress();
}

document.getElementById('grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button.opt');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const raw = btn.dataset.value;
  const value = raw === 'exclude' ? 'exclude' : Number(raw);
  const item = ITEMS[idx];
  answers[item.id] = value;
  saveAnswers();
  document.getElementById('card-' + idx).outerHTML = cardHtml(item, idx);
});

document.getElementById('download').addEventListener('click', () => {
  const out = Object.keys(answers).map((id) => {
    const item = ITEMS.find((it) => it.id === id);
    return { id, chosen: answers[id], currentLabel: item ? item.currentLabel : null };
  });
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tick_sheet_results.json';
  a.click();
});

renderAll();
</script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument(
        "--git-hash", default=None,
        help="evaluations.git_hash (in corpus.db) to pull flagged puzzles from "
             "(default: current HEAD, matching evaluate-corpus.ts's own default)",
    )
    parser.add_argument("--reason", default="duplicate given digits")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument(
        "--out-dir", type=Path, default=Path("killer_sudoku/training/review_output"),
    )
    args = parser.parse_args()

    git_hash = args.git_hash or subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True,
    ).stdout.strip()

    print("Fitting the deployed hog_letterbox model...")
    recogniser, model = fit_deployed_hog_model()

    print(f"Finding puzzles flagged '{args.reason}' under git-hash {git_hash}...")
    flagged = flagged_puzzle_paths(git_hash, args.reason, args.db_path)
    print(f"{len(flagged)} flagged puzzles found.")
    if not flagged:
        print("Nothing to review.")
        return

    candidates = crops_from_flagged_puzzles(flagged)
    print(f"{len(candidates)} given-digit crops extracted from flagged puzzles.")

    scored = score_candidates(
        [
            (sample_key(c.corpus, c.source_name, c.row, c.col), c.current_label, c.crop)
            for c in candidates
        ],
        recogniser, model,
    )
    selected = least_confident(scored, args.count)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / "tick_sheet.html"
    out_path.write_text(render_tick_sheet(selected), encoding="utf-8")
    candidates_path = args.out_dir / "candidates.json"
    write_candidates_file(selected, candidates_path)
    print(f"Wrote {len(selected)}-item tick sheet to {out_path}")
    print(f"Wrote companion candidate data to {candidates_path}")
    print("Open the tick sheet in a browser, work through the crops, click Download, then run:")
    print(
        "  python killer_sudoku/training/apply_review_corrections.py "
        f"<downloaded.json> --candidates {candidates_path}"
    )


if __name__ == "__main__":
    main()
