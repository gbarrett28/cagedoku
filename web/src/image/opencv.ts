/**
 * TypeScript interface for the subset of the OpenCV.js module used by the
 * image pipeline.
 *
 * OpenCV.js is loaded at runtime as a WASM module; there is no official
 * @types/opencv package.  This file defines only the methods and constants
 * actually called in the codebase so that accidental typos and wrong argument
 * counts become compile-time errors rather than silent runtime crashes.
 *
 * All types are intentionally minimal — only the shape of objects that the
 * image pipeline reads is described.
 */

// ---------------------------------------------------------------------------
// OpenCV object types
// ---------------------------------------------------------------------------

/** An OpenCV Mat (multi-dimensional dense array). */
export interface OpenCVMat {
  /** Number of rows. */
  readonly rows: number;
  /** Number of columns. */
  readonly cols: number;
  /** Raw pixel data (uint8 view). */
  readonly data: Uint8Array;
  /** Raw pixel data (int32 view) — use this for hierarchy access instead of intAt. */
  readonly data32S: Int32Array;
  /** Raw pixel data (float32 view). */
  readonly data32F: Float32Array;
  /** Number of channels per element. */
  channels(): number;
  /** Return a sub-region Mat (shares memory; caller must delete). */
  roi(rect: OpenCVRect): OpenCVMat;
  /** Deep copy. */
  clone(): OpenCVMat;
  /** Free native memory. Must be called exactly once when done. */
  delete(): void;
}

/** An OpenCV MatVector (variable-length list of Mats). */
export interface OpenCVMatVector {
  size(): number;
  get(index: number): OpenCVMat;
  push_back(mat: OpenCVMat): void;
  delete(): void;
}

/** An OpenCV Scalar (up to 4-channel constant value). */
export interface OpenCVScalar {
  // Opaque; only used as an argument to drawing/border functions.
}

/** An OpenCV Size (width × height). */
export interface OpenCVSize {
  readonly width: number;
  readonly height: number;
}

/** An OpenCV Rect (axis-aligned bounding rectangle). */
export interface OpenCVRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Return value of minMaxLoc. */
export interface OpenCVMinMaxLoc {
  readonly minVal: number;
  readonly maxVal: number;
  readonly minLoc: { readonly x: number; readonly y: number };
  readonly maxLoc: { readonly x: number; readonly y: number };
}

// ---------------------------------------------------------------------------
// The OpenCV module interface
// ---------------------------------------------------------------------------

/**
 * The OpenCV.js module object resolved from `window.cv` after WASM init.
 *
 * Constructor types are expressed as interfaces with `new()` signatures so
 * callers can write `new cv.Mat()`, `new cv.Scalar(0)`, etc.
 */
export interface OpenCVModule {
  // -------------------------------------------------------------------
  // Constructors
  // -------------------------------------------------------------------

  readonly Mat: {
    new(): OpenCVMat;
    new(rows: number, cols: number, type: number): OpenCVMat;
    /** Fill all channels with the given Scalar. */
    new(rows: number, cols: number, type: number, scalar: OpenCVScalar): OpenCVMat;
  };
  readonly MatVector: { new(): OpenCVMatVector };
  readonly Scalar: { new(...values: number[]): OpenCVScalar };
  readonly Size: { new(width: number, height: number): OpenCVSize };
  readonly Rect: { new(x: number, y: number, width: number, height: number): OpenCVRect };

  // -------------------------------------------------------------------
  // Factory functions
  // -------------------------------------------------------------------

  /** Create a Mat from an ImageData (RGBA → CV_8UC4). */
  matFromImageData(imageData: ImageData): OpenCVMat;
  /** Create a Mat from a flat number array. */
  matFromArray(rows: number, cols: number, type: number, data: number[]): OpenCVMat;

  // -------------------------------------------------------------------
  // Image processing
  // -------------------------------------------------------------------

  /** Convert image colour space. */
  cvtColor(src: OpenCVMat, dst: OpenCVMat, code: number): void;
  /** Upscale by ×2 (Gaussian pyramid). */
  pyrUp(src: OpenCVMat, dst: OpenCVMat): void;
  /** Add a constant-coloured border. */
  copyMakeBorder(
    src: OpenCVMat, dst: OpenCVMat,
    top: number, bottom: number, left: number, right: number,
    borderType: number, value: OpenCVScalar,
  ): void;
  /** Adaptive thresholding. */
  adaptiveThreshold(
    src: OpenCVMat, dst: OpenCVMat,
    maxVal: number, adaptiveMethod: number, thresholdType: number,
    blockSize: number, C: number,
  ): void;
  /** Set dst[i] = 255 if lowerb[i] <= src[i] <= upperb[i], else 0. */
  inRange(src: OpenCVMat, lowerb: OpenCVMat | OpenCVScalar, upperb: OpenCVMat | OpenCVScalar, dst: OpenCVMat): void;
  /** Apply perspective warp. */
  warpPerspective(
    src: OpenCVMat, dst: OpenCVMat, M: OpenCVMat, dsize: OpenCVSize, flags?: number,
  ): void;
  /** Compute the perspective transform matrix from 4-point correspondences. */
  getPerspectiveTransform(src: OpenCVMat, dst: OpenCVMat): OpenCVMat;

  // -------------------------------------------------------------------
  // Contour analysis
  // -------------------------------------------------------------------

  /** Find contours in a binary image. */
  findContours(
    image: OpenCVMat, contours: OpenCVMatVector, hierarchy: OpenCVMat,
    mode: number, method: number,
  ): void;
  /** Contour area in pixels. */
  contourArea(contour: OpenCVMat): number;
  /** Contour perimeter. */
  arcLength(curve: OpenCVMat, closed: boolean): number;
  /** Approximate a contour with a simpler polygon. */
  approxPolyDP(curve: OpenCVMat, approxCurve: OpenCVMat, epsilon: number, closed: boolean): void;
  /** Axis-aligned bounding rect of a contour. */
  boundingRect(points: OpenCVMat): OpenCVRect;
  /** Draw contours into an image. */
  drawContours(
    image: OpenCVMat, contours: OpenCVMatVector,
    contourIdx: number, color: OpenCVScalar, thickness?: number,
  ): void;

  // -------------------------------------------------------------------
  // Template matching
  // -------------------------------------------------------------------

  /** Slide a template over an image and compute match scores. */
  matchTemplate(image: OpenCVMat, templ: OpenCVMat, result: OpenCVMat, method: number): void;
  /** Find the minimum and maximum values in a single-channel Mat. */
  minMaxLoc(src: OpenCVMat): OpenCVMinMaxLoc;

  // -------------------------------------------------------------------
  // Constants — colour conversion
  // -------------------------------------------------------------------
  readonly COLOR_RGBA2GRAY: number;
  readonly COLOR_BGR2RGBA: number;
  readonly COLOR_GRAY2RGBA: number;

  // -------------------------------------------------------------------
  // Constants — border
  // -------------------------------------------------------------------
  readonly BORDER_CONSTANT: number;

  // -------------------------------------------------------------------
  // Constants — adaptive threshold
  // -------------------------------------------------------------------
  readonly ADAPTIVE_THRESH_MEAN_C: number;
  readonly THRESH_BINARY_INV: number;

  // -------------------------------------------------------------------
  // Constants — contour retrieval / approximation
  // -------------------------------------------------------------------
  readonly RETR_EXTERNAL: number;
  readonly RETR_TREE: number;
  readonly CHAIN_APPROX_SIMPLE: number;

  // -------------------------------------------------------------------
  // Constants — warp interpolation
  // -------------------------------------------------------------------
  readonly INTER_LINEAR: number;

  // -------------------------------------------------------------------
  // Constants — Mat types
  // -------------------------------------------------------------------
  readonly CV_8UC1: number;
  readonly CV_8UC4: number;
  readonly CV_32FC1: number;
  readonly CV_32FC2: number;
  readonly CV_32SC2: number;

  // -------------------------------------------------------------------
  // Constants — template matching methods
  // -------------------------------------------------------------------
  readonly TM_CCOEFF_NORMED: number;
}
