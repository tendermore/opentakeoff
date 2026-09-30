// Edge snapping: move each edge of an approximate outline (a raster flood's trace, a vision model's
// drawing) onto the parallel drawn line closest to it, then rebuild the corners as line intersections.
// The approximation is off by a few raster cells or image pixels; the drawing's own linework is exact.
import { SEG_CURVE, SEG_CLIP } from "./oneclick.ts";

type Pt = [number, number];

/** `tolPx`: how far (sheet px) an edge may move; `allowed`: per-segment flag of the lines it may snap to
 *  (null = every straight stroke). An edge with no parallel line covering `minCover` of it stays put.
 *  `prefer`: "nearest" line (default), or the one furthest "inward" — the room-side face of a wall, for an
 *  outline drawn on or across the wall rather than beside its inner face. */
export function snapEdges(ring: Pt[], segs: ArrayLike<number>, meta: ArrayLike<number>, pxPerM: number, tolPx: number,
  { allowed = null as ArrayLike<number> | null, minCover = 0.35, angleDeg = 3, prefer = "nearest" as "nearest" | "inward" } = {}): Pt[] {
  const n = ring.length;
  if (n < 3 || !(tolPx > 0)) return ring;
  const minSeg = 0.2 * pxPerM, minEdge = 0.3 * pxPerM, sinTol = Math.sin((angleDeg * Math.PI) / 180);
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bx0 = Math.min(...xs) - tolPx, bx1 = Math.max(...xs) + tolPx, by0 = Math.min(...ys) - tolPx, by1 = Math.max(...ys) + tolPx;
  const cand: number[] = [];
  for (let i = 0, m = segs.length >> 2; i < m; i++) {
    if (meta[i]! & (SEG_CURVE | SEG_CLIP) || (allowed && !allowed[i])) continue;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    if (Math.max(x0, x1) < bx0 || Math.min(x0, x1) > bx1 || Math.max(y0, y1) < by0 || Math.min(y0, y1) > by1) continue;
    if (Math.hypot(x1 - x0, y1 - y0) < minSeg) continue;
    cand.push(i);
  }
  const signed = ring.reduce((a, p, i) => { const q = ring[(i + 1) % n]!; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
  const inward = signed > 0 ? 1 : -1;
  // each edge becomes a line: a point on it and a direction (the drawn line's, when it snapped)
  const lines: { p: Pt; d: Pt; moved: number; nrm: Pt }[] = [];
  for (let e = 0; e < n; e++) {
    const a = ring[e]!, b = ring[(e + 1) % n]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / (L || 1), uy = (b[1] - a[1]) / (L || 1);
    const nx = -uy * inward, ny = ux * inward;   // unit normal pointing into the outline
    const keep = { p: a, d: [ux, uy] as Pt, moved: 0, nrm: [nx, ny] as Pt };
    if (L < minEdge) { lines.push(keep); continue; }
    // parallel strokes within reach, bucketed by offset (1 cm); each bucket remembers its longest stroke
    const buckets = new Map<number, { cov: number; best: number; bestLen: number }>();
    for (const i of cand) {
      const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
      const sl = Math.hypot(x1 - x0, y1 - y0);
      if (Math.abs(ux * (y1 - y0) - uy * (x1 - x0)) / sl > sinTol) continue;
      const d = (((x0 - a[0]) * nx + (y0 - a[1]) * ny) + ((x1 - a[0]) * nx + (y1 - a[1]) * ny)) / 2;
      if (Math.abs(d) > tolPx) continue;
      const t0 = (x0 - a[0]) * ux + (y0 - a[1]) * uy, t1 = (x1 - a[0]) * ux + (y1 - a[1]) * uy;
      const ov = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (ov <= 0) continue;
      const k = Math.round(d / (0.01 * pxPerM));
      const bk = buckets.get(k) ?? { cov: 0, best: i, bestLen: 0 };
      bk.cov += ov;
      if (sl > bk.bestLen) { bk.best = i; bk.bestLen = sl; }
      buckets.set(k, bk);
    }
    // one drawn line split over neighbouring buckets counts once
    const merged: { k: number; cov: number; best: number; bestLen: number }[] = [];
    for (const [k, bk] of [...buckets.entries()].sort((p, q) => p[0] - q[0])) {
      const last = merged[merged.length - 1];
      if (last && k - last.k <= 1) { last.cov += bk.cov; if (bk.bestLen > last.bestLen) { last.best = bk.best; last.bestLen = bk.bestLen; last.k = k; } }
      else merged.push({ k, ...bk });
    }
    const ok = merged.filter((m) => m.cov >= minCover * L);
    if (!ok.length) { lines.push(keep); continue; }
    ok.sort(prefer === "inward" ? (p, q) => q.k - p.k : (p, q) => Math.abs(p.k) - Math.abs(q.k));
    const i = ok[0]!.best;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    const sl = Math.hypot(x1 - x0, y1 - y0);
    let dx = (x1 - x0) / sl, dy = (y1 - y0) / sl;
    if (dx * ux + dy * uy < 0) { dx = -dx; dy = -dy; }
    lines.push({ p: [x0, y0], d: [dx, dy], moved: ok[0]!.k * 0.01 * pxPerM, nrm: [nx, ny] });
  }
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const A = lines[(k - 1 + n) % n]!, B = lines[k]!, v = ring[k]!;
    // the corner, shifted with its two edges: the fallback when they are (near) parallel
    const shifted: Pt = [v[0] + A.nrm[0] * A.moved + B.nrm[0] * B.moved, v[1] + A.nrm[1] * A.moved + B.nrm[1] * B.moved];
    const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(den) < Math.sin((10 * Math.PI) / 180)) { out.push(shifted); continue; }
    const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
    const x: Pt = [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t];
    out.push(Math.hypot(x[0] - v[0], x[1] - v[1]) > 3 * tolPx ? shifted : x);
  }
  return out;
}
