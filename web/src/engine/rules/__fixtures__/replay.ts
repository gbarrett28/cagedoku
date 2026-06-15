/**
 * Builds a KillerBoardState that replays a RuleBugFixture's stalled puzzle
 * state, using the standard PuzzleSpecData deserialiser so cage geometry
 * matches what the real engine would have produced.
 */

import { dataToSpec } from '../../../session/specUtils.js';
import { KillerBoardState } from '../../boardState.js';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

export function boardFromFixture(fixture: RuleBugFixture): KillerBoardState {
  const spec = dataToSpec({ regions: fixture.regions, cageTotals: fixture.cageTotals });
  const board = new KillerBoardState(spec, { includeVirtualCages: false });
  board.restoreCandidates(fixture.stalledCandidates);
  return board;
}
