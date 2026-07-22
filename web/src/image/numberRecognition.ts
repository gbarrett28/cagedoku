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
import { extractHoleFeatures } from './holeFeatures.js';
type Cv = OpenCVModule;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bounding rect as [x, y, width, height]. */
export type BRect = [number, number, number, number];

/** Node in the OpenCV contour hierarchy tree. */
export type ContourInfo = [contour: number[][], br: BRect, area: number, children: ContourInfo[]];

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

/**
 * PCA + template-matching + RBF-SVM classifier parameters.
 *
 * Mirrors Python's `CayenneNumber` (killer_sudoku/image/number_recognition.py):
 * two-stage inference — template matching (fast path) against per-digit mean
 * images, falling through to PCA-projected RBF-SVM classification when no
 * template scores above `templateThreshold`.
 */
export interface PCAParams {
  /** Thumbnail side length (64); image is winSize×winSize before PCA. */
  winSize: number;
  /** Number of PCA components to use (dims). */
  dims: number;
  /** (winSize*winSize,) per-pixel training mean. */
  mean: Float64Array;
  /** (dims * winSize*winSize,) component matrix, row-major. Row d is eigenvector d. */
  components: Float64Array;
  /** Per-digit mean template images (winSize*winSize each), keyed by digit label. */
  templates: ReadonlyMap<number, Float32Array>;
  /** Minimum TM_CCOEFF_NORMED score for the template fast path. */
  templateThreshold: number;
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

/**
 * Aggregate one-vs-one classifier votes into a per-sample prediction.
 *
 * Iterates over every ordered pair (i, j) with i < j — one classifier per pair.
 * `scoreForPair(s, clfIdx)` returns a signed score; positive → class i wins,
 * negative → class j wins. The class with the most accumulated votes wins.
 * Confidence is `maxVotes / (nClasses - 1)` (normalised by the maximum a single
 * class can receive, not total classifiers); samples below `threshold` are flagged
 * as not confident.
 */
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
  hog?: HOGParams;
  pca?: PCAParams;
  classifier: Classifier;
  confidenceThreshold: number;
}

/**
 * Extract HOG feature vectors from winSize×winSize uint8 images.
 *
 * Matches extract_hog() in web/train_recogniser.py exactly:
 * centered differences, unsigned atan2(|Gy|,Gx) mod 180, nearest-bin voting,
 * L2 block normalisation. No OpenCV dependency — pure arithmetic.
 *
 * @param imgs - flat uint8 pixel data for each image, each of length winSize²
 * @returns Float64Array of shape [n × nFeat] where nFeat = nBlocks² × cpb² × nbins
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

/**
 * Project winSize×winSize uint8 thumbnails into PCA space.
 *
 * Matches Python's `CayenneNumber._classify` exactly: centre (subtract the
 * training mean) then project onto each retained eigenvector — no sklearn
 * `PCA.transform` call, to avoid sklearn version skew (a bare `PCA()`
 * reconstructed from the .npz lacks `explained_variance_`).
 *
 * @param imgs - flat uint8 pixel data for each image, each of length winSize².
 * @returns Float64Array of shape [n × dims].
 */
function pcaExtract(imgs: Uint8Array[], pca: PCAParams): Float64Array {
  const { winSize, dims, mean, components } = pca;
  const nPixels = winSize * winSize;
  const n = imgs.length;
  const result = new Float64Array(n * dims);
  for (let i = 0; i < n; i++) {
    const img = imgs[i]!;
    for (let d = 0; d < dims; d++) {
      let sum = 0;
      const base = d * nPixels;
      for (let p = 0; p < nPixels; p++) {
        sum += (img[p]! - mean[p]!) * components[base + p]!;
      }
      result[i * dims + d] = sum;
    }
  }
  return result;
}

/**
 * Normalised cross-correlation coefficient between two same-size images.
 *
 * Matches `cv2.matchTemplate(img, tmpl, cv2.TM_CCOEFF_NORMED)` for the
 * single-position case (image and template are the same size, so there is
 * exactly one overlap position — no sliding window needed).
 */
function templateMatchNormed(img: ArrayLike<number>, tmpl: ArrayLike<number>): number {
  const n = img.length;
  let sumI = 0, sumT = 0;
  for (let i = 0; i < n; i++) { sumI += img[i]!; sumT += tmpl[i]!; }
  const meanI = sumI / n, meanT = sumT / n;
  let num = 0, denI = 0, denT = 0;
  for (let i = 0; i < n; i++) {
    const di = img[i]! - meanI;
    const dt = tmpl[i]! - meanT;
    num += di * dt;
    denI += di * di;
    denT += dt * dt;
  }
  const denom = Math.sqrt(denI * denT);
  return denom > 0 ? num / denom : 0;
}

/** Classify digit images using HOG + OVO classifier. */
function classify(rec: NumRecogniser, imgs: Uint8Array[]): Recognition[] {
  const n = imgs.length;
  const { classifier, confidenceThreshold } = rec;

  if (rec.pca) {
    const { pca } = rec;
    const results: Recognition[] = new Array(n);
    const fallbackIndices: number[] = [];
    const fallbackImgs: Uint8Array[] = [];

    // Template matching (fast path): compare each thumbnail to every stored
    // per-digit mean template via TM_CCOEFF_NORMED; accept the best match
    // directly if it clears templateThreshold, else fall through to PCA+RBF.
    // Matches Python's CayenneNumber.get_sums exactly.
    if (pca.templates.size > 0) {
      for (let i = 0; i < n; i++) {
        const img = imgs[i]!;
        let bestScore = -2.0;
        let bestDigit = 0;
        for (const [digit, tmpl] of pca.templates) {
          const score = templateMatchNormed(img, tmpl);
          if (score > bestScore) { bestScore = score; bestDigit = digit; }
        }
        if (bestScore >= pca.templateThreshold) {
          results[i] = { label: bestDigit, confident: true };
        } else {
          fallbackIndices.push(i);
          fallbackImgs.push(img);
        }
      }
    } else {
      for (let i = 0; i < n; i++) { fallbackIndices.push(i); fallbackImgs.push(imgs[i]!); }
    }

    if (fallbackImgs.length > 0) {
      const x = pcaExtract(fallbackImgs, pca);
      const recs = rbfPredictWithConfidence(classifier as RBFClassifier, x, fallbackImgs.length, confidenceThreshold);
      for (let k = 0; k < fallbackIndices.length; k++) {
        results[fallbackIndices[k]!] = recs[k]!;
      }
    }

    return results;
  }

  const hog = hogExtract(imgs, rec.hog!);
  const hole = extractHoleFeatures(imgs, rec.hog!.winSize);
  const nHog = hog.length / n;
  const nHole = hole.length / n;
  const x = new Float64Array(n * (nHog + nHole));
  for (let i = 0; i < n; i++) {
    x.set(hog.subarray(i * nHog, (i + 1) * nHog), i * (nHog + nHole));
    x.set(hole.subarray(i * nHole, (i + 1) * nHole), i * (nHog + nHole) + nHog);
  }
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
  function getF32(name: string): Float32Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 4 === 0) return new Float32Array(binBuffer, offset, byteLength / 4);
    return new Float32Array(binBuffer.slice(offset, offset + byteLength));
  }
  function getI32(name: string): Int32Array {
    const { offset, byteLength } = arrays[name]!;
    if (offset % 4 === 0) return new Int32Array(binBuffer, offset, byteLength / 4);
    return new Int32Array(binBuffer.slice(offset, offset + byteLength));
  }
  const scalarI32 = (name: string): number => getI32(name)[0]!;
  const scalarF64 = (name: string): number => getF64(name)[0]!;

  const classesArr = getI32('classes');
  const nClasses = classesArr.length;

  if (classifierType === 'pca_rbf') {
    const winSize = scalarI32('pca_win_size');
    const dims = scalarI32('pca_dims');
    const [nSv, nFeatures] = arrays['rbf_support_vectors']!.shape as [number, number];
    const templates = new Map<number, Float32Array>();
    for (const digit of classesArr) {
      const key = `template_${digit}`;
      if (key in arrays) templates.set(digit, getF32(key));
    }
    const pca: PCAParams = {
      winSize,
      dims,
      mean:       getF64('pca_mean'),
      components: getF64('pca_components'),
      templates,
      templateThreshold: scalarF64('template_threshold'),
    };
    const classifier: RBFClassifier = {
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
    return { pca, classifier, confidenceThreshold: scalarF64('confidence_threshold') };
  }

  const hog: HOGParams = {
    winSize:     scalarI32('hog_win_size'),
    cellSize:    scalarI32('hog_cell_size'),
    blockSize:   scalarI32('hog_block_size'),
    blockStride: scalarI32('hog_block_stride'),
    nbins:       scalarI32('hog_nbins'),
  };

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
/**
 * Width/height-only digit-glyph size gate (no vertical-position parity
 * check). Shared by contourIsNumber (board-wide live recognition, which also
 * needs the parity check to exclude centred solution digits) and the offline
 * training-data bridge (find-digit-blobs-server.ts), whose caller has
 * already scoped the search to a cage-total's own quadrant — there is no
 * solution-digit ambiguity left to resolve there.
 *
 * @param w - Contour bounding-rect width.
 * @param h - Contour bounding-rect height.
 * @param subres - Pixels per cell side.
 */
export function isDigitSizedContour(w: number, h: number, subres: number): boolean {
  return w >= (subres >> 4) && w < (subres >> 1) && h >= (subres >> 3) && h < (subres >> 1);
}

/**
 * @param area - Contour area (from `cv.contourArea`), used to reject
 *   low-fill-ratio shapes (e.g. a cage's border-line corner notch) that pass
 *   the bounding-box size check but aren't a digit glyph — see
 *   `isCageTotalContour`.
 * @param minFillRatio - Minimum area / (width * height) to count as a digit.
 */
/**
 * Decide whether a bounding rectangle could be a digit in a cage total.
 *
 * Matches Python's `contour_is_number` (killer_sudoku/image/number_recognition.py)
 * exactly: both x and y parity checked (centre falls in the first half-cell
 * of both its column and row), pure bounding-box size, no fill-ratio and no
 * hierarchy-depth requirement — those were later TS-only additions with no
 * Python equivalent.
 *
 * @param br - [x, y, w, h] bounding rect.
 * @param subres - Pixels per cell side.
 */
export function contourIsNumber(br: BRect, subres: number): boolean {
  const [x, y, w, h] = br;
  const xx = (2 * (x + (w >> 1))) / subres | 0;
  const yy = (2 * (y + (h >> 1))) / subres | 0;
  return xx % 2 === 0 && yy % 2 === 0 && isDigitSizedContour(w, h, subres);
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
      const area = cv.contourArea(c);
      const children = contourHier(cv, contours, hierarchy, seen, child);
      // Extract contour points as number[][].
      const pts: number[][] = [];
      for (let p = 0; p < c.rows; p++) {
        pts.push([c.data32S[p * 2]!, c.data32S[p * 2 + 1]!]);
      }
      c.delete();
      ret.push([pts, brTuple, area, children]);
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
 * contourIsNumber AND are nested at depth >= 2. Non-matching contours are
 * discarded but their children are still searched.
 *
 * @param chier - Contour hierarchy.
 * @param subres - Pixels per cell side.
 * @param minFillRatio - Minimum area / (width * height) to count as a digit;
 *   see `contourIsNumber`.
 * @param depth - Current depth in the hierarchy (0 at the top-level call).
 *   Depth 0 is the single outer-grid contour, depth 1 is the 81 per-cell
 *   border frames (plus, on images with fragmented border ink, stray
 *   non-cell line fragments -- e.g. a cage's L-shaped corner notch that
 *   happens to pass the size/fill-ratio checks). A genuine cage-total digit
 *   is only ever found nested inside a cell's frame, i.e. depth >= 2.
 */
/**
 * Filter contour hierarchy to digit-sized contours only.
 *
 * Matches Python's `get_num_contours` exactly: recursively searches for
 * contours whose bounding rect passes `contourIsNumber`. Non-matching
 * contours are discarded but their children are still searched — no
 * hierarchy-depth requirement (an earlier TS-only addition with no Python
 * equivalent, added to fix a real bug — see git history around
 * contourIsNumber.test.ts — being deliberately reverted for now to match
 * Python while the rest of the pipeline is brought to parity).
 *
 * @param chier - Contour hierarchy.
 * @param subres - Pixels per cell side.
 */
export function getNumContours(chier: ContourInfo[], subres: number): ContourInfo[] {
  const ret: ContourInfo[] = [];
  for (const [c, br, area, ds] of chier) {
    if (contourIsNumber(br, subres)) {
      ret.push([c, br, area, ds]);
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
  dst?: number[][],
): Uint8Array {
  const dstQuad = dst ?? [
    [0, 0],
    [resH - 1, 0],
    [resH - 1, resW - 1],
    [0, resW - 1],
  ];
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, rect.flat());
  const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, dstQuad.flat());
  const m = cv.getPerspectiveTransform(src, dstMat);
  const out = new cv.Mat();
  cv.warpPerspective(gry, out, m, new cv.Size(resW, resH), cv.INTER_LINEAR);
  src.delete(); dstMat.delete(); m.delete();

  const data = new Uint8Array(out.data);
  out.delete();
  return data;
}


/**
 * Local-maxima peak finder. Replaces `scipy.signal.find_peaks(x, height=...)`.
 *
 * Matches scipy's plateau handling exactly: a flat run of equal values
 * bounded by strictly lower neighbours on both sides counts as one peak,
 * located at the run's midpoint (floor). Boundary elements (index 0 and
 * length-1) can never be peaks, matching scipy.
 *
 * @param x - Input signal.
 * @param height - Minimum value for a peak to be reported.
 */
function findPeaks(x: ArrayLike<number>, height: number): number[] {
  const n = x.length;
  const midpoints: number[] = [];
  let i = 1;
  const iMax = n - 1;
  while (i < iMax) {
    if (x[i - 1]! < x[i]!) {
      let iAhead = i + 1;
      while (iAhead < iMax && x[iAhead] === x[i]) iAhead++;
      if (x[iAhead]! < x[i]!) {
        const leftEdge = i;
        const rightEdge = iAhead - 1;
        midpoints.push((leftEdge + rightEdge) >> 1);
        i = iAhead;
      }
    }
    i++;
  }
  return midpoints.filter(p => x[p]! >= height);
}

/**
 * Column-wise "topmost ink row" profile for a bounding-rect crop of a binary
 * (ink=255, background=0) image. Matches Python's
 * `np.argmax(warped_blk[y:y+h, x:x+w], axis=0)`: for each column, the index
 * (within [0, h)) of the first ink pixel from the top, or 0 if the column has
 * no ink at all (argmax of an all-zero column returns its first index).
 */
function topInkRowProfile(warpedBlk: OpenCVMat, x: number, y: number, w: number, h: number): Int32Array {
  const data = warpedBlk.data as Uint8Array;
  const width = warpedBlk.cols as number;
  const ys = new Int32Array(w);
  for (let dx = 0; dx < w; dx++) {
    let rowIdx = 0;
    for (let dy = 0; dy < h; dy++) {
      if (data[(y + dy) * width + (x + dx)]! > 0) { rowIdx = dy; break; }
    }
    ys[dx] = rowIdx;
  }
  return ys;
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
  subres: number,
): [Uint8Array[], Uint8Array, number, number] {
  const [x, y, w, h] = br;

  // Always warp the full bounding rect to 64×64 — returned as the merged
  // thumbnail for training export (not used for the split decision itself,
  // unlike the earlier classifier-based approach this replaces).
  const fullSrc = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const mergedThumb = getWarpFromRect(cv, fullSrc, warpedBlk);

  // Peak detection on the column-wise topmost-ink-row profile: a gap between
  // two digit glyphs shows up as a peak (the profile dips down — less ink
  // near the top — where there's no glyph). Matches Python's split_num
  // exactly: no classifier involved in the split decision at all.
  const ys = topInkRowProfile(warpedBlk, x, y, w, h);
  const peaks = findPeaks(ys, 4);
  const validPeaks = peaks.filter(p =>
    contourIsNumber([x, y, p, h], subres) && contourIsNumber([x + p, y, w - p, h], subres),
  );

  let rects: Array<[yTop: number, yBottom: number, xLeft: number, xRight: number]>;
  if (validPeaks.length === 0) {
    rects = [[y, y + h, x, x + w]];
  } else {
    const sp = validPeaks[validPeaks.length - 1]!;
    if (sp >= h || (w - sp) >= h) {
      throw new Error(`splitNum: unexpected digit geometry — split point ${sp} invalid for bounding rect [${br.join(',')}]`);
    }
    rects = [[y, y + h, x, x + sp], [y, y + h, x + sp, x + w]];
  }

  const halfRes = subres >> 1;
  const thumbs = rects.map(([yt, yb, xl, xr]) => {
    const src = [[xl, yt], [xr, yt], [xr, yb], [xl, yb]];
    return getWarpFromRect(cv, src, warpedBlk, halfRes, halfRes);
  });

  return [thumbs, mergedThumb, x, y];
}

/**
 * Read pre-filled digits from the centre of each cell (classic puzzles only).
 *
 * @param cv - OpenCV.js module.
 * @param warpedBlk - Warped binary image Mat (ink=255).
 * @param rec - Loaded digit classifier.
 * @param subres - Pixels per cell side.
 * @param classicConf - (9×9) [row][col] confidence from scanClassicDigits.
 * @returns (9×9) number[][] of given digits (0 for empty/unrecognised cells).
 */
/**
 * Compute square-padded warp source corners for a contour bounding rect.
 * Centres the rect in a square whose side equals max(bw, bh), preserving
 * the digit's natural aspect ratio when warped to a square thumbnail.
 * Returns [[TL],[TR],[BR],[BL]] in image (x, y) coordinates.
 */


export function readClassicDigits(
  cv: Cv,
  warpedBlk: OpenCVMat,
  rec: NumRecogniser,
  subres: number,
  classicConf: number[][],
): { digits: number[][]; thumbs: Map<string, Uint8Array[]> } {
  const half = subres >> 1;
  const margin = subres >> 2;
  const digits: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const thumbs = new Map<string, Uint8Array[]>();

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (classicConf[r]![c]! === 0) continue;

      const y0 = r * subres + margin;
      const x0 = c * subres + margin;
      const patch = warpedBlk.roi(new cv.Rect(x0, y0, half, half));

      const cnts = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(patch, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      patch.delete();
      hier.delete();

      if (cnts.size() === 0) {
        cnts.delete();
        continue;
      }

      let bestIdx = 0;
      let bestArea = 0;
      for (let i = 0; i < cnts.size(); i++) {
        const ci = cnts.get(i);
        const area = cv.contourArea(ci);
        ci.delete();
        if (area > bestArea) { bestArea = area; bestIdx = i; }
      }

      const cBest = cnts.get(bestIdx);
      const br = cv.boundingRect(cBest);
      cBest.delete();
      cnts.delete();

      if (br.width === 0 || br.height === 0) continue;

      const ax = x0 + br.x;
      const ay = y0 + br.y;
      const src = [[ax, ay], [ax + br.width, ay], [ax + br.width, ay + br.height], [ax, ay + br.height]];
      const thumb = getWarpFromRect(cv, src, warpedBlk, half, half);
      const [rec0] = recognise(rec, [thumb]);
      const d = rec0!.label;
      if (d > 0) {
        digits[r]![c] = d;
        thumbs.set(`${r},${c}`, [thumb]);
      }
    }
  }

  return { digits, thumbs };
}
