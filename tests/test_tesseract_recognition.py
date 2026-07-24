import shutil

import numpy as np
import numpy.typing as npt
import pytest
from PIL import Image, ImageDraw, ImageFont

from killer_sudoku.image.tesseract_recognition import TesseractNumber

pytestmark = pytest.mark.skipif(
    shutil.which("tesseract") is None, reason="tesseract binary not installed"
)


def _render_digit(digit: int, size: int = 64) -> npt.NDArray[np.uint8]:
    # Matches the real pipeline's crop convention (ink=white, background=black,
    # per read_classic_digits' docstring) — TesseractNumber.get_sums inverts
    # this to dark-ink-on-light-background internally before calling Tesseract.
    img = Image.new("L", (size, size), color=0)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=48)
    bbox = draw.textbbox((0, 0), str(digit), font=font)
    x = (size - (bbox[2] - bbox[0])) // 2 - bbox[0]
    y = (size - (bbox[3] - bbox[1])) // 2 - bbox[1]
    draw.text((x, y), str(digit), fill=255, font=font)
    return np.asarray(img, dtype=np.uint8)


def test_get_sums_reads_rendered_digits() -> None:
    digits = [1, 2, 3, 7, 9]
    crops = [_render_digit(d) for d in digits]
    recogniser = TesseractNumber()
    labels = recogniser.get_sums(crops)
    assert labels.tolist() == digits


def test_get_sums_empty_input() -> None:
    recogniser = TesseractNumber()
    labels = recogniser.get_sums([])
    assert labels.tolist() == []
