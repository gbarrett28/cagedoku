/**
 * Ink-bounding-box aspect ratio: a single scalar feature meant to give the
 * classifier a direct, targeted signal for confusions HOG+hole can't resolve
 * (notably 1 vs 7 -- both are hole-free, and HOG's per-block L2 normalisation
 * discards much of the raw-magnitude "how much ink, how wide" signal that
 * would otherwise separate a narrow glyph from a wide one).
 *
 * Computed from the same 64x64 canonical image HOG/hole already receive, not
 * the pre-warp raw crop -- letterbox warping preserves aspect ratio, so the
 * ink footprint within the canonical image already encodes it.
 */
export function extractAspectFeatures(imgs: Uint8Array[], winSize: number): Float64Array {
  const n = imgs.length;
  const result = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const img = imgs[p]!;
    let minX = winSize, maxX = -1, minY = winSize, maxY = -1;
    for (let y = 0; y < winSize; y++) {
      for (let x = 0; x < winSize; x++) {
        if (img[y * winSize + x]! > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const w = maxX >= minX ? maxX - minX + 1 : 0;
    const h = maxY >= minY ? maxY - minY + 1 : 0;
    result[p] = h > 0 ? w / h : 0;
  }
  return result;
}
