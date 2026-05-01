import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "web"))
from train_recogniser import generate_synthetic_samples, extract_hog, HOG_FEAT


def test_generate_synthetic_samples_covers_digits_1_to_9():
    samples = generate_synthetic_samples()
    assert len(samples) > 0
    labels = {label for label, _ in samples}
    assert labels == set(range(1, 10)), f"Missing: {set(range(1,10)) - labels}"
    for _, img in samples[:5]:
        assert img.shape == (64, 64)
        assert img.dtype == np.uint8
        assert img.max() > 0


def test_extract_hog_output_shape():
    imgs = [np.zeros((64, 64), dtype=np.uint8) for _ in range(3)]
    imgs[0][20:44, 28:36] = 200   # rough digit stroke
    X = extract_hog(imgs)
    assert X.shape == (3, HOG_FEAT), f"Expected (3, {HOG_FEAT}), got {X.shape}"
    assert X.dtype == np.float64
