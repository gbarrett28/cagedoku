import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from extract_guardian_samples import square_pad_src, is_num_contour


def test_square_pad_src_square():
    src = square_pad_src(10, 20, 30, 30)
    np.testing.assert_allclose(src, [[10,20],[40,20],[40,50],[10,50]], atol=0.01)


def test_square_pad_src_tall():
    # bw=10, bh=30 -> side=30, cx=15, cy=35
    src = square_pad_src(10, 20, 10, 30)
    np.testing.assert_allclose(src, [[0,20],[30,20],[30,50],[0,50]], atol=0.01)


def test_square_pad_src_wide():
    # bw=30, bh=10 -> side=30, cx=25, cy=25
    src = square_pad_src(10, 20, 30, 10)
    np.testing.assert_allclose(src, [[10,10],[40,10],[40,40],[10,40]], atol=0.01)


def test_is_num_contour_accepts_digit_sized():
    assert is_num_contour(10, 20, subres=128) is True  # w=10>=8, h=20>=16


def test_is_num_contour_rejects_too_narrow():
    assert is_num_contour(4, 10, subres=128) is False   # w=4 < 8


def test_is_num_contour_rejects_too_wide():
    assert is_num_contour(70, 10, subres=128) is False  # w=70 > 64


def test_is_num_contour_rejects_too_short():
    assert is_num_contour(20, 5, subres=128) is False   # h=5 < 16
