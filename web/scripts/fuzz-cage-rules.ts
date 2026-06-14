#!/usr/bin/env vite-node
/**
 * fuzz-cage-rules.ts — property-based reproducer for CageCandidateFilter /
 * SolutionMapFilter golden-solution violations.
 *
 * Generates random valid killer-sudoku cage layouts on top of the fixed
 * KNOWN_SOLUTION grid (so the golden solution is known), runs the real
 * KillerSolverEngine with goldenSolution + onViolation wired up, and reports
 * the first seed where CageCandidateFilter or SolutionMapFilter would
 * eliminate a digit that matches the golden solution.
 *
 * Usage (from the repo root):
 *   npx vite-node web/scripts/fuzz-cage-rules.ts [numSeeds]
 */

import { KNOWN_SOLUTION } from '../src/engine/fixtures.js';
import { validateCageLayout } from '../src/image/validation.js';
import { KillerBoardState } from '../src/engine/boardState.js';
import { KillerSolverEngine } from '../src/engine/solverEngine.js';
import { defaultRules } from '../src/engine/rules/index.js';
import type { Elimination } from '../src/engine/types.js';
import type { PuzzleSpec } from '../src/solver/puzzleSpec.js';

/** Seeded LCG for reproducible pseudo-random sequences. */
function makePrng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// NOTE: LinearSystem._deriveNonburbVirtualCages/_reduceDerive has unbounded
// (apparently exponential) complexity for layouts with many 3+ cell cages —
// see the OOM finding documented separately. Keep cages small/sparse here so
// the reproducer can actually run; this still exercises real virtual-cage
// derivation for pair cages.
const MERGE_PASSES = 1;
const MERGE_PROB = 0.08;
const MAX_CAGE_SIZE = 2;

/**
 * Build a random valid killer cage layout over KNOWN_SOLUTION.
 *
 * Starts from 81 single-cell cages and repeatedly merges grid-adjacent cages
 * whose golden digits are disjoint (so every cage's digits remain distinct,
 * as required by the "distinct digits" cage constraint).
 */
function randomCageSpec(rng: () => number): PuzzleSpec {
  const N = 81;
  const parent = Array.from({ length: N }, (_, i) => i);
  const digitSets = Array.from({ length: N }, (_, i) =>
    new Set<number>([KNOWN_SOLUTION[Math.floor(i / 9)]![i % 9]!]));

  function find(x: number): number {
    while (parent[x] !== x) x = parent[x]!;
    return x;
  }

  const pairs: Array<[number, number]> = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (c < 8) pairs.push([r * 9 + c, r * 9 + c + 1]);
      if (r < 8) pairs.push([r * 9 + c, (r + 1) * 9 + c]);
    }
  }

  for (let pass = 0; pass < MERGE_PASSES; pass++) {
    for (const [a, b] of shuffle(pairs, rng)) {
      const ra = find(a), rb = find(b);
      if (ra === rb) continue;
      if (rng() > MERGE_PROB) continue;
      const setA = digitSets[ra]!, setB = digitSets[rb]!;
      if (setA.size + setB.size > MAX_CAGE_SIZE) continue;
      let disjoint = true;
      for (const d of setB) if (setA.has(d)) { disjoint = false; break; }
      if (!disjoint) continue;
      for (const d of setB) setA.add(d);
      parent[rb] = ra;
    }
  }

  const cageTotals: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  for (let i = 0; i < N; i++) {
    if (find(i) === i) {
      const r = Math.floor(i / 9), c = i % 9;
      let sum = 0;
      for (const d of digitSets[i]!) sum += d;
      cageTotals[r]![c] = sum;
    }
  }

  // borderX[col][rowGap]; borderY[colGap][row] — see docs/architecture.md.
  const borderX: boolean[][] = Array.from({ length: 9 }, () => new Array<boolean>(8).fill(true));
  const borderY: boolean[][] = Array.from({ length: 8 }, () => new Array<boolean>(9).fill(true));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (c < 8 && find(r * 9 + c) === find(r * 9 + c + 1)) borderY[c]![r] = false;
      if (r < 8 && find(r * 9 + c) === find((r + 1) * 9 + c)) borderX[c]![r] = false;
    }
  }

  return validateCageLayout(cageTotals, borderX, borderY);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const numSeeds = Number(process.argv[2] ?? 2000);
const targetRules = new Set(['CageCandidateFilter', 'SolutionMapFilter']);
let foundCount = 0;

for (let seed = 1; seed <= numSeeds; seed++) {
  const rng = makePrng(seed);
  const spec = randomCageSpec(rng);
  const board = new KillerBoardState(spec);

  const violations: Array<{ ruleName: string; offending: readonly Elimination[] }> = [];
  const engine = new KillerSolverEngine(board, defaultRules(), {
    goldenSolution: KNOWN_SOLUTION,
    onViolation: (ruleName, offending) => { violations.push({ ruleName, offending }); },
  });

  try {
    engine.solve();
  } catch (e) {
    console.log(`seed=${seed}: solve() threw: ${(e as Error).message}`);
    continue;
  }

  const bad = violations.filter(v => targetRules.has(v.ruleName));
  if (bad.length > 0) {
    foundCount++;
    console.log(`\n=== seed ${seed}: golden-violating elimination ===`);
    console.log('regions:', JSON.stringify(spec.regions));
    console.log('cageTotals:', JSON.stringify(spec.cageTotals));
    console.log('borderX:', JSON.stringify(spec.borderX));
    console.log('borderY:', JSON.stringify(spec.borderY));
    for (const v of bad) {
      console.log(`rule=${v.ruleName}`);
      for (const e of v.offending) {
        const [r, c] = e.cell;
        console.log(`  r${r + 1}c${c + 1} -= ${e.digit} (golden=${KNOWN_SOLUTION[r]![c]})`);
      }
    }
    if (foundCount >= 5) break;
  } else if (violations.length > 0) {
    console.log(`seed=${seed}: ${violations.length} violation(s) from other rules: ${[...new Set(violations.map(v => v.ruleName))].join(', ')}`);
  }
}

if (foundCount === 0) console.log(`No CageCandidateFilter/SolutionMapFilter violations found across ${numSeeds} seeds.`);
else console.log(`\nFound ${foundCount} violating seed(s) out of ${numSeeds}.`);
