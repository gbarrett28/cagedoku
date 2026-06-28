import { dataToSpec } from '../session/specUtils.js';
import { PuzzleState } from '../session/types.js';

async function sha256hex(data: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(bytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeSpecHash(state: PuzzleState | null): Promise<string | null> {
  if (state === null) return null;
  if (PuzzleState.isKiller(state)) {
    const spec = dataToSpec(state.specData);
    return sha256hex(
      JSON.stringify({ borderX: spec.borderX, borderY: spec.borderY, cageTotals: spec.cageTotals }),
    );
  }
  return sha256hex(JSON.stringify(state.givenDigits));
}
