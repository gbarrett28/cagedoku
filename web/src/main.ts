/**
 * Killer Sudoku COACH — browser entry point.
 *
 * Adapted from killer_sudoku/static/main.ts.  All `fetch('/api/...')` calls
 * replaced with direct calls to session/actions.ts functions.
 * State lives in session/store.ts; no server required.
 */

import { loadCV, loadRec, setCandidatesCache } from './session/store.js';
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
  patchCage,
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

  // 2. Cage boundaries in red (killer only)
  if (state.puzzleType !== 'classic') {
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 7.5;
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

  // 6. Cage totals (killer only)
  if (state.puzzleType !== 'classic') {
    ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const headCells = state.specData.cageTotals;
    const regions = state.specData.regions;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if ((headCells[r]?.[c] ?? 0) > 0) {
          const cageIdx = (regions[r]?.[c] ?? 1) - 1;
          const cage = state.cageStates[cageIdx];
          const total = cage !== undefined ? cage.total : headCells[r]![c]!;
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

  const tbody = el<HTMLTableSectionElement>('cage-tbody');
  clearChildren(tbody);
  for (const cage of state.cageStates) {
    const row = tbody.insertRow();
    const labelCell = row.insertCell(); labelCell.textContent = cage.label; labelCell.className = 'cage-label';
    const cellsCell = row.insertCell(); cellsCell.textContent = cage.cells.map(c => `r${c.row}c${c.col}`).join(' '); cellsCell.className = 'cage-cells';
    const totalCell = row.insertCell();
    const input = document.createElement('input');
    input.type = 'number'; input.value = String(cage.total);
    input.min = '1'; input.max = '45'; input.className = 'total-input'; input.dataset['cage'] = cage.label;
    input.addEventListener('change', () => { void handleCageEdit(cage.label, Number(input.value)); });
    totalCell.appendChild(input);
  }

  el<HTMLElement>('review-panel').hidden = false;
  el<HTMLElement>('editor-section').hidden = true;
  el<HTMLElement>('solution-panel').hidden = true;
}

function renderPlayingMode(state: PuzzleState): void {
  currentState = state;
  refreshDisplay();
  el<HTMLElement>('review-actions').hidden = true;
  el<HTMLElement>('editor-section').hidden = true;
  el<HTMLElement>('original-col').hidden = true;
  el<HTMLElement>('warped-col').hidden = true;
  el<HTMLElement>('playing-actions').hidden = false;
  el<HTMLElement>('solution-panel').hidden = true;
  updateUndoButton(state);
  el<HTMLButtonElement>('candidates-btn').disabled = false;
  el<HTMLButtonElement>('hints-btn').disabled = false;
  const isKiller = state.puzzleType !== 'classic';
  el<HTMLButtonElement>('inspect-cage-btn').hidden = !isKiller;
  el<HTMLButtonElement>('virtual-cage-btn').hidden = !isKiller;
}

function updateUndoButton(state: PuzzleState): void {
  const btn = el<HTMLButtonElement>('undo-btn');
  if (state.turns.length === 0) { btn.disabled = true; return; }
  const last = state.turns[state.turns.length - 1]!.action;
  btn.disabled = last.type === 'placeDigit' && last.source === 'given';
}

function renderSolution(grid: number[][]): void {
  const container = el<HTMLElement>('solution-grid');
  clearChildren(container);
  const table = document.createElement('table');
  table.className = 'solution-table';
  for (let r = 0; r < 9; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < 9; c++) {
      const td = document.createElement('td');
      td.textContent = String(grid[r]![c]! || '');
      if (r === 2 || r === 5) td.classList.add('box-bottom');
      if (c === 2 || c === 5) td.classList.add('box-right');
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  container.appendChild(table);
  el<HTMLElement>('solution-panel').hidden = false;
}

// ---------------------------------------------------------------------------
// Virtual cage panel
// ---------------------------------------------------------------------------

function renderVirtualCagePanel(): void {
  if (currentCandidates === null) return;
  const vcs = currentCandidates.virtualCages;
  const col = el<HTMLElement>('virtual-cage-col');
  if (vcs.length > 0 || virtualCageMode) col.hidden = false;

  const list = el<HTMLElement>('virtual-cage-list');
  list.replaceChildren();
  for (const vc of vcs) {
    const item = document.createElement('div'); item.className = 'vc-item';
    const header = document.createElement('div'); header.className = 'vc-item-header';
    header.textContent = `total ${vc.total} — ${vc.cells.length} cells: ` + vc.cells.map(([r, c]) => `r${r + 1}c${c + 1}`).join(' ');
    item.appendChild(header);

    const solnsDiv = document.createElement('div'); solnsDiv.className = 'vc-solutions';
    const allSolns = vc.allSolutions;
    if (allSolns.length === 0) {
      const p = document.createElement('span'); p.className = 'soln-item auto-impossible'; p.textContent = '(no valid solutions)'; solnsDiv.appendChild(p);
    } else {
      const autoImpossibleKeys = new Set(vc.autoImpossible.map(s => s.join(',')));
      const userEliminatedKeys = new Set(vc.userEliminated.map(s => s.join(',')));
      for (const soln of allSolns) {
        const span = document.createElement('span');
        const key = soln.join(',');
        if (autoImpossibleKeys.has(key)) {
          span.className = 'soln-item auto-impossible';
        } else if (userEliminatedKeys.has(key)) {
          span.className = 'soln-item user-eliminated';
          span.addEventListener('click', () => { void handleEliminateVirtualCageSolution(vc.key, [...soln]); });
        } else {
          span.className = 'soln-item active';
          span.addEventListener('click', () => { void handleEliminateVirtualCageSolution(vc.key, [...soln]); });
        }
        span.textContent = `{${soln.join(',')}}`;
        solnsDiv.appendChild(span);
      }
    }
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

    for (const soln of data.allSolutions) {
      const span = document.createElement('span');
      const key = soln.join(',');
      const isAutoImpossible = data.autoImpossible.some(s => s.join(',') === key);
      const isUserElim = data.userEliminated.some(s => [...s].sort((a, b) => a - b).join(',') === key);
      if (isAutoImpossible) {
        span.className = 'soln-item auto-impossible';
      } else if (isUserElim) {
        span.className = 'soln-item user-eliminated';
        span.addEventListener('click', () => { void handleEliminateSolution(label, [...soln]); });
      } else {
        span.className = 'soln-item active';
        span.addEventListener('click', () => { void handleEliminateSolution(label, [...soln]); });
      }
      span.textContent = `{${soln.join(',')}}`;
      inspector.appendChild(span);
    }
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
  const el_ = el<HTMLElement>('status-msg');
  el_.textContent = msg;
  el_.className = 'status' + (isError ? ' error' : '');
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
  renderState(state);
  const warpedCol = el<HTMLElement>('warped-col');
  const warpedImg = el<HTMLImageElement>('warped-img');
  if (warpedImageUrl) { warpedImg.src = warpedImageUrl; warpedCol.hidden = false; } else { warpedCol.hidden = true; }
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
  } catch (e) { setStatus(`OCR failed: ${String(e)}`, true); }
  finally { setLoading(false); }
}

async function handleConfirm(): Promise<void> {
  setLoading(true);
  try {
    const state = confirmPuzzle();
    renderPlayingMode(state);
    setStatus('');
  } catch (e) { setStatus(`Confirm failed: ${String(e)}`, true); }
  finally { setLoading(false); }
}

async function handleCageEdit(label: string, total: number): Promise<void> {
  try { renderState(patchCage(label, total)); } catch (e) { setStatus(String(e), true); }
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

async function handleSolve(): Promise<void> {
  if (currentState === null) { setStatus('No active session — process an image first.', true); return; }
  setLoading(true);
  try {
    const data = solvePuzzle();
    if (!data.solved || data.error) { setStatus(`Solve failed: ${data.error ?? 'unknown error'}`, true); return; }
    renderSolution(data.grid);
    setStatus('Solved!');
  } catch (e) { setStatus(`Solve error: ${String(e)}`, true); }
  finally { setLoading(false); }
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

  void Promise.all([cvWithProgress, loadRec()])
    .then(() => { (window as unknown as Record<string, unknown>)['__pipelineReady'] = true; })
    .catch(e => {
      cvRow.style.display = 'none';
      setStatus(`Image pipeline load failed: ${String(e)}`, true);
    });

  el<HTMLButtonElement>('process-btn').addEventListener('click', () => { void handleProcess(); });
  el<HTMLButtonElement>('confirm-btn').addEventListener('click', () => { void handleConfirm(); });
  el<HTMLButtonElement>('solve-btn').addEventListener('click', () => { void handleSolve(); });
  el<HTMLButtonElement>('undo-btn').addEventListener('click', () => { void handleUndo(); });

  el<HTMLButtonElement>('edit-btn').addEventListener('click', () => {
    el<HTMLElement>('editor-section').hidden = false;
  });

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
      if (e.key === 'ArrowUp' && row > 1) { selectedCell = { row: row - 1, col }; redrawGrid(); }
      else if (e.key === 'ArrowDown' && row < 9) { selectedCell = { row: row + 1, col }; redrawGrid(); }
      else if (e.key === 'ArrowLeft' && col > 1) { selectedCell = { row, col: col - 1 }; redrawGrid(); }
      else if (e.key === 'ArrowRight' && col < 9) { selectedCell = { row, col: col + 1 }; redrawGrid(); }
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
        if (cage) renderCageInspector(cage.label);
      }
      return;
    }

    selectedCell = { row: r0 + 1, col: c0 + 1 };  // convert to 1-based
    redrawGrid();
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
