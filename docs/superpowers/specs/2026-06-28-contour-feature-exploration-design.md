# Contour Feature Exploration Design

## Goal

Extract raw contour trees from a representative sample of corpus puzzles (using the
production browser pipeline) and build a labelled per-contour feature dataset in Python
for exploratory analysis. The aim is to discover which geometric and topological signals
cleanly separate grid-structure contours from number contours — without pre-supposing
which signals matter.

No TypeScript implementation follows from this sprint. If the analysis reveals useful
features, a separate spec will describe what to implement.

---

## Architecture

Two independent components:

```
corpus.db
    │
    ▼
dump-contour-trees.ts  ──►  contour-dumps/<hash>.json  (one per puzzle)
                                          │
                                          ▼
                            analyse-contours.py  ──►  contour-dumps/features.csv
```

Both scripts are one-shot research tools. No tests. No production wiring.

---

## Component 1: `web/scripts/dump-contour-trees.ts`

### Sample selection

Query `corpus.db` for up to **50 puzzles per (corpus × ground_truth) combination**
where:

```sql
e.status = 'done'
AND e.bucket IN ('clean', 'backtracked')
AND e.detected_type = json_extract(p.ground_truth, '$[0]')
```

Combinations: `guardian/classic`, `guardian/killer`, `observer/classic`,
`observer/killer` — up to 200 puzzles total.

### Browser setup

Reuses the same Playwright + vite preview setup as `evaluate-corpus.ts`:

- Suppress tutorial modal via `localStorage`
- Suppress `<dialog>.showModal()` via `addInitScript`
- Set `window.__reportContourTree = true` once for the session (via `addInitScript`)
  so `main.ts` knows to include the contour payload

### Triggering the pipeline

For each puzzle:

1. Register a one-shot `__reportOutcome` callback (same pattern as `evaluate-corpus.ts`)
2. Upload the puzzle file via `#file-input`
3. Await the outcome promise (30 s timeout)
4. Write the JSON dump

### Output per puzzle: `contour-dumps/<puzzle_hash>.json`

```typescript
interface ContourDump {
  puzzle_hash: string;
  corpus: string;            // 'guardian' | 'observer'
  ground_truth: string;      // 'killer' | 'classic'
  bucket: string;            // 'clean' | 'backtracked'
  subres: number;            // pixels per cell side (typically 128)

  // Raw contour tree — polygon points, bounding rect, area, children.
  // Serialised exactly as window.__lastContourTree.
  tree: ContourNode[];

  // Pipeline selections used as labels
  selectedNumbers: BRect[];  // contours returned by getNumContours
  outerGridBR: BRect;        // outer grid frame from locateGrid

  // Semantic pipeline outputs for spatial cross-referencing
  // borderX[col][rowGap]: true = cage border between rows rowGap and rowGap+1 in col
  // borderY[colGap][row]: true = cage border between cols colGap and colGap+1 in row
  borderX: boolean[][] | null;   // killer only (9 cols × 8 gaps)
  borderY: boolean[][] | null;   // killer only (8 gaps × 9 rows)

  // cageTotals[row][col]: non-zero only at cage head cells (killer), or 0 (classic)
  cageTotals: number[][] | null; // 9×9, killer only

  // givenDigits[row][col]: pre-filled digit or null for empty (classic only)
  givenDigits: (number | null)[][] | null;  // 9×9, classic only
}

type ContourNode = [pts: number[][], br: BRect, area: number, children: ContourNode[]];
type BRect = [x: number, y: number, w: number, h: number];
```

`contour-dumps/` is gitignored.

### Changes to `main.ts` / `ParseResult`

When `window.__reportContourTree` is truthy, `parsePuzzleImage` must return two extra
fields alongside its existing `ParseResult`:

```typescript
contourTree: ContourNode[] | null;      // window.__lastContourTree equivalent
selectedNumbers: BRect[];               // contours returned by getNumContours
outerGridBR: BRect | null;              // outer grid bounding rect from locateGrid
```

`main.ts` includes these in the `__reportOutcome` payload along with the already-present
`borderX`, `borderY`, `cageTotals`, and `givenDigits`.

`ParseResult` gains these optional fields only; existing consumers are unaffected.

---

## Component 2: `web/scripts/analyse-contours.py`

### Input

All `contour-dumps/<hash>.json` files. No database access needed (all metadata is in the
JSON).

### Per-contour features

Traverse each tree depth-first. For every node compute:

| Feature | Description |
|---|---|
| `puzzle_hash` | from dump metadata |
| `corpus` | `guardian` / `observer` |
| `ground_truth` | `killer` / `classic` |
| `depth` | recursion depth from root (root = 0) |
| `depth_below` | max depth of subtree (leaf = 0) |
| `num_peers` | sibling count (0 for root) |
| `num_children` | direct child count |
| `x`, `y`, `w`, `h` | bounding rect in warped-image pixels |
| `cx_norm`, `cy_norm` | bounding rect centre ÷ subres (each axis; value of 1.0 = one cell width from origin) |
| `w_norm`, `h_norm` | w/subres, h/subres |
| `area_norm` | area / subres² |
| `aspect_ratio` | w/h |
| `fill_ratio` | area / (w × h) |
| `area_rel_parent` | area / parent.area (1.0 for root) |
| `hu1`…`hu7` | log-scaled Hu moments: `sign(h) × log10(\|h\| + 1e-10)` |

Hu moments are computed with `cv2.moments(pts)` → `cv2.HuMoments(m)`, where `pts` is
the polygon point array for the contour.

### Label assignment

Each contour gets one label from the pipeline's own outputs:

| Label | Condition |
|---|---|
| `grid` | bounding rect matches `outerGridBR` |
| `number` | bounding rect appears in `selectedNumbers` |
| `unlabelled` | everything else |

Bounding rect matching is exact integer equality (the same BRect values from the same
pipeline run).

### Spatial cross-referencing columns

For contours labelled `number`, also compute:

- `cell_row`, `cell_col`: which 9×9 cell the contour centre falls in
  (`cell_row = floor(cy / subres)`, `cell_col = floor(cx / subres)`)
- `cage_total`: value from `cageTotals[cell_row][cell_col]` if non-zero, else `null`
- `given_digit`: value from `givenDigits[cell_row][cell_col]` if non-null, else `null`

### Output

`contour-dumps/features.csv` — flat table, one row per contour, all columns above.

---

## Out of scope

- No TypeScript feature implementation
- No ML model or classifier
- No unit tests (research tooling)
- No changes to the production evaluation pipeline
- `contour-dumps/` is never committed
