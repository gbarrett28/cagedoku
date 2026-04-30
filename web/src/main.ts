/**
 * Killer Sudoku COACH — browser entry point.
 *
 * Adapted from killer_sudoku/static/main.ts.  All `fetch('/api/...')` calls
 * replaced with direct calls to session/actions.ts functions.
 * State lives in session/store.ts; no server required.
 */

import { loadCV, loadRec, setCandidatesCache, getCV } from './session/store.js';
import { extractTrainingData } from './image/trainingExport.js';
import { dataToSpec } from './session/specUtils.js';
import { makeTrivialSpec, makeTwoCellCageSpec, makeBoxCageSpec } from './engine/fixtures.js';
import {
  uploadPuzzle,
  loadSpecDirect,
  confirmPuzzle,
  computeCandidates,
  enterCell,
  undo,
  rewind,
  cycleCandidate,
  solvePuzzle,
  getCageSolutions,
  eliminateCageSolution,
  eliminateVirtualCageSolution,
  addVirtualCage,
  getHints,
  applyHint,
  applyDraftLayout,
  getSettingsData,
  saveSettingsData,
} from './session/actions.js';
import type {
  CandidatesResponse,
  HintItem,
  PuzzleState,
} from './session/types.js';

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
// ---------------------------------------------------------------------------

let currentState: PuzzleState | null = null;
let currentCandidates: CandidatesResponse | null = null;
let selectedCell: { row: number; col: number } | null = null;  // 1-based
let showCandidates = false;
let showEssential = true;
let candidateEditMode = false;
let virtualCageMode = false;
let virtualCageSelection = new Set<string>();   // "r,c" keys, 0-based
let hintHighlightCells = new Set<string>();     // "r,c" keys, 0-based
let activeHintItem: HintItem | null = null;
let inspectCageMode = false;

let draftBorderX: boolean[][] = [];   // [col][rowGap] — cage horizontal walls
let draftBorderY: boolean[][] = [];   // [colGap][row] — cage vertical walls
let draftEdited = false;              // true once the user changes any total or border
let totalEditCell: { row: number; col: number } | null = null;  // 0-based, active overlay
let totalEditPrev = 0;
let reviewErrorCells = new Set<string>(); // "row,col" keys — cages failing Confirm validation

// ---------------------------------------------------------------------------
// Grid rendering
// ---------------------------------------------------------------------------

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
): void {
  canvas.width = GRID_PX;
  canvas.height = GRID_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, GRID_PX, GRID_PX);

  // 1b. Existing virtual cage cells (teal/violet/pink/orange underlays)
  if (candidatesData !== null) {
    const vcColors = [
      'rgba(20, 184, 166, 0.25)',
      'rgba(139, 92, 246, 0.25)',
      'rgba(236, 72, 153, 0.25)',
      'rgba(251, 146, 60, 0.25)',
    ];
    for (const [vcIdx, vc] of candidatesData.virtualCages.entries()) {
      ctx.fillStyle = vcColors[vcIdx % vcColors.length]!;
      for (const [r, c] of vc.cells) {
        ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }
  }

  // 1c. Virtual cage selection (indigo underlay while drawing)
  if (vcSelection !== null && vcSelection.size > 0) {
    ctx.fillStyle = 'rgba(99, 102, 241, 0.35)';
    for (const key of vcSelection) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 1e. Hint highlight cells (amber)
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = 'rgba(251, 191, 36, 0.45)';
    for (const key of highlightKeys) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 1f. Selected-cell highlight (1-based selected → 0-based canvas)
  if (selected !== null) {
    ctx.fillStyle = '#dbeafe';
    ctx.fillRect(
      MARGIN + (selected.col - 1) * CELL,
      MARGIN + (selected.row - 1) * CELL,
      CELL, CELL,
    );
  }

  // 1g. Validation error highlight (red tint on cages with missing/invalid totals)
  if (errorCells && errorCells.size > 0) {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
    for (const key of errorCells) {
      const parts = key.split(',').map(Number);
      const r = parts[0]!, c = parts[1]!;
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 2. Cage boundaries in red (killer only) — from draft borders if editing, else from regions
  if (state.puzzleType !== 'classic') {
    ctx.strokeStyle = draft ? '#0055cc' : '#cc0000'; // blue in edit mode, red normally
    ctx.lineWidth = 7.5;
    if (draft) {
      // draftBorderX[col][rowGap]: wall between rows rowGap and rowGap+1 in column col
      for (let col = 0; col < 9; col++) {
        for (let rowGap = 0; rowGap < 8; rowGap++) {
          if (draft.borderX[col]![rowGap]) {
            const y = MARGIN + (rowGap + 1) * CELL;
            ctx.beginPath(); ctx.moveTo(MARGIN + col * CELL, y); ctx.lineTo(MARGIN + (col + 1) * CELL, y); ctx.stroke();
          }
        }
      }
      // draftBorderY[colGap][row]: wall between cols colGap and colGap+1 in row
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

  // 3. Thin dashed cell dividers
  ctx.strokeStyle = '#000'; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
  for (let i = 1; i < 9; i++) {
    const pos = MARGIN + i * CELL;
    ctx.beginPath(); ctx.moveTo(MARGIN, pos); ctx.lineTo(MARGIN + 9 * CELL, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, MARGIN); ctx.lineTo(pos, MARGIN + 9 * CELL); ctx.stroke();
  }
  ctx.setLineDash([]);

  // 4. 3×3 box dividers
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  for (const b of [3, 6]) {
    const pos = MARGIN + b * CELL;
    ctx.beginPath(); ctx.moveTo(MARGIN, pos); ctx.lineTo(MARGIN + 9 * CELL, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, MARGIN); ctx.lineTo(pos, MARGIN + 9 * CELL); ctx.stroke();
  }

  // 5. Outer border
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
  ctx.strokeRect(MARGIN, MARGIN, 9 * CELL, 9 * CELL);

  // 6. Cage totals (killer only) — read directly from specData.cageTotals [row][col]
  if (state.puzzleType !== 'classic') {
    ctx.fillStyle = '#000'; ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const totals = state.specData.cageTotals;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const total = totals[r]?.[c] ?? 0;
        if (total > 0) {
          ctx.fillText(String(total), MARGIN + c * CELL + 2, MARGIN + r * CELL + 2);
        }
      }
    }
  }

  // 7. Digit rendering
  const digitGrid: number[][] | null =
    state.userGrid !== null ? state.userGrid : (state.givenDigits ?? null);

  if (digitGrid !== null) {
    const duplicateCells = new Set<string>();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const d = digitGrid[r]?.[c] ?? 0;
        if (d === 0) continue;
        for (let cc = 0; cc < 9; cc++) { if (cc !== c && (digitGrid[r]?.[cc] ?? 0) === d) duplicateCells.add(`${r},${c}`); }
        for (let rr = 0; rr < 9; rr++) { if (rr !== r && (digitGrid[rr]?.[c] ?? 0) === d) duplicateCells.add(`${r},${c}`); }
        const br = Math.floor(r / 3) * 3; const bc = Math.floor(c / 3) * 3;
        for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
          const rr = br + dr; const cc = bc + dc;
          if ((rr !== r || cc !== c) && (digitGrid[rr]?.[cc] ?? 0) === d) duplicateCells.add(`${r},${c}`);
        }
      }
    }
    if (duplicateCells.size > 0) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.15)';
      for (const key of duplicateCells) {
        const parts = key.split(',').map(Number);
        const r = parts[0]!, c = parts[1]!;
        ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }

    // Build set of given-digit cells (classic + confirmed)
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

  // 8. Candidate sub-grid
  if (showCands && candidatesData !== null && state.userGrid !== null) {
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
        if ((state.userGrid[r]?.[c] ?? 0) !== 0) continue;
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
  );
}

async function fetchCandidates(): Promise<void> {
  if (currentState === null) return;
  try {
    const data = computeCandidates();
    currentCandidates = data;
    setCandidatesCache(data);
    redrawGrid();
    renderVirtualCagePanel();
  } catch {
    // best effort — grid renders without candidates
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

  el<HTMLElement>('review-panel').hidden = false;
  el<HTMLElement>('solution-panel').hidden = true;
}

function renderPlayingMode(state: PuzzleState): void {
  currentState = state;
  reviewErrorCells = new Set();
  refreshDisplay();
  el<HTMLElement>('review-actions').hidden = true;
  el<HTMLElement>('original-col').hidden = true;
  el<HTMLElement>('warped-col').hidden = true;
  el<HTMLElement>('playing-actions').hidden = false;
  el<HTMLElement>('solution-panel').hidden = true;
  updateUndoButton(state);
  updateRevealButton();
  el<HTMLButtonElement>('candidates-btn').disabled = false;
  el<HTMLButtonElement>('hints-btn').disabled = false;
  const isKiller = state.puzzleType !== 'classic';
  el<HTMLButtonElement>('inspect-cage-btn').hidden = !isKiller;
  el<HTMLButtonElement>('virtual-cage-btn').hidden = !isKiller;
  el<HTMLButtonElement>('export-btn').hidden = !isKiller || state.warpedImageUrl === null;
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

async function handleReveal(): Promise<void> {
  if (currentState === null || selectedCell === null) return;
  const { row, col } = selectedCell;
  if (!confirm(`Reveal solution for r${row}c${col}?`)) return;
  setLoading(true);
  try {
    const data = solvePuzzle();
    if (!data.solved || data.grid === null) { setStatus('No solution found — check puzzle layout', true); return; }
    const digit = data.grid[row - 1]![col - 1]!;
    if (digit === 0) { setStatus('Solver could not determine this cell', true); return; }
    await handleCellEntry(digit);
    updateRevealButton();
  } catch (e) { setStatus(String(e), true); }
  finally { setLoading(false); }
}

async function handleExport(): Promise<void> {
  if (currentState === null || currentState.warpedImageUrl === null) return;
  const cv = getCV();
  if (cv === null) { setStatus('Image pipeline not ready', true); return; }
  setLoading(true);
  try {
    const data = await extractTrainingData(
      cv,
      currentState.warpedImageUrl,
      currentState.specData.cageTotals,
      currentState.puzzleType,
    );
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `training-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${data.sampleCount} training sample${data.sampleCount !== 1 ? 's' : ''}`);
  } catch (e) { setStatus(`Export failed: ${String(e)}`, true); }
  finally { setLoading(false); }
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
  const elimKeys = new Set(userEliminated.map(s => [...s].sort((a, b) => a - b).join(',')));
  for (const soln of allSolutions) {
    const span = document.createElement('span');
    const key = soln.join(',');
    const normKey = [...soln].sort((a, b) => a - b).join(',');
    if (autoKeys.has(key)) {
      span.className = 'soln-item auto-impossible';
    } else if (elimKeys.has(normKey)) {
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
    const header = document.createElement('div'); header.className = 'vc-item-header';
    header.textContent = `total ${vc.total} — ${vc.cells.length} cells: ` +
      vc.cells.map(([r, c]) => `r${r + 1}c${c + 1}`).join(' ');
    item.appendChild(header);

    const solnsDiv = document.createElement('div'); solnsDiv.className = 'vc-solutions';
    renderSolutionList(
      solnsDiv,
      vc.allSolutions,
      vc.autoImpossible,
      vc.userEliminated,
      (soln) => { void handleEliminateVirtualCageSolution(vc.key, soln); },
    );
    item.appendChild(solnsDiv);
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Cage inspector
// ---------------------------------------------------------------------------

function renderCageInspector(label: string): void {
  try {
    const data = getCageSolutions(label);
    const inspector = el<HTMLElement>('cage-inspector');
    clearChildren(inspector);
    el<HTMLElement>('inspector-heading').textContent = `Cage ${label}`;
    el<HTMLElement>('inspector-col').hidden = false;
    renderSolutionList(
      inspector,
      data.allSolutions,
      data.autoImpossible,
      data.userEliminated,
      (soln) => { void handleEliminateSolution(label, soln); },
    );
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function handleEliminateSolution(label: string, solution: number[]): Promise<void> {
  try {
    const state = eliminateCageSolution(label, solution);
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

function showHintModal(hint: HintItem): void {
  activeHintItem = hint;
  hintHighlightCells = new Set(hint.highlightCells.map(([r, c]) => `${r},${c}`));
  redrawGrid();
  el<HTMLElement>('hint-modal-title').textContent = hint.displayName;
  el<HTMLElement>('hint-modal-explanation').textContent = hint.explanation;
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
  activeHintItem = null;
  redrawGrid();
}

// ---------------------------------------------------------------------------
// Hint dropdown
// ---------------------------------------------------------------------------

function openConfigModal(): void {
  const data = getSettingsData();
  const alwaysApplySet = new Set(data.alwaysApplyRules);
  const list = el<HTMLElement>('config-rules-list');
  clearChildren(list);

  const ess = el<HTMLInputElement>('essential-toggle');
  ess.checked = showEssential;

  for (const rule of data.hintableRules) {
    const row = document.createElement('div'); row.className = 'config-rule-row';
    const nameSpan = document.createElement('span'); nameSpan.className = 'config-rule-name'; nameSpan.textContent = rule.displayName;
    const infoBtn = document.createElement('button'); infoBtn.className = 'btn-rule-info'; infoBtn.textContent = '\u24d8'; infoBtn.title = 'About this rule';
    infoBtn.addEventListener('click', () => {
      el<HTMLHeadingElement>('rule-info-title').textContent = rule.displayName;
      el<HTMLParagraphElement>('rule-info-description').textContent = rule.description;
      (el<HTMLDialogElement>('rule-info-modal') as HTMLDialogElement).showModal();
    });
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

function applyUploadResult(state: PuzzleState, warpedImageUrl: string | null, warning: string | null): void {
  reviewErrorCells = new Set();
  renderState(state);
  // Initialise draft borders from the OCR result so edit mode is immediately active.
  const spec = dataToSpec(state.specData);
  draftBorderX = spec.borderX.map(col => [...col]);
  draftBorderY = spec.borderY.map(row => [...row]);
  draftEdited = false;
  const warpedCol = el<HTMLElement>('warped-col');
  const warpedImg = el<HTMLImageElement>('warped-img');
  if (warpedImageUrl) { warpedImg.src = warpedImageUrl; }
  el<HTMLElement>('original-col').hidden = false;
  warpedCol.hidden = false;
  el<HTMLElement>('review-actions').hidden = false;
  el<HTMLElement>('playing-actions').hidden = true;
  el<HTMLElement>('upload-panel').hidden = true;
  el<HTMLButtonElement>('new-puzzle-btn').hidden = false;
  setStatus(warning ? `Warning: ${warning}` : '');
}

async function handleProcess(): Promise<void> {
  const fileInput = el<HTMLInputElement>('file-input');
  if (!fileInput.files || fileInput.files.length === 0) { setStatus('Please select an image file.', true); return; }
  setLoading(true);
  try {
    const { state, warpedImageUrl, warning } = await uploadPuzzle(fileInput.files[0]!);
    applyUploadResult(state, warpedImageUrl, warning);
  } catch (e) {
    // uploadPuzzle only throws on hard failures (e.g. not an image).
    // Partial OCR failures return a placeholder state instead.
    setStatus(`Processing failed: ${String(e)}`, true);
  }
  finally { setLoading(false); }
}

async function handleConfirm(): Promise<void> {
  if (currentState === null) return;
  setLoading(true);
  try {
    // Capture user-edited totals and warped image URL before state is replaced.
    const exportTotals = currentState.specData.cageTotals;
    const exportWarpedUrl = currentState.warpedImageUrl;
    const exportPuzzleType = currentState.puzzleType;

    const result = applyDraftLayout(
      draftBorderX, draftBorderY, currentState.specData.cageTotals,
    );
    if (result.errorCells.size > 0) {
      reviewErrorCells = result.errorCells;
      redrawGrid();
      setStatus('Each cage needs exactly one total in its valid range — highlighted in red', true);
      return;
    }
    // Sum outside [360, 450] is a strong signal of OCR errors — block and require correction.
    if (result.warnings.length > 0) {
      setStatus(result.warnings.join('; ') + ' — please correct the totals before confirming', true);
      return;
    }
    reviewErrorCells = new Set();
    currentState = result.state;
    const playing = confirmPuzzle();
    renderPlayingMode(playing);
    setStatus('');

    // Fire-and-forget training export — only when the user has corrected something,
    // so unedited OCR results (which may contain errors) are never written to disk.
    if (draftEdited && exportPuzzleType !== 'classic' && exportWarpedUrl !== null) {
      const cv = getCV();
      if (cv !== null) {
        void extractTrainingData(cv, exportWarpedUrl, exportTotals, exportPuzzleType)
          .then(data => {
            if (data.sampleCount === 0) return;
            const json = JSON.stringify(data);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `training-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
            setStatus(`Exported ${data.sampleCount} training sample${data.sampleCount !== 1 ? 's' : ''}`);
          })
          .catch(() => { /* export is best-effort, don't disrupt play */ });
      }
    }
  } catch (e) { setStatus(`Confirm failed: ${String(e)}`, true); }
  finally { setLoading(false); }
}

async function handleCellEntry(digit: number): Promise<void> {
  if (currentState === null || selectedCell === null) return;
  try {
    const state = enterCell(selectedCell.row, selectedCell.col, digit);
    currentState = state;
    refreshDisplay();
    updateUndoButton(state);
  } catch { /* best effort */ }
}

async function handleUndo(): Promise<void> {
  try {
    const state = undo();
    currentState = state;
    refreshDisplay();
    updateUndoButton(state);
  } catch { /* nothing to undo */ }
}

async function handleCandidateCycle(row1b: number, col1b: number, digit: number): Promise<void> {
  try {
    const state = cycleCandidate(row1b, col1b, digit);
    currentState = state;
    refreshDisplay();
  } catch { /* best effort */ }
}

async function handleGivenDigitEdit(row1b: number, col1b: number, digit: number): Promise<void> {
  if (currentState === null) return;
  const givenDigits = currentState.givenDigits
    ? currentState.givenDigits.map(row => [...row])
    : Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  givenDigits[row1b - 1]![col1b - 1] = digit;
  currentState = { ...currentState, givenDigits };
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
    currentState = addVirtualCage(cells, total);
    virtualCageMode = false; virtualCageSelection = new Set();
    el<HTMLElement>('vc-form').hidden = true;
    totalInput.value = '';
    el<HTMLButtonElement>('virtual-cage-btn').textContent = 'Virtual cage';
    void fetchCandidates();
  } catch (e) { setStatus(`Virtual cage error: ${String(e)}`, true); }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// Register the offline service worker. Only runs in production builds — skipped
// during Vite dev mode to prevent the SW from intercepting HMR/module requests.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  void navigator.serviceWorker.register('./sw.js').catch(err => {
    console.warn('[SW] Registration failed:', err);
  });
}

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

  void Promise.all([cvWithProgress, loadRec()])
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

  el<HTMLButtonElement>('process-btn').addEventListener('click', () => { void handleProcess(); });
  el<HTMLButtonElement>('confirm-btn').addEventListener('click', () => { void handleConfirm(); });
  el<HTMLButtonElement>('undo-btn').addEventListener('click', () => { void handleUndo(); });
  el<HTMLButtonElement>('reveal-btn').addEventListener('click', () => { void handleReveal(); });
  el<HTMLButtonElement>('export-btn').addEventListener('click', () => { void handleExport(); });

  el<HTMLSelectElement>('puzzle-type-select').addEventListener('change', (e) => {
    if (currentState === null) return;
    const type = (e.target as HTMLSelectElement).value as 'killer' | 'classic';
    const updated = { ...currentState, puzzleType: type };
    import('./session/store.js').then(m => m.setState(updated));
    currentState = updated;
    renderState(updated);
  });

  // ── Inline cage total editing overlay ──────────────────────────────────────
  const cageTotalInput = el<HTMLInputElement>('cage-total-edit');

  function commitTotalEdit(): void {
    if (totalEditCell === null || currentState === null) return;
    const { row, col } = totalEditCell;
    const v = Number(cageTotalInput.value);
    const newTotal = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
    currentState.specData.cageTotals[row]![col] = newTotal;
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
        currentState.specData.cageTotals[row]![col] = totalEditPrev;
      }
      totalEditCell = null;
      cageTotalInput.style.display = 'none';
      redrawGrid();
    }
  });
  // ───────────────────────────────────────────────────────────────────────────

  el<HTMLButtonElement>('new-puzzle-btn').addEventListener('click', () => {
    currentState = null; currentCandidates = null; selectedCell = null;
    showCandidates = false; candidateEditMode = false;
    virtualCageMode = false; virtualCageSelection = new Set();
    hintHighlightCells = new Set(); activeHintItem = null;
    el<HTMLElement>('upload-panel').hidden = false;
        el<HTMLElement>('review-panel').hidden = true;
    el<HTMLElement>('solution-panel').hidden = true;
    el<HTMLElement>('playing-actions').hidden = true;
    el<HTMLButtonElement>('new-puzzle-btn').hidden = true;
        el<HTMLButtonElement>('candidates-btn').disabled = true;
    el<HTMLButtonElement>('hints-btn').disabled = true;
    el<HTMLButtonElement>('inspect-cage-btn').hidden = true;
    el<HTMLButtonElement>('virtual-cage-btn').hidden = true;
    el<HTMLButtonElement>('reveal-btn').hidden = true;
    el<HTMLInputElement>('file-input').value = '';
    setStatus('');
  });

  el<HTMLButtonElement>('help-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('general-help-modal') as HTMLDialogElement).showModal();
  });
  el<HTMLButtonElement>('general-help-close-btn').addEventListener('click', () => {
    el<HTMLDialogElement>('general-help-modal').close();
  });

  el<HTMLButtonElement>('config-btn').addEventListener('click', () => { openConfigModal(); });
  el<HTMLButtonElement>('config-cancel-btn').addEventListener('click', () => { el<HTMLDialogElement>('config-modal').close(); });
  el<HTMLButtonElement>('config-save-btn').addEventListener('click', () => {
    const selects = el<HTMLElement>('config-rules-list').querySelectorAll<HTMLSelectElement>('select[data-rule-name]');
    const alwaysApply: string[] = [];
    selects.forEach(s => { if (s.value === 'auto' && s.dataset['ruleName']) alwaysApply.push(s.dataset['ruleName']); });
    showEssential = el<HTMLInputElement>('essential-toggle').checked;
    saveSettingsData(alwaysApply);
    el<HTMLDialogElement>('config-modal').close();
    if (currentState !== null) refreshDisplay();
  });
  el<HTMLButtonElement>('rule-info-close-btn').addEventListener('click', () => { el<HTMLDialogElement>('rule-info-modal').close(); });

  // Candidates
  el<HTMLButtonElement>('candidates-btn').addEventListener('click', () => {
    showCandidates = !showCandidates;
    el<HTMLButtonElement>('candidates-btn').textContent = showCandidates ? 'Hide candidates' : 'Show candidates';
    el<HTMLButtonElement>('edit-candidates-btn').hidden = !showCandidates;
    el<HTMLButtonElement>('help-candidates-btn').hidden = !showCandidates;
    if (showCandidates) { void fetchCandidates(); } else { currentCandidates = null; redrawGrid(); }
  });

  el<HTMLButtonElement>('edit-candidates-btn').addEventListener('click', () => {
    candidateEditMode = !candidateEditMode;
    el<HTMLButtonElement>('edit-candidates-btn').textContent = candidateEditMode ? 'Done editing' : 'Edit candidates';
  });

  el<HTMLButtonElement>('help-candidates-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('help-candidates-modal') as HTMLDialogElement).showModal();
  });
  el<HTMLButtonElement>('close-help-btn').addEventListener('click', () => { el<HTMLDialogElement>('help-candidates-modal').close(); });

  // Virtual cage
  el<HTMLButtonElement>('virtual-cage-btn').addEventListener('click', () => {
    virtualCageMode = !virtualCageMode;
    virtualCageSelection = new Set();
    el<HTMLButtonElement>('virtual-cage-btn').textContent = virtualCageMode ? 'Cancel virtual cage' : 'Virtual cage';
    el<HTMLElement>('vc-form').hidden = !virtualCageMode;
    if (virtualCageMode) el<HTMLElement>('virtual-cage-col').hidden = false;
    redrawGrid();
  });
  el<HTMLButtonElement>('vc-add-btn').addEventListener('click', () => { void submitVirtualCage(); });
  el<HTMLButtonElement>('vc-cancel-btn').addEventListener('click', () => {
    virtualCageMode = false; virtualCageSelection = new Set();
    el<HTMLElement>('vc-form').hidden = true;
    el<HTMLButtonElement>('virtual-cage-btn').textContent = 'Virtual cage';
    redrawGrid();
  });

  // Cage inspector
  el<HTMLButtonElement>('inspect-cage-btn').addEventListener('click', () => {
    inspectCageMode = !inspectCageMode;
    el<HTMLButtonElement>('inspect-cage-btn').textContent = inspectCageMode ? 'Done inspecting' : 'Inspect cage';
    if (!inspectCageMode) el<HTMLElement>('inspector-col').hidden = true;
  });

  // Hints dropdown
  el<HTMLButtonElement>('hints-btn').addEventListener('click', () => {
    const dropdown = el<HTMLElement>('hints-dropdown');
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    clearChildren(dropdown);
    try {
      const { hints } = getHints();
      if (hints.length === 0) {
        const p = document.createElement('p'); p.className = 'hints-empty'; p.textContent = 'No hints available'; dropdown.appendChild(p);
      } else {
        for (const hint of hints) {
          const btn = document.createElement('button'); btn.className = 'hint-item'; btn.textContent = hint.displayName;
          btn.addEventListener('click', () => { dropdown.hidden = true; showHintModal(hint); });
          dropdown.appendChild(btn);
        }
      }
    } catch (e) {
      const p = document.createElement('p'); p.className = 'hints-empty'; p.textContent = String(e); dropdown.appendChild(p);
    }
    dropdown.hidden = false;
  });

  document.addEventListener('click', (e) => {
    const dropdown = el<HTMLElement>('hints-dropdown');
    if (!dropdown.hidden && !(e.target as HTMLElement).closest('.hints-anchor')) {
      dropdown.hidden = true;
    }
  });

  // Hint modal
  el<HTMLButtonElement>('hint-apply-btn').addEventListener('click', () => {
    if (activeHintItem === null) return;
    (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).close();
    const hint = activeHintItem;
    clearHintHighlight();

    if (hint.rewindToTurnIdx !== null) {
      try { currentState = rewind(hint.rewindToTurnIdx); refreshDisplay(); updateUndoButton(currentState); } catch { /* */ }
    } else if (hint.placement !== null) {
      void handleCellEntry(hint.placement[2]);
    } else if (hint.virtualCageSuggestion !== null) {
      const { cells, total } = hint.virtualCageSuggestion;
      try { currentState = addVirtualCage([...cells], total); void fetchCandidates(); } catch (e) { setStatus(String(e), true); }
    } else {
      try { currentState = applyHint(hint.eliminations); refreshDisplay(); } catch (e) { setStatus(String(e), true); }
    }
  });

  el<HTMLButtonElement>('hint-close-btn').addEventListener('click', () => {
    (el<HTMLDialogElement>('hint-modal') as HTMLDialogElement).close();
    clearHintHighlight();
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

    if (candidateEditMode && selectedCell !== null) {
      if (e.key >= '1' && e.key <= '9') { void handleCandidateCycle(selectedCell.row, selectedCell.col, Number(e.key)); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { void handleCandidateCycle(selectedCell.row, selectedCell.col, 0); return; }
    } else if (selectedCell !== null) {
      if (e.key >= '1' && e.key <= '9') { void handleCellEntry(Number(e.key)); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { void handleCellEntry(0); return; }
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

    // ── Review-mode interaction (before confirm) ─────────────────────────
    if (currentState.userGrid === null && currentState.puzzleType !== 'classic') {
      // Review mode: borders always togglable; interior click handled by Chunk 2 (total overlay).
      const BORDER_ZONE = 7; // px
      for (let r = 1; r < 9; r++) {
        if (Math.abs(y - r * CELL) < BORDER_ZONE) {
          draftBorderX[c0]![r - 1] = !draftBorderX[c0]![r - 1];
          draftEdited = true; redrawGrid(); return;
        }
      }
      for (let c = 1; c < 9; c++) {
        if (Math.abs(x - c * CELL) < BORDER_ZONE) {
          draftBorderY[c - 1]![r0] = !draftBorderY[c - 1]![r0];
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
      inp.style.left = `${MARGIN + c0 * CELL}px`;
      inp.style.top  = `${MARGIN + r0 * CELL}px`;
      inp.value = existing > 0 ? String(existing) : '';
      inp.style.display = 'block';
      inp.focus();
      inp.select();
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

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

  // Digit buttons
  for (let d = 1; d <= 9; d++) {
    const btn = document.getElementById(`digit-${d}`);
    if (btn) btn.addEventListener('click', () => { void handleCellEntry(d); });
  }
  const clearBtn = document.getElementById('digit-0');
  if (clearBtn) clearBtn.addEventListener('click', () => { void handleCellEntry(0); });

  // Dev/test hook — skipped in production builds by Vite's dead-code elimination.
  // Exposes window.__testLoad() so Playwright tests can exercise the full
  // review→confirm→playing UI flow without OpenCV or a real puzzle image.
  if (import.meta.env.DEV) {
    // 'trivial'     — all 81 cells are single-cell cages; all auto-placed after confirm.
    // 'twoCellCage' — top-left two cells share a cage (sum 8); still over-constrained.
    // 'boxCage'     — 9 box cages (3×3 each, sum 45); no cell auto-placed → digit entry works.
    (window as unknown as Record<string, unknown>)['__testLoad'] = (specName?: string) => {
      let spec;
      if (specName === 'twoCellCage') spec = makeTwoCellCageSpec();
      else if (specName === 'boxCage') spec = makeBoxCageSpec();
      else spec = makeTrivialSpec();
      const { state, warpedImageUrl, warning } = loadSpecDirect(spec);
      applyUploadResult(state, warpedImageUrl, warning);
    };
  }
});
