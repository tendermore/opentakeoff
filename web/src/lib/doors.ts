// Door openings, read off the drafter's own swings.
//
// doorseal.findDoorSeals already reads every hinged swing on a sheet as the
// chord hinge→strike (the leaf in its closed position), because the room flood
// needs the doorway closed. That chord is also exactly what three takeoffs need:
// the skirting run stops at it (wall base = perimeter − openings), the floor
// changes at it (a threshold is the chord), and one swing is one door (a count).
// What a seal does NOT need, and a count or a deduction does, is to be sure the
// curve is a DOOR: sealing a stair winder costs nothing, counting it is a wrong
// number. So this module takes the seals and keeps only swings that behave like
// a door leaf, pairs the two leaves of a double door, and merges duplicate
// copies of one swing (stroke + fill exports of the same arc).
//
// Nothing here reads layer names or text: a door is recognised by geometry that
// holds for any drafter — a leaf sweeps about a quarter turn around a hinge,
// through an empty doorway, and stops.
import { findDoorSeals } from "./doorseal.ts";
import { SEG_CURVE, SEG_CLIP } from "./oneclick.ts";
import type { Point, MaskObj } from "./oneclick.ts";

export interface Door {
  /** One hinge per leaf (image px). */
  hinges: Point[];
  /** The closed-leaf chord across the opening: hinge→strike for one leaf,
   *  hinge→hinge for a pair. Skirting stops at it; a threshold runs along it. */
  opening: [Point, Point];
  /** Opening width, image px: the leaf radius (the two radii for a pair). */
  width: number;
  leaves: 1 | 2;
  /** Midpoint of the opening chord. */
  at: Point;
}

export interface RejectedSwing {
  hinge: Point;
  strike: Point;
  r: number;
  /** over_sweep: the curve runs on round its centre (stair rail, turning
   *  circle); short_sweep: too little turn for a leaf; radial_lines: treads
   *  radiate from its centre (a winder); no_leaf: no leaf drawn at either end. */
  reason: "over_sweep" | "short_sweep" | "radial_lines" | "no_leaf";
}

// A hinged leaf is drawn sweeping a quarter turn, occasionally a little more
// (doors that open against a return wall). A curve that keeps going round the
// same centre past this is a stair rail, a turning circle or a round fixture.
const MAX_SWING_DEG = 135;
// Stair winders are drawn as a curved rail with the treads radiating from its
// centre; a door's sector between the leaf and its closed position is the
// empty doorway. Lines through the hinge count as radiating when they point
// into the sector at least this far from either end (the leaf and the closed
// position themselves are drawn along the two ends).
const RADIAL_END_MARGIN_DEG = 12;
// Two radiating lines are distinct treads when their directions differ by more
// than this (one tread drawn as a double stroke is one line).
const RADIAL_DISTINCT_DEG = 4;
// A single stray line through a hinge (a dimension, a grid line) happens; two
// or more distinct radiating lines is a winder. Treads are drawn out past the
// rail, so they are looked for out to RADIAL_REACH × r, and they converge on the
// newel, not exactly on the rail's centre — hence a looser tolerance than a
// leaf test's.
const RADIAL_MAX = 1;
const RADIAL_REACH = 2.5;
const RADIAL_TOL_FRAC = 0.12;
// ...and the least a leaf is drawn swinging: a quarter turn drawn short still
// turns well past this; a shallower curve is a window flap or a fixture.
const MIN_SWING_DEG = 60;
// At most two leaves share one hinge circle (a double-acting pair, a quarter
// turn each); curve ink further round it than this is a circle.
const MAX_CIRCLE_DEG = 210;
// Duplicate copies of one swing (stroke + fill, or a swing drawn twice) share
// hinge, radius and strike to within drafting precision: a small fraction of
// the leaf.
const DUP_FRAC = 0.08;
// Double doors: two leaves hung on opposite jambs, meeting in the middle, so
// their hinges sit r1 + r2 apart and both close onto the point between them
// (to within an astragal and drafting slack, a few % of the pair's width).
const PAIR_SPAN_FRAC = 0.08;
const PAIR_MEET_FRAC = 0.06;
// A dashed swing leaves gaps of a few degrees between dashes.
const DASH_GAP_DEG = 12;
// Two swings on nearly one centre and radius that strike different points are
// one curve drawn in pieces (a stair's semicircular rail end, a round fixture):
// no door shares its hinge circle with another leaf.
const CO_CENTRE_FRAC = 0.25;
// Curve ink round the swing circle is tallied in sectors of this size, so a
// dashed circle (a turning circle, a rotating fixture) counts all the way round
// while a quarter-turn swing fills at most MAX_SWING_DEG / SECTOR_DEG + 1.
const SECTOR_DEG = 15;
// The leaf is drawn open along the radius to the swing's open end: straight ink
// within this fraction of r of that radius (a leaf is drawn as a line or a
// thin rectangle, ~40 mm thick on a ~900 mm leaf) and parallel to it.
const LEAF_OFFSET_FRAC = 0.08;
const LEAF_ANGLE_DEG = 8;

const deg = (a: number) => (a * 180) / Math.PI;
const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Uniform grid over segment indices, for "what ink is within r of here". */
class SegGrid {
  private cells = new Map<number, number[]>();
  constructor(private segs: number[], private size: number, keep: (i: number) => boolean) {
    const n = segs.length >> 2;
    for (let i = 0; i < n; i++) {
      if (!keep(i)) continue;
      const x0 = Math.floor(Math.min(segs[i * 4], segs[i * 4 + 2]) / size), x1 = Math.floor(Math.max(segs[i * 4], segs[i * 4 + 2]) / size);
      const y0 = Math.floor(Math.min(segs[i * 4 + 1], segs[i * 4 + 3]) / size), y1 = Math.floor(Math.max(segs[i * 4 + 1], segs[i * 4 + 3]) / size);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx * 100003 + gy;
        const c = this.cells.get(k);
        if (c) c.push(i); else this.cells.set(k, [i]);
      }
    }
  }
  near(x: number, y: number, r: number): Set<number> {
    const out = new Set<number>();
    const s = this.size;
    for (let gx = Math.floor((x - r) / s); gx <= Math.floor((x + r) / s); gx++) {
      for (let gy = Math.floor((y - r) / s); gy <= Math.floor((y + r) / s); gy++) {
        for (const i of this.cells.get(gx * 100003 + gy) ?? []) out.add(i);
      }
    }
    return out;
  }
}

/** Curve ink on the circle (C, r), as 1° bins around it. */
function circleBins(segs: number[], grid: SegGrid, C: Point, r: number): Uint8Array {
  const tol = Math.max(1, 0.06 * r);
  const on = new Uint8Array(360);
  for (const i of grid.near(C[0], C[1], r + tol)) {
    const x0 = segs[i * 4] - C[0], y0 = segs[i * 4 + 1] - C[1], x1 = segs[i * 4 + 2] - C[0], y1 = segs[i * 4 + 3] - C[1];
    if (Math.abs(Math.hypot(x0, y0) - r) > tol || Math.abs(Math.hypot(x1, y1) - r) > tol) continue;
    let a0 = wrap(Math.atan2(y0, x0)), d = wrap(Math.atan2(y1, x1) - a0);
    if (d > Math.PI) { a0 = wrap(a0 + d); d = 2 * Math.PI - d; }
    const k0 = Math.floor(deg(a0)), k1 = Math.ceil(deg(a0 + d));
    for (let k = k0; k <= k1; k++) on[((k % 360) + 360) % 360] = 1;
  }
  return on;
}

/** The run of bins containing angle `a` (radians), bridging gaps of up to
 *  `gapDeg` (a dashed swing), as [start, length] in radians; null if none. */
function spanAt(on: Uint8Array, a: number, gapDeg: number): [number, number] | null {
  const k0 = Math.round(deg(wrap(a))) % 360;
  let hit = -1;
  for (let dk = 0; dk <= 6 && hit < 0; dk++) {
    if (on[(k0 + dk) % 360]) hit = (k0 + dk) % 360;
    else if (on[(k0 - dk + 360) % 360]) hit = (k0 - dk + 360) % 360;
  }
  if (hit < 0) return null;
  const step = (k: number, dir: number) => {
    for (let g = 1; g <= gapDeg + 1; g++) if (on[(k + dir * g + 360) % 360]) return (k + dir * g + 360) % 360;
    return -1;
  };
  let lo = hit, hi = hit, n = 1;
  for (let k = step(lo, -1); k >= 0 && n < 360; k = step(lo, -1)) { n += (lo - k + 360) % 360; lo = k; }
  for (let k = step(hi, 1); k >= 0 && n < 360; k = step(hi, 1)) { n += (k - hi + 360) % 360; hi = k; }
  return [(lo * Math.PI) / 180, (Math.min(n, 360) * Math.PI) / 180];
}

/** Distinct straight lines through the hinge, reaching out to `reach` × r,
 *  pointing into the sector [s0, s0 + len] at least RADIAL_END_MARGIN_DEG
 *  from both ends. */
function radialLines(segs: number[], grid: SegGrid, C: Point, r: number, s0: number, len: number, reach: number, tolFrac: number): number {
  const tol = Math.max(1.5, tolFrac * r);
  const m = (RADIAL_END_MARGIN_DEG * Math.PI) / 180;
  const dirs: number[] = [];
  for (const i of grid.near(C[0], C[1], reach * r)) {
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.25 * r) continue;
    // the line through the segment must pass through the hinge...
    const off = Math.abs((bx - ax) * (C[1] - ay) - (by - ay) * (C[0] - ax)) / L;
    if (off > tol) continue;
    // ...and the segment must lie out along the swing's radius, not across the hinge
    const da = Math.hypot(ax - C[0], ay - C[1]), db = Math.hypot(bx - C[0], by - C[1]);
    const far: Point = da > db ? [ax, ay] : [bx, by];
    if (Math.max(da, db) < 0.5 * r || Math.min(da, db) > reach * r) continue;
    const a = wrap(Math.atan2(far[1] - C[1], far[0] - C[0]));
    const t = wrap(a - s0);
    if (t < m || t > len - m) continue;
    if (!dirs.some((d) => Math.abs(deg(wrap(d - a + Math.PI) - Math.PI)) < RADIAL_DISTINCT_DEG)) dirs.push(a);
  }
  return dirs.length;
}

/** The swing's open end: the end of its run away from the strike. */
function openEnd(C: Point, r: number, strike: Point, span: [number, number]): Point {
  const aS = Math.atan2(strike[1] - C[1], strike[0] - C[0]);
  const t = wrap(aS - span[0]);
  const a = t < span[1] / 2 ? span[0] + span[1] : span[0];
  return [C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)];
}

/** Is the leaf drawn: straight ink along the radius from the hinge out to the
 *  swing's open end, covering most of it? */
function hasLeaf(segs: number[], grid: SegGrid, C: Point, r: number, E: Point): boolean {
  const ux = (E[0] - C[0]) / r, uy = (E[1] - C[1]) / r;
  const tol = Math.max(1.5, LEAF_OFFSET_FRAC * r);
  const cand = [...grid.near((C[0] + E[0]) / 2, (C[1] + E[1]) / 2, r)].filter((i) => {
    const dx = segs[i * 4 + 2] - segs[i * 4], dy = segs[i * 4 + 3] - segs[i * 4 + 1];
    const L = Math.hypot(dx, dy);
    return L > 0 && Math.abs(dx * uy - dy * ux) / L < Math.sin((LEAF_ANGLE_DEG * Math.PI) / 180);
  });
  let covered = 0;
  const T = [0.2, 0.35, 0.5, 0.65, 0.8];
  for (const t of T) {
    const px = C[0] + ux * t * r, py = C[1] + uy * t * r;
    if (cand.some((i) => segDist(segs, i, px, py) < tol)) covered++;
  }
  return covered >= T.length - 1;
}

function segDist(segs: number[], i: number, px: number, py: number): number {
  const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

interface Swing {
  hinge: Point;
  /** the end the leaf closes against */
  strike: Point;
  /** the swing's other end, where the leaf hangs open */
  far: Point;
  r: number;
  reject?: RejectedSwing["reason"];
}

/** Every distinct swing on the sheet, each judged door or not-door. */
function judgeSwings(segs: number[], meta: Uint8Array, mo: MaskObj, pxPerFt: number): Swing[] {
  const seals = findDoorSeals(segs, meta, mo, pxPerFt);
  if (!seals.length) return [];
  const maxR = Math.max(...seals.map((s) => s.r));
  const curves = new SegGrid(segs, maxR, (i) => !!(meta[i] & SEG_CURVE) && !(meta[i] & SEG_CLIP));
  const straight = new SegGrid(segs, maxR, (i) => !(meta[i] & SEG_CURVE) && !(meta[i] & SEG_CLIP));
  // one swing exported twice (stroke + fill) is one swing
  const uniq: typeof seals = [];
  for (const s of seals) {
    const dup = uniq.some((u) => Math.hypot(u.hinge[0] - s.hinge[0], u.hinge[1] - s.hinge[1]) < DUP_FRAC * s.r
      && Math.abs(u.r - s.r) < DUP_FRAC * s.r && Math.hypot(u.strike[0] - s.strike[0], u.strike[1] - s.strike[1]) < DUP_FRAC * s.r);
    if (!dup) uniq.push(s);
  }
  const base = uniq.map((s) => {
    const on = circleBins(segs, curves, s.hinge, s.r);
    return { s, on, span: spanAt(on, Math.atan2(s.strike[1] - s.hinge[1], s.strike[0] - s.hinge[0]), DASH_GAP_DEG) };
  });
  const overlap = (a: [number, number], b: [number, number]) => {
    let n = 0;
    for (let k = 0; k < 360; k += 2) {
      const t = (k * Math.PI) / 180;
      if (wrap(t - a[0]) <= a[1] && wrap(t - b[0]) <= b[1]) n += 2;
    }
    return n / Math.max(1, Math.min(deg(a[1]), deg(b[1])));
  };
  const out: Swing[] = [];
  for (const [i, { s, on, span }] of base.entries()) {
    let coCentred = false, twin = false;
    for (const [j, y] of base.entries()) {
      if (j === i) continue;
      if (Math.hypot(y.s.hinge[0] - s.hinge[0], y.s.hinge[1] - s.hinge[1]) >= CO_CENTRE_FRAC * s.r || Math.abs(y.s.r - s.r) >= CO_CENTRE_FRAC * s.r) continue;
      // the same swing drawn twice a hair apart (a double pen line) is kept once;
      // a second swing round the same centre, elsewhere on the circle, is one
      // curve drawn in pieces
      if (span && y.span && overlap(span, y.span) >= 0.5) { if (j < i) twin = true; } else coCentred = true;
    }
    if (twin) continue;
    const sw: Swing = { hinge: s.hinge, strike: s.strike, far: s.strike, r: s.r };
    out.push(sw);
    let sectors = 0;
    for (let k = 0; k < 360; k += SECTOR_DEG) if (on.subarray(k, k + SECTOR_DEG).some((v) => v)) sectors++;
    if (!span || coCentred || deg(span[1]) > MAX_SWING_DEG || sectors * SECTOR_DEG > MAX_CIRCLE_DEG) { sw.reject = "over_sweep"; continue; }
    if (deg(span[1]) < MIN_SWING_DEG) { sw.reject = "short_sweep"; continue; }
    if (radialLines(segs, straight, s.hinge, s.r, span[0], span[1], RADIAL_REACH, RADIAL_TOL_FRAC) > RADIAL_MAX) { sw.reject = "radial_lines"; continue; }
    // the leaf hangs open at one end of the swing; the other end is where it closes
    const far = openEnd(s.hinge, s.r, s.strike, span);
    sw.far = far;
    if (!hasLeaf(segs, straight, s.hinge, s.r, far)) {
      if (!hasLeaf(segs, straight, s.hinge, s.r, s.strike)) { sw.reject = "no_leaf"; continue; }
      // the seal read the leaf's end as the strike: the swing closes at the other end
      sw.strike = far; sw.far = s.strike;
    }
  }
  return out;
}

/** Every hinged door on a sheet, from its drawn swing. `segs`/`meta`/`mo` are
 *  the sheet's vector geometry and ink mask in image px (the inputs
 *  findDoorSeals takes); `pxPerFt` is the sheet scale. Swings that do not
 *  behave like a door leaf come back in `rejected` with the reason. */
export function findDoors(segs: number[], meta: Uint8Array, mo: MaskObj, pxPerFt: number): { doors: Door[]; rejected: RejectedSwing[] } {
  const swings = judgeSwings(segs, meta, mo, pxPerFt);
  const rejected: RejectedSwing[] = swings.filter((s) => s.reject).map((s) => ({ hinge: s.hinge, strike: s.strike, r: s.r, reason: s.reject! }));
  const leaves = swings.filter((s) => !s.reject);
  const used = new Set<number>();
  const doors: Door[] = [];
  const mid = (p: Point, q: Point): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let i = 0; i < leaves.length; i++) {
    if (used.has(i)) continue;
    const a = leaves[i];
    let pair = -1;
    for (let j = i + 1; j < leaves.length && pair < 0; j++) {
      if (used.has(j)) continue;
      const b = leaves[j], sum = a.r + b.r;
      const span = Math.hypot(a.hinge[0] - b.hinge[0], a.hinge[1] - b.hinge[1]);
      if (Math.abs(span - sum) > PAIR_SPAN_FRAC * sum) continue;
      // both leaves close onto the one point between the hinges where they meet
      const t = a.r / sum;
      const M: Point = [a.hinge[0] + (b.hinge[0] - a.hinge[0]) * t, a.hinge[1] + (b.hinge[1] - a.hinge[1]) * t];
      const endAt = (l: Swing) => [l.strike, l.far].find((e) => Math.hypot(e[0] - M[0], e[1] - M[1]) <= PAIR_MEET_FRAC * sum);
      const ea = endAt(a), eb = endAt(b);
      if (ea && eb) { a.strike = ea; b.strike = eb; pair = j; }
    }
    used.add(i);
    if (pair >= 0) {
      used.add(pair);
      const b = leaves[pair];
      doors.push({ hinges: [a.hinge, b.hinge], opening: [a.hinge, b.hinge], width: a.r + b.r, leaves: 2, at: mid(a.hinge, b.hinge) });
    } else {
      doors.push({ hinges: [a.hinge], opening: [a.hinge, a.strike], width: a.r, leaves: 1, at: mid(a.hinge, a.strike) });
    }
  }
  return { doors, rejected };
}

// A door opening belongs to a room when its closed-leaf chord runs along the
// room's ring. The ring sits on the room's wall faces and crosses a doorway on
// the wall line, so the chord is parallel to one of its edges and no further
// from it than the wall is thick — on either face of the wall, since the leaf
// may be drawn at either. The thickest walls doors are hung in are ~350 mm
// insulated exterior walls, hence 0.40 m.
export const OPENING_WALL_M = 0.4;
// Parallel to a ring edge within drafting slack; a door in a wall meeting the
// ring at a corner is perpendicular to it.
const OPENING_PARALLEL_DEG = 15;
// Alongside the ring for at least half its width: a door beside the room, in
// the same wall line but opening elsewhere, overlaps it by less.
const OPENING_ALONG_FRAC = 0.5;

/** Does `door`'s opening run along `ring` (image px), within `wallPx`? */
export function doorOnRing(door: Door, ring: Point[], wallPx: number): boolean {
  const [a, b] = door.opening;
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const cosTol = Math.cos((OPENING_PARALLEL_DEG * Math.PI) / 180);
  const edges: [Point, Point][] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!L) continue;
    // |cos| of the angle between the edge and the chord, direction-free
    if (Math.abs(((q[0] - p[0]) * Math.cos(ang) + (q[1] - p[1]) * Math.sin(ang)) / L) >= cosTol) edges.push([p, q]);
  }
  if (!edges.length) return false;
  const N = 10;
  let along = 0;
  for (let k = 0; k <= N; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / N, y = a[1] + ((b[1] - a[1]) * k) / N;
    if (edges.some(([p, q]) => ptSegDist(x, y, p, q) <= wallPx)) along++;
  }
  return along / (N + 1) >= OPENING_ALONG_FRAC;
}

function ptSegDist(x: number, y: number, p: Point, q: Point): number {
  const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / L2)) : 0;
  return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy);
}
