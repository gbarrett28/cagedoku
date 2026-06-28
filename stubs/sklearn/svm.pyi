from typing import Any

import numpy as np

class SVC:
    """Support Vector Classifier stub."""

    classes_: np.ndarray[Any, np.dtype[np.intp]]
    support_vectors_: np.ndarray[Any, np.dtype[np.float64]]
    dual_coef_: np.ndarray[Any, np.dtype[np.float64]]
    intercept_: np.ndarray[Any, np.dtype[np.float64]]
    n_support_: np.ndarray[Any, np.dtype[np.intp]]
    _gamma: float

    def __init__(
        self,
        *,
        C: float = 1.0,
        kernel: str = "rbf",
        degree: int = 3,
        gamma: str | float = "scale",
        coef0: float = 0.0,
        shrinking: bool = True,
        probability: bool = False,
        tol: float = 1e-3,
        cache_size: float = 200,
        class_weight: dict[str, float] | str | None = None,
        verbose: bool = False,
        max_iter: int = -1,
        decision_function_shape: str = "ovr",
        break_ties: bool = False,
        random_state: int | None = None,
    ) -> None: ...
    def fit(
        self,
        X: np.ndarray[Any, Any],
        y: np.ndarray[Any, Any],
        sample_weight: np.ndarray[Any, Any] | None = None,
    ) -> SVC: ...
    def predict(self, X: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]: ...
    def decision_function(self, X: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]: ...


class LinearSVC:
    """Linear Support Vector Classifier stub."""

    classes_: np.ndarray[Any, np.dtype[np.intp]]
    coef_: np.ndarray[Any, np.dtype[np.float64]]
    intercept_: np.ndarray[Any, np.dtype[np.float64]]

    def __init__(
        self,
        *,
        penalty: str = "l2",
        loss: str = "squared_hinge",
        dual: bool | str = "auto",
        tol: float = 1e-4,
        C: float = 1.0,
        multi_class: str = "ovr",
        fit_intercept: bool = True,
        intercept_scaling: float = 1,
        class_weight: dict[str, float] | str | None = None,
        verbose: int = 0,
        random_state: int | None = None,
        max_iter: int = 1000,
    ) -> None: ...
    def fit(
        self,
        X: np.ndarray[Any, Any],
        y: np.ndarray[Any, Any],
        sample_weight: np.ndarray[Any, Any] | None = None,
    ) -> LinearSVC: ...
    def predict(self, X: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]: ...
    def decision_function(self, X: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]: ...
