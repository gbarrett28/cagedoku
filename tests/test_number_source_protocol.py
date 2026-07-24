import numpy as np
import numpy.typing as npt

from killer_sudoku.image.inp_image import InpImage
from killer_sudoku.image.number_recognition import CayenneNumber, NumberSource


def test_cayenne_number_satisfies_number_source() -> None:
    num_recogniser = InpImage.make_num_recogniser()
    source: NumberSource = num_recogniser  # mypy-checked assignment
    assert isinstance(source, CayenneNumber)


class _FakeSource:
    def get_sums(self, nums: list[npt.NDArray[np.uint8]]) -> npt.NDArray[np.intp]:
        return np.zeros(len(nums), dtype=np.intp)


def test_arbitrary_class_satisfies_number_source_structurally() -> None:
    source: NumberSource = _FakeSource()
    result = source.get_sums([np.zeros((64, 64), dtype=np.uint8)])
    assert result.tolist() == [0]
