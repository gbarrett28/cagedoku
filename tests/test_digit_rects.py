import shutil
from pathlib import Path

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.training.digit_rects import locate_cage_total_rects


def test_locate_cage_total_rects_matches_production_digit_count(tmp_path: Path) -> None:
    # rework=True is required to get a non-None warped_blk (the cache-hit path
    # never recomputes it) -- copy to tmp_path first, never point rework=True
    # at the live guardian/ directory (it re-writes .jpk there).
    shutil.copy(Path("guardian/killer_sudoku_0.jpg"), tmp_path / "killer_sudoku_0.jpg")
    config = ImagePipelineConfig(puzzle_dir=tmp_path, rework=True)
    inp = InpImage(tmp_path / "killer_sudoku_0.jpg", config, InpImage.make_num_recogniser())
    assert inp.spec_error is None
    assert inp.warped_blk is not None

    rects = locate_cage_total_rects(inp.warped_blk, config.subres)
    # Every non-zero cage total's digit count should have a matching rect count;
    # cross-check the total number of rects against the sum of digit-string
    # lengths implied by the production-read cage_totals grid.
    expected_digit_count = sum(len(str(t)) for t in inp.info.cage_totals.flatten() if t > 0)
    assert len(rects) == expected_digit_count
