/**
 * COACH — Phase 1 frontend
 *
 * Handles puzzle image upload, cage-total correction, and solution display.
 * All state lives server-side; the client is purely a thin view layer.
 *
 * Compile with:  tsc  (reads tsconfig.json at project root)
 * Output:        killer_sudoku/static/main.js  (not committed)
 */

// ── API types (mirror killer_sudoku/api/schemas.py) ────────────────────────

interface CellPosition {
  row: number;
  col: number;
}

interface SubCageState {
  label: string;
  total: number | null;
  cells: CellPosition[];
}

interface CageState {
  label: string;
  total: number;
  cells: CellPosition[];
  subdivisions: SubCageState[];
  user_eliminated_solns: number[][];
}

interface CageSolutionsResponse {
  label: string;
  all_solutions: number[][];
  auto_impossible: number[][];
  user_eliminated: number[][];
}

interface MoveRecord {
  row: number;        // 1-based
  col: number;        // 1-based
  digit: number;      // 0–9 (0 = clear)
  prev_digit: number; // 0–9
}

interface CandidateCell {
  auto_candidates: number[];
  auto_essential:  number[];
  user_essential:  number[];
  user_removed:    number[];
}

interface CandidateGrid {
  cells: CandidateCell[][];   // 9 rows × 9 cols, 0-based
}

interface PuzzleSpecData {
  regions: number[][];
  cage_totals: number[][];
  border_x: boolean[][];
  border_y: boolean[][];
}

interface PuzzleState {
  session_id: string;
  newspaper: "guardian" | "observer";
  cages: CageState[];
  spec_data: PuzzleSpecData;
  original_image_b64: string;
  golden_solution: number[][] | null;
  user_grid: number[][] | null;
  move_history: MoveRecord[];
  candidate_grid: CandidateGrid | null;
}

interface UploadResponse {
  session_id: string;
  state: PuzzleState;
}

interface SolveResponse {
  solved: boolean;
  grid: number[][];
  error: string | null;
}

interface EliminationItem {
  cell: [number, number];  // [row, col] 0-based
  digit: number;
}

interface HintItem {
  rule_name: string;
  display_name: string;
  explanation: string;
  highlight_cells: [number, number][];  // 0-based [row, col]
  eliminations: EliminationItem[];
  elimination_count: number;
}

interface HintsResponse {
  hints: HintItem[];
}

// ── Grid canvas constants ────────────────────────────────────────────────────

const CELL = 50;   // pixels per sudoku cell
const MARGIN = 4;  // outer padding in pixels
const GRID_PX = MARGIN * 2 + 9 * CELL;  // total canvas size (= 458px)

// ── Module state ────────────────────────────────────────────────────────────

let currentSessionId: string | null = null;
let currentState: PuzzleState | null = null;
let selectedCell: { row: number; col: number } | null = null;
// row and col are 1-based (1–9), matching the API convention
let showCandidates: boolean = false;
let candidateEditMode: boolean = false;
let inspectCageMode: boolean = false;
let inspectedCageLabel: string | null = null;
let hintHighlightCells: Set<string> = new Set(); // "r,c" keys, 0-based
let activeHintItem: HintItem | null = null;

// ── UI helpers ──────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`Element #${id} not found`);
  return e as T;
}

function setStatus(msg: string, isError = false): void {
  const span = el<HTMLSpanElement>("status-msg");
  span.textContent = msg;
  span.className = isError ? "status error" : "status";
}

function setLoading(loading: boolean): void {
  el<HTMLButtonElement>("process-btn").disabled = loading;
  el<HTMLButtonElement>("confirm-btn").disabled = loading;
  el<HTMLButtonElement>("solve-btn").disabled = loading;
  if (loading) setStatus("Processing…");
}

function clearChildren(node: Node): void {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
}

// ── Grid canvas drawing ──────────────────────────────────────────────────────

/**
 * Render the detected killer-sudoku grid onto a canvas element.
 *
 * Drawing layers (back → front):
 *  1. White fill
 *  2. Thin dashed black lines for every internal cell boundary
 *  3. Medium solid black lines for the 3×3 box boundaries
 *  4. Thick solid black outer border
 *  5. Red lines for cage boundaries (from spec_data.border_x / border_y)
 *  6. Cage total numbers (from state.cages, positioned via spec_data.cage_totals)
 *
 * Coordinate conventions (from PuzzleSpec / build_brdrs):
 *  border_x[col][rowBnd]  — horizontal wall below row rowBnd in column col
 *  border_y[row][colBnd]  — vertical wall right of col colBnd in row row
 */
function drawGrid(
  canvas: HTMLCanvasElement,
  state: PuzzleState,
  selected: { row: number; col: number } | null = null,
  showCands: boolean = false,
  highlightKeys: Set<string> | null = null  // "r,c" keys, 0-based
): void {
  canvas.width = GRID_PX;
  canvas.height = GRID_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 1. White background
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, GRID_PX, GRID_PX);

  // 1b. Hint highlight cells (amber, drawn before cage underlay)
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = "rgba(251, 191, 36, 0.45)";
    for (const key of highlightKeys) {
      const parts = key.split(",");
      const r = Number(parts[0]);
      const c = Number(parts[1]);
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 1c. Selected-cell highlight (before cage underlay so red lines render on top)
  if (selected !== null) {
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(
      MARGIN + (selected.col - 1) * CELL,
      MARGIN + (selected.row - 1) * CELL,
      CELL,
      CELL
    );
  }

  // 2. Cage boundaries in red — drawn first as a wide underlay so the black
  //    grid lines (dashed cell dividers, box lines, outer border) appear on top.
  //
  //    regions[r][c] is the 1-based cage index for cell (r, c).
  //    A cage wall exists wherever two adjacent cells belong to different cages.
  ctx.strokeStyle = "#cc0000";
  ctx.lineWidth = 7.5;
  const reg = state.spec_data.regions;  // [9][9]

  // Horizontal walls — between rows r and r+1 in each column
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      if ((reg[r]?.[c] ?? 0) !== (reg[r + 1]?.[c] ?? 0)) {
        const y = MARGIN + (r + 1) * CELL;
        ctx.beginPath();
        ctx.moveTo(MARGIN + c * CELL, y);
        ctx.lineTo(MARGIN + (c + 1) * CELL, y);
        ctx.stroke();
      }
    }
  }

  // Vertical walls — between cols c and c+1 in each row
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 8; c++) {
      if ((reg[r]?.[c] ?? 0) !== (reg[r]?.[c + 1] ?? 0)) {
        const x = MARGIN + (c + 1) * CELL;
        ctx.beginPath();
        ctx.moveTo(x, MARGIN + r * CELL);
        ctx.lineTo(x, MARGIN + (r + 1) * CELL);
        ctx.stroke();
      }
    }
  }

  // 3. Thin dashed cell dividers (drawn over the red underlay)
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 3]);
  for (let i = 1; i < 9; i++) {
    const pos = MARGIN + i * CELL;
    ctx.beginPath();
    ctx.moveTo(MARGIN, pos);
    ctx.lineTo(MARGIN + 9 * CELL, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, MARGIN);
    ctx.lineTo(pos, MARGIN + 9 * CELL);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 4. Medium solid 3×3 box dividers (at rows/cols 3 and 6)
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.5;
  for (const b of [3, 6]) {
    const pos = MARGIN + b * CELL;
    ctx.beginPath();
    ctx.moveTo(MARGIN, pos);
    ctx.lineTo(MARGIN + 9 * CELL, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, MARGIN);
    ctx.lineTo(pos, MARGIN + 9 * CELL);
    ctx.stroke();
  }

  // 5. Outer grid border
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2.5;
  ctx.strokeRect(MARGIN, MARGIN, 9 * CELL, 9 * CELL);

  // 6. Cage totals — position from spec_data.cage_totals (head cell),
  //    value from state.cages (user-corrected)
  ctx.fillStyle = "#000";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const headCells = state.spec_data.cage_totals;
  const regions = state.spec_data.regions;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((headCells[r]?.[c] ?? 0) > 0) {
        const cageIdx = (regions[r]?.[c] ?? 1) - 1;
        const cage = state.cages[cageIdx];
        const total = cage !== undefined ? cage.total : headCells[r][c];
        ctx.fillText(String(total), MARGIN + c * CELL + 2, MARGIN + r * CELL + 2);
      }
    }
  }

  // 7. User-entered digits (playing mode)
  if (state.user_grid !== null) {
    ctx.fillStyle = "#2563eb";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const digit = state.user_grid[r]?.[c] ?? 0;
        if (digit > 0) {
          ctx.fillText(
            String(digit),
            MARGIN + c * CELL + CELL / 2,
            MARGIN + r * CELL + CELL / 2
          );
        }
      }
    }
  }

  // 8. Candidate sub-grid (only when showCands && candidate data available)
  //    Reserve CAND_TOP px at the top of each cell so digit 1 does not
  //    collide with the cage-total label (drawn at y+2 with 11px font).
  if (showCands && state.candidate_grid !== null && state.user_grid !== null) {
    const cg = state.candidate_grid;
    const CAND_TOP = 13; // px reserved for cage-total label at top of cell
    const SUB_W = CELL / 3;
    const SUB_H = (CELL - CAND_TOP) / 3;
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if ((state.user_grid[r]?.[c] ?? 0) !== 0) continue;  // skip solved cells
        const cell = cg.cells[r]?.[c];
        if (cell === undefined) continue;
        const autoSet = new Set(cell.auto_candidates);
        const removedSet = new Set(cell.user_removed);
        const essSet = new Set([...cell.user_essential, ...cell.auto_essential]);
        for (let n = 1; n <= 9; n++) {
          if (removedSet.has(n)) continue;
          if (!autoSet.has(n)) continue;
          const subRow = Math.floor((n - 1) / 3);
          const subCol = (n - 1) % 3;
          const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
          const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
          ctx.fillStyle = essSet.has(n) ? "#ffb5a7" : "#9ca3af";
          ctx.fillText(String(n), cx, cy);
        }
      }
    }
  }
}

// ── Render helpers ──────────────────────────────────────────────────────────

function renderState(state: PuzzleState): void {
  // Draw the detected cage layout onto the canvas
  drawGrid(el<HTMLCanvasElement>("grid-canvas"), state);

  // Show the uploaded photo for comparison
  el<HTMLImageElement>("original-img").src =
    `data:image/jpeg;base64,${state.original_image_b64}`;

  // Rebuild cage table rows (cage editor starts hidden; built now so it's
  // ready the moment the user clicks "Edit cage totals")
  const tbody = el<HTMLTableSectionElement>("cage-tbody");
  clearChildren(tbody);

  for (const cage of state.cages) {
    const row = tbody.insertRow();

    const labelCell = row.insertCell();
    labelCell.textContent = cage.label;
    labelCell.className = "cage-label";

    const cellsCell = row.insertCell();
    cellsCell.textContent = cage.cells
      .map((c) => `r${c.row}c${c.col}`)
      .join(" ");
    cellsCell.className = "cage-cells";

    const totalCell = row.insertCell();
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(cage.total);
    input.min = "1";
    input.max = "45";
    input.className = "total-input";
    input.dataset["cage"] = cage.label;
    input.addEventListener("change", () => {
      void handleCageEdit(cage.label, Number(input.value));
    });
    totalCell.appendChild(input);
  }

  // Show review panel; keep editor hidden until user requests it
  el<HTMLElement>("review-panel").hidden = false;
  el<HTMLElement>("editor-section").hidden = true;
  el<HTMLElement>("solution-panel").hidden = true;
}

function renderSolution(grid: number[][]): void {
  const container = el<HTMLDivElement>("solution-grid");
  clearChildren(container);

  const table = document.createElement("table");
  table.className = "solution-table";

  for (let r = 0; r < grid.length; r++) {
    const tr = table.insertRow();
    const rowData = grid[r];
    for (let c = 0; c < rowData.length; c++) {
      const td = tr.insertCell();
      const digit = rowData[c];
      td.textContent = digit > 0 ? String(digit) : "";
      if (r % 3 === 2) td.classList.add("box-bottom");
      if (c % 3 === 2) td.classList.add("box-right");
    }
  }

  container.appendChild(table);
  el<HTMLElement>("solution-panel").hidden = false;
}

function renderCageInspector(
  data: CageSolutionsResponse,
  cage: CageState
): void {
  const inspector = el<HTMLElement>("cage-inspector");
  const heading = el<HTMLElement>("inspector-heading");

  const topLeft = cage.cells[0];
  heading.textContent =
    `c${topLeft.row},${topLeft.col} \u2014 total ${cage.total} \u2014 ${cage.cells.length} cells`;

  const impossibleSet = new Set(data.auto_impossible.map((s) => s.join(",")));
  const eliminatedSet = new Set(data.user_eliminated.map((s) => s.join(",")));
  const active = data.all_solutions.filter(
    (s) => !impossibleSet.has(s.join(",")) && !eliminatedSet.has(s.join(","))
  );
  const userElim = data.user_eliminated.filter(
    (s) => !impossibleSet.has(s.join(","))
  );

  inspector.replaceChildren();

  for (const soln of active) {
    const div = document.createElement("div");
    div.className = "soln-item active";
    div.textContent = `{${soln.join(",")}}`;
    div.addEventListener("click", () => {
      void eliminateSolution(data.label, soln);
    });
    inspector.appendChild(div);
  }

  for (const soln of userElim) {
    const div = document.createElement("div");
    div.className = "soln-item user-eliminated";
    div.textContent = `{${soln.join(",")}}`;
    div.addEventListener("click", () => {
      void eliminateSolution(data.label, soln);
    });
    inspector.appendChild(div);
  }

  for (const soln of data.auto_impossible) {
    const div = document.createElement("div");
    div.className = "soln-item auto-impossible";
    div.textContent = `{${soln.join(",")}}`;
    inspector.appendChild(div);
  }
}

async function fetchCageSolutions(label: string): Promise<void> {
  if (!currentSessionId || !currentState) return;
  const cage = currentState.cages.find((c) => c.label === label);
  if (!cage) return;
  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/cage/${label}/solutions`
    );
    if (!res.ok) return;
    const data = (await res.json()) as CageSolutionsResponse;
    renderCageInspector(data, cage);
  } catch {
    // best effort — inspector is non-critical
  }
}

async function eliminateSolution(
  label: string,
  solution: number[]
): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/cage/${label}/solutions/eliminate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ solution }),
      }
    );
    if (!res.ok) return;
    const state = (await res.json()) as PuzzleState;
    renderPlayingMode(state);
    void fetchCageSolutions(label);
  } catch {
    // best effort
  }
}

function redrawGrid(): void {
  if (currentState === null) return;
  const highlights = hintHighlightCells.size > 0 ? hintHighlightCells : null;
  drawGrid(
    el<HTMLCanvasElement>("grid-canvas"),
    currentState,
    selectedCell,
    showCandidates,
    highlights,
  );
}

function renderPlayingMode(state: PuzzleState): void {
  currentState = state;
  redrawGrid();
  el<HTMLElement>("review-actions").hidden = true;
  el<HTMLElement>("editor-section").hidden = true;
  el<HTMLElement>("original-col").hidden = true;
  el<HTMLElement>("playing-actions").hidden = false;
  el<HTMLElement>("solution-panel").hidden = true;
  updateUndoButton(state);
  el<HTMLButtonElement>("candidates-btn").disabled = false;
  el<HTMLButtonElement>("hints-btn").disabled = false;
}

function updateUndoButton(state: PuzzleState): void {
  el<HTMLButtonElement>("undo-btn").disabled = state.move_history.length === 0;
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handleProcess(): Promise<void> {
  const fileInput = el<HTMLInputElement>("file-input");
  const newspaper = el<HTMLSelectElement>("newspaper-select").value;

  if (!fileInput.files || fileInput.files.length === 0) {
    setStatus("Please select an image file.", true);
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);

  setLoading(true);
  try {
    const res = await fetch(`/api/puzzle?newspaper=${newspaper}`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = (await res.json()) as { detail: string };
      setStatus(`OCR failed: ${err.detail}`, true);
      return;
    }

    const data = (await res.json()) as UploadResponse;
    currentSessionId = data.session_id;
    renderState(data.state);
    setStatus("");
  } catch (e) {
    setStatus(`Network error: ${String(e)}`, true);
  } finally {
    setLoading(false);
  }
}

async function handleCageEdit(label: string, newTotal: number): Promise<void> {
  if (!currentSessionId) return;

  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/cage/${label}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total: newTotal }),
      }
    );

    if (!res.ok) {
      const err = (await res.json()) as { detail: string };
      setStatus(`Error updating cage ${label}: ${err.detail}`, true);
      return;
    }

    // Redraw canvas with the corrected cage total
    const state = (await res.json()) as PuzzleState;
    drawGrid(el<HTMLCanvasElement>("grid-canvas"), state);
  } catch (e) {
    setStatus(`Network error: ${String(e)}`, true);
  }
}

async function handleConfirm(): Promise<void> {
  if (!currentSessionId) {
    setStatus("No active session — process an image first.", true);
    return;
  }
  setLoading(true);
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/confirm`, {
      method: "POST",
    });
    if (!res.ok) {
      const err = (await res.json()) as { detail: string };
      setStatus(`Confirm failed: ${err.detail}`, true);
      return;
    }
    const state = (await res.json()) as PuzzleState;
    renderPlayingMode(state);
    setStatus("");
  } catch (e) {
    setStatus(`Network error: ${String(e)}`, true);
  } finally {
    setLoading(false);
  }
}

async function handleCellEntry(digit: number): Promise<void> {
  if (!currentSessionId || selectedCell === null) return;
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/cell`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row: selectedCell.row,
        col: selectedCell.col,
        digit,
      }),
    });
    if (!res.ok) return;
    const state = (await res.json()) as PuzzleState;
    currentState = state;
    redrawGrid();
    updateUndoButton(state);
  } catch {
    // Cell entry is best-effort; network errors are silently ignored
  }
}

async function handleUndo(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/undo`, {
      method: "POST",
    });
    if (!res.ok) return;
    const state = (await res.json()) as PuzzleState;
    currentState = state;
    redrawGrid();
    updateUndoButton(state);
  } catch {
    // Undo is best-effort; network errors are silently ignored
  }
}

async function handleCandidateCycle(
  row: number,
  col: number,
  digit: number
): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(
      `/api/puzzle/${currentSessionId}/candidates/cell`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row, col, digit }),
      }
    );
    if (!res.ok) return;
    const state = (await res.json()) as PuzzleState;
    currentState = state;
    redrawGrid();
  } catch {
    // Candidate cycle is best-effort; network errors silently ignored
  }
}

async function handleSolve(): Promise<void> {
  if (!currentSessionId) {
    setStatus("No active session — process an image first.", true);
    return;
  }

  setLoading(true);
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/solve`, {
      method: "POST",
    });

    const data = (await res.json()) as SolveResponse;

    if (!data.solved || data.error) {
      setStatus(`Solve failed: ${data.error ?? "unknown error"}`, true);
      return;
    }

    renderSolution(data.grid);
    setStatus("Solved!");
  } catch (e) {
    setStatus(`Network error: ${String(e)}`, true);
  } finally {
    setLoading(false);
  }
}

async function handleQuit(): Promise<void> {
  const btn = el<HTMLButtonElement>("quit-btn");
  btn.disabled = true;
  btn.textContent = "Stopping…";
  try {
    await fetch("/api/quit", { method: "POST" });
  } catch {
    // The server closing the connection looks like a network error — expected.
  }
  btn.textContent = "Server stopped";
  setStatus("Server stopped. You can close this tab.");
}

// ── Wire up ─────────────────────────────────────────────────────────────────

el<HTMLButtonElement>("process-btn").addEventListener("click", () => {
  void handleProcess();
});

// "Looks correct — solve!" now confirms the layout and enters playing mode
el<HTMLButtonElement>("confirm-btn").addEventListener("click", () => {
  void handleConfirm();
});

// "Edit cage totals" reveals the cage editor table
el<HTMLButtonElement>("edit-btn").addEventListener("click", () => {
  el<HTMLElement>("editor-section").hidden = false;
  el<HTMLButtonElement>("edit-btn").disabled = true;
});

el<HTMLButtonElement>("solve-btn").addEventListener("click", () => {
  void handleSolve();
});

el<HTMLButtonElement>("undo-btn").addEventListener("click", () => {
  void handleUndo();
});

el<HTMLCanvasElement>("grid-canvas").addEventListener("mousedown", (e) => {
  if (currentState?.user_grid == null) return;
  const canvas = el<HTMLCanvasElement>("grid-canvas");
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const col = Math.floor((x - MARGIN) / CELL) + 1;
  const row = Math.floor((y - MARGIN) / CELL) + 1;
  if (col >= 1 && col <= 9 && row >= 1 && row <= 9) {
    if (showCandidates && candidateEditMode) {
      // Detect which digit sub-cell was clicked (3×3 layout within the cell).
      // Matches the non-square CAND_TOP layout used in drawGrid layer 8.
      const CAND_TOP = 13;
      const cellX = (x - MARGIN) - (col - 1) * CELL;
      const cellY = (y - MARGIN) - (row - 1) * CELL;
      const subCol = Math.floor((cellX / CELL) * 3); // 0, 1, 2
      const adjustedY = Math.max(0, cellY - CAND_TOP);
      const subRow = Math.floor((adjustedY / (CELL - CAND_TOP)) * 3); // 0, 1, 2
      const digit = subRow * 3 + subCol + 1; // 1–9
      selectedCell = { row, col };
      void handleCandidateCycle(row, col, digit);
    } else {
      selectedCell = { row, col };
      redrawGrid();
    }
    if (inspectCageMode && currentState) {
      const clickedCage = currentState.cages.find((cage) =>
        cage.cells.some((cp) => cp.row === row && cp.col === col)
      );
      if (clickedCage) {
        inspectedCageLabel = clickedCage.label;
        el<HTMLElement>("inspector-col").hidden = false;
        void fetchCageSolutions(clickedCage.label);
      }
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (currentState?.user_grid == null) return;
  if (selectedCell === null) return;
  if (showCandidates && candidateEditMode) {
    if (e.key >= "1" && e.key <= "9") {
      void handleCandidateCycle(
        selectedCell.row,
        selectedCell.col,
        Number(e.key)
      );
    } else if (e.key === "Backspace" || e.key === "Delete") {
      void handleCandidateCycle(selectedCell.row, selectedCell.col, 0);
    }
  } else {
    if (e.key >= "1" && e.key <= "9") {
      void handleCellEntry(Number(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      void handleCellEntry(0);
    }
  }
});

el<HTMLButtonElement>("candidates-btn").addEventListener("click", () => {
  showCandidates = !showCandidates;
  const btn = el<HTMLButtonElement>("candidates-btn");
  btn.textContent = showCandidates ? "Hide candidates" : "Show candidates";
  el<HTMLButtonElement>("edit-candidates-btn").hidden = !showCandidates;
  el<HTMLButtonElement>("help-candidates-btn").hidden = !showCandidates;
  el<HTMLButtonElement>("inspect-cage-btn").hidden = !showCandidates;
  if (!showCandidates) {
    candidateEditMode = false;
    el<HTMLButtonElement>("edit-candidates-btn").textContent =
      "Edit candidates";
    inspectCageMode = false;
    el<HTMLButtonElement>("inspect-cage-btn").textContent = "Inspect cage";
    el<HTMLElement>("inspector-col").hidden = true;
    inspectedCageLabel = null;
  }
  redrawGrid();
});

el<HTMLButtonElement>("edit-candidates-btn").addEventListener("click", () => {
  candidateEditMode = !candidateEditMode;
  el<HTMLButtonElement>("edit-candidates-btn").textContent = candidateEditMode
    ? "Done editing"
    : "Edit candidates";
});

el<HTMLButtonElement>("help-candidates-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("help-candidates-modal") as HTMLDialogElement).showModal();
});

el<HTMLButtonElement>("inspect-cage-btn").addEventListener("click", () => {
  inspectCageMode = !inspectCageMode;
  const btn = el<HTMLButtonElement>("inspect-cage-btn");
  btn.textContent = inspectCageMode ? "Stop inspecting" : "Inspect cage";
  if (!inspectCageMode) {
    el<HTMLElement>("inspector-col").hidden = true;
    inspectedCageLabel = null;
  }
});

el<HTMLButtonElement>("close-help-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("help-candidates-modal") as HTMLDialogElement).close();
});

el<HTMLButtonElement>("quit-btn").addEventListener("click", () => {
  void handleQuit();
});

// ── Hints ────────────────────────────────────────────────────────────────────

function clearHintHighlight(): void {
  hintHighlightCells = new Set();
  activeHintItem = null;
  redrawGrid();
}

function showHintModal(hint: HintItem): void {
  activeHintItem = hint;
  hintHighlightCells = new Set(hint.highlight_cells.map(([r, c]) => `${r},${c}`));
  redrawGrid();
  el<HTMLElement>("hint-modal-title").textContent = hint.display_name;
  el<HTMLElement>("hint-modal-explanation").textContent = hint.explanation;
  const elim = hint.eliminations;
  const summary = elim.length === 1
    ? `Eliminates 1 candidate.`
    : `Eliminates ${elim.length} candidates.`;
  el<HTMLElement>("hint-modal-summary").textContent = summary;
  (el<HTMLDialogElement>("hint-modal") as HTMLDialogElement).showModal();
}

el<HTMLButtonElement>("hints-btn").addEventListener("click", () => {
  if (!currentSessionId) return;
  const dropdown = el<HTMLElement>("hints-dropdown");
  if (!dropdown.hidden) {
    dropdown.hidden = true;
    return;
  }
  void (async () => {
    const res = await fetch(`/api/puzzle/${currentSessionId}/hints`);
    if (!res.ok) return;
    const data = (await res.json()) as HintsResponse;
    clearChildren(dropdown);
    if (data.hints.length === 0) {
      const p = document.createElement("p");
      p.className = "hints-empty";
      p.textContent = "No hints available for the current state.";
      dropdown.appendChild(p);
    } else {
      for (const hint of data.hints) {
        const btn = document.createElement("button");
        btn.className = "hint-item";
        btn.textContent = `${hint.display_name} (${hint.elimination_count} elimination${hint.elimination_count === 1 ? "" : "s"})`;
        btn.addEventListener("click", () => {
          dropdown.hidden = true;
          showHintModal(hint);
        });
        dropdown.appendChild(btn);
      }
    }
    dropdown.hidden = false;
  })();
});

// Close hints dropdown when clicking outside it
document.addEventListener("click", (e) => {
  const dropdown = el<HTMLElement>("hints-dropdown");
  const hintsBtn = el<HTMLButtonElement>("hints-btn");
  if (!dropdown.hidden && !dropdown.contains(e.target as Node) && e.target !== hintsBtn) {
    dropdown.hidden = true;
  }
});

el<HTMLButtonElement>("hint-apply-btn").addEventListener("click", async () => {
  if (!activeHintItem || !currentSessionId) return;
  const eliminations = activeHintItem.eliminations;
  (el<HTMLDialogElement>("hint-modal") as HTMLDialogElement).close();
  clearHintHighlight();
  const resp = await fetch(`/api/puzzles/${currentSessionId}/hints/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eliminations }),
  });
  if (resp.ok) {
    currentState = await resp.json();
    redrawGrid();
  }
});

el<HTMLButtonElement>("hint-close-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("hint-modal") as HTMLDialogElement).close();
  clearHintHighlight();
});
