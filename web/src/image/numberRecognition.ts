/**
 * Number recognition: Stage 3 (digit extraction) of the image pipeline.
 *
 * Provides:
 *   - RBFClassifier: pure-TypeScript OvO RBF SVM inference (no sklearn).
 *   - NumRecogniser: HOG/hole-feature RBF-SVM recognition.
 *   - loadNumRecogniser(): loads the exported .bin + .json model files.
 *   - Contour hierarchy helpers used to extract digit bounding rects.
 *   - splitNum(): separates one- and two-digit cage totals.
 *   - readClassicDigits(): extracts pre-filled digits from classic puzzles.
 */

import type { OpenCVModule, OpenCVMat, OpenCVMatVector } from './opencv.js';
import { extractHoleFeatures } from './holeFeatures.js';
import { extractAspectFeatures } from './aspectFeatures.js';
import { cageSumRange } from '../engine/types.js';
type Cv = OpenCVModule;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bounding rect as [x, y, width, height]. */
export type BRect = [number, number, number, number];

/** Exact bounding-box pixels copied from the warped grid before any resize. */
export interface RawDigitCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export type WarpStrategy = 'stretch' | 'letterbox' | 'letterbox-centered';

/** Node in the OpenCV contour hierarchy tree. */
export type ContourInfo = [br: BRect, children: ContourInfo[]];

// ---------------------------------------------------------------------------
// RBFClassifier: pure-TypeScript OvO RBF SVM
// ---------------------------------------------------------------------------

/**
 * Pure-TypeScript OvO RBF SVM classifier extracted from a fitted sklearn SVC.
 *
 * Inference uses only typed arrays; no sklearn runtime is required.
 */
export interface HOGParams {
  winSize: number;      // 64
  cellSize: number;     // 8
  blockSize: number;    // 16
  blockStride: number;  // 8
  nbins: number;        // 9
}

/**
 * HOG params used for feature extraction independent of any specific loaded
 * model (e.g. training-data caching) — matches train_recogniser.py's
 * HOG_WIN_SIZE/HOG_CELL_SIZE/HOG_BLOCK_SIZE/HOG_BLOCK_STRIDE/HOG_NBINS.
 * A deployed HogRecogniser's own params (read from its manifest) may differ
 * and always take precedence for actual recognition.
 */
export const DEFAULT_HOG_PARAMS: HOGParams = {
  winSize: 64, cellSize: 8, blockSize: 16, blockStride: 8, nbins: 9,
};

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

/**
 * Linear dimensionality reduction applied to HOG+hole features before the
 * RBF-SVM, matching sklearn's `PCA.transform`: `(x - mean) @ components.T`.
 * Optional — models trained without `--pca-components` omit it entirely and
 * the raw feature vector is passed to the classifier unchanged.
 */
export interface PcaProjection {
  /** (n_features,) per-feature mean subtracted before projection. */
  mean: Float64Array;
  /** (n_components, n_features) row-major principal component vectors. */
  components: Float64Array;
  nComponents: number;
  nFeatures: number;
}

/** Project raw feature vectors through a fitted PCA basis: (x - mean) @ components.T. */
export function pcaProject(x: Float64Array, nSamples: number, pca: PcaProjection): Float64Array {
  const { mean, components, nComponents, nFeatures } = pca;
  const out = new Float64Array(nSamples * nComponents);
  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    for (let c = 0; c < nComponents; c++) {
      const comp = components.subarray(c * nFeatures, (c + 1) * nFeatures);
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) dot += (xi[f]! - mean[f]!) * comp[f]!;
      out[i * nComponents + c] = dot;
    }
  }
  return out;
}

/**
 * Between-class-mean reduction: projects onto the directions where digit-class
 * means differ most (rank <= n_classes - 1, equivalent to the between-class
 * scatter matrix used in LDA), optionally followed by ordinary PCA on the
 * residual (orthogonal-complement) variance. Mirrors Python's
 * `fit_class_mean_pca` exactly — `mean_of_means`/`between_components` come
 * from an SVD of the (small) matrix of per-label mean feature vectors, not
 * from the raw per-sample data.
 */
export interface ClassMeanReduction {
  meanOfMeans: Float64Array;          // (n_features,)
  betweenComponents: Float64Array;    // (n_between, n_features) row-major
  nBetween: number;
  nFeatures: number;
  /** Present only when trained with residual components > 0. */
  residualMean?: Float64Array;        // (n_features,)
  residualComponents?: Float64Array;  // (n_residual, n_features) row-major
  nResidual?: number;
}

export function classMeanProject(
  x: Float64Array, nSamples: number, reduction: ClassMeanReduction,
): Float64Array {
  const {
    meanOfMeans, betweenComponents, nBetween, nFeatures,
    residualMean, residualComponents, nResidual,
  } = reduction;
  const hasResidual = residualMean !== undefined && residualComponents !== undefined && nResidual !== undefined;
  const nOut = nBetween + (hasResidual ? nResidual : 0);
  const out = new Float64Array(nSamples * nOut);
  const centered = new Float64Array(nFeatures);
  const residual = new Float64Array(nFeatures);

  for (let i = 0; i < nSamples; i++) {
    const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
    for (let f = 0; f < nFeatures; f++) centered[f] = xi[f]! - meanOfMeans[f]!;

    for (let c = 0; c < nBetween; c++) {
      const comp = betweenComponents.subarray(c * nFeatures, (c + 1) * nFeatures);
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) dot += centered[f]! * comp[f]!;
      out[i * nOut + c] = dot;
    }

    if (!hasResidual) continue;

    // residual = centered - reconstruction(betweenProj) -- subtract each
    // between-class component's contribution back out before the second stage.
    residual.set(centered);
    for (let c = 0; c < nBetween; c++) {
      const comp = betweenComponents.subarray(c * nFeatures, (c + 1) * nFeatures);
      const coeff = out[i * nOut + c]!;
      for (let f = 0; f < nFeatures; f++) residual[f] = residual[f]! - coeff * comp[f]!;
    }
    for (let r = 0; r < nResidual; r++) {
      const comp = residualComponents.subarray(r * nFeatures, (r + 1) * nFeatures);
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) dot += (residual[f]! - residualMean[f]!) * comp[f]!;
      out[i * nOut + nBetween + r] = dot;
    }
  }
  return out;
}

export interface Recognition {
  label: number;
  confident: boolean;
  /** Second-most-likely label and its raw score, present whenever the
   *  classifier considered more than one candidate class. `score` is only
   *  meaningful as a within-prediction ranking — its scale differs between
   *  the template-matching fast path (TM_CCOEFF_NORMED, roughly -1..1) and
   *  the RBF fallback path (an OvO vote count, integer 0..nClasses-1). */
  runnerUp?: { label: number; score: number };
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
    let best2 = -1;
    for (let c = 0; c < nClasses; c++) {
      if (c === best) continue;
      if (best2 === -1 || votes[s * nClasses + c]! > votes[s * nClasses + best2]!) best2 = c;
    }
    // Normalise by (nClasses-1): max votes any class can receive in OVO, not total classifiers.
    const confident = votes[s * nClasses + best]! / (nClasses - 1) >= threshold;
    result.push({
      label: classes[best]!,
      confident,
      ...(best2 !== -1 ? { runnerUp: { label: classes[best2]!, score: votes[s * nClasses + best2]! } } : {}),
    });
  }
  return result;
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

export abstract class NumRecogniser {
  constructor(readonly confidenceThreshold: number) {}
  abstract readonly warpStrategy: WarpStrategy;
  abstract recognise(imgs: Uint8Array[], allowedLabels?: (ReadonlySet<number> | undefined)[]): Recognition[];

  warpForRecognition(cv: Cv, crop: RawDigitCrop, targetSize: number): Uint8Array {
    return warpRawDigitCrop(cv, crop, this.warpStrategy, targetSize);
  }
}

export class HogRecogniser extends NumRecogniser {
  constructor(
    private readonly hog: HOGParams,
    private readonly classifier: RBFClassifier,
    confidenceThreshold: number,
    readonly warpStrategy: WarpStrategy,
    private readonly pca?: PcaProjection,
    private readonly useAspectFeature: boolean = false,
    private readonly classMean?: ClassMeanReduction,
  ) {
    super(confidenceThreshold);
  }

  recognise(imgs: Uint8Array[]): Recognition[] {
    const n = imgs.length;
    const { hog, classifier, confidenceThreshold, pca, useAspectFeature, classMean } = this;
    const hogFeat = hogExtract(imgs, hog);
    const hole = extractHoleFeatures(imgs, hog.winSize);
    const nHog = hogFeat.length / n;
    const nHole = hole.length / n;
    const nAspect = useAspectFeature ? 1 : 0;
    const aspect = useAspectFeature ? extractAspectFeatures(imgs, hog.winSize) : undefined;
    let x: Float64Array<ArrayBufferLike> = new Float64Array(n * (nHog + nHole + nAspect));
    for (let i = 0; i < n; i++) {
      x.set(hogFeat.subarray(i * nHog, (i + 1) * nHog), i * (nHog + nHole + nAspect));
      x.set(hole.subarray(i * nHole, (i + 1) * nHole), i * (nHog + nHole + nAspect) + nHog);
      if (aspect !== undefined) x[i * (nHog + nHole + nAspect) + nHog + nHole] = aspect[i]!;
    }
    if (classMean !== undefined) x = classMeanProject(x, n, classMean);
    else if (pca !== undefined) x = pcaProject(x, n, pca);
    return rbfPredictWithConfidence(classifier, x, n, confidenceThreshold);
  }

}


/**
 * Which digit(s) can structurally appear at `digitIndex` of a `digitCount`-digit
 * cage total, given the cage's size. Enumerates every valid total in
 * cageSumRange(cageSize) with exactly digitCount digits and collects the digit
 * at that position. Falls back to unrestricted (0-9) if no valid total has
 * exactly digitCount digits -- a symptom of upstream detection being wrong,
 * which must degrade to "no restriction", never to an impossible-to-satisfy
 * empty set.
 */
export function allowedDigitsForPosition(
  cageSize: number, digitIndex: number, digitCount: number,
): ReadonlySet<number> {
  const [lo, hi] = cageSumRange(cageSize);
  const allowed = new Set<number>();
  for (let total = lo; total <= hi; total++) {
    const s = String(total);
    if (s.length !== digitCount) continue;
    allowed.add(Number(s[digitIndex]));
  }
  if (allowed.size === 0) {
    for (let d = 0; d <= 9; d++) allowed.add(d);
  }
  return allowed;
}

export interface TemplateMatch {
  templatePixels: Float64Array;   // (nTemplates * nFeatures,) row-major
  templateLabels: Int32Array;     // (nTemplates,)
  nTemplates: number;
  nFeatures: number;
}

/** Normalized cross-correlation between two equal-length pixel vectors. */
function normalizedCrossCorrelation(a: Float64Array, b: ArrayLike<number>, offset: number, len: number): number {
  let meanA = 0, meanB = 0;
  for (let i = 0; i < len; i++) { meanA += a[i]!; meanB += b[offset + i]!; }
  meanA /= len; meanB /= len;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < len; i++) {
    const da = a[i]! - meanA, db = b[offset + i]! - meanB;
    num += da * db; denomA += da * da; denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

export class PcaRecogniser extends NumRecogniser {
  constructor(
    private readonly classifier: RBFClassifier,
    confidenceThreshold: number,
    readonly warpStrategy: WarpStrategy,
    private readonly classMean: ClassMeanReduction,
    private readonly templates: TemplateMatch,
    private readonly templateThreshold: number,
    private readonly templateMargin: number,
  ) {
    super(confidenceThreshold);
  }

  recognise(imgs: Uint8Array[], allowedLabels?: (ReadonlySet<number> | undefined)[]): Recognition[] {
    const n = imgs.length;
    const nFeatures = this.templates.nFeatures;
    const x = new Float64Array(n * nFeatures);
    for (let i = 0; i < n; i++) {
      for (let f = 0; f < nFeatures; f++) x[i * nFeatures + f] = imgs[i]![f]!;
    }

    const results: Recognition[] = [];
    const rbfNeeded: number[] = [];
    const scores = new Float64Array(this.templates.nTemplates);
    for (let i = 0; i < n; i++) {
      const allowed = allowedLabels?.[i];
      const xi = x.subarray(i * nFeatures, (i + 1) * nFeatures);
      let best = -1, bestScore = -Infinity;
      for (let t = 0; t < this.templates.nTemplates; t++) {
        if (allowed !== undefined && !allowed.has(this.templates.templateLabels[t]!)) continue;
        const score = normalizedCrossCorrelation(xi, this.templates.templatePixels, t * nFeatures, nFeatures);
        scores[t] = score;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best === -1) {
        // Every template excluded -- shouldn't happen given
        // allowedDigitsForPosition's own empty-set fallback, but stay safe by
        // deferring to the (unrestricted) RBF fallback rather than crashing.
        results.push({ label: -1, confident: false });
        rbfNeeded.push(i);
        continue;
      }
      // Reject the fast path if a template from a *different* digit came
      // close to the winner -- a high raw score alone doesn't rule out a
      // near-tie against the wrong digit's template (e.g. an ambiguous "6"
      // scoring higher against digit 8's template than any digit-6 template).
      // See docs/image-pipeline.md's template-threshold note.
      const bestLabel = this.templates.templateLabels[best]!;
      let runnerUpScore = -Infinity;
      for (let t = 0; t < this.templates.nTemplates; t++) {
        if (this.templates.templateLabels[t] === bestLabel) continue;
        if (allowed !== undefined && !allowed.has(this.templates.templateLabels[t]!)) continue;
        if (scores[t]! > runnerUpScore) runnerUpScore = scores[t]!;
      }
      if (bestScore >= this.templateThreshold && bestScore - runnerUpScore >= this.templateMargin) {
        results.push({ label: bestLabel, confident: true });
      } else {
        results.push({ label: -1, confident: false }); // placeholder, replaced below
        rbfNeeded.push(i);
      }
    }

    if (rbfNeeded.length > 0) {
      const xRbf = new Float64Array(rbfNeeded.length * nFeatures);
      for (let k = 0; k < rbfNeeded.length; k++) {
        xRbf.set(x.subarray(rbfNeeded[k]! * nFeatures, (rbfNeeded[k]! + 1) * nFeatures), k * nFeatures);
      }
      const projected = classMeanProject(xRbf, rbfNeeded.length, this.classMean);
      const rbfResults = rbfPredictWithConfidence(this.classifier, projected, rbfNeeded.length, this.confidenceThreshold);
      for (let k = 0; k < rbfNeeded.length; k++) {
        results[rbfNeeded[k]!] = rbfResults[k]!;
      }
    }

    return results;
  }
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
export function hogExtract(imgs: Uint8Array[], params: HOGParams): Float64Array {
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

// ---------------------------------------------------------------------------
// Model loading from .bin + .json
// ---------------------------------------------------------------------------

let _active: NumRecogniser | null = null;

/** Registers rec as the recogniser splitNum/readClassicDigits use internally. */
export function setActiveRecogniser(rec: NumRecogniser): void { _active = rec; }

/** @internal exported only for the singleton-guard unit test. */
export function activeRecogniser(): NumRecogniser {
  if (_active === null) throw new Error('No recogniser loaded — call setActiveRecogniser() first');
  return _active;
}

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
  manifestJson: {
    classifier_type?: string;
    recogniser_type?: string;
    warp_strategy?: string;
    arrays: Record<string, { dtype: string; shape: number[]; offset: number; byteLength: number }>;
  },
): NumRecogniser {
  const classifierType = manifestJson.classifier_type;
  if (classifierType !== 'rbf') {
    throw new Error(`Unsupported classifier type: ${String(classifierType)}`);
  }
  const warpStrategy = manifestJson.warp_strategy;
  if (warpStrategy !== 'stretch' && warpStrategy !== 'letterbox' && warpStrategy !== 'letterbox-centered') {
    throw new Error(`Unsupported warp strategy: ${String(warpStrategy)}`);
  }

  const arrays = manifestJson.arrays;

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

  const classes = getI32('classes');
  const [nSv, nFeatures] = arrays['rbf_support_vectors']!.shape as [number, number];
  const classifier: RBFClassifier = {
    kind:           'rbf',
    supportVectors: getF64('rbf_support_vectors'),
    dualCoef:       getF64('rbf_dual_coef'),
    intercept:      getF64('rbf_intercept'),
    nSupport:       getI32('rbf_n_support'),
    gamma:          scalarF64('rbf_gamma'),
    classes,
    nClasses:       classes.length,
    nSv,
    nFeatures,
  };
  const confidenceThreshold = scalarF64('confidence_threshold');

  const recogniserType = manifestJson.recogniser_type ?? 'hog';

  if (recogniserType === 'pca') {
    const [nBetween, cmNFeatures] = arrays['cm_between_components']!.shape as [number, number];
    const classMean: ClassMeanReduction = {
      meanOfMeans:       getF64('cm_mean_of_means'),
      betweenComponents: getF64('cm_between_components'),
      nBetween,
      nFeatures:         cmNFeatures,
    };
    if (arrays['cm_residual_components'] !== undefined) {
      const [nResidual] = arrays['cm_residual_components']!.shape as [number, number];
      classMean.residualMean = getF64('cm_residual_mean');
      classMean.residualComponents = getF64('cm_residual_components');
      classMean.nResidual = nResidual;
    }
    const [nTemplates, templateNFeatures] = arrays['template_pixels']!.shape as [number, number];
    const templates: TemplateMatch = {
      templatePixels: getF64('template_pixels'),
      templateLabels: getI32('template_labels'),
      nTemplates,
      nFeatures: templateNFeatures,
    };
    // Empirically tuned (2026-08-01). A flat score threshold can't
    // distinguish "confidently right" from "confidently matches the wrong
    // digit's template" -- an earlier flat-threshold-only candidate (0.83,
    // no margin) passed its own sweep but a full corpus eval found 26 cells
    // (19 puzzles) of real "6" crops scoring higher against digit 8's
    // template than any digit-6 template. So acceptance also requires the
    // winning template's score to beat the best score from any *other*
    // digit's templates by templateMargin (a Lowe's-ratio-style ambiguity
    // check). (threshold, margin) was swept jointly against four sources:
    // corpus_train.json (4000 labeled samples, in-sample -- these generated
    // the templates), the 26 known digit-6/8 regressions, 103 hard cases of
    // a narrow-oval "0" font the RBF fallback used to mis-predict as
    // 6/8/9/3, and -- for real statistical power -- ~92k crops pulled from
    // every cell of every corpus puzzle that solved cleanly under a prior
    // run (a misread cage-total or given digit almost never lets a killer
    // sudoku solve to a unique, consistent grid, so a clean solve is strong
    // evidence every digit in it was read correctly; this set is disjoint
    // from the training data that built the templates, but structurally
    // excludes the exact hard boundary cases since those broke their
    // puzzle's solve -- it validates precision at scale, not recall).
    // 0.74/0.04 has zero errors across all four sources (0/~84k weak-labeled
    // accepts, 0/26 regressions, 0/4000 in-sample) while recovering 101/103
    // (98%) of the digit-0 fix, and sits right at the edge of the
    // zero-error frontier -- 0.72/0.04 already shows 108 weak-labeled
    // errors, so this isn't a fluke of a narrow window. See
    // docs/image-pipeline.md's template-threshold note for the full
    // analysis.
    const templateThreshold = 0.74;
    const templateMargin = 0.04;
    return new PcaRecogniser(classifier, confidenceThreshold, warpStrategy, classMean, templates, templateThreshold, templateMargin);
  }

  const hog: HOGParams = {
    winSize:     scalarI32('hog_win_size'),
    cellSize:    scalarI32('hog_cell_size'),
    blockSize:   scalarI32('hog_block_size'),
    blockStride: scalarI32('hog_block_stride'),
    nbins:       scalarI32('hog_nbins'),
  };

  let pca: PcaProjection | undefined;
  if (arrays['pca_components'] !== undefined) {
    const [nComponents, pcaNFeatures] = arrays['pca_components']!.shape as [number, number];
    pca = {
      mean:       getF64('pca_mean'),
      components: getF64('pca_components'),
      nComponents,
      nFeatures:  pcaNFeatures,
    };
  }

  let classMean: ClassMeanReduction | undefined;
  if (arrays['cm_between_components'] !== undefined) {
    const [nBetween, cmNFeatures] = arrays['cm_between_components']!.shape as [number, number];
    classMean = {
      meanOfMeans:       getF64('cm_mean_of_means'),
      betweenComponents: getF64('cm_between_components'),
      nBetween,
      nFeatures:         cmNFeatures,
    };
    if (arrays['cm_residual_components'] !== undefined) {
      const [nResidual] = arrays['cm_residual_components']!.shape as [number, number];
      classMean.residualMean = getF64('cm_residual_mean');
      classMean.residualComponents = getF64('cm_residual_components');
      classMean.nResidual = nResidual;
    }
  }

  const useAspectFeature = arrays['use_aspect_feature'] !== undefined && scalarI32('use_aspect_feature') === 1;

  return new HogRecogniser(
    hog, classifier, confidenceThreshold, warpStrategy, pca, useAspectFeature, classMean,
  );
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
 * check). Shared by contourIsNumber and production digit extraction.
 * contourIsNumber also applies the vertical-position check needed to exclude
 * centred solution digits during board-wide live recognition.
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
      const children = contourHier(cv, contours, hierarchy, seen, child);
      c.delete();
      ret.push([brTuple, children]);
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
  for (const [br, ds] of chier) {
    if (contourIsNumber(br, subres)) {
      ret.push([br, ds]);
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


/** Copy an untouched digit bounding box from the already-warped puzzle grid. */
export function extractRawDigitCrop(
  cv: Cv,
  warpedGrid: OpenCVMat,
  rect: readonly [x: number, y: number, width: number, height: number],
): RawDigitCrop {
  const [x, y, width, height] = rect;
  if (width <= 0 || height <= 0) {
    throw new Error(`extractRawDigitCrop: dimensions must be positive, got [${rect.join(',')}]`);
  }
  if (x < 0 || y < 0 || x + width > warpedGrid.cols || y + height > warpedGrid.rows) {
    throw new Error(
      `extractRawDigitCrop: rectangle [${rect.join(',')}] is outside grid bounds ${warpedGrid.cols}x${warpedGrid.rows}`,
    );
  }

  const roi = warpedGrid.roi(new cv.Rect(x, y, width, height));
  const contiguous = roi.clone();
  roi.delete();
  const pixels = new Uint8Array(contiguous.data);
  contiguous.delete();
  return { x, y, width, height, pixels };
}

/** Apply one named production warp to a strategy-neutral raw digit crop. */
export function warpRawDigitCrop(
  cv: Cv,
  crop: RawDigitCrop,
  strategy: WarpStrategy,
  targetSize: number = 64,
): Uint8Array {
  if (crop.width <= 0 || crop.height <= 0) {
    throw new Error(`warpRawDigitCrop: crop dimensions must be positive, got ${crop.width}x${crop.height}`);
  }
  if (crop.pixels.length !== crop.width * crop.height) {
    throw new Error(
      `warpRawDigitCrop: expected ${crop.width * crop.height} pixels, got ${crop.pixels.length}`,
    );
  }
  if (targetSize <= 0) {
    throw new Error(`warpRawDigitCrop: target size must be positive, got ${targetSize}`);
  }

  const source = cv.matFromArray(crop.height, crop.width, cv.CV_8UC1, Array.from(crop.pixels));
  try {
    if (strategy === 'stretch') {
      const src = [[0, 0], [crop.width, 0], [crop.width, crop.height], [0, crop.height]];
      return getWarpFromRect(cv, src, source, targetSize, targetSize);
    }
    const letterboxed = letterboxWarp(cv, 0, 0, crop.width, crop.height, source, targetSize, targetSize);
    if (strategy === 'letterbox-centered') {
      return centerByCentroid(letterboxed, targetSize);
    }
    return letterboxed;
  } finally {
    source.delete();
  }
}

/**
 * Aspect-preserving warp: fits the source rect into resH×resW with letterbox
 * padding (centered, background-filled) rather than direct-stretch.
 *
 * Restored verbatim from git history (commit 701423a^, before it was replaced
 * by renderContourMask and later getWarpFromRect) for HogRecogniser, which was
 * trained on this crop geometry.
 */
function letterboxWarp(
  cv: Cv, ax: number, ay: number, bw: number, bh: number,
  gry: OpenCVMat, resH: number = 64, resW: number = 64,
): Uint8Array {
  const scale = Math.min((resW - 1) / bw, (resH - 1) / bh);
  const destW = bw * scale, destH = bh * scale;
  const offX = ((resW - 1) - destW) / 2, offY = ((resH - 1) - destH) / 2;
  const src = [[ax, ay], [ax + bw, ay], [ax + bw, ay + bh], [ax, ay + bh]];
  const dst = [[offX, offY], [offX + destW, offY], [offX + destW, offY + destH], [offX, offY + destH]];
  return getWarpFromRect(cv, src, gry, resH, resW, dst);
}

/**
 * Shift a square grayscale image so its ink center of mass lands at the
 * canvas center, via integer pixel translation (no interpolation, no
 * resampling — avoids introducing new blur/aliasing). Pixels shifted off
 * the edge are dropped; pixels shifted in from off-canvas are filled with 0.
 * A no-ink image (all zero) is returned unchanged (no centroid to align to).
 */
export function centerByCentroid(img: Uint8Array, size: number): Uint8Array {
  let sx = 0, sy = 0, mass = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = img[y * size + x]!;
      if (v > 0) { sx += x * v; sy += y * v; mass += v; }
    }
  }
  if (mass === 0) return img;

  const cx = sx / mass, cy = sy / mass;
  const canvasCenter = (size - 1) / 2;
  const dx = Math.round(canvasCenter - cx);
  const dy = Math.round(canvasCenter - cy);
  if (dx === 0 && dy === 0) return img;

  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const sy2 = y - dy;
    if (sy2 < 0 || sy2 >= size) continue;
    for (let x = 0; x < size; x++) {
      const sx2 = x - dx;
      if (sx2 < 0 || sx2 >= size) continue;
      out[y * size + x] = img[sy2 * size + sx2]!;
    }
  }
  return out;
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
    // Row index of the strongest pixel in this column, not the first nonzero
    // one: matches np.argmax(warped_blk[y:y+h, x:x+w], axis=0) exactly,
    // including its "first occurrence of the max" tie-break. warpedBlk isn't
    // strictly binary here -- INTER_LINEAR perspective warp antialiases glyph
    // edges into a 0-255 continuum, so a faint fringe pixel can be nonzero
    // one row above the column's true (saturated) ink; using ">0" there
    // instead of the true per-column max desyncs this profile from Python's
    // and silently corrupts downstream peak detection for some digits.
    let bestVal = data[y * width + (x + dx)]!;
    let bestIdx = 0;
    for (let dy = 1; dy < h; dy++) {
      const v = data[(y + dy) * width + (x + dx)]!;
      if (v > bestVal) { bestVal = v; bestIdx = dy; }
    }
    ys[dx] = bestIdx;
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
): [Uint8Array[], RawDigitCrop[], number, number] {
  const [x, y, w, h] = br;

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
  const rec = activeRecogniser();
  const sourceCrops = rects.map(([yt, yb, xl, xr]) =>
    extractRawDigitCrop(cv, warpedBlk, [xl, yt, xr - xl, yb - yt]),
  );
  const thumbs = sourceCrops.map(crop => rec.warpForRecognition(cv, crop, halfRes));

  return [thumbs, sourceCrops, x, y];
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
  subres: number,
  classicConf: number[][],
): {
  digits: number[][];
  thumbs: Map<string, Uint8Array[]>;
  sourceCrops: Map<string, RawDigitCrop[]>;
  recognitions: Map<string, Recognition>;
} {
  const rec = activeRecogniser();
  const half = subres >> 1;
  const margin = subres >> 2;
  const digits: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const thumbs = new Map<string, Uint8Array[]>();
  const sourceCrops = new Map<string, RawDigitCrop[]>();
  const recognitions = new Map<string, Recognition>();

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
      const sourceCrop = extractRawDigitCrop(cv, warpedBlk, [ax, ay, br.width, br.height]);
      const thumb = rec.warpForRecognition(cv, sourceCrop, half);
      const [rec0] = rec.recognise([thumb]);
      const d = rec0!.label;
      if (d > 0) {
        const key = `${r},${c}`;
        digits[r]![c] = d;
        thumbs.set(key, [thumb]);
        sourceCrops.set(key, [sourceCrop]);
        recognitions.set(key, rec0!);
      }
    }
  }

  return { digits, thumbs, sourceCrops, recognitions };
}
