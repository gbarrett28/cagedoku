import { describe, it, expect } from 'vitest';
import { findRetrainingSuggestions } from './retrainingSuggestions.js';
import { KNOWN_SOLUTION } from './fixtures.js';
import type { Recognition } from '../image/numberRecognition.js';

function thumb(seed: number): Uint8Array {
  // Distinct-but-arbitrary 64x64 crop content; only identity/byte-equality
  // across the pipeline matters here, not visual content.
  return new Uint8Array(64 * 64).fill(seed);
}

describe('findRetrainingSuggestions', () => {
  it('proposes a proven_unique correction when the runner-up resolves the clash and the corrected grid solves by rules alone', () => {
    // KNOWN_SOLUTION (fixtures.ts) is a complete valid grid: column 0 is
    // [5,6,1,8,4,7,9,2,3]. Corrupt (0,0) from its true value 5 to 6, matching
    // row 1's column-0 given -- a genuine column-0 duplicate on 6, mirroring
    // this session's real classic_guardian/expert/killer_sudoku_274.jpg
    // finding (a misread cell clashing with a correctly-read one elsewhere in
    // the same column). The runner-up correctly names the true digit, 5.
    const givenDigits = KNOWN_SOLUTION.map(row => [...row]);
    givenDigits[0]![0] = 6;

    const cellThumbs = new Map<string, Uint8Array[]>([['0,0', [thumb(1)]]]);
    const recognitions = new Map<string, Recognition>([
      ['0,0', { label: 6, confident: true, runnerUp: { label: 5, score: 5 } }],
    ]);

    const suggestions = findRetrainingSuggestions(givenDigits, cellThumbs, recognitions);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      row: 0, col: 0, predictedLabel: 6, suggestedLabel: 5,
      confidenceTier: 'proven_unique',
    });
  });

  it('proposes nothing when there is no clash at all', () => {
    const cellThumbs = new Map<string, Uint8Array[]>();
    const recognitions = new Map<string, Recognition>();
    const givenDigits = Array.from({ length: 9 }, () => Array(9).fill(0));
    expect(findRetrainingSuggestions(givenDigits, cellThumbs, recognitions)).toEqual([]);
  });

  it('never proposes a correction for a cell with no runnerUp available', () => {
    const givenDigits = Array.from({ length: 9 }, () => Array(9).fill(0));
    givenDigits[0]![0] = 7;
    givenDigits[0]![5] = 7;
    const cellThumbs = new Map<string, Uint8Array[]>([
      ['0,0', [thumb(1)]], ['0,5', [thumb(2)]],
    ]);
    const recognitions = new Map<string, Recognition>([
      ['0,0', { label: 7, confident: true }], // no runnerUp
      ['0,5', { label: 7, confident: true }], // no runnerUp
    ]);
    expect(findRetrainingSuggestions(givenDigits, cellThumbs, recognitions)).toEqual([]);
  });
});
