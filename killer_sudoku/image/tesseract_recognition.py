"""Tesseract-OCR-backed digit recogniser, batched via image montage.

Calling `tesseract` once per digit crop is prohibitively slow (each invocation
forks a subprocess and reloads language data). TesseractNumber instead tiles
many crops into a single canvas and issues one `image_to_data` call per batch,
then maps detected text boxes back to their originating crop by position.
"""

import math

import numpy as np
import numpy.typing as npt
import pytesseract
from PIL import Image


class TesseractNumber:
    """Digit recogniser backed by Tesseract OCR, batched via image montage.

    Attributes:
        cols: Number of crops per montage row.
        cell: Side length (pixels) each crop is resized to before tiling.
        pad: Padding (pixels) between adjacent crops and around the canvas
            edge, large enough that Tesseract does not merge neighbouring
            digits into one token.
    """

    def __init__(self, cols: int = 10, cell: int = 64, pad: int = 24) -> None:
        self.cols = cols
        self.cell = cell
        self.pad = pad

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Classify a list of digit-image crops, returning one label per crop.

        Args:
            nums: List of digit image arrays (grayscale, any size — resized to
                self.cell before tiling).

        Returns:
            Array of predicted digit labels, one per input crop. -1 where no
            digit was detected in that crop's slot.
        """
        if not nums:
            return np.array([], dtype=np.intp)

        step = self.cell + self.pad
        rows = math.ceil(len(nums) / self.cols)
        canvas_height = rows * step + self.pad
        canvas = np.full(
            (canvas_height, self.cols * step + self.pad), 255, dtype=np.uint8
        )
        slots: list[tuple[int, int, int, int]] = []
        for idx, img in enumerate(nums):
            r, c = divmod(idx, self.cols)
            y0 = self.pad + r * step
            x0 = self.pad + c * step
            resized = np.asarray(
                Image.fromarray(img).resize((self.cell, self.cell)), dtype=np.uint8
            )
            # Tesseract expects dark ink on light background.
            canvas[y0 : y0 + self.cell, x0 : x0 + self.cell] = 255 - resized
            slots.append((x0, y0, x0 + self.cell, y0 + self.cell))

        # image_to_boxes gives one box per detected *character* (not per word),
        # which matters here: image_to_data groups adjacent digits with tight
        # spacing into a single multi-character "word" token spanning several
        # slots, silently losing per-slot attribution.
        data = pytesseract.image_to_boxes(
            Image.fromarray(canvas),
            config="--psm 6 -c tessedit_char_whitelist=0123456789",
            output_type=pytesseract.Output.DICT,
        )

        labels = [-1] * len(nums)
        # image_to_boxes returns an empty dict (no keys at all) rather than a
        # dict of empty lists when nothing is detected in the whole canvas.
        for ch, left, bottom, right, top in zip(
            data.get("char", []),
            data.get("left", []),
            data.get("bottom", []),
            data.get("right", []),
            data.get("top", []),
            strict=True,
        ):
            if not ch.isdigit():
                continue
            # image_to_boxes uses a bottom-left origin (y increases upward);
            # flip to the top-left origin used by `slots`.
            cx = (left + right) // 2
            cy = canvas_height - (top + bottom) // 2
            for idx, (x0, y0, x1, y1) in enumerate(slots):
                if x0 <= cx < x1 and y0 <= cy < y1 and labels[idx] == -1:
                    labels[idx] = int(ch)
                    break

        return np.array(labels, dtype=np.intp)
