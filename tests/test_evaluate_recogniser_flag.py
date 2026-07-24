import shutil
from pathlib import Path

import numpy as np
import numpy.typing as npt

from killer_sudoku.image.config import ImagePipelineConfig
from killer_sudoku.training.evaluate import collect_status


class _AllOnesSource:
    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        return np.ones(len(nums), dtype=np.intp)


def test_collect_status_accepts_injected_recogniser(tmp_path: Path) -> None:
    # Copy a single fixture image into an isolated tmp_path — never point
    # collect_status at the real guardian/observer directories directly,
    # since it unconditionally overwrites status.pkl/eval_report.json there.
    shutil.copy(Path("guardian/killer_sudoku_0.jpg"), tmp_path / "killer_sudoku_0.jpg")
    config = ImagePipelineConfig(puzzle_dir=tmp_path, rework=False)
    status = collect_status(config, num_recogniser=_AllOnesSource())
    assert len(list(status.items())) == 1
