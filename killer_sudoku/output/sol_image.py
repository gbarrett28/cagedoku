"""Solution image renderer for killer sudoku puzzles.

Provides SolImageConfig (sizing/colour parameters) and SolImage (the renderer).
SolImage draws a blank sudoku grid, cage borders, cage totals, candidate dots,
and final solution digits onto an OpenCV image array.
"""

import dataclasses

import cv2
import numpy as np
import numpy.typing as npt


@dataclasses.dataclass(frozen=True)
class SolImageConfig:
    """Size and colour parameters for the solution image.

    All pixel dimensions are derived from thin_border, diff_border, and sq_edge
    via computed properties so that changing any one value cascades consistently.
    """

    thin_border: int = 3
    diff_border: int = 3
    sq_edge: int = 128
    cage_border_color: tuple[int, int, int] = (224, 0, 0)
    number_color: tuple[int, int, int] = (0, 255, 0)
    sum_color: tuple[int, int, int] = (0, 0, 255)

    @property
    def thick_border(self) -> int:
        """Width of a thick (box-edge) border in pixels."""
        return self.thin_border + self.diff_border

    @property
    def sq_size(self) -> int:
        """Total pixel span of one cell including its thin borders."""
        return (2 * self.thin_border) + self.sq_edge

    @property
    def box_size(self) -> int:
        """Total pixel span of one 3×3 box including its thick borders."""
        return (2 * self.thick_border) + (3 * self.sq_size)

    @property
    def img_size(self) -> int:
        """Total pixel side-length of the full 9×9 solution image."""
        return 3 * self.box_size


class SolImage:
    """Renders a killer-sudoku solution as an OpenCV image.

    Coordinate convention
    ---------------------
    OpenCV's (x, y) maps to (column, row) in matrix terms.  The sudoku grid is
    indexed by (row i, col j) throughout this class.  In OpenCV rectangle calls
    the *first* point argument is (x, y) = (col-coord, row-coord), so arguments
    are passed as (col_coord, row_coord) consistently.

    Axis-swap note in draw_borders vs draw_sum / draw_number
    ---------------------------------------------------------
    draw_borders(brdrs) iterates ``for i, aux in enumerate(brdrs)`` where ``i``
    is the **row** index, so ``_sq_coord(i)`` gives the row (y) pixel and
    ``_sq_coord(j)`` gives the column (x) pixel.  Inside that method the OpenCV
    calls therefore pass ``(col_coord, row_coord)`` = ``(_sq_coord(j), _sq_coord(i))``.

    draw_sum(i, j, n) and draw_number(n, i, j) receive ``i`` as the **column**
    index and ``j`` as the **row** index (the opposite convention).  This matches
    the calling convention used in main.py and is preserved intentionally; the
    variable names ``si_c`` / ``sj_c`` in those methods reflect the swapped
    semantics.  A comment marks the swap at each call site.
    """

    def __init__(self, config: SolImageConfig | None = None) -> None:
        """Initialise a blank sudoku grid image.

        Draws a black background with white cell rectangles for all 81 cells.

        Args:
            config: Size/colour configuration.  Uses SolImageConfig defaults if None.
        """
        self._config: SolImageConfig = (
            config if config is not None else SolImageConfig()
        )
        cfg = self._config

        self.sol_img: npt.NDArray[np.uint8] = np.zeros(
            (cfg.img_size, cfg.img_size, 3), np.uint8
        )

        # Paint each of the 81 cells white.
        for bi in range(3):
            bi_c = (bi * cfg.box_size) + cfg.thick_border
            for bj in range(3):
                bj_c = (bj * cfg.box_size) + cfg.thick_border
                for si in range(3):
                    si_c = bi_c + (si * cfg.sq_size) + cfg.thin_border
                    for sj in range(3):
                        sj_c = bj_c + (sj * cfg.sq_size) + cfg.thin_border
                        cv2.rectangle(
                            self.sol_img,
                            (si_c, sj_c),
                            (si_c + cfg.sq_edge, sj_c + cfg.sq_edge),
                            (255, 255, 255),
                            -1,
                        )

    def _sq_coord(self, i: int) -> int:
        """Return the top/left pixel coordinate of cell i along one axis.

        Accounts for thick box borders and thin cell borders within each box.
        Works identically for row and column indices (the grid is square).

        Args:
            i: Cell index in [0, 8].

        Returns:
            Pixel offset of the cell's inner edge from the image origin.
        """
        cfg = self._config
        return (
            ((i // 3) * cfg.box_size)
            + cfg.thick_border
            + ((i % 3) * cfg.sq_size)
            + cfg.thin_border
        )

    def draw_borders(self, brdrs: npt.NDArray[np.bool_]) -> None:
        """Overlay cage borders on the image.

        Paints a coloured stripe along each flagged edge of every cell.

        Args:
            brdrs: Boolean array of shape (9, 9, 4).  The last dimension is
                   [up, right, down, left] — True means a cage border exists
                   on that edge of the cell.  brdrs[i][j] is row i, column j.

        Note:
            i is the row index, j is the column index.  _sq_coord(i) gives the
            row (y) pixel; _sq_coord(j) gives the column (x) pixel.
        """
        cfg = self._config
        for i, aux in enumerate(brdrs):
            # row pixel range
            row_c = self._sq_coord(i)
            row_d = row_c + cfg.sq_edge
            for j, b in enumerate(aux):
                up, right, down, left = bool(b[0]), bool(b[1]), bool(b[2]), bool(b[3])
                # column pixel range
                col_c = self._sq_coord(j)
                col_d = col_c + cfg.sq_edge
                # OpenCV (x, y) = (col, row)
                if up:
                    cv2.rectangle(
                        self.sol_img,
                        (col_c, row_c),
                        (col_d, row_c + 16),
                        cfg.cage_border_color,
                        -1,
                    )
                if right:
                    cv2.rectangle(
                        self.sol_img,
                        (col_d - 16, row_c),
                        (col_d, row_d),
                        cfg.cage_border_color,
                        -1,
                    )
                if down:
                    cv2.rectangle(
                        self.sol_img,
                        (col_c, row_d - 16),
                        (col_d, row_d),
                        cfg.cage_border_color,
                        -1,
                    )
                if left:
                    cv2.rectangle(
                        self.sol_img,
                        (col_c, row_c),
                        (col_c + 16, row_d),
                        cfg.cage_border_color,
                        -1,
                    )

    def draw_sum(self, i: int, j: int, n: int) -> None:
        """Render a cage total in the top-left corner of the cage's lead cell.

        Clears the cage-border paint behind the number before writing text.

        Args:
            i: Column index of the cell (note: swapped vs draw_borders — i is
               the column here, matching the calling convention in main.py).
            j: Row index of the cell.
            n: The cage total to display.

        Note (axis swap):
            draw_sum receives (col=i, row=j), the opposite of draw_borders
            where i is the row.  This is intentional — it matches the call
            sites in main.py.
        """
        cfg = self._config
        # i → column, j → row  (axis swap vs draw_borders)
        col_c = self._sq_coord(i)
        row_c = self._sq_coord(j)
        cv2.rectangle(
            self.sol_img,
            (col_c, row_c),
            (col_c + 64, row_c + 64),
            (255, 255, 255),
            -1,
        )
        cv2.putText(
            self.sol_img,
            str(n),
            (col_c + 4, row_c + 52),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.5,
            cfg.sum_color,
            5,
        )

    def draw_number(self, n: int, i: int, j: int) -> None:
        """Render the solved digit for a cell.

        Args:
            n: The digit (1–9) to display.
            i: Column index of the cell (note: swapped vs draw_borders — i is
               the column here, matching the calling convention in main.py).
            j: Row index of the cell.

        Note (axis swap):
            Like draw_sum, i is the column index and j is the row index here.
        """
        cfg = self._config
        # i → column, j → row  (axis swap vs draw_borders)
        col_c = self._sq_coord(i) + cfg.sq_edge - 20
        row_c = self._sq_coord(j) + 44
        cv2.putText(
            self.sol_img,
            str(n),
            (col_c, row_c),
            cv2.FONT_HERSHEY_SIMPLEX,
            3,
            cfg.number_color,
            10,
        )

    def draw_dots(self, sq_poss: npt.NDArray[np.object_]) -> None:
        """Render candidate-possibility dots for unsolved cells.

        For each unsolved cell (more than one candidate remaining) draws a 3×3
        grid of small circles, one per digit 1–9.  A circle is green if that
        digit is still possible, black otherwise.

        Args:
            sq_poss: Object array of shape (9, 9) where each element is a
                     set[int] of the remaining candidate digits for that cell.
        """
        fr = 24  # spacing between dot centres in pixels
        for i in range(9):
            bi = self._sq_coord(i) + 64
            for j in range(9):
                if len(sq_poss[i][j]) > 1:
                    bj = self._sq_coord(j) + 32
                    for num in range(1, 10):
                        gr = 255 if num in sq_poss[i][j] else 0
                        px = bi + (fr * ((num - 1) // 3))
                        py = bj + (fr * ((num - 1) % 3))
                        cv2.circle(self.sol_img, (py, px), 6, (0, gr, 0), thickness=-1)
