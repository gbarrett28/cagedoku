"""Build a manual-review tick sheet from production duplicate-conflict crops.

The browser evaluator identifies conflicting given digits and stores the exact
raw bounding-box crop selected from the warped grid. This tool only curates
labels: it does not rerun OCR, fit a recogniser, or derive conflicts. The
companion candidate file preserves each raw crop and its source rectangle for
the training pipeline.
"""

import argparse
import base64
import dataclasses
import json
import sqlite3
import subprocess
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt

DEFAULT_DB_PATH = Path("corpus.db")


DEFAULT_CORPORA: list[tuple[str, Path]] = [
    ("guardian", Path("guardian")),
    ("observer", Path("observer")),
    ("classic_guardian", Path("classic_guardian/easy")),
    ("classic_observer", Path("classic_observer")),
]


def resolve_corpus_name(
    path: Path,
    corpora: list[tuple[str, Path]] = DEFAULT_CORPORA,
) -> str:
    """Map a source image path to its corpus name by directory."""
    resolved = path.resolve().parent
    for name, corpus_dir in corpora:
        if resolved == corpus_dir.resolve():
            return name
    raise ValueError(f"{path} is not under any registered corpus directory")


def sample_key(corpus: str, source_name: str, row: int, col: int) -> str:
    """Return the stable manual-review identifier for a corpus cell."""
    return f"{corpus}|{source_name}|{row}|{col}"


@dataclasses.dataclass(frozen=True)
class ReviewCandidate:
    corpus: str
    source_name: str
    row: int
    col: int
    source_rect: tuple[int, int, int, int]
    crop: npt.NDArray[np.uint8]
    current_label: int


@dataclasses.dataclass(frozen=True)
class ReviewItem:
    id: str
    current_label: int
    source_rect: tuple[int, int, int, int]
    crop: npt.NDArray[np.uint8]
    conflict_descs: tuple[str, ...]


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


def _given_digit_reads_for_flagged(
    flagged: list[tuple[str, str, Path]],
    git_hash: str,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[tuple[str, Path, list[sqlite3.Row]]]:
    """Read cached raw given-digit rows for flagged puzzles.

    Rows without strategy-neutral source pixels are historical and cannot
    produce a reusable manual override, so they are skipped.
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    results: list[tuple[str, Path, list[sqlite3.Row]]] = []
    skipped_unregistered = 0
    try:
        for _corpus, content_hash, src in flagged:
            try:
                resolved_corpus = resolve_corpus_name(src)
            except ValueError:
                skipped_unregistered += 1
                continue
            rows = conn.execute(
                """
                SELECT row, col, predicted_label, clashes_with,
                       source_x, source_y, source_width, source_height, source_pixels
                FROM cell_reads
                WHERE puzzle_hash = ? AND git_hash = ? AND cell_type = 'given_digit'
                  AND source_pixels IS NOT NULL
                """,
                (content_hash, git_hash),
            ).fetchall()
            if rows:
                results.append((resolved_corpus, src, rows))
    finally:
        conn.close()
    if skipped_unregistered:
        print(f"Skipped {skipped_unregistered} flagged puzzle(s) outside every registered corpus directory.")
    return results


def _crop_from_row(row: sqlite3.Row) -> npt.NDArray[np.uint8]:
    width = int(row["source_width"])
    height = int(row["source_height"])
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid source crop dimensions: {width}x{height}")
    pixels = bytes(row["source_pixels"])
    if len(pixels) != width * height:
        raise ValueError(
            f"Raw source crop has {len(pixels)} bytes, expected {width * height} for {width}x{height}"
        )
    return np.frombuffer(pixels, dtype=np.uint8).reshape(height, width).copy()


def crops_from_duplicate_conflicts(
    flagged: list[tuple[str, str, Path]],
    git_hash: str,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[tuple[ReviewCandidate, list[str]]]:
    """Return only raw given-digit crops involved in duplicate conflicts."""
    out: list[tuple[ReviewCandidate, list[str]]] = []
    for corpus, src, rows in _given_digit_reads_for_flagged(flagged, git_hash, db_path):
        for row in rows:
            clashes = json.loads(row["clashes_with"])
            if not clashes:
                continue
            width = int(row["source_width"])
            height = int(row["source_height"])
            candidate = ReviewCandidate(
                corpus=corpus,
                source_name=src.name,
                row=int(row["row"]),
                col=int(row["col"]),
                source_rect=(int(row["source_x"]), int(row["source_y"]), width, height),
                crop=_crop_from_row(row),
                current_label=int(row["predicted_label"]),
            )
            descs = [f"clashes with r{clash['row'] + 1}c{clash['col'] + 1}" for clash in clashes]
            out.append((candidate, descs))
    out.sort(key=lambda pair: tuple(sorted(pair[1])))
    return out


def build_review_items(
    pairs: list[tuple[ReviewCandidate, list[str]]],
    count: int,
) -> list[ReviewItem]:
    """Convert raw conflict crops to the bounded set rendered for review."""
    return [
        ReviewItem(
            id=sample_key(candidate.corpus, candidate.source_name, candidate.row, candidate.col),
            current_label=candidate.current_label,
            source_rect=candidate.source_rect,
            crop=candidate.crop,
            conflict_descs=tuple(descs),
        )
        for candidate, descs in pairs[: max(count, 0)]
    ]


def _encode_png_b64(img: npt.NDArray[np.uint8]) -> str:
    _ok, buf = cv2.imencode(".png", img)
    return base64.b64encode(buf.tobytes()).decode("ascii")


def render_tick_sheet(items: list[ReviewItem]) -> str:
    items_json = json.dumps(
        [
            {
                "id": item.id,
                "currentLabel": item.current_label,
                "sourceWidth": item.source_rect[2],
                "sourceHeight": item.source_rect[3],
                "conflictDescs": list(item.conflict_descs),
                "image": "data:image/png;base64," + _encode_png_b64(item.crop),
            }
            for item in items
        ]
    )
    return _TEMPLATE.replace("__ITEMS_JSON__", items_json)


def write_candidates_file(items: list[ReviewItem], out_path: Path) -> None:
    """Write raw crop evidence and geometry for apply_review_corrections.py."""
    payload = {}
    for item in items:
        source_x, source_y, source_width, source_height = item.source_rect
        payload[item.id] = {
            "expectedPrior": item.current_label,
            "cropPng": _encode_png_b64(item.crop),
            "sourceRect": {
                "x": source_x,
                "y": source_y,
                "width": source_width,
                "height": source_height,
            },
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "puzzleType": "classic",
            "conflictDescs": list(item.conflict_descs),
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
  .meta.conflict { color: #c0392b; font-weight: 600; }
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
      '<div class="meta">current: ' + item.currentLabel + ' &middot; raw: ' + item.sourceWidth + '&times;' + item.sourceHeight + '</div>' +
      (item.conflictDescs && item.conflictDescs.length ? '<div class="meta conflict">' + item.conflictDescs.join('; ') + '</div>' : '') +
      '<div class="row">' +
        optBtn(item.currentLabel, 'Confirm ' + item.currentLabel, 'primary') +
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
        "--git-hash",
        default=None,
        help="evaluations.git_hash to review (default: current HEAD)",
    )
    parser.add_argument("--reason", default="duplicate given digits")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("killer_sudoku/training/review_output"),
    )
    args = parser.parse_args()

    git_hash = args.git_hash or subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    print(f"Finding puzzles flagged '{args.reason}' under git-hash {git_hash}...")
    flagged = flagged_puzzle_paths(git_hash, args.reason, args.db_path)
    print(f"{len(flagged)} flagged puzzles found.")
    if not flagged:
        print("Nothing to review.")
        return

    pairs = crops_from_duplicate_conflicts(flagged, git_hash, args.db_path)
    print(f"{len(pairs)} raw given-digit crops involved in a duplicate-digit conflict.")
    selected = build_review_items(pairs, args.count)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / "tick_sheet.html"
    out_path.write_text(render_tick_sheet(selected), encoding="utf-8")
    candidates_path = args.out_dir / "candidates.json"
    write_candidates_file(selected, candidates_path)
    print(f"Wrote {len(selected)}-item tick sheet to {out_path}")
    print(f"Wrote companion candidate data to {candidates_path}")
    print("Open the tick sheet, review the crops, click Download, then run:")
    print(
        "  python killer_sudoku/training/apply_review_corrections.py "
        f"<downloaded.json> --candidates {candidates_path}"
    )


if __name__ == "__main__":
    main()
