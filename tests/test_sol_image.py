"""Tests for killer_sudoku.output.sol_image."""

import numpy as np

from killer_sudoku.output.sol_image import SolImage, SolImageConfig

# ---------------------------------------------------------------------------
# SolImage construction
# ---------------------------------------------------------------------------


def test_sol_image_default_size() -> None:
    """SolImage() creates an image with the expected default dimensions."""
    cfg = SolImageConfig()
    img = SolImage()
    assert img.sol_img.shape == (cfg.img_size, cfg.img_size, 3)


def test_sol_image_dtype() -> None:
    """SolImage().sol_img has dtype uint8."""
    img = SolImage()
    assert img.sol_img.dtype == np.uint8


def test_sol_image_custom_config() -> None:
    """A custom SolImageConfig with smaller sq_edge produces a smaller image."""
    default_cfg = SolImageConfig()
    custom_cfg = SolImageConfig(sq_edge=64)
    img = SolImage(config=custom_cfg)
    assert img.sol_img.shape[0] == custom_cfg.img_size
    assert img.sol_img.shape[0] < default_cfg.img_size


# ---------------------------------------------------------------------------
# SolImageConfig computed properties
# ---------------------------------------------------------------------------


def test_sol_image_config_derived_sizes() -> None:
    """SolImageConfig derived properties are internally consistent."""
    cfg = SolImageConfig()
    assert cfg.thick_border == cfg.thin_border + cfg.diff_border
    assert cfg.sq_size == 2 * cfg.thin_border + cfg.sq_edge
    assert cfg.box_size == 2 * cfg.thick_border + 3 * cfg.sq_size
    assert cfg.img_size == 3 * cfg.box_size


# ---------------------------------------------------------------------------
# SolImage drawing methods
# ---------------------------------------------------------------------------


def test_draw_borders_all_true() -> None:
    """draw_borders() with all-True border array does not raise."""
    img = SolImage()
    borders = np.ones((9, 9, 4), dtype=bool)
    img.draw_borders(borders)


def test_draw_borders_all_false() -> None:
    """draw_borders() with all-False border array does not raise."""
    img = SolImage()
    borders = np.zeros((9, 9, 4), dtype=bool)
    img.draw_borders(borders)


def test_draw_sum() -> None:
    """draw_sum() for cell (0, 0) with total 15 does not raise."""
    img = SolImage()
    img.draw_sum(0, 0, 15)


def test_draw_number() -> None:
    """draw_number() for digit 5 at cell (0, 0) does not raise."""
    img = SolImage()
    img.draw_number(5, 0, 0)


def test_draw_dots() -> None:
    """draw_dots() with a representative sq_poss array does not raise."""
    img = SolImage()
    # Build an object array of sets mimicking an unsolved grid
    sq_poss = np.array(
        [[set(range(1, 10)) for _ in range(9)] for _ in range(9)],
        dtype=object,
    )
    img.draw_dots(sq_poss)


def test_draw_dots_single_candidates() -> None:
    """draw_dots() skips cells with a single candidate (no dots drawn)."""
    img = SolImage()
    # All cells solved — no dots should be drawn; must not raise
    sq_poss = np.array(
        [[{(i * 9 + j) % 9 + 1} for j in range(9)] for i in range(9)],
        dtype=object,
    )
    img.draw_dots(sq_poss)
