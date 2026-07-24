"""Renders digits from system TTF fonts as a cross-font robustness holdout.

These fonts are never used for training, only for measuring how well each
trained combination generalises to typefaces it has never seen.
"""

import matplotlib.font_manager as fm
import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw, ImageFont


def generate_cross_font_holdout(
    digits: range = range(0, 10),
    pt_sizes: tuple[int, ...] = (32, 48, 64),
) -> list[tuple[int, npt.NDArray[np.uint8]]]:
    font_paths = fm.findSystemFonts(fontext="ttf")
    samples: list[tuple[int, npt.NDArray[np.uint8]]] = []

    for font_path in font_paths:
        for pt in pt_sizes:
            for digit in digits:
                try:
                    font = ImageFont.truetype(font_path, pt)
                except Exception:  # unreadable/incompatible font files are common and expected
                    continue
                canvas = 256
                img = Image.new("L", (canvas, canvas), 0)
                draw = ImageDraw.Draw(img)
                text = str(digit)
                bbox = draw.textbbox((0, 0), text, font=font)
                w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
                if w == 0 or h == 0:
                    continue
                x = (canvas - w) // 2 - bbox[0]
                y = (canvas - h) // 2 - bbox[1]
                draw.text((x, y), text, fill=255, font=font)
                arr = np.array(img, dtype=np.uint8)
                ys, xs = np.where(arr > 0)
                if len(ys) == 0:
                    continue
                margin = 4
                y0 = max(0, int(ys.min()) - margin)
                y1 = min(arr.shape[0], int(ys.max()) + margin + 1)
                x0 = max(0, int(xs.min()) - margin)
                x1 = min(arr.shape[1], int(xs.max()) + margin + 1)
                samples.append((digit, arr[y0:y1, x0:x1]))

    return samples
