"""Tests that InpImage exposes the diagnostic attributes needed by the corpus evaluator."""

from pathlib import Path

import pytest

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.image.inp_image import InpImage

pytestmark = pytest.mark.pipeline


@pytest.fixture
def loaded_inp() -> InpImage:
    """Return an InpImage loaded from guardian/killer_sudoku_0.jpg."""
    return InpImage(Path("guardian/killer_sudoku_0.jpg"), ImagePipelineConfig(), InpImage.make_num_recogniser())


def test_ink_density_is_float_in_unit_interval(loaded_inp: InpImage) -> None:
    assert isinstance(loaded_inp.ink_density, float)
    assert 0.0 <= loaded_inp.ink_density <= 1.0


def test_fallback_used_is_bool(loaded_inp: InpImage) -> None:
    assert isinstance(loaded_inp.fallback_used, bool)


def test_total_sum_is_nonneg_int(loaded_inp: InpImage) -> None:
    assert isinstance(loaded_inp.total_sum, int)
    assert loaded_inp.total_sum >= 0


def test_connectivity_score_is_nonneg_int(loaded_inp: InpImage) -> None:
    assert isinstance(loaded_inp.connectivity_score, int)
    assert loaded_inp.connectivity_score >= 0
