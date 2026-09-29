// Wall linework without layers or pen weights. A flattened export draws a wall as
// two parallel lines at wall thickness (often with hatch between), in the same pen
// as the furniture, and draws grid axes as single lines — so pairing separates
// walls where neither layer nor pen weight can. Port of Datum's walls.mjs.

/** Per-segment flag (1 = wall face): a segment at least `minSeg` long with a
 *  parallel partner `tmin`..`tmax` away that overlaps it by `minOverlap`.
 *  Lengths in metres; `pxPerM` converts them to the segments' image px. */
export function wallSegIndices(
  segs: number[], meta: Uint8Array, pxPerM: number,
  { tmin = 0.07, tmax = 0.35, minSeg = 0.8, minOverlap = 0.8, angleDeg = 1.5 } = {},
): Uint8Array {
  const n = segs.length >> 2, keep = new Uint8Array(n);
  const minLen = minSeg * pxPerM, maxOff = tmax * pxPerM, minOff = tmin * pxPerM, minOv = minOverlap * pxPerM;
  const sinTol = Math.sin(angleDeg * Math.PI / 180);
  const cell = Math.max(maxOff * 2, 1), grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (meta[i] & 3) continue;                     // curve chords and clip paths are never wall faces
    const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
    if (Math.hypot(x1 - x0, y1 - y0) < minLen) continue;
    const gx0 = Math.floor((Math.min(x0, x1) - maxOff) / cell), gx1 = Math.floor((Math.max(x0, x1) + maxOff) / cell);
    const gy0 = Math.floor((Math.min(y0, y1) - maxOff) / cell), gy1 = Math.floor((Math.max(y0, y1) + maxOff) / cell);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gx * 1e6 + gy;
      let b = grid.get(k);
      if (!b) grid.set(k, b = []);
      b.push(i);
    }
  }
  const seen = new Set<number>();
  for (const b of grid.values()) {
    for (let a = 0; a < b.length; a++) for (let c = a + 1; c < b.length; c++) {
      let i = b[a], j = b[c];
      if (i > j) [i, j] = [j, i];
      const key = i * 4194304 + j;
      if (seen.has(key)) continue;
      seen.add(key);
      const ax = segs[4 * i], ay = segs[4 * i + 1], dx = segs[4 * i + 2] - ax, dy = segs[4 * i + 3] - ay, L = Math.hypot(dx, dy);
      const ux = dx / L, uy = dy / L;
      const ex = segs[4 * j + 2] - segs[4 * j], ey = segs[4 * j + 3] - segs[4 * j + 1], M = Math.hypot(ex, ey);
      if (Math.abs(ux * ey - uy * ex) / M > sinTol) continue;
      const mx = (segs[4 * j] + segs[4 * j + 2]) / 2 - ax, my = (segs[4 * j + 1] + segs[4 * j + 3]) / 2 - ay;
      const off = Math.abs(mx * -uy + my * ux);
      if (off < minOff || off > maxOff) continue;
      const t0 = (segs[4 * j] - ax) * ux + (segs[4 * j + 1] - ay) * uy, t1 = (segs[4 * j + 2] - ax) * ux + (segs[4 * j + 3] - ay) * uy;
      if (Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) < minOv) continue;
      keep[i] = keep[j] = 1;
    }
  }
  return keep;
}
