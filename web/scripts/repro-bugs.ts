/**
 * repro-bugs.ts — reproduce GitHub bug reports #139, #141, #144
 *
 * Uses exact userGrid from each bug report (post-session state).
 *
 * Usage: cd web && npx vite-node scripts/repro-bugs.ts
 */

import { KillerBoardState } from '../src/engine/boardState.js';
import { SolverEngine } from '../src/engine/solverEngine.js';
import { NakedSingle } from '../src/engine/rules/nakedSingle.js';
import { HiddenSingle } from '../src/engine/rules/hiddenSingle.js';
import { PointingPairs } from '../src/engine/rules/pointingPairs.js';
import { UniqueRectangle } from '../src/engine/rules/uniqueRectangle.js';
import { NakedPair } from '../src/engine/rules/nakedPair.js';
import { HiddenQuad } from '../src/engine/rules/hiddenQuad.js';
import { XWing } from '../src/engine/rules/xWing.js';
import { XYZWing } from '../src/engine/rules/xyzWing.js';
import { Skyscraper } from '../src/engine/rules/skyscraper.js';
import { HiddenPair } from '../src/engine/rules/hiddenPair.js';
import { NakedTriple } from '../src/engine/rules/nakedTriple.js';
import { HiddenTriple } from '../src/engine/rules/hiddenTriple.js';
import { LockedCandidates } from '../src/engine/rules/lockedCandidates.js';
import { mrvBacktrack } from '../src/engine/backtracker.js';
import { Cell, Elimination, Trigger } from '../src/engine/types.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';

function makeClassicSpec(): PuzzleSpec {
  return {
    regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1)),
    cageTotals: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => c === 0 ? 45 : 0)),
    borderX: Array.from({ length: 9 }, () => Array.from({ length: 8 }, () => true)),
    borderY: Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => false)),
  };
}

function makeEngine(board: KillerBoardState, ...rules: any[]): SolverEngine {
  return new SolverEngine(board, rules, { linearSystemActive: false });
}

function seedDigits(engine: SolverEngine, board: KillerBoardState, grid: number[][]): void {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const d = grid[r]![c]!;
      if (d > 0) {
        const elims: Elimination[] = [];
        for (let other = 1; other <= 9; other++) {
          if (other !== d && board.cands(r, c).has(other))
            elims.push({ cell: [r, c] as Cell, digit: other });
        }
        if (elims.length) engine.applyEliminations(elims);
      }
    }
  }
}

function getGolden(board: KillerBoardState): number[][] | null {
  const snap = board.candidates.map(row => row.map(cell => new Set(cell!)));
  const sol = mrvBacktrack(board);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) board.candidates[r]![c]! = snap[r]![c]!;
  return sol;
}

function countUnsolved(board: KillerBoardState): number {
  let n = 0;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (board.cands(r, c).size > 1) n++;
  return n;
}

/** Check all hint rules simultaneously on the board, like the real hint engine does. */
function checkAllHintRules(board: KillerBoardState, golden: number[][] | null, hintRules: any[]): void {
  for (const rule of hintRules) {
    const ctx = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
    const result = rule.apply(ctx);
    if (result.eliminations.length > 0) {
      const hints = rule.asHints(ctx, result.eliminations);
      for (const h of hints) {
        const elims = result.eliminations.map((e: any) => {
          const [r, c] = e.cell;
          const ok = golden?.[r]?.[c] !== e.digit;
          return `r${r+1}c${c+1}-=${e.digit}${ok ? '' : '❌WRONG'}`;
        });
        console.log(`  ${rule.name}: ${h.explanation}`);
        console.log(`    elims: ${elims.join(', ')}`);
        const pivots = h.highlightCells.slice(0, 4).map(([r,c]: [number,number]) => `r${r+1}c${c+1}`);
        console.log(`    pivots[0..3]: ${pivots.join(', ')}`);
      }
    }
    // Also try unit-scoped
    for (const unit of board.units) {
      const uCtx = { board, unit, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
      const res = rule.apply(uCtx);
      if (res.eliminations.length > 0) {
        const hints = rule.asHints(uCtx, res.eliminations);
        for (const h of hints) {
          const elims = res.eliminations.map((e: any) => {
            const [r, c] = e.cell;
            const ok = golden?.[r]?.[c] !== e.digit;
            return `r${r+1}c${c+1}-=${e.digit}${ok ? '' : '❌WRONG'}`;
          });
          console.log(`  ${rule.name}(unit): ${h.explanation}`);
          console.log(`    elims: ${elims.join(', ')}`);
          const pivots = h.highlightCells.slice(0, 4).map(([r,c]: [number,number]) => `r${r+1}c${c+1}`);
          console.log(`    pivots[0..3]: ${pivots.join(', ')}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bug #139 — Unique Rectangle — exact userGrid from bug report
// ---------------------------------------------------------------------------
console.log('\n====== Bug #139 — Unique Rectangle ======');
{
  // userGrid from bug report (has more solved cells than givenDigits)
  const userGrid = [[0,0,0,0,0,0,0,0,0],[7,0,6,4,5,0,0,3,0],[3,5,1,0,0,2,0,4,0],[0,0,2,6,1,0,4,0,0],[0,8,0,7,9,3,0,1,0],[0,0,0,0,2,4,0,0,0],[0,4,0,0,0,7,3,2,0],[0,0,3,0,4,0,1,0,0],[0,0,0,0,0,0,8,5,4]];
  const board = new KillerBoardState(makeClassicSpec(), { includeVirtualCages: false });
  const engine = makeEngine(board, new NakedSingle());
  seedDigits(engine, board, userGrid);
  engine.solve();
  console.log(`\nAfter NakedSingle with userGrid: ${countUnsolved(board)} unsolved`);
  const golden = getGolden(board);

  // Apply the Hidden Quad hint (as in session trace)
  const ctx = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
  let quadApplied = false;
  for (const unit of board.units) {
    const uCtx = { board, unit, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
    const quad = new HiddenQuad();
    const res = quad.apply(uCtx);
    if (res.eliminations.length > 0) {
      const hints = quad.asHints(uCtx, res.eliminations);
      if (hints.length > 0) {
        console.log(`Applied HiddenQuad: ${hints[0]!.explanation}`);
        engine.applyEliminations(hints[0]!.eliminations);
        engine.solve();
        quadApplied = true;
        break;
      }
    }
  }
  if (!quadApplied) console.log('HiddenQuad: not found');

  console.log(`After quad: ${countUnsolved(board)} unsolved`);
  console.log('Checking UR:');
  checkAllHintRules(board, golden, [new UniqueRectangle()]);

  // Check the UR description field (which the user complained about)
  const ur = new UniqueRectangle();
  console.log('\nUR description (first 300 chars):');
  console.log(ur.description.slice(0, 300));
}

// ---------------------------------------------------------------------------
// Bug #141 — Naked Pair — exact userGrid from bug report
// ---------------------------------------------------------------------------
console.log('\n====== Bug #141 — Naked Pair ======');
{
  // userGrid from bug report
  const userGrid = [[0,0,0,9,6,0,7,3,0],[0,0,0,1,0,3,4,0,0],[0,0,0,7,8,0,5,9,1],[0,0,3,5,0,0,0,4,0],[0,5,0,0,0,0,2,0,6],[0,0,1,2,0,6,0,0,3],[6,0,5,4,0,7,0,0,0],[9,0,0,0,1,0,0,0,0],[0,8,2,0,0,0,0,0,0]];
  const spec = makeClassicSpec();
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  const engine = makeEngine(board, new NakedSingle());
  seedDigits(engine, board, userGrid);
  engine.solve();
  console.log(`\nAfter NakedSingle with userGrid: ${countUnsolved(board)} unsolved`);
  const golden = getGolden(board);

  console.log('Top-right box (r1-3, c7-9) candidates:');
  for (let r = 0; r < 3; r++) for (let c = 6; c < 9; c++) {
    const s = board.cands(r, c);
    if (s.size >= 1) console.log(`  r${r+1}c${c+1}: {${[...s].sort().join(',')}}`);
  }

  console.log('\nAll hint rules simultaneously:');
  checkAllHintRules(board, golden, [
    new HiddenSingle(), new NakedPair(), new HiddenPair(),
    new PointingPairs(), new LockedCandidates(), new NakedTriple(), new HiddenTriple(),
  ]);

  // Now check: does PointingPairs eliminate the SAME targets as NakedPair?
  console.log('\n--- Dedup check: NakedPair vs PointingPairs in col 9 ---');
  const npElims = new Set<string>();
  const ppElims = new Set<string>();

  for (const unit of board.units) {
    const uCtx = { board, unit, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
    const npRes = new NakedPair().apply(uCtx);
    for (const e of npRes.eliminations) npElims.add(`${e.cell[0]},${e.cell[1]}:${e.digit}`);
    const ppRes = new PointingPairs().apply(uCtx);
    for (const e of ppRes.eliminations) ppElims.add(`${e.cell[0]},${e.cell[1]}:${e.digit}`);
  }

  const overlap = [...npElims].filter(k => ppElims.has(k));
  console.log(`NakedPair eliminations: ${[...npElims].sort().join(', ')}`);
  console.log(`PointingPairs eliminations: ${[...ppElims].sort().join(', ')}`);
  console.log(`Overlap (dedup risk): ${overlap.join(', ')}`);

  const hsElims = new Set<string>();
  for (const unit of board.units) {
    const uCtx = { board, unit, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
    const hsRes = new HiddenSingle().apply(uCtx);
    for (const e of hsRes.eliminations) hsElims.add(`${e.cell[0]},${e.cell[1]}:${e.digit}`);
  }
  const hsOverlap = [...npElims].filter(k => hsElims.has(k));
  console.log(`HiddenSingle overlap with NakedPair: ${hsOverlap.length === 0 ? 'none' : hsOverlap.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Bug #144 — X-Wing wrong defining cells — exact userGrid from bug report
// ---------------------------------------------------------------------------
console.log('\n====== Bug #144 — X-Wing wrong cells ======');
{
  // userGrid already has 2 Skyscraper hints applied
  const userGrid = [[5,6,0,3,0,4,7,2,0],[3,0,4,0,0,7,6,5,8],[0,0,7,0,6,5,3,4,0],[6,3,9,4,5,0,0,1,7],[7,0,5,9,0,1,4,3,6],[0,4,0,6,7,3,0,9,5],[4,0,6,0,1,9,5,7,3],[9,7,3,5,4,6,1,8,2],[0,5,0,7,3,0,9,6,4]];
  const board = new KillerBoardState(makeClassicSpec(), { includeVirtualCages: false });
  const engine = makeEngine(board, new NakedSingle());
  seedDigits(engine, board, userGrid);
  engine.solve();
  console.log(`\nAfter NakedSingle with userGrid: ${countUnsolved(board)} unsolved`);
  const golden = getGolden(board);

  console.log('Unsolved cells:');
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const s = board.cands(r, c);
    if (s.size > 1) console.log(`  r${r+1}c${c+1}: {${[...s].sort().join(',')}}`);
  }

  console.log('\nChecking X-Wing (all variants):');
  const xwing = new XWing();
  let found = false;

  // Global context
  const gCtx = { board, unit: null, cell: null, hint: Trigger.GLOBAL, hintDigit: null };
  const gRes = xwing.apply(gCtx);
  if (gRes.eliminations.length > 0) {
    const hints = xwing.asHints(gCtx, gRes.eliminations);
    for (const h of hints) {
      console.log(`\nXWing: ${h.explanation}`);
      console.log(`  highlightCells (all): ${h.highlightCells.map(([r,c]: [number,number]) => `r${r+1}c${c+1}`).join(', ')}`);
      console.log(`  eliminations: ${h.eliminations.map((e: any) => {
        const [r, c] = e.cell;
        const ok = golden?.[r]?.[c] !== e.digit;
        return `r${r+1}c${c+1}-=${e.digit}${ok ? '' : '❌WRONG'}`;
      }).join(', ')}`);
      found = true;
    }
  }

  if (!found) console.log('  XWing: rule does not fire');

  // Also check digit by digit to find which digit the XWing fires for
  console.log('\nDigit-by-digit XWing candidate analysis:');
  for (let digit = 1; digit <= 9; digit++) {
    // Check col counts per row
    const rowCols: number[][] = Array.from({ length: 9 }, () => []);
    const colRows: number[][] = Array.from({ length: 9 }, () => []);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (board.cands(r, c).has(digit) && board.cands(r, c).size > 1) {
          rowCols[r]!.push(c);
          colRows[c]!.push(r);
        }
      }
    }
    // Row-variant: rows with exactly 2 cols for this digit
    const rows2 = rowCols.map((cs, r) => cs.length === 2 ? r : -1).filter(r => r >= 0);
    for (let i = 0; i < rows2.length - 1; i++) {
      for (let j = i + 1; j < rows2.length; j++) {
        const ra = rows2[i]!, rb = rows2[j]!;
        const [ca1, ca2] = rowCols[ra]!;
        const [cb1, cb2] = rowCols[rb]!;
        if (ca1 === cb1 && ca2 === cb2) {
          console.log(`  d${digit} ROW-variant: rows r${ra+1},r${rb+1} × cols c${ca1!+1},c${ca2!+1} — pivots r${ra+1}c${ca1!+1},r${ra+1}c${ca2!+1},r${rb+1}c${cb1!+1},r${rb+1}c${cb2!+1}`);
        }
      }
    }
    // Col-variant: cols with exactly 2 rows for this digit
    const cols2 = colRows.map((rs, c) => rs.length === 2 ? c : -1).filter(c => c >= 0);
    for (let i = 0; i < cols2.length - 1; i++) {
      for (let j = i + 1; j < cols2.length; j++) {
        const ca = cols2[i]!, cb = cols2[j]!;
        const [ra1, ra2] = colRows[ca]!;
        const [rb1, rb2] = colRows[cb]!;
        if (ra1 === rb1 && ra2 === rb2) {
          console.log(`  d${digit} COL-variant: cols c${ca+1},c${cb+1} × rows r${ra1!+1},r${ra2!+1} — correct pivots r${ra1!+1}c${ca+1},r${ra1!+1}c${cb+1},r${ra2!+1}c${ca+1},r${ra2!+1}c${cb+1}`);
          // The user says correct pivots are r2c2,r3c2,r3c4,r2c4 (1-indexed)
          // = (row1,col1),(row2,col1),(row2,col3),(row1,col3) (0-indexed)
        }
      }
    }
  }
}
