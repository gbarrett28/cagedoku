from typing import Any

import numpy as np
import numpy.typing as npt

class PCA:
    components_: np.ndarray[Any, np.dtype[np.float64]]
    explained_variance_: np.ndarray[Any, np.dtype[np.float64]]
    explained_variance_ratio_: np.ndarray[Any, np.dtype[np.float64]]
    n_components_: int
    # Fitted attributes (present after fit/fit_transform)
    mean_: np.ndarray[Any, np.dtype[np.float64]]
    n_features_in_: int

    def __init__(
        self,
        n_components: int | float | str | None = None,
        *,
        copy: bool = True,
        whiten: bool = False,
        svd_solver: str = "auto",
        tol: float = 0.0,
        iterated_power: int | str = "auto",
        random_state: int | None = None,
    ) -> None: ...
    def fit(self, X: npt.ArrayLike, y: None = None) -> PCA: ...
    def fit_transform(self, X: npt.ArrayLike, y: None = None) -> np.ndarray[Any, Any]: ...
    def transform(self, X: npt.ArrayLike) -> np.ndarray[Any, Any]: ...
    def inverse_transform(self, X: npt.ArrayLike) -> np.ndarray[Any, Any]: ...
