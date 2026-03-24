# Project COACH: Master Functional Specification

---

## Developer Onboarding

### What COACH Is

A browser-based coaching companion for killer sudoku. You upload a newspaper puzzle
image (Guardian or Observer), the OCR pipeline detects cage boundaries and totals,
and COACH guides you through solving it — with candidate management, mistake detection,
and logical hints.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend API | FastAPI + Pydantic (Python) |
| Session persistence | JSON files on disk |
| Frontend | TypeScript (compiled with `tsc`) + vanilla DOM |
| Image pipeline | OpenCV + PCA (existing `cagedoku` solver) |

### Directory Structure

```
killer_sudoku/
├── api/                    # FastAPI layer
│   ├── app.py              # Application factory + serve() entry point
│   ├── config.py           # CoachConfig (reads COACH_* env vars)
│   ├── schemas.py          # Pydantic request/response models
│   ├── session.py          # JSON session store
│   └── routers/
│       └── puzzle.py       # /api/puzzle/* endpoints
└── static/                 # Frontend assets
    ├── index.html          # SPA shell
    ├── main.ts             # TypeScript source (committed)
    ├── main.js             # Compiled output (NOT committed — generate with tsc)
    └── styles.css
```

### Running the Server

```bash
# From the project root (guardian/ and observer/ model dirs must be present)
pip install -e ".[dev]"
coach                # starts server and opens browser automatically
coach --no-browser   # starts server without opening browser
# → http://127.0.0.1:8000
```

Override defaults via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `COACH_GUARDIAN_DIR` | `guardian` | Guardian model/puzzle directory |
| `COACH_OBSERVER_DIR` | `observer` | Observer model/puzzle directory |
| `COACH_SESSIONS_DIR` | `sessions` | JSON session persistence directory |
| `COACH_HOST` | `127.0.0.1` | Bind address |
| `COACH_PORT` | `8000` | Port |

### Compiling the Frontend

TypeScript is the source of truth; the compiled `.js` is not committed.

```bash
# Install TypeScript (once)
npm install -g typescript

# Compile (run from project root)
tsc

# Output: killer_sudoku/static/main.js
```

### API Endpoints (Phase 1)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/puzzle?newspaper=guardian` | Upload image, run OCR, create session |
| `GET` | `/api/puzzle/{session_id}` | Retrieve current puzzle state |
| `PATCH` | `/api/puzzle/{session_id}/cage/{label}` | Correct a cage total |
| `POST` | `/api/puzzle/{session_id}/cage/{label}/subdivide` | Split a cage |
| `POST` | `/api/puzzle/{session_id}/solve` | Solve; returns 9×9 grid |

Interactive API docs: `http://127.0.0.1:8000/docs`

---

## 1. System Integration & Entry Points
The application is a "utility-first" tool designed to bypass standard menus and drop the user directly into a workspace.

### 1.1 Windows Desktop (Shell Integration)
* **Registry Association**: Register under `HKEY_CLASSES_ROOT\*\shell\OpenWithSudokuCoach` for image context menus.
* **CLI Argument Handling**: Accept a file path string at launch to trigger the OCR pipeline immediately.
* **Session Persistence**: Support resuming an in-progress puzzle when launched; prompt the user to save or discard if a new image is opened during an active session.

### 1.2 Android (Intent Filtering)
* **Manifest Declaration**: Integrate via `<intent-filter>` with `ACTION_SEND` and `mimeType="image/*"`.
* **Deep Linking**: Act as a direct share target from gallery or camera apps, landing on the Verification screen.

---

## 2. Phase 1: Grid Recognition & Verification
This phase allows users to "groom" the OCR data before the logic engine takes over.

* **Visual Overlay**: Display detected cages with **Red Borders** and standard cells with **Light Dotted Borders**.
* **Cage Sub-division**:
    * Users may manually subdivide cages, marked visually with **Green Borders**.
    * **Calculated Totals**: When a user defines totals for $n-1$ sub-cages, the system must automatically calculate and populate the final sub-total.
* **Gated Editing**: While structural editing is primary in Phase 1, the user may return here from the Coaching phase via a "Gated Edit" warning to correct OCR errors mid-solve.

---

## 3. Phase 2: The Coaching Canvas (Main HUD)
The primary environment where the user solves the puzzle against a background "Golden Solution".

### 3.1 Candidate Management
* **Keypad Layout**: Display candidates in a $3 \times 3$ phone keypad orientation within each cell.
* **Automated Pruning**: Provide real-time candidate removal based on mathematical constraints and cell values.
* **User Persistence**: Manually removed candidates must be stored in a separate "User State" that persists across recalculations.

### 3.2 Real-Time Coaching & Hints
* **Silent Monitoring**: The system silently tracks the "Golden Solution" and detects the moment a user eliminates a correct digit.
* **The "Mistake" Pulse**: A subtle, non-intrusive UI icon pulses when an error is detected, providing immediate feedback without stopping flow.
* **Hint Options**:
    * **Backtrack**: Revert the board to the state immediately prior to the first detected mistake.
    * **Logical Reduction**: Highlight cells and provide text/visual explanations of specific rules (e.g., "Hidden Triple").
    * **Assisted Application**: Allow users to apply the logic manually or trigger a "System Apply" to execute the changes.

---

## 4. Phase 3: Advanced Logical Overlays
Analytical views that visualize high-level Killer Sudoku constraints.

### 4.1 "Delicate Salmon" (Essential Digits)
* **Function**: Identify "Essential Digits"—numbers that must appear in a cage regardless of the mathematical partition chosen.
* **Visual**: Highlight these candidates using **Hex #FF918A (Delicate Salmon)**.

### 4.2 Cage Solution Manager
* **Enumeration**: List all valid mathematical partitions for a selected cage.
* **Manual Pruning**: Users can swipe or tap to "Dismiss" a specific partition, instantly updating the grid's candidate state.

### 4.3 Linked Cage View (Binary Logic)
* **Binary Annotation**: For cages with only two valid solutions, Solution A appears in the bottom-left and Solution B in the bottom-right of the cells.
* **Logic Unification**:
    * Initially, binary cages use unique pastel border colors.
    * If a logical link is identified (choosing A in Cage 1 forces B in Cage 2), the system unifies their border colors to show they are "entangled".

---

## 5. Technical & Accessibility Requirements
* **Failure Handling**: Terminate early with a clear notification if the OCR result creates an unsolvable puzzle state.
* **Visual Adjustments**: Provide color-blindness accessible palettes as overrides for the default "Delicate Salmon" and "Binary Link" colors.
* **Device Optimization**: Maximize the usable display area for $3 \times 3$ candidate grids on both high-res desktops and mobile screens.
