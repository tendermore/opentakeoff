// Does a room outline follow the drawn walls? The check for a floor outline with
// no printed room area to compare against (US sheets; European sheets without
// area stamps), ported from Datum's path coverage check (datum `path`).
//
// A room is bounded by wall faces. An outline that is a room's own outline runs
// along a wall face for nearly all its length, leaving it only where the wall
// has an opening — a door, a cased opening, a passage — and encloses no wall of
// its own. An outline that stopped at furniture runs along furniture lines; one
// that leaked through an opening into the next room holds the wall between them.
// Nothing here reads text, layers or project conventions: only where the wall
// faces are (wallpairs.ts: paired lines at wall thickness, plus filled poché).
import { SEG_CURVE, SEG_CLIP } from "./oneclick.ts";

type Pt = [number, number];
/** What the check needs of a door (doors.ts Door): its closed-leaf chord. */
export interface DoorReach { opening: [Pt, Pt] }

// Datum's constants, in the same unit: image px at RENDER_SCALE 2 is 1/144 in,
// Datum's sheet px.
/** An edge is sampled this often (px). */
const STEP_PX = 2;
/** A sample lies along a wall face within one printed point (px): line weight
 * and the drafter's slack between collinear pieces of one face. */
const ALONG_PX = 2;
/** ...and parallel to it within this angle: drafting slack, not a turn. */
const PARALLEL_DEG = 4;
/** An edge must run along wall faces for this share of its length. */
export const COVERED = 0.8;
/** A gap in the wall line with wall on both sides, up to this long, is an
 * opening (a double door is 1.8 m); longer is empty paper. */
export const OPENING_MAX_M = 2.0;
/** Edges shorter than the thickest wall carry no evidence either way: they are
 * the jambs and returns an outline turns through at a doorway or a niche. */
export const SHORT_EDGE_M = 0.4;
/** A wall inside the outline: a paired wall face reaching further than a wall
 * thickness inside it, for at least the shortest wall face wallpairs keeps
 * (0.8 m). A room holds no wall; two rooms measured as one hold the wall
 * between them. */
export const INSIDE_WALL_M = 0.8;
const INSIDE_DEPTH_M = 0.4;
/** A door chord runs along the edge it opens: parallel within drafting slack (doors.ts). */
const OPENING_PARALLEL_DEG = 15;
/** A wall inside is sampled at a tenth of a metre: far finer than the 0.8 m that decides. */
const INSIDE_STEP_M = 0.1;

export interface WallCheck {
  pass: boolean;
  /** Share of the judged outline length along wall faces or across an opening. */
  coverage: number;
  /** Per judged edge: its length (m) and share along walls; the weakest first. */
  weakest?: { edge: number; length_m: number; coverage: number };
  /** Length (m) of wall face lying inside the outline, deeper than a wall. */
  inside_wall_m: number;
  reason?: "off_walls" | "wall_inside";
}

/** `faces`: per segment, 1 = a wall face the outline may run along; `pairs`:
 * per segment, 1 = a paired wall line (the inside-wall test ignores filled
 * poché, which draws columns inside rooms). `doors`: the sheet's hinged doors
 * (doors.ts). At a door the room's boundary is the opening: an edge may cross
 * it along the door's closed-leaf chord (within a wall's thickness of it),
 * even where the opening meets a corner and has wall on one side only. A trace
 * that runs round the swing instead is not excused — it is crossing floor. */
export function checkOnWalls(ring: Pt[], segs: ArrayLike<number>, meta: ArrayLike<number>, faces: ArrayLike<number>, pairs: ArrayLike<number>,
  pxPerM: number, doors: DoorReach[] = [], ids: ArrayLike<number> | null = null): WallCheck {
  const n = ring.length;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const pad = INSIDE_DEPTH_M * pxPerM + ALONG_PX;
  const bx0 = Math.min(...xs) - pad, bx1 = Math.max(...xs) + pad, by0 = Math.min(...ys) - pad, by1 = Math.max(...ys) + pad;
  const near: number[] = [];
  for (const i of candidates(segs, ids)) {
    if (!faces[i] && !pairs[i]) continue;
    if (meta[i]! & (SEG_CURVE | SEG_CLIP)) continue;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    if (Math.max(x0, x1) < bx0 || Math.min(x0, x1) > bx1 || Math.max(y0, y1) < by0 || Math.min(y0, y1) > by1) continue;
    near.push(i);
  }
  const sinTol = Math.sin((PARALLEL_DEG * Math.PI) / 180);
  // the faces parallel to one edge and within reach of it, found once per edge
  const facesAlong = (a: Pt, b: Pt, ux: number, uy: number): number[] => near.filter((i) => {
    if (!faces[i]) return false;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!, L = Math.hypot(x1 - x0, y1 - y0);
    if (!L || Math.abs(ux * (y1 - y0) - uy * (x1 - x0)) / L > sinTol) return false;
    if (Math.max(x0, x1) < Math.min(a[0], b[0]) - ALONG_PX || Math.min(x0, x1) > Math.max(a[0], b[0]) + ALONG_PX) return false;
    if (Math.max(y0, y1) < Math.min(a[1], b[1]) - ALONG_PX || Math.min(y0, y1) > Math.max(a[1], b[1]) + ALONG_PX) return false;
    return Math.abs((x0 - a[0]) * -uy + (y0 - a[1]) * ux) <= ALONG_PX + L * sinTol;
  });
  const wallPx = SHORT_EDGE_M * pxPerM;
  const cosDoor = Math.cos((OPENING_PARALLEL_DEG * Math.PI) / 180);
  const onOpening = (x: number, y: number, ux: number, uy: number): boolean => doors.some(({ opening: [a, b] }) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!L || Math.abs((ux * (b[0] - a[0]) + uy * (b[1] - a[1])) / L) < cosDoor) return false;
    return ptSegDist(x, y, a[0], a[1], b[0], b[1]) <= wallPx;
  });

  let judged = 0, covered = 0;
  let weakest: WallCheck["weakest"];
  for (let e = 0; e < n; e++) {
    const a = ring[e]!, b = ring[(e + 1) % n]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < wallPx) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const k = Math.max(2, Math.round(L / STEP_PX));
    const along = facesAlong(a, b, ux, uy);
    const hit: boolean[] = [];
    for (let j = 0; j <= k; j++) {
      const x = a[0] + (b[0] - a[0]) * (j / k), y = a[1] + (b[1] - a[1]) * (j / k);
      hit.push(along.some((i) => ptSegDist(x, y, segs[4 * i]!, segs[4 * i + 1]!, segs[4 * i + 2]!, segs[4 * i + 3]!) <= ALONG_PX));
    }
    // gaps: an opening between wall on both sides, or across a drawn door
    const step = L / k;
    for (let i = 0; i <= k;) {
      if (hit[i]) { i++; continue; }
      let j = i;
      while (j <= k && !hit[j]) j++;
      const bounded = i > 0 && j <= k && (j - i) * step <= OPENING_MAX_M * pxPerM;
      for (let q = i; q < j; q++) {
        if (bounded) hit[q] = true;
        else {
          const x = a[0] + (b[0] - a[0]) * (q / k), y = a[1] + (b[1] - a[1]) * (q / k);
          if (onOpening(x, y, ux, uy)) hit[q] = true;
        }
      }
      i = j;
    }
    const share = hit.filter(Boolean).length / (k + 1);
    judged += L; covered += share * L;
    if (!weakest || share < weakest.coverage) weakest = { edge: e, length_m: round2(L / pxPerM), coverage: round2(share) };
  }

  // wall inside: paired faces sampled along their length, counted where they
  // lie inside the outline and deeper than a wall from its edges
  // (sampled every INSIDE_STEP_M; counting stops once it is a wall)
  const depth = INSIDE_DEPTH_M * pxPerM, stepPx = Math.max(STEP_PX, INSIDE_STEP_M * pxPerM), enough = INSIDE_WALL_M * pxPerM;
  const ix0 = Math.min(...xs) + depth, ix1 = Math.max(...xs) - depth, iy0 = Math.min(...ys) + depth, iy1 = Math.max(...ys) - depth;
  let insidePx = 0;
  for (const i of near) {
    if (!pairs[i] || insidePx >= enough) continue;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    if (Math.max(x0, x1) < ix0 || Math.min(x0, x1) > ix1 || Math.max(y0, y1) < iy0 || Math.min(y0, y1) > iy1) continue;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(1, Math.round(L / stepPx));
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (x < ix0 || x > ix1 || y < iy0 || y > iy1) continue;
      if (inPoly(x, y, ring) && distToRingPx(x, y, ring) > depth) insidePx += L / k;
    }
  }
  const inside_wall_m = round2(insidePx / pxPerM);
  const coverage = judged ? round2(covered / judged) : 0;
  const offWalls = !judged || (weakest != null && weakest.coverage < COVERED);
  const reason = inside_wall_m >= INSIDE_WALL_M ? "wall_inside" as const : offWalls ? "off_walls" as const : undefined;
  return { pass: !reason, coverage, ...(weakest ? { weakest } : {}), inside_wall_m, ...(reason ? { reason } : {}) };
}

/** The outline measured to the wall line across its openings. A flood through
 * a doorway runs into the opening up to the door leaf (or the far face of the
 * wall) and back: a notch no deeper than a wall (INSIDE_DEPTH_M) and no wider
 * than an opening (OPENING_MAX_M) whose ends sit on one straight wall line.
 * That notch is the wall's own thickness, not the room's floor (a room is
 * measured to the inside face of its walls), so it is cut off along the line.
 * Only notches that stick out of the room are cut; one reaching in (a column,
 * a shaft) is the room's real boundary. */
export function closeOpenings(ring: Pt[], pxPerM: number): Pt[] {
  let r = dropSpikes(ring);
  const depth = INSIDE_DEPTH_M * pxPerM, width = OPENING_MAX_M * pxPerM;
  const sinTol = Math.sin((PARALLEL_DEG * Math.PI) / 180);
  const signed = (q: Pt[]) => q.reduce((acc, p, i) => { const o = q[(i + 1) % q.length]!; return acc + p[0] * o[1] - o[0] * p[1]; }, 0) / 2;
  for (let changed = true; changed && r.length > 4;) {
    changed = false;
    const n = r.length, orient = Math.sign(signed(r));
    for (let i = 0; i < n && !changed; i++) {
      for (let k = 2; k <= 4 && k < n - 1 && !changed; k++) {
        const a = r[i]!, b = r[(i + k) % n]!, prev = r[(i - 1 + n) % n]!;
        const cx = b[0] - a[0], cy = b[1] - a[1], C = Math.hypot(cx, cy);
        if (!C || C > width) continue;
        // the chord continues the wall line the outline arrived along
        const px = a[0] - prev[0], py = a[1] - prev[1], P = Math.hypot(px, py);
        if (!P || Math.abs(px * cy - py * cx) / (P * C) > sinTol || px * cx + py * cy < 0) continue;
        const mid: Pt[] = [];
        for (let j = 1; j < k; j++) mid.push(r[(i + j) % n]!);
        // every notch vertex within a wall's depth of the line, all on the outside
        const off = mid.map(([x, y]) => ((x - a[0]) * cy - (y - a[1]) * cx) / C);
        if (off.some((d) => Math.abs(d) > depth) || !off.some((d) => Math.abs(d) > ALONG_PX)) continue;
        const notch = signed([a, ...mid, b]);
        if (Math.sign(notch) !== orient) continue;   // reaches into the room: keep
        const keep = new Set(Array.from({ length: k - 1 }, (_, j) => (i + 1 + j) % n));
        r = r.filter((_, idx) => !keep.has(idx));
        changed = true;
      }
    }
  }
  return r;
}

/** Without zero-width spikes (out along a line and straight back: a trace
 * running into a hairline) and repeated vertices — no floor, only perimeter. */
function dropSpikes(ring: Pt[]): Pt[] {
  const r = ring.slice();
  for (let i = 0; r.length > 3 && i < r.length;) {
    const p = r[(i - 1 + r.length) % r.length]!, v = r[i]!, q = r[(i + 1) % r.length]!;
    if (Math.hypot(v[0] - p[0], v[1] - p[1]) <= ALONG_PX / 2 || Math.hypot(q[0] - p[0], q[1] - p[1]) <= ALONG_PX) {
      r.splice(i, 1);
      i = Math.max(0, i - 1);
    } else i++;
  }
  return r;
}

/** A wall lining or finish drawn as its own line inside the wall face (a
 * furring, a tiled pre-wall) is at most this thick; a room is measured to its
 * inside finished face, the innermost of them. */
export const LINING_MAX_M = 0.1;

/** Each edge moved in onto the innermost wall face that runs along it within a
 * lining's thickness (LINING_MAX_M) — the inside finished face — and the
 * corners rebuilt where the moved edges meet. An edge with no such face stays. */
export function toInsideFace(ring: Pt[], segs: ArrayLike<number>, meta: ArrayLike<number>, faces: ArrayLike<number>, pxPerM: number,
  ids: ArrayLike<number> | null = null): Pt[] {
  const n = ring.length;
  if (n < 3) return ring;
  const reach = LINING_MAX_M * pxPerM, minEdge = SHORT_EDGE_M * pxPerM;
  const sinTol = Math.sin((PARALLEL_DEG * Math.PI) / 180);
  const area = ring.reduce((acc, p, i) => { const q = ring[(i + 1) % n]!; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
  const inward = area > 0 ? 1 : -1;
  const shift: number[] = [];
  const nrm: Pt[] = [];
  let moved = false;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bx0 = Math.min(...xs) - reach, bx1 = Math.max(...xs) + reach, by0 = Math.min(...ys) - reach, by1 = Math.max(...ys) + reach;
  const near: number[] = [];
  for (const i of candidates(segs, ids)) {
    if (!faces[i] || meta[i]! & (SEG_CURVE | SEG_CLIP)) continue;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    if (Math.max(x0, x1) < bx0 || Math.min(x0, x1) > bx1 || Math.max(y0, y1) < by0 || Math.min(y0, y1) > by1) continue;
    near.push(i);
  }
  for (let e = 0; e < n; e++) {
    const a = ring[e]!, b = ring[(e + 1) % n]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / (L || 1), uy = (b[1] - a[1]) / (L || 1);
    const nx = -uy * inward, ny = ux * inward;
    nrm.push([nx, ny]);
    shift.push(0);
    if (L < minEdge) continue;
    const runs: { d: number; t0: number; t1: number }[] = [];   // parallel faces inside the edge, by inward offset (px)
    for (const i of near) {
      const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
      const sl = Math.hypot(x1 - x0, y1 - y0);
      if (!sl || Math.abs(ux * (y1 - y0) - uy * (x1 - x0)) / sl > sinTol) continue;
      const d = (((x0 - a[0]) * nx + (y0 - a[1]) * ny) + ((x1 - a[0]) * nx + (y1 - a[1]) * ny)) / 2;
      if (d <= ALONG_PX || d > reach) continue;
      const t0 = (x0 - a[0]) * ux + (y0 - a[1]) * uy, t1 = (x1 - a[0]) * ux + (y1 - a[1]) * uy;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
      if (hi > lo) runs.push({ d, t0: lo, t1: hi });
    }
    let best = 0;
    for (const r of runs) {
      if (r.d <= best) continue;
      // one drawn line: the runs within a line's width of this offset, their union along the edge
      const along = runs.filter((q) => Math.abs(q.d - r.d) <= ALONG_PX / 2).sort((p, q) => p.t0 - q.t0);
      let covered = 0, end = 0;
      for (const q of along) { if (q.t1 > end) { covered += q.t1 - Math.max(q.t0, end); end = q.t1; } }
      if (covered >= COVERED * L) best = r.d;
    }
    if (best) { shift[e] = best; moved = true; }
  }
  if (!moved) return ring;
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const pe = (k - 1 + n) % n, v = ring[k]!, A = ring[pe]!, B = ring[(k + 1) % n]!;
    // the two edges meeting at v, each moved along its own normal
    const p1: Pt = [A[0] + nrm[pe]![0] * shift[pe]!, A[1] + nrm[pe]![1] * shift[pe]!], d1: Pt = [v[0] - A[0], v[1] - A[1]];
    const p2: Pt = [v[0] + nrm[k]![0] * shift[k]!, v[1] + nrm[k]![1] * shift[k]!], d2: Pt = [B[0] - v[0], B[1] - v[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
    if (!l1 || !l2 || Math.abs(den) / (l1 * l2) < Math.sin((10 * Math.PI) / 180)) {
      out.push([v[0] + nrm[pe]![0] * shift[pe]! + nrm[k]![0] * shift[k]!, v[1] + nrm[pe]![1] * shift[pe]! + nrm[k]![1] * shift[k]!]);
      continue;
    }
    const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
    out.push([p1[0] + d1[0] * t, p1[1] + d1[1] * t]);
  }
  return out;
}

/** Does the sheet draw walls the check can read? (Any wall face at all.) */
export const hasWallFaces = (faces: ArrayLike<number>): boolean => Array.prototype.some.call(faces, (f: number) => f === 1);

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The segment indices to look at: `ids` (the sheet's wall segments, listed
 * once) or every segment. */
function* candidates(segs: ArrayLike<number>, ids: ArrayLike<number> | null): Iterable<number> {
  if (ids) for (let k = 0; k < ids.length; k++) yield ids[k]!;
  else for (let i = 0, m = segs.length >> 2; i < m; i++) yield i;
}

function ptSegDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2)) : 0;
  return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
}

function inPoly(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRingPx(x: number, y: number, ring: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    d = Math.min(d, ptSegDist(x, y, a[0], a[1], b[0], b[1]));
  }
  return d;
}
