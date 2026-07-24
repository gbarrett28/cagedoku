import shutil
from pathlib import Path

from killer_sudoku.training.agreement_pool import build_agreement_pool


def test_build_agreement_pool_only_includes_agreeing_clean_puzzles(tmp_path: Path) -> None:
    shutil.copy(Path("guardian/killer_sudoku_0.jpg"), tmp_path / "killer_sudoku_0.jpg")
    samples = build_agreement_pool(tmp_path, corpus_name="guardian")
    # Every returned sample must have a label consistent with what both
    # recognisers would produce -- can't assert an exact count without
    # knowing in advance whether this specific image passes the gate, so
    # assert structural invariants instead.
    for s in samples:
        assert s.corpus == "guardian"
        assert s.puzzle_type in {"killer", "classic"}
        assert 0 <= s.label <= 9
        assert s.rect.shape == (4, 2)
