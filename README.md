# COACH — Killer Sudoku Coaching App

A browser-based coaching companion for killer sudoku. Reads a photo of a newspaper puzzle, detects the cage layout, and guides you through solving with candidates, logical hints, and rule-based deductions — all running locally in the browser with no server required.

**Live app:** https://gbarrett28.github.io/cagedoku/

## How it works

1. Take a photo of a killer sudoku puzzle and upload it
2. The image pipeline locates the grid, detects cage borders, and reads cage totals
3. Review and correct the detected layout if needed, then confirm
4. Solve with the help of candidates display, cage solution inspector, and on-demand hints

## Features

- Offline-capable (service worker caches all assets after first load)
- Candidate display with must-contain highlighting
- Cage solution inspector — click solutions to eliminate impossible combinations
- Virtual cage tool — draw a derived sum constraint across any cells
- Hint engine with 25 rules from naked singles through X-wing, swordfish, and simple colouring
- Config panel to promote hint-only rules to always-apply
- Undo for digit entries, candidate edits, and hint applications

## Development

```bash
cd web
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # Vitest unit + fuzz tests
npx playwright test --config playwright.dev.config.ts   # UI flow tests
```

## Repository

https://github.com/gbarrett28/cagedoku
