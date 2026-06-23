/**
 * Hole-count topology feature for the digit recogniser. Mirrors
 * extract_hole_features() in web/train_recogniser.py exactly.
 *
 * Distinguishes shapes like "3" (0 holes) from "8" (2 holes) — a signal HOG's
 * local gradient histograms cannot encode, since hole structure is global
 * topology, not local edge orientation. See
 * docs/superpowers/specs/2026-06-23-hole-count-feature-design.md for the
 * full design rationale.
 */

const MIN_HOLE_AREA = 6;
const N_HOLE_FEATURES = 5;

/**
 * Count enclosed background regions ("holes") in a binarized digit thumbnail
 * and encode them as a fixed-width feature vector.
 *
 * Algorithm: BFS from every border background pixel (4-connectivity) marks
 * "outside"; any background pixel left unvisited is enclosed. A second
 * 4-connectivity pass labels those into distinct hole regions with per-region
 * pixel area. Regions smaller than MIN_HOLE_AREA are discarded as
 * anti-aliasing/dither noise.
 *
 * @param imgs - flat uint8 pixel data per image (ink=255, background=0), each
 *   of length winSize²
 * @param winSize - thumbnail side length (64 for the digit recogniser)
 * @returns Float64Array of shape [n × 5], flattened row-major:
 *   [onehot(0 holes), onehot(1 hole), onehot(2+ holes), frac(largest hole), frac(2nd largest)]
 */
export function extractHoleFeatures(imgs: Uint8Array[], winSize: number): Float64Array {
  const n = imgs.length;
  const size = winSize * winSize;
  const result = new Float64Array(n * N_HOLE_FEATURES);
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);

  const neighbours = (i: number, y: number, x: number): readonly number[] => {
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < winSize - 1) out.push(i + 1);
    if (y > 0) out.push(i - winSize);
    if (y < winSize - 1) out.push(i + winSize);
    return out;
  };

  for (let p = 0; p < n; p++) {
    const img = imgs[p]!;
    visited.fill(0);

    let inkCount = 0;
    for (let i = 0; i < size; i++) if (img[i]! > 0) inkCount++;

    // Step 1: flood-fill "outside" from every border background pixel.
    let qHead = 0, qTail = 0;
    const seedBorder = (i: number): void => {
      if (img[i]! === 0 && !visited[i]) { visited[i] = 1; queue[qTail++] = i; }
    };
    for (let x = 0; x < winSize; x++) { seedBorder(x); seedBorder((winSize - 1) * winSize + x); }
    for (let y = 0; y < winSize; y++) { seedBorder(y * winSize); seedBorder(y * winSize + winSize - 1); }
    while (qHead < qTail) {
      const i = queue[qHead++]!;
      const y = (i / winSize) | 0;
      const x = i - y * winSize;
      for (const j of neighbours(i, y, x)) {
        if (img[j]! === 0 && !visited[j]) { visited[j] = 1; queue[qTail++] = j; }
      }
    }

    // Step 2: label remaining unvisited background pixels as hole regions.
    const holeAreas: number[] = [];
    for (let start = 0; start < size; start++) {
      if (visited[start] || img[start]! !== 0) continue;
      qHead = 0; qTail = 0;
      visited[start] = 1;
      queue[qTail++] = start;
      let area = 0;
      while (qHead < qTail) {
        const i = queue[qHead++]!;
        area++;
        const y = (i / winSize) | 0;
        const x = i - y * winSize;
        for (const j of neighbours(i, y, x)) {
          if (img[j]! === 0 && !visited[j]) { visited[j] = 1; queue[qTail++] = j; }
        }
      }
      if (area >= MIN_HOLE_AREA) holeAreas.push(area);
    }
    holeAreas.sort((a, b) => b - a);

    const base = p * N_HOLE_FEATURES;
    const bucket = Math.min(holeAreas.length, 2);
    result[base + bucket] = 1;
    const denom = Math.max(inkCount, 1);
    result[base + 3] = (holeAreas[0] ?? 0) / denom;
    result[base + 4] = (holeAreas[1] ?? 0) / denom;
  }

  return result;
}
