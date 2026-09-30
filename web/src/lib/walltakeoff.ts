// Wall takeoff from plan linework — no layers, no text vocabulary, no per-set numbers.
//
// A wall in plan is a BAND: two outer faces a wall's thickness apart, with its
// material between them — solid poché, a hatch, further parallel lines
// (cladding, insulation, gypsum layers), or nothing at all on outline-style
// sets. Furniture and casework also draw parallel lines a wall's thickness
// apart, so a pair alone is not a wall; what a pair's INTERIOR holds is the
// evidence (poché or a face-to-face hatch is material; a sink, a bed or text
// is not), and the sheet's own style decides how much an empty pair is worth:
// on a sheet that draws its walls with poché or hatch, an empty pair is
// casework and is withheld, never counted.
//
// Quantities follow the centreline convention (NRM2 "walling measured on the
// centre line"): an L corner runs both walls to the centreline intersection, a
// wall abutting another at a T stops at its face, and a run is carried through
// an opening only as GROSS length — net length subtracts every bridged gap.
//
// Pure module: input is the sheet's vector geometry (oneclick.ts), output is
// runs in image px with their metric quantities. Scale comes in as px per metre.
import { SEG_CURVE, SEG_CLIP, SEG_FILLONLY, type VectorGeometry, type Point } from "./oneclick.ts";

// ── physical bounds (metres) — properties of buildings, not of any drawing set ──
/** Thinner than this is a door leaf, a glass line pair or a double pen stroke. */
export const MIN_THICK_M = 0.06;
/** Thicker than this is not one wall (foundation plans and massive masonry excepted — flagged). */
export const MAX_THICK_M = 0.7;
/** One layer gap inside a wall band (insulation, cavity) is never wider than this. */
export const MAX_LAYER_GAP_M = 0.45;
/** Shortest face piece that can carry a direction (shorter is hatch, text, symbols). */
export const MIN_PIECE_M = 0.1;
/** Shortest run reported as a wall on its own. */
export const MIN_RUN_M = 0.3;
/** Collinear face pieces this close along the line weld (drafting breaks at junctions stay open). */
export const WELD_GAP_M = 0.02;
/** Collinearity tolerance across the line. */
export const C_TOL_M = 0.006;
/** Angle bins for parallel families. */
export const ANGLE_TOL_DEG = 0.35;
/** Narrower gaps are junction breaks (an abutting wall interrupts one face), not openings. */
export const MIN_OPENING_M = 0.4;
/** Widest opening bridged into a run's gross length (a double door, a window band). */
export const MAX_OPENING_M = 3.0;
/** Faces this close in offset are one face drawn twice (stroke + fill outline). */
const DUP_C_M = 0.004;
/** A sheet draws its walls with material (poché, hatch, insulation) when material
 *  slabs reach this share of the empty-pair length: furniture, casework and
 *  dimension strings supply the empty pairs on every sheet, walls the material. */
export const MATERIAL_STYLE_SHARE = 0.25;
/** A hatch: at least this many strokes per metre of wall, in at most three directions. */
export const HATCH_MIN_PER_M = 4;
/** ...and present in this share of the wall's length bins. */
export const HATCH_COVERAGE = 0.75;
const HATCH_BIN_M = 0.15;
/** A slab whose strokes are this share square rungs is a ladder, not material. */
const LADDER_SHARE = 0.8;
/** A stroke along the wall at least this long is a layer line, not hatch. */
const LAYER_LINE_M = 0.5;
/** An empty slab this thin on a wall's face is a board layer of the wall. */
export const BOARD_LAYER_M = 0.03;
/** Growth passes admitting empty pairs that meet the wall network. */
const NETWORK_ROUNDS = 5;
/** An empty pair this long, meeting pairs at both ends, seeds the network. */
export const OUTLINE_SEED_M = 3.0;
/** ...and on an empty-pair sheet, a pair this long joined at one end grows it. */
export const OUTLINE_SPUR_M = 1.0;
/** A group of joined bands shorter than this in total is not a building's walls. */
export const NETWORK_MIN_M = 8;
/** Runs shorter than this count only as stubs held by walls at both ends. */
export const SHORT_RUN_M = 1.0;
/** A band shorter than this that touches no other wall is not counted. */
export const ISOLATED_MAX_M = 3.0;
/** Bands lying within this share of the sheet's short side from its edge are the border. */
export const FRAME_MARGIN = 0.03;
/** Two bands closer than their half thicknesses plus this meet. */
export const JOIN_REACH_M = 0.1;
/** Poché is dark: a fill paler than this (Rec.709 luminance 0–255) is a finish wash or a mask. */
export const POCHE_MAX_LUM = 200;

export type WallEvidence = "poche" | "hatch" | "outline";

export interface WallOpening {
  /** Gap span along the centreline, image px. */
  span: [Point, Point];
  widthM: number;
  /** door: a swing drawn at it; window: glazing lines in the band; opening: one line across. */
  kind: OpeningKind;
}

export interface WallRun {
  /** Centreline, image px; gross (through bridged openings, corners extended). */
  line: [Point, Point];
  thicknessM: number;
  grossM: number;
  netM: number;
  openings: WallOpening[];
  evidence: WallEvidence;
  /** true = one face on the building's outside; null = could not tell. */
  exterior: boolean | null;
  /** Segment indices of the faces that bound the run (the evidence trail). */
  faceSegs: number[];
}

export interface WithheldWall {
  line: [Point, Point];
  thicknessM: number;
  lengthM: number;
  reason: string;
}

export interface WallTakeoff {
  runs: WallRun[];
  withheld: WithheldWall[];
  /** What the sheet draws its walls with, by measured length. */
  style: { poche_m: number; hatch_m: number; outline_m: number; outline_counted: boolean };
  /** Gaps between two collinear pieces of one wall that carried no door or
   *  window evidence (never bridged): where a window mark points at one, it
   *  is the window's opening. Image px along the wall centreline. */
  gaps: Array<{ span: [Point, Point]; widthM: number }>;
}

export interface WallOptions {
  /** Rects (image px) whose linework is not plan: schedule tables, title block. */
  exclude?: Array<[number, number, number, number]>;
  /** Only this rect (image px): one drawing of a sheet that carries several. */
  region?: [number, number, number, number];
  /** Drawing-scale notes on the sheet (sheetscope.scaleLabels) as px per metre:
   *  a group of walls whose own title states another scale is not measured. */
  scaleNotes?: Array<{ at: Point; label: string; pxPerM: number }>;
  /** Door openings (closed-leaf chords, image px) from doors.ts: a gap with one is a door. */
  doors?: Array<[Point, Point]>;
  /** Text boxes (image px): a band carrying text is a table row or a label box, not a wall. */
  text?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
}

// A face: a welded straight line in a family's rotated frame (u along, c across).
interface Face { c: number; lo: number; hi: number; segs: number[]; lattice?: boolean }
// A slab: the space between two adjacent faces over an interval.
interface Slab { c0: number; c1: number; lo: number; hi: number; f0: number; f1: number; ev: WallEvidence | null }
// A band piece: stacked material slabs, outermost faces c0..c1.
interface Band { c0: number; c1: number; lo: number; hi: number; ev: WallEvidence; faces: number[] }

interface Family { ux: number; uy: number; faces: Face[] }

const deg = Math.PI / 180;

/** Straight segments grouped into parallel families, rotated so the family runs along u. */
function families(geo: VectorGeometry, pxPerM: number, excl: WallOptions["exclude"], region?: WallOptions["region"]): Family[] {
  const { segs, meta } = geo;
  const n = segs.length >> 2;
  const minLen = MIN_PIECE_M * pxPerM;
  const items: { a: number; i: number; len: number }[] = [];
  const inExcl = (x: number, y: number) => !!excl?.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  for (let i = 0; i < n; i++) {
    if (meta[i] & (SEG_CURVE | SEG_CLIP)) continue;
    const dx = segs[4 * i + 2] - segs[4 * i], dy = segs[4 * i + 3] - segs[4 * i + 1];
    const len = Math.hypot(dx, dy);
    if (len < minLen) continue;
    const mx = (segs[4 * i] + segs[4 * i + 2]) / 2, my = (segs[4 * i + 1] + segs[4 * i + 3]) / 2;
    if (inExcl(mx, my)) continue;
    if (region && (mx < region[0] || mx > region[2] || my < region[1] || my > region[3])) continue;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    items.push({ a, i, len });
  }
  // parallel families by peaks of a length-weighted angle histogram: chaining
  // neighbouring angles would run through a sheet full of tessellated curves
  // and fuse every direction into one family
  const BIN = ANGLE_TOL_DEG * deg / 2, nb = Math.ceil(Math.PI / BIN);
  const hist = new Float64Array(nb);
  const binOf = (a: number) => Math.min(nb - 1, Math.floor(a / BIN));
  for (const it of items) hist[binOf(it.a)] += it.len;
  const taken = new Uint8Array(items.length);
  const groups: { a: number; i: number; len: number }[][] = [];
  const minWeight = MIN_PIECE_M * pxPerM * 4;
  for (;;) {
    let pk = -1, best = 0;
    for (let k = 0; k < nb; k++) { const w = hist[(k + nb - 1) % nb] + hist[k] + hist[(k + 1) % nb]; if (w > best) { best = w; pk = k; } }
    if (pk < 0 || best < minWeight) break;
    const center = (pk + 0.5) * BIN;
    const g: { a: number; i: number; len: number }[] = [];
    items.forEach((it, j) => {
      if (taken[j]) return;
      let d = it.a - center;
      if (d > Math.PI / 2) d -= Math.PI; else if (d < -Math.PI / 2) d += Math.PI;
      if (Math.abs(d) <= ANGLE_TOL_DEG * deg) { taken[j] = 1; g.push({ ...it, a: center + d }); hist[binOf(it.a)] -= it.len; }
    });
    for (const k of [pk - 1, pk, pk + 1]) hist[(k + nb) % nb] = Math.max(0, hist[(k + nb) % nb]);
    if (!g.length) { hist[pk] = 0; continue; }
    groups.push(g);
  }
  const out: Family[] = [];
  for (const g of groups) {
    let sx = 0, sy = 0;
    for (const it of g) { sx += Math.cos(2 * it.a) * it.len; sy += Math.sin(2 * it.a) * it.len; }
    const a = Math.atan2(sy, sx) / 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    const raw: Face[] = g.map(({ i }) => {
      const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
      const u0 = x0 * ux + y0 * uy, u1 = x1 * ux + y1 * uy;
      const c = ((x0 + x1) / 2) * -uy + ((y0 + y1) / 2) * ux;
      return { c, lo: Math.min(u0, u1), hi: Math.max(u0, u1), segs: [i] };
    });
    const faces = weld(raw, pxPerM);
    markLattice(faces, pxPerM);
    out.push({ ux, uy, faces });
  }
  return out;
}

/** Lattice faces: members of a regular-pitch parallel family with at least two
 *  members on each side — table rows, stair treads, tile and plank hatch. A
 *  wall's own layer lines are few and irregularly spaced; a table's rows are
 *  many and even. Such faces bound no wall. */
export const LATTICE_MAX_PITCH_M = 1.0;
const LATTICE_MIN_SIDE = 2;
const LATTICE_PITCH_TOL = 0.25;
const LATTICE_REGULAR = 0.7;
function markLattice(F: Face[], pxPerM: number): void {
  const win = 2.5 * LATTICE_MAX_PITCH_M * pxPerM, minD = 0.005 * pxPerM;
  // a member crosses the face's middle and is not much shorter: short hatch
  // strokes beside a long wall face do not make the face part of their field,
  // and hatch lines clipped at different lengths still read as one field
  const ov = (a: Face, b: Face) => {
    const mid = (a.lo + a.hi) / 2;
    return b.lo <= mid && b.hi >= mid && b.hi - b.lo >= 0.5 * (a.hi - a.lo);
  };
  for (let k = 0; k < F.length; k++) {
    const f = F[k], offs: number[] = [0];
    let up = 0, dn = 0;
    for (let j = k + 1; j < F.length && F[j].c - f.c <= win; j++) if (F[j].c - f.c > minD && ov(f, F[j])) { offs.push(F[j].c - f.c); up++; }
    for (let j = k - 1; j >= 0 && f.c - F[j].c <= win; j--) if (f.c - F[j].c > minD && ov(f, F[j])) { offs.push(F[j].c - f.c); dn++; }
    if (up < LATTICE_MIN_SIDE || dn < LATTICE_MIN_SIDE) continue;
    offs.sort((a, b) => a - b);
    const uniq = offs.filter((o, i) => i === 0 || o - offs[i - 1] > minD);
    const seq = uniq.slice(1).map((o, i) => o - uniq[i]);
    const gaps = seq.slice().sort((a, b) => a - b);
    const pitch = gaps[gaps.length >> 1];
    if (!(pitch > 0)) continue;
    const regular = gaps.filter((g) => Math.abs(g - pitch) <= LATTICE_PITCH_TOL * pitch).length / gaps.length;
    if (pitch <= LATTICE_MAX_PITCH_M * pxPerM && regular >= LATTICE_REGULAR) { f.lattice = true; continue; }
    // a double-line hatch repeats two gaps in turn (narrow, wide, narrow, …)
    if (seq.length >= 4) {
      let same = 0;
      for (let q = 0; q + 2 < seq.length; q++) if (Math.abs(seq[q] - seq[q + 2]) <= LATTICE_PITCH_TOL * Math.max(seq[q], seq[q + 2])) same++;
      const period = seq[0] + seq[1];
      if (same / (seq.length - 2) >= LATTICE_REGULAR && period <= 2 * LATTICE_MAX_PITCH_M * pxPerM) f.lattice = true;
    }
  }
}

/** Weld collinear pieces (same c within tolerance, gaps ≤ WELD_GAP) into faces. */
function weld(raw: Face[], pxPerM: number): Face[] {
  const cTol = C_TOL_M * pxPerM, gap = WELD_GAP_M * pxPerM;
  raw.sort((a, b) => a.c - b.c);
  // bucket by c: consecutive faces within cTol of the bucket's first member
  const out: Face[] = [];
  let k = 0;
  while (k < raw.length) {
    let j = k;
    while (j + 1 < raw.length && raw[j + 1].c - raw[k].c <= cTol) j++;
    const bucket = raw.slice(k, j + 1).sort((a, b) => a.lo - b.lo);
    let cur: Face | null = null;
    let wsum = 0, csum = 0;
    const flush = () => { if (cur) { cur.c = csum / wsum; out.push(cur); } };
    for (const f of bucket) {
      if (cur && f.lo <= cur.hi + gap) {
        cur.hi = Math.max(cur.hi, f.hi);
        cur.segs.push(...f.segs);
        const w = f.hi - f.lo; wsum += w; csum += f.c * w;
      } else {
        flush();
        cur = { c: f.c, lo: f.lo, hi: f.hi, segs: f.segs.slice() };
        wsum = Math.max(1e-9, f.hi - f.lo); csum = f.c * wsum;
      }
    }
    flush();
    k = j + 1;
  }
  return out.sort((a, b) => a.c - b.c || a.lo - b.lo);
}

/** Subtract intervals from [lo, hi]; returns the remaining pieces. */
function subtract(lo: number, hi: number, cuts: Array<[number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[lo, hi]];
  for (const [a, b] of cuts) {
    const next: Array<[number, number]> = [];
    for (const [p, q] of parts) {
      if (b <= p || a >= q) { next.push([p, q]); continue; }
      if (a > p) next.push([p, a]);
      if (b < q) next.push([b, q]);
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

/** Elementary slabs: adjacent faces (no face between them over the interval) a layer gap apart. */
function slabsOf(fam: Family, pxPerM: number): Slab[] {
  const F = fam.faces;
  const maxGap = MAX_LAYER_GAP_M * pxPerM, dup = DUP_C_M * pxPerM, minOv = MIN_PIECE_M * pxPerM;
  const out: Slab[] = [];
  for (let i = 0; i < F.length; i++) {
    const a = F[i];
    if (a.lattice) continue;
    for (let j = i + 1; j < F.length; j++) {
      const b = F[j];
      const d = b.c - a.c;
      if (d > maxGap) break;
      if (d <= dup || b.lattice) continue;
      const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
      if (hi - lo < minOv) continue;
      // faces strictly between a and b over this interval make the pair non-adjacent there
      const cuts: Array<[number, number]> = [];
      for (let k = i + 1; k < j; k++) {
        const m = F[k];
        if (m.lattice || m.c - a.c <= dup || b.c - m.c <= dup) continue;   // hatch strokes are content, not layers
        if (m.hi > lo && m.lo < hi) cuts.push([m.lo, m.hi]);
      }
      for (const [p, q] of subtract(lo, hi, cuts)) {
        if (q - p >= minOv) out.push({ c0: a.c, c1: b.c, lo: p, hi: q, f0: i, f1: j, ev: null });
      }
    }
  }
  return out;
}

// ── material evidence ──────────────────────────────────────────────────────

interface Evidence {
  /** dark filled figures: closed polygons (image px) */
  fills: { poly: Point[]; x0: number; y0: number; x1: number; y1: number }[];
  fillGrid: Map<number, number[]>;
  /** every straight or curved stroke, bucketed by midpoint */
  segGrid: Map<number, number[]>;
  cell: number;
  text: WallOptions["text"];
  doors?: Array<[Point, Point]>;
  gapLog?: Array<{ span: [Point, Point]; widthM: number }>;
}

const gkey = (gx: number, gy: number) => gx * 100003 + gy;

function buildEvidence(geo: VectorGeometry, pxPerM: number, text: WallOptions["text"]): Evidence {
  const cell = 0.5 * pxPerM;
  const fills: Evidence["fills"] = [];
  const fillGrid = new Map<number, number[]>();
  for (const sp of geo.subpaths ?? []) {
    if (!(sp.flags & SEG_FILLONLY) || (sp.flags & SEG_CLIP)) continue;
    if (sp.fillLum > POCHE_MAX_LUM) continue;   // pale washes (room fills, finish zones) are not material
    const poly: Point[] = [];
    for (let i = sp.i0; i < sp.i1; i++) poly.push([geo.segs[4 * i], geo.segs[4 * i + 1]]);
    if (poly.length < 3) continue;
    const k = fills.length;
    fills.push({ poly, x0: sp.x0, y0: sp.y0, x1: sp.x1, y1: sp.y1 });
    for (let gx = Math.floor(sp.x0 / cell); gx <= Math.floor(sp.x1 / cell); gx++) {
      for (let gy = Math.floor(sp.y0 / cell); gy <= Math.floor(sp.y1 / cell); gy++) {
        const key = gkey(gx, gy);
        let b = fillGrid.get(key);
        if (!b) fillGrid.set(key, b = []);
        b.push(k);
      }
    }
  }
  const segGrid = new Map<number, number[]>();
  const n = geo.segs.length >> 2;
  for (let i = 0; i < n; i++) {
    if (geo.meta[i] & SEG_CLIP) continue;
    const mx = (geo.segs[4 * i] + geo.segs[4 * i + 2]) / 2, my = (geo.segs[4 * i + 1] + geo.segs[4 * i + 3]) / 2;
    const key = gkey(Math.floor(mx / cell), Math.floor(my / cell));
    let b = segGrid.get(key);
    if (!b) segGrid.set(key, b = []);
    b.push(i);
  }
  return { fills, fillGrid, segGrid, cell, text };
}

function inPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function filledAt(ev: Evidence, p: Point): boolean {
  const b = ev.fillGrid.get(gkey(Math.floor(p[0] / ev.cell), Math.floor(p[1] / ev.cell)));
  if (!b) return false;
  for (const k of b) {
    const f = ev.fills[k];
    if (p[0] < f.x0 || p[0] > f.x1 || p[1] < f.y0 || p[1] > f.y1) continue;
    if (inPoly(p, f.poly)) return true;
  }
  return false;
}

const toXY = (fam: Family, u: number, c: number): Point => [u * fam.ux - c * fam.uy, u * fam.uy + c * fam.ux];

/** What lies between a slab's two faces: poché, a face-to-face hatch, nothing, or clutter (null). */
function judgeSlab(s: Slab, fam: Family, ev: Evidence, geo: VectorGeometry, pxPerM: number): WallEvidence | null {
  const t = s.c1 - s.c0, L = s.hi - s.lo;
  const mid = (s.c0 + s.c1) / 2;
  // poché: sample the mid-line
  const nS = Math.max(3, Math.min(40, Math.round(L / (0.1 * pxPerM))));
  let filled = 0;
  for (let k = 0; k < nS; k++) {
    const u = s.lo + ((k + 0.5) / nS) * L;
    if (filledAt(ev, toXY(fam, u, mid))) filled++;
  }
  if (filled / nS >= 0.6) return "poche";
  // text inside the slab: a table row or a label box
  if (ev.text?.length) {
    for (const tb of ev.text) {
      const cx = (tb.x0 + tb.x1) / 2, cy = (tb.y0 + tb.y1) / 2;
      const u = cx * fam.ux + cy * fam.uy, c = cx * -fam.uy + cy * fam.ux;
      if (u > s.lo && u < s.hi && c > s.c0 + 0.15 * t && c < s.c1 - 0.15 * t) return null;
    }
  }
  // strokes inside: a hatch (many short strokes in a few directions) or clutter
  const { segs, meta } = geo;
  const inset = 0.12 * t;
  const corners = [toXY(fam, s.lo, s.c0), toXY(fam, s.hi, s.c0), toXY(fam, s.lo, s.c1), toXY(fam, s.hi, s.c1)];
  const gx0 = Math.floor(Math.min(...corners.map((p) => p[0])) / ev.cell), gx1 = Math.floor(Math.max(...corners.map((p) => p[0])) / ev.cell);
  const gy0 = Math.floor(Math.min(...corners.map((p) => p[1])) / ev.cell), gy1 = Math.floor(Math.max(...corners.map((p) => p[1])) / ev.cell);
  const uEnd = 0.02 * pxPerM;
  // a material symbol (hatch, cross-hatch, insulation batts) repeats all along
  // the wall; a fixture or casework sits in one place
  const binW = Math.max(HATCH_BIN_M * pxPerM, 0.5 * t);
  const nBins = Math.max(1, Math.floor(L / binW));
  const seen = new Uint8Array(nBins);
  let n = 0, curves = 0, long = 0, rungs = 0;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const b = ev.segGrid.get(gkey(gx, gy));
    if (!b) continue;
    for (const i of b) {
      const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const mu = mx * fam.ux + my * fam.uy, mc = mx * -fam.uy + my * fam.ux;
      if (mu <= s.lo + uEnd || mu >= s.hi - uEnd || mc <= s.c0 + inset || mc >= s.c1 - inset) continue;
      if (meta[i] & SEG_FILLONLY) continue;       // fill outlines were judged above
      const c0 = x0 * -fam.uy + y0 * fam.ux, c1 = x1 * -fam.uy + y1 * fam.ux;
      const len = Math.hypot(x1 - x0, y1 - y0);
      // a layer line runs along the wall; a short stroke along it is hatch
      if (Math.abs(c1 - c0) < 0.05 * t && !(meta[i] & SEG_CURVE) && len >= Math.min(LAYER_LINE_M * pxPerM, 0.5 * L)) continue;
      n++;
      if (meta[i] & SEG_CURVE) curves++;
      else if (len > 1.6 * t && Math.abs(c1 - c0) >= 0.05 * t) long++;
      // a stroke square across the band, face to face, is a rung
      if (!(meta[i] & SEG_CURVE) && Math.abs(c1 - c0) >= 0.8 * t && len <= 1.1 * Math.abs(c1 - c0)) rungs++;
      seen[Math.min(nBins - 1, Math.max(0, Math.floor((mu - s.lo) / binW)))] = 1;
    }
  }
  const perM = n / (L / pxPerM);
  if (n === 0 || (perM < 0.5 && curves === 0)) return "outline";   // a stray tick is not casework
  const coverage = seen.reduce((a, b) => a + b, 0) / nBins;
  // square rungs at a pitch are a ladder — stair treads, a rack, a grating, a
  // run of mullions — never wall material, which is hatched on the bias,
  // dotted or batted
  if (rungs >= LADDER_SHARE * n) return null;
  if (perM >= HATCH_MIN_PER_M && coverage >= HATCH_COVERAGE && long <= 0.1 * n) return "hatch";
  return null;
}

/** Stack adjacent material slabs into bands (outermost faces), per u interval. */
/** On a sheet that draws its walls with poché or hatch, an empty slab belongs to a
 *  wall only as a cavity BETWEEN two material slabs; one hanging off the side of a
 *  wall is a room wash edge, a skirting line or casework, and is cut off. A stack
 *  of empty slabs alone stays whole (it is judged later, as a whole). */
function splitStack(stack: Slab[], outlineOk: boolean, pxPerM: number): Slab[][] {
  if (outlineOk || stack.every((s) => s.ev === "outline")) return [stack];
  // board layers (gypsum, cladding boards) are thin empty slabs on a wall's faces
  const thin = (s: Slab) => s.c1 - s.c0 <= BOARD_LAYER_M * pxPerM;
  const keep = stack.map((s, k) => s.ev !== "outline" || thin(s) || (k > 0 && k < stack.length - 1 && stack[k - 1].ev !== "outline" && stack[k + 1].ev !== "outline"));
  const out: Slab[][] = [];
  let cur: Slab[] = [];
  stack.forEach((s, k) => { if (keep[k]) cur.push(s); else { if (cur.length) out.push(cur); cur = []; } });
  if (cur.length) out.push(cur);
  return out;
}

function bandsOf(slabs: Slab[], pxPerM: number, outlineOk: boolean): Band[] {
  // Sweep u: at each elementary interval between slab endpoints, chain slabs
  // that share faces into stacks and emit the stack as a band piece.
  const mat = slabs.filter((s) => s.ev);
  const cuts = new Set<number>();
  for (const s of mat) { cuts.add(s.lo); cuts.add(s.hi); }
  const xs = [...cuts].sort((a, b) => a - b);
  const byLo = mat.slice().sort((a, b) => a.lo - b.lo);
  const maxT = MAX_THICK_M * pxPerM, dup = DUP_C_M * pxPerM;
  const out: Band[] = [];
  const open: Slab[] = [];
  let p = 0;
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k], b = xs[k + 1];
    while (p < byLo.length && byLo[p].lo <= a) open.push(byLo[p++]);
    for (let q = open.length - 1; q >= 0; q--) if (open[q].hi <= a) open.splice(q, 1);
    const here = open.filter((s) => s.lo <= a && s.hi >= b).sort((x, y) => x.c0 - y.c0);
    let i = 0;
    while (i < here.length) {
      let j = i;
      while (j + 1 < here.length && Math.abs(here[j + 1].c0 - here[j].c1) <= dup && here[j + 1].c1 - here[i].c0 <= maxT) j++;
      for (const stack of splitStack(here.slice(i, j + 1), outlineOk, pxPerM)) {
        const ev: WallEvidence = stack.some((s) => s.ev === "poche") ? "poche" : stack.some((s) => s.ev === "hatch") ? "hatch" : "outline";
        const first = stack[0], last = stack[stack.length - 1];
        out.push({ c0: first.c0, c1: last.c1, lo: a, hi: b, ev, faces: [first.f0, last.f1] });
      }
      i = j + 1;
    }
  }
  return out;
}

interface RawRun { fam: number; c0: number; c1: number; lo: number; hi: number; ev: WallEvidence; faces: Set<number>; pieces: Array<[number, number]> }

/** Weld band pieces with the same outer faces into runs along u. */
function runsOf(bands: Band[], famIdx: number, pxPerM: number): RawRun[] {
  const tol = 0.01 * pxPerM;
  const sorted = bands.slice().sort((a, b) => a.c0 - b.c0 || a.c1 - b.c1 || a.lo - b.lo);
  const out: RawRun[] = [];
  for (const b of sorted) {
    const r = out.find((x) => Math.abs(x.c0 - b.c0) <= tol && Math.abs(x.c1 - b.c1) <= tol && b.lo <= x.hi + tol && b.hi >= x.lo - tol);
    if (r) {
      r.lo = Math.min(r.lo, b.lo); r.hi = Math.max(r.hi, b.hi);
      r.pieces.push([b.lo, b.hi]);
      if (b.ev === "poche" || (b.ev === "hatch" && r.ev === "outline")) r.ev = b.ev;
      b.faces.forEach((f) => r.faces.add(f));
    } else {
      out.push({ fam: famIdx, c0: b.c0, c1: b.c1, lo: b.lo, hi: b.hi, ev: b.ev, faces: new Set(b.faces), pieces: [[b.lo, b.hi]] });
    }
  }
  return out;
}

/** Bridge collinear same-thickness runs across openings (gross), recording each gap. */
/** One wall is one run. A wall whose drawn layers change along its length
 *  (a cladding line that stops, a hatch that starts) yields overlapping bands
 *  of different widths; the longest band claims the stretch it covers and the
 *  others keep only what it does not. */
function dedupe<R extends RawRun & { gaps?: Array<[number, number, GapKind]> }>(runs: R[], pxPerM: number): R[] {
  const drawn = (r: RawRun) => r.pieces.reduce((s, [a, b]) => s + b - a, 0);
  const order = runs.slice().sort((a, b) => drawn(b) - drawn(a));
  const kept: R[] = [];
  const minLen = MIN_PIECE_M * pxPerM;
  for (const r of order) {
    const cuts: Array<[number, number]> = [];
    for (const k of kept) {
      const ov = Math.min(r.c1, k.c1) - Math.max(r.c0, k.c0);
      if (ov >= 0.5 * Math.min(r.c1 - r.c0, k.c1 - k.c0)) cuts.push([k.lo, k.hi]);
    }
    for (const [lo, hi] of subtract(r.lo, r.hi, cuts)) {
      if (hi - lo < minLen) continue;
      kept.push({
        ...r, lo, hi, faces: new Set(r.faces),
        pieces: r.pieces.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number]).filter(([a, b]) => b > a),
        ...(r.gaps ? { gaps: r.gaps.filter(([a, b]) => a >= lo && b <= hi) } : {}),
      });
    }
  }
  return kept;
}

export type OpeningKind = "door" | "window" | "opening";
type GapKind = OpeningKind | "junction";

/** What fills a gap [a, b] between two collinear pieces of one wall band:
 *  a door (a swing drawn at it), a window (glazing lines along the wall inside
 *  the band), an opening (one line across: a threshold, a sliding leaf), a
 *  junction break (narrower than any opening), or nothing — two walls that
 *  merely line up across a room, never bridged. */
function gapKind(fam: Family, c0: number, c1: number, a: number, b: number, geo: VectorGeometry, ev: Evidence, pxPerM: number): GapKind | null {
  const w = b - a, t = c1 - c0;
  if (w < MIN_OPENING_M * pxPerM) return "junction";
  const { segs, meta } = geo;
  const cu = (a + b) / 2, cc = (c0 + c1) / 2;
  const [cx, cy] = toXY(fam, cu, cc);
  const R = 1.2 * w;
  let curves = 0, along = 0;
  for (let gx = Math.floor((cx - R) / ev.cell); gx <= Math.floor((cx + R) / ev.cell); gx++) {
    for (let gy = Math.floor((cy - R) / ev.cell); gy <= Math.floor((cy + R) / ev.cell); gy++) {
      const bk = ev.segGrid.get(gkey(gx, gy));
      if (!bk) continue;
      for (const i of bk) {
        const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        if (meta[i] & SEG_CURVE) { if (Math.hypot(mx - cx, my - cy) <= R) curves++; continue; }
        const u0 = x0 * fam.ux + y0 * fam.uy, u1 = x1 * fam.ux + y1 * fam.uy;
        const v0 = x0 * -fam.uy + y0 * fam.ux, v1 = x1 * -fam.uy + y1 * fam.ux;
        if (Math.abs(v1 - v0) > 0.02 * w) continue;                     // not along the wall
        const v = (v0 + v1) / 2;
        if (v < c0 + 0.15 * t || v > c1 - 0.15 * t) continue;            // glazing sits inside the band, not on its faces
        const cover = Math.min(b, Math.max(u0, u1)) - Math.max(a, Math.min(u0, u1));
        if (cover >= 0.6 * w) along++;
      }
    }
  }
  if (ev.doors) {
    for (const [p, q] of ev.doors) {
      const mu = ((p[0] + q[0]) / 2) * fam.ux + ((p[1] + q[1]) / 2) * fam.uy, mc = ((p[0] + q[0]) / 2) * -fam.uy + ((p[1] + q[1]) / 2) * fam.ux;
      if (mu >= a - 0.1 * w && mu <= b + 0.1 * w && Math.abs(mc - cc) <= t / 2 + 0.2 * w) return "door";
    }
  } else if (curves >= 3) return "door";
  if (along >= 2) return "window";
  if (along === 1) return "opening";
  return null;
}

function bridge(runs: RawRun[], fam: Family, geo: VectorGeometry, ev: Evidence, pxPerM: number): Array<RawRun & { gaps: Array<[number, number, GapKind]> }> {
  const tol = 0.015 * pxPerM, maxGap = MAX_OPENING_M * pxPerM;
  const sorted = runs.slice().sort((a, b) => a.c0 - b.c0 || a.lo - b.lo);
  const used = new Array<boolean>(sorted.length).fill(false);
  const out: Array<RawRun & { gaps: Array<[number, number, GapKind]> }> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const cur = { ...sorted[i], faces: new Set(sorted[i].faces), pieces: sorted[i].pieces.slice(), gaps: [] as Array<[number, number, GapKind]> };
    used[i] = true;
    let grew = true;
    const refused = new Set<number>();
    while (grew) {
      grew = false;
      // nearest collinear piece on either side first, so a gap is judged between neighbours
      let best = -1, bestGap = Infinity;
      for (let j = 0; j < sorted.length; j++) {
        if (used[j] || refused.has(j)) continue;
        const r = sorted[j];
        const same = Math.abs(r.c0 - cur.c0) <= tol && Math.abs(r.c1 - cur.c1) <= tol;
        // a wall whose drawn width changes at an opening (a window reveal, a
        // cladding line stopping at a door) still runs through it
        const inline = Math.abs((r.c0 + r.c1) / 2 - (cur.c0 + cur.c1) / 2) <= Math.min(r.c1 - r.c0, cur.c1 - cur.c0) / 2;
        if (!same && !inline) continue;
        const g = r.lo > cur.hi ? r.lo - cur.hi : r.hi < cur.lo ? cur.lo - r.hi : 0;
        if (!same && g === 0) continue;
        if (g <= maxGap && g < bestGap) { best = j; bestGap = g; }
      }
      if (best < 0) break;
      const r = sorted[best];
      const [a, b] = r.lo > cur.hi ? [cur.hi, r.lo] : r.hi < cur.lo ? [r.hi, cur.lo] : [0, 0];
      const sameBand = Math.abs(r.c0 - cur.c0) <= tol && Math.abs(r.c1 - cur.c1) <= tol;
      if (b > a) {
        const kind0 = gapKind(fam, Math.min(cur.c0, r.c0), Math.max(cur.c1, r.c1), a, b, geo, ev, pxPerM);
        const kind = sameBand || kind0 === "door" || kind0 === "window" ? kind0 : null;
        if (!kind) {
          if (b - a >= MIN_OPENING_M * pxPerM) {
            const cc = (Math.min(cur.c0, r.c0) + Math.max(cur.c1, r.c1)) / 2;
            ev.gapLog?.push({ span: [toXY(fam, a, cc), toXY(fam, b, cc)], widthM: (b - a) / pxPerM });
          }
          refused.add(best); grew = true; continue;
        }
        cur.gaps.push([a, b, kind]);
        if (!sameBand) {
          // the opening belongs to this wall's gross length; the piece beyond it,
          // drawn at another width, stays its own run with its own thickness
          cur.lo = Math.min(cur.lo, a); cur.hi = Math.max(cur.hi, b);
          refused.add(best); grew = true; continue;
        }
      }
      cur.lo = Math.min(cur.lo, r.lo); cur.hi = Math.max(cur.hi, r.hi);
      used[best] = true; grew = true;
      r.faces.forEach((f) => cur.faces.add(f));
      cur.pieces.push(...r.pieces);
      if (r.ev === "poche" || (r.ev === "hatch" && cur.ev === "outline")) cur.ev = r.ev;
    }
    out.push(cur);
  }
  return out;
}

/** Extend run ends to the centreline intersection at L corners (both runs end there). */
function extendCorners(runs: Array<{ fam: Family; c: number; lo: number; hi: number; t: number }>, pxPerM: number): void {
  const reach = 0.05 * pxPerM;
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const A = runs[i], B = runs[j];
    const cross = A.fam.ux * B.fam.uy - A.fam.uy * B.fam.ux;
    if (Math.abs(cross) < Math.sin(20 * deg)) continue;
    // centreline intersection
    const pA = toXY(A.fam, 0, A.c), pB = toXY(B.fam, 0, B.c);
    const dx = pB[0] - pA[0], dy = pB[1] - pA[1];
    const s = (dx * B.fam.uy - dy * B.fam.ux) / cross;         // along A from pA
    const X: Point = [pA[0] + s * A.fam.ux, pA[1] + s * A.fam.uy];
    const uA = X[0] * A.fam.ux + X[1] * A.fam.uy, uB = X[0] * B.fam.ux + X[1] * B.fam.uy;
    // each run must END near X: within the other's half thickness (+reach) beyond its end
    const endA = uA > A.hi ? uA - A.hi : uA < A.lo ? A.lo - uA : -1;
    const endB = uB > B.hi ? uB - B.hi : uB < B.lo ? B.lo - uB : -1;
    const fitA = endA >= 0 && endA <= B.t / 2 + reach, fitB = endB >= 0 && endB <= A.t / 2 + reach;
    if (!fitA || !fitB) continue;
    if (uA > A.hi) A.hi = uA; else A.lo = uA;
    if (uB > B.hi) B.hi = uB; else B.lo = uB;
  }
}

function ptSeg(p: Point, [a, b]: [Point, Point]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance between two segments (0 when they cross). */
function segDist(A: [Point, Point], B: [Point, Point]): number {
  const [[ax, ay], [bx, by]] = A, [[cx, cy], [dx, dy]] = B;
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(ptSeg(A[0], B), ptSeg(A[1], B), ptSeg(B[0], A), ptSeg(B[1], A));
}

// ── exterior / interior ────────────────────────────────────────────────────

/** Rays cast from each side of a run: the outside of a building is where rays
 *  leave the drawing without crossing another wall. A flood from the border
 *  would need every opening closed; rays only need most of them to hit. */
const RAY_SPREAD_DEG = [-60, -40, -20, 0, 20, 40, 60];
const RAY_OFFSETS = [0.2, 0.35, 0.5, 0.65, 0.8];
export const EXTERIOR_ESCAPE = 0.6;   // share of a side's rays that must escape for "outside"
export const INTERIOR_ESCAPE = 0.3;   // ...and at most this share for "inside"

/** Sides of every run; returns the runs with outside on BOTH faces (freestanding). */
function classifySides(runs: WallRun[], pxPerM: number): Set<WallRun> {
  const free = new Set<WallRun>();
  const L = runs.map((r) => r.line);
  const hits = (ox: number, oy: number, dx: number, dy: number, self: number): boolean => {
    for (let k = 0; k < L.length; k++) {
      if (k === self) continue;
      const [[ax, ay], [bx, by]] = L[k];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - ox) * ey - (ay - oy) * ex) / den;      // along the ray
      const u = ((ax - ox) * dy - (ay - oy) * dx) / den;      // along the wall
      if (t > 0 && u >= 0 && u <= 1) return true;
    }
    return false;
  };
  runs.forEach((r, i) => {
    const [[x0, y0], [x1, y1]] = r.line;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const tx = (x1 - x0) / len, ty = (y1 - y0) / len;
    const off = (r.thicknessM / 2) * pxPerM + 0.05 * pxPerM;
    const escape = [0, 0];
    let n = 0;
    for (const f of RAY_OFFSETS) {
      const bx = x0 + f * (x1 - x0), by = y0 + f * (y1 - y0);
      for (const a of RAY_SPREAD_DEG) {
        const ca = Math.cos(a * deg), sa = Math.sin(a * deg);
        for (const side of [0, 1]) {
          const nx = side ? ty : -ty, ny = side ? -tx : tx;   // the two normals
          const dx = nx * ca - ny * sa, dy = nx * sa + ny * ca;
          if (!hits(bx + nx * off, by + ny * off, dx, dy, i)) escape[side]++;
        }
        n++;
      }
    }
    const e0 = escape[0] / n, e1 = escape[1] / n;
    const out0 = e0 >= EXTERIOR_ESCAPE, out1 = e1 >= EXTERIOR_ESCAPE;
    if (out0 !== out1 && Math.min(e0, e1) <= INTERIOR_ESCAPE) r.exterior = true;
    else if (e0 <= INTERIOR_ESCAPE && e1 <= INTERIOR_ESCAPE) r.exterior = false;
    else r.exterior = null;
    if (out0 && out1) free.add(r);
  });
  return free;
}

/** The sheet's walls: runs with centreline, thickness, gross/net length and side. */
export function wallTakeoff(geo: VectorGeometry, pxPerM: number, width: number, height: number, opts: WallOptions = {}): WallTakeoff {
  const fams = families(geo, pxPerM, opts.exclude, opts.region);
  const ev = buildEvidence(geo, pxPerM, opts.text);
  ev.doors = opts.doors;
  ev.gapLog = [];
  const minT = MIN_THICK_M * pxPerM, maxT = MAX_THICK_M * pxPerM;
  type Cand = RawRun & { gaps: Array<[number, number, GapKind]> };
  const cands: Array<{ fam: Family; famIdx: number; r: Cand }> = [];
  const famSlabs = fams.map((fam) => {
    const slabs = fam.faces.length < 2 ? [] : slabsOf(fam, pxPerM);
    for (const s of slabs) s.ev = judgeSlab(s, fam, ev, geo, pxPerM);
    return slabs;
  });
  // the sheet's wall style, by the length of wall-thick slabs each way of drawing
  const style = { poche_m: 0, hatch_m: 0, outline_m: 0, outline_counted: true };
  for (const slabs of famSlabs) for (const s of slabs) {
    if (!s.ev || s.c1 - s.c0 < minT) continue;
    const len = (s.hi - s.lo) / pxPerM;
    if (s.ev === "poche") style.poche_m += len; else if (s.ev === "hatch") style.hatch_m += len; else style.outline_m += len;
  }
  style.outline_counted = style.poche_m + style.hatch_m < MATERIAL_STYLE_SHARE * style.outline_m;
  const withheld: WithheldWall[] = [];
  fams.forEach((fam, fi) => {
    const bands = bandsOf(famSlabs[fi], pxPerM, false).filter((b) => b.c1 - b.c0 >= minT && b.c1 - b.c0 <= maxT);
    const pieces = runsOf(bands, fi, pxPerM);
    // openings are bridged only between pieces that are walls themselves
    for (const r of dedupe(bridge(dedupe(pieces, pxPerM), fam, geo, ev, pxPerM), pxPerM)) cands.push({ fam, famIdx: fi, r });
  });
  const kept: Array<{ fam: Family; c: number; lo: number; hi: number; t: number; r: Cand }> = [];
  for (const { fam, r } of cands) {
    if ((r.hi - r.lo) < MIN_RUN_M * pxPerM) continue;
    kept.push({ fam, c: (r.c0 + r.c1) / 2, lo: r.lo, hi: r.hi, t: r.c1 - r.c0, r });
  }
  // an empty pair is a wall only where it spans between walls: both ends
  // against a wall already counted, at an angle — grown outward from the
  // poché/hatch walls like a wall network. On a sheet that draws every wall
  // as an empty pair, long pairs meeting other pairs at both ends seed it.
  const accepted = kept.map((k) => k.r.ev !== "outline");
  const endHits = (i: number, onlyAccepted: boolean): number => {
    const A = kept[i];
    let ends = 0;
    for (const u of [A.lo, A.hi]) {
      const p = toXY(A.fam, u, A.c);
      const hit = kept.some((B, j) => {
        if (j === i || (onlyAccepted && !accepted[j])) return false;
        const seg: [Point, Point] = [toXY(B.fam, B.lo, B.c), toXY(B.fam, B.hi, B.c)];
        if (Math.abs(A.fam.ux * B.fam.uy - A.fam.uy * B.fam.ux) < Math.sin(20 * deg)) {
          // the same wall line continuing past a junction break or an opening
          if (!style.outline_counted || B.fam !== A.fam || Math.abs(B.c - A.c) > Math.min(A.t, B.t) / 2) return false;
          return ptSeg(p, seg) <= MAX_OPENING_M * pxPerM;
        }
        return ptSeg(p, seg) <= (A.t + B.t) / 2 + JOIN_REACH_M * pxPerM;
      });
      if (hit) ends++;
    }
    return ends;
  };
  for (let round = 0; round < NETWORK_ROUNDS; round++) {
    let grew = false;
    kept.forEach((k, i) => {
      if (accepted[i]) return;
      const ok = endHits(i, true) === 2 || (k.hi - k.lo >= OUTLINE_SEED_M * pxPerM && endHits(i, false) >= (style.outline_counted ? 1 : 2))
        // on a sheet that draws its walls as empty pairs, a pair joined to the
        // network at one end is a partition like the rest
        || (style.outline_counted && endHits(i, true) >= 1 && k.hi - k.lo >= OUTLINE_SPUR_M * pxPerM);
      if (ok) { accepted[i] = true; grew = true; }
    });
    if (!grew) break;
  }
  const outlineKept = kept.filter((k, i) => {
    if (accepted[i]) return true;
    const c = k.c;
    withheld.push({ line: [toXY(k.fam, k.lo, c), toXY(k.fam, k.hi, c)], thicknessM: k.t / pxPerM, lengthM: (k.hi - k.lo) / pxPerM, reason: "outline_unconnected: two parallel lines with nothing between them that do not meet the wall network — casework, furniture or a symbol, not counted" });
    return false;
  });
  kept.length = 0; kept.push(...outlineKept);
  extendCorners(kept, pxPerM);
  let runs: WallRun[] = kept.map(({ fam, c, lo, hi, t, r }) => {
    const gaps = r.gaps.filter((g) => g[2] !== "junction").map(([a, b, kind]) => ({ span: [toXY(fam, a, c), toXY(fam, b, c)] as [Point, Point], widthM: (b - a) / pxPerM, kind: kind as OpeningKind }));
    const gross = (hi - lo) / pxPerM;
    return {
      line: [toXY(fam, lo, c), toXY(fam, hi, c)],
      thicknessM: t / pxPerM,
      grossM: gross,
      netM: gross - gaps.reduce((s, g) => s + g.widthM, 0),
      openings: gaps,
      evidence: r.ev,
      exterior: null,
      faceSegs: [...r.faces].flatMap((fi) => fam.faces[fi]?.segs ?? []),
    };
  });
  // a wall belongs to a building: a short band touching no other wall is a
  // legend sample, a symbol or casework
  // legend samples stack side by side, so only a junction with a wall at an
  // angle counts as meeting the building
  const dir = (r: WallRun) => Math.atan2(r.line[1][1] - r.line[0][1], r.line[1][0] - r.line[0][0]);
  const angled = (a: WallRun, b: WallRun) => Math.abs(Math.sin(dir(a) - dir(b))) >= Math.sin(20 * deg);
  // a short band lying across another wall's band is that wall's hatch or a
  // jamb line; a short band is a wall stub only when walls hold both its ends
  const inside = (r: WallRun, q: WallRun) => r.line.every((p) => ptSeg(p, q.line) <= (q.thicknessM / 2) * pxPerM + 1);
  const held = (r: WallRun, i: number) => r.line.every((p) => runs.some((q, j) => j !== i && angled(r, q) && q.grossM > r.grossM &&
    ptSeg(p, q.line) <= ((r.thicknessM + q.thicknessM) / 2 + JOIN_REACH_M) * pxPerM));
  const stray = runs.map((r, i) => r.grossM < SHORT_RUN_M && (runs.some((q, j) => j !== i && q.grossM > r.grossM && inside(r, q)) || !held(r, i)));
  runs = runs.filter((r, i) => {
    if (!stray[i]) return true;
    withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "short_unanchored: a band under 1 m not held by walls at both ends, or lying inside another wall — hatch, a jamb line or casework" });
    return false;
  });
  const lonely = runs.map((r, i) => r.grossM < ISOLATED_MAX_M && !runs.some((q, j) => j !== i && angled(r, q) &&
    segDist(r.line, q.line) <= ((r.thicknessM + q.thicknessM) / 2 + JOIN_REACH_M) * pxPerM));
  // the drawing frame: double border lines a wall's width apart
  const margin = FRAME_MARGIN * Math.min(width, height);
  const onFrame = (r: WallRun) => r.line.every(([x, y]) => x < margin || y < margin || x > width - margin || y > height - margin);
  const connected = runs.filter((r, i) => {
    if (onFrame(r)) {
      withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "sheet_frame: a band along the sheet edge — the drawing border" });
      return false;
    }
    if (!lonely[i]) return true;
    withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "isolated: a short band that meets no wall at an angle — a legend sample, a symbol or casework" });
    return false;
  });
  // a small closed cluster of bands (a level marker, a column symbol, a
  // north arrow) meets only itself
  const comp = connected.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  connected.forEach((r, i) => connected.forEach((q, j) => {
    if (j > i && segDist(r.line, q.line) <= ((r.thicknessM + q.thicknessM) / 2 + JOIN_REACH_M) * pxPerM) comp[find(i)] = find(j);
  }));
  const box = new Map<number, [number, number, number, number]>();
  connected.forEach((r, i) => {
    const k = find(i), b = box.get(k) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of r.line) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    box.set(k, b);
  });
  const small = (i: number) => { const b = box.get(find(i))!; return Math.hypot(b[2] - b[0], b[3] - b[1]) < ISOLATED_MAX_M * pxPerM; };
  // the scale note nearest each group of walls (inside it or just beside it)
  // is that drawing's own scale; one that disagrees with the sheet's marks a
  // detail, a section or a key plan
  const foreignScale = new Map<number, string>();
  if (opts.scaleNotes?.length) {
    for (const [k, b] of box) {
      const reach = 0.25 * Math.hypot(b[2] - b[0], b[3] - b[1]) + 0.5 * pxPerM;
      let best: { d: number; n: { label: string; pxPerM: number } } | undefined;
      for (const n of opts.scaleNotes) {
        const dx = Math.max(b[0] - n.at[0], 0, n.at[0] - b[2]), dy = Math.max(b[1] - n.at[1], 0, n.at[1] - b[3]);
        const d = Math.hypot(dx, dy);
        if (d <= reach && (!best || d < best.d)) best = { d, n };
      }
      if (best && Math.abs(best.n.pxPerM / pxPerM - 1) > 0.05) foreignScale.set(k, best.n.label);
    }
  }
  const compLen = new Map<number, number>();
  connected.forEach((r, i) => compLen.set(find(i), (compLen.get(find(i)) ?? 0) + r.grossM));
  const building = connected.filter((r, i) => {
    if (small(i)) {
      withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "symbol: part of a small cluster of bands that meets no other wall — a marker, a column or a symbol" });
      return false;
    }
    const foreign = foreignScale.get(find(i));
    if (foreign) {
      withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: `other_scale: this drawing's own title says ${foreign} — a detail or section beside the plan, not measurable at the sheet's scale` });
      return false;
    }
    if ((compLen.get(find(i)) ?? 0) < NETWORK_MIN_M) {
      withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "fragment: part of a few bands joined to no wall network (under 8 m together) — a detail, a diagram or casework" });
      return false;
    }
    return true;
  });
  const free = classifySides(building, pxPerM);
  const counted = building.filter((r) => {
    if (!free.has(r)) return true;
    withheld.push({ line: r.line, thicknessM: r.thicknessM, lengthM: r.grossM, reason: "freestanding: open to the outside on both faces — a railing, a parapet, a balcony edge or a site wall, not a building wall" });
    return false;
  });
  return { runs: counted, withheld, style, gaps: ev.gapLog };
}
