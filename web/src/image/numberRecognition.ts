/**
 * Number recognition: Stage 3 (digit extraction) of the image pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.number_recognition` module.
 *
 * Provides:
 *   - RBFClassifier: pure-TypeScript OvO RBF SVM inference (no sklearn).
 *   - NumRecogniser: PCA + two-stage classifier (template matching + SVM).
 *   - loadNumRecogniser(): loads the exported .bin + .json model files.
 *   - Contour hierarchy helpers used to extract digit bounding rects.
 *   - splitNum(): separates one- and two-digit cage totals.
 *   - readClassicDigits(): extracts pre-filled digits from classic puzzles.
 */

import type { OpenCVModule, OpenCVMat, OpenCVMatVector } from './opencv.js';
type Cv = OpenCVModule;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bounding rect as [x, y, width, height]. */
export type BRect = [number, number, number, number];

/** Node in the OpenCV contour hierarchy tree. */
export type ContourInfo = [contour: number[][], br: BRect, children: ContourInfo[]];

// ---------------------------------------------------------------------------
// RBFClassifier: pure-TypeScript OvO RBF SVM
// ---------------------------------------------------------------------------

/**
 * Pure-TypeScript OvO RBF SVM classifier extracted from a fitted sklearn SVC.
 *
 * Mirrors Python's `RBFClassifier` dataclass.  At inference time only typed
 * arrays are used — no sklearn required.
 */
export interface HOGParams {
  winSize: number;      // 64
  cellSize: number;     // 8
  blockSize: number;    // 16
  blockStride: number;  // 8
  nbins: number;        // 9
}

export interface LinearClassifier {
  kind: 'linear';
  coef: Float64Array;       // (nClassifiers, nFeatures) row-major
  intercept: Float64Array;  // (nClassifiers,)
  classes: Int32Array;
  nClasses: number;
  nClassifiers: number;
  nFeatures: number;
}

export interface RBFModel {
  /** (n_sv, n_features) support vectors. */
  supportVectors: Float64Array;
  /** (n_classes-1, n_sv) dual coefficients. */
  dualCoef: Float64Array;
  /** (n_classifiers,) bias terms. */
  intercept: Float64Array;
  /** (n_classes,) number of SVs per class. */
  nSupport: Int32Array;
  /** RBF kernel width γ. */
  gamma: number;
  /** (n_classes,) class labels. */
  classes: Int32Array;
  nClasses: number;
  nSv: number;
  nFeatures: number;
}

export interface RBFClassifier extends RBFModel {
  kind: 'rbf';
}

export type Classifier = LinearClassifier | RBFClassifier;

export interface Recognition {
  label: number;
  confident: boolean;
}

/** OVO vote loop shared by both classifier types. */
function ovoVote(
  nSamples: number,
  nClasses: number,
  _nClassifiers: number,
  scoreForPair: (s: number, clfIdx: number) => number,
  classes: Int32Array,
  threshold: number,
): Recognition[] {
  const votes = new Int32Array(nSamples * nClasses);
  let clfIdx = 0;
  for (let i = 0; i < nClasses; i++) {
    for (let j = i + 1; j < nClasses; j++) {
      for (let s = 0; s < nSamples; s++) {
        if (scoreForPair(s, clfIdx) > 0) votes[s * nClasses + i]!++;
        else votes[s * nClasses + j]!++;
      }
      clfIdx++;
    }
  }
  const result: Recognition[] = [];
  for (let s = 0; s < nSamples; s++) {
    let best = 0;
    for (let c = 1; c < nClasses; c++) {
      if (votes[s * nClasses + c]! > votes[s * nClasses + best]!) best = c;
    }
    // Normalise by (nClasses-1): max votes any class can receive in OVO, not total classifiers.
    result.push({ label: classes[best]!, confident: votes[s * nClasses + best]! / (nClasses - 1) >= threshold });
  }
  return result;
}

function linearPredict(clf: LinearClassifier, x: Float64Array, nSamples: number, threshold: number): Recognition[] {
  const { coef, intercept, classes, nClasses, nClassifiers, nFeatures } = clf;
  return ovoVote(nSamples, nClasses, nClassifiers,
    (s, clfIdx) => {
      const xi = x.subarray(s * nFeatures, (s + 1) * nFeatures);
      const row = coef.subarray(clfIdx * nFeatures, (clfIdx + 1) * nFeatures);
      let dec = intercept[clfIdx]!;
      for (let f = 0; f < nFeatures; f++) dec += row[f]! * xi[f]!;
      return dec;
    },
    classes, threshold,
  );
}

function rbfPredictWithConfidence(clf: RBFClassifier, x: Float64Array, nSamples: number, threshold: number): Recognition[] {
  const { supportVectors, dualCoef, intercept, nSupport, gamma, classes, nClasses, nSv, nFeatures } = clf;

  const k = new Float64Array(nSamples * nSv);
  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    let xsq = 0;
    for (let f = 0; f < nFeatures; f++) xsq += xi[f]! * xi[f]!;
    for (let j = 0; j < nSv; j++) {
      const sv = supportVectors.subarray(j * nFeatures, (j + 1) * nFeatures);
      let svsq = 0, dot = 0;
      for (let f = 0; f < nFeatures; f++) { svsq += sv[f]! * sv[f]!; dot += xi[f]! * sv[f]!; }
      k[i * nSv + j] = Math.exp(-gamma * (xsq + svsq - 2 * dot));
    }
  }
  const svEnd = new Int32Array(nClasses);
  svEnd[0] = nSupport[0]!;
  for (let c = 1; c < nClasses; c++) svEnd[c] = svEnd[c - 1]! + nSupport[c]!;
  const svStart = new Int32Array(nClasses);
  for (let c = 1; c < nClasses; c++) svStart[c] = svEnd[c - 1]!;
  const nClassifiers = (nClasses * (nClasses - 1)) / 2;

  return ovoVote(nSamples, nClasses, nClassifiers,
    (s, clfIdx) => {
      // Reconstruct i,j from clfIdx — same order as training loop.
      let idx = 0, ii = 0, jj = 1;
      outer: for (let i = 0; i < nClasses; i++) {
        for (let j = i + 1; j < nClasses; j++) {
          if (idx++ === clfIdx) { ii = i; jj = j; break outer; }
        }
      }
      const si = svStart[ii]!, ei = svEnd[ii]!;
      const sj = svStart[jj]!, ej = svEnd[jj]!;
      let dec = intercept[clfIdx]!;
      for (let sv = si; sv < ei; sv++) dec += dualCoef[(jj - 1) * nSv + sv]! * k[s * nSv + sv]!;
      for (let sv = sj; sv < ej; sv++) dec += dualCoef[ii * nSv + sv]! * k[s * nSv + sv]!;
      return dec;
    },
    classes, threshold,
  );
}

// ---------------------------------------------------------------------------
// NumRecogniser
// ---------------------------------------------------------------------------

export interface NumRecogniser {
  hog: HOGParams;
  classifier: Classifier;
  confidenceThreshold: number;
}

/**
 * Extract HOG feature vectors from winSize×winSize uint8 images.
 *
 * Matches extract_hog() in web/train_recogniser.py exactly:
 * centered differences, unsigned atan2(|Gy|,Gx) mod 180, nearest-bin voting,
 * L2 block normalisation. No OpenCV dependency — pure arithmetic.
 */
function hogExtract(imgs: Uint8Array[], params: HOGParams): Float64Array {
  const { winSize, cellSize, blockSize, blockStride, nbins } = params;
  const nCells = winSize / cellSize;
  const cpb = blockSize / cellSize;                                   // cells per block side
  const nBlocks = (winSize - blockSize) / blockStride + 1;
  const nFeat = nBlocks * nBlocks * cpb * cpb * nbins;
  const binWidth = 180 / nbins;
  const n = imgs.length;
  const result = new Float64Array(n * nFeat);

  for (let p = 0; p < n; p++) {
    const img = imgs[p]!;

    // Gradients — centered differences, clamped borders.
    const Gx = new Float32Array(winSize * winSize);
    const Gy = new Float32Array(winSize * winSize);
    for (let y = 0; y < winSize; y++) {
      for (let x = 0; x < winSize; x++) {
        const i = y * winSize + x;
        Gx[i] = x === 0            ? img[i + 1]! - img[i]!
               : x === winSize - 1 ? img[i]! - img[i - 1]!
               : img[i + 1]! - img[i - 1]!;
        Gy[i] = y === 0            ? img[i + winSize]! - img[i]!
               : y === winSize - 1 ? img[i]! - img[i - winSize]!
               : img[i + winSize]! - img[i - winSize]!;
      }
    }

    // Cell histograms — nearest-bin, magnitude-weighted.
    const cellHists = new Float32Array(nCells * nCells * nbins);
    for (let y = 0; y < winSize; y++) {
      for (let x = 0; x < winSize; x++) {
        const i = y * winSize + x;
        const gx = Gx[i]!, gy = Gy[i]!;
        const mag = Math.sqrt(gx * gx + gy * gy);
        const angleDeg = (Math.atan2(Math.abs(gy), gx) * 180 / Math.PI) % 180;
        const bin = Math.floor(angleDeg / binWidth) % nbins;
        const cy = Math.floor(y / cellSize);
        const cx = Math.floor(x / cellSize);
        cellHists[(cy * nCells + cx) * nbins + bin]! += mag;
      }
    }

    // Block descriptors — L2 normalise each 2×2 cell block.
    const eps = 1e-6;
    let featIdx = p * nFeat;
    for (let by = 0; by < nBlocks; by++) {
      for (let bx = 0; bx < nBlocks; bx++) {
        let norm = eps * eps;
        const base = featIdx;
        // Collect block values and accumulate norm.
        for (let cy = by; cy < by + cpb; cy++) {
          for (let cx = bx; cx < bx + cpb; cx++) {
            const h = (cy * nCells + cx) * nbins;
            for (let b = 0; b < nbins; b++) {
              const v = cellHists[h + b]!;
              result[featIdx++] = v;
              norm += v * v;
            }
          }
        }
        norm = Math.sqrt(norm);
        for (let i = base; i < featIdx; i++) result[i]! /= norm;
      }
    }
  }
  return result;
}

/** Classify digit images using HOG + OVO classifier. */
function classify(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  const n = imgs.length;
  const x = hogExtract(imgs, rec.hog);
  const { classifier, confidenceThreshold } = rec;
  if (classifier.kind === 'linear') return linearPredict(classifier, x, n, confidenceThreshold);
  return rbfPredictWithConfidence(classifier, x, n, confidenceThreshold);
}

/** Classify digit image patches and return labels with confidence flags. */
export function recognise(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  return classify(rec, imgs);
}

// ---------------------------------------------------------------------------
// Model loading from .bin + .json
// ---------------------------------------------------------------------------

/**
 * Load the NumRecogniser model from the exported .bin and .json files.
 *
 * The manifest JSON contains dtype, shape, offset, byteLength for each array.
 * The binary file is a flat little-endian blob of all arrays concatenated.
 *
 * @param binBuffer - Contents of num_recogniser.bin.
 * @param manifestJson - Parsed contents of num_recogniser.json.
 */
export function loadNumRecogniser(
  binBuffer: ArrayBuffer,
  manifestJson: { classifier_type?: string; arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }> },
): NumRecogniser {
  const arrays = manifestJson.arrays;
  const classifierType = manifestJson.classifier_type ?? 'rbf';

  function getF64(name: string): Float64Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 8 === 0) return new Float64Array(binBuffer, offset, byteLength / 8);
    return new Float64Array(binBuffer.slice(offset, offset + byteLength));
  }
  function getI32(name: string): Int32Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 4 === 0) return new Int32Array(binBuffer, offset, byteLength / 4);
    return new Int32Array(binBuffer.slice(offset, offset + byteLength));
  }
  const scalarI32 = (name: string): number => getI32(name)[0]!;
  const scalarF64 = (name: string): number => getF64(name)[0]!;

  const hog: HOGParams = {
    winSize:     scalarI32('hog_win_size'),
    cellSize:    scalarI32('hog_cell_size'),
    blockSize:   scalarI32('hog_block_size'),
    blockStride: scalarI32('hog_block_stride'),
    nbins:       scalarI32('hog_nbins'),
  };

  const classesArr = getI32('classes');
  const nClasses = classesArr.length;

  let classifier: Classifier;
  if (classifierType === 'linear') {
    const [nClassifiers, nFeatures] = arrays['linear_coef']!.shape as [number, number];
    classifier = {
      kind: 'linear',
      coef:         getF64('linear_coef'),
      intercept:    getF64('linear_intercept'),
      classes:      classesArr,
      nClasses,
      nClassifiers,
      nFeatures,
    };
  } else {
    const [nSv, nFeatures] = arrays['rbf_support_vectors']!.shape as [number, number];
    classifier = {
      kind:           'rbf',
      supportVectors: getF64('rbf_support_vectors'),
      dualCoef:       getF64('rbf_dual_coef'),
      intercept:      getF64('rbf_intercept'),
      nSupport:       getI32('rbf_n_support'),
      gamma:          scalarF64('rbf_gamma'),
      classes:        classesArr,
      nClasses,
      nSv,
      nFeatures,
    };
  }

  return { hog, classifier, confidenceThreshold: scalarF64('confidence_threshold') };
}

// ---------------------------------------------------------------------------
// Contour hierarchy helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether a bounding rect could be a digit in a cage total.
 *
 * A valid digit bounding rect must have its centre in an even-numbered
 * half-cell (first half of a cell) and have dimensions consistent with a
 * digit occupying roughly 1/8 to 1/2 of a cell.
 *
 * @param br - [x, y, w, h] bounding rect.
 * @param subres - Pixels per cell side.
 */
export function contourIsNumber(br: BRect, subres: number): boolean {
  const [, y, w, h] = br;
  const yy = (2 * (y + (h >> 1))) / subres | 0;
  // x-parity omitted: yy + height checks exclude solution digits; x-parity falsely rejects second digits of "1X" totals near right-side cage borders.
  return (
    yy % 2 === 0 &&
    w >= (subres >> 4) && w < (subres >> 1) &&
    h >= (subres >> 3) && h < (subres >> 1)
  );
}

/**
 * Recursively build a contour hierarchy from OpenCV findContours output.
 *
 * @param cv - OpenCV.js module.
 * @param contours - MatVector from findContours.
 * @param hierarchy - Hierarchy Mat from findContours (shape Nx1x4, int32).
 * @param seen - Set of already-visited indices.
 * @param i - Starting index.
 */
export function contourHier(
  cv: Cv,
  contours: OpenCVMatVector,
  hierarchy: OpenCVMat,
  seen: Set<number>,
  i: number = 0,
): ContourInfo[] {
  if (contours.size() === 0) return [];

  // Hierarchy is a 1×N Mat with 4 int channels per contour.
  // Layout per node (channel index): [0]=next, [1]=prev, [2]=firstChild, [3]=parent.
  // Access via data32S[contourIdx * 4 + channel] — more reliable than intAt overloads.
  const hier = hierarchy.data32S;

  const ret: ContourInfo[] = [];
  while (i !== -1) {
    const next  = hier[i * 4 + 0];
    const child = hier[i * 4 + 2];
    if (!seen.has(i)) {
      const c = contours.get(i);
      const br = cv.boundingRect(c);
      const brTuple: BRect = [br.x, br.y, br.width, br.height];
      const children = contourHier(cv, contours, hierarchy, seen, child);
      // Extract contour points as number[][].
      const pts: number[][] = [];
      for (let p = 0; p < c.rows; p++) {
        pts.push([c.data32S[p * 2]!, c.data32S[p * 2 + 1]!]);
      }
      ret.push([pts, brTuple, children]);
    }
    seen.add(i);
    i = next!;
  }
  return ret;
}

/**
 * Filter contour hierarchy to digit-sized contours only.
 *
 * Recursively searches for contours whose bounding rect passes
 * contourIsNumber. Non-matching contours are discarded but their children
 * are still searched.
 *
 * @param chier - Contour hierarchy.
 * @param subres - Pixels per cell side.
 */
export function getNumContours(chier: ContourInfo[], subres: number): ContourInfo[] {
  const ret: ContourInfo[] = [];
  for (const [c, br, ds] of chier) {
    if (contourIsNumber(br, subres)) {
      ret.push([c, br, ds]);
    } else {
      ret.push(...getNumContours(ds, subres));
    }
  }
  return ret;
}

/**
 * Apply a perspective warp to extract a sub-region of an image.
 *
 * @param cv - OpenCV.js module.
 * @param rect - (4, 2) source corner points [[x,y], ...].
 * @param gry - Source grayscale Mat.
 * @param resH - Output height (default 64).
 * @param resW - Output width (default 64).
 * @returns Warped Uint8Array (caller owns it).
 */
export function getWarpFromRect(
  cv: Cv,
  rect: number[][],
  gry: OpenCVMat,
  resH: number = 64,
  resW: number = 64,
): Uint8Array {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, rect.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    resH - 1, 0,
    resH - 1, resW - 1,
    0, resW - 1,
  ]);
  const m = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  cv.warpPerspective(gry, out, m, new cv.Size(resW, resH), cv.INTER_LINEAR);
  src.delete(); dst.delete(); m.delete();

  const data = new Uint8Array(out.data);
  out.delete();
  return data;
}

/**
 * Simple local-maxima peak finder. Replaces scipy.signal.find_peaks.
 *
 * Returns indices where arr[i] > arr[i-1] and arr[i] > arr[i+1] and
 * arr[i] >= minHeight.
 */

/**
 * Split a bounding rect that may contain one or two digits.
 *
 * Uses peak detection on the column-argmax profile to find a vertical split
 * point between two adjacent digits.
 *
 * @param cv - OpenCV.js module.
 * @param br - [x, y, w, h] bounding rect in the warped image.
 * @param warpedBlk - Warped binary image Mat (ink=255).
 * @param subres - Pixels per cell side.
 * @returns [thumbnails, x, y] — list of warped digit Uint8Arrays and the
 *   top-left corner of the original bounding rect.
 */
export function splitNum(
  cv: Cv,
  br: BRect,
  warpedBlk: OpenCVMat,
): [Uint8Array[], number, number] {
  const [x, y, w, h] = br;
  const data: Uint8Array = warpedBlk.data as Uint8Array;
  const width: number = warpedBlk.cols as number;

  // Vertical ink projection: count white pixels per column.
  const inkCounts = new Array<number>(w).fill(0);
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) {
      if (data[(y + dy) * width + (x + dx)]! > 0) inkCounts[dx]!++;
    }
  }

  const maxInk = Math.max(...inkCounts);
  const rects: Array<[number, number, number, number]> = [];

  if (maxInk === 0) {
    rects.push([y, y + h, x, x + w]);
  } else {
    // Segment into digit blobs: contiguous runs of columns with ink above the gap
    // threshold.  A true inter-digit gap has near-zero ink; digit bodies — even at
    // the narrow waist of "3" or "8" — stay well above 15 % of the column maximum.
    const gapThreshold = maxInk * 0.15;
    const blobs: Array<[number, number]> = [];  // [left, right) in crop coords
    let blobStart = -1;
    for (let dx = 0; dx <= w; dx++) {
      if (dx < w && inkCounts[dx]! > gapThreshold) {
        if (blobStart < 0) blobStart = dx;
      } else if (blobStart >= 0) {
        blobs.push([blobStart, dx]);
        blobStart = -1;
      }
    }

    if (blobs.length === 2 && blobs[0]![1] - blobs[0]![0] >= 2 && blobs[1]![1] - blobs[1]![0] >= 2) {
      for (const [l, r] of blobs) rects.push([y, y + h, x + l, x + r]);
    } else {
      rects.push([y, y + h, x, x + w]);
    }
  }

  // Use the full 64×64 resolution (default) so thumbnails match the model's
  // nFeatures=4096 and template size expectations.
  const thumbnails: Uint8Array[] = [];
  for (const [yt, yb, xl, xr] of rects) {
    const src = [[xl, yt], [xr, yt], [xr, yb], [xl, yb]];
    thumbnails.push(getWarpFromRect(cv, src, warpedBlk));
  }

  return [thumbnails, x, y];
}

/**
 * Read pre-filled digits from the centre of each cell (classic puzzles only).
 *
 * @param cv - OpenCV.js module.
 * @param warpedBlk - Warped binary image Mat (ink=255).
 * @param rec - Loaded digit classifier.
 * @param subres - Pixels per cell side.
 * @param classicConf - (9×9) [row][col] confidence from scanCells.
 * @returns (9×9) number[][] of given digits (0 for empty/unrecognised cells).
 */
export function readClassicDigits(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  classicConf: number[][],
): number[][] {
  const half = subres >> 1;
  // Match scanCells: use the same margin/patchSize so tall digits aren't clipped.
  const margin = (subres / 6) | 0;
  const patchSize = subres - 2 * margin;
  const givenDigits: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (classicConf[r]![c]! === 0) continue;

      const y0 = r * subres + margin;
      const x0 = c * subres + margin;
      const patch = warpedBlk.roi(new cv.Rect(x0, y0, patchSize, patchSize));

      const cnts = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(patch, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      patch.delete();
      hier.delete();

      if (cnts.size() === 0) {
        cnts.delete();
        continue;
      }

      // Find the largest contour.
      let bestIdx = 0;
      let bestArea = 0;
      for (let i = 0; i < cnts.size(); i++) {
        const area = cv.contourArea(cnts.get(i));
        if (area > bestArea) { bestArea = area; bestIdx = i; }
      }

      const br = cv.boundingRect(cnts.get(bestIdx));
      cnts.delete();

      if (br.width === 0 || br.height === 0) continue;

      const ax = x0 + br.x;
      const ay = y0 + br.y;
      const src = [
        [ax, ay], [ax + br.width, ay],
        [ax + br.width, ay + br.height], [ax, ay + br.height],
      ];
      const thumb = getWarpFromRect(cv, src, warpedBlk, half, half);
      const [rec0] = recognise(rec, [thumb]);
      const d = rec0!.label;
      if (d > 0) givenDigits[r]![c] = d;
    }
  }

  return givenDigits;
}
