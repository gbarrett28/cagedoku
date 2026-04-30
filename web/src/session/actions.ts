/**
 * Session actions — replaces all Python `fetch('/api/puzzle/...')` calls.
 *
 * Each function reads/writes the in-memory store directly and calls the
 * TS engine helpers instead of making network requests. The function
 * signatures and return shapes mirror the Python API so that the adapted
 * main.ts can call them as drop-in replacements.
 */

import { solve } from '../engine/index.js';
import { solSums } from '../solver/equation.js';
import { defaultRules } from '../engine/rules/index.js';
import type { Cell } from '../engine/types.js';
import { parsePuzzleImage } from '../image/inpImage.js';
import { defaultImagePipelineConfig } from '../image/config.js';
import { validateCageLayout } from '../image/validation.js';
import type { PuzzleSpec } from '../solver/puzzleSpec.js';
import {
  buildEngine,
  applyAutoPlacements,
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
  virtualCageKey,
} from './specUtils.js';
import { getState, setState, getCV, getRec } from './store.js';
import type {
  CageSolutionsResponse,
  CandidatesResponse,
  HintItem,
  HintsResponse,
  PuzzleState,
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
}

/**
 * Build a PuzzleState directly from a PuzzleSpec, bypassing the image pipeline.
 *
 * Used in dev/test mode to exercise the full review→confirm→playing UI flow
 * without requiring OpenCV or a real puzzle image.
 */
export function loadSpecDirect(spec: PuzzleSpec): UploadResult {
  const settings = loadSettings();
  const state: PuzzleState = {
    specData: specToData(spec),
    cageStates: specToCageStates(spec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...settings.alwaysApplyRules],
    goldenSolution: null,
    puzzleType: 'killer',
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
  };
  setState(state);
  return { state, warpedImageUrl: null, warning: null };
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
  const result = await parsePuzzleImage(cv, file, rec, config);

  // Convert warpedImageData to a data URL for <img> display
  let warpedImageUrl: string | null = null;
  if (result.warpedImageData !== null) {
    const offscreen = new OffscreenCanvas(result.warpedImageData.width, result.warpedImageData.height);
    const octx = offscreen.getContext('2d')!;
    octx.putImageData(result.warpedImageData, 0, 0);
    const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    warpedImageUrl = URL.createObjectURL(blob);
  }

  const originalImageUrl = await fileToDataUrl(file);
  const settings = loadSettings();

  let spec = result.spec;
  let warning = result.specError;

  // On OCR failure show a blank canvas (no borders, no totals) so the user can
  // build the layout from scratch.  A blank spec is a single 81-cell region —
  // the user adds borders to partition it into cages.
  if (spec === null) {
    warning = (warning ? warning + ' ' : '') + 'Cage layout could not be detected — starting with a blank grid.';
    const blankBorderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(false));
    const blankBorderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
    const blankTotals  = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
    spec = validateCageLayout(blankTotals, blankBorderX, blankBorderY);
  }

  // validateCageLayout builds regions and cageTotals in [col][row] order; the rest of
  // the codebase (drawGrid, dataToSpec, applyDraftLayout) expects [row][col].
  const transposedSpec: PuzzleSpec = {
    ...spec,
    regions: Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => spec.regions[c]![r]!),
    ),
    cageTotals: Array.from({ length: 9 }, (_, r) =>
      Array.from({ length: 9 }, (__, c) => spec.cageTotals[c]![r]!),
    ),
  };

  const state: PuzzleState = {
    specData: specToData(transposedSpec),
    cageStates: specToCageStates(transposedSpec),
    userGrid: null,
    virtualCages: [],
    turns: [],
    alwaysApplyRules: [...settings.alwaysApplyRules],
    goldenSolution: null,
    puzzleType: result.puzzleType,
    givenDigits: result.givenDigits,
    originalImageUrl,
    warpedImageUrl,
  };

  setState(state);
  return { state, warpedImageUrl, warning };
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Cage total editing (pre-confirm)
// ---------------------------------------------------------------------------

/**
 * Corrects the OCR-detected total for a named cage. Replaces PATCH /cage/:label.
 */
export function patchCage(label: string, total: number): PuzzleState {
  const state = requireState();
  const upper = label.toUpperCase();
  const newCages = state.cageStates.map(c =>
    c.label === upper ? { ...c, total } : c,
  );
  const updated: PuzzleState = { ...state, cageStates: newCages };
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
): { state: PuzzleState; errorCells: Set<string>; warnings: string[] } {
  const state = requireState();
  if (state.userGrid !== null) throw new Error('Cannot edit layout after confirming');

  // Union-find: keys are "${col},${row}"
  const rmap = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 9; r++) {
      const k = `${c},${r}`;
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
      if (!borderX[c]![r]!) union(`${c},${r}`, `${c},${r + 1}`);
  for (let cg = 0; cg < 8; cg++)
    for (let r = 0; r < 9; r++)
      if (!borderY[cg]![r]!) union(`${cg},${r}`, `${cg + 1},${r}`);

  // Validate each cage: exactly one non-zero total, within the valid range for its size.
  // errorCells uses "row,col" keys (matches drawGrid's highlight convention).
  const errorCells = new Set<string>();
  const headTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const seen = new Set<string>();

  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 9; r++) {
      const rep = find(`${c},${r}`);
      if (seen.has(rep)) continue;
      seen.add(rep);

      const cageCells = members.get(rep)!;
      const n = cageCells.size;
      const lo = (n * (n + 1)) / 2;
      const hi = (n * (19 - n)) / 2;

      let nonZeroCount = 0;
      let headC = -1; let headR = -1; let headTotal = 0;
      for (const k of cageCells) {
        const [kc, kr] = k.split(',').map(Number) as [number, number];
        const total = cellTotals[kr]![kc]!; // [row][col]
        if (total !== 0) {
          nonZeroCount++;
          headC = kc; headR = kr; headTotal = total;
        }
      }

      const structuralError = nonZeroCount !== 1;
      const rangeError = nonZeroCount === 1 && (headTotal < lo || headTotal > hi);

      if (structuralError || rangeError) {
        for (const k of cageCells) {
          const [kc, kr] = k.split(',').map(Number) as [number, number];
          errorCells.add(`${kr},${kc}`); // "row,col" for drawGrid
        }
      } else {
        headTotals[headC]![headR] = headTotal; // [col][row] for validateCageLayout
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
  // A valid 9×9 killer sudoku always sums to exactly 405 (digits 1–9 each appear 9 times).
  const warnings = totalSum !== 405
    ? [`Cage totals sum to ${totalSum} (expected 405) — please correct before confirming`]
    : [];

  const updated: PuzzleState = {
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
 * Runs the solver, builds the golden solution, and transitions to playing
 * mode. Replaces POST /confirm.
 */
export function confirmPuzzle(): PuzzleState {
  const state = requireState();
  if (state.userGrid !== null) throw new Error('Session already confirmed');

  const spec = cageStatesToSpec(state.cageStates, state.specData);
  const givenDigits = state.givenDigits ?? undefined;
  const board = solve(spec, givenDigits);

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
  let updated: PuzzleState = {
    ...state,
    goldenSolution,
    userGrid,
    turns: givenTurns,
  };
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Builds the full CandidatesResponse for the current state.
 * Replaces GET /candidates.
 */
export function computeCandidates(): CandidatesResponse {
  const state = requireConfirmed();
  const { board } = buildEngine(state); // engine.solve() called inside buildEngine

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
      const cageIdx = board.regions[r]![c]!;
      const remaining = board.cageSolns[cageIdx]!;
      const cagePossible: Set<number> = remaining.length > 0
        ? new Set(remaining.flat())
        : new Set<number>();
      const removedHere = removedByCell.get(`${r},${c}`) ?? new Set<number>();
      const solverCands = new Set([...board.cands(r, c)].filter(d => cagePossible.has(d)));
      // Union in user-removed so they show for strikethrough even after SolutionMapFilter prunes
      for (const d of removedHere) solverCands.add(d);
      return {
        candidates: [...solverCands].sort((a, b) => a - b),
        userRemoved: [...removedHere].sort((a, b) => a - b),
      };
    }),
  );

  // Real cage info
  const nRealCages = Math.max(...board.regions.flat()) + 1;
  const cages = Array.from({ length: nRealCages }, (_, idx) => {
    const unit = board.units[27 + idx]!;
    const solns = board.cageSolns[idx]!;
    const mustContain = solns.length > 0
      ? [...solns.reduce((acc, s) => { const ss = new Set(s); return new Set([...acc].filter(d => ss.has(d))); }, new Set(solns[0]!))]
          .sort((a, b) => a - b)
      : [];
    let total = 0;
    for (const [r, c] of unit.cells) {
      const v = board.spec.cageTotals[r]![c]!;
      if (v) { total = v; break; }
    }
    return {
      cageIdx: idx,
      cells: unit.cells.map(([r, c]) => [r, c] as [number, number]),
      total,
      solutions: solns.map(s => [...s].sort((a, b) => a - b)),
      mustContain,
    };
  });

  // Virtual cage info — include allSolutions/userEliminated so the UI can
  // render them identically to the real cage inspector.
  const virtualCages = state.virtualCages.map((vc, i) => {
    const vcSolns = board.cageSolns[nRealCages + i] ?? [];
    const allSolutions = [...solSums(vc.cells.length, 0, vc.total)]
      .map(s => [...s].sort((a, b) => a - b))
      .sort((a, b) => { for (let j = 0; j < a.length; j++) { const d = a[j]! - b[j]!; if (d !== 0) return d; } return 0; });
    const possibleKeys = new Set(vcSolns.map(s => [...s].sort((a, b) => a - b).join(',')));
    const userEliminatedKeys = new Set(
      vc.eliminatedSolns.map(s => [...s].sort((a, b) => a - b).join(',')),
    );
    const autoImpossible = allSolutions.filter(
      s => !possibleKeys.has(s.join(',')) && !userEliminatedKeys.has(s.join(',')),
    );
    const userEliminated = allSolutions.filter(s => userEliminatedKeys.has(s.join(',')));
    const mustContain = vcSolns.length > 0
      ? [...vcSolns.reduce((acc, s) => { const ss = new Set(s); return new Set([...acc].filter(d => ss.has(d))); }, new Set(vcSolns[0]))]
          .sort((a, b) => a - b)
      : [];
    return {
      key: virtualCageKey(vc.cells, vc.total),
      cells: vc.cells.map(([r, c]) => [r, c] as [number, number]),
      total: vc.total,
      solutions: vcSolns.map(s => [...s].sort((a, b) => a - b)),
      allSolutions,
      autoImpossible,
      userEliminated,
      mustContain,
    };
  });

  return { cells, cages, virtualCages };
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
  updated = applyAutoPlacements(updated);
  setState(updated);
  return updated;
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
  if (state.turns.length === 0) throw new Error('Nothing to undo');
  const last = state.turns[state.turns.length - 1]!.action;
  if (last.type === 'placeDigit' && last.source === 'given') throw new Error('Cannot undo given digits');

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
  updated = applyAutoPlacements(updated);
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
  const spec = cageStatesToSpec(state.cageStates, state.specData);
  try {
    const board = solve(spec);
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
 * Returns all digit combinations for a cage, split by status.
 * Replaces GET /cage/:label/solutions.
 */
export function getCageSolutions(label: string): CageSolutionsResponse {
  const state = requireConfirmed();
  const upper = label.toUpperCase();
  const cageIdx = state.cageStates.findIndex(c => c.label === upper);
  if (cageIdx === -1) throw new Error(`Cage ${label} not found`);
  const cage = state.cageStates[cageIdx]!;

  const { board } = buildEngine(state); // engine.solve() called inside buildEngine
  const allSolutions = [...solSums(cage.cells.length, 0, cage.total)]
    .map(s => [...s].sort((a, b) => a - b))
    .sort((a, b) => { for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; if (d !== 0) return d; } return 0; });

  const possible = new Set(board.cageSolns[cageIdx]!.map(s => [...s].sort((a, b) => a - b).join(',')));
  const autoImpossible = allSolutions.filter(s => !possible.has(s.join(',')));

  return {
    label: upper,
    allSolutions,
    autoImpossible,
    userEliminated: cage.userEliminatedSolns.map(s => [...s]),
  };
}

/**
 * Toggles a cage solution as user-eliminated. Replaces POST /cage/:label/solutions/eliminate.
 */
export function eliminateCageSolution(label: string, solution: number[]): PuzzleState {
  const state = requireConfirmed();
  const upper = label.toUpperCase();
  const sorted = [...solution].sort((a, b) => a - b);
  const key = sorted.join(',');

  const newCages = state.cageStates.map(c => {
    if (c.label !== upper) return c;
    const current = c.userEliminatedSolns.map(s => [...s].sort((a, b) => a - b));
    const existsIdx = current.findIndex(s => s.join(',') === key);
    const updated = existsIdx >= 0
      ? current.filter((_, i) => i !== existsIdx)
      : [...current, sorted];
    return { ...c, userEliminatedSolns: updated };
  });

  const updated: PuzzleState = { ...state, cageStates: newCages };
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
  const sorted = [...solution].sort((a, b) => a - b);
  const solKey = sorted.join(',');

  const newVCs = state.virtualCages.map(vc => {
    if (virtualCageKey(vc.cells, vc.total) !== vcKey) return vc;
    const current = vc.eliminatedSolns.map(s => [...s].sort((a, b) => a - b));
    const existsIdx = current.findIndex(s => s.join(',') === solKey);
    const updated = existsIdx >= 0
      ? current.filter((_, i) => i !== existsIdx)
      : [...current, sorted];
    return { ...vc, eliminatedSolns: updated };
  });

  const updated: PuzzleState = { ...state, virtualCages: newVCs };
  setState(updated);
  return applyAutoPlacements(updated);
}

// ---------------------------------------------------------------------------
// Virtual cages
// ---------------------------------------------------------------------------

/**
 * Validates and adds a user-defined virtual cage. Replaces POST /virtual-cages.
 * Cells are 0-based [row, col] pairs.
 */
export function addVirtualCage(cells: [number, number][], total: number): PuzzleState {
  const state = requireConfirmed();

  if (cells.length < 2) throw new Error('Virtual cage requires at least 2 cells');
  const unique = new Set(cells.map(([r, c]) => `${r},${c}`));
  if (unique.size !== cells.length) throw new Error('Duplicate cells in virtual cage');
  for (const [r, c] of cells) {
    if (r < 0 || r > 8 || c < 0 || c > 8) throw new Error(`Cell (${r},${c}) out of range`);
  }
  const n = cells.length;
  const minTotal = n * (n + 1) / 2;
  const maxTotal = n * (19 - n) / 2;
  if (total < minTotal || total > maxTotal) {
    throw new Error(`Total ${total} impossible for ${n} distinct digits (${minTotal}–${maxTotal})`);
  }

  const typedCells = cells.map(([r, c]) => [r, c] as Cell);
  const key = virtualCageKey(typedCells as unknown as readonly Cell[], total);
  const existing = new Set(userVirtualCages(state).map(vc => virtualCageKey(vc.cells, vc.total)));
  if (existing.has(key)) throw new Error(`Virtual cage already exists: ${key}`);

  const cage: VirtualCage = { cells: typedCells as Cell[], total, eliminatedSolns: [] };
  const action: UserAction = { type: 'addVirtualCage', cage };
  const updated = recordTurn(state, action);
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
export function getHints(): HintsResponse {
  const state = requireConfirmed();
  if (state.userGrid === null) return { hints: [] };

  // Inconsistency check: if any move conflicts with the golden solution,
  // return only a Rewind hint.
  const rewindIdx = findLastConsistentTurnIdx(state);
  if (rewindIdx !== null) {
    return {
      hints: [{
        ruleName: 'Rewind',
        displayName: 'Rewind to last consistent state',
        explanation: 'A mistake has been detected. Rewinding will undo all moves back to the last correct state.',
        highlightCells: [],
        eliminations: [],
        eliminationCount: 0,
        placement: null,
        rewindToTurnIdx: rewindIdx,
        virtualCageSuggestion: null,
      }],
    };
  }

  // Build engine from full current state so user placements, candidate removals,
  // and virtual cages are all reflected before generating hints.
  const { engine } = buildEngine(state, { includeHints: true }); // engine.solve() called inside buildEngine
  const rawHints = engine.pendingHints;

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
    };
  });

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
export function getSettingsData(): SettingsResponse {
  const settings = loadSettings();
  const hintableRules: RuleInfo[] = defaultRules().map(r => ({
    name: r.name,
    displayName: r.name.replace(/([A-Z])/g, ' $1').trim(),
    description: r.description,
  }));
  return {
    alwaysApplyRules: settings.alwaysApplyRules,
    showEssential: true, // localStorage-persisted by main.ts
    hintableRules,
  };
}

/**
 * Persists updated settings and refreshes the current state.
 * Replaces PATCH /api/settings.
 */
export function saveSettingsData(alwaysApplyRules: string[]): PuzzleState | null {
  saveSettings({ alwaysApplyRules });
  const s = getState();
  if (s === null) return null;
  const updated: PuzzleState = { ...s, alwaysApplyRules };
  setState(updated);
  return s.userGrid !== null ? refresh() : updated;
}
