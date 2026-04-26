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
export interface RBFModel {
  /** (n_sv, n_features) support vectors. */
  supportVectors: Float64Array;
  /** (n_classes-1, n_sv) dual coefficients. */
  dualCoef: Float64Array;
  /** (n_classifiers,) bias terms; n_classifiers = n_classes*(n_classes-1)//2. */
  intercept: Float64Array;
  /** (n_classes,) number of SVs per class. */
  nSupport: Int32Array;
  /** RBF kernel width γ. */
  gamma: number;
  /** (n_classes,) class labels. */
  classes: Int32Array;
  /** n_classes. */
  nClasses: number;
  /** n_sv. */
  nSv: number;
  /** n_features. */
  nFeatures: number;
}

/**
 * OvO RBF SVM prediction using typed-array math.
 *
 * Computes the RBF kernel matrix, runs 45 binary decision functions, tallies
 * votes, and returns the class with most votes.
 *
 * @param model - Loaded RBFModel.
 * @param x - (n_samples, n_features) query points, row-major Float64Array.
 * @param nSamples - Number of query samples.
 * @returns Int32Array of length n_samples with predicted class labels.
 */
export function rbfPredict(model: RBFModel, x: Float64Array, nSamples: number): Int32Array {
  const { supportVectors, dualCoef, intercept, nSupport, gamma, classes, nClasses, nSv, nFeatures } = model;

  // RBF kernel: K[i,j] = exp(-γ * ||x[i] - sv[j]||²)
  const k = new Float64Array(nSamples * nSv);
  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    // ||x[i]||²
    let xsq = 0;
    for (let f = 0; f < nFeatures; f++) xsq += xi[f]! * xi[f]!;
    for (let j = 0; j < nSv; j++) {
      const sv = supportVectors.subarray(j * nFeatures, (j + 1) * nFeatures);
      let svsq = 0, dot = 0;
      for (let f = 0; f < nFeatures; f++) {
        svsq += sv[f]! * sv[f]!;
        dot += xi[f]! * sv[f]!;
      }
      k[i * nSv + j] = Math.exp(-gamma * (xsq + svsq - 2 * dot));
    }
  }

  // Cumulative SV counts per class.
  const svEnd = new Int32Array(nClasses);
  svEnd[0] = nSupport[0]!;
  for (let c = 1; c < nClasses; c++) svEnd[c] = svEnd[c - 1]! + nSupport[c]!;
  const svStart = new Int32Array(nClasses);
  for (let c = 1; c < nClasses; c++) svStart[c] = svEnd[c - 1]!;

  const votes = new Int32Array(nSamples * nClasses);
  let clfIdx = 0;

  for (let i = 0; i < nClasses; i++) {
    for (let j = i + 1; j < nClasses; j++) {
      const si = svStart[i]!, ei = svEnd[i]!;
      const sj = svStart[j]!, ej = svEnd[j]!;

      // Dual coef layout: row (j-1) → class-i SVs; row i → class-j SVs.
      for (let s = 0; s < nSamples; s++) {
        let decision = intercept[clfIdx]!;
        for (let sv = si; sv < ei; sv++) {
          decision += dualCoef[(j - 1) * nSv + sv]! * k[s * nSv + sv]!;
        }
        for (let sv = sj; sv < ej; sv++) {
          decision += dualCoef[i * nSv + sv]! * k[s * nSv + sv]!;
        }
        if (decision > 0) {
          votes[s * nClasses + i] = votes[s * nClasses + i]! + 1;
        } else {
          votes[s * nClasses + j] = votes[s * nClasses + j]! + 1;
        }
      }
      clfIdx++;
    }
  }

  const result = new Int32Array(nSamples);
  for (let s = 0; s < nSamples; s++) {
    let best = 0;
    for (let c = 1; c < nClasses; c++) {
      if (votes[s * nClasses + c]! > votes[s * nClasses + best]!) best = c;
    }
    result[s] = classes[best]!;
  }
  return result;
}

// ---------------------------------------------------------------------------
// NumRecogniser: PCA + two-stage classifier
// ---------------------------------------------------------------------------

/**
 * PCA model arrays needed for inference.
 * (Only components_ and mean_ are required — no explained_variance_ needed.)
 */
export interface PCAModel {
  components: Float64Array; // (nComponents, nFeatures)
  mean: Float64Array;        // (nFeatures,)
  nComponents: number;
  nFeatures: number;
}

/** Per-digit mean templates for the fast-path template-matching stage. */
export type Templates = Map<number, Float32Array>;

/** Loaded number recogniser model. */
export interface NumRecogniser {
  pca: PCAModel;
  dims: number;
  rbf: RBFModel;
  templates: Templates | null;
  templateThreshold: number;
}

/**
 * Project image patches into PCA space.
 *
 * @param pca - PCA model with components and mean.
 * @param patches - Flat array of uint8 patches, each nFeatures pixels.
 * @param nPatches - Number of patches.
 * @returns (nPatches, nComponents) Float64Array of PCA projections.
 */
function pcaTransform(pca: PCAModel, patches: Uint8Array[], nPatches: number): Float64Array {
  const { components, mean, nComponents, nFeatures } = pca;
  const result = new Float64Array(nPatches * nComponents);
  for (let p = 0; p < nPatches; p++) {
    const patch = patches[p]!;
    for (let c = 0; c < nComponents; c++) {
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) {
        dot += (patch[f]! - mean[f]!) * components[c * nFeatures + f]!;
      }
      result[p * nComponents + c] = dot;
    }
  }
  return result;
}

/**
 * Classify digit images using PCA + RBF SVM.
 *
 * @param rec - Loaded NumRecogniser.
 * @param imgs - List of uint8 patch arrays (each nFeatures pixels).
 * @returns Int32Array of predicted digit labels.
 */
function classify(rec: NumRecogniser, imgs: Uint8Array[]): Int32Array {
  const n = imgs.length;
  const pcaResult = pcaTransform(rec.pca, imgs, n);
  // Slice to dims PCA components.
  const x = new Float64Array(n * rec.dims);
  for (let p = 0; p < n; p++) {
    for (let d = 0; d < rec.dims; d++) {
      x[p * rec.dims + d] = pcaResult[p * rec.pca.nComponents + d]!;
    }
  }
  return rbfPredict(rec.rbf, x, n);
}

/**
 * Classify a list of digit image patches using template matching (fast) then SVM.
 *
 * @param cv - OpenCV.js module.
 * @param rec - Loaded NumRecogniser.
 * @param imgs - List of uint8 patch arrays to classify.
 * @returns Int32Array of predicted digit labels.
 */
export function getSums(cv: Cv, rec: NumRecogniser, imgs: Uint8Array[]): Int32Array {
  if (!rec.templates || rec.templates.size === 0) {
    return classify(rec, imgs);
  }

  const n = imgs.length;
  const labels = new Int32Array(n).fill(-1);
  const fallbackIdxs: number[] = [];
  const fallbackImgs: Uint8Array[] = [];

  for (let idx = 0; idx < n; idx++) {
    const img = imgs[idx]!;
    const size = Math.sqrt(img.length) | 0;

    // Build a float32 Mat from the patch.
    const imgF = new cv.Mat(size, size, cv.CV_32FC1);
    for (let i = 0; i < img.length; i++) imgF.data32F[i] = img[i]!;

    let bestScore = -2.0;
    let bestDigit = 0;
    for (const [digit, tmpl] of rec.templates) {
      const tmplMat = new cv.Mat(size, size, cv.CV_32FC1);
      for (let i = 0; i < tmpl.length; i++) tmplMat.data32F[i] = tmpl[i]!;

      const resultMat = new cv.Mat();
      cv.matchTemplate(imgF, tmplMat, resultMat, cv.TM_CCOEFF_NORMED);
      const score = resultMat.data32F[0]!;
      tmplMat.delete();
      resultMat.delete();

      if (score > bestScore) {
        bestScore = score;
        bestDigit = digit;
      }
    }
    imgF.delete();

    if (bestScore >= rec.templateThreshold) {
      labels[idx] = bestDigit;
    } else {
      fallbackIdxs.push(idx);
      fallbackImgs.push(img);
    }
  }

  if (fallbackImgs.length > 0) {
    const fallbackLabels = classify(rec, fallbackImgs);
    for (let i = 0; i < fallbackIdxs.length; i++) {
      labels[fallbackIdxs[i]!] = fallbackLabels[i]!;
    }
  }

  return labels;
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
  manifestJson: { arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }> },
): NumRecogniser {
  const arrays = manifestJson.arrays;

  function getF64(name: string): Float64Array {
    const { offset, byteLength } = arrays[name]!;
    // Float64Array requires byteOffset % 8 === 0. The .bin file packs arrays
    // without alignment padding, so a direct view may throw RangeError.
    // Copying into a fresh buffer guarantees alignment at negligible cost.
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
  function getScalarF64(name: string): number {
    return getF64(name)[0]!;
  }
  function getScalarI32(name: string): number {
    return getI32(name)[0]!;
  }

  const pcaComponents = getF64('pca_components');
  const pcaMean = getF64('pca_mean');
  const [nComponents, nFeatures] = arrays['pca_components']!.shape as [number, number];

  const pca: PCAModel = {
    components: pcaComponents,
    mean: pcaMean,
    nComponents,
    nFeatures,
  };

  const svArr = getF64('rbf_support_vectors');
  const nSv = arrays['rbf_support_vectors']!.shape[0]!;
  const rbfNFeatures = arrays['rbf_support_vectors']!.shape[1]!;
  const nSupportArr = getI32('rbf_n_support');
  const classesArr = getI32('rbf_classes');
  const nClasses = classesArr.length;

  const rbf: RBFModel = {
    supportVectors: svArr,
    dualCoef: getF64('rbf_dual_coef'),
    intercept: getF64('rbf_intercept'),
    nSupport: nSupportArr,
    gamma: getScalarF64('rbf_gamma'),
    classes: classesArr,
    nClasses,
    nSv,
    nFeatures: rbfNFeatures,
  };

  const dims = getScalarI32('dims');
  const templateThreshold = getScalarF64('template_threshold');

  // Load per-digit templates (template_0 … template_9).
  const templates = new Map<number, Float32Array>();
  for (let d = 0; d <= 9; d++) {
    const key = `template_${d}`;
    if (key in arrays) {
      templates.set(d, getF32(key));
    }
  }

  return {
    pca,
    dims,
    rbf,
    templates: templates.size > 0 ? templates : null,
    templateThreshold,
  };
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
  const [x, y, w, h] = br;
  const xx = (2 * (x + (w >> 1))) / subres | 0;
  const yy = (2 * (y + (h >> 1))) / subres | 0;
  return (
    xx % 2 === 0 &&
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
 * Paint contours and their children onto a Mat, alternating fill values.
 *
 * Draws each contour filled, then recurses into children with inverted fill
 * to create hole-masks for nested contours (e.g. digit "0").
 *
 * @param cv - OpenCV.js module.
 * @param msk - Mat to paint onto (modified in-place).
 * @param ch - Contour hierarchy.
 * @param fill - Fill value (255 = foreground, 0 = hole).
 */
export function paintMask(cv: Cv, msk: OpenCVMat, ch: ContourInfo[], fill: number = 255): void {
  for (const [pts, , ds] of ch) {
    // Rebuild contour as a Mat.
    const c = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat());
    const vec = new cv.MatVector();
    vec.push_back(c);
    cv.drawContours(msk, vec, 0, new cv.Scalar(fill, fill, fill, 255), -1);
    vec.delete();
    c.delete();
    paintMask(cv, msk, ds, 255 - fill);
  }
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
function findPeaks(arr: number[], minHeight: number): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i]! >= minHeight && arr[i]! > arr[i - 1]! && arr[i]! > arr[i + 1]!) {
      peaks.push(i);
    }
  }
  return peaks;
}

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
): [Uint8Array[], number, number] {
  const [x, y, w, h] = br;
  const data: Uint8Array = warpedBlk.data as Uint8Array;
  const width: number = warpedBlk.cols as number;

  // Column-argmax profile: for each column in the crop, find the row with max value.
  const ys: number[] = [];
  for (let dx = 0; dx < w; dx++) {
    let maxVal = 0;
    let maxRow = 0;
    for (let dy = 0; dy < h; dy++) {
      const v = data[(y + dy) * width + (x + dx)]!;
      if (v > maxVal) { maxVal = v; maxRow = dy; }
    }
    ys.push(maxRow);
  }

  const rawPeaks = findPeaks(ys, 4);
  const validPeaks = rawPeaks.filter(p =>
    contourIsNumber([x, y, p, h], subres) &&
    contourIsNumber([x + p, y, w - p, h], subres),
  );

  const rects: Array<[number, number, number, number]> = [];

  if (validPeaks.length === 0) {
    // Ink-count fallback: argmax peaks are fragile to single-pixel JPEG decode differences.
    // A true gap between two digits has significantly fewer white pixels than digit columns.
    const inkCounts: number[] = [];
    for (let dx = 0; dx < w; dx++) {
      let ink = 0;
      for (let dy = 0; dy < h; dy++) {
        if (data[(y + dy) * width + (x + dx)]! > 0) ink++;
      }
      inkCounts.push(ink);
    }
    const margin = Math.max(2, w >> 3);
    let minInk = Infinity;
    let splitCol = -1;
    for (let dx = margin; dx < w - margin; dx++) {
      if (inkCounts[dx]! < minInk) { minInk = inkCounts[dx]!; splitCol = dx; }
    }
    const maxInk = Math.max(...inkCounts);
    const isGap = maxInk > 0 && splitCol >= 0 && minInk < maxInk * 0.15 &&
      contourIsNumber([x, y, splitCol, h], subres) &&
      contourIsNumber([x + splitCol, y, w - splitCol, h], subres);
    if (isGap) {
      rects.push([y, y + h, x, x + splitCol]);
      rects.push([y, y + h, x + splitCol, x + w]);
    } else {
      rects.push([y, y + h, x, x + w]);
    }
  } else {
    const sp = validPeaks[validPeaks.length - 1]!;
    rects.push([y, y + h, x, x + sp]);
    rects.push([y, y + h, x + sp, x + w]);
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
  const givenDigits: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (classicConf[r]![c]! === 0) continue;

      const y0 = r * subres + (subres >> 2);
      const x0 = c * subres + (subres >> 2);
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
      const labels = getSums(cv, rec, [thumb]);
      const d = labels[0]!;
      if (d > 0) givenDigits[r]![c] = d;
    }
  }

  return givenDigits;
}
