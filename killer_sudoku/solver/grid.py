"""Shared error type for the image-processing -> solver boundary.

The rest of this file (Grid, GridConfig, the row/col/box helpers) held the
legacy Python solver -- both the constraint/equation-based Grid.solve() and
the rule-engine-based Grid.engine_solve() -- retired in favour of routing
every solve through the real TypeScript engine via
killer_sudoku.training.ts_bridge.solve(). ProcessingError stays here: it's
an image-pipeline error (not solver-specific -- see its own docstring), and
killer_sudoku/image/inp_image.py and validation.py depend on it.
"""

import numpy as np
import numpy.typing as npt


class ProcessingError(Exception):
    """Raised when image-processing produces an inconsistent cage layout.

    Attributes:
        msg: Human-readable description of the inconsistency.
        regions: The partially-assigned region array at the time of failure.
        brdrs: The border array passed to set_up.
    """

    def __init__(
        self,
        msg: str,
        regions: npt.NDArray[np.intp],
        brdrs: npt.NDArray[np.bool_],
    ) -> None:
        super().__init__(msg)
        self.msg: str = msg
        self.regions: npt.NDArray[np.intp] = regions
        self.brdrs: npt.NDArray[np.bool_] = brdrs
