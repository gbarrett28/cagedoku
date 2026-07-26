/**
 * Detects likely digit-recognizer misreads in classic given-digit grids from
 * real corpus photos and proposes corrections for manual review.
 *
 * Never treats "a solution exists" as proof a correction is right: only a
 * folklore rule-engine solve that fully resolves the corrected grid on its
 * own (solveClassicByRulesOnly, no backtracking) counts as a uniqueness
 * proof (confidenceTier: 'proven_unique'). A capping-aware backtracking
 * search (mrvBacktrackProvenInfeasible) is used exclusively to rule out
 * corrections that make the puzzle outright infeasible — never to confirm
 * one. Every candidate is gated on hasDuplicateDigits before any solve is
 * attempted, and again after substitution before accepting a result.
 */
import { hasDuplicateDigits, findDuplicateCells, findDuplicateClashPartners } from '../session/assertions.js';
import { solveClassicByRulesOnly } from './index.js';
import { mrvBacktrackProvenInfeasible } from './backtracker.js';
import type { Recognition } from '../image/numberRecognition.js';

export interface RetrainingSuggestion {
  row: number;
  col: number;
  predictedLabel: number;
  suggestedLabel: number;
  confidenceTier: 'proven_unique' | 'feasible_only';
  crop: Uint8Array;
}

export interface GivenDigitRead {
  row: number;
  col: number;
  predictedLabel: number;
  confident: boolean;
  /** Other given-digit cells this one shares a digit with in some row/col/box. Empty if none. */
  clashesWith: { row: number; col: number }[];
  crop: Uint8Array;
}

export function findRetrainingSuggestions(
  givenDigits: readonly (readonly number[])[],
  cellThumbs: ReadonlyMap<string, Uint8Array[]>,
  recognitions: ReadonlyMap<string, Recognition>,
): RetrainingSuggestion[] {
  if (!hasDuplicateDigits(givenDigits)) return [];

  const mutableGrid = givenDigits.map(row => [...row]);
  const clashingCells = findDuplicateCells(mutableGrid);
  const suggestions: RetrainingSuggestion[] = [];

  for (const key of clashingCells) {
    const [rowStr, colStr] = key.split(',');
    const row = Number(rowStr);
    const col = Number(colStr);
    const recognition = recognitions.get(key);
    if (recognition?.runnerUp === undefined) continue;

    const original = mutableGrid[row]![col]!;
    mutableGrid[row]![col] = recognition.runnerUp.label;

    if (hasDuplicateDigits(mutableGrid)) {
      // Substitution didn't clear every clash (multiple independent clashes,
      // or it introduced a new one) — reject without ever attempting a solve.
      mutableGrid[row]![col] = original;
      continue;
    }

    const { board, solvedByRulesAlone } = solveClassicByRulesOnly(mutableGrid);
    const thumbArr = cellThumbs.get(key);
    const crop = thumbArr?.[0];

    if (solvedByRulesAlone && crop !== undefined) {
      suggestions.push({
        row, col,
        predictedLabel: recognition.label,
        suggestedLabel: recognition.runnerUp.label,
        confidenceTier: 'proven_unique',
        crop,
      });
    } else if (crop !== undefined && !mrvBacktrackProvenInfeasible(board)) {
      // Not proven unique, but not proven infeasible either — a plausible
      // candidate for human review, flagged at lower confidence.
      suggestions.push({
        row, col,
        predictedLabel: recognition.label,
        suggestedLabel: recognition.runnerUp.label,
        confidenceTier: 'feasible_only',
        crop,
      });
    }
    // else: mrvBacktrackProvenInfeasible === true → this correction is wrong
    // (or insufficient); reject it, propose nothing for this cell.

    mutableGrid[row]![col] = original;
  }

  return suggestions;
}

/**
 * Every given-digit cell's read, independent of whether it's part of a
 * clash — unlike findRetrainingSuggestions, which only reports resolvable
 * duplicate-clash substitutions. Used by evaluate-corpus.ts to persist
 * ground-truth crops+labels for later offline analysis (e.g. comparing
 * against a separately-derived read of the same puzzle).
 */
export function buildGivenDigitReads(
  givenDigits: readonly (readonly number[])[],
  cellThumbs: ReadonlyMap<string, Uint8Array[]>,
  recognitions: ReadonlyMap<string, Recognition>,
): GivenDigitRead[] {
  const clashPartners = findDuplicateClashPartners(givenDigits);
  const reads: GivenDigitRead[] = [];

  for (const [key, recognition] of recognitions) {
    const crop = cellThumbs.get(key)?.[0];
    if (crop === undefined) continue;
    const [rowStr, colStr] = key.split(',');
    const partners = clashPartners.get(key);
    const clashesWith = partners === undefined ? [] : Array.from(partners, partnerKey => {
      const [pRowStr, pColStr] = partnerKey.split(',');
      return { row: Number(pRowStr), col: Number(pColStr) };
    });

    reads.push({
      row: Number(rowStr),
      col: Number(colStr),
      predictedLabel: recognition.label,
      confident: recognition.confident,
      clashesWith,
      crop,
    });
  }

  return reads;
}
