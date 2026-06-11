/**
 * Session actions — replaces all Python `fetch('/api/puzzle/...')` calls.
 *
 * Each function reads/writes the in-memory store directly and calls the
 * TS engine helpers instead of making network requests. The function
 * signatures and return shapes mirror the Python API so that the adapted
 * main.ts can call them as drop-in replacements.
 */

import { solve, BoardState, KillerBoardState, SolveResult } from '../engine/index.js';
import { mrvBacktrack } from '../engine/backtracker.js';
import { solSums, solDiffs } from '../solver/equation.js';
import type { DiffSolution } from '../solver/equation.js';
import { defaultRules } from '../engine/rules/index.js';

import { cageSumRange, cellKey, keyToCell } from '../engine/types.js';
import type { Cell } from '../engine/types.js';
import { parsePuzzleImage, ImageDecodeError, GridNotFoundError } from '../image/inpImage.js';
import { UserFacingError } from './errors.js';
import { AssertionViolation, validateSudokuSolution } from './assertions.js';
import { formatActionLog } from './actionLog.js';

import type { ParseResult } from '../image/inpImage.js';
import { defaultImagePipelineConfig } from '../image/config.js';
import { validateCageLayout, hasMultipleCageTotals } from '../image/validation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import {
  buildEngine,
  applyAutoPlacements,
  applyNextAutoPlacement,
  recordTurn,
  rebuildUserGrid,
  userRemoved,
  userVirtualCages,
  findLastConsistentTurnIdx,
} from './engine.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  specToCageStates,
  cageStatesToSpec,
  specToData,
  classicSyntheticSpec,
  virtualCageKey,
  virtualCageKeyFromCage,
  solutionKey,
} from './specUtils.js';
import { getState, setState, getCV, getRec, getSplitRec } from './store.js';
import { PuzzleState } from './types.js';
import type {
  CandidatesResponse,
  HintItem,
  HintsResponse,
  KillerPuzzleState,
  RuleInfo,
  SettingsResponse,
  SolveResponse,
  Turn,
  UserAction,
  VirtualCage,
  VirtualCageSuggestion,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 1–9 each appear 9 times → the only valid sum for a full 9×9 sudoku grid. */
const GRID_TOTAL_SUM = 405;

/** Intersection of all sets, returned as a sorted array. */
function intersectAll(sets: ReadonlySet<number>[]): number[] {
  if (sets.length === 0) return [];
  return [...sets[0]!].filter(d => sets.every(s => s.has(d))).sort((a, b) => a - b);
}

/** Lexicographic comparator for sorted digit arrays. */
function lexCompare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; if (d !== 0) return d; }
  return 0;
}

/**
 * All valid digit combinations for an n-cell cage summing to total,
 * each sorted ascending, the list sorted lexicographically.
 */
function allCageSolutions(cellCount: number, total: number): readonly (readonly number[])[] {
  return [...solSums(cellCount, 0, total)]
    .map(s => [...s].sort((a, b) => a - b))
    .sort(lexCompare);
}

/**
 * Toggles a sorted digit combination in a list of eliminated solutions.
 * The solution is normalised (sorted) before comparison and storage.
 */
function toggleSolution(
  list: readonly (readonly number[])[],
  soln: readonly number[],
): readonly (readonly number[])[] {
  const sorted = [...soln].sort((a, b) => a - b);
  const key = sorted.join(',');
  const idx = list.findIndex(s => solutionKey(s) === key);
  return idx >= 0 ? list.filter((_, i) => i !== idx) : [...list, sorted];
}

function requireState(): PuzzleState {
  const s = getState();
  if (s === null) throw new Error('No active session');
  return s;
}

function requireConfirmed(): PuzzleState {
  const s = requireState();
  if (s.userGrid === null) throw new Error('Session not yet confirmed');
  return s;
}

// ---------------------------------------------------------------------------
// Image upload & OCR
// ---------------------------------------------------------------------------

export interface UploadResult {
  state: PuzzleState;
  warpedImageUrl: string | null;
  warning: string | null;
  cellThumbs: ReadonlyMap<string, Uint8Array[]>;
  mergedThumbs: ReadonlyMap<string, Uint8Array>;
}

/**
 * Build a PuzzleState directly from a PuzzleSpec, bypassing the image pipeline.
 *
 * Used in dev/test mode to exercise the full review→confirm→playing UI flow
 * without requiring OpenCV or a real puzzle image.
 */
export function loadSpecDirect(spec: PuzzleSpec): UploadResult {
  const settings = loadSettings();
  const state = PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [...settings.alwaysApplyRules], null, null);
  setState(state);
  return { state, warpedImageUrl: null, warning: null, cellThumbs: new Map(), mergedThumbs: new Map() };
}

/**
 * Build a PuzzleState for a Classic puzzle, bypassing the image pipeline.
 *
 * Used in dev/test mode via the `__testLoad('classic')` hook. The caller
 * must pass a 9×9 given-digits grid (0 = blank cell). The resulting state has
 * no cage data at all, so cage display is naturally suppressed.
 */
export function loadClassicDirect(givenDigits: readonly (readonly number[])[]): UploadResult {
  const settings = loadSettings();
  const state = PuzzleState.createClassic(givenDigits.map(row => [...row]), [...settings.alwaysApplyRules], null);
  setState(state);
  return {
    state,
    warpedImageUrl: null,
    warning: 'Review the detected digits and press Confirm & Solve',
    cellThumbs: new Map(),
    mergedThumbs: new Map(),
  };
}

/**
 * Runs the image pipeline on the given File, creates a PuzzleState in the
 * store, and returns the result for rendering. Replaces POST /api/puzzle.
 */
export async function uploadPuzzle(file: File): Promise<UploadResult> {
  const cv = getCV();
  const rec = getRec();
  if (cv === null || rec === null) throw new Error('Image pipeline not loaded — call loadCV() and loadRec() first');

  const config = defaultImagePipelineConfig();
  let result: ParseResult;
  try {
    result = await parsePuzzleImage(cv, file, rec, config, getSplitRec() ?? undefined);
  } catch (e) {
    if (e instanceof ImageDecodeError || e instanceof GridNotFoundError) throw e;
    // Any other pipeline error → proceed to review with blank grid.
    result = {
      spec: null,
      specError: `Image pipeline failed: ${String(e)}`,
      puzzleType: 'killer',
      givenDigits: null,
      warpedImageData: null,
      cellThumbs: new Map(),
      mergedThumbs: new Map(),
    };
  }

  const originalImageUrl = await fileToDisplayUrl(file);
  const { state, warpedImageUrl, warning } = await buildStateFromParseResult(result, originalImageUrl);
  return { state, warpedImageUrl, warning, cellThumbs: result.cellThumbs, mergedThumbs: result.mergedThumbs };
}

/**
 * Re-runs the image pipeline on the original file using user-adjusted corners,
 * skipping grid detection (Stage 1). Updates the store and returns a new UploadResult.
 *
 * @param file - The original uploaded image file.
 * @param corners - Adjusted grid corners in original-image pixel space.
 * @param originalImageData - The decoded original image (from the initial uploadPuzzle call).
 */

/**
 * Produce a perspective-warped preview image from user-adjusted corners.
 * Returns null if the image pipeline isn't loaded or imageData is not available.
 */

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** For PDFs, <img> cannot render a PDF data URL, so we render page 1 to a JPEG
 *  using an HTMLCanvasElement (which has toDataURL). Returns null on failure. */
async function fileToDisplayUrl(file: File): Promise<string | null> {
  if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
    return fileToDataUrl(file);
  }
  try {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
    GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocument({ data, verbosity: 0 }).promise;
    try {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      await pdf.destroy();
    }
  } catch (e) {
    console.warn('[fileToDisplayUrl] PDF preview render failed', e);
    return null;
  }
}

/**
 * Runs the full solver on spec and validates the result.
 *
 * Returns null if the solution is valid (all 81 cells filled, no duplicate
 * digits in any row, column, or box). Returns a human-readable description of
 * the first problem found if the solution is invalid — e.g. unsolved cells
 * (wrong cage totals preventing the solver from placing a digit) or duplicate
 * digits (cage rules double-placing a digit due to an OCR error).
 *
 * Used to detect corrupted cage totals at OCR-time.
 */
export function solveAndValidateSpec(spec: PuzzleSpec): string | null {
  const { board } = solve(spec);
  return extractAndValidateSolution(board);
}

/**
 * Extracts a tentative 9×9 solution grid from a board and validates it.
 *
 * Cells with more than one candidate are recorded as 0 (unsolved).
 * Returns null if valid, or a human-readable error string if the solution
 * has unsolved cells or duplicate digits in any unit.
 *
 * Used as the confirm-time guard to block corrupted puzzles before they reach
 * the playing screen.
 */
export function extractAndValidateSolution(board: BoardState): string | null {
  const grid: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      const cands = board.cands(r, c);
      return cands.size === 1 ? [...cands][0]! : 0;
    }),
  );
  return validateSudokuSolution(grid);
}

async function buildStateFromParseResult(
  result: ParseResult,
  originalImageUrl: string | null,
): Promise<{ state: PuzzleState; warpedImageUrl: string | null; warning: string | null }> {
  let warpedImageUrl: string | null = null;
  if (result.warpedImageData !== null) {
    const offscreen = new OffscreenCanvas(result.warpedImageData.width, result.warpedImageData.height);
    offscreen.getContext('2d')!.putImageData(result.warpedImageData, 0, 0);
    const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    warpedImageUrl = URL.createObjectURL(blob);
  }

  const settings = loadSettings();
  let spec = result.spec;
  let warning = result.specError;

  if (spec === null) {
    warning = (warning ? warning + ' ' : '') + 'Cage layout could not be detected — starting with a blank grid.';
    const blankBorderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
    const blankBorderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
    const blankTotals  = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    blankTotals[0]![0] = 1; // placeholder cage head at row=0, col=0
    const blankRegions = Array.from({ length: 9 }, () => new Array<number>(9).fill(1));
    spec = { regions: blankRegions, cageTotals: blankTotals, borderX: blankBorderX, borderY: blankBorderY };
  }

  // Structural check (O(81), no solver) before the expensive solver validation.
  // hasMultipleCageTotals detects two cage-head cells in the same region — a
  // specific OCR error where a digit was read from an adjacent cage. When it fires,
  // the solver is skipped and a more specific message is shown.
  if (result.spec !== null) {
    const structuralError = hasMultipleCageTotals(spec);
    const validityError = structuralError ?? solveAndValidateSpec(spec);
    if (validityError !== null) {
      const msg =
        `Puzzle appears to have invalid cage totals — an OCR digit may be wrong ` +
        `(${validityError}). Check the totals carefully before confirming.`;
      warning = warning ? msg + ' ' + warning : msg;
    }
  }

  const state: PuzzleState = result.puzzleType === 'killer'
    ? PuzzleState.createKiller(specToData(spec), specToCageStates(spec), [...settings.alwaysApplyRules], originalImageUrl, warpedImageUrl)
    : PuzzleState.createClassic(result.givenDigits, [...settings.alwaysApplyRules], originalImageUrl);

  setState(state);
  return { state, warpedImageUrl, warning };
}

// ---------------------------------------------------------------------------
// Cage total editing (pre-confirm)
// ---------------------------------------------------------------------------

/**
 * Corrects the OCR-detected total for a named cage. Replaces PATCH /cage/:label.
 */
export function patchCage(label: string, total: number): PuzzleState {
  const state = requireState();
  if (!PuzzleState.isKiller(state)) throw new Error('patchCage requires a killer puzzle state');
  const upper = label.toUpperCase();
  const newCages = state.cageStates.map(c =>
    c.label === upper ? { ...c, total } : c,
  );
  const updated = { ...state, cageStates: newCages };
  setState(updated);
  return updated;
}

/**
 * Toggle a cage border in the review spec, then rebuild the cage structure.
 *
 * axis='X': horizontal border — borderX[col][rowGap] between rows rowGap and rowGap+1.
 * axis='Y': vertical border  — borderY[colGap][row] between cols colGap and colGap+1.
 *
 * When cages merge (border removed) the new cage total is the sum of both old totals.
 * When a cage splits (border added) the component containing the old head keeps its
 * total; the new component gets the minimum valid total for its size.
 */
// patchBorder removed — border editing uses deferred-validation edit mode in main.ts.
// Call applyDraftLayout() when the user is done editing.
// Applies a set of draft cage borders, rebuilding cage totals from the
// existing cageStates (merging → sum; splitting → minimum for new sub-cages).
// Called from main.ts when the user finishes editing in grid-edit mode.
export function applyDraftLayout(
  borderX: readonly (readonly boolean[])[],    // [col][rowGap]
  borderY: readonly (readonly boolean[])[],    // [colGap][row]
  cellTotals: readonly (readonly number[])[],  // [row][col] — any cell may be non-zero
): { state: KillerPuzzleState; errorCells: Set<string>; warnings: string[] } {
  const state = requireState();
  if (!PuzzleState.isKiller(state)) throw new Error('applyDraftLayout requires a killer puzzle state');
  if (state.userGrid !== null) throw new Error('Cannot edit layout after confirming');

  // Union-find: keys are "row,col" (cellKey format)
  const rmap = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const k = cellKey([r, c] as Cell);
      rmap.set(k, k); members.set(k, new Set([k]));
    }
  }
  const find = (k: string): string => rmap.get(k)!;
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    for (const p of members.get(drop)!) rmap.set(p, keep);
    const ks = members.get(keep)!;
    for (const p of members.get(drop)!) ks.add(p);
    members.delete(drop);
  };
  for (let c = 0; c < 9; c++)
    for (let r = 0; r < 8; r++)
      if (!borderX[c]![r]!) union(cellKey([r, c] as Cell), cellKey([r + 1, c] as Cell));
  for (let cg = 0; cg < 8; cg++)
    for (let r = 0; r < 9; r++)
      if (!borderY[cg]![r]!) union(cellKey([r, cg] as Cell), cellKey([r, cg + 1] as Cell));

  // Validate each cage: exactly one non-zero total, within the valid range for its size.
  const errorCells = new Set<string>();
  const headTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const seen = new Set<string>();

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const rep = find(cellKey([r, c] as Cell));
      if (seen.has(rep)) continue;
      seen.add(rep);

      const cageCells = members.get(rep)!;
      const n = cageCells.size;
      const [lo, hi] = cageSumRange(n);

      let nonZeroCount = 0;
      let headR = -1; let headC = -1; let headTotal = 0;
      for (const k of cageCells) {
        const [kr, kc] = keyToCell(k);
        const total = cellTotals[kr]![kc]!;
        if (total !== 0) {
          nonZeroCount++;
          headR = kr; headC = kc; headTotal = total;
        }
      }

      const structuralError = nonZeroCount !== 1;
      const rangeError = nonZeroCount === 1 && (headTotal < lo || headTotal > hi);

      if (structuralError || rangeError) {
        for (const k of cageCells) errorCells.add(k);
      } else {
        headTotals[headR]![headC] = headTotal;
      }
    }
  }

  if (errorCells.size > 0) {
    return { state, errorCells, warnings: [] };
  }

  const bxMut = borderX.map(col => [...col]) as boolean[][];
  const byMut = borderY.map(row => [...row]) as boolean[][];
  const spec = validateCageLayout(headTotals, bxMut, byMut);

  const totalSum = headTotals.flat().reduce((a, b) => a + b, 0);
  const warnings = totalSum !== GRID_TOTAL_SUM
    ? [`Cage totals sum to ${totalSum} (expected ${GRID_TOTAL_SUM}) — please correct before confirming`]
    : [];

  const updated = {
    ...state,
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
  };
  setState(updated);
  return { state: updated, errorCells: new Set(), warnings };
}

// ---------------------------------------------------------------------------
// Confirm (OCR review → playing mode)
// ---------------------------------------------------------------------------

/**
 * Runs the solver on the current pre-confirm spec.
 * Call this before confirmPuzzle() to obtain the board to pass in.
 *
 * Returns both the solved board and whether MRV backtracking was needed
 * (i.e. constraint propagation alone could not fully solve the puzzle).
 * Throws if called after confirming.
 */
export function solveCurrentSpec(): SolveResult {
  const state = requireState();
  if (state.userGrid !== null) throw new Error('Already confirmed');
  const spec = PuzzleState.isKiller(state)
    ? cageStatesToSpec(state.cageStates, state.specData)
    : classicSyntheticSpec();
  // givenDigits are only meaningful for classic puzzles (pre-filled cells).
  // For killer puzzles, readClassicDigits can produce false-positive detections
  // (e.g. a cage total digit near the cell centre). Passing them to solve()
  // would incorrectly force those cells, potentially producing invalid solutions.
  const givenDigits = PuzzleState.isKiller(state) ? undefined : (state.givenDigits ?? undefined);
  return solve(spec, givenDigits);
}

/**
 * Builds the golden solution from a pre-computed board and transitions to
 * playing mode. Replaces POST /confirm.
 *
 * The board must have been produced by solveCurrentSpec() for the current
 * spec. Passing the board avoids a second solver run when the caller has
 * already solved (e.g. the auto-confirm path in handleProcess).
 */
export function confirmPuzzle(board: BoardState, fixtureStalledCandidates?: number[][][]): PuzzleState {
  const state = requireState();
  if (state.userGrid !== null) throw new Error('Session already confirmed');

  // Extract golden solution — 0 for cells the solver could not determine
  const goldenSolution: number[][] = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      const cands = board.cands(r, c);
      return cands.size === 1 ? [...cands][0]! : 0;
    }),
  );

  // For classic puzzles, pre-fill userGrid with given digits and record them
  // as placeDigit turns so rebuildUserGrid can reconstruct them after undo.
  const userGrid: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const givenTurns: Turn[] = [];
  if (state.givenDigits !== null) {
    const blankSnapshot = { candidates: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [])) };
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const d = state.givenDigits[r]![c]!;
        if (d > 0) {
          userGrid[r]![c] = d;
          givenTurns.push({
            action: { type: 'placeDigit', row: r, col: c, digit: d as number, source: 'given' },
            autoMutations: [],
            snapshot: blankSnapshot,
          });
        }
      }
    }
  }

  // Preserve alwaysApplyRules from state (set from user settings in uploadPuzzle/loadSpecDirect).
  const confirmedKiller = { ...state, goldenSolution, userGrid, turns: givenTurns, fixtureStalledCandidates: fixtureStalledCandidates ?? null };
  const confirmedClassic = { ...state, goldenSolution, userGrid, turns: givenTurns };
  let updated: PuzzleState = PuzzleState.isKiller(state) ? confirmedKiller : confirmedClassic;
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

/**
 * Revert session state to a pre-confirm OCR snapshot.
 * Used by the Edit OCR button to let the user correct OCR digits after auto-confirm.
 */
export function revertToOcr(ocrState: PuzzleState): void {
  setState(ocrState);
}

/** Checks post-confirmation assertions about the golden solution.
 *  Returns a violation if the solution is incomplete or invalid, null otherwise.
 *  Called by the UI layer after confirmPuzzle succeeds so the puzzle always
 *  reaches playing state regardless of the assertion result. */
export function checkSolutionAssertions(state: PuzzleState): AssertionViolation | null {
  const sol = state.goldenSolution;
  if (sol === null) return null;

  // Assertion 1: solver could not determine all cells using logical rules alone.
  if (sol.some(row => row.some(d => d === 0))) {
    return new AssertionViolation({
      name: 'UnsolvedByRules',
      description: 'The rule-based solver could not fill every cell. This puzzle may require techniques the rule set does not yet cover.',
      puzzleSpecJson: JSON.stringify(PuzzleState.isKiller(state) ? state.specData : null),
      solutionJson: JSON.stringify(sol),
      actionLog: formatActionLog(),
    });
  }

  // Assertion 2: the solution the solver produced fails basic sudoku validity.
  const reason = validateSudokuSolution(sol);
  if (reason !== null) {
    return new AssertionViolation({
      name: 'InvalidSolution',
      description: `The solver produced an invalid solution: ${reason}`,
      puzzleSpecJson: JSON.stringify(PuzzleState.isKiller(state) ? state.specData : null),
      solutionJson: JSON.stringify(sol),
      actionLog: formatActionLog(),
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Builds CandidatesResponse from an already-constructed KillerBoardState.
 * Shared by computeCandidates (full solve) and computeAnimationCandidates (skip solve).
 */
export function candidatesFromBoard(board: BoardState, state: PuzzleState): CandidatesResponse {
  // Per-cell user-removed lookup
  const removedByCell = new Map<string, Set<number>>();
  for (const [r, c, d] of userRemoved(state)) {
    const key = `${r},${c}`;
    const s = removedByCell.get(key) ?? new Set<number>();
    s.add(d);
    removedByCell.set(key, s);
  }

  // Build per-cell info
  const cells = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (__, c) => {
      const removedHere = removedByCell.get(`${r},${c}`) ?? new Set<number>();
      const solverCands = board instanceof KillerBoardState
        ? (() => {
            const cageIdx = board.regions[r]![c]!;
            const remaining = board.cageSolns[cageIdx]!;
            const cagePossible = new Set(remaining.flat());
            return new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)));
          })()
        : new Set(board.cands(r, c));
      // Union in user-removed so they show for strikethrough even after SolutionMapFilter prunes
      for (const d of removedHere) solverCands.add(d);
      return {
        candidates: [...solverCands].sort((a, b) => a - b),
        userRemoved: [...removedHere].sort((a, b) => a - b),
      };
    }),
  );

  // Real cage info — allSolutions/autoImpossible/userEliminated match VirtualCageInfo shape.
  // A plain BoardState carries no cage data; cages/nRealCages are empty/zero for it.
  const cageStates = PuzzleState.isKiller(state) ? state.cageStates : [];
  const nRealCages = board instanceof KillerBoardState ? Math.max(...board.regions.flat()) + 1 : 0;
  const cages = board instanceof KillerBoardState
    ? Array.from({ length: nRealCages }, (_, idx) => {
        const unit = board.units[27 + idx]!;
        // board.cageSolns[idx] has user-eliminated and engine-impossible both removed by buildEngine.
        const solns = board.cageSolns[idx]!;
        const cageState = cageStates[idx]!;
        let total = 0;
        for (const [r, c] of unit.cells) {
          const v = board.spec.cageTotals[r]![c]!;
          if (v) { total = v; break; }
        }
        const all = allCageSolutions(unit.cells.length, total);
        // solns elements are already order-normalised by the engine; s.join(',') is sufficient.
        const possibleKeys = new Set(solns.map(s => s.join(',')));
        // userEliminatedSolns are stored sorted by toggleSolution; join is sufficient.
        const userEliminatedKeys = new Set(cageState.userEliminatedSolns.map(s => s.join(',')));
        return {
          cageIdx: idx,
          label: cageState.label,
          cells: unit.cells.map(([r, c]) => [r, c] as [number, number]),
          total,
          solutions: solns.map(s => [...s].sort((a, b) => a - b)),
          allSolutions: all,
          autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
          userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
          mustContain: solns.length > 0 ? intersectAll(solns.map(s => new Set(s))) : [],
        };
      })
    : [];

  // Virtual cage info — same SolutionCategorization shape as CageInfo.
  const diffSolnKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
  const virtualCageStates = PuzzleState.isKiller(state) ? state.virtualCages : [];
  const virtualCages = virtualCageStates.map((vc, i) => {
    const isDiff = vc.negativeCells !== undefined && vc.negativeCells.length > 0;
    const key = virtualCageKeyFromCage(vc);
    if (isDiff) {
      const negCells = vc.negativeCells!;
      const negKeys = new Set(negCells.map(([r, c]) => `${r},${c}`));
      const posCount = vc.cells.length - negKeys.size;
      const negCount = negKeys.size;
      const allDiff = solDiffs(posCount, negCount, vc.total);
      const elimKeys = new Set((vc.eliminatedDiffSolns ?? []).map(diffSolnKey));
      const remaining = allDiff.filter(s => !elimKeys.has(diffSolnKey(s)));
      return {
        key,
        cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
        total: vc.total,
        solutions: [],
        allSolutions: [],
        autoImpossible: [],
        userEliminated: [],
        mustContain: [],
        negativeCells: negCells.map(([r, c]) => [r, c] as [number, number]),
        allDiffSolutions: allDiff,
        diffSolutions: remaining,
        eliminatedDiffSolns: (vc.eliminatedDiffSolns ?? []).slice(),
      };
    }
    // Virtual cages are killer-only (gated behind isKiller in main.ts's UI), so this
    // branch never observes a non-empty array for a plain BoardState — but the type
    // system needs the same instanceof narrow to read board.cageSolns at all.
    const vcSolns = board instanceof KillerBoardState ? (board.cageSolns[nRealCages + i] ?? []) : [];
    const all = allCageSolutions(vc.cells.length, vc.total);
    const possibleKeys = new Set(vcSolns.map(solutionKey));
    // eliminatedSolns are stored sorted by toggleSolution; join is sufficient.
    const userEliminatedKeys = new Set(vc.eliminatedSolns.map(s => s.join(',')));
    return {
      key,
      cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
      total: vc.total,
      solutions: vcSolns.map(s => [...s].sort((a, b) => a - b)),
      allSolutions: all,
      autoImpossible: all.filter(s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(','))),
      userEliminated: all.filter(s => userEliminatedKeys.has(s.join(','))),
      mustContain: vcSolns.length > 0 ? intersectAll(vcSolns.map(s => new Set(s))) : [],
    };
  });

  return { cells, cages, virtualCages };
}

/**
 * Builds the full CandidatesResponse for the current state.
 * Replaces GET /candidates.
 */
export function computeCandidates(): CandidatesResponse {
  const state = requireConfirmed();
  const { board } = buildEngine(state); // engine.solve() called inside buildEngine
  return candidatesFromBoard(board, state);
}

/**
 * Builds a partial CandidatesResponse for the rule-by-rule animation loop,
 * without running the full solver. Candidates reflect only what has been
 * eliminated so far (user placements + userRemovedCandidates), giving a
 * progressive per-rule display rather than instantly collapsing everything.
 */
export function computeAnimationCandidates(state: PuzzleState): CandidatesResponse {
  const { board } = buildEngine(state, { skipSolve: true });
  return candidatesFromBoard(board, state);
}

// ---------------------------------------------------------------------------
// Cell entry
// ---------------------------------------------------------------------------

/**
 * Places or clears a digit in the user's playing grid. Row/col are 1-based.
 * Replaces PATCH /cell.
 */
export function enterCell(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  let updated = recordTurn(state, action);
  // Rebuild from turns so auto-placements are always derived from explicit user
  // actions alone — mirrors undo/rewind. This keeps the round-trip invariant:
  //   applyAutoPlacements(rebuildUserGrid(state)) === state.userGrid
  updated = applyAutoPlacements(rebuildUserGrid(updated));
  setState(updated);
  return updated;
}

/**
 * Records the user's digit placement without applying auto-placements.
 * Used by the animated path in the UI (autoPlacementDelay > 0) so the
 * animation loop can step through auto-placements one-by-one.
 */
export function enterCellStep(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;
  const action: UserAction = digit !== 0
    ? { type: 'placeDigit', row: r, col: c, digit, source: 'user' }
    : { type: 'removeDigit', row: r, col: c };
  const updated = recordTurn(state, action);
  setState(updated);
  return updated;
}

/**
 * Applies exactly one pending auto-placement and persists it to the store.
 * Returns the updated state, or null if there are no more auto-placements.
 */
export function stepAutoPlacement(): PuzzleState | null {
  const state = getState();
  if (state === null) return null;
  const next = applyNextAutoPlacement(state);
  if (next === null) return null;
  setState(next);
  return next;
}

// ---------------------------------------------------------------------------
// Undo / rewind
// ---------------------------------------------------------------------------

/**
 * Reverses the last user action. Skips if the last turn was a given-digit
 * placement. Replaces POST /undo.
 */
export function undo(): PuzzleState {
  const state = requireConfirmed();
  if (state.turns.length === 0) throw new UserFacingError('Nothing to undo');
  const last = state.turns[state.turns.length - 1]!.action;
  if (last.type === 'placeDigit' && last.source === 'given') throw new UserFacingError('Cannot undo given digits');

  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, -1) };
  let updated = rebuildUserGrid(trimmed);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

/**
 * Trims history to `turnIdx` turns and rebuilds. Replaces POST /rewind.
 */
export function rewind(turnIdx: number): PuzzleState {
  const state = requireConfirmed();
  const trimmed: PuzzleState = { ...state, turns: state.turns.slice(0, turnIdx) };
  let updated = rebuildUserGrid(trimmed);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Candidate cycling
// ---------------------------------------------------------------------------

/**
 * Cycles a digit's candidate state (normal ↔ removed). digit=0 resets cell.
 * Row/col are 1-based. Replaces PATCH /candidates/cell.
 */
export function cycleCandidate(row1b: number, col1b: number, digit: number): PuzzleState {
  const state = requireConfirmed();
  const r = row1b - 1;
  const c = col1b - 1;

  let action: UserAction;
  if (digit === 0) {
    action = { type: 'resetCellCandidates', row: r, col: c };
  } else {
    const cellRemoved = new Set(
      userRemoved(state).filter(([rr, cc]) => rr === r && cc === c).map(([,, d]) => d),
    );
    const { board } = buildEngine(state);
    if (cellRemoved.has(digit)) {
      action = { type: 'restoreCandidate', row: r, col: c, digit };
    } else if (board.cands(r, c).has(digit)) {
      action = { type: 'eliminateCandidate', row: r, col: c, digit };
    } else {
      // auto-impossible and not user-removed — no-op
      return state;
    }
  }

  let updated = recordTurn(state, action);
  // Rebuild from turns so auto-placements stay consistent with explicit user
  // actions — same invariant as enterCell and undo.
  updated = applyAutoPlacements(rebuildUserGrid(updated));
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

/**
 * Runs the full constraint solver and returns the solution grid.
 * Replaces POST /solve.
 */
export function solvePuzzle(): SolveResponse {
  const state = requireState();
  if (!PuzzleState.isKiller(state)) throw new Error('solvePuzzle requires a killer puzzle state');
  const spec = cageStatesToSpec(state.cageStates, state.specData);
  try {
    const { board } = solve(spec);
    const grid: number[][] = Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => {
        const cands = board.cands(r, c);
        return cands.size === 1 ? [...cands][0]! : 0;
      }),
    );
    const solved = grid.every(row => row.every(d => d !== 0));
    return { solved, grid };
  } catch (e) {
    return { solved: false, grid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)), error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Cage solutions
// ---------------------------------------------------------------------------

/**
 * Toggles a cage solution as user-eliminated. Replaces POST /cage/:label/solutions/eliminate.
 */
export function eliminateCageSolution(label: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateCageSolution requires a killer puzzle state');
  const upper = label.toUpperCase();
  const newCages = state.cageStates.map(c =>
    c.label !== upper ? c : { ...c, userEliminatedSolns: toggleSolution(c.userEliminatedSolns, solution) },
  );
  const updated = { ...state, cageStates: newCages };
  setState(updated);
  return applyAutoPlacements(updated);
}

/**
 * Toggles a solution combination for a virtual cage (eliminate ↔ restore).
 * Mirrors eliminateCageSolution but operates on state.virtualCages by key.
 * The change is stored in virtualCages.eliminatedSolns (not in turn history)
 * and survives undo of unrelated actions, just like real cage eliminations.
 */
export function eliminateVirtualCageSolution(vcKey: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateVirtualCageSolution requires a killer puzzle state');
  const newVCs = state.virtualCages.map(vc =>
    virtualCageKeyFromCage(vc) !== vcKey ? vc : { ...vc, eliminatedSolns: toggleSolution(vc.eliminatedSolns, solution) },
  );
  const updated = { ...state, virtualCages: newVCs };
  setState(updated);
  return applyAutoPlacements(updated);
}

/** Toggle a DiffSolution as user-eliminated for a diff virtual cage identified by key. */
export function eliminateVirtualCageDiffSolution(vcKey: string, solution: DiffSolution): PuzzleState {
  const state = requireConfirmed();
  if (!PuzzleState.isKiller(state)) throw new Error('eliminateVirtualCageDiffSolution requires a killer puzzle state');
  const diffKey = (s: DiffSolution) => `${[...s.pos].join(',')}|${[...s.neg].join(',')}`;
  const newVCs = state.virtualCages.map(vc => {
    if (virtualCageKeyFromCage(vc) !== vcKey) return vc;
    const current = vc.eliminatedDiffSolns ?? [];
    const k = diffKey(solution);
    const isElim = current.some(s => diffKey(s) === k);
    const newElims = isElim
      ? current.filter(s => diffKey(s) !== k)
      : [...current, solution];
    return { ...vc, eliminatedDiffSolns: newElims };
  });
  const updated = { ...state, virtualCages: newVCs };
  setState(updated);
  return applyAutoPlacements(updated);
}

// ---------------------------------------------------------------------------
// Virtual cages
// ---------------------------------------------------------------------------

/**
 * Validates and adds a user-defined virtual cage. Replaces POST /virtual-cages.
 * Cells are 0-based [row, col] pairs.
 * Pass negativeCells (a subset of cells) to create a difference cage:
 *   sum(cells \ negativeCells) − sum(negativeCells) = total  (total must be ≥ 0).
 */
export function addVirtualCage(
  cells: [number, number][],
  total: number,
  negativeCells?: [number, number][],
): PuzzleState {
  const state = requireConfirmed();
  const isDiff = negativeCells !== undefined && negativeCells.length > 0;

  if (cells.length < 2) throw new Error('Virtual cage requires at least 2 cells');
  const unique = new Set(cells.map(([r, c]) => `${r},${c}`));
  if (unique.size !== cells.length) throw new Error('Duplicate cells in virtual cage');
  for (const [r, c] of cells) {
    if (r < 0 || r > 8 || c < 0 || c > 8) throw new Error(`Cell (${r},${c}) out of range`);
  }

  if (isDiff) {
    // Diff cage validation
    if (total < 0) throw new Error('Total must be non-negative for a difference cage');
    const negKeys = new Set(negativeCells!.map(([r, c]) => `${r},${c}`));
    for (const k of negKeys) {
      if (!unique.has(k)) throw new Error(`Negative cell ${k} is not in the selected cells`);
    }
    if (negKeys.size === cells.length) {
      throw new Error('At least one positive cell is required');
    }
    const posCount = cells.length - negKeys.size;
    const negCount = negKeys.size;
    const solutions = solDiffs(posCount, negCount, total);
    if (solutions.length === 0) {
      throw new Error(`Total ${total} has no valid solutions for ${posCount} positive and ${negCount} negative cells`);
    }
  } else {
    const n = cells.length;
    const [minTotal, maxTotal] = cageSumRange(n);
    if (total < minTotal || total > maxTotal) {
      throw new Error(`Total ${total} impossible for ${n} distinct digits (${minTotal}–${maxTotal})`);
    }
  }

  const typedCells = cells.map(([r, c]) => [r, c] as Cell);
  const typedNeg = negativeCells?.map(([r, c]) => [r, c] as Cell);
  const key = virtualCageKey(typedCells as unknown as readonly Cell[], total, typedNeg as unknown as readonly Cell[] | undefined);
  const existing = new Set(userVirtualCages(state).map(vc => virtualCageKeyFromCage(vc)));
  if (existing.has(key)) throw new Error(`Virtual cage already exists: ${key}`);

  const cage: VirtualCage = {
    cells: typedCells as Cell[],
    total,
    eliminatedSolns: [],
    ...(isDiff && { negativeCells: typedNeg as Cell[], eliminatedDiffSolns: [] }),
  };
  const action: UserAction = { type: 'addVirtualCage', cage };
  let updated = recordTurn(state, action);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

/** Linear rule names used for hint stratification. */
const LINEAR_RULE_NAMES = new Set(['LinearElimination', 'DeltaConstraint', 'SumPairConstraint']);

/**
 * Computes and returns hints for the current state.
 * Replaces GET /hints.
 */
/** Build a Rewind HintItem pointing to turn `idx`. */
function makeRewindHint(idx: number): HintItem {
  return {
    ruleName: 'Rewind',
    displayName: 'Rewind to last consistent state',
    explanation: 'A mistake has been detected. Rewinding will undo all moves back to the last correct state.',
    highlightCells: [],
    eliminations: [],
    eliminationCount: 0,
    placement: null,
    rewindToTurnIdx: idx,
    virtualCageSuggestion: null,
  };
}

/**
 * Scan turn history for the first turn that explicitly eliminated `digit` from
 * cell `(r,c)` — either via eliminateCandidate or via applyHint.
 * Returns the turn index, or null if not found (e.g. was eliminated by a rule).
 */
function findFirstElimTurnIdx(
  state: PuzzleState,
  r: number,
  c: number,
  digit: number,
): number | null {
  for (let i = 0; i < state.turns.length; i++) {
    const a = state.turns[i]!.action;
    if (a.type === 'eliminateCandidate' && a.row === r && a.col === c && a.digit === digit) return i;
    if (a.type === 'applyHint') {
      for (const [er, ec, ed] of a.eliminations) {
        if (er === r && ec === c && ed === digit) return i;
      }
    }
  }
  return null;
}

/**
 * Checks the user's recorded eliminations (cycleCandidate, applyHint) against
 * goldenSolution.  Returns the first cell where the correct solution digit was
 * explicitly removed by the user, or null if all golden candidates are intact.
 *
 * State-based (no board build required) so it is safe to call before buildEngine.
 */
function findMissingGoldenCandidate(
  state: PuzzleState,
): { r: number; c: number; gold: number } | null {
  const gs = state.goldenSolution;
  if (gs === null) return null;

  // Check explicit eliminateCandidate actions via userRemoved()
  for (const [r, c, d] of userRemoved(state)) {
    const gold = gs[r]?.[c];
    if (gold !== undefined && gold !== 0 && d === gold && state.userGrid![r]![c] === 0) {
      return { r, c, gold };
    }
  }
  return null;
}

export function getHints(): HintsResponse {
  let state = requireConfirmed();
  if (state.userGrid === null) return { hints: [] };

  // ── Inconsistency detection ─────────────────────────────────────────────────
  // Three paths can put the board in a state inconsistent with goldenSolution:
  //   1. A wrong digit was placed (detectable via userGrid vs goldenSolution).
  //      findLastConsistentTurnIdx also finds the responsible turn when it was
  //      a user placeDigit action; wrong auto-placed digits fall back to turn 0.
  //   2. The correct solution digit was explicitly eliminated from a cell's
  //      candidates (cycleCandidate / applyHint) — detectable from turn history.
  //   3. Wrong digits in userGrid that have no corresponding turn (legacy states
  //      from pre-soundness-assertion auto-placement cascades) — detected as any
  //      non-zero wrong cell in userGrid.
  const gs = state.goldenSolution;
  let inconsistent = false;
  let rewindTurnIdx: number | null = null;
  let missingCell: { r: number; c: number; gold: number } | null = null;

  if (gs !== null) {
    // Check 1 & 3: wrong digit anywhere in userGrid
    for (let r = 0; r < 9 && !inconsistent; r++) {
      for (let c = 0; c < 9 && !inconsistent; c++) {
        const placed = state.userGrid[r]![c]!;
        const gold = gs[r]![c]!;
        if (placed !== 0 && gold !== 0 && placed !== gold) {
          inconsistent = true;
          rewindTurnIdx = findLastConsistentTurnIdx(state); // null if no turn
        }
      }
    }

    // Check 2: correct golden candidate explicitly eliminated by user
    if (!inconsistent) {
      missingCell = findMissingGoldenCandidate(state);
      if (missingCell !== null) {
        inconsistent = true;
        rewindTurnIdx = findFirstElimTurnIdx(state, missingCell.r, missingCell.c, missingCell.gold);
      }
    }
  }

  if (inconsistent) {
    if (missingCell !== null) {
      // Golden candidate was explicitly eliminated. In a multi-solution puzzle the
      // cell may still have a remaining candidate that is correct for an alternative
      // solution — check before offering Rewind.
      const { board: altBoard } = buildEngine(state);
      const altSolution = altBoard.cands(missingCell.r, missingCell.c).size > 0
        ? mrvBacktrack(altBoard)
        : null;
      // Only accept the alt-solution if it places a DIFFERENT digit at the affected cell.
      // If mrvBacktrack returns the same gold digit (the board's constraints confirm it's
      // the only valid answer, e.g. the linear system re-pinned the cell), the user's
      // elimination was wrong → Rewind.
      if (altSolution !== null && altSolution[missingCell.r]?.[missingCell.c] !== missingCell.gold) {
        state = { ...state, goldenSolution: altSolution };
        setState(state);
        // Fall through to normal hint generation with the revised golden.
      } else {
        return { hints: [makeRewindHint(rewindTurnIdx ?? 0)] };
      }
    }

    // Wrong digit in userGrid — two sub-cases:
    //   A) rewindTurnIdx !== null — the wrong digit came from a user placeDigit turn.
    //      Before offering Rewind, check for an alternative valid solution (multi-solution
    //      puzzle: the user's placement might be consistent with a different valid solution).
    //   B) rewindTurnIdx === null — no matching turn exists; this wrong digit is from an
    //      auto-placement cascade (pre-soundness-assertion state).  Rewind immediately.
    if (rewindTurnIdx === null) {
      // Case B: auto-placed wrong digit — no turn to point to, Rewind to start.
      return { hints: [makeRewindHint(0)] };
    }

    // Case A: user's intentional wrong placement — check for alternative solution.
    const { board } = buildEngine(state); // safe: NoSolnError caught inside buildEngine
    const altSolution = mrvBacktrack(board);
    if (altSolution !== null) {
      // Puzzle has multiple solutions — update goldenSolution and fall through
      // to normal hint generation with the revised golden.
      state = { ...state, goldenSolution: altSolution };
      setState(state);
    } else {
      // No alternative — genuine mistake.  Rewind to the earliest bad turn.
      return { hints: [makeRewindHint(rewindTurnIdx)] };
    }
  }
  // ── End inconsistency detection ─────────────────────────────────────────────

  // Build engine so user placements, candidate removals, and virtual cages are
  // all reflected in the board before generating hints.
  const { board, engine } = buildEngine(state, { includeHints: true });
  const rawHints = engine.pendingHints;

  // Empty candidate set means the golden was eliminated by a prior user action
  // (e.g. a cage solution elimination cascade not tracked in userRemoved).
  // mrvBacktrack always returns null when a cell has zero candidates, so Rewind immediately.
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (state.userGrid![r]![c] === 0 && board.cands(r, c).size === 0) {
        return { hints: [makeRewindHint(0)] };
      }
    }
  }

  // Filter out hints for cells that already have a placed digit
  const filtered = rawHints.filter(h =>
    h.placement == null || state.userGrid![h.placement[0]!]![h.placement[1]!] === 0,
  );

  // Stratify linear hints: T1 (placements) > T2 (delta/sum pairs) > T3 (virtual cage suggestions)
  const t1 = filtered.filter(h => h.ruleName === 'LinearElimination' && h.placement != null);
  const t2 = filtered.filter(h => h.ruleName === 'DeltaConstraint' || h.ruleName === 'SumPairConstraint');
  const t3 = filtered.filter(h => h.ruleName === 'LinearElimination' && h.virtualCageSuggestion != null);
  const nonLinear = filtered.filter(h => !LINEAR_RULE_NAMES.has(h.ruleName));

  const linearHints = t1.length > 0 ? t1 : t2.length > 0 ? t2 : t3;

  const selected = [...nonLinear, ...linearHints].sort((a, b) => b.eliminations.length - a.eliminations.length);

  const hints: HintItem[] = selected.map(h => {
    let vcSug: VirtualCageSuggestion | null = null;
    if (h.virtualCageSuggestion != null) {
      const [vcells, vtotal] = h.virtualCageSuggestion;
      vcSug = {
        cells: [...vcells].sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2).map(([r, c]) => [r, c]),
        total: vtotal,
      };
    }
    return {
      ruleName: h.ruleName,
      displayName: h.displayName,
      explanation: h.explanation,
      highlightCells: [...h.highlightCells].sort(([r1, c1], [r2, c2]) => r1 - r2 || c1 - c2).map(([r, c]) => [r, c] as [number, number]),
      eliminations: h.eliminations.map(e => ({ cell: [e.cell[0], e.cell[1]] as [number, number], digit: e.digit })),
      eliminationCount: h.eliminations.length,
      placement: h.placement ? [h.placement[0], h.placement[1], h.placement[2]] : null,
      rewindToTurnIdx: null,
      virtualCageSuggestion: vcSug,
      ...(h.colourGroups ? {
        colourGroups: h.colourGroups.map(g => ({
          colour: g.colour,
          cells: [...g.cells].map(([r, c]) => [r, c] as [number, number]),
        })),
      } : {}),
      ...(h.patternDigits ? { patternDigits: [...h.patternDigits] } : {}),
    };
  });

  // Assertion: solvable puzzle is stuck — the rule set can't make progress.
  // Only fires after the user has placed at least one digit to avoid false positives
  // at the very start of a puzzle.
  const goldenComplete = state.goldenSolution !== null && state.goldenSolution.every(row => row.every(d => d !== 0));
  const puzzleIncomplete = state.userGrid!.some(row => row.some(d => d === 0));
  const hasUserPlacements = state.turns.some(t => t.action.type === 'placeDigit' && t.action.source === 'user');
  // When no hints are found on a solvable puzzle this most likely means the
  // position requires a technique (XYWing, colouring, forcing chains, …) that
  // the engine does not yet implement.  Log for developer awareness but do NOT
  // throw an AssertionViolation — the bug-report modal confuses users who are
  // simply past the engine's current capability.  The "No hint found" message
  // in the dropdown is the right user-facing response.
  if (hints.length === 0 && goldenComplete && puzzleIncomplete && hasUserPlacements) {
    console.warn('[StuckPuzzle] No hint found for a solvable position — engine may be missing a technique.');
  }

  return { hints };
}

/**
 * Applies a hint's eliminations by recording them as user-removed candidates.
 * Replaces POST /hints/apply.
 */
export function applyHint(eliminations: readonly { cell: [number, number]; digit: number }[]): PuzzleState {
  const state = requireConfirmed();
  const triples: [number, number, number][] = eliminations.map(e => [e.cell[0], e.cell[1], e.digit]);
  const action: UserAction = { type: 'applyHint', eliminations: triples };
  let updated = recordTurn(state, action);
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Re-validates the board with current settings and returns the updated state.
 * Replaces POST /refresh.
 */
export function refresh(): PuzzleState {
  const state = requireConfirmed();
  const updated = applyAutoPlacements(state);
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Returns the current settings plus the full list of hintable rules.
 * Replaces GET /api/settings.
 */
/** Returns the current auto-placement animation delay in ms (0 = instant). */
export function getAutoPlacementDelay(): number {
  return loadSettings().autoPlacementDelay;
}

export function getSettingsData(): SettingsResponse {
  const settings = loadSettings();
  const state = getState();
  const isKillerPuzzle = state !== null && PuzzleState.isKiller(state);
  const hintableRules: RuleInfo[] = defaultRules()
    .filter(r => isKillerPuzzle || !r.killerOnly)
    .map(r => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
    }));
  return {
    alwaysApplyRules: settings.alwaysApplyRules,
    autoPlacementDelay: settings.autoPlacementDelay,
    showEssential: true, // localStorage-persisted by main.ts
    showCandidatesByDefault: settings.showCandidatesByDefault,
    hintableRules,
  };
}

/**
 * Persists updated settings and refreshes the current state.
 * Replaces PATCH /api/settings.
 */
export function saveSettingsData(
  alwaysApplyRules: string[],
  autoPlacementDelay: number,
  showCandidatesByDefault: boolean,
): PuzzleState | null {
  saveSettings({ alwaysApplyRules, autoPlacementDelay, showCandidatesByDefault });
  const s = getState();
  if (s === null) return null;
  const updated: PuzzleState = { ...s, alwaysApplyRules };
  setState(updated);
  return s.userGrid !== null ? refresh() : updated;
}
