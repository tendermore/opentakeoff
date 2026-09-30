// Skirting (wall base, "gulvlist") along one room's ring, read off the drawn walls.
//
// A skirting board runs along the room's wall faces and stops where there is no
// wall to fix it to: at a door, at an opening with no door, and along an open
// side where the room runs on into the next space with nothing drawn between.
// It keeps going under a window (the sill is above it) and past the short
// breaks where another wall abuts.
//
// So the ring is walked in small steps and every step is judged by what lies
// along it: a wall face (wallpairs.ts faces, the drawn-walls check's own), a
// door's opening (doors.ts, the closed-leaf chord), or nothing. A stretch with no
// face is then judged as a whole: a junction break (too short to be an opening),
// a window (glazing lines along it inside the wall), an opening (bounded by wall
// on both sides, nothing or one line across), an open side (nothing drawn at
// all), or — when a wall face runs alongside but off the ring, or the ring
// follows a drawn line that is not a wall — a ring that does not follow the walls
// here, which is flagged and never measured.
//
// Nothing here reads text, layers or project conventions. Pure module: image px
// in, image px and metres out; the caller converts units.
import { SEG_CURVE, SEG_CLIP } from "./oneclick.ts";

type Pt = [number, number];
/** What skirting needs of a door (doors.ts Door). */
export interface SkirtingDoor { opening: [Pt, Pt]; width: number; leaves: 1 | 2; at: Pt }

/** A step along the ring (px). */
const STEP_PX = 2;
/** A step lies along a wall face within this (m): a line's width and the slack
 *  a traced or snapped ring keeps from the face it follows. */
export const ON_FACE_M = 0.03;
/** ...parallel within drafting slack (wallcheck.ts). */
const PARALLEL_DEG = 4;
/** A wall face alongside the ring further off than ON_FACE_M but within a wall's
 *  thickness is a ring off the wall (drawn on the centreline, the outer face or
 *  inside a lining), not an open side. */
export const OFF_FACE_M = 0.4;
/** A break shorter than this is a junction (an abutting wall, a column face, a
 *  frame): the skirting runs on (walltakeoff.ts MIN_OPENING_M). */
export const MIN_OPENING_M = 0.4;
/** ...and an opening with no door narrower than this is not a way through
 *  (the narrowest doors are 0.6 m): a wall end, a pilaster or a column face. */
export const MIN_PASSAGE_M = 0.6;
/** A door's opening runs along the ring within this (doors.ts OPENING_PARALLEL_DEG). */
const DOOR_PARALLEL_DEG = 15;
/** An opening between wall on both sides is at most this wide; wider with
 *  nothing drawn is an open side (wallcheck.ts OPENING_MAX_M). */
export const OPENING_MAX_M = 2.0;
/** Glazing sits inside the wall band: lines along the break, offset from the
 *  ring towards the wall's far face by more than a line and at most a wall. */
const GLAZING_COVER = 0.6;
/** An open side has nothing drawn alongside it. Ink running along the ring
 *  within a wall's reach (OFF_FACE_M) where there is no wall face — a wall
 *  drawn in a style the face reader does not pair (thin lines at a small
 *  scale, one line, a curve), a glass wall, casework — means the ring is on
 *  something, so the stretch is flagged, not deducted, once it covers this
 *  share of it. */
const LINE_SHARE = 0.5;

export type SkirtingGapKind = "door" | "opening" | "open_side";
export interface SkirtingDeduction {
  kind: SkirtingGapKind;
  /** Along the ring, image px: where the deduction starts and ends. */
  from: Pt;
  to: Pt;
  length_m: number;
  /** door: the leaf width (a pair's two leaves), leaves and where the door is. */
  door?: { at: Pt; width_m: number; leaves: 1 | 2 };
}
export interface SkirtingFlag {
  reason: "off_walls" | "unread_edge";
  at: Pt;
  length_m: number;
}
export interface SkirtingKept { kind: "window" | "junction"; at: Pt; length_m: number }
export interface SkirtingResult {
  /** The ring's whole length (m), as traced. */
  gross_m: number;
  /** Length of the spikes dropped from the trace before it was read (m). */
  spikes_m: number;
  /** gross − spikes − deductions (m): the length of `runs`. */
  net_m: number;
  /** Share of the ring along a wall face. */
  on_walls: number;
  deductions: SkirtingDeduction[];
  /** Breaks the skirting runs through, reported so a reviewer sees them. */
  kept: SkirtingKept[];
  /** Stretches where the ring does not follow the walls: the room is not measured. */
  flags: SkirtingFlag[];
  /** The installed runs, image px: the ring with the deductions cut out
   *  (one closed polyline when nothing is deducted). */
  runs: Pt[][];
}

interface Edge { a: Pt; b: Pt; L: number; ux: number; uy: number; s0: number }
interface Sample { s: number; e: number; t: number; w: number; on: boolean; near: boolean; line: boolean }

/** A ring vertex where the trace turns back on itself by more than this is the
 *  tip of a spike: out along a line and straight back, enclosing no floor. */
const SPIKE_TURN_DEG = 170;

/** The ring without a repeated closing vertex, zero-length edges or spikes (a
 *  flood that ran into a door swing or a fixture and back: length, no floor, no
 *  wall to fix a board to). */
function cleanRing(ring: Pt[]): Pt[] {
  const r: Pt[] = [];
  for (const p of ring) {
    const q = r[r.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) r.push([p[0], p[1]]);
  }
  while (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) <= 1e-6) r.pop();
  const cosTip = Math.cos((SPIKE_TURN_DEG * Math.PI) / 180);
  for (let i = 0; r.length > 3 && i < r.length;) {
    const p = r[(i - 1 + r.length) % r.length], v = r[i], q = r[(i + 1) % r.length];
    const ax = v[0] - p[0], ay = v[1] - p[1], bx = q[0] - v[0], by = q[1] - v[1], A = Math.hypot(ax, ay), B = Math.hypot(bx, by);
    if (!A || !B || (ax * bx + ay * by) / (A * B) <= cosTip) { r.splice(i, 1); i = Math.max(0, i - 1); } else i++;
  }
  return r;
}

function ptSegDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2)) : 0;
  return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
}

/** Skirting along `ring` (image px). `faces`: per segment, 1 = a wall face (the
 *  drawn-walls check's faces); `doors`: the sheet's doors; `onRing(door)`: does
 *  the door open on this ring (doors.ts doorOnRing). */
export function skirtingOfRing(ringIn: Pt[], segs: ArrayLike<number>, meta: ArrayLike<number>, faces: ArrayLike<number>,
  pxPerM: number, doors: SkirtingDoor[], onRing: (d: SkirtingDoor) => boolean): SkirtingResult {
  const ring = cleanRing(ringIn);
  const n = ring.length;
  const perim = (r: Pt[]) => r.reduce((acc, p, i) => { const q = r[(i + 1) % r.length]; return acc + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);
  const traced = perim(ringIn);
  const edges: Edge[] = [];
  let P = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edges.push({ a, b, L, ux: L ? (b[0] - a[0]) / L : 0, uy: L ? (b[1] - a[1]) / L : 0, s0: P });
    P += L;
  }
  const m = (px: number) => px / pxPerM;
  const spikes = Math.max(0, traced - P);
  const empty: SkirtingResult = { gross_m: m(traced), spikes_m: m(spikes), net_m: m(P), on_walls: 0, deductions: [], kept: [], flags: [], runs: [[...ring, ring[0]]] };
  if (n < 3 || !P) return empty;
  // the ring's outward normal: the wall is on this side of a ring on its inside face
  const area2 = ring.reduce((acc, p, i) => { const q = ring[(i + 1) % n]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
  const outSign = area2 > 0 ? -1 : 1;   // image y down: a positive shoelace sum runs clockwise on screen
  const at = (s: number): Pt => {
    const u = ((s % P) + P) % P;
    let e = edges.length - 1;
    for (let k = 0; k < edges.length; k++) if (u < edges[k].s0 + edges[k].L) { e = k; break; }
    const E = edges[e], t = E.L ? (u - E.s0) / E.L : 0;
    return [E.a[0] + (E.b[0] - E.a[0]) * t, E.a[1] + (E.b[1] - E.a[1]) * t];
  };

  // straight ink near the ring, once
  const reach = OFF_FACE_M * pxPerM + 2;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bx0 = Math.min(...xs) - reach, bx1 = Math.max(...xs) + reach, by0 = Math.min(...ys) - reach, by1 = Math.max(...ys) + reach;
  const near: number[] = [];
  for (let i = 0, k = segs.length >> 2; i < k; i++) {
    if (meta[i]! & SEG_CLIP) continue;
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    if (Math.max(x0, x1) < bx0 || Math.min(x0, x1) > bx1 || Math.max(y0, y1) < by0 || Math.min(y0, y1) > by1) continue;
    near.push(i);
  }
  const sinTol = Math.sin((PARALLEL_DEG * Math.PI) / 180);
  const onTol = Math.max(2, ON_FACE_M * pxPerM), offTol = OFF_FACE_M * pxPerM;

  // judge every step
  const samples: Sample[] = [];
  const along: number[][] = [];
  for (const [e, E] of edges.entries()) {
    // parallel straight ink alongside this edge, within a wall's reach of it
    const par: { i: number; face: boolean; x0: number; y0: number; x1: number; y1: number }[] = [];
    const curves: [number, number, number, number][] = [];
    for (const i of near) {
      const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!, L = Math.hypot(x1 - x0, y1 - y0);
      // curve ink (a curved wall, tessellated) is never a face but is drawn: it only says "something is here"
      if (meta[i]! & SEG_CURVE) { if (L && ptSegDist((x0 + x1) / 2, (y0 + y1) / 2, E.a[0], E.a[1], E.b[0], E.b[1]) <= reach) curves.push([x0, y0, x1, y1]); continue; }
      if (!L || Math.abs(E.ux * (y1 - y0) - E.uy * (x1 - x0)) / L > sinTol) continue;
      const d0 = (x0 - E.a[0]) * -E.uy + (y0 - E.a[1]) * E.ux, d1 = (x1 - E.a[0]) * -E.uy + (y1 - E.a[1]) * E.ux;
      if (Math.min(Math.abs(d0), Math.abs(d1)) > reach) continue;
      const t0 = (x0 - E.a[0]) * E.ux + (y0 - E.a[1]) * E.uy, t1 = (x1 - E.a[0]) * E.ux + (y1 - E.a[1]) * E.uy;
      if (Math.max(t0, t1) < -reach || Math.min(t0, t1) > E.L + reach) continue;
      par.push({ i, face: !!faces[i], x0, y0, x1, y1 });
    }
    along.push(par.map((p) => p.i));
    const k = Math.max(1, Math.ceil(E.L / STEP_PX));
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k, x = E.a[0] + (E.b[0] - E.a[0]) * t, y = E.a[1] + (E.b[1] - E.a[1]) * t;
      let on = false, nearFace = false, line = false;
      for (const p of par) {
        // only ink whose foot falls on the segment: a wall ending at a jamb is not alongside the opening
        const dx = p.x1 - p.x0, dy = p.y1 - p.y0, L2 = dx * dx + dy * dy;
        const u = ((x - p.x0) * dx + (y - p.y0) * dy) / L2;
        if (u < 0 || u > 1) continue;
        const d = ptSegDist(x, y, p.x0, p.y0, p.x1, p.y1);
        if (p.face && d <= onTol) { on = true; break; }
        if (p.face && d <= offTol) nearFace = true;
        if (d <= offTol) line = true;
      }
      if (!on && !line) line = curves.some(([x0, y0, x1, y1]) => ptSegDist(x, y, x0, y0, x1, y1) <= offTol);
      samples.push({ s: E.s0 + t * E.L, e, t, w: E.L / k, on, near: nearFace, line });
    }
  }

  // doors on this ring: the leaf width, centred where the opening meets the ring
  const cuts: { s0: number; s1: number; d: SkirtingDeduction }[] = [];
  // onto the nearest edge the opening runs along (doorOnRing's parallel test), not a chamfer beside it
  const cosDoor = Math.cos((DOOR_PARALLEL_DEG * Math.PI) / 180);
  const project = (p: Pt, dir: Pt): number => {
    let best = Infinity, sBest = 0;
    for (const E of edges) {
      if (!E.L || Math.abs(E.ux * dir[0] + E.uy * dir[1]) < cosDoor) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - E.a[0]) * E.ux + (p[1] - E.a[1]) * E.uy) / E.L));
      const d = Math.hypot(p[0] - (E.a[0] + E.ux * t * E.L), p[1] - (E.a[1] + E.uy * t * E.L));
      if (d < best) { best = d; sBest = E.s0 + t * E.L; }
    }
    return sBest;
  };
  for (const d of doors) {
    if (!onRing(d)) continue;
    const [p, q] = d.opening, L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const c = project([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], [(q[0] - p[0]) / L, (q[1] - p[1]) / L]);
    const s0 = c - d.width / 2, s1 = c + d.width / 2;
    cuts.push({ s0, s1, d: { kind: "door", from: at(s0), to: at(s1), length_m: m(d.width), door: { at: d.at, width_m: m(d.width), leaves: d.leaves } } });
  }
  const inCut = (s: number) => cuts.some((c) => {
    const u = ((s - c.s0) % P + P) % P;
    return u <= c.s1 - c.s0;
  });

  // stretches with no wall face, outside the doors (cyclic)
  const N = samples.length;
  const bad = samples.map((q) => !q.on && !inCut(q.s));
  const kept: SkirtingKept[] = [], flags: SkirtingFlag[] = [];
  if (bad.every(Boolean) && !cuts.length) {
    // nothing along the ring is a wall: no measurement to make
    flags.push({ reason: samples.some((q) => q.near) ? "off_walls" : "unread_edge", at: ring[0], length_m: m(P) });
  } else if (bad.some(Boolean)) {
    let start = bad.findIndex((b, i) => b && !bad[(i - 1 + N) % N]);
    if (start < 0) start = 0;
    for (let off = 0; off < N;) {
      const i = (start + off) % N;
      if (!bad[i]) { off++; continue; }
      const run: Sample[] = [];
      while (off < N && bad[(start + off) % N]) { run.push(samples[(start + off) % N]); off++; }
      const len = run.reduce((acc, q) => acc + q.w, 0);
      const s0 = run[0].s - run[0].w / 2, s1 = s0 + len;
      const mid = at(s0 + len / 2);
      if (len < MIN_OPENING_M * pxPerM) { kept.push({ kind: "junction", at: mid, length_m: m(len) }); continue; }
      const nearShare = run.filter((q) => q.near).reduce((acc, q) => acc + q.w, 0) / len;
      const lineShare = run.filter((q) => q.line).reduce((acc, q) => acc + q.w, 0) / len;
      const prev = samples[(samples.indexOf(run[0]) - 1 + N) % N], next = samples[(samples.indexOf(run[run.length - 1]) + 1) % N];
      const bounded = (prev.on || inCut(prev.s)) && (next.on || inCut(next.s));
      if (bounded && len <= OPENING_MAX_M * pxPerM) {
        const g = glazing(run, edges, along, segs, outSign, pxPerM);
        if (g >= 2) { kept.push({ kind: "window", at: mid, length_m: m(len) }); continue; }
        if (len < MIN_PASSAGE_M * pxPerM) { kept.push({ kind: "junction", at: mid, length_m: m(len) }); continue; }
        if (nearShare >= LINE_SHARE) { flags.push({ reason: "off_walls", at: mid, length_m: m(len) }); continue; }
        cuts.push({ s0, s1, d: { kind: "opening", from: at(s0), to: at(s1), length_m: m(len) } });
        continue;
      }
      if (nearShare >= LINE_SHARE) { flags.push({ reason: "off_walls", at: mid, length_m: m(len) }); continue; }
      if (lineShare >= LINE_SHARE) { flags.push({ reason: "unread_edge", at: mid, length_m: m(len) }); continue; }
      cuts.push({ s0, s1, d: { kind: "open_side", from: at(s0), to: at(s1), length_m: m(len) } });
    }
  }
  const onLen = samples.filter((q) => q.on).reduce((acc, q) => acc + q.w, 0);

  // the runs: the ring minus the union of the cuts
  const iv: [number, number][] = [];
  for (const c of cuts) {
    const a = ((c.s0 % P) + P) % P, len = Math.min(P, c.s1 - c.s0);
    if (a + len <= P) iv.push([a, a + len]); else { iv.push([a, P]); iv.push([0, a + len - P]); }
  }
  iv.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const v of iv) { const last = merged[merged.length - 1]; if (last && v[0] <= last[1]) last[1] = Math.max(last[1], v[1]); else merged.push([...v]); }
  const cutLen = merged.reduce((acc, [a, b]) => acc + b - a, 0);
  let runs: Pt[][];
  if (!merged.length) runs = [[...ring, ring[0]]];
  else {
    runs = [];
    for (let k = 0; k < merged.length; k++) {
      const a = merged[k][1], b = k + 1 < merged.length ? merged[k + 1][0] : merged[0][0] + P;
      if (b - a < 1e-6) continue;
      runs.push(polyline(a, b, edges, P, at));
    }
  }
  return {
    gross_m: m(traced), spikes_m: m(spikes), net_m: m(P - cutLen), on_walls: onLen / P,
    deductions: cuts.map((c) => c.d), kept, flags, runs,
  };
}

/** The ring from arclength a to b (b may exceed P: it wraps), vertices included. */
function polyline(a: number, b: number, edges: Edge[], P: number, at: (s: number) => Pt): Pt[] {
  const out: Pt[] = [at(a)];
  for (let lap = 0; lap < 2; lap++) {
    for (const E of edges) {
      const v = E.s0 + lap * P;
      if (v > a && v < b) out.push(E.a);
    }
  }
  out.push(at(b));
  return out;
}

/** Distinct glazing lines across a break: straight ink along the ring, on the
 *  wall's side of it (a line's width to a wall's thickness out), covering most
 *  of the break. A window's frame and glass draw two or more; a threshold or a
 *  sliding leaf one. */
function glazing(run: Sample[], edges: Edge[], along: number[][], segs: ArrayLike<number>, outSign: number, pxPerM: number): number {
  const e = run[Math.floor(run.length / 2)].e, E = edges[e];
  const nx = -E.uy * outSign, ny = E.ux * outSign;
  const onE = run.filter((q) => q.e === e);
  if (!onE.length) return 0;
  const t0 = onE[0].t * E.L - onE[0].w / 2, t1 = onE[onE.length - 1].t * E.L + onE[onE.length - 1].w / 2, w = t1 - t0;
  // pieces of one drawn line (a frame broken at a mullion) share an offset: their union along the break counts
  const lines: { off: number; iv: [number, number][] }[] = [];
  for (const i of along[e]) {
    const x0 = segs[4 * i]!, y0 = segs[4 * i + 1]!, x1 = segs[4 * i + 2]!, y1 = segs[4 * i + 3]!;
    const off = (((x0 + x1) / 2 - E.a[0]) * nx + ((y0 + y1) / 2 - E.a[1]) * ny);
    if (off < 2 || off > OFF_FACE_M * pxPerM) continue;
    const u0 = (x0 - E.a[0]) * E.ux + (y0 - E.a[1]) * E.uy, u1 = (x1 - E.a[0]) * E.ux + (y1 - E.a[1]) * E.uy;
    const lo = Math.max(t0, Math.min(u0, u1)), hi = Math.min(t1, Math.max(u0, u1));
    if (hi <= lo) continue;
    const line = lines.find((l) => Math.abs(l.off - off) < 1.5);
    if (line) line.iv.push([lo, hi]); else lines.push({ off, iv: [[lo, hi]] });
  }
  let n = 0;
  for (const l of lines) {
    l.iv.sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [lo, hi] of l.iv) { if (hi > end) { covered += hi - Math.max(lo, end); end = hi; } }
    if (covered >= GLAZING_COVER * w) n++;
  }
  return n;
}
