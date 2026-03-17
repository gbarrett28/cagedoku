"""Digit and number recognition for killer sudoku cage totals.

Two recognisers are implemented:
- NumberRecogniser: PCA + KMeans clustering used during training.
- CayenneNumber: PCA + KNN classifier used during inference.

Helper functions handle contour hierarchy traversal, digit geometry checks,
image painting, digit splitting, and perspective warping.
"""

from pathlib import Path
from typing import Any, Protocol

import cv2
import joblib  # type: ignore[import-untyped]
import numpy as np
import numpy.typing as npt
from scipy.signal import find_peaks
from sklearn.cluster import KMeans  # type: ignore[import-untyped]
from sklearn.decomposition import PCA  # type: ignore[import-untyped]

# A contour entry: (contour array, bounding rect, list of child ContourInfo).
ContourInfo = tuple[npt.NDArray[np.int32], tuple[int, int, int, int], list[Any]]


class _Classifier(Protocol):
    """Protocol for sklearn-compatible digit classifiers.

    Any object implementing predict() over a sequence of feature vectors
    satisfies this Protocol, enabling SVC, KNN, or any future classifier to
    be used interchangeably inside CayenneNumber.
    """

    def predict(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]:
        """Return predicted digit labels for each row of x."""
        ...


def contour_hier(
    chs: list[tuple[npt.NDArray[np.int32], npt.NDArray[np.int32]]],
    seen: set[int],
    i: int = 0,
) -> list[ContourInfo]:
    """Recursively build a contour hierarchy from OpenCV findContours output.

    Traverses the linked-list structure encoded in the OpenCV hierarchy array,
    visiting siblings via the next pointer and children via the child pointer.

    Args:
        chs: Zipped list of (contour, hierarchy_row) from cv2.findContours.
        seen: Set of already-visited indices (prevents double-visiting).
        i: Starting index (default 0 for the root).

    Returns:
        List of ContourInfo tuples (contour, bounding_rect, children).
    """
    if not chs:
        return []

    ret: list[ContourInfo] = []
    while i != -1:
        c, hier_row = chs[i]
        n = int(hier_row[0])
        d = int(hier_row[2])
        if i not in seen:
            children = contour_hier(chs, seen, d)
            raw_br = cv2.boundingRect(c)
            br: tuple[int, int, int, int] = (
                int(raw_br[0]),
                int(raw_br[1]),
                int(raw_br[2]),
                int(raw_br[3]),
            )
            ret.append((c, br, children))
        seen.add(i)
        i = n

    return ret


def contour_is_number(br: tuple[int, int, int, int], subres: int) -> bool:
    """Decide whether a bounding rectangle could be a digit in a cage total.

    A valid digit bounding rect must start in an even-numbered half-cell
    (to avoid cage separators) and have dimensions consistent with a digit
    character occupying roughly 1/8 to 1/2 of a cell.

    Args:
        br: Bounding rect as (x, y, w, h).
        subres: Sub-resolution (pixels per cell side).

    Returns:
        True if the rect is plausibly a digit bounding box.
    """
    x, y, w, h = br
    xx = (2 * x) // subres
    yy = (2 * y) // subres
    return (
        xx % 2 == 0
        and yy % 2 == 0
        and subres // 16 <= w < subres // 2
        and subres // 8 <= h < subres // 2
    )


def get_num_contours(chier: list[ContourInfo], subres: int) -> list[ContourInfo]:
    """Filter contour hierarchy to digit-sized contours only.

    Recursively searches for contours whose bounding rect passes
    contour_is_number. Non-matching contours are discarded but their
    children are still searched.

    Args:
        chier: Contour hierarchy (output of contour_hier).
        subres: Sub-resolution (pixels per cell side).

    Returns:
        Flat list of ContourInfo items that pass the digit size test.
    """
    ret: list[ContourInfo] = []
    for c, br, ds in chier:
        if contour_is_number(br, subres):
            ret.append((c, br, ds))
        else:
            ret += get_num_contours(ds, subres)
    return ret


def paint_mask(
    msk: npt.NDArray[np.uint8],
    ch: list[ContourInfo],
    fill: int = 255,
) -> None:
    """Paint contours and their children onto a mask, alternating fill values.

    Draws each contour filled with fill, then recurses into children with
    the inverted fill value (255 - fill), creating a hole-mask for nested
    contours (e.g. the hollow centre of a digit zero).

    Args:
        msk: Image to paint onto (modified in-place).
        ch: Contour hierarchy list.
        fill: Fill value for this level (255 for foreground, 0 for holes).
    """
    for c, _, ds in ch:
        cv2.drawContours(
            image=msk, contours=[c], contourIdx=0, color=fill, thickness=-1
        )
        paint_mask(msk, ds, fill=(255 - fill))


def get_warp_from_rect(
    rect: npt.NDArray[np.float32],
    gry: npt.NDArray[np.uint8],
    res: tuple[int, int] = (64, 64),
) -> npt.NDArray[np.uint8]:
    """Apply a perspective warp to extract a sub-region of an image.

    Warps the quadrilateral defined by rect into a rectangular output of
    size res using a perspective transform.

    Args:
        rect: (4, 2) float32 array of source corner points.
        gry: Source image (grayscale).
        res: Output size as (height, width), default (64, 64).

    Returns:
        Warped image of size res.
    """
    resy, resx = res
    dst = np.array(
        [[0, 0], [resy - 1, 0], [resy - 1, resx - 1], [0, resx - 1]], dtype=np.float32
    )
    m = cv2.getPerspectiveTransform(rect, dst)
    result: npt.NDArray[np.uint8] = np.asarray(
        cv2.warpPerspective(gry, m, res, flags=cv2.INTER_LINEAR), dtype=np.uint8
    )
    return result


def split_num(
    br: tuple[int, int, int, int],
    warped_blk: npt.NDArray[np.uint8],
    subres: int,
) -> tuple[list[npt.NDArray[np.uint8]], int, int]:
    """Split a bounding rect that may contain one or two digits.

    Uses peak detection on the column-argmax profile to find a vertical
    split point between two adjacent digits. Each resulting sub-rect is
    perspective-warped to a canonical thumbnail size.

    Args:
        br: Bounding rect (x, y, w, h) of the candidate digit group.
        warped_blk: Full thresholded grid image after perspective warp.
        subres: Sub-resolution (pixels per cell side).

    Returns:
        (thumbnails, x, y) where thumbnails is a list of warped digit images
        and (x, y) is the top-left corner of the original bounding rect.

    Raises:
        ValueError: if digit geometry is inconsistent with expected splits.
    """
    x, y, w, h = br
    ys: npt.NDArray[np.intp] = np.argmax(warped_blk[y : y + h, x : x + w], axis=0)
    peaks: npt.NDArray[np.intp]
    peaks, _ = find_peaks(ys, height=4)
    valid_peaks = [
        p
        for p in peaks.tolist()
        if contour_is_number((x, y, p, h), subres)
        and contour_is_number((x, y, w - p, h), subres)
    ]

    rects: list[tuple[int, int, int, int]] = []
    if len(valid_peaks) == 0:
        if w >= h:
            raise ValueError(
                f"Unexpected digit geometry: bounding rect {br} "
                "has w>=h with no valid split peaks"
            )
        rects.append((y, y + h, x, x + w))
    else:
        sp = valid_peaks[-1]
        if sp >= h or (w - sp) >= h:
            raise ValueError(
                f"Unexpected digit geometry: split point {sp} "
                f"invalid for bounding rect {br}"
            )
        rects.append((y, y + h, x, x + sp))
        rects.append((y, y + h, x + sp, x + w))

    half_res = subres // 2
    ret: list[npt.NDArray[np.uint8]] = []
    for yt, yb, xl, xr in rects:
        src = np.array([[xl, yt], [xr, yt], [xr, yb], [xl, yb]], dtype=np.float32)
        ret.append(get_warp_from_rect(src, warped_blk, res=(half_res, half_res)))

    return ret, x, y


def number_img(
    c: ContourInfo,
    resolution: int,
    shape: tuple[int, int] | None = None,
) -> npt.NDArray[np.float64]:
    """Render a single contour hierarchy entry to a 2D image array.

    Paints the contour (and its children) onto a blank canvas of size
    (resolution, resolution), then crops to the bounding rect. If shape
    is given, places the cropped image in the top-left of a zero array of
    that shape.

    Args:
        c: A ContourInfo tuple (contour, bounding_rect, children).
        resolution: Size of the temporary canvas (should be >= grid resolution).
        shape: Optional output shape; if None, the raw crop is returned.

    Returns:
        2D float64 array containing the rendered digit.
    """
    number: npt.NDArray[np.float64] = np.zeros((resolution, resolution))
    paint_mask(number, [c])  # type: ignore[arg-type]

    _, (x, y, w, h), _ = c
    crop: npt.NDArray[np.float64] = np.asarray(
        number[y : y + h, x : x + w], dtype=np.float64
    )
    if shape is not None:
        ret: npt.NDArray[np.float64] = np.zeros(shape, dtype=np.float64)
        ret[:h, :w] = crop
    else:
        ret = crop
    return ret


class NumberRecogniser:
    """PCA + KMeans digit clustering, used during training only.

    Fits a PCA model on digit image vectors then clusters them with KMeans.
    The cluster-to-digit assignment is determined manually after visual
    inspection of the cluster contents.
    """

    def __init__(
        self,
        allcs: list[npt.NDArray[np.uint8]],
        n_clusters: int,
    ) -> None:
        self.pca: PCA = PCA()
        self.kmeans: KMeans = KMeans(n_clusters=n_clusters, n_init=16)

        num_var: npt.NDArray[np.float64] = self.pca.fit_transform(
            [n.flatten() for n in allcs]
        )
        self.labels_: npt.NDArray[np.intp] = self.kmeans.fit_predict(num_var)
        self._num_var: npt.NDArray[np.float64] = num_var

    def get_clusters(self, sums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Predict cluster labels for a list of digit images.

        Args:
            sums: List of digit image arrays to classify.

        Returns:
            Array of cluster index labels.
        """
        result: npt.NDArray[np.intp] = self.kmeans.predict(
            self.pca.transform([s.flatten() for s in sums])
        )
        return result

    def get_sums(
        self, sums: list[npt.NDArray[np.uint8]], cl_nums: list[int]
    ) -> list[int]:
        """Map digit images to digit values using the cluster-to-digit mapping.

        Args:
            sums: List of digit image arrays.
            cl_nums: Cluster-to-digit mapping list indexed by cluster label.

        Returns:
            List of digit integers (may include -1 for unrecognised).
        """
        cls = self.get_clusters(sums)
        return [cl_nums[int(c)] for c in cls]


class CayenneNumber:
    """PCA + SVM digit classifier with optional template-matching fast path.

    Two-stage inference:
      1. Template matching (fast path): compare each digit image to stored mean
         templates using cv2.TM_CCOEFF_NORMED.  If the best match score exceeds
         template_threshold, return that digit directly.
      2. SVM (slow path): project into PCA space and classify with an SVC trained
         on the full labelled dataset.  Used only when template matching is uncertain.

    If templates is None (backward-compatible load of an older model), all images
    go directly to the classifier.

    Attributes:
        pca: Fitted PCA for dimensionality reduction.
        dims: Number of PCA dimensions to use (chosen at training time).
        classifier: Fitted sklearn-compatible classifier (SVC or legacy KNN).
        templates: Per-digit mean images (float32) for template matching, or None.
        template_threshold: Minimum TM_CCOEFF_NORMED score for the fast path.
    """

    def __init__(
        self,
        pca: PCA,
        dims: int,
        classifier: _Classifier,
        templates: dict[int, npt.NDArray[np.float32]] | None = None,
        template_threshold: float = 0.85,
    ) -> None:
        self.pca: PCA = pca
        self.dims: int = dims
        self.classifier: _Classifier = classifier
        self.templates: dict[int, npt.NDArray[np.float32]] | None = templates
        self.template_threshold: float = template_threshold

    def _classify(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Project nums into PCA space and classify with the SVM/KNN.

        Args:
            nums: Digit image arrays to classify.

        Returns:
            Array of predicted digit labels.
        """
        nums_pca: npt.NDArray[np.float64] = self.pca.transform(
            [n.flatten() for n in nums]
        )
        labels: npt.NDArray[np.intp] = self.classifier.predict(
            np.array([v[: self.dims] for v in nums_pca])
        )
        return labels

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        """Classify a list of digit images, returning digit label predictions.

        Uses template matching as a fast path when templates are available.
        Images that score below template_threshold fall through to the SVM.

        Args:
            nums: List of digit image arrays (each warped to canonical size).

        Returns:
            Array of predicted digit labels.
        """
        if not self.templates:
            return self._classify(nums)

        labels: list[int] = []
        fallback_indices: list[int] = []
        fallback_imgs: list[npt.NDArray[np.uint8]] = []

        for idx, img in enumerate(nums):
            img_f = img.astype(np.float32)
            best_score = -2.0
            best_digit = 0
            for digit, tmpl in self.templates.items():
                result: npt.NDArray[np.float32] = np.asarray(
                    cv2.matchTemplate(img_f, tmpl, cv2.TM_CCOEFF_NORMED),
                    dtype=np.float32,
                )
                score = float(np.max(result))
                if score > best_score:
                    best_score = score
                    best_digit = digit
            if best_score >= self.template_threshold:
                labels.append(best_digit)
            else:
                labels.append(-1)  # placeholder; filled below
                fallback_indices.append(idx)
                fallback_imgs.append(img)

        if fallback_imgs:
            fallback_labels = self._classify(fallback_imgs)
            for i, lbl in zip(fallback_indices, fallback_labels.tolist(), strict=True):
                labels[i] = int(lbl)

        return np.array(labels, dtype=np.intp)


def load_number_recogniser(model_path: Path) -> CayenneNumber:
    """Load a trained CayenneNumber model from disk using joblib.

    Handles migration of older models that stored a KNN under the attribute
    name 'neighbs' (pre-SVM refactor).  Those models are upgraded in-memory
    to the current CayenneNumber layout (classifier, no templates).

    Args:
        model_path: Path to the serialised CayenneNumber model file.

    Raises:
        FileNotFoundError: if model_path does not exist.
    """
    if not model_path.exists():
        raise FileNotFoundError(f"Number recogniser model not found: {model_path}")
    raw = joblib.load(model_path)
    if hasattr(raw, "neighbs") and not hasattr(raw, "classifier"):
        # Migrate: old model stored KNN as 'neighbs'; wrap it under 'classifier'.
        raw.classifier = raw.neighbs
        raw.templates = None
        raw.template_threshold = 0.85
    result: CayenneNumber = raw
    return result
