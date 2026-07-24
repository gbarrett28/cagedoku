"""Loads the historical letterbox-HOG recogniser (git commit 99cbb70).

Used as an independent second opinion in the PCA/HOG agreement gate.
web/train_recogniser.py has HogRecogniser.save() but no load() -- this is the
missing inverse, plus a from-scratch OvO linear-SVM predictor (TS's
linearPredict/ovoVote have no Python equivalent; RBFClassifier in
killer_sudoku.image.number_recognition already covers the RBF case generically).
"""

import dataclasses
import json
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np
import numpy.typing as npt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web"))
from train_recogniser import extract_hog, extract_hole_features

from killer_sudoku.image.number_recognition import RBFClassifier


@dataclasses.dataclass(frozen=True)
class LinearOvOClassifier:
    """Pure-numpy one-vs-one linear SVM classifier (mirrors TS linearPredict/ovoVote).

    Attributes:
        coef: (n_classifiers, n_features) weight rows, one per class pair (i, j) with i < j.
        intercept: (n_classifiers,) bias per pair.
        classes: (n_classes,) class labels.
        n_classifiers: n_classes * (n_classes - 1) // 2.
        n_features: feature vector length.
    """

    coef: npt.NDArray[np.float64]
    intercept: npt.NDArray[np.float64]
    classes: npt.NDArray[np.intp]
    n_classifiers: int
    n_features: int

    def predict(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.intp]:
        n_samples = x.shape[0]
        n_classes = len(self.classes)
        votes = np.zeros((n_samples, n_classes), dtype=np.int32)
        clf_idx = 0
        for i in range(n_classes):
            for j in range(i + 1, n_classes):
                decision = x @ self.coef[clf_idx] + self.intercept[clf_idx]
                votes[:, i] += (decision > 0).astype(np.int32)
                votes[:, j] += (decision <= 0).astype(np.int32)
                clf_idx += 1
        result: npt.NDArray[np.intp] = self.classes[np.argmax(votes, axis=1)]
        return result


@dataclasses.dataclass(frozen=True)
class HOGParams:
    win_size: int
    cell_size: int
    block_size: int
    block_stride: int
    nbins: int


def load_hog_classifier(
    bin_path: Path, json_path: Path
) -> tuple[HOGParams, LinearOvOClassifier | RBFClassifier, float]:
    """Load a HOG+hole-feature model from the TS .bin/.json export format."""
    manifest = json.loads(json_path.read_text(encoding="utf-8"))
    arrays = manifest["arrays"]
    blob = bin_path.read_bytes()

    def get(name: str) -> npt.NDArray[np.generic]:
        meta = arrays[name]
        np_dtype = {"int32": np.int32, "float64": np.float64}[meta["dtype"]]
        flat = np.frombuffer(
            blob, dtype=np_dtype, count=meta["byteLength"] // np.dtype(np_dtype).itemsize,
            offset=meta["offset"],
        )
        # Scalar arrays are stored with shape [] (0-d); reshaping to that
        # produces a 0-d array that can't be indexed with [0], so scalars
        # stay flat here and callers use get_scalar() instead.
        shape = meta["shape"]
        return flat if not shape else flat.reshape(shape)

    def get_scalar(name: str) -> float:
        return float(get(name)[0])

    hog_params = HOGParams(
        win_size=int(get_scalar("hog_win_size")),
        cell_size=int(get_scalar("hog_cell_size")),
        block_size=int(get_scalar("hog_block_size")),
        block_stride=int(get_scalar("hog_block_stride")),
        nbins=int(get_scalar("hog_nbins")),
    )
    confidence_threshold = get_scalar("confidence_threshold")
    classifier_type = manifest.get("classifier_type", "rbf")

    classifier: LinearOvOClassifier | RBFClassifier
    if classifier_type == "linear":
        coef = get("linear_coef").astype(np.float64)
        classifier = LinearOvOClassifier(
            coef=coef,
            intercept=get("linear_intercept").astype(np.float64),
            classes=get("classes").astype(np.intp),
            n_classifiers=coef.shape[0],
            n_features=coef.shape[1],
        )
    else:
        classifier = RBFClassifier(
            support_vectors=get("rbf_support_vectors").astype(np.float64),
            dual_coef=get("rbf_dual_coef").astype(np.float64),
            intercept=get("rbf_intercept").astype(np.float64),
            n_support=get("rbf_n_support").astype(np.intp),
            gamma=get_scalar("rbf_gamma"),
            classes=get("classes").astype(np.intp),
        )
    return hog_params, classifier, confidence_threshold


class HogNumber:
    """NumberSource backed by the recovered historical HOG+hole-feature model."""

    def __init__(
        self,
        hog_params: HOGParams,
        classifier: LinearOvOClassifier | RBFClassifier,
        warp_fn: Callable[[npt.NDArray[np.uint8]], npt.NDArray[np.uint8]],
    ) -> None:
        self._hog_params = hog_params
        self._classifier = classifier
        self._warp_fn = warp_fn

    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        if not nums:
            return np.array([], dtype=np.intp)
        warped = np.stack([self._warp_fn(img) for img in nums])
        hog_feat = extract_hog(warped)
        hole_feat = extract_hole_features(warped)
        features = np.hstack([hog_feat, hole_feat])
        return self._classifier.predict(features)
