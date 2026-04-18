/**
 * Configuration interfaces for the image processing pipeline.
 *
 * Mirrors Python's `killer_sudoku.image.config` module. All interfaces are
 * readonly (frozen) with default factory functions. Computed properties
 * are provided as plain functions rather than class getters to stay idiomatic
 * TypeScript.
 */

/** Parameters for contour-based grid detection. */
export interface GridLocationConfig {
  /**
   * Subtracted from the histogram-valley estimate of the darkest significant
   * tone to tighten the threshold and avoid classifying mid-tone paper as
   * grid ink.
   */
  readonly isblackOffset: number;
}

export function defaultGridLocationConfig(): GridLocationConfig {
  return { isblackOffset: 56 };
}

/** Parameters for cage border detection. */
export interface BorderDetectionConfig {
  /** C offset for cv2.adaptiveThreshold. */
  readonly adaptiveC: number;
  /**
   * Strip half-width divisor: half_width = subres // sampleFraction pixels.
   */
  readonly sampleFraction: number;
  /**
   * Strip end inset divisor: margin = subres // sampleMargin pixels from each
   * end. Removes pixels at both ends of the strip to avoid sampling digit ink
   * in adjacent cells.
   */
  readonly sampleMargin: number;
}

export function defaultBorderDetectionConfig(): BorderDetectionConfig {
  return { adaptiveC: 0, sampleFraction: 4, sampleMargin: 16 };
}

/** Parameters for digit/number recognition. */
export interface NumberRecognitionConfig {
  /** Pixels per cell side for the warped sub-image. */
  readonly subres: number;
  /** SVM regularisation parameter C. */
  readonly svmC: number;
  /** SVM kernel coefficient; 'scale' = 1/(n_features * X.var()). */
  readonly svmGamma: string;
  /** Minimum template-match score; below this the SVM fallback runs. */
  readonly templateThreshold: number;
  /**
   * C offset for adaptive threshold fallback: used when the primary
   * contour-based detection produces a cage-total sum outside [360, 450].
   */
  readonly contourFallbackAdaptiveC: number;
}

export function defaultNumberRecognitionConfig(): NumberRecognitionConfig {
  return {
    subres: 128,
    svmC: 5.0,
    svmGamma: 'scale',
    templateThreshold: 0.85,
    contourFallbackAdaptiveC: 20,
  };
}

/** Parameters for Stage 3: lightweight per-cell classification. */
export interface CellScanConfig {
  /**
   * Minimum contour dimension as a fraction of subres for classic digit
   * detection. A pre-filled digit occupies at least one-third of the cell.
   */
  readonly classicMinSizeFraction: number;
  /**
   * Minimum cage_total_confidence for a cell to contribute positive border
   * anchors.
   */
  readonly anchorConfidenceThreshold: number;
  /**
   * Minimum dominant-quadrant ink fraction for killer puzzle classification.
   */
  readonly tlFractionThreshold: number;
  /**
   * Minimum dominant-quadrant fraction to trigger orientation correction.
   */
  readonly rotationDominanceThreshold: number;
}

export function defaultCellScanConfig(): CellScanConfig {
  return {
    classicMinSizeFraction: 1.0 / 3.0,
    anchorConfidenceThreshold: 0.5,
    tlFractionThreshold: 0.40,
    rotationDominanceThreshold: 0.50,
  };
}

/** Parameters for Stage 4: format-agnostic anchored border clustering. */
export interface BorderClusteringConfig {
  /** Strip half-width divisor: half_width = subres // sampleFraction pixels. */
  readonly sampleFraction: number;
  /**
   * Strip end inset divisor: margin = subres // sampleMargin pixels from each
   * end. Removes pixels at both ends of the strip to avoid sampling digit ink
   * in adjacent cells.
   */
  readonly sampleMargin: number;
}

export function defaultBorderClusteringConfig(): BorderClusteringConfig {
  return { sampleFraction: 4, sampleMargin: 16 };
}

// ---------------------------------------------------------------------------
// Global config instance — set once at app startup, read everywhere.
// ---------------------------------------------------------------------------

let _config: ImagePipelineConfig | null = null;

/**
 * Set the image pipeline config for the session.
 * Must be called before any pipeline function is invoked.
 * Subsequent calls overwrite the previous config (useful for testing).
 */
export function setImagePipelineConfig(cfg: ImagePipelineConfig): void {
  _config = cfg;
}

/**
 * Read the current global image pipeline config.
 * Falls back to the default if setImagePipelineConfig has not been called.
 */
export function getImagePipelineConfig(): ImagePipelineConfig {
  return _config ?? (_config = defaultImagePipelineConfig());
}

// ---------------------------------------------------------------------------

/** Top-level configuration for the image processing pipeline. */
export interface ImagePipelineConfig {
  readonly gridLocation: GridLocationConfig;
  readonly borderDetection: BorderDetectionConfig;
  readonly numberRecognition: NumberRecognitionConfig;
  readonly cellScan: CellScanConfig;
  readonly borderClustering: BorderClusteringConfig;
}

export function defaultImagePipelineConfig(): ImagePipelineConfig {
  return {
    gridLocation: defaultGridLocationConfig(),
    borderDetection: defaultBorderDetectionConfig(),
    numberRecognition: defaultNumberRecognitionConfig(),
    cellScan: defaultCellScanConfig(),
    borderClustering: defaultBorderClusteringConfig(),
  };
}

/** Sub-resolution for cell images (pixels per cell side). */
export function subres(cfg: ImagePipelineConfig): number {
  return cfg.numberRecognition.subres;
}

/** Full grid resolution in pixels (gridSize * subres). */
export function resolution(cfg: ImagePipelineConfig, gridSize = 9): number {
  return gridSize * subres(cfg);
}

/**
 * Adaptive threshold block size derived from subres.
 * Computed as (subres // 4) | 1 to ensure the value is always odd,
 * as required by cv2.adaptiveThreshold.
 */
export function adaptiveBlockSize(cfg: ImagePipelineConfig): number {
  return (subres(cfg) >> 2) | 1;
}
