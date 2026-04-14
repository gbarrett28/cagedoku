/**
 * Grid location: Stage 1 of the image pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.grid_location` module (post-Phase-0
 * cleanup — Hough fallback removed).
 *
 * Locates the sudoku grid in a browser ImageData via OpenCV.js contour
 * detection.  All functions receive `cv` (the OpenCV.js module object) as
 * their first argument so the async module load is handled by the caller.
 */

/** The OpenCV.js module type — typed as `any` to avoid requiring @types/opencv. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;

/**
 * Prepare a browser ImageData for grid detection.
 *
 * Converts the RGBA ImageData to grayscale, scales up via pyrUp until both
 * dimensions meet the minimum resolution, then adds a 3-pixel black border
 * to ensure contours near image edges are fully enclosed.
 *
 * @param cv - OpenCV.js module.
 * @param imageData - Raw RGBA image data from a canvas or FileReader.
 * @param resolution - Minimum pixel dimension required (9 * subres).
 * @returns [gry, srcMat] — grayscale Mat and bordered colour Mat.
 *   Caller must delete both Mats when done.
 */
export function getGryImg(cv: Cv, imageData: ImageData, resolution: number): [Cv, Cv] {
  // Convert RGBA ImageData to OpenCV Mat.
  let src = cv.matFromImageData(imageData);
  // Convert to grayscale.
  let gry = new cv.Mat();
  cv.cvtColor(src, gry, cv.COLOR_RGBA2GRAY);
  src.delete();

  // Scale up until both dimensions meet the minimum resolution.
  while (gry.rows < resolution || gry.cols < resolution) {
    const upscaled = new cv.Mat();
    cv.pyrUp(gry, upscaled);
    gry.delete();
    gry = upscaled;
  }

  // Add a 3-pixel black border so contours near the edge are closed.
  const bordered = new cv.Mat();
  cv.copyMakeBorder(gry, bordered, 3, 3, 3, 3, cv.BORDER_CONSTANT, new cv.Scalar(0));

  // Return separate grayscale (for border detection) and bordered grayscale.
  return [bordered, bordered];
}

/**
 * Find the grid rectangle via contour detection.
 *
 * Scans the largest external contours for a quadrilateral with approximately
 * square aspect ratio.  The outer border of the grid is a thick continuous
 * rectangle and is typically the largest connected dark region in the image.
 *
 * Corner ordering follows cv2.getPerspectiveTransform convention:
 *   rect[0]=TL, rect[1]=TR, rect[2]=BR, rect[3]=BL.
 *
 * @param cv - OpenCV.js module.
 * @param blk - Binary Mat (255 = dark pixels).
 * @param minAspect - Minimum short/long ratio to accept as valid (default 0.5).
 * @returns 4×2 Float32Array [TL, TR, BR, BL] in source-image coordinates,
 *   or null if no suitable quadrilateral is found.
 */
export function contourQuad(cv: Cv, blk: Cv, minAspect: number = 0.5): Float32Array | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(blk, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  hierarchy.delete();

  // Sort contours by area descending, check largest 10.
  const areas: Array<[number, number]> = [];
  for (let i = 0; i < contours.size(); i++) {
    areas.push([cv.contourArea(contours.get(i)), i]);
  }
  areas.sort((a, b) => b[0] - a[0]);

  let result: Float32Array | null = null;

  outer: for (const [, idx] of areas.slice(0, 10)) {
    const c = contours.get(idx);
    const peri = cv.arcLength(c, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * peri, true);

    if (approx.rows !== 4) {
      approx.delete();
      continue;
    }

    // Extract 4 points as flat array [x0,y0, x1,y1, x2,y2, x3,y3].
    const pts: Array<[number, number]> = [];
    for (let r = 0; r < 4; r++) {
      pts.push([approx.data32S[r * 2], approx.data32S[r * 2 + 1]]);
    }
    approx.delete();

    // Sort corners: TL (min x+y), BR (max x+y), TR (min y-x), BL (max y-x).
    const sums = pts.map(([x, y]) => x + y);
    const diffs = pts.map(([x, y]) => y - x);
    const tlIdx = argmin(sums);
    const brIdx = argmax(sums);
    const trIdx = argmin(diffs);
    const blIdx = argmax(diffs);

    const rect = new Float32Array(8);
    rect[0] = pts[tlIdx][0]; rect[1] = pts[tlIdx][1];
    rect[2] = pts[trIdx][0]; rect[3] = pts[trIdx][1];
    rect[4] = pts[brIdx][0]; rect[5] = pts[brIdx][1];
    rect[6] = pts[blIdx][0]; rect[7] = pts[blIdx][1];

    const w = Math.hypot(rect[2] - rect[0], rect[3] - rect[1]);
    const h = Math.hypot(rect[6] - rect[0], rect[7] - rect[1]);
    const lo = Math.min(w, h);
    const hi = Math.max(w, h);
    if (hi > 0 && lo / hi >= minAspect) {
      result = rect;
      break outer;
    }
  }

  contours.delete();
  return result;
}

/**
 * Locate the sudoku grid in a grayscale Mat via contour detection.
 *
 * Thresholds the image using a histogram-valley estimate of the darkest
 * significant tone (the grid lines), then finds the largest quadrilateral
 * contour as the grid boundary.
 *
 * @param cv - OpenCV.js module.
 * @param gry - Grayscale source Mat.
 * @param isblackOffset - Subtracted from valley estimate to tighten threshold.
 * @returns [blk, rect] — thresholded binary Mat and 4×2 Float32Array of
 *   corner coordinates [TL, TR, BR, BL].  Caller must delete blk.
 * @throws {Error} if no quadrilateral contour can be found.
 */
export function locateGrid(
  cv: Cv,
  gry: Cv,
  isblackOffset: number,
): [Cv, Float32Array] {
  // Build a 16-bin histogram to find the darkest significant tone.
  const pixels = gry.data as Uint8Array;
  const counts = new Int32Array(16);
  for (const v of pixels) {
    counts[(v >> 4) & 0xf]++;
  }

  // Walk from the bright end; stop when count rises — that's the valley.
  let cm = pixels.length;
  let isblack = 256;
  for (let b = 15; b >= 0; b--) {
    if (counts[b] < cm) {
      cm = counts[b];
      isblack = b * 16;
    } else {
      break;
    }
  }
  isblack -= isblackOffset;

  // Threshold: pixels darker than isblack become 255 (white = dark region).
  const blk = new cv.Mat();
  cv.inRange(gry, new cv.Mat(1, 1, cv.CV_8UC1, [0]), new cv.Mat(1, 1, cv.CV_8UC1, [isblack]), blk);

  const rect = contourQuad(cv, blk);
  if (rect === null) {
    blk.delete();
    throw new Error('locateGrid: no quadrilateral contour found');
  }

  return [blk, rect];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function argmin(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[best]) best = i;
  return best;
}

function argmax(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}
