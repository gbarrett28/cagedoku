"""Digit and number recognition for killer sudoku cage totals.

Two recognisers are implemented:
- NumberRecogniser: PCA + KMeans clustering used during training.
- CayenneNumber: PCA + KNN classifier used during inference.

Helper functions handle contour hierarchy traversal, digit geometry checks,
image painting, digit splitting, and perspective warping.
"""

import dataclasses
import io
import warnings
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


@dataclasses.dataclass(frozen=True)
class RBFClassifier:
    """Pure-numpy OvO RBF SVM classifier extracted from a fitted sklearn SVC.

    Implements the _Classifier protocol so it can replace sklearn SVC inside
    CayenneNumber. At inference time only numpy is required — sklearn is not
    imported.

    Fields mirror sklearn SVC internals:
        support_vectors: (n_sv, n_features) support vectors.
        dual_coef: (n_classes-1, n_sv) dual coefficients. For pair (i, j),
            row j-1 holds coefficients for class i's SVs; row i for class j's SVs.
        intercept: (n_classifiers,) bias; n_classifiers = n_classes*(n_classes-1)//2.
        n_support: (n_classes,) number of SVs per class (SVs are ordered by class).
        gamma: RBF kernel width (the actual float, post "scale" resolution).
        classes: (n_classes,) class labels (e.g. array([0,1,...,9])).
    """

    support_vectors: npt.NDArray[np.float64]
    dual_coef: npt.NDArray[np.float64]
    intercept: npt.NDArray[np.float64]
    n_support: npt.NDArray[np.intp]
    gamma: float
    classes: npt.NDArray[np.intp]

    @staticmethod
    def from_svc(svc: Any) -> "RBFClassifier":
        """Extract arrays from a fitted sklearn SVC with kernel='rbf'.

        Args:
            svc: Fitted sklearn SVC instance (must use kernel='rbf').

        Returns:
            RBFClassifier with all arrays copied from svc internals.
        """
        return RBFClassifier(
            support_vectors=np.array(svc.support_vectors_, dtype=np.float64),
            dual_coef=np.array(svc.dual_coef_, dtype=np.float64),
            intercept=np.array(svc.intercept_, dtype=np.float64),
            n_support=np.array(svc.n_support_, dtype=np.intp),
            gamma=float(svc._gamma),
            classes=np.array(svc.classes_, dtype=np.intp),
        )

    def predict(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]:
        """OvO RBF SVM prediction using pure numpy.

        Computes the RBF kernel matrix, runs a binary decision function for each
        class pair, tallies votes, and returns the class with the most votes.

        Args:
            x: (n_samples, n_features) query points.

        Returns:
            (n_samples,) predicted class labels from self.classes.
        """
        sv = self.support_vectors
        # RBF kernel: K[i,j] = exp(-gamma * ||x[i] - sv[j]||^2)
        x_sq = np.sum(x**2, axis=1, keepdims=True)  # (n, 1)
        sv_sq = np.sum(sv**2, axis=1, keepdims=True).T  # (1, n_sv)
        k = np.exp(-self.gamma * (x_sq + sv_sq - 2.0 * x @ sv.T))  # (n, n_sv)

        n_classes = len(self.classes)
        votes = np.zeros((len(x), n_classes), dtype=np.int32)
        sv_end: npt.NDArray[np.intp] = np.cumsum(self.n_support)
        sv_start: npt.NDArray[np.intp] = np.r_[np.intp(0), sv_end[:-1]]

        clf_idx = 0
        for i in range(n_classes):
            for j in range(i + 1, n_classes):
                si, ei = int(sv_start[i]), int(sv_end[i])
                sj, ej = int(sv_start[j]), int(sv_end[j])
                # Dual coef layout: row j-1 → class i's SVs; row i → class j's SVs.
                coef = np.concatenate(
                    [
                        self.dual_coef[j - 1, si:ei],
                        self.dual_coef[i, sj:ej],
                    ]
                )
                k_sub = np.concatenate([k[:, si:ei], k[:, sj:ej]], axis=1)
                decision = k_sub @ coef + self.intercept[clf_idx]
                votes[:, i] += (decision > 0).astype(np.int32)
                votes[:, j] += (decision <= 0).astype(np.int32)
                clf_idx += 1

        result: npt.NDArray[np.intp] = self.classes[np.argmax(votes, axis=1)]
        return result


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

    A valid digit bounding rect must have its centre in an even-numbered
    half-cell (first half of a cell) and have dimensions consistent with a
    digit character occupying roughly 1/8 to 1/2 of a cell.

    The centre (x + w//2, y + h//2) is used for the position check.  This
    is robust to both edges of the cell: perspective warp can place a digit's
    top-left 1-2 pixels outside the cell boundary, and a digit that barely
    straddles a cell wall will have its centre clearly inside the correct cell.
    Using the centre keeps the position check consistent with the cell
    assignment in inp_image (which uses bounding-box centre for col/row).

    Args:
        br: Bounding rect as (x, y, w, h).
        subres: Sub-resolution (pixels per cell side).

    Returns:
        True if the rect is plausibly a digit bounding box.
    """
    x, y, w, h = br
    xx = (2 * (x + w // 2)) // subres
    yy = (2 * (y + h // 2)) // subres
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

    A peak at column p within the crop is valid when both the left sub-rect
    (x, y, p, h) and the right sub-rect (x+p, y, w-p, h) pass
    contour_is_number.  Note that the right sub-rect uses x+p as its origin
    (not x) so the position check reflects the actual pixel location of the
    right digit in the warped image.

    When no valid split peak is found the whole rect is treated as a single
    digit regardless of aspect ratio.  A rect with w >= h that cannot be
    split occurs in borderline cases where pixel quantisation after perspective
    warp makes a portrait digit appear barely landscape; treating it as one
    digit is correct and resilient.

    Args:
        br: Bounding rect (x, y, w, h) of the candidate digit group.
        warped_blk: Full thresholded grid image after perspective warp.
        subres: Sub-resolution (pixels per cell side).

    Returns:
        (thumbnails, x, y) where thumbnails is a list of warped digit images
        and (x, y) is the top-left corner of the original bounding rect.

    Raises:
        ValueError: if a located split point is geometrically inconsistent
            (split position >= h or remainder >= h).
    """
    x, y, w, h = br
    ys: npt.NDArray[np.intp] = np.argmax(warped_blk[y : y + h, x : x + w], axis=0)
    peaks: npt.NDArray[np.intp]
    peaks, _ = find_peaks(ys, height=4)
    valid_peaks = [
        p
        for p in peaks.tolist()
        if contour_is_number((x, y, p, h), subres)
        and contour_is_number((x + p, y, w - p, h), subres)
    ]

    rects: list[tuple[int, int, int, int]] = []
    if len(valid_peaks) == 0:
        # No valid split found: treat the whole rect as a single digit.
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
        flat = np.array([n.flatten() for n in nums], dtype=np.float64)
        # PCA transform: centre then project — avoids sklearn version skew
        # (bare PCA() reconstructed from .npz lacks explained_variance_).
        components: npt.NDArray[np.float64] = self.pca.components_
        nums_pca: npt.NDArray[np.float64] = (flat - self.pca.mean_) @ components.T
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


def save_number_recogniser(model: CayenneNumber, path: Path) -> None:
    """Save a CayenneNumber model to a compressed .npz file.

    The model's classifier must be an RBFClassifier. All arrays — PCA
    components, RBF SVM arrays, per-digit templates, and scalar parameters —
    are stored in a single .npz file suitable for committing to the repository.

    Args:
        model: Trained CayenneNumber whose classifier is an RBFClassifier.
        path: Destination file path (should end in .npz).

    Raises:
        TypeError: if model.classifier is not an RBFClassifier.
    """
    if not isinstance(model.classifier, RBFClassifier):
        raise TypeError(
            f"save_number_recogniser requires an RBFClassifier; "
            f"got {type(model.classifier).__name__}"
        )
    rbf = model.classifier
    arrays: dict[str, Any] = {
        "pca_components": np.array(model.pca.components_, dtype=np.float64),
        "pca_mean": np.array(model.pca.mean_, dtype=np.float64),
        "dims": np.array(model.dims, dtype=np.int64),
        "rbf_support_vectors": rbf.support_vectors,
        "rbf_dual_coef": rbf.dual_coef,
        "rbf_intercept": rbf.intercept,
        "rbf_n_support": rbf.n_support.astype(np.int64),
        "rbf_gamma": np.array(rbf.gamma, dtype=np.float64),
        "rbf_classes": rbf.classes.astype(np.int64),
        "template_threshold": np.array(model.template_threshold, dtype=np.float64),
    }
    if model.templates is not None:
        for digit, tmpl in model.templates.items():
            arrays[f"template_{digit}"] = np.array(tmpl, dtype=np.float32)
    np.savez_compressed(path, **arrays)


def _load_npz(data: Any) -> CayenneNumber:
    """Reconstruct a CayenneNumber from an open NpzFile.

    Sets PCA attributes directly on a bare PCA() instance so transform()
    works without re-fitting. Reconstructs RBFClassifier from stored arrays.

    Args:
        data: Open numpy NpzFile (from np.load).

    Returns:
        CayenneNumber with RBFClassifier.
    """
    pca: PCA = PCA()
    pca.components_ = data["pca_components"]
    pca.mean_ = data["pca_mean"]
    pca.n_components_ = int(data["pca_components"].shape[0])
    pca.n_features_in_ = int(data["pca_components"].shape[1])

    rbf = RBFClassifier(
        support_vectors=data["rbf_support_vectors"].astype(np.float64),
        dual_coef=data["rbf_dual_coef"].astype(np.float64),
        intercept=data["rbf_intercept"].astype(np.float64),
        n_support=data["rbf_n_support"].astype(np.intp),
        gamma=float(data["rbf_gamma"]),
        classes=data["rbf_classes"].astype(np.intp),
    )

    templates: dict[int, npt.NDArray[np.float32]] | None = None
    template_keys = [
        k for k in data.files if k.startswith("template_") and k[9:].isdigit()
    ]
    if template_keys:
        templates = {int(k[9:]): data[k].astype(np.float32) for k in template_keys}

    return CayenneNumber(
        pca=pca,
        dims=int(data["dims"]),
        classifier=rbf,
        templates=templates,
        template_threshold=float(data["template_threshold"]),
    )


def load_number_recogniser_stream(fh: Any) -> CayenneNumber:
    """Load a CayenneNumber from a binary stream containing .npz data.

    Used by InpImage.make_num_recogniser() to load from the importlib.resources
    Traversable without requiring a filesystem path.

    Args:
        fh: Binary file-like object containing .npz data.

    Returns:
        CayenneNumber with RBFClassifier.
    """
    with np.load(io.BytesIO(fh.read())) as data:
        return _load_npz(data)


def load_number_recogniser(model_path: Path) -> CayenneNumber:
    """Load a trained CayenneNumber model from disk.

    Dispatches on file suffix:
      .npz — reconstructs RBFClassifier and PCA from arrays; sklearn not required.
      .pkl — loads via joblib and emits DeprecationWarning (migration path only).

    Args:
        model_path: Path to the model file (.npz or .pkl).

    Raises:
        ValueError: if the suffix is not .npz or .pkl.
    """
    suffix = model_path.suffix.lower()
    if suffix == ".npz":
        with np.load(model_path) as data:
            return _load_npz(data)
    if suffix == ".pkl":
        warnings.warn(
            f"Loading number recogniser from .pkl ({model_path}) is deprecated. "
            "Re-train with ks-train-numbers to produce a .npz bundle.",
            DeprecationWarning,
            stacklevel=2,
        )
        raw = joblib.load(model_path)
        if hasattr(raw, "neighbs") and not hasattr(raw, "classifier"):
            # Migrate: old model stored KNN as 'neighbs'; wrap under 'classifier'.
            raw.classifier = raw.neighbs
            raw.templates = None
            raw.template_threshold = 0.85
        result: CayenneNumber = raw
        return result
    raise ValueError(
        f"Unsupported number recogniser format: {model_path.suffix!r}. "
        "Expected .npz or .pkl."
    )


def read_classic_digits(
    warped_blk: npt.NDArray[np.uint8],
    num_recogniser: CayenneNumber,
    subres: int,
    classic_conf: npt.NDArray[np.float64],
) -> npt.NDArray[np.intp]:
    """Read pre-filled digits from the centre of each cell.

    For each cell flagged by classic_conf, extracts the central half-cell
    crop of the warped binary image, finds the largest contour, warps its
    bounding rect to canonical size, and passes it to the digit recogniser.

    Args:
        warped_blk: Warped binary image (ink=white, background=black).
        num_recogniser: Loaded digit classifier.
        subres: Pixels per cell side in warped_blk.
        classic_conf: (9, 9) array from scan_cells; > 0 means cell has a digit.

    Returns:
        (9, 9) int array of given digits (0 for empty or unrecognised cells).
    """
    half = subres // 2
    given_digits = np.zeros((9, 9), dtype=np.intp)
    for r in range(9):
        for c in range(9):
            if classic_conf[r, c] == 0.0:
                continue
            y0 = r * subres + subres // 4
            x0 = c * subres + subres // 4
            patch: npt.NDArray[np.uint8] = warped_blk[y0 : y0 + half, x0 : x0 + half]
            cnts_raw: Any
            cnts_raw, _ = cv2.findContours(
                patch, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if not cnts_raw:
                continue
            largest = max(
                (np.asarray(cnt, dtype=np.int32) for cnt in cnts_raw),
                key=cv2.contourArea,
            )
            bx, by, bw, bh = cv2.boundingRect(largest)
            if bw == 0 or bh == 0:
                continue
            ax, ay = x0 + bx, y0 + by
            rect = np.array(
                [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]],
                dtype=np.float32,
            )
            thumb = get_warp_from_rect(rect, warped_blk, res=(half, half))
            labels = num_recogniser.get_sums([thumb])
            d = int(labels[0])
            if d > 0:
                given_digits[r, c] = d
    return given_digits
