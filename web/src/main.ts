/**
 * Sudoku COACH — browser entry point.
 *
 * Adapted from killer_sudoku/static/main.ts.  All `fetch('/api/...')` calls
 * replaced with direct calls to session/actions.ts functions.
 * State lives in session/store.ts; no server required.
 */

import { loadCV, loadRec, loadSplitRec, setCandidatesCache, setState } from './session/store.js';
import { logAction, clearActionLog, formatActionLog, getActionLog } from './session/actionLog.js';
import { loadSettings } from './session/settings.js';
import { cellLabel } from './engine/rules/_labels.js';
import { extractTrainingData } from './image/trainingExport.js';
import type { TrainingExport } from './image/trainingExport.js';
import { defaultImagePipelineConfig } from './image/config.js';
import { initiateUpload, grantConsent, uploadTrainingData, submitPuzzleReport } from './image/trainingUpload.js';
import { dataToSpec } from './session/specUtils.js';
import { analyseKernels } from './engine/kernelAnalysis.js';
import { makeTrivialSpec, makeTwoCellCageSpec, makeBoxCageSpec, makeClassicGivenDigits, makeClassicPartialGivenDigits } from './engine/fixtures.js';
import {
  uploadPuzzle,
  loadSpecDirect,
  loadClassicDirect,
  confirmPuzzle,
  computeCandidates,
  computeAnimationCandidates,
  enterCell,
  enterCellStep,
  getAutoPlacementDelay,
  undo,
  rewind,
  cycleCandidate,
  eliminateCageSolution,
  eliminateVirtualCageSolution,
  addVirtualCage,
  getHints,
  applyHint,
  applyDraftLayout,
  solveCurrentSpec,
  getSettingsData,
  saveSettingsData,
  checkSolutionAssertions,
  revertToOcr,
  extractAndValidateSolution,
} from './session/actions.js';
import type {
  CandidatesResponse,
  HintItem,
  PuzzleState,
  SolutionCategorization,
} from './session/types.js';
import type { Cell } from './engine/types.js';
import { GridNotFoundError } from './image/inpImage.js';
import { UserFacingError } from './session/errors.js';
import { applyAutoApplyLock } from './autoApplyLock.js';
import { showHintPill, hideHintPill } from './hintPill.js';
import { getNextAutoApplyStep, applyAutoApplyStep } from './session/engine.js';
import { AssertionViolation, findDuplicateCells, hasDuplicateDigits, isCageSumCorrect } from './session/assertions.js';
import { initTutorial, appendCallouts } from './tutorial.js';
import { resolveDigitKey } from './resolveDigitKey.js';
import type { StallFixtureFile } from './engine/rules/stallFixtureFile.js';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// Canvas constants
// ---------------------------------------------------------------------------

const CELL = 50;
const MARGIN = 4;
const GRID_PX = MARGIN * 2 + 9 * CELL;

// ---------------------------------------------------------------------------
// UI state
//
// These module-level variables are the single source of truth for all UI
// modes. Known design debt: consolidating them into an immutable state object
// with functional updates would make event handlers easier to test and reduce
// the risk of handlers reading stale values. See docs/architecture.md §Known
// Design Issues.
// ---------------------------------------------------------------------------

let currentState: PuzzleState | null = null;
let currentCandidates: CandidatesResponse | null = null;
let selectedCell: { row: number; col: number } | null = null;  // 1-based
let showCandidates = false;
let showEssential = true;
let candidateEditMode = false;
let virtualCageMode = false;
let virtualCageSelection = new Set<string>();   // "r,c" keys, 0-based
let hintHighlightCells = new Set<string>();     // "r,c" keys, 0-based — pattern cells (orange)
let hintElimCells = new Set<string>();          // "r,c" keys, 0-based — elimination cells (yellow)
let hintColourGroups: readonly { cells: readonly [number, number][]; colour: 'blue' | 'green' }[] = [];
let activeHintItem: HintItem | null = null;
let inspectCageMode = false;

// ── User colouring tool ──────────────────────────────────────────────────────
type ColourMode = 'off' | 'blue-next' | 'green-next';
let colourMode: ColourMode = 'off';
/** "r,c" 0-based keys → colour applied by the user colouring tool. */
const cellColours = new Map<string, 'blue' | 'green'>();

let fastForwardRequested = false;

let draftBorderX: boolean[][] = [];   // [col][rowGap] — cage horizontal walls
let draftBorderY: boolean[][] = [];   // [colGap][row] — cage vertical walls

// Active stall fixture — set when loaded from the fixture panel, cleared on normal pipeline start.
let currentFixtureName: string | null = null;
let currentFixtureUnsolvedCells: number | null = null;
let currentFixtureTotalCandidates: number | null = null;

/** Returns the active fixture context for feedback submission, or null when no fixture is loaded. */
function activeFixtureContext(): { name: string; unsolvedCells: number; totalCandidates: number } | null {
  if (currentFixtureName === null) return null;
  return {
    name: currentFixtureName,
    unsolvedCells: currentFixtureUnsolvedCells!,
    totalCandidates: currentFixtureTotalCandidates!,
  };
}
let draftEdited = false;              // true once the user changes any total or border
let pendingCellThumbs = new Map<string, Uint8Array[]>(); // OCR thumbnails, held until Confirm
let pendingMergedThumbs = new Map<string, Uint8Array>(); // pre-split merged thumbnails, held until Confirm
let totalEditCell: { row: number; col: number } | null = null;  // 0-based, active overlay
let totalEditPrev = 0;
let reviewErrorCells = new Set<string>(); // "row,col" keys — cages failing Confirm validation
let reviewSuspectCells = new Set<string>(); // "row,col" keys — cells suspected of OCR misread (amber)
let kernelWarningShown = false; // true after first-confirm kernel warning; skips analysis on re-confirm

// Bug reporting state
let pendingBug: { info: string } | null = null;
let exceptionForSubmission: string | null = null;

// OCR state preserved across auto-confirm for the Edit OCR button.
let lastOcrState: PuzzleState | null = null;
let lastWarpedUrl: string | null = null;

// ---------------------------------------------------------------------------
// Grid rendering
// ---------------------------------------------------------------------------

function drawUnderlays(
  ctx: CanvasRenderingContext2D,
  candidatesData: CandidatesResponse | null,
  vcSelection: Set<string> | null,
  highlightKeys: Set<string> | null,
  selected: { row: number; col: number } | null,
  errorCells: Set<string> | undefined,
  suspectCells?: Set<string>,
): void {
  const vcColors = [
    'rgba(20, 184, 166, 0.25)',
    'rgba(139, 92, 246, 0.25)',
    'rgba(236, 72, 153, 0.25)',
    'rgba(251, 146, 60, 0.25)',
  ];
  if (candidatesData !== null) {
    for (const [vcIdx, vc] of candidatesData.virtualCages.entries()) {
      ctx.fillStyle = vcColors[vcIdx % vcColors.length]!;
      for (const [r, c] of vc.cells) {
        ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }
  }
  if (vcSelection !== null && vcSelection.size > 0) {
    ctx.fillStyle = 'rgba(99, 102, 241, 0.35)';
    for (const key of vcSelection) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  // Chain-colouring: hint colour groups (blue/green for the two chain groups)
  for (const group of hintColourGroups) {
    ctx.fillStyle = group.colour === 'blue' ? 'rgba(59, 130, 246, 0.45)' : 'rgba(34, 197, 94, 0.45)';
    for (const [r, c] of group.cells) {
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  // User colouring tool: manually coloured cells (blue/green)
  for (const [key, colour] of cellColours) {
    const parts = key.split(',').map(Number);
    const r = parts[0]!, c = parts[1]!;
    ctx.fillStyle = colour === 'blue' ? 'rgba(59, 130, 246, 0.45)' : 'rgba(34, 197, 94, 0.45)';
    ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
  }
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = 'rgba(249, 115, 22, 0.35)';
    for (const key of highlightKeys) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  if (hintElimCells.size > 0) {
    ctx.fillStyle = 'rgba(251, 191, 36, 0.45)';
    for (const key of hintElimCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  if (selected !== null && colourMode === 'off') {
    ctx.fillStyle = '#dbeafe';
    ctx.fillRect(
      MARGIN + (selected.col - 1) * CELL,
      MARGIN + (selected.row - 1) * CELL,
      CELL, CELL,
    );
  }
  if (errorCells && errorCells.size > 0) {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
    for (const key of errorCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
  if (suspectCells && suspectCells.size > 0) {
    ctx.fillStyle = 'rgba(245, 158, 11, 0.45)';
    for (const key of suspectCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }
}

function drawCageBorders(
  ctx: CanvasRenderingContext2D,
  state: PuzzleState,
  draft: { borderX: boolean[][], borderY: boolean[][] } | undefined,
): void {
  ctx.strokeStyle = draft ? '#0055cc' : '#cc0000';
  ctx.lineWidth = 7.5;
  if (draft) {
    for (let col = 0; col < 9; col++) {
      for (let rowGap = 0; rowGap < 8; rowGap++) {
        if (draft.borderX[col]![rowGap]) {
          const y = MARGIN + (rowGap + 1) * CELL;
          ctx.beginPath(); ctx.moveTo(MARGIN + col * CELL, y); ctx.lineTo(MARGIN + (col + 1) * CELL, y); ctx.stroke();
        }
      }
    }
    for (let colGap = 0; colGap < 8; colGap++) {
      for (let row = 0; row < 9; row++) {
        if (draft.borderY[colGap]![row]) {
          const x = MARGIN + (colGap + 1) * CELL;
          ctx.beginPath(); ctx.moveTo(x, MARGIN + row * CELL); ctx.lineTo(x, MARGIN + (row + 1) * CELL); ctx.stroke();
        }
      }
    }
  } else {
    const reg = state.specData.regions;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 9; c++) {
        if ((reg[r]?.[c] ?? 0) !== (reg[r + 1]?.[c] ?? 0)) {
          const y = MARGIN + (r + 1) * CELL;
          ctx.beginPath(); ctx.moveTo(MARGIN + c * CELL, y); ctx.lineTo(MARGIN + (c + 1) * CELL, y); ctx.stroke();
        }
      }
    }
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 8; c++) {
        if ((reg[r]?.[c] ?? 0) !== (reg[r]?.[c + 1] ?? 0)) {
          const x = MARGIN + (c + 1) * CELL;
          ctx.beginPath(); ctx.moveTo(x, MARGIN + r * CELL); ctx.lineTo(x, MARGIN + (r + 1) * CELL); ctx.stroke();
        }
      }
    }
  }
}

function drawGridLines(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = '#000'; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
  for (let i = 1; i < 9; i++) {
    const pos = MARGIN + i * CELL;
    ctx.beginPath(); ctx.moveTo(MARGIN, pos); ctx.lineTo(MARGIN + 9 * CELL, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, MARGIN); ctx.lineTo(pos, MARGIN + 9 * CELL); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  for (const b of [3, 6]) {
    const pos = MARGIN + b * CELL;
    ctx.beginPath(); ctx.moveTo(MARGIN, pos); ctx.lineTo(MARGIN + 9 * CELL, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, MARGIN); ctx.lineTo(pos, MARGIN + 9 * CELL); ctx.stroke();
  }
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
  ctx.strokeRect(MARGIN, MARGIN, 9 * CELL, 9 * CELL);
}

function drawCageTotals(ctx: CanvasRenderingContext2D, state: PuzzleState): void {
  const TOTAL_FONT_PX = Math.round(CELL * 0.36); // ~18px at CELL=50
  ctx.font = `bold ${TOTAL_FONT_PX}px sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const totals = state.specData.cageTotals;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const total = totals[r]?.[c] ?? 0;
      if (total === 0) continue;
      const x = MARGIN + c * CELL + 2;
      const y = MARGIN + r * CELL + 2;
      const label = String(total);
      const tw = ctx.measureText(label).width;
      // White chip behind the number so it reads cleanly over grid lines.
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y - 1, tw + 2, TOTAL_FONT_PX + 1);
      ctx.fillStyle = '#111';
      ctx.fillText(label, x, y);
    }
  }
}

function drawDigits(ctx: CanvasRenderingContext2D, state: PuzzleState): void {
  const digitGrid: number[][] | null =
    state.userGrid !== null ? state.userGrid : (state.givenDigits ?? null);
  if (digitGrid === null) return;

  const duplicateCells = findDuplicateCells(digitGrid);
  if (duplicateCells.size > 0) {
    ctx.fillStyle = 'rgba(220, 38, 38, 0.15)';
    for (const key of duplicateCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  const givenCells = new Set<string>();
  if (state.puzzleType === 'classic' && state.userGrid !== null && state.givenDigits !== null) {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if ((state.givenDigits[r]?.[c] ?? 0) > 0) givenCells.add(`${r},${c}`);
    }
  }
  ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const digit = digitGrid[r]?.[c] ?? 0;
      if (digit > 0) {
        const key = `${r},${c}`;
        ctx.fillStyle = duplicateCells.has(key) ? '#dc2626'
          : (state.userGrid !== null && !givenCells.has(key)) ? '#2563eb'
          : '#000';
        ctx.fillText(String(digit), MARGIN + c * CELL + CELL / 2, MARGIN + r * CELL + CELL / 2);
      }
    }
  }
}

function drawCandidates(
  ctx: CanvasRenderingContext2D,
  userGrid: number[][],
  candidatesData: CandidatesResponse,
  showEss: boolean,
): void {
  const mustContainByCell = new Map<string, Set<number>>();
  for (const cage of candidatesData.cages) {
    const mc = new Set(cage.mustContain);
    for (const [r, c] of cage.cells) mustContainByCell.set(`${r},${c}`, mc);
  }
  const CAND_TOP = 13;
  const SUB_W = CELL / 3; const SUB_H = (CELL - CAND_TOP) / 3;
  ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((userGrid[r]?.[c] ?? 0) !== 0) continue;
      const cell = candidatesData.cells[r]?.[c];
      if (cell === undefined) continue;
      const candSet = new Set(cell.candidates);
      const removedSet = new Set(cell.userRemoved);
      const essSet = mustContainByCell.get(`${r},${c}`) ?? new Set<number>();
      for (let n = 1; n <= 9; n++) {
        const subRow = Math.floor((n - 1) / 3); const subCol = (n - 1) % 3;
        const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
        const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
        if (removedSet.has(n)) {
          ctx.fillStyle = '#d1d5db'; ctx.fillText(String(n), cx, cy);
          const hw = SUB_W * 0.35;
          ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cx - hw, cy); ctx.lineTo(cx + hw, cy); ctx.stroke();
        } else if (candSet.has(n)) {
          ctx.fillStyle = (essSet.has(n) && showEss) ? '#cc5a45' : '#888';
          ctx.fillText(String(n), cx, cy);
        }
      }
    }
  }
}

/**
 * Draws per-digit markers for the active hint:
 *   circles (red)  — eliminated digits in elimination cells
 *   squares (blue) — pattern digits in pattern (highlight) cells
 */
function drawHintDigitMarkers(
  ctx: CanvasRenderingContext2D,
  userGrid: number[][],
  candidatesData: CandidatesResponse,
): void {
  if (activeHintItem === null) return;
  const hint = activeHintItem;
  const CAND_TOP = 13;
  const SUB_W = CELL / 3;
  const SUB_H = (CELL - CAND_TOP) / 3;
  const R = Math.min(SUB_W, SUB_H) * 0.38;

  // Red circles around eliminated (cell, digit) pairs
  if (hint.eliminations.length > 0) {
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
    ctx.lineWidth = 1.5;
    for (const { cell: [r, c], digit: d } of hint.eliminations) {
      if ((userGrid[r]?.[c] ?? 0) !== 0) continue;
      const cellInfo = candidatesData.cells[r]?.[c];
      if (!cellInfo) continue;
      if (!cellInfo.candidates.includes(d) && !cellInfo.userRemoved.includes(d)) continue;
      const subRow = Math.floor((d - 1) / 3);
      const subCol = (d - 1) % 3;
      const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
      const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Blue squares around pattern digits in highlight (pattern) cells.
  // Skip any cell that is also an elimination cell — it gets a circle, not a square.
  const patternDigits: readonly number[] =
    hint.patternDigits ??
    (hint.placement !== null ? [hint.placement[2]] : [...new Set(hint.eliminations.map(e => e.digit))]);
  if (patternDigits.length > 0 && hint.highlightCells.length > 0) {
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)';
    ctx.lineWidth = 1.5;
    const hw = SUB_W * 0.38;
    const hh = SUB_H * 0.38;
    for (const [r, c] of hint.highlightCells) {
      if (hintElimCells.has(`${r},${c}`)) continue;   // elim cells get circles, not squares
      if ((userGrid[r]?.[c] ?? 0) !== 0) continue;
      const cellInfo = candidatesData.cells[r]?.[c];
      if (!cellInfo) continue;
      const candSet = new Set(cellInfo.candidates);
      for (const d of patternDigits) {
        if (!candSet.has(d)) continue;
        const subRow = Math.floor((d - 1) / 3);
        const subCol = (d - 1) % 3;
        const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
        const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
        ctx.strokeRect(cx - hw, cy - hh, 2 * hw, 2 * hh);
      }
    }
  }
}

function drawGrid(
  canvas: HTMLCanvasElement,
  state: PuzzleState,
  selected: { row: number; col: number } | null = null,
  showCands: boolean = false,
  highlightKeys: Set<string> | null = null,
  candidatesData: CandidatesResponse | null = null,
  vcSelection: Set<string> | null = null,
  showEss: boolean = true,
  draft?: { borderX: boolean[][], borderY: boolean[][] },
  errorCells?: Set<string>,
  suspectCells?: Set<string>,
): void {
  canvas.width = GRID_PX;
  canvas.height = GRID_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, GRID_PX, GRID_PX);
  drawUnderlays(ctx, candidatesData, vcSelection, highlightKeys, selected, errorCells, suspectCells);
  if (state.puzzleType !== 'classic') drawCageBorders(ctx, state, draft);
  drawGridLines(ctx);
  if (state.puzzleType !== 'classic') drawCageTotals(ctx, state);
  drawDigits(ctx, state);
  if (showCands && candidatesData !== null && state.userGrid !== null) {
    drawCandidates(ctx, state.userGrid, candidatesData, showEss);
    drawHintDigitMarkers(ctx, state.userGrid, candidatesData);
  }
}

function isGridSolved(state: PuzzleState): boolean {
  const grid = state.userGrid;
  if (grid === null) return false;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((grid[r]?.[c] ?? 0) === 0) return false;
    }
  }
  for (let i = 0; i < 9; i++) {
    const row = new Set<number>(); const col = new Set<number>();
    for (let j = 0; j < 9; j++) {
      const rd = grid[i]![j]!; if (row.has(rd)) return false; row.add(rd);
      const cd = grid[j]![i]!; if (col.has(cd)) return false; col.add(cd);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const box = new Set<number>();
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
        const d = grid[br * 3 + dr]![bc * 3 + dc]!;
        if (box.has(d)) return false; box.add(d);
      }
    }
  }
  if (state.puzzleType !== 'classic') {
    if (!isCageSumCorrect(grid, state.specData.regions, state.specData.cageTotals)) return false;
  }
  return true;
}

function closeSidePanels(): void {
  inspectCageMode = false;
  el<HTMLButtonElement>('inspect-cage-btn').classList.remove('active');
  el<HTMLElement>('inspector-col').hidden = true;
  el<HTMLElement>('playing-actions').hidden = false;
  el<HTMLElement>('side-panel').classList.remove('inspector-open');
  el<HTMLElement>('side-panel').classList.remove('virtual-cage-open');
}

function checkCompletion(state: PuzzleState): void {
  const solved = isGridSolved(state);
  el<HTMLElement>('completion-msg').hidden = !solved;
  if (solved) closeSidePanels();
  const actionIds = [
    'hints-btn', 'mode-toggle',
    'inspect-cage-btn', 'virtual-cage-btn', 'colour-btn', 'reveal-btn',
  ];
  for (const id of actionIds) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = solved;
  }
  for (let d = 0; d <= 9; d++) {
    const btn = document.getElementById(`digit-${d}`) as HTMLButtonElement | null;
    if (btn) btn.disabled = solved;
  }
}

function redrawGrid(): void {
  if (currentState === null) return;
  drawGrid(
    el<HTMLCanvasElement>('grid-canvas'),
    currentState,
    selectedCell,
    showCandidates,
    hintHighlightCells.size > 0 ? hintHighlightCells : null,
    currentCandidates,
    virtualCageSelection.size > 0 ? virtualCageSelection : null,
    showEssential,
    currentState?.userGrid === null ? { borderX: draftBorderX, borderY: draftBorderY } : undefined,
    reviewErrorCells.size > 0 ? reviewErrorCells : undefined,
    reviewSuspectCells.size > 0 ? reviewSuspectCells : undefined,
  );
  checkCompletion(currentState);
}

async function fetchCandidates(): Promise<void> {
  if (currentState === null) return;
  try {
    const data = computeCandidates();
    currentCandidates = data;
    setCandidatesCache(data);
    redrawGrid();
    renderVirtualCagePanel();
  } catch (e) {
    setStatus(String(e), true);
    reportBug(e, 'fetchCandidates');
  }
}

function refreshDisplay(): void {
  if (showCandidates) {
    void fetchCandidates();
  } else {
    redrawGrid();
  }
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

function renderState(state: PuzzleState): void {
  currentState = state;
  drawGrid(el<HTMLCanvasElement>('grid-canvas'), state);

  const heading = document.getElementById('detected-layout-heading');
  if (heading !== null) {
    heading.textContent = state.puzzleType === 'classic'
      ? 'Detected Layout — Classic Sudoku'
      : 'Detected Layout — Killer Sudoku';
  }

  el<HTMLElement>('classic-edit-hint').hidden =
    state.puzzleType !== 'classic' || state.userGrid !== null;

  if (state.originalImageUrl !== null) {
    el<HTMLImageElement>('original-img').src = state.originalImageUrl;
  }

  el<HTMLSelectElement>('puzzle-type-select').value = state.puzzleType;
  el<HTMLElement>('review-panel').dataset['puzzleType'] = state.puzzleType;

  el<HTMLElement>('review-panel').hidden = false;
  el<HTMLElement>('solution-panel').hidden = true;
}

function buildUploadCallouts(): { id: string; text: string }[] {
  return [
    { id: 'process-btn',      text: 'Tap here to analyse your photo and detect the grid and cages.' },
    { id: 'hard-puzzles-btn', text: 'Browse puzzles the rule engine cannot solve — try one and suggest a new rule.' },
    { id: 'help-btn',         text: 'Re-open this guide at any time.' },
    { id: 'feedback-btn',     text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
    { id: 'config-btn',       text: 'Configure which logical rules run automatically.' },
  ];
}

function buildPlayingCallouts(isKiller: boolean, fromFixture = false): { id: string; text: string }[] {
  const callouts: { id: string; text: string }[] = [
    { id: 'undo-btn',       text: 'Undo your last move.' },
    { id: 'hints-btn',      text: 'Request a logical hint to guide your next step.' },
    { id: 'mode-toggle',    text: 'Switch between Normal mode (place digits) and Candidate mode (edit pencil marks). The digit buttons work the same way in both modes.' },
    { id: 'colour-btn',     text: 'Colour cells blue/green to trace conjugate-pair chains. Tap a cell to colour it and auto-switch to the other colour. Tap a coloured cell to toggle it. Tap the button again to stop and clear.' },
    { id: 'reveal-btn',     text: 'Reveal the correct digit for the selected cell.' },
    { id: 'digit-1',        text: 'Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead. On a keyboard, Ctrl+digit works in the opposite mode.' },
    { id: 'new-puzzle-btn', text: 'Start a fresh puzzle.' },
    { id: 'edit-ocr-btn',   text: 'Return to the OCR review screen to correct any mis-read digits, then re-confirm.' },
    { id: 'logo-k',         text: 'Tap the K badge at any time to restart this tutorial.' },
  ];
  if (isKiller) {
    callouts.splice(3, 0,
      { id: 'inspect-cage-btn', text: 'Show remaining valid digit combinations for a cage.' },
      { id: 'virtual-cage-btn', text: 'Add a virtual cage constraint derived from the current board state.' },
    );
  }
  if (fromFixture) {
    callouts.push({
      id: 'feedback-btn',
      text: 'This puzzle stalled the rule engine. If you spot a logical deduction it missed, tap the envelope and choose "Rule suggestion" to share your idea.',
    });
  }
  return callouts;
}

function renderPlayingMode(state: PuzzleState): void {
  currentState = state;
  reviewErrorCells = new Set();
  reviewSuspectCells = new Set();
  kernelWarningShown = false;
  const data = getSettingsData();
  showCandidates = data.showCandidatesByDefault;
  candidateEditMode = false;
  refreshDisplay();
  el<HTMLElement>('upload-panel').hidden = true;
  el<HTMLElement>('review-panel').hidden = false;
  el<HTMLElement>('review-actions').hidden = true;
  el<HTMLElement>('original-col').hidden = true;
  el<HTMLElement>('warped-col').hidden = true;
  el<HTMLElement>('playing-actions').hidden = false;
  el<HTMLElement>('action-group').hidden = false;
  el<HTMLElement>('solution-panel').hidden = true;
  el<HTMLButtonElement>('new-puzzle-btn').hidden = false;
  updateUndoButton(state);
  updateRevealButton();
  el<HTMLButtonElement>('hints-btn').disabled = false;
  const isKiller = state.puzzleType !== 'classic';
  el<HTMLButtonElement>('inspect-cage-btn').hidden = !isKiller;
  el<HTMLButtonElement>('virtual-cage-btn').hidden = !isKiller;
  el<HTMLButtonElement>('colour-btn').hidden = false;
  el<HTMLButtonElement>('mode-toggle').hidden = !showCandidates;
  el<HTMLButtonElement>('mode-toggle').classList.remove('active');
}

function updateUndoButton(state: PuzzleState): void {
  const btn = el<HTMLButtonElement>('undo-btn');
  if (state.turns.length === 0) { btn.disabled = true; return; }
  const last = state.turns[state.turns.length - 1]!.action;
  btn.disabled = last.type === 'placeDigit' && last.source === 'given';
}

function updateRevealButton(): void {
  el<HTMLButtonElement>('reveal-btn').hidden =
    currentState === null || currentState.userGrid === null || selectedCell === null;
}

function setAutoApplyLock(locked: boolean): void {
  const lockable = [
    'undo-btn', 'hints-btn', 'mode-toggle', 'inspect-cage-btn',
    'virtual-cage-btn', 'reveal-btn',
    'digit-0', 'digit-1', 'digit-2', 'digit-3', 'digit-4',
    'digit-5', 'digit-6', 'digit-7', 'digit-8', 'digit-9',
    'new-puzzle-btn',
  ].map(id => el<HTMLButtonElement>(id));
  applyAutoApplyLock(lockable, el<HTMLButtonElement>('fast-forward-btn'), locked);
  if (!locked) fastForwardRequested = false;
}

async function handleReveal(): Promise<void> {
  if (currentState === null || selectedCell === null) return;
  const { row, col } = selectedCell;
  if (!confirm(`Reveal solution for ${cellLabel([row - 1, col - 1] as Cell)}?`)) return;
  logAction('reveal_used', cellLabel([row - 1, col - 1] as Cell));
  try {
    const sol = currentState.goldenSolution;
    if (sol === null) { setStatus('No solution cached — please confirm the puzzle first', true); return; }
    const digit = sol[row - 1]![col - 1]!;
    if (digit === 0) { setStatus('Solver could not determine this cell', true); return; }
    await handleCellEntry(digit);
    updateRevealButton();
  } catch (e) { setStatus(String(e), true); }
}

// ---------------------------------------------------------------------------
// Virtual cage panel
// ---------------------------------------------------------------------------

function renderSolutionList(
  container: HTMLElement,
  allSolutions: readonly (readonly number[])[],
  autoImpossible: readonly (readonly number[])[],
  userEliminated: readonly (readonly number[])[],
  onToggle: (soln: number[]) => void,
): void {
  if (allSolutions.length === 0) {
    const p = document.createElement('span');
    p.className = 'soln-item auto-impossible';
    p.textContent = '(no valid solutions)';
    container.appendChild(p);
    return;
  }
  const autoKeys = new Set(autoImpossible.map(s => s.join(',')));
  const elimKeys = new Set(userEliminated.map(s => [...s].join(',')));
  for (const soln of allSolutions) {
    const span = document.createElement('span');
    const key = soln.join(',');
    if (autoKeys.has(key)) {
      span.className = 'soln-item auto-impossible';
    } else if (elimKeys.has(key)) {
      span.className = 'soln-item user-eliminated';
      span.addEventListener('click', () => onToggle([...soln]));
    } else {
      span.className = 'soln-item active';
      span.addEventListener('click', () => onToggle([...soln]));
    }
    span.textContent = `{${soln.join(',')}}`;
    container.appendChild(span);
  }
}

function renderCageCard(
  container: HTMLElement,
  heading: string,
  info: SolutionCategorization,
  onToggle: (soln: number[]) => void,
): void {
  const headingEl = document.createElement('div');
  headingEl.className = 'vc-item-header';
  headingEl.textContent = heading;
  container.appendChild(headingEl);
  const solnsEl = document.createElement('div');
  solnsEl.className = 'vc-solutions';
  container.appendChild(solnsEl);
  renderSolutionList(solnsEl, info.allSolutions, info.autoImpossible, info.userEliminated, onToggle);
}

function renderVirtualCagePanel(): void {
  if (currentCandidates === null) return;
  const col = el<HTMLElement>('virtual-cage-col');

  // Filter to virtual cages containing the selected cell (0-based r,c).
  const sel = selectedCell;
  const vcs = currentCandidates.virtualCages.filter(vc =>
    sel !== null && vc.cells.some(([r, c]) => r === sel.row - 1 && c === sel.col - 1),
  );

  if (vcs.length > 0 || virtualCageMode) col.hidden = false;

  const list = el<HTMLElement>('virtual-cage-list');
  list.replaceChildren();
  for (const vc of vcs) {
    const item = document.createElement('div'); item.className = 'vc-item';
    const heading = `total ${vc.total} — ${vc.cells.length} cells: ` +
      vc.cells.map(cell => cellLabel(cell)).join(' ');
    renderCageCard(item, heading, vc, (soln) => { void handleEliminateVirtualCageSolution(vc.key, soln); });
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Cage inspector
// ---------------------------------------------------------------------------

function renderCageInspector(label: string): void {
  try {
    const upper = label.toUpperCase();
    // Use currentCandidates when fresh (avoids a duplicate buildEngine call);
    // fall back to computeCandidates() when candidates panel is hidden.
    const data = currentCandidates ?? computeCandidates();
    const cage = data.cages.find(c => c.label === upper);
    if (cage === undefined) return;
    const inspector = el<HTMLElement>('cage-inspector');
    clearChildren(inspector);
    el<HTMLElement>('inspector-heading').textContent = `Cage ${label}`;
    el<HTMLElement>('inspector-col').hidden = false;
    el<HTMLElement>('playing-actions').hidden = true;
    el<HTMLElement>('side-panel').classList.add('inspector-open');
    renderSolutionList(
      inspector,
      cage.allSolutions,
      cage.autoImpossible,
      cage.userEliminated,
      (soln) => { void handleEliminateSolution(label, soln); },
    );
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function handleEliminateSolution(label: string, solution: number[]): Promise<void> {
  try {
    const state = eliminateCageSolution(label, solution);
    // Null currentCandidates before renderPlayingMode so renderCageInspector
    // below always recomputes fresh data (fetchCandidates may update it again
    // synchronously inside refreshDisplay when showCandidates=true).
    currentCandidates = null;
    renderPlayingMode(state);
    renderCageInspector(label);
  } catch (e) { setStatus(String(e), true); }
}

async function handleEliminateVirtualCageSolution(vcKey: string, solution: number[]): Promise<void> {
  try {
    eliminateVirtualCageSolution(vcKey, solution);
    void fetchCandidates(); // re-renders virtual cage panel with updated eliminations
  } catch (e) { setStatus(String(e), true); }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(msg: string, isError = false): void {
  const cls = 'status' + (isError ? ' error' : '');
  for (const id of ['status-msg', 'review-status-msg']) {
    const el_ = document.getElementById(id);
    if (el_) { el_.textContent = msg; el_.className = cls; }
  }
}

function setLoading(on: boolean): void {
  el<HTMLButtonElement>('process-btn').disabled = on;
}

// ---------------------------------------------------------------------------
// Hint modal
// ---------------------------------------------------------------------------

function openRuleInfoModal(displayName: string, description: string): void {
  el<HTMLHeadingElement>('rule-info-title').textContent = displayName;
  const descEl = el<HTMLElement>('rule-info-description');
  descEl.innerHTML = '';
  for (const para of description.split('\n\n')) {
    const p = document.createElement('p');
    p.textContent = para;
    descEl.appendChild(p);
  }
  (el<HTMLDialogElement>('rule-info-modal') as HTMLDialogElement).showModal();
}

function showHintModal(hint: HintItem): void {
  activeHintItem = hint;
  hintHighlightCells = new Set(hint.highlightCells.map(([r, c]) => `${r},${c}`));
  hintElimCells = new Set(hint.eliminations.map(({ cell: [r, c] }) => `${r},${c}`));
  hintColourGroups = hint.colourGroups ?? [];
  redrawGrid();
  el<HTMLElement>('hint-modal-title').textContent = hint.displayName;
  el<HTMLElement>('hint-modal-explanation').textContent = hint.explanation;
  const ruleInfo = getSettingsData().hintableRules.find(r => r.name === hint.ruleName);
  const infoBtn = el<HTMLButtonElement>('hint-info-btn');
  if (ruleInfo) {
    infoBtn.hidden = false;
    infoBtn.onclick = () => openRuleInfoModal(ruleInfo.displayName, ruleInfo.description);
  } else {
    infoBtn.hidden = true;
    infoBtn.onclick = null;
  }
  const applyBtn = el<HTMLButtonElement>('hint-apply-btn');
  if (hint.rewindToTurnIdx !== null) {
    el<HTMLElement>('hint-modal-summary').textContent = 'Rewinding will undo all moves back to the last correct state.';
    applyBtn.textContent = 'Rewind';
  } else if (hint.placement !== null) {
    el<HTMLElement>('hint-modal-summary').textContent = `Places digit ${hint.placement[2]}.`;
    applyBtn.textContent = 'Place';
  } else if (hint.virtualCageSuggestion !== null) {
    el<HTMLElement>('hint-modal-summary').textContent = 'Adds this constraint as a virtual cage.';
    applyBtn.textContent = 'Add virtual cage';
  } else {
    const n = hint.eliminations.length;
    el<HTMLElement>('hint-modal-summary').textContent = n === 1 ? 'Eliminates 1 candidate.' : `Eliminates ${n} candidates.`;
    applyBtn.textContent = 'Apply';
  }
  (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).showModal();
}

function clearHintHighlight(): void {
  hintHighlightCells = new Set();
  hintElimCells = new Set();
  hintColourGroups = [];
  activeHintItem = null;
  hideHintPill(el('hint-pill'));
  redrawGrid();
}

function showAssertionModal(violation: AssertionViolation): void {
  el<HTMLElement>('assertion-desc').textContent = violation.ctx.description;
  el<HTMLButtonElement>('assertion-submit-btn').onclick = () => {
    const info = `[${violation.ctx.name}] ${violation.ctx.description}\n\nSolution:\n${violation.ctx.solutionJson}`;
    exceptionForSubmission = info;
    el<HTMLDialogElement>('assertion-modal').close();
    el<HTMLButtonElement>('feedback-btn').click();
  };
  (el<HTMLDialogElement>('assertion-modal') as HTMLDialogElement).showModal();
}

// ---------------------------------------------------------------------------
// Hint dropdown
// ---------------------------------------------------------------------------

function openConfigModal(): void {
  const data = getSettingsData();
  const alwaysApplySet = new Set(data.alwaysApplyRules);
  const list = el<HTMLElement>('config-rules-list');
  clearChildren(list);

  el<HTMLInputElement>('candidates-default-toggle').checked = data.showCandidatesByDefault;

  const ess = el<HTMLInputElement>('essential-toggle');
  ess.checked = showEssential;

  const delayInput = el<HTMLInputElement>('config-delay-input');
  delayInput.value = String(data.autoPlacementDelay);
  el<HTMLElement>('config-delay-label').textContent = data.autoPlacementDelay === 0 ? 'Off' : `${data.autoPlacementDelay} ms`;
  delayInput.oninput = () => {
    const v = Number(delayInput.value);
    el<HTMLElement>('config-delay-label').textContent = v === 0 ? 'Off' : `${v} ms`;
  };

  for (const rule of data.hintableRules) {
    const row = document.createElement('div'); row.className = 'config-rule-row';
    const nameSpan = document.createElement('span'); nameSpan.className = 'config-rule-name'; nameSpan.textContent = rule.displayName;
    const infoBtn = document.createElement('button'); infoBtn.className = 'btn-rule-info'; infoBtn.textContent = 'ⓘ'; infoBtn.title = 'About this rule';
    infoBtn.addEventListener('click', () => { openRuleInfoModal(rule.displayName, rule.description); });
    const select = document.createElement('select'); select.className = 'config-rule-select'; select.dataset['ruleName'] = rule.name;
    const optAuto = document.createElement('option'); optAuto.value = 'auto'; optAuto.textContent = 'Auto-apply';
    const optHint = document.createElement('option'); optHint.value = 'hint'; optHint.textContent = 'Hint-only';
    select.appendChild(optAuto); select.appendChild(optHint);
    select.value = alwaysApplySet.has(rule.name) ? 'auto' : 'hint';
    row.appendChild(nameSpan); row.appendChild(infoBtn); row.appendChild(select);
    list.appendChild(row);
  }
  (el<HTMLDialogElement>('config-modal') as HTMLDialogElement).showModal();
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Corner picker
// ---------------------------------------------------------------------------

function reportBug(e: unknown, context: string): void {
  const stack = e instanceof Error && e.stack ? `\n\nStack:\n${e.stack}` : '';
  pendingBug = { info: `Exception in ${context}:\n${String(e)}${stack}` };
}

function applyUploadResult(state: PuzzleState, warpedImageUrl: string | null, warning: string | null): void {
  reviewErrorCells = new Set();
  reviewSuspectCells = new Set();
  kernelWarningShown = false;
  renderState(state);
  const warpedCol = el<HTMLElement>('warped-col');
  const warpedImg = el<HTMLImageElement>('warped-img');
  if (warpedImageUrl) { warpedImg.src = warpedImageUrl; }
  el<HTMLElement>('original-col').hidden = state.originalImageUrl === null;
  warpedCol.hidden = warpedImageUrl === null;
  el<HTMLElement>('review-actions').hidden = false;
  // For Classic puzzles, show the digit pad so the user can correct OCR digits
  // by clicking buttons (not just keyboard). The action-group (undo, hints, etc.)
  // stays hidden — those controls are only active in playing mode.
  const isClassicReview = state.puzzleType === 'classic';
  el<HTMLElement>('completion-msg').hidden = true;
  el<HTMLElement>('playing-actions').hidden = !isClassicReview;
  if (isClassicReview) {
    el<HTMLButtonElement>('inspect-cage-btn').hidden = true;
    el<HTMLButtonElement>('virtual-cage-btn').hidden = true;
  }
  el<HTMLElement>('upload-panel').hidden = true;
  el<HTMLButtonElement>('new-puzzle-btn').hidden = false;
  el<HTMLButtonElement>('edit-ocr-btn').hidden = true;
  setStatus(warning ? `Warning: ${warning}` : '');
}

async function handleProcess(): Promise<void> {
  const fileInput = el<HTMLInputElement>('file-input');
  if (!fileInput.files || fileInput.files.length === 0) { setStatus('Please select an image or PDF file.', true); return; }
  // Clear any active fixture — the normal image pipeline takes over.
  currentFixtureName = null;
  currentFixtureUnsolvedCells = null;
  currentFixtureTotalCandidates = null;
  clearActionLog();
  const f = fileInput.files[0]!;
  logAction('file_selected', `${f.name} (${(f.size / 1024).toFixed(0)} KB)`);
  el<HTMLButtonElement>('edit-ocr-btn').hidden = true;
  lastOcrState = null;
  lastWarpedUrl = null;
  // Reset solver result so stale data from a previous run is never read.
  (window as unknown as Record<string, unknown>)['__lastSolverResult'] = null;
  setLoading(true);
  try {
    const { state, warpedImageUrl, warning, cellThumbs, mergedThumbs } = await uploadPuzzle(f);
    pendingCellThumbs = new Map(cellThumbs);
    pendingMergedThumbs = new Map(mergedThumbs);

    // Initialise draft borders from the OCR result (used in both paths below).
    const ocrSpec = dataToSpec(state.specData);
    draftBorderX = ocrSpec.borderX.map(col => [...col]);
    draftBorderY = ocrSpec.borderY.map(row => [...row]);
    draftEdited = false;
    // Expose pipeline result for Playwright integration tests (app.spec.ts).
    (window as unknown as Record<string, unknown>)['__lastPipelineResult'] = {
      cageTotals: state.specData.cageTotals,
      borderX: draftBorderX,
      borderY: draftBorderY,
    };

    const nCages = Math.max(...state.specData.regions.flat()) + 1;
    logAction('ocr_complete', `${state.puzzleType}, ${nCages} cage(s)${warning ? ', warning: ' + warning : ''}`);

    // Attempt auto-confirm (Killer only): skip the review screen when OCR is clean,
    // the cage layout is valid, and the solver finds a complete solution.
    // Classic puzzles always go to the review screen so the user can verify digits.
    if (warning === null && state.puzzleType !== 'classic') {
      const layoutResult = applyDraftLayout(draftBorderX, draftBorderY, state.specData.cageTotals);
      if (layoutResult.errorCells.size === 0 && layoutResult.warnings.length === 0) {
        // Yield to the browser so the loading indicator renders before the solve blocks.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const { board, usedBacktracking, stalledCandidates } = solveCurrentSpec();
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking,
          stalledCandidates: stalledCandidates ?? null,
          spec: dataToSpec(state.specData),
        };
        let boardComplete = true;
        for (let r = 0; r < 9 && boardComplete; r++)
          for (let c = 0; c < 9 && boardComplete; c++)
            if (board.cands(r, c).size !== 1) boardComplete = false;
        if (boardComplete) {
          lastOcrState = state;
          lastWarpedUrl = warpedImageUrl;
          logAction('auto_confirmed');
          const playing = confirmPuzzle(board);
          renderPlayingMode(playing);
          appendCallouts(buildPlayingCallouts(playing.puzzleType !== 'classic'));
          const autoViolation = checkSolutionAssertions(playing);
          if (autoViolation !== null) showAssertionModal(autoViolation);
          el<HTMLButtonElement>('edit-ocr-btn').hidden = false;
          pendingCellThumbs = new Map();
          pendingMergedThumbs = new Map();
          setStatus('');
          if (usedBacktracking && stalledCandidates && state.originalImageUrl !== null) {
            const stallReport = {
              reason: 'stall' as const,
              puzzleType: layoutResult.state.puzzleType,
              regions: layoutResult.state.specData.regions as number[][],
              cageTotals: layoutResult.state.specData.cageTotals as number[][],
              stalledCandidates,
            };
            submitPuzzleReport(
              stallReport,
              () => showTrainingConsentModal(() => submitPuzzleReport(stallReport)),
            );
          }
          return;
        }
      }
      // Auto-confirm failed — show review screen with the specific error.
      // applyDraftLayout returns the original state unchanged when errorCells exist.
      const stateToShow = layoutResult.errorCells.size > 0 ? state : layoutResult.state;
      applyUploadResult(stateToShow, warpedImageUrl, null);
      appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
      if (layoutResult.errorCells.size > 0) {
        logAction('review_shown', 'layout errors');
        reviewErrorCells = layoutResult.errorCells;
        redrawGrid();
        setStatus('Each cage needs exactly one total in its valid range — highlighted in red. If this is a Classic sudoku, change the Type dropdown to Classic.', true);
      } else if (layoutResult.warnings.length > 0) {
        logAction('review_shown', 'sum warning');
        setStatus(layoutResult.warnings.join('; ') + ' — please correct the totals before confirming', true);
      } else {
        logAction('review_shown', 'solver incomplete');
        setStatus('Solver could not determine all cells — please check the cage layout and totals', true);
      }
      return;
    }

    // Classic auto-confirm: if OCR is clean and given digits form a complete valid grid,
    // skip review and go straight to playing mode. When all 81 cells are filled we can give
    // specific feedback (duplicate highlights or solver-incomplete message) rather than the
    // generic review prompt — mirroring the Killer path's targeted error reporting.
    if (warning === null && state.puzzleType === 'classic' && state.givenDigits !== null) {
      const allFilled = state.givenDigits.every(row => row.every(d => d > 0));
      if (allFilled) {
        const dupCells = findDuplicateCells(state.givenDigits);
        if (dupCells.size > 0) {
          applyUploadResult(state, warpedImageUrl, null);
          appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
          logAction('review_shown', 'classic duplicates');
          reviewErrorCells = dupCells;
          redrawGrid();
          setStatus('Duplicate digits detected — correct the highlighted cells and press Confirm & Solve', true);
          return;
        }
        // All 81 cells filled, no duplicates — run solver and verify completeness (mirrors Killer path).
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const { board: classicBoard, usedBacktracking: classicUsedBt, stalledCandidates: classicStalled } = solveCurrentSpec();
        (window as unknown as Record<string, unknown>)['__lastSolverResult'] = {
          usedBacktracking: classicUsedBt,
          stalledCandidates: classicStalled ?? null,
          spec: dataToSpec(state.specData),
        };
        let boardComplete = true;
        for (let r = 0; r < 9 && boardComplete; r++)
          for (let c = 0; c < 9 && boardComplete; c++)
            if (classicBoard.cands(r, c).size !== 1) boardComplete = false;
        if (boardComplete) {
          lastOcrState = state;
          lastWarpedUrl = warpedImageUrl;
          logAction('auto_confirmed', 'classic');
          const classicPlaying = confirmPuzzle(classicBoard);
          renderPlayingMode(classicPlaying);
          appendCallouts(buildPlayingCallouts(false));
          const classicViolation = checkSolutionAssertions(classicPlaying);
          if (classicViolation !== null) showAssertionModal(classicViolation);
          el<HTMLButtonElement>('edit-ocr-btn').hidden = false;
          setStatus('');
          // Mirror the killer auto-confirm: upload stall state if backtracking
          // was needed, and upload OCR thumbnails. Both paths trigger consent.
          // Note: a direct E2E test of this path is impractical (requires a real
          // 81/81-digit OCR result); coverage comes from the manual-confirm path
          // tests and the underlying upload-function unit tests.
          if (classicUsedBt && classicStalled && state.originalImageUrl !== null) {
            const classicStallReport = {
              reason: 'stall' as const,
              puzzleType: 'classic' as const,
              regions: state.specData.regions as number[][],
              cageTotals: state.specData.cageTotals as number[][],
              stalledCandidates: classicStalled,
            };
            submitPuzzleReport(
              classicStallReport,
              () => showTrainingConsentModal(() => submitPuzzleReport(classicStallReport)),
            );
          }
          clearAndUploadTrainingData(extractTrainingData(
            pendingCellThumbs,
            state.givenDigits,
            'classic',
            defaultImagePipelineConfig().numberRecognition.subres,
          ));
          return;
        }
        applyUploadResult(state, warpedImageUrl, null);
        appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
        logAction('review_shown', 'classic solver incomplete');
        setStatus('Solver could not process the detected digits — please review and confirm manually', true);
        return;
      }
    }

    // Reach here when: OCR produced a warning, Classic grid is incomplete/invalid,
    // or this is a Classic puzzle the user needs to review.
    logAction('review_shown', state.puzzleType === 'classic' ? 'classic' : 'ocr warning');
    applyUploadResult(state, warpedImageUrl, warning ?? 'Review the detected digits and press Confirm & Solve');
    appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
  } catch (e) {
    if (e instanceof GridNotFoundError) {
      setStatus(e.message, true);
    } else {
      setStatus(`Processing failed: ${String(e)}`, true);
      reportBug(e, 'handleProcess');
    }
  }
  finally { setLoading(false); }
}

/**
 * Validates the current review state and prepares it for confirmation.
 * Returns an error string if the puzzle is invalid, or null if it is ready to solve.
 * For Killer puzzles this also updates reviewErrorCells and currentState as side effects.
 */
function validateCurrentReview(): string | null {
  if (currentState === null) return null;
  if (currentState.puzzleType === 'classic') {
    if (currentState.givenDigits !== null && hasDuplicateDigits(currentState.givenDigits)) {
      return 'Fix the duplicate digits (highlighted in red) before confirming';
    }
    return null;
  }
  // Killer: validate cage layout, then check the sum advisory.
  const result = applyDraftLayout(draftBorderX, draftBorderY, currentState.specData.cageTotals);
  if (result.errorCells.size > 0) {
    reviewErrorCells = result.errorCells;
    redrawGrid();
    return 'Each cage needs exactly one total in its valid range — highlighted in red';
  }
  // Sum outside [360, 450] is a strong signal of OCR errors — block and require correction.
  if (result.warnings.length > 0) {
    return result.warnings.join('; ') + ' — please correct the totals before confirming';
  }
  reviewErrorCells = new Set();
  currentState = result.state;
  return null;
}

function clearAndUploadTrainingData(data: TrainingExport | null): void {
  pendingCellThumbs = new Map();
  pendingMergedThumbs = new Map();
  if (data !== null && data.sampleCount > 0) {
    initiateUpload(data, d => showTrainingConsentModal(() => uploadTrainingData(d)));
  }
}

async function handleConfirm(): Promise<void> {
  if (currentState === null) return;
  setLoading(true);
  try {
    const validationError = validateCurrentReview();
    if (validationError !== null) {
      setStatus(validationError, true);
      return;
    }

    // Yield so the loading indicator renders before the solve blocks the main thread.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const { board: confirmedBoard, usedBacktracking: confirmUsedBacktracking, stalledCandidates: confirmStalledCandidates } = solveCurrentSpec();

    // Guard: validate the solver's output before confirming. Corrupted cage totals
    // can cause the rule engine to fill all cells with duplicate digits (invalid but
    // appearing complete). Returning early prevents the playing screen and stall upload.
    const solutionError = extractAndValidateSolution(confirmedBoard);
    if (solutionError !== null) {
      setStatus(
        `Invalid puzzle — cage totals appear to have OCR errors (${solutionError}). Correct the totals and try again.`,
        true,
      );
      return;
    }

    // Kernel analysis: if the solver stalled and this is the first confirm attempt,
    // run a bounded DFS to identify cells that are ambiguous due to OCR misreads.
    // Skip for classic puzzles (given digits are shown directly on the review screen)
    // and if ≥50 cells are unsolved (corrupted totals / inherently ambiguous spec).
    const stalledCount = confirmStalledCandidates?.flat().filter(c => c.length > 1).length ?? 0;
    if (confirmUsedBacktracking && confirmStalledCandidates && !kernelWarningShown
        && currentState.puzzleType !== 'classic' && stalledCount < 50) {
      const spec = dataToSpec(currentState.specData);
      const solution: number[][] = Array.from({ length: 9 }, (_, r) =>
        Array.from({ length: 9 }, (_, c) => [...confirmedBoard.cands(r, c)][0]!),
      );
      const analysis = analyseKernels(spec, confirmStalledCandidates, solution);
      if (analysis.ambiguousCells.length > 0) {
        kernelWarningShown = true;
        reviewSuspectCells = new Set(analysis.ambiguousCells.map(([r, c]) => `${r},${c}`));
        redrawGrid();
        const cellNames = analysis.ambiguousCells
          .map(([r, c]) => cellLabel([r, c]))
          .join(', ');
        setStatus(
          `OCR may have missed a digit in ${cellNames} (highlighted) — check the original image. Click Confirm again to proceed anyway.`,
          true,
        );
        return;
      }
    }

    const playing = confirmPuzzle(confirmedBoard);
    logAction('confirmed', currentState.puzzleType);
    renderPlayingMode(playing);
    appendCallouts(buildPlayingCallouts(playing.puzzleType !== 'classic'));
    setStatus('');
    const assertionViolation = checkSolutionAssertions(playing);
    if (assertionViolation !== null) showAssertionModal(assertionViolation);

    // Upload puzzle spec when backtracking was needed (rules alone couldn't solve it).
    if (confirmUsedBacktracking && confirmStalledCandidates && currentState.originalImageUrl !== null) {
      const stallReport = {
        reason: 'stall' as const,
        puzzleType: currentState.puzzleType,
        regions: currentState.specData.regions as number[][],
        cageTotals: currentState.specData.cageTotals as number[][],
        stalledCandidates: confirmStalledCandidates,
      };
      submitPuzzleReport(
        stallReport,
        () => showTrainingConsentModal(() => submitPuzzleReport(stallReport)),
      );
    }

    // Upload training samples when the user confirmed a puzzle.
    // Thumbnails are captured before state replacement; clear them now regardless.
    if (draftEdited && currentState.puzzleType !== 'classic') {
      clearAndUploadTrainingData(extractTrainingData(
        pendingCellThumbs,
        currentState.specData.cageTotals,
        currentState.puzzleType,
        defaultImagePipelineConfig().numberRecognition.subres,
        pendingMergedThumbs,
      ));
    } else if (currentState.puzzleType === 'classic' && currentState.givenDigits !== null) {
      clearAndUploadTrainingData(extractTrainingData(
        pendingCellThumbs,
        currentState.givenDigits,
        'classic',
        defaultImagePipelineConfig().numberRecognition.subres,
      ));
    } else {
      clearAndUploadTrainingData(null);
    }
  } catch (e) { setStatus(`Confirm failed: ${String(e)}`, true); }
  finally { setLoading(false); }
}

function showTrainingConsentModal(upload: () => void): void {
  const modal = el<HTMLDialogElement>('training-consent-modal');
  const onceBtn   = el<HTMLButtonElement>('training-consent-once-btn');
  const alwaysBtn = el<HTMLButtonElement>('training-consent-always-btn');
  const skipBtn   = el<HTMLButtonElement>('training-consent-skip-btn');
  const close = (): void => { modal.close(); };
  onceBtn.onclick   = () => { upload(); close(); };
  alwaysBtn.onclick = () => { grantConsent(); upload(); close(); };
  skipBtn.onclick   = close;
  modal.showModal();
}

async function handleCellEntry(digit: number): Promise<void> {
  if (currentState === null || selectedCell === null) return;
  try {
    if (digit === 0) logAction('cell_cleared', cellLabel([selectedCell.row - 1, selectedCell.col - 1] as Cell));
    else logAction('cell_entered', `${cellLabel([selectedCell.row - 1, selectedCell.col - 1] as Cell)}=${digit}`);
    const delay = getAutoPlacementDelay();
    if (delay === 0) {
      const state = enterCell(selectedCell.row, selectedCell.col, digit);
      currentState = state;
      refreshDisplay();
      updateUndoButton(state);
    } else {
      // Animated path: show the user's placement first, then step through each rule.
      setAutoApplyLock(true);
      try {
        // Synchronous display helper for use during animation.
        // Uses buildEngine(skipSolve:true) so candidates narrow progressively
        // one rule at a time, rather than collapsing to the solved state instantly.
        const animRefresh = (animState: PuzzleState): void => {
          if (showCandidates) {
            const data = computeAnimationCandidates(animState);
            currentCandidates = data;
            setCandidatesCache(data);
            redrawGrid();
          } else {
            redrawGrid();
          }
        };

        let state = enterCellStep(selectedCell.row, selectedCell.col, digit);
        currentState = state;
        animRefresh(currentState);
        updateUndoButton(state);
        await new Promise<void>(resolve => { setTimeout(resolve, fastForwardRequested ? 0 : delay); });
        while (true) {
          const step = getNextAutoApplyStep(currentState);
          if (step === null) break;

          if (fastForwardRequested) {
            currentState = applyAutoApplyStep(currentState, step);
            continue;
          }

          // Show hint pill + highlight for this rule, then wait.
          hintHighlightCells = new Set(step.highlightCells.map(([r, c]) => `${r},${c}`));
          hintElimCells = new Set(step.eliminations.map(({ cell: [r, c] }) => `${r},${c}`));
          showHintPill(el('hint-pill'), el('hint-pill-label'), step.displayName);
          animRefresh(currentState);
          await new Promise<void>(resolve => { setTimeout(resolve, delay); });

          // Apply the rule's changes and immediately show the result before next step.
          currentState = applyAutoApplyStep(currentState, step);
          hintHighlightCells = new Set();
          hintElimCells = new Set();
          hideHintPill(el('hint-pill'));
          animRefresh(currentState);
        }
        // Final cleanup after all steps (or fast-forward drain).
        // Commit the animation result to the global store (auto-placed digits in userGrid)
        // and clear the transient autoRemovedCandidates before the final full-solve refresh.
        hideHintPill(el('hint-pill'));
        hintHighlightCells = new Set();
        hintElimCells = new Set();
        const finalState: PuzzleState = { ...currentState, autoRemovedCandidates: [] };
        setState(finalState);
        currentState = finalState;
        refreshDisplay();
        updateUndoButton(currentState);
      } finally {
        setAutoApplyLock(false);
      }
    }
  } catch (e) { setStatus(String(e), true); }
}

async function handleUndo(): Promise<void> {
  try {
    logAction('undo');
    const state = undo();
    currentState = state;
    refreshDisplay();
    updateUndoButton(state);
  } catch (e) {
    setStatus(String(e), true);
    if (!(e instanceof UserFacingError)) reportBug(e, 'handleUndo');
  }
}

async function handleCandidateCycle(row1b: number, col1b: number, digit: number): Promise<void> {
  try {
    const state = cycleCandidate(row1b, col1b, digit);
    currentState = state;
    refreshDisplay();
    updateUndoButton(state);
  } catch (e) { setStatus(String(e), true); }
}

async function handleGivenDigitEdit(row1b: number, col1b: number, digit: number): Promise<void> {
  if (currentState === null) return;
  const givenDigits = currentState.givenDigits
    ? currentState.givenDigits.map(row => [...row])
    : Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  givenDigits[row1b - 1]![col1b - 1] = digit;
  currentState = { ...currentState, givenDigits };
  setState(currentState);
  reviewErrorCells = findDuplicateCells(givenDigits);
  redrawGrid();
}

async function submitVirtualCage(): Promise<void> {
  if (virtualCageSelection.size < 2) return;
  if (currentState?.userGrid !== null) {
    const allSolved = [...virtualCageSelection].every(k => {
      const [kr, kc] = k.split(',').map(Number);
      return (currentState!.userGrid![kr!]?.[kc!] ?? 0) !== 0;
    });
    if (allSolved) { setStatus('Cannot add virtual cage: all selected cells are already solved.', true); return; }
  }
  const totalInput = el<HTMLInputElement>('vc-total-input');
  const total = Number(totalInput.value);
  if (!total || total < 3) { totalInput.focus(); return; }
  const cells = [...virtualCageSelection].map(key => key.split(',').map(Number) as [number, number]);
  try {
    logAction('virtual_cage_added', `${cells.length} cells, total=${total}`);
    currentState = addVirtualCage(cells, total);
    virtualCageMode = false; virtualCageSelection = new Set();
    el<HTMLElement>('vc-form').hidden = true;
    el<HTMLElement>('side-panel').classList.remove('virtual-cage-open');
    totalInput.value = '';
    const vcBtn1 = el<HTMLButtonElement>('virtual-cage-btn');
    vcBtn1.classList.remove('active');
    vcBtn1.dataset['tooltip'] = 'Virtual cage';
    void fetchCandidates();
  } catch (e) { setStatus(`Virtual cage error: ${String(e)}`, true); }
}

// ---------------------------------------------------------------------------
// Feedback submission
// ---------------------------------------------------------------------------

async function handleFeedbackSubmit(): Promise<void> {
  const workerUrl = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;
  const description = el<HTMLTextAreaElement>('feedback-description').value.trim();
  if (!description) {
    el<HTMLElement>('feedback-status').textContent = 'Please enter a description.';
    el<HTMLTextAreaElement>('feedback-description').focus();
    return;
  }

  const isBug = el<HTMLInputElement>('feedback-type-bug').checked;
  const isNewRule = el<HTMLInputElement>('feedback-type-new-rule').checked;
  const feedbackType: 'bug' | 'enhancement' | 'new-rule' = isBug ? 'bug' : isNewRule ? 'new-rule' : 'enhancement';
  const bugCategory = isBug
    ? (el<HTMLInputElement>('bug-cat-wrong').checked ? 'wrong-behaviour' : 'inaccurate-description')
    : undefined;
  const expected = isBug ? el<HTMLTextAreaElement>('feedback-expected').value.trim() || undefined : undefined;

  const puzzleSpec = currentState !== null ? {
    puzzleType: currentState.puzzleType,
    regions: currentState.specData.regions,
    cageTotals: currentState.specData.cageTotals,
    userGrid: currentState.userGrid,
    givenDigits: currentState.givenDigits,
  } : null;

  const settings = loadSettings();

  // When a fixture is active and the user is filing a rule suggestion, attach
  // the fixture reference so it lands in the GitHub issue body.
  const fixtureCtx = isNewRule ? activeFixtureContext() : null;

  const payload = {
    version: 3 as const,
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    feedbackType,
    bugCategory,
    description,
    expected,
    actionLog: formatActionLog(),
    puzzleSpec,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    config: { alwaysApplyRules: settings.alwaysApplyRules, autoPlacementDelay: settings.autoPlacementDelay },
    exception: exceptionForSubmission ?? undefined,
    ...(fixtureCtx !== null && {
      fixtureName: fixtureCtx.name,
      unsolvedCells: fixtureCtx.unsolvedCells,
      totalCandidates: fixtureCtx.totalCandidates,
    }),
  };

  const statusEl = el<HTMLElement>('feedback-status');
  const submitBtn = el<HTMLButtonElement>('feedback-submit-btn');
  submitBtn.disabled = true;
  statusEl.textContent = 'Sending…';
  statusEl.className = 'status';

  if (!workerUrl) {
    // Dev fallback: log to console
    console.log('[Feedback]', payload);
    statusEl.textContent = 'Feedback logged to console (no worker URL configured).';
    submitBtn.disabled = false;
    return;
  }

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      exceptionForSubmission = null;
      statusEl.textContent = 'Thank you — feedback submitted.';
      setTimeout(() => { el<HTMLDialogElement>('feedback-modal').close(); }, 1500);
    } else {
      const text = await res.text();
      statusEl.textContent = `Submission failed (${res.status}): ${text}`;
      statusEl.className = 'status error';
    }
  } catch (e) {
    statusEl.textContent = `Submission failed: ${String(e)}`;
    statusEl.className = 'status error';
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// Waiting service worker: set when a new SW installs but has not yet taken control.
// Sent SKIP_WAITING via postMessage when the user clicks New Puzzle (state cleared).
let waitingSW: ServiceWorker | null = null;

// Register the offline service worker. Only runs in production builds — skipped
// during Vite dev mode to prevent the SW from intercepting HMR/module requests.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register('./sw.js')
    .then((registration) => {
      // Capture a SW that is already waiting (e.g. tab opened after a deploy
      // landed but before the user interacted with the page).
      if (registration.waiting) waitingSW = registration.waiting;

      // Capture future updates: fires when a new SW begins installing.
      registration.addEventListener('updatefound', () => {
        const sw = registration.installing;
        if (sw === null) return;
        sw.addEventListener('statechange', () => {
          // 'installed' means the SW finished installing and is now waiting.
          if (sw.state === 'installed') waitingSW = sw;
        });
      });
    })
    .catch(err => {
      console.warn('[SW] Registration failed:', err);
    });
}

// Dev-only test hook: lets Playwright tests inject a fake waiting SW so the
// SKIP_WAITING path can be exercised without a real service worker.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>)['__setWaitingSW'] =
    (sw: ServiceWorker | null) => { waitingSW = sw; };
}

// ---------------------------------------------------------------------------
// Hard Puzzles fixture panel
// ---------------------------------------------------------------------------

type FixtureMeta = Omit<StallFixtureFile, 'spec' | 'stalledCandidates'>;
let cachedFixtures: FixtureMeta[] | null = null;

async function loadFixtureList(): Promise<void> {
  if (cachedFixtures !== null) {
    renderFixtureTable(cachedFixtures);
    return;
  }
  try {
    const resp = await fetch('./stall-fixtures/index.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    cachedFixtures = (await resp.json()) as FixtureMeta[];
  } catch (err) {
    el<HTMLElement>('fixture-loading').textContent = 'Failed to load puzzle list.';
    console.error('[fixture-panel] fetch failed:', err);
    return;
  }
  renderFixtureTable(cachedFixtures);
}

function renderFixtureTable(fixtures: FixtureMeta[]): void {
  const container = el<HTMLElement>('fixture-list-content');
  container.replaceChildren();

  const table = document.createElement('table');
  table.className = 'fixture-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of ['Puzzle', 'Unsolved', 'Candidates']) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const meta of fixtures) {
    const tr = document.createElement('tr');

    for (const val of [meta.name, String(meta.unsolvedCells), String(meta.totalCandidates)]) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    }

    tr.addEventListener('click', () => {
      void (async () => {
        try {
          const resp = await fetch(
            `./stall-fixtures/${encodeURIComponent(meta.name)}.stall.json`,
          );
          if (!resp.ok) return;
          const fixture = (await resp.json()) as StallFixtureFile;
          if (fixture.puzzleType === 'classic' && fixture.givenDigits != null) {
            loadClassicDirect(fixture.givenDigits);
            draftBorderX = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
            draftBorderY = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(false));
          } else {
            loadSpecDirect(fixture.spec);
            draftBorderX = fixture.spec.borderX.map((col) => [...col]);
            draftBorderY = fixture.spec.borderY.map((row) => [...row]);
          }
          currentFixtureName = meta.name;
          currentFixtureUnsolvedCells = meta.unsolvedCells;
          currentFixtureTotalCandidates = meta.totalCandidates;
          const { board } = solveCurrentSpec();
          const playing = confirmPuzzle(board, fixture.stalledCandidates);
          el<HTMLElement>('fixture-panel').hidden = true;
          renderPlayingMode(playing);
          appendCallouts(buildPlayingCallouts(playing.puzzleType !== 'classic', true));
        } catch (err) {
          console.error('[fixture-panel] Failed to load fixture:', err);
        }
      })();
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {

  // Startup: load OpenCV (with download progress bar) and digit recogniser in parallel
  el<HTMLElement>('version-banner').textContent =
    `${import.meta.env.DEV ? 'dev' : 'prod'} ${__BUILD_TIME__}`;

  const cvRow = el<HTMLElement>('cv-loading-row');
  const cvLabel = el<HTMLElement>('cv-loading-label');
  const cvBar = el<HTMLProgressElement>('cv-progress');
  cvRow.style.display = 'flex';

  const cvWithProgress = loadCV('./opencv.js', (phase, ratio) => {
    if (phase === 'downloading') {
      cvBar.value = Math.round(ratio * 85); // reserve last 15% for WASM compilation
      cvLabel.textContent = `Downloading image pipeline… ${Math.round(ratio * 100)}%`;
    } else {
      cvBar.value = 90;
      cvLabel.textContent = 'Compiling (WASM)…';
    }
  }).then(cv => {
    cvBar.value = 100;
    cvLabel.textContent = 'Image pipeline ready';
    setTimeout(() => { cvRow.style.display = 'none'; }, 1500);
    return cv;
  });

  // Timeout: if the pipeline hasn't loaded in 30 s, tell the user how to diagnose.
  const loadTimeout = setTimeout(() => {
    cvLabel.textContent = 'Still loading — check browser console (F12) for errors';
    cvBar.removeAttribute('value'); // indeterminate
    console.warn('[CV] Pipeline not ready after 30 s. Common causes:\n' +
      '  1. opencv.js failed to fetch — check Network tab\n' +
      '  2. WASM init threw — look for [CV] errors above\n' +
      '  3. Stale service worker — Application > Storage > Clear site data, then reload');
  }, 30_000);

  void Promise.all([cvWithProgress, loadRec(), loadSplitRec()])
    .then(() => {
      clearTimeout(loadTimeout);
      (window as unknown as Record<string, unknown>)['__pipelineReady'] = true;
    })
    .catch(e => {
      clearTimeout(loadTimeout);
      cvRow.style.display = 'none';
      console.error('[CV] Pipeline load failed:', e);
      setStatus(`Image pipeline failed: ${String(e)} — open DevTools (F12) for details`, true);
    });

  // Tutorial — show help modal on first visit, then walk through button callouts.
  initTutorial();
  appendCallouts(buildUploadCallouts());

  el<HTMLDivElement>('logo-k').addEventListener('click', () => {
    const calloutEl = el<HTMLElement>('callout');
    const modalEl  = el<HTMLDialogElement>('general-help-modal');
    // No-op if a callout is showing or the modal is already open.
    if (!calloutEl.hidden || modalEl.open) return;

    localStorage.removeItem('coach_tutorial_suppressed');
    initTutorial(); // resets calloutQueue/calloutStarted/tutorialActive; shows modal

    // Pre-fill the queue for the current screen BEFORE the user dismisses the modal.
    // appendCallouts() skips advanceCallout() while calloutStarted === false, so the
    // sequence only starts when the modal closes and sets calloutStarted = true.
    const inPlaying = currentState !== null;
    const inReview  = !inPlaying && !el<HTMLElement>('review-panel').hidden;
    if (inPlaying) {
      appendCallouts(buildPlayingCallouts(currentState!.puzzleType !== 'classic'));
    } else if (inReview) {
      appendCallouts([{ id: 'confirm-btn', text: 'When the grid looks correct, confirm to start solving.' }]);
    } else {
      appendCallouts(buildUploadCallouts());
    }
  });

  el<HTMLButtonElement>('process-btn').addEventListener('click', () => { void handleProcess(); });
  el<HTMLButtonElement>('confirm-btn').addEventListener('click', () => { void handleConfirm(); });

  el<HTMLButtonElement>('undo-btn').addEventListener('click', () => { void handleUndo(); });
  el<HTMLButtonElement>('reveal-btn').addEventListener('click', () => { void handleReveal(); });

  el<HTMLSelectElement>('puzzle-type-select').addEventListener('change', (e) => {
    if (currentState === null) return;
    const type = (e.target as HTMLSelectElement).value as 'killer' | 'classic';
    const updated = { ...currentState, puzzleType: type };
    import('./session/store.js').then(m => m.setState(updated));
    currentState = updated;
    renderState(updated);
  });

  // ── Inline cage total editing overlay ───────────────────────────────────────────────────────────────────────────────────────
  const cageTotalInput = el<HTMLInputElement>('cage-total-edit');

  function commitTotalEdit(): void {
    if (totalEditCell === null || currentState === null) return;
    const { row, col } = totalEditCell;
    const v = Number(cageTotalInput.value);
    const newTotal = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
    const newTotals = currentState.specData.cageTotals.map((r, ri) =>
      ri === row ? r.map((val, ci) => (ci === col ? newTotal : val)) : [...r],
    );
    currentState = { ...currentState, specData: { ...currentState.specData, cageTotals: newTotals } };
    logAction('total_edited', `r${row}c${col}=${newTotal}`);
    draftEdited = true;
    totalEditCell = null;
    cageTotalInput.style.display = 'none';
    redrawGrid();
  }

  cageTotalInput.addEventListener('blur', commitTotalEdit);
  cageTotalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTotalEdit(); }
    if (e.key === 'Escape') {
      if (totalEditCell !== null && currentState !== null) {
        const { row, col } = totalEditCell;
        const prev = totalEditPrev;
        const newTotals = currentState.specData.cageTotals.map((r, ri) =>
          ri === row ? r.map((val, ci) => (ci === col ? prev : val)) : [...r],
        );
        currentState = { ...currentState, specData: { ...currentState.specData, cageTotals: newTotals } };
      }
      totalEditCell = null;
      cageTotalInput.style.display = 'none';
      redrawGrid();
    }
  });
  // ───────────────────────────────────────────────────────────────────────────────────────

  el<HTMLButtonElement>('new-puzzle-btn').addEventListener('click', () => {
    logAction('new_puzzle');
    clearActionLog();
    currentState = null; currentCandidates = null; selectedCell = null;
    showCandidates = false; candidateEditMode = false;
    virtualCageMode = false; virtualCageSelection = new Set();
    hintHighlightCells = new Set(); hintElimCells = new Set(); hintColourGroups = []; activeHintItem = null;
    colourMode = 'off'; cellColours.clear();
    inspectCageMode = false;
    el<HTMLButtonElement>('inspect-cage-btn').classList.remove('active');
    el<HTMLElement>('inspector-col').hidden = true;
    el<HTMLElement>('side-panel').classList.remove('inspector-open');
    el<HTMLElement>('side-panel').classList.remove('virtual-cage-open');
    totalEditCell = null;
    reviewErrorCells = new Set();
    draftEdited = false;
    pendingCellThumbs = new Map();
    pendingMergedThumbs = new Map();
    el<HTMLElement>('upload-panel').hidden = false;
    el<HTMLElement>('review-panel').hidden = true;
    el<HTMLElement>('solution-panel').hidden = true;
    el<HTMLElement>('playing-actions').hidden = true;
    el<HTMLElement>('action-group').hidden = true;
    el<HTMLButtonElement>('new-puzzle-btn').hidden = true;
    el<HTMLButtonElement>('hints-btn').disabled = true;
    el<HTMLButtonElement>('inspect-cage-btn').hidden = true;
    el<HTMLButtonElement>('virtual-cage-btn').hidden = true;
    el<HTMLButtonElement>('colour-btn').hidden = true;
    el<HTMLButtonElement>('colour-btn').classList.remove('active');
    el<HTMLButtonElement>('reveal-btn').hidden = true;
    el<HTMLInputElement>('file-input').value = '';
    setStatus('');

    // Apply any pending SW update now that all puzzle state has been cleared.
    // The page will reload once the new SW activates and fires controllerchange.
    if (waitingSW !== null) {
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => location.reload(),
        { once: true },
      );
      waitingSW.postMessage({ type: 'SKIP_WAITING' });
      waitingSW = null;
    }
  });

  el<HTMLButtonElement>('edit-ocr-btn').addEventListener('click', () => {
    if (lastOcrState === null) return;
    revertToOcr(lastOcrState);
    // Re-initialise draft borders from the saved OCR spec.
    const ocrSpec = dataToSpec(lastOcrState.specData);
    draftBorderX = ocrSpec.borderX.map(col => [...col]);
    draftBorderY = ocrSpec.borderY.map(row => [...row]);
    draftEdited = false;
    applyUploadResult(lastOcrState, lastWarpedUrl, null);
    appendCallouts([{ id: 'confirm-btn', text: 'Correct any OCR errors, then confirm to re-solve.' }]);
  });

  el<HTMLButtonElement>('hard-puzzles-btn').addEventListener('click', () => {
    const uploadPanel = el<HTMLElement>('upload-panel');
    const fixturePanel = el<HTMLElement>('fixture-panel');
    // showingFixtures is true when the fixture panel is currently visible.
    // Toggling: if currently showing fixtures → return to upload; else → show fixtures.
    const showingFixtures = !fixturePanel.hidden;
    uploadPanel.hidden = !showingFixtures;  // hide upload when entering fixture view
    fixturePanel.hidden = showingFixtures;  // hide fixture when returning to upload
    if (!showingFixtures) void loadFixtureList();
  });

  el<HTMLButtonElement>('help-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('general-help-modal') as HTMLDialogElement).showModal();
  });
  el<HTMLButtonElement>('general-help-close-btn').addEventListener('click', () => {
    el<HTMLDialogElement>('general-help-modal').close();
  });

  // ── Feedback modal ───────────────────────────────────────────────────────────
  el<HTMLButtonElement>('feedback-btn').addEventListener('click', () => {
    // Default to bug report
    el<HTMLInputElement>('feedback-type-bug').checked = true;
    el<HTMLElement>('feedback-bug-fields').style.display = '';
    el<HTMLElement>('feedback-description-label').textContent = 'What happened?';
    el<HTMLTextAreaElement>('feedback-description').value = '';
    el<HTMLTextAreaElement>('feedback-expected').value = '';
    el<HTMLInputElement>('bug-cat-wrong').checked = true;
    el<HTMLElement>('feedback-status').textContent = '';

    const entries = getActionLog();
    el<HTMLElement>('feedback-trace-count').textContent = String(entries.length);
    el<HTMLElement>('feedback-trace').textContent = formatActionLog();

    if (pendingBug !== null) {
      el<HTMLInputElement>('feedback-type-bug').click();
      el<HTMLTextAreaElement>('feedback-description').value = pendingBug.info;
      exceptionForSubmission = pendingBug.info;
      pendingBug = null;
    }

    (el<HTMLDialogElement>('feedback-modal') as HTMLDialogElement).showModal();
  });

  el<HTMLInputElement>('feedback-type-bug').addEventListener('change', () => {
    el<HTMLElement>('feedback-bug-fields').style.display = '';
    el<HTMLElement>('feedback-description-label').textContent = 'What happened?';
  });
  el<HTMLInputElement>('feedback-type-enhancement').addEventListener('change', () => {
    el<HTMLElement>('feedback-bug-fields').style.display = 'none';
    el<HTMLElement>('feedback-description-label').textContent = 'What would you like to see?';
  });
  el<HTMLInputElement>('feedback-type-new-rule').addEventListener('change', () => {
    el<HTMLElement>('feedback-bug-fields').style.display = 'none';
    el<HTMLElement>('feedback-description-label').textContent = 'Describe the rule you think would unlock this puzzle';
  });

  el<HTMLButtonElement>('feedback-cancel-btn').addEventListener('click', () => {
    el<HTMLDialogElement>('feedback-modal').close();
  });

  el<HTMLButtonElement>('feedback-submit-btn').addEventListener('click', () => {
    void handleFeedbackSubmit();
  });
  // ─────────────────────────────────────────────────────────────────────────────

  el<HTMLButtonElement>('config-btn').addEventListener('click', () => { openConfigModal(); });
  el<HTMLButtonElement>('config-cancel-btn').addEventListener('click', () => { el<HTMLDialogElement>('config-modal').close(); });
  el<HTMLButtonElement>('config-save-btn').addEventListener('click', () => {
    const selects = el<HTMLElement>('config-rules-list').querySelectorAll<HTMLSelectElement>('select[data-rule-name]');
    const alwaysApply: string[] = [];
    selects.forEach(s => { if (s.value === 'auto' && s.dataset['ruleName']) alwaysApply.push(s.dataset['ruleName']); });
    showEssential = el<HTMLInputElement>('essential-toggle').checked;
    const delay = Number(el<HTMLInputElement>('config-delay-input').value);
    const showCandDefault = el<HTMLInputElement>('candidates-default-toggle').checked;
    saveSettingsData(alwaysApply, delay, showCandDefault);
    el<HTMLDialogElement>('config-modal').close();
    if (currentState !== null) refreshDisplay();
  });
  el<HTMLButtonElement>('rule-info-close-btn').addEventListener('click', () => { el<HTMLDialogElement>('rule-info-modal').close(); });

  // Mode toggle (Normal | Candidates) — also acts as a safety to restore the digit pad
  el<HTMLButtonElement>('mode-toggle').addEventListener('click', () => {
    candidateEditMode = !candidateEditMode;
    el<HTMLButtonElement>('mode-toggle').classList.toggle('active', candidateEditMode);
    closeSidePanels();
  });

  el<HTMLButtonElement>('close-help-btn').addEventListener('click', () => { el<HTMLDialogElement>('help-candidates-modal').close(); });

  // Colouring tool
  el<HTMLButtonElement>('colour-btn').addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('colour-btn');
    if (colourMode === 'off') {
      colourMode = 'blue-next';
      btn.classList.add('active');
      btn.dataset['tooltip'] = 'Colouring active (press to stop and clear)';
    } else {
      colourMode = 'off';
      cellColours.clear();
      btn.classList.remove('active');
      btn.dataset['tooltip'] = 'Colour cells';
    }
    redrawGrid();
  });

  // Virtual cage
  el<HTMLButtonElement>('virtual-cage-btn').addEventListener('click', () => {
    virtualCageMode = !virtualCageMode;
    virtualCageSelection = new Set();
    const vcBtn = el<HTMLButtonElement>('virtual-cage-btn');
    vcBtn.classList.toggle('active', virtualCageMode);
    vcBtn.dataset['tooltip'] = virtualCageMode ? 'Cancel virtual cage' : 'Virtual cage';
    el<HTMLElement>('vc-form').hidden = !virtualCageMode;
    if (virtualCageMode) {
      el<HTMLElement>('virtual-cage-col').hidden = false;
      el<HTMLElement>('side-panel').classList.add('virtual-cage-open');
    } else {
      el<HTMLElement>('side-panel').classList.remove('virtual-cage-open');
    }
    redrawGrid();
  });
  el<HTMLButtonElement>('vc-add-btn').addEventListener('click', () => { void submitVirtualCage(); });
  el<HTMLButtonElement>('vc-cancel-btn').addEventListener('click', () => {
    virtualCageMode = false; virtualCageSelection = new Set();
    el<HTMLElement>('vc-form').hidden = true;
    el<HTMLElement>('side-panel').classList.remove('virtual-cage-open');
    const vcBtn2 = el<HTMLButtonElement>('virtual-cage-btn');
    vcBtn2.classList.remove('active');
    vcBtn2.dataset['tooltip'] = 'Virtual cage';
    redrawGrid();
  });

  // Cage inspector
  el<HTMLButtonElement>('inspect-cage-btn').addEventListener('click', () => {
    inspectCageMode = !inspectCageMode;
    const inspBtn = el<HTMLButtonElement>('inspect-cage-btn');
    inspBtn.classList.toggle('active', inspectCageMode);
    inspBtn.dataset['tooltip'] = inspectCageMode ? 'Done inspecting' : 'Inspect cage';
    if (!inspectCageMode) {
      el<HTMLElement>('inspector-col').hidden = true;
      el<HTMLElement>('playing-actions').hidden = false;
      el<HTMLElement>('side-panel').classList.remove('inspector-open');
    }
  });

  // Hints list modal
  const hintsListModal = el<HTMLDialogElement>('hints-list-modal');
  hintsListModal.addEventListener('click', e => {
    if (e.target === hintsListModal) hintsListModal.close();
  });
  el<HTMLButtonElement>('hints-list-close-btn').addEventListener('click', () => {
    hintsListModal.close();
  });

  el<HTMLButtonElement>('hints-btn').addEventListener('click', () => {
    const content = el<HTMLElement>('hints-list-content');
    clearChildren(content);
    try {
      const { hints } = getHints();
      if (hints.length === 0) {
        const p = document.createElement('p'); p.className = 'hints-empty'; p.textContent = 'No hint found — this position may require a technique not yet supported. Try Reveal for the selected cell.';
        content.appendChild(p);
      } else {
        const rulesMap = new Map(getSettingsData().hintableRules.map(r => [r.name, r]));
        for (const hint of hints) {
          const row = document.createElement('div'); row.className = 'hint-list-row';
          const btn = document.createElement('button'); btn.className = 'hint-item'; btn.textContent = hint.displayName;
          btn.addEventListener('click', () => { hintsListModal.close(); showHintModal(hint); });
          row.appendChild(btn);
          const ruleInfo = rulesMap.get(hint.ruleName);
          if (ruleInfo) {
            const infoBtn = document.createElement('button'); infoBtn.className = 'btn-rule-info'; infoBtn.textContent = 'ⓘ'; infoBtn.title = 'About this rule';
            infoBtn.addEventListener('click', () => { openRuleInfoModal(ruleInfo.displayName, ruleInfo.description); });
            row.appendChild(infoBtn);
          }
          content.appendChild(row);
        }
      }
    } catch (e) {
      if (e instanceof AssertionViolation) {
        showAssertionModal(e);
        return;
      }
      const p = document.createElement('p'); p.className = 'hints-empty'; p.textContent = String(e);
      content.appendChild(p);
    }
    hintsListModal.showModal();
  });

  // Hint modal
  el<HTMLButtonElement>('hint-apply-btn').addEventListener('click', () => {
    if (activeHintItem === null) return;
    (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).close();
    const hint = activeHintItem;
    clearHintHighlight();

    logAction('hint_applied', hint.displayName);
    if (hint.rewindToTurnIdx !== null) {
      try { currentState = rewind(hint.rewindToTurnIdx); refreshDisplay(); updateUndoButton(currentState); } catch (e) { setStatus(String(e), true); }
    } else if (hint.placement !== null) {
      selectedCell = { row: hint.placement[0] + 1, col: hint.placement[1] + 1 };
      void handleCellEntry(hint.placement[2]);
    } else if (hint.virtualCageSuggestion !== null) {
      const { cells, total } = hint.virtualCageSuggestion;
      try { currentState = addVirtualCage([...cells], total); void fetchCandidates(); } catch (e) { setStatus(String(e), true); }
    } else {
      try { currentState = applyHint(hint.eliminations); refreshDisplay(); updateUndoButton(currentState); } catch (e) { setStatus(String(e), true); }
    }
  });

  el<HTMLButtonElement>('hint-close-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).close();
    clearHintHighlight();
  });

  el<HTMLButtonElement>('fast-forward-btn').addEventListener('click', () => {
    fastForwardRequested = true;
  });

  el<HTMLButtonElement>('hint-minimize-btn').addEventListener('click', () => {
    if (activeHintItem === null) return;
    (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).close();
    showHintPill(el('hint-pill'), el('hint-pill-label'), activeHintItem.displayName);
  });

  el('hint-pill').addEventListener('click', () => {
    if (activeHintItem === null) return;
    hideHintPill(el('hint-pill'));
    showHintModal(activeHintItem);
  });

  el<HTMLButtonElement>('assertion-dismiss-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('assertion-modal') as HTMLDialogElement).close();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (currentState === null || currentState.userGrid === null) {
      // Pre-confirm: classic inline editing
      if (currentState?.puzzleType === 'classic' && selectedCell !== null) {
        if (e.key >= '1' && e.key <= '9') { void handleGivenDigitEdit(selectedCell.row, selectedCell.col, Number(e.key)); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { void handleGivenDigitEdit(selectedCell.row, selectedCell.col, 0); return; }
      }
      return;
    }

    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;

    if (selectedCell !== null) {
      const resolved = resolveDigitKey(candidateEditMode, e.ctrlKey, e.key);
      if (resolved !== null) {
        if (e.ctrlKey) e.preventDefault();
        if (resolved.action === 'placeDigit') {
          void handleCellEntry(resolved.digit);
        } else {
          void handleCandidateCycle(selectedCell.row, selectedCell.col, resolved.digit);
        }
        return;
      }
    }

    if (selectedCell !== null) {
      const { row, col } = selectedCell;
      if (e.key === 'ArrowUp' && row > 1) { selectedCell = { row: row - 1, col }; redrawGrid(); updateRevealButton(); }
      else if (e.key === 'ArrowDown' && row < 9) { selectedCell = { row: row + 1, col }; redrawGrid(); updateRevealButton(); }
      else if (e.key === 'ArrowLeft' && col > 1) { selectedCell = { row, col: col - 1 }; redrawGrid(); updateRevealButton(); }
      else if (e.key === 'ArrowRight' && col < 9) { selectedCell = { row, col: col + 1 }; redrawGrid(); updateRevealButton(); }
    }
  });

  // Canvas click — cell selection / virtual cage drawing / cage inspection
  el<HTMLCanvasElement>('grid-canvas').addEventListener('mousedown', (e) => {
    if (currentState === null) return;
    const canvas = el<HTMLCanvasElement>('grid-canvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX - MARGIN;
    const y = (e.clientY - rect.top) * scaleY - MARGIN;
    const c0 = Math.floor(x / CELL);  // 0-based
    const r0 = Math.floor(y / CELL);  // 0-based
    if (c0 < 0 || c0 > 8 || r0 < 0 || r0 > 8) return;

    // ── Review-mode interaction (before confirm) ─────────────────────────────────────────────────────────────────────────────────────
    if (currentState.userGrid === null && currentState.puzzleType !== 'classic') {
      // Review mode: borders always togglable; interior click handled by Chunk 2 (total overlay).
      const BORDER_ZONE = 7; // px
      for (let r = 1; r < 9; r++) {
        if (Math.abs(y - r * CELL) < BORDER_ZONE) {
          draftBorderX[c0]![r - 1] = !draftBorderX[c0]![r - 1];
          logAction('border_toggled', `row-gap ${r} col ${c0}`);
          draftEdited = true; redrawGrid(); return;
        }
      }
      for (let c = 1; c < 9; c++) {
        if (Math.abs(x - c * CELL) < BORDER_ZONE) {
          draftBorderY[c - 1]![r0] = !draftBorderY[c - 1]![r0];
          logAction('border_toggled', `col-gap ${c} row ${r0}`);
          draftEdited = true; redrawGrid(); return;
        }
      }
      // Interior click — open total-edit overlay on the clicked cell.
      // e.preventDefault() prevents the browser from moving focus to document.body
      // after mousedown on a non-focusable canvas, which would fire blur on the
      // input and immediately hide the overlay.
      e.preventDefault();
      const existing = currentState.specData.cageTotals[r0]![c0]!;
      totalEditCell = { row: r0, col: c0 };
      totalEditPrev = existing;
      const inp = el<HTMLInputElement>('cage-total-edit');
      const cssScale = rect.width / canvas.width;
      const cellCss = CELL * cssScale;
      inp.style.left     = `${(MARGIN + c0 * CELL) * cssScale}px`;
      inp.style.top      = `${(MARGIN + r0 * CELL) * cssScale}px`;
      inp.style.width    = `${cellCss}px`;
      inp.style.height   = `${cellCss}px`;
      inp.style.fontSize = `${26 * cssScale}px`;
      inp.value = existing > 0 ? String(existing) : '';
      inp.style.display = 'block';
      inp.focus();
      inp.select();
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────────────────

    if (colourMode !== 'off' && !candidateEditMode) {
      const key = `${r0},${c0}`;
      const existing = cellColours.get(key);
      const colour = existing !== undefined
        ? (existing === 'blue' ? 'green' : 'blue')  // toggle existing colour
        : (colourMode === 'blue-next' ? 'blue' : 'green');
      cellColours.set(key, colour);
      colourMode = colour === 'blue' ? 'green-next' : 'blue-next';
      // Fall through so the cell is also selected and keypad remains usable
    }

    if (virtualCageMode) {
      const key = `${r0},${c0}`;
      if (virtualCageSelection.has(key)) virtualCageSelection.delete(key); else virtualCageSelection.add(key);
      const vcStatus = el<HTMLElement>('vc-selection-status');
      const allSolved = virtualCageSelection.size >= 2 && currentState.userGrid !== null &&
        [...virtualCageSelection].every(k => {
          const [kr, kc] = k.split(',').map(Number);
          return (currentState!.userGrid![kr!]?.[kc!] ?? 0) !== 0;
        });
      vcStatus.textContent = virtualCageSelection.size < 2
        ? 'Click cells on the grid'
        : allSolved ? 'All cells already solved — select unsolved cells'
        : `${virtualCageSelection.size} cells selected`;
      el<HTMLButtonElement>('vc-add-btn').disabled = allSolved || virtualCageSelection.size < 2;
      redrawGrid();
      return;
    }

    if (inspectCageMode && currentState.userGrid !== null) {
      const cageIdx = currentState.specData.regions[r0]?.[c0];
      if (cageIdx !== undefined) {
        const cage = currentState.cageStates[cageIdx - 1];
        if (cage) {
          selectedCell = { row: r0 + 1, col: c0 + 1 };
          renderCageInspector(cage.label);
          renderVirtualCagePanel();
          redrawGrid();
        }
      }
      return;
    }

    selectedCell = { row: r0 + 1, col: c0 + 1 };  // convert to 1-based
    redrawGrid();
    updateRevealButton();
  });

  // Digit buttons — pre-confirm Classic edits given digits; edit-candidates mode toggles a
  // candidate; otherwise places a digit in the playing grid.
  function handleDigitButton(d: number): void {
    if (currentState?.userGrid === null && currentState?.puzzleType === 'classic' && selectedCell !== null) {
      void handleGivenDigitEdit(selectedCell.row, selectedCell.col, d);
    } else if (candidateEditMode && selectedCell !== null) {
      void handleCandidateCycle(selectedCell.row, selectedCell.col, d);
    } else {
      void handleCellEntry(d);
    }
  }
  for (let d = 1; d <= 9; d++) {
    const btn = document.getElementById(`digit-${d}`);
    if (btn) btn.addEventListener('click', () => handleDigitButton(d));
  }
  const clearBtn = document.getElementById('digit-0');
  if (clearBtn) clearBtn.addEventListener('click', () => handleDigitButton(0));

  // Dev/test hook — skipped in production builds by Vite's dead-code elimination.
  // Exposes window.__testLoad() so Playwright tests can exercise the full
  // review→confirm→playing UI flow without OpenCV or a real puzzle image.
  if (import.meta.env.DEV) {
    // 'trivial'     — all 81 cells are single-cell cages; all auto-placed after confirm.
    // 'twoCellCage' — top-left two cells share a cage (sum 8); still over-constrained.
    // 'boxCage'     — 9 box cages (3×3 each, sum 45); no cell auto-placed → digit entry works.
    // 'classic'     — Classic sudoku with one blank cell; always goes to review screen.
    (window as unknown as Record<string, unknown>)['__testLoad'] = (specName?: string) => {
      if (specName === 'classic' || specName === 'classicPartial') {
        const givenDigits = specName === 'classicPartial'
          ? makeClassicPartialGivenDigits()
          : makeClassicGivenDigits();
        const { state, warpedImageUrl, warning } = loadClassicDirect(givenDigits);
        // Classic borders: all walls present; values don't affect Classic rendering/confirm.
        draftBorderX = Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true));
        draftBorderY = Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => true));
        draftEdited = false;
        applyUploadResult(state, warpedImageUrl, warning);
        return;
      }
      let spec;
      if (specName === 'twoCellCage') spec = makeTwoCellCageSpec();
      else if (specName === 'boxCage') spec = makeBoxCageSpec();
      else spec = makeTrivialSpec();
      const { state, warpedImageUrl, warning } = loadSpecDirect(spec);
      draftBorderX = spec.borderX.map(col => [...col]);
      draftBorderY = spec.borderY.map(row => [...row]);
      draftEdited = false;
      applyUploadResult(state, warpedImageUrl, warning);
    };

    // Exposes window.__testSetPendingThumbs() so Playwright tests can inject
    // fake OCR thumbnails into pendingCellThumbs before calling __testLoad.
    // This lets tests verify that the confirm flow triggers training-data upload.
    // Key format: "row,col"; value: one Uint8Array per digit in the cage total.
    (window as unknown as Record<string, unknown>)['__testSetPendingThumbs'] = (
      entries: Record<string, number[][]>,
    ) => {
      pendingCellThumbs = new Map(
        Object.entries(entries).map(([key, arrays]) => [
          key,
          arrays.map(a => new Uint8Array(a)),
        ]),
      );
    };

    // Exposes window.__testShowConsentModal() so Playwright tests can exercise
    // the consent modal without needing a real OCR result.
    (window as unknown as Record<string, unknown>)['__testShowConsentModal'] = () => {
      const mockData: TrainingExport = {
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: __BUILD_TIME__,
        puzzleType: 'killer',
        subres: 128,
        thumbnailSize: 64,
        sampleCount: 1,
        samples: [{ digit: 3, pixels: Array<number>(4096).fill(128) }],
      };
      showTrainingConsentModal(() => uploadTrainingData(mockData));
    };

    // Exposes window.__activeFixture() so Playwright tests (and the browser
    // console) can inspect the active stall-fixture context — used by the
    // Task 3 feedback handler test to verify the fixture reference is captured.
    (window as unknown as Record<string, unknown>)['__activeFixture'] = activeFixtureContext;

  }
});
