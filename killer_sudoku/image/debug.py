"""Debug visualisation utilities for the killer_sudoku image pipeline.

These functions are for interactive debugging only and must NOT be imported
by any inference-path module. They depend on matplotlib.pyplot which will
open GUI windows.
"""

from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from matplotlib import pyplot as plt

from killer_sudoku.image.number_recognition import ContourInfo, paint_mask


def show_stuff(
    bins: npt.NDArray[np.float64],
    blk: npt.NDArray[np.uint8],
    counts: npt.NDArray[np.intp],
    img: npt.NDArray[np.uint8],
    isblack: int,
    rect: npt.NDArray[np.float32],
    num_chiers: list[ContourInfo],
) -> None:
    """Show the grid detection result alongside the histogram and threshold.

    Displays a three-panel figure: annotated colour image, binary threshold
    image, and histogram with the isblack threshold marked. Then paints digit
    contours onto a blank image and shows it.

    Args:
        bins: Histogram bin edges.
        blk: Thresholded binary image.
        counts: Histogram counts per bin.
        img: Original BGR image (corners will be annotated in-place).
        isblack: Threshold value used to produce blk.
        rect: (4, 2) float32 array of detected grid corners.
        num_chiers: Digit contour hierarchy for painting.
    """
    for pt in rect:
        pt_ints = (int(round(float(pt[0]))), int(round(float(pt[1]))))
        cv2.circle(img, pt_ints, 5, (0, 255, 0), -1)
    plt.subplot(1, 3, 1)
    plt.imshow(img)
    plt.xticks([]), plt.yticks([])
    plt.subplot(1, 3, 2)
    plt.imshow(blk, "gray")
    plt.xticks([]), plt.yticks([])
    plt.subplot(1, 3, 3)
    plt.title(f"{isblack}")
    plt.stairs(counts, bins)
    plt.show()
    numbers = np.zeros(blk.shape, np.uint8)
    paint_mask(numbers, num_chiers)
    plt.imshow(numbers, "gray")
    plt.show()


def plt_images(imgs: list[Any], ticks: bool = False) -> None:
    """Show a list of images side by side in a single matplotlib figure.

    Args:
        imgs: List of images (any format accepted by plt.imshow).
        ticks: Whether to show axis ticks (default False).
    """
    for i, img in enumerate(imgs, 1):
        plt.subplot(1, len(imgs), i)
        plt.imshow(img, "gray")
        if not ticks:
            plt.xticks([]), plt.yticks([])
    plt.show()


def show_clusters(
    labels: npt.NDArray[np.intp],
    allcs: list[npt.NDArray[np.uint8]],
) -> None:
    """Display up to 10 examples from each cluster in a grid layout.

    Args:
        labels: Cluster label per image sample.
        allcs: List of image arrays corresponding to labels.
    """
    clusters: dict[int, list[npt.NDArray[np.uint8]]] = {}
    for c, label in zip(allcs, labels, strict=False):
        key = int(label)
        if key not in clusters:
            clusters[key] = []
        clusters[key].append(c)
    print(f"Number of clusters is {len(clusters)}")

    for i, k in enumerate(sorted(clusters.keys())):
        for j, c1 in enumerate(clusters[k][:10], 1):
            plt.subplot(len(clusters.keys()), 10, j + (10 * i))
            plt.imshow(c1, "gray")
            plt.xticks([]), plt.yticks([])
    plt.show()


def plot_pca(pca: Any, dim: int = 32) -> None:
    """Show the first dim PCA components as colour-mapped images.

    Each component is rescaled to [0, 255] and displayed using the JET
    colour map to highlight the sign and magnitude of each weight.

    Args:
        pca: Fitted sklearn PCA object.
        dim: Number of components to display (default 32).
    """
    print(pca.explained_variance_ratio_[0:32])
    print(np.cumsum(pca.explained_variance_ratio_[0:32]))

    for c in range(dim):
        component = pca.components_[c]
        pmin = component.min()
        pmax = component.max()
        gry_weights: npt.NDArray[np.uint8] = np.asarray(
            (component - pmin) * 255 / (pmax - pmin), dtype=np.uint8
        )
        col_weights = cv2.applyColorMap(gry_weights, cv2.COLORMAP_JET)

        plt.subplot(4, 8, c + 1)
        plt.imshow(col_weights)
        plt.xticks([]), plt.yticks([])

    plt.show()


def show_scatter(
    vecs: list[npt.NDArray[np.float64]],
    vals: list[int],
    n: int = 3,
) -> None:
    """Show a scatter plot of the first n pairs of PCA dimensions.

    Plots consecutive pairs of dimensions: (0,1), (1,2), (2,0), coloured by
    digit label.

    Args:
        vecs: List of PCA-projected vectors.
        vals: Digit label per vector (used for colouring).
        n: Number of dimension pairs to plot (default 3).
    """
    for i in range(n):
        plt.subplot(n, 1, i + 1)
        plt.scatter([v[i] for v in vecs], [v[(i + 1) % n] for v in vecs], c=vals)
    plt.show()
