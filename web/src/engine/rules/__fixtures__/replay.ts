/**
 * Replays a RuleBugFixture's serialized session: deserializes the
 * `SerializedPuzzleState` and runs it through `buildEngine` exactly as the
 * live app would, reproducing the board at the moment the bug/miss was
 * detected.
 */

import { buildEngine } from '../../../session/engine.js';
import { PuzzleState } from '../../../session/types.js';
import type { BoardState } from '../../boardState.js';
import type { RuleBugFixture } from '../../../../../shared/src/fixture.js';

export function boardFromFixture(fixture: RuleBugFixture): { board: BoardState; state: PuzzleState } {
  const state = PuzzleState.deserialize(fixture.state);
  const { board } = buildEngine(state, { skipValidation: true });
  return { board, state };
}
