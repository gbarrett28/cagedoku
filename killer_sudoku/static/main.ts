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
  source?: string;    // "given" for pre-filled classic digits
}

interface CellInfo {
  candidates: number[];   // solver-deduced candidates (includes user_removed for struck-through render)
  user_removed: number[]; // digits explicitly removed by the user
}

interface CageInfo {
  cage_idx: number;
  cells: [number, number][];  // 0-based [row, col] pairs
  total: number;
  solutions: number[][];
  must_contain: number[];     // intersection of remaining solutions
}

interface VirtualCageInfo {
  key: string;
  cells: [number, number][];
  total: number;
  solutions: number[][];
  must_contain: number[];
}

interface CandidatesResponse {
  cells: CellInfo[][];         // 9 rows × 9 cols, 0-based
  cages: CageInfo[];
  virtual_cages: VirtualCageInfo[];
}

interface PuzzleSpecData {
  regions: number[][];
  cage_totals: number[][];
  border_x: boolean[][];
  border_y: boolean[][];
}

interface PuzzleState {
  session_id: string;
  cages: CageState[];
  spec_data: PuzzleSpecData;
  original_image_b64: string;
  golden_solution: number[][] | null;
  user_grid: number[][] | null;
  move_history: MoveRecord[];
  puzzle_type: "killer" | "classic";
  given_digits: number[][] | null;
}

interface UploadResponse {
  session_id: string;
  state: PuzzleState;
  warning?: string;
  warped_image_b64?: string;
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

interface VirtualCageSuggestion {
  cells: [number, number][];  // 0-based (row, col)
  total: number;
}

interface HintItem {
  rule_name: string;
  display_name: string;
  explanation: string;
  highlight_cells: [number, number][];  // 0-based [row, col]
  eliminations: EliminationItem[];
  elimination_count: number;
  placement: [number, number, number] | null;  // [row, col, digit] or null
  rewind_to_turn_idx: number | null;  // non-null for Rewind hints only
  virtual_cage_suggestion: VirtualCageSuggestion | null;  // T3 hint
}

interface HintsResponse {
  hints: HintItem[];
}

interface RuleInfo {
  name: string;
  display_name: string;
  description: string;
}

interface SettingsResponse {
  always_apply_rules: string[];
  show_essential: boolean;
  hintable_rules: RuleInfo[];
}

interface AddVirtualCageRequest {
  cells: [number, number][];  // 0-based (row, col)
  total: number;
}

// ── Grid canvas constants ────────────────────────────────────────────────────

const CELL = 50;   // pixels per sudoku cell
const MARGIN = 4;  // outer padding in pixels
const GRID_PX = MARGIN * 2 + 9 * CELL;  // total canvas size (= 458px)

// ── Module state ────────────────────────────────────────────────────────────

let currentSessionId: string | null = null;
let currentState: PuzzleState | null = null;
let currentCandidates: CandidatesResponse | null = null;
let virtualCageMode: boolean = false;
let virtualCageSelection: Set<string> = new Set();  // "r,c" keys, 0-based
let selectedCell: { row: number; col: number } | null = null;
// row and col are 1-based (1–9), matching the API convention
let showCandidates: boolean = false;
let showEssential: boolean = true;
let candidateEditMode: boolean = false;
let inspectCageMode: boolean = false;
let inspectedCageLabel: string | null = null;
let hintHighlightCells: Set<string> = new Set(); // "r,c" keys, 0-based
let activeHintItem: HintItem | null = null;

// ── UI helpers ──────────────────────────────────────────────────────────────

// Show page load time in header so a hard-refresh is immediately visible.
(document.getElementById("load-time") as HTMLSpanElement).textContent =
  `loaded ${new Date().toLocaleTimeString()}`;

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
  highlightKeys: Set<string> | null = null,  // "r,c" keys, 0-based
  candidatesData: CandidatesResponse | null = null,
  vcSelection: Set<string> | null = null,    // cells being drawn, "r,c" 0-based
  showEss: boolean = true,
): void {
  canvas.width = GRID_PX;
  canvas.height = GRID_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 1. White background
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, GRID_PX, GRID_PX);

  // 1b. Existing virtual cage cells (teal underlay, one shade per cage index)
  if (candidatesData !== null) {
    const vcColors = [
      "rgba(20, 184, 166, 0.25)",  // teal
      "rgba(139, 92, 246, 0.25)",  // violet
      "rgba(236, 72, 153, 0.25)",  // pink
      "rgba(251, 146, 60, 0.25)",  // orange
    ];
    for (const [vcIdx, vc] of candidatesData.virtual_cages.entries()) {
      ctx.fillStyle = vcColors[vcIdx % vcColors.length];
      for (const [r, c] of vc.cells) {
        ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }
  }

  // 1c. Virtual cage selection (indigo underlay while drawing a new cage)
  if (vcSelection !== null && vcSelection.size > 0) {
    ctx.fillStyle = "rgba(99, 102, 241, 0.35)";
    for (const key of vcSelection) {
      const parts = key.split(",");
      const r = Number(parts[0]);
      const c = Number(parts[1]);
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 1e. Hint highlight cells (amber, drawn before cage underlay)
  if (highlightKeys !== null && highlightKeys.size > 0) {
    ctx.fillStyle = "rgba(251, 191, 36, 0.45)";
    for (const key of highlightKeys) {
      const parts = key.split(",");
      const r = Number(parts[0]);
      const c = Number(parts[1]);
      ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
    }
  }

  // 1f. Selected-cell highlight (before cage underlay so red lines render on top)
  if (selected !== null) {
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(
      MARGIN + (selected.col - 1) * CELL,
      MARGIN + (selected.row - 1) * CELL,
      CELL,
      CELL
    );
  }

  // 2. Cage boundaries in red — killer only (classic has no cage overlay).
  //    Drawn first as a wide underlay so grid lines appear on top.
  //    regions[r][c] is the 1-based cage index; a wall exists where adjacent
  //    cells belong to different cages.
  if (state.puzzle_type !== "classic") {
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

  // 6. Cage totals — killer only (classic has no cage totals).
  //    Position from spec_data.cage_totals (head cell), value from state.cages.
  if (state.puzzle_type !== "classic") {
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
  }

  // 7. Digit rendering — pre-confirm given_digits (classic) or playing-mode user_grid.
  //    Classic given digits are black; user entries are blue.
  //    Cells with a digit that is duplicated in its row, column, or 3×3 box
  //    are rendered in red to flag OCR or entry errors.
  const digitGrid: number[][] | null =
    state.user_grid !== null
      ? state.user_grid
      : state.given_digits ?? null;

  if (digitGrid !== null) {
    // Build set of (r,c) keys whose digit is duplicated in its unit.
    const duplicateCells = new Set<string>();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const d = digitGrid[r]?.[c] ?? 0;
        if (d === 0) continue;
        // Check row
        for (let cc = 0; cc < 9; cc++) {
          if (cc !== c && (digitGrid[r]?.[cc] ?? 0) === d) {
            duplicateCells.add(`${r},${c}`);
          }
        }
        // Check column
        for (let rr = 0; rr < 9; rr++) {
          if (rr !== r && (digitGrid[rr]?.[c] ?? 0) === d) {
            duplicateCells.add(`${r},${c}`);
          }
        }
        // Check 3×3 box
        const br = Math.floor(r / 3) * 3;
        const bc = Math.floor(c / 3) * 3;
        for (let dr = 0; dr < 3; dr++) {
          for (let dc = 0; dc < 3; dc++) {
            const rr = br + dr;
            const cc = bc + dc;
            if ((rr !== r || cc !== c) && (digitGrid[rr]?.[cc] ?? 0) === d) {
              duplicateCells.add(`${r},${c}`);
            }
          }
        }
      }
    }

    // Underlay duplicate cells in pale red before drawing digits.
    if (duplicateCells.size > 0) {
      ctx.fillStyle = "rgba(220, 38, 38, 0.15)";
      for (const key of duplicateCells) {
        const parts = key.split(",");
        const r = Number(parts[0]);
        const c = Number(parts[1]);
        ctx.fillRect(MARGIN + c * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }

    const givenCells = new Set<string>();
    if (state.puzzle_type === "classic" && state.user_grid !== null) {
      for (const m of state.move_history) {
        if (m.source === "given") {
          givenCells.add(`${m.row - 1},${m.col - 1}`);
        }
      }
    }
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const digit = digitGrid[r]?.[c] ?? 0;
        if (digit > 0) {
          const key = `${r},${c}`;
          const isDuplicate = duplicateCells.has(key);
          // Pre-confirm given_digits: black normally, red if duplicate.
          // Post-confirm user_grid: given=black, user=blue, duplicate=red.
          if (isDuplicate) {
            ctx.fillStyle = "#dc2626";
          } else if (state.user_grid !== null && !givenCells.has(key)) {
            ctx.fillStyle = "#2563eb";
          } else {
            ctx.fillStyle = "#000";
          }
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
  if (showCands && candidatesData !== null && state.user_grid !== null) {
    // Build per-cell must_contain lookup from cage info (0-based row,col key)
    const mustContainByCell = new Map<string, Set<number>>();
    for (const cage of candidatesData.cages) {
      const mc = new Set(cage.must_contain);
      for (const [r, c] of cage.cells) {
        mustContainByCell.set(`${r},${c}`, mc);
      }
    }
    const CAND_TOP = 13; // px reserved for cage-total label at top of cell
    const SUB_W = CELL / 3;
    const SUB_H = (CELL - CAND_TOP) / 3;
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if ((state.user_grid[r]?.[c] ?? 0) !== 0) continue;  // skip solved cells
        const cell = candidatesData.cells[r]?.[c];
        if (cell === undefined) continue;
        const candSet = new Set(cell.candidates);
        const removedSet = new Set(cell.user_removed);
        const essSet = mustContainByCell.get(`${r},${c}`) ?? new Set<number>();
        for (let n = 1; n <= 9; n++) {
          const subRow = Math.floor((n - 1) / 3);
          const subCol = (n - 1) % 3;
          const cx = MARGIN + c * CELL + (subCol + 0.5) * SUB_W;
          const cy = MARGIN + r * CELL + CAND_TOP + (subRow + 0.5) * SUB_H;
          if (removedSet.has(n)) {
            // Struck-through: draw the digit dimmed with a horizontal line.
            ctx.fillStyle = "#d1d5db";
            ctx.fillText(String(n), cx, cy);
            const hw = SUB_W * 0.35;
            ctx.strokeStyle = "#6b7280";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx - hw, cy);
            ctx.lineTo(cx + hw, cy);
            ctx.stroke();
          } else if (candSet.has(n)) {
            ctx.fillStyle = (essSet.has(n) && showEss) ? "#cc5a45" : "#888";
            ctx.fillText(String(n), cx, cy);
          }
        }
      }
    }
  }
}

// ── Render helpers ──────────────────────────────────────────────────────────

function renderState(state: PuzzleState): void {
  currentState = state;
  // Draw the detected cage layout onto the canvas
  drawGrid(el<HTMLCanvasElement>("grid-canvas"), state);

  // Update heading to show detected puzzle type
  const heading = document.getElementById("detected-layout-heading");
  if (heading !== null) {
    heading.textContent =
      state.puzzle_type === "classic"
        ? "Detected Layout — Classic Sudoku"
        : "Detected Layout — Killer Sudoku";
  }

  // Show inline-edit hint for classic puzzles in the pre-confirm review phase.
  el<HTMLElement>("classic-edit-hint").hidden =
    state.puzzle_type !== "classic" || state.user_grid !== null;

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
  const vcSel = virtualCageSelection.size > 0 ? virtualCageSelection : null;
  drawGrid(
    el<HTMLCanvasElement>("grid-canvas"),
    currentState,
    selectedCell,
    showCandidates,
    highlights,
    currentCandidates,
    vcSel,
    showEssential,
  );
}

async function fetchCandidates(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/candidates`);
    if (!res.ok) return;
    currentCandidates = (await res.json()) as CandidatesResponse;
    redrawGrid();
    renderVirtualCagePanel();
  } catch {
    // best effort — candidates are non-critical; grid still renders without them
  }
}

function renderVirtualCagePanel(): void {
  if (currentCandidates === null) return;
  const vcs = currentCandidates.virtual_cages;
  const col = el<HTMLElement>("virtual-cage-col");

  // Show/hide the column: always visible once any virtual cage exists, or when
  // the user is actively drawing a new one.
  if (vcs.length > 0 || virtualCageMode) {
    col.hidden = false;
  }

  const list = el<HTMLElement>("virtual-cage-list");
  list.replaceChildren();

  for (const vc of vcs) {
    const item = document.createElement("div");
    item.className = "vc-item";

    const header = document.createElement("div");
    header.className = "vc-item-header";
    header.textContent =
      `total ${vc.total} — ${vc.cells.length} cells: ` +
      vc.cells.map(([r, c]) => `r${r + 1}c${c + 1}`).join(" ");
    item.appendChild(header);

    const solns = document.createElement("div");
    solns.className = "vc-solutions";
    if (vc.solutions.length === 0) {
      const p = document.createElement("span");
      p.className = "soln-item auto-impossible";
      p.textContent = "(no valid solutions)";
      solns.appendChild(p);
    } else {
      for (const soln of vc.solutions) {
        const span = document.createElement("span");
        span.className = "soln-item active";
        span.textContent = `{${soln.join(",")}}`;
        solns.appendChild(span);
      }
    }
    item.appendChild(solns);
    list.appendChild(item);
  }
}

async function submitVirtualCage(): Promise<void> {
  if (!currentSessionId || virtualCageSelection.size < 2) return;
  const totalInput = el<HTMLInputElement>("vc-total-input");
  const total = Number(totalInput.value);
  if (!total || total < 3) {
    totalInput.focus();
    return;
  }
  const cells = [...virtualCageSelection].map((key) => {
    const parts = key.split(",");
    return [Number(parts[0]), Number(parts[1])] as [number, number];
  });
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/virtual-cages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cells, total } satisfies AddVirtualCageRequest),
    });
    if (!res.ok) {
      const err = (await res.json()) as { detail: string };
      setStatus(`Virtual cage error: ${err.detail}`, true);
      return;
    }
    currentState = await res.json();
    // Exit drawing mode and reset form
    virtualCageMode = false;
    virtualCageSelection = new Set();
    el<HTMLElement>("vc-form").hidden = true;
    totalInput.value = "";
    el<HTMLButtonElement>("virtual-cage-btn").textContent = "Virtual cage";
    void fetchCandidates();
  } catch (e) {
    setStatus(`Virtual cage error: ${String(e)}`, true);
  }
}

function refreshDisplay(): void {
  if (showCandidates) {
    void fetchCandidates();
  } else {
    redrawGrid();
  }
}

function renderPlayingMode(state: PuzzleState): void {
  currentState = state;
  refreshDisplay();
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

  if (!fileInput.files || fileInput.files.length === 0) {
    setStatus("Please select an image file.", true);
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);

  setLoading(true);
  try {
    const res = await fetch("/api/puzzle", {
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

    // Show the perspective-corrected grid image when available.
    const warpedCol = el<HTMLElement>("warped-col");
    const warpedImg = el<HTMLImageElement>("warped-img");
    if (data.warped_image_b64) {
      warpedImg.src = `data:image/jpeg;base64,${data.warped_image_b64}`;
      warpedCol.hidden = false;
    } else {
      warpedCol.hidden = true;
    }

    // Collapse upload panel so the review layout has more room.
    el<HTMLElement>("upload-panel").hidden = true;
    el<HTMLButtonElement>("new-puzzle-btn").hidden = false;

    if (data.warning) {
      setStatus(`Warning: ${data.warning}`, false);
    } else {
      setStatus("");
    }
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

async function handleGivenDigitEdit(row: number, col: number, digit: number): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/puzzle/${currentSessionId}/given-digit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row, col, digit }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { detail: string };
      setStatus(`Error updating digit: ${err.detail}`, true);
      return;
    }
    const state = (await res.json()) as PuzzleState;
    currentState = state;
    drawGrid(el<HTMLCanvasElement>("grid-canvas"), state, selectedCell);
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
    refreshDisplay();
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
    refreshDisplay();
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
    refreshDisplay();
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
  // Allow cell selection in pre-confirm classic mode (for OCR correction)
  // as well as the normal post-confirm playing mode.
  const isPreConfirmClassic =
    currentState?.user_grid == null &&
    currentState?.puzzle_type === "classic" &&
    currentState?.given_digits != null;
  if (currentState?.user_grid == null && !isPreConfirmClassic) return;
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
    if (virtualCageMode) {
      // Toggle cell in/out of virtual cage selection (0-based key)
      const key = `${row - 1},${col - 1}`;
      if (virtualCageSelection.has(key)) {
        virtualCageSelection.delete(key);
      } else {
        virtualCageSelection.add(key);
      }
      const n = virtualCageSelection.size;
      el<HTMLElement>("vc-selection-status").textContent =
        n === 0
          ? "Click cells on the grid"
          : `${n} cell${n === 1 ? "" : "s"} selected`;
      redrawGrid();
    } else if (inspectCageMode && currentState) {
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
  const isPreConfirmClassic =
    currentState?.user_grid == null &&
    currentState?.puzzle_type === "classic" &&
    currentState?.given_digits != null;
  if (currentState?.user_grid == null && !isPreConfirmClassic) return;
  // Don't steal keypresses from any focused input or textarea.
  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) return;
  if (selectedCell === null) return;

  // Arrow key navigation (wraps around at grid edges).
  const arrowDeltas: Record<string, [number, number]> = {
    ArrowUp:    [-1,  0],
    ArrowDown:  [ 1,  0],
    ArrowLeft:  [ 0, -1],
    ArrowRight: [ 0,  1],
  };
  if (e.key in arrowDeltas) {
    e.preventDefault();
    const [dr, dc] = arrowDeltas[e.key]!;
    selectedCell = {
      row: ((selectedCell.row - 1 + dr + 9) % 9) + 1,
      col: ((selectedCell.col - 1 + dc + 9) % 9) + 1,
    };
    redrawGrid();
    return;
  }

  if (isPreConfirmClassic) {
    // Pre-confirm classic: edit given_digits directly via API.
    if (e.key >= "1" && e.key <= "9") {
      void handleGivenDigitEdit(selectedCell.row, selectedCell.col, Number(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      void handleGivenDigitEdit(selectedCell.row, selectedCell.col, 0);
    }
  } else if (showCandidates && candidateEditMode) {
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
  el<HTMLButtonElement>("virtual-cage-btn").hidden = !showCandidates;
  if (!showCandidates) {
    currentCandidates = null;
    candidateEditMode = false;
    el<HTMLButtonElement>("edit-candidates-btn").textContent = "Edit candidates";
    inspectCageMode = false;
    el<HTMLButtonElement>("inspect-cage-btn").textContent = "Inspect cage";
    el<HTMLElement>("inspector-col").hidden = true;
    inspectedCageLabel = null;
    virtualCageMode = false;
    virtualCageSelection = new Set();
    el<HTMLButtonElement>("virtual-cage-btn").textContent = "Virtual cage";
    el<HTMLElement>("vc-form").hidden = true;
    el<HTMLElement>("virtual-cage-col").hidden = true;
    redrawGrid();
  } else {
    void fetchCandidates();
  }
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

el<HTMLButtonElement>("virtual-cage-btn").addEventListener("click", () => {
  virtualCageMode = !virtualCageMode;
  const btn = el<HTMLButtonElement>("virtual-cage-btn");
  btn.textContent = virtualCageMode ? "Stop drawing" : "Virtual cage";
  const form = el<HTMLElement>("vc-form");
  if (virtualCageMode) {
    virtualCageSelection = new Set();
    el<HTMLElement>("vc-selection-status").textContent = "Click cells on the grid";
    el<HTMLInputElement>("vc-total-input").value = "";
    form.hidden = false;
    el<HTMLElement>("virtual-cage-col").hidden = false;
    redrawGrid();
  } else {
    virtualCageSelection = new Set();
    form.hidden = true;
    // Keep column visible if there are existing virtual cages
    if (currentCandidates === null || currentCandidates.virtual_cages.length === 0) {
      el<HTMLElement>("virtual-cage-col").hidden = true;
    }
    redrawGrid();
  }
});

el<HTMLButtonElement>("vc-add-btn").addEventListener("click", () => {
  void submitVirtualCage();
});

el<HTMLButtonElement>("vc-cancel-btn").addEventListener("click", () => {
  virtualCageMode = false;
  virtualCageSelection = new Set();
  el<HTMLButtonElement>("virtual-cage-btn").textContent = "Virtual cage";
  el<HTMLElement>("vc-form").hidden = true;
  if (currentCandidates === null || currentCandidates.virtual_cages.length === 0) {
    el<HTMLElement>("virtual-cage-col").hidden = true;
  }
  redrawGrid();
});

el<HTMLButtonElement>("close-help-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("help-candidates-modal") as HTMLDialogElement).close();
});

el<HTMLButtonElement>("config-btn").addEventListener("click", () => {
  void openConfigModal();
});

el<HTMLButtonElement>("config-save-btn").addEventListener("click", async () => {
  const selects = el<HTMLElement>("config-rules-list")
    .querySelectorAll<HTMLSelectElement>("select[data-rule-name]");
  const alwaysApplyRules: string[] = [];
  for (const select of selects) {
    if (select.value === "auto" && select.dataset["ruleName"]) {
      alwaysApplyRules.push(select.dataset["ruleName"]);
    }
  }

  showEssential = el<HTMLInputElement>("essential-toggle").checked;

  const patchResp = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      always_apply_rules: alwaysApplyRules,
      show_essential: showEssential,
    }),
  });
  if (!patchResp.ok) {
    throw new Error(
      `PATCH settings failed: ${patchResp.status} ${await patchResp.text()}`
    );
  }

  if (currentSessionId) {
    const refreshResp = await fetch(`/api/puzzle/${currentSessionId}/refresh`, {
      method: "POST",
    });
    if (!refreshResp.ok) {
      throw new Error(
        `POST refresh failed: ${refreshResp.status} ${await refreshResp.text()}`
      );
    }
    currentState = await refreshResp.json();
    refreshDisplay();
  }

  (el<HTMLDialogElement>("config-modal")).close();
});

el<HTMLButtonElement>("config-cancel-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("config-modal")).close();
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

async function openConfigModal(): Promise<void> {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`GET settings failed: ${res.status} ${await res.text()}`);
  }
  const settings = (await res.json()) as SettingsResponse;
  const alwaysApplySet = new Set(settings.always_apply_rules);

  // Sync module-level showEssential from persisted settings.
  showEssential = settings.show_essential;
  el<HTMLInputElement>("essential-toggle").checked = showEssential;

  const list = el<HTMLElement>("config-rules-list");
  clearChildren(list);

  for (const rule of settings.hintable_rules) {
    const row = document.createElement("div");
    row.className = "config-rule-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "config-rule-name";
    nameSpan.textContent = rule.display_name;

    const infoBtn = document.createElement("button");
    infoBtn.className = "btn-rule-info";
    infoBtn.textContent = "\u24d8";  // ⓘ
    infoBtn.title = "About this rule";
    infoBtn.addEventListener("click", () => {
      el<HTMLHeadingElement>("rule-info-title").textContent = rule.display_name;
      el<HTMLParagraphElement>("rule-info-description").textContent = rule.description;
      el<HTMLDialogElement>("rule-info-modal").showModal();
    });

    const select = document.createElement("select");
    select.className = "config-rule-select";
    select.dataset["ruleName"] = rule.name;

    const optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "Auto-apply";
    const optHint = document.createElement("option");
    optHint.value = "hint";
    optHint.textContent = "Hint-only";
    select.appendChild(optAuto);
    select.appendChild(optHint);
    select.value = alwaysApplySet.has(rule.name) ? "auto" : "hint";

    row.appendChild(nameSpan);
    row.appendChild(infoBtn);
    row.appendChild(select);
    list.appendChild(row);
  }

  el<HTMLDialogElement>("config-modal").showModal();
}

el<HTMLButtonElement>("rule-info-close-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("rule-info-modal").close();
});

function showHintModal(hint: HintItem): void {
  activeHintItem = hint;
  hintHighlightCells = new Set(hint.highlight_cells.map(([r, c]) => `${r},${c}`));
  redrawGrid();
  el<HTMLElement>("hint-modal-title").textContent = hint.display_name;
  el<HTMLElement>("hint-modal-explanation").textContent = hint.explanation;

  const applyBtn = el<HTMLButtonElement>("hint-apply-btn");
  if (hint.rewind_to_turn_idx !== null) {
    el<HTMLElement>("hint-modal-summary").textContent =
      "Rewinding will undo all moves back to the last correct state.";
    applyBtn.textContent = "Rewind";
  } else if (hint.placement !== null) {
    const [, , d] = hint.placement;
    el<HTMLElement>("hint-modal-summary").textContent = `Places digit ${d}.`;
    applyBtn.textContent = "Place";
  } else if (hint.virtual_cage_suggestion !== null) {
    el<HTMLElement>("hint-modal-summary").textContent =
      "Adds this constraint as a virtual cage.";
    applyBtn.textContent = "Add virtual cage";
  } else {
    const n = hint.eliminations.length;
    el<HTMLElement>("hint-modal-summary").textContent =
      n === 1 ? "Eliminates 1 candidate." : `Eliminates ${n} candidates.`;
    applyBtn.textContent = "Apply";
  }
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
    if (!res.ok) throw new Error(`GET hints failed: ${res.status} ${await res.text()}`);
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
        if (hint.placement !== null) {
          const [r, c, d] = hint.placement;
          btn.textContent = `${hint.display_name} — place ${d} at r${r + 1}c${c + 1}`;
        } else if (hint.virtual_cage_suggestion !== null) {
          btn.textContent = `${hint.display_name} — add virtual cage`;
        } else {
          const n = hint.elimination_count;
          btn.textContent = `${hint.display_name} (${n} elimination${n === 1 ? "" : "s"})`;
        }
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
  const hint = activeHintItem; // capture before clearHintHighlight() nullifies it
  (el<HTMLDialogElement>("hint-modal") as HTMLDialogElement).close();
  clearHintHighlight();
  try {
    if (hint.rewind_to_turn_idx !== null) {
      // Rewind hint: discard all turns after the last consistent state
      const resp = await fetch(`/api/puzzle/${currentSessionId}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn_idx: hint.rewind_to_turn_idx }),
      });
      if (!resp.ok) throw new Error(`POST rewind failed: ${resp.status} ${await resp.text()}`);
      currentState = await resp.json();
    } else if (hint.placement !== null) {
      // Placement hint: enter the digit via the cell endpoint
      const [row, col, digit] = hint.placement;
      const resp = await fetch(`/api/puzzle/${currentSessionId}/cell`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: row + 1, col: col + 1, digit }),
      });
      if (!resp.ok) throw new Error(`PATCH cell failed: ${resp.status} ${await resp.text()}`);
      currentState = await resp.json();
    } else if (hint.virtual_cage_suggestion !== null) {
      // T3 virtual cage suggestion: register the suggested cage
      const { cells, total } = hint.virtual_cage_suggestion;
      const resp = await fetch(`/api/puzzle/${currentSessionId}/virtual-cages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells, total }),
      });
      if (!resp.ok) throw new Error(`POST virtual-cages failed: ${resp.status} ${await resp.text()}`);
      currentState = await resp.json();
    } else {
      // Elimination hint: mark candidates as user_removed
      const resp = await fetch(`/api/puzzle/${currentSessionId}/hints/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eliminations: hint.eliminations }),
      });
      if (!resp.ok) throw new Error(`POST hints/apply failed: ${resp.status} ${await resp.text()}`);
      currentState = await resp.json();
    }
    refreshDisplay();
  } catch (e) {
    console.error("Hint apply error:", e);
    setStatus(`Hint apply failed: ${String(e)}`, true);
  }
});

el<HTMLButtonElement>("hint-close-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("hint-modal") as HTMLDialogElement).close();
  clearHintHighlight();
});

el<HTMLButtonElement>("help-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("general-help-modal").showModal();
});

el<HTMLButtonElement>("general-help-close-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("general-help-modal").close();
});

el<HTMLButtonElement>("new-puzzle-btn").addEventListener("click", () => {
  window.location.reload();
});
