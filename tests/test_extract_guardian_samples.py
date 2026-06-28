import base64
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
import extract_guardian_samples
from extract_guardian_samples import find_digit_blobs, is_num_contour, select_digit_blobs


def test_is_num_contour_accepts_digit_sized() -> None:
    assert is_num_contour(10, 20, subres=128) is True  # w=10>=8, h=20>=16


def test_is_num_contour_rejects_too_narrow() -> None:
    assert is_num_contour(4, 10, subres=128) is False   # w=4 < 8


def test_is_num_contour_rejects_too_wide() -> None:
    assert is_num_contour(70, 10, subres=128) is False  # w=70 > 64


def test_is_num_contour_rejects_too_short() -> None:
    assert is_num_contour(20, 5, subres=128) is False   # h=5 < 16


def test_is_num_contour_rejects_degenerate_split_sliver() -> None:
    """Real failure case: observer/killer_sudoku_10.jpg col=2 row=2 total=17.
    The ink-minimum 2-digit split point landed one column before content_end,
    leaving the '7' half a 1px-wide anti-aliasing sliver, not a real glyph.
    """
    assert is_num_contour(1, 5, subres=202) is False


def test_is_num_contour_rejects_merged_two_digit_glyph() -> None:
    """Same failure case, other half: with the split point pinned almost at
    the content's right edge, the '1' half absorbed both digits of "17".
    """
    assert is_num_contour(176, 101, subres=202) is False


def test_find_digit_blobs_encodes_request_and_decodes_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_digit_blobs must base64-encode the ROI and decode the bridge's
    response without needing a real subprocess -- the real bridge behaviour
    is covered separately by the real-subprocess integration tests below.
    """
    captured = {}

    def fake_request_blobs(payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(payload)
        return {"blobs": [[1, 2, 3, 4], [10, 2, 3, 4]]}

    monkeypatch.setattr(extract_guardian_samples, "_request_blobs", fake_request_blobs)

    roi = np.zeros((20, 30), dtype=np.uint8)  # h=20, w=30
    roi[5:15, 10:20] = 255

    result = find_digit_blobs(roi, subres=128)

    assert captured["w"] == 30
    assert captured["h"] == 20
    assert captured["subres"] == 128
    assert base64.b64decode(captured["pixels"]) == roi.tobytes()
    assert result == [(1, 2, 3, 4), (10, 2, 3, 4)]


def test_find_digit_blobs_real_bridge_single_digit() -> None:
    """Integration test against the real Node bridge subprocess: a single
    digit-sized blob must be found and a thin border-bleed line excluded --
    the exact failure case is_num_contour was added to catch after the fact.
    Height must be >=16 for subres=128 (isDigitSizedContour: h >= subres>>3).
    """
    roi = np.zeros((30, 30), dtype=np.uint8)
    roi[3:23, 12:22] = 255  # 10x20 digit-sized blob
    roi[4:20, 1] = 255      # 1px-wide border-bleed line at the ROI's left margin

    blobs = find_digit_blobs(roi, subres=128)

    assert blobs == [(12, 3, 10, 20)]


def test_find_digit_blobs_real_bridge_two_separate_digits() -> None:
    """Two already-separated digit blobs must both be found and returned
    left-to-right -- the common case for a clean 2-digit cage total.
    """
    roi = np.zeros((30, 50), dtype=np.uint8)
    roi[3:23, 5:15] = 255   # left digit
    roi[3:23, 30:40] = 255  # right digit

    blobs = find_digit_blobs(roi, subres=128)

    assert blobs == [(5, 3, 10, 20), (30, 3, 10, 20)]


def test_select_digit_blobs_returns_exact_match_unchanged() -> None:
    blobs = [(14, 8, 16, 37), (35, 8, 27, 37)]
    assert select_digit_blobs(blobs, ndigits=2) == blobs


def test_select_digit_blobs_drops_lower_decoration_fragment() -> None:
    """Real case: observer/killer_sudoku_0.jpg col=5 row=7 total=14. A thick
    cage-border/underline decoration band below the digits fragmented (where
    it had a gap) into a small, digit-sized-enough blob -- shorter and lower
    in the ROI than the two real digits, which always sit at the top (that
    is exactly why the ROI is cropped to the cell's top-left quadrant).
    """
    blobs = [(0, 53, 20, 25), (14, 8, 16, 37), (35, 8, 27, 37)]
    assert select_digit_blobs(blobs, ndigits=2) == [(14, 8, 16, 37), (35, 8, 27, 37)]


def test_select_digit_blobs_resorts_by_x_after_picking_topmost() -> None:
    """The decoration fragment can land anywhere in x-order -- selection by
    y (topmost) must be followed by re-sorting the survivors by x.
    """
    blobs = [(0, 8, 10, 20), (20, 53, 10, 10), (40, 8, 10, 20)]
    assert select_digit_blobs(blobs, ndigits=2) == [(0, 8, 10, 20), (40, 8, 10, 20)]


def test_select_digit_blobs_returns_none_when_too_few() -> None:
    assert select_digit_blobs([(0, 0, 10, 20)], ndigits=2) is None
