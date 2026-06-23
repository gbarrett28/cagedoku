import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from extract_guardian_samples import is_num_contour


def test_is_num_contour_accepts_digit_sized():
    assert is_num_contour(10, 20, subres=128) is True  # w=10>=8, h=20>=16


def test_is_num_contour_rejects_too_narrow():
    assert is_num_contour(4, 10, subres=128) is False   # w=4 < 8


def test_is_num_contour_rejects_too_wide():
    assert is_num_contour(70, 10, subres=128) is False  # w=70 > 64


def test_is_num_contour_rejects_too_short():
    assert is_num_contour(20, 5, subres=128) is False   # h=5 < 16
