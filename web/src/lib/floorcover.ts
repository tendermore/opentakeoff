// Floor coverage — the floor a room takeoff has not measured yet.
//
// A room sweep reports the rooms it found. What it cannot say on its own is
// what it did NOT find: the corridor with no walls round it, the waiting area
// open to the hall, the stair room whose flood ran into the corridor. On a
// marked-up plan those read as whitespace, and an estimator reviewing the
// takeoff asks "where is the rest of the floor?".
//
// So measure the floor that is left. Take the sheet's wall raster (the mask
// the sweep floods, doorways closed at their swings), burn every floor
// outline already committed into it, and what is still free is the remaining
// floor. Its connected pieces are ZONES. A zone that holds exactly one room
// label is that room's floor; a zone that holds several is split at what the
// drawing draws between them — a zone or finish line running wall to wall, or
// an opening between two wall ends (netroom's line-end closure) — and never
// anywhere else. Pieces with no label fold back into the one labelled piece
// they touch (a counter pocket is not a room). Where nothing drawn separates
// two labels, the zone stays whole and says so.
//
// This module only partitions. It does not decide what may be committed — the
// caller holds the zone against the printed area (checkAgainstPrintedArea) or,
// on sheets that print none, against its walls (wallShare) — and it never
// reads a layer name, a room name or a project convention: walls, openings and
// drawn lines are geometry.
//
// Room segmentation outside construction splits open space at narrow passages
// (Bormann et al., ICRA 2016: morphological, distance-transform and Voronoi
// segmentation) or halfway between two labels (Ahmed et al., DAS 2012). Both
// place a boundary the drawing does not draw; here an undrawn boundary is a
// reason to report, not a place to cut.
//
// Pure module: no pdf.js, no DOM.
import { SEG_CURVE, SEG_CLIP, traceRegion } from "./oneclick.ts";
import type { MaskObj, Point } from "./oneclick.ts";

/** Free floor thinner than this (m) along a measured outline or a wall is a
 *  trace's slack against the wall face, not floor anyone left out. */
export const SLIVER_M = 0.04;
/** An enclosed piece smaller than this (m²) is a wall cavity or a symbol, not floor. */
export const MIN_PIECE_M2 = 0.25;
/** ...and so is one no wider than this (m) anywhere: the space between a wall's two faces. */
export const MIN_PIECE_WIDTH_M = 0.4;
/** A drawn line counts as a zone boundary when it is at least this long (m)... */
export const CUT_MIN_M = 0.4;
/** ...and each of its ends lands within this distance (m) of a wall or another boundary line. */
export const CUT_LAND_M = 0.15;
/** Two collinear wall ends facing each other across a clear gap this wide (m)
 *  are one wall with an opening in it (netroom's line-end closure, 7 ft; a
 *  double door is 1.8 m). Wider is open plan, and nothing is drawn there. */
export const OPENING_MIN_M = 0.6;
export const OPENING_MAX_M = 2.1;
/** Collinear within this lateral offset (m). */
const OPENING_LATERAL_M = 0.1;
/** Building footprint: measured and labelled floor closed over this radius
 *  (m), so the walls between rooms and a small unlabelled space between them
 *  fall inside the building, while paper a metre and a half away does not. */
export const FOOTPRINT_CLOSE_M = 1.5;

export interface CoverLabel {
  /** the label as drawn: "54,0 m²", "211", "OFFICE" */
  text: string;
  /** printed area (m²) when the label is an area stamp, else null */
  m2: number | null;
  /** centre, image px */
  x: number;
  y: number;
  /** text height, image px */
  h: number;
  /** the room name drawn with it, when known */
  name?: string;
}

export interface CoverInput {
  /** hard bit 1 = boundary (walls, sealed doorways); the mask a room flood uses */
  walls: MaskObj;
  /** mask-resolution cells of drawn zone boundaries and openings (zoneCuts) */
  cuts?: Uint8Array | null;
  /** committed floor outlines on the sheet, image px */
  measured: Point[][];
  labels: CoverLabel[];
  /** image px per metre */
  pxPerM: number;
  /** a zone larger than this (m²) is not a room but the paper round the building */
  leakM2: number;
}

export interface CoverZone {
  /** mask cell indices */
  cells: Int32Array;
  /** indices into CoverInput.labels */
  labels: number[];
  m2: number;
  /** open to the sheet edge or larger than any room: the outside, not a room */
  leaks: boolean;
  /** share of the zone's boundary that is wall ink or a measured room (the rest is a drawn line, an opening or open floor) */
  wallShare: number;
  /** a point inside the zone (image px) */
  at: Point;
  /** image px */
  bbox: [number, number, number, number];
  /** labels a split could not separate: the drawing draws nothing between them */
  unsplit?: boolean;
  /** floor folded in across drawn lines (furniture pockets, door swings, stair flights), m² */
  mergedM2?: number;
}

export interface CoverResult {
  zones: CoverZone[];
  /** enclosed floor inside the building footprint holding no label */
  unlabeled: CoverZone[];
  /** indices of labels that sit inside a measured outline */
  measuredLabels: number[];
  /** mask geometry, for tracing */
  mw: number;
  mh: number;
  ws: number;
}

const FREE = 0, WALL = 1, TAKEN = 2, CUT = 3;

/** Even-odd scanline fill of an image-px ring at mask resolution. */
function fillRing(state: Uint8Array, mw: number, mh: number, ws: number, ring: Point[], v: number): void {
  if (ring.length < 3) return;
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of ring) { y0 = Math.min(y0, y * ws); y1 = Math.max(y1, y * ws); }
  const n = ring.length;
  for (let my = Math.max(0, Math.floor(y0)); my <= Math.min(mh - 1, Math.ceil(y1)); my++) {
    const yc = my + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = ring[i][0] * ws, ay = ring[i][1] * ws, bx = ring[(i + 1) % n][0] * ws, by = ring[(i + 1) % n][1] * ws;
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.round(xs[k])), b = Math.min(mw - 1, Math.round(xs[k + 1]) - 1);
      for (let mx = a; mx <= b; mx++) state[my * mw + mx] = v;
    }
  }
}

/** City-block distance (cells) from every cell to the nearest cell where `src` is set, capped at 65535. */
function distFrom(src: (i: number) => boolean, mw: number, mh: number): Uint16Array {
  const d = new Uint16Array(mw * mh);
  const INF = 65535;
  for (let i = 0; i < d.length; i++) d[i] = src(i) ? 0 : INF;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const i = y * mw + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
    if (y > 0 && d[i - mw] + 1 < v) v = d[i - mw] + 1;
    d[i] = v;
  }
  for (let y = mh - 1; y >= 0; y--) for (let x = mw - 1; x >= 0; x--) {
    const i = y * mw + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < mw - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
    if (y < mh - 1 && d[i + mw] + 1 < v) v = d[i + mw] + 1;
    d[i] = v;
  }
  return d;
}

/** 4-connected components of cells where `open` holds; returns per-cell component id (-1 = none) and each component's cells. */
function components(open: (i: number) => boolean, mw: number, mh: number, within?: Int32Array): { id: Int32Array; comps: Int32Array[] } {
  const id = new Int32Array(mw * mh).fill(-1);
  const comps: Int32Array[] = [];
  const queue = new Int32Array(mw * mh);
  const starts = within ?? null;
  const total = starts ? starts.length : mw * mh;
  for (let k = 0; k < total; k++) {
    const s = starts ? starts[k] : k;
    if (id[s] >= 0 || !open(s)) continue;
    const c = comps.length;
    let head = 0, tail = 0;
    queue[tail++] = s; id[s] = c;
    while (head < tail) {
      const i = queue[head++];
      const x = i % mw;
      if (x > 0 && id[i - 1] < 0 && open(i - 1)) { id[i - 1] = c; queue[tail++] = i - 1; }
      if (x < mw - 1 && id[i + 1] < 0 && open(i + 1)) { id[i + 1] = c; queue[tail++] = i + 1; }
      if (i >= mw && id[i - mw] < 0 && open(i - mw)) { id[i - mw] = c; queue[tail++] = i - mw; }
      if (i + mw < mw * mh && id[i + mw] < 0 && open(i + mw)) { id[i + mw] = c; queue[tail++] = i + mw; }
    }
    comps.push(queue.slice(0, tail));
  }
  return { id, comps };
}

/** Is the point inside a ring (image px)? */
function inRing(x: number, y: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The remaining floor of one sheet, as zones. */
export function coverZones(inp: CoverInput): CoverResult {
  const { walls: mo, pxPerM, labels } = inp;
  const { mw, mh, ws } = mo;
  const N = mw * mh;
  const cellM2 = 1 / (ws * ws * pxPerM * pxPerM);
  const state = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (mo.mask[i] & 1) state[i] = WALL;
  for (const ring of inp.measured) fillRing(state, mw, mh, ws, ring, TAKEN);
  // walls stay walls where a measured outline overlaps them: a trace on the
  // wall face must not turn the wall into "measured" floor
  for (let i = 0; i < N; i++) if (mo.mask[i] & 1) state[i] = WALL;

  // sliver opening: free cells within r of a non-free cell that no wider free
  // floor reaches are the trace's slack along a wall, not floor
  const r = Math.max(1, Math.round(SLIVER_M * pxPerM * ws));
  const dIn = distFrom((i) => state[i] !== FREE, mw, mh);
  const dCore = distFrom((i) => dIn[i] > r, mw, mh);
  const free = (i: number) => state[i] === FREE && dCore[i] <= r;

  const measuredLabels: number[] = [];
  const open: number[] = [];
  labels.forEach((l, k) => (inp.measured.some((ring) => inRing(l.x, l.y, ring)) ? measuredLabels : open).push(k));

  const { id, comps } = components(free, mw, mh);
  // a label's cell: the free cell nearest its centre, within its own text height
  const cellOf = (l: CoverLabel): number => {
    const cx = Math.round(l.x * ws), cy = Math.round(l.y * ws);
    const R = Math.max(2, Math.ceil(1.5 * l.h * ws));
    let best = -1, bd = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
      const i = y * mw + x;
      if (id[i] < 0) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const labelCell = new Map<number, number>();
  const byComp = new Map<number, number[]>();
  for (const k of open) {
    const c = cellOf(labels[k]);
    if (c < 0) continue;
    labelCell.set(k, c);
    const list = byComp.get(id[c]) ?? [];
    list.push(k);
    byComp.set(id[c], list);
  }

  const zoneOf = (cells: Int32Array, labs: number[]): CoverZone => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, edge = false;
    for (const i of cells) {
      const x = i % mw, y = (i / mw) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === mw - 1 || y === mh - 1) edge = true;
    }
    const m2 = cells.length * cellM2;
    const at = labs.length ? [labels[labs[0]].x, labels[labs[0]].y] as Point : [cells[cells.length >> 1] % mw / ws, ((cells[cells.length >> 1] / mw) | 0) / ws] as Point;
    return { cells, labels: labs, m2, leaks: edge || m2 > inp.leakM2, wallShare: 0, at, bbox: [x0 / ws, y0 / ws, (x1 + 1) / ws, (y1 + 1) / ws] };
  };

  const zones: CoverZone[] = [];
  const unlabeledRaw: CoverZone[] = [];
  comps.forEach((cells, c) => {
    const labs = byComp.get(c) ?? [];
    if (!labs.length) {
      if (cells.length * cellM2 >= MIN_PIECE_M2) unlabeledRaw.push(zoneOf(cells, []));
      return;
    }
    const z = zoneOf(cells, labs);
    if (!inp.cuts) { zones.push(labs.length > 1 ? { ...z, unsplit: true } : z); return; }
    const leaksAt = (piece: Int32Array) => zoneOf(piece, []).leaks;
    for (const p of splitZone(z, inp.cuts, labelCell, mw, mh, leaksAt)) {
      const pz = { ...zoneOf(p.cells, p.labels), mergedM2: p.merged * cellM2, ...(p.unsplit ? { unsplit: true } : {}) };
      if (p.labels.length) zones.push(pz);
      else if (pz.m2 >= MIN_PIECE_M2) unlabeledRaw.push(pz);
    }
  });

  // wall share: of a zone's boundary cells, those that face wall ink or a measured room
  const owner = new Int32Array(N).fill(-1);
  zones.forEach((z, k) => { for (const i of z.cells) owner[i] = k; });
  zones.forEach((z, k) => {
    let bound = 0, walled = 0;
    for (const i of z.cells) {
      const x = i % mw;
      const nb = [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, i - mw, i + mw];
      let edge = false, wall = false;
      for (const j of nb) {
        if (j < 0 || j >= N) { edge = true; continue; }
        if (owner[j] === k) continue;
        edge = true;
        // across the sliver band: look a few cells further for wall or measured floor
        if (state[j] === WALL || state[j] === TAKEN || nearBound(j, i, state, mw, mh, r + 1)) wall = true;
      }
      if (edge) { bound++; if (wall) walled++; }
    }
    z.wallShare = bound ? walled / bound : 0;
  });

  // enclosed floor with no label, inside the building: the footprint is the
  // measured and labelled floor closed over FOOTPRINT_CLOSE_M, plus the wall
  // network that floor touches (so a space at the building's edge, walled in,
  // is inside), holes filled
  const unlabeled: CoverZone[] = [];
  if (unlabeledRaw.length) {
    const inB = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (state[i] === TAKEN) inB[i] = 1;
    for (const z of zones) if (!z.leaks) for (const i of z.cells) inB[i] = 1;
    const R = Math.round(FOOTPRINT_CLOSE_M * pxPerM * ws);
    const dB = distFrom((i) => !!inB[i], mw, mh);
    const dOut = distFrom((i) => dB[i] > R, mw, mh);
    // the building's walls: wall ink touching measured or labelled floor, and all wall ink joined to it
    const bw = new Uint8Array(N);
    const wq = new Int32Array(N);
    let wh = 0, wt = 0;
    for (let i = 0; i < N; i++) if (state[i] === WALL && dB[i] <= r + 1) { bw[i] = 1; wq[wt++] = i; }
    while (wh < wt) {
      const i = wq[wh++], x = i % mw, y = (i / mw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= mw || yy >= mh) continue;
        const j = yy * mw + xx;
        if (!bw[j] && state[j] === WALL) { bw[j] = 1; wq[wt++] = j; }
      }
    }
    const closed = (i: number) => dOut[i] > R || !!bw[i];
    // holes: what the sheet edge cannot reach without crossing the closed footprint
    const outside = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (i: number) => { if (!outside[i] && !closed(i)) { outside[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < mw; x++) { push(x); push((mh - 1) * mw + x); }
    for (let y = 0; y < mh; y++) { push(y * mw); push(y * mw + mw - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % mw;
      if (x > 0) push(i - 1); if (x < mw - 1) push(i + 1); if (i >= mw) push(i - mw); if (i + mw < N) push(i + mw);
    }
    const halfWidth = (MIN_PIECE_WIDTH_M / 2) * pxPerM * ws;
    for (const z of unlabeledRaw) {
      if (z.leaks) continue;
      let widest = 0;
      for (const i of z.cells) if (dIn[i] > widest) widest = dIn[i];
      if (widest < halfWidth) continue;
      let inside = 0;
      for (const i of z.cells) if (!outside[i]) inside++;
      if (inside >= 0.8 * z.cells.length) unlabeled.push(z);
    }
  }
  return { zones, unlabeled, measuredLabels, mw, mh, ws };
}

/** Is there wall or measured floor within `reach` cells of j, looking away from i? */
function nearBound(j: number, i: number, state: Uint8Array, mw: number, mh: number, reach: number): boolean {
  const dx = (j % mw) - (i % mw), dy = ((j / mw) | 0) - ((i / mw) | 0);
  let x = j % mw, y = (j / mw) | 0;
  for (let s = 0; s < reach; s++) {
    x += dx; y += dy;
    if (x < 0 || y < 0 || x >= mw || y >= mh) return false;
    const v = state[y * mw + x];
    if (v === WALL || v === TAKEN) return true;
    if (v === FREE) return false;
  }
  return false;
}

/** Split one multi-label zone at the drawn cuts inside it. Pieces with no
 *  label fold into the single labelled piece they touch, round after round; a
 *  piece touching two labelled pieces stays apart. A labelled piece that
 *  still holds several labels is returned `unsplit`. Cut cells go to a
 *  neighbouring piece, so the pieces tile the zone. */
function splitZone(z: CoverZone, cuts: Uint8Array, labelCell: Map<number, number>, mw: number, mh: number,
  leaksAt: (cells: Int32Array) => boolean): { cells: Int32Array; labels: number[]; merged: number; unsplit?: boolean }[] {
  const inZone = new Uint8Array(mw * mh);
  let anyCut = false;
  for (const i of z.cells) { inZone[i] = cuts[i] ? CUT : 1; if (cuts[i]) anyCut = true; }
  const whole = [{ cells: z.cells, labels: z.labels, merged: 0, ...(z.labels.length > 1 ? { unsplit: true } : {}) }];
  if (!anyCut) return whole;
  const { id, comps } = components((i) => inZone[i] === 1, mw, mh, z.cells);
  if (comps.length < 2) return whole;
  const group = comps.map((_, k) => k);
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
  const labs = comps.map(() => [] as number[]);
  for (const k of z.labels) {
    let c = labelCell.get(k)!;
    if (id[c] < 0) {   // the label's cell is on a cut line: the nearest piece
      const x = c % mw, y = (c / mw) | 0;
      outer: for (let R = 1; R < 12; R++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < mw && yy < mh && id[yy * mw + xx] >= 0) { c = yy * mw + xx; break outer; }
      }
    }
    if (id[c] >= 0) labs[id[c]].push(k);
  }
  // adjacency across cut cells (a cut line is a few cells wide)
  const adj = comps.map(() => new Set<number>());
  const W = 3;
  for (const i of z.cells) {
    if (inZone[i] !== CUT) continue;
    const x = i % mw, y = (i / mw) | 0;
    const seen: number[] = [];
    for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= mw || yy >= mh) continue;
      const c = id[yy * mw + xx];
      if (c >= 0 && !seen.includes(c)) seen.push(c);
    }
    for (const a of seen) for (const b of seen) if (a !== b) adj[a].add(b);
  }
  const hasLabel = comps.map((_, k) => labs[k].length > 0);
  // the outside never folds into a room: a piece open to the sheet edge, or larger than any room, stays apart
  const outside = comps.map((c, k) => !hasLabel[k] && leaksAt(c));
  const labelled = (g: number) => hasLabel[g];
  const outsideGroup = (g: number) => outside[g];   // an outside piece never joins a group, so it stays its own root
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra === rb) return; group[ra] = rb; hasLabel[rb] = hasLabel[rb] || hasLabel[ra]; };
  for (let changed = true, rounds = 0; changed && rounds < 200; rounds++) {
    changed = false;
    // per unlabelled group: the labelled groups it touches
    const touch = new Map<number, Set<number>>();
    for (let k = 0; k < comps.length; k++) {
      const g = find(k);
      if (labelled(g) || outside[k]) continue;
      const t = touch.get(g) ?? new Set<number>();
      for (const o of adj[k]) { const og = find(o); if (og !== g && labelled(og)) t.add(og); }
      touch.set(g, t);
    }
    for (const [g, t] of touch) if (t.size === 1 && !outsideGroup(g)) { union(g, [...t][0]); changed = true; }
    // unlabelled groups touching no labelled group but each other: join them so they can reach one
    if (!changed) {
      for (let k = 0; k < comps.length && !changed; k++) {
        const g = find(k);
        if (labelled(g) || outside[k] || (touch.get(g)?.size ?? 0) > 0) continue;
        for (const o of adj[k]) { const og = find(o); if (og !== g && !labelled(og) && !outside[o] && (touch.get(og)?.size ?? 0) <= 1) { union(g, og); changed = true; break; } }
      }
    }
  }
  const out = new Map<number, { cells: number[]; labels: number[]; merged: number }>();
  comps.forEach((cells, k) => {
    const g = find(k);
    const o = out.get(g) ?? { cells: [], labels: [], merged: 0 };
    for (const i of cells) o.cells.push(i);
    o.labels.push(...labs[k]);
    if (!labs[k].length) o.merged += cells.length;
    out.set(g, o);
  });
  // cut cells to the neighbouring group with the most contact
  for (const i of z.cells) {
    if (inZone[i] !== CUT) continue;
    const x = i % mw, y = (i / mw) | 0;
    let best = -1, bd = Infinity;
    for (let dy = -W; dy <= W; dy++) for (let dx = -W; dx <= W; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= mw || yy >= mh) continue;
      const c = id[yy * mw + xx];
      const d = dx * dx + dy * dy;
      if (c >= 0 && d < bd) { bd = d; best = find(c); }
    }
    if (best >= 0) { const o = out.get(best)!; o.cells.push(i); o.merged++; }
  }
  return [...out.values()].map((o) => ({ cells: Int32Array.from(o.cells), labels: o.labels, merged: o.labels.length ? o.merged : 0, ...(o.labels.length > 1 ? { unsplit: true } : {}) }));
}

/** The drawn zone boundaries of a sheet, as mask cells: straight lines that are
 *  not walls, run wall to wall (each end within CUT_LAND_M of wall ink or of
 *  another such line) and cross no wall on the way — a finish edge, a zone
 *  line, a counter front. Grid axes, section markers and dimension lines cross
 *  walls and are left out. Plus the openings between two collinear wall ends
 *  facing each other across OPENING_MIN_M..OPENING_MAX_M of clear floor.
 *  `wallSeg`: per segment, 1 = the segment is wall (drawn into `walls`); `skip`: 1 = not drawn on this
 *  plan (a hidden or demolition layer), never a boundary. */
export function zoneCuts(segs: ArrayLike<number>, meta: ArrayLike<number>, wallSeg: ArrayLike<number>, walls: MaskObj, pxPerM: number, skip?: ArrayLike<number> | null): Uint8Array {
  const { mw, mh, ws } = walls;
  const cuts = new Uint8Array(mw * mh);
  const hard = (x: number, y: number) => {
    const mx = Math.round(x * ws), my = Math.round(y * ws);
    return mx >= 0 && my >= 0 && mx < mw && my < mh && !!(walls.mask[my * mw + mx] & 1);
  };
  const land = CUT_LAND_M * pxPerM;
  const wallNear = (x: number, y: number) => {
    const R = Math.max(1, Math.ceil(land * ws));
    const cx = Math.round(x * ws), cy = Math.round(y * ws);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const mx = cx + dx, my = cy + dy;
      if (mx >= 0 && my >= 0 && mx < mw && my < mh && walls.mask[my * mw + mx] & 1) return true;
    }
    return false;
  };
  const plot = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * ws * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mx = Math.round((x0 + (x1 - x0) * t) * ws), my = Math.round((y0 + (y1 - y0) * t) * ws);
      for (const [ax, ay] of [[mx, my], [mx + 1, my], [mx, my + 1]]) if (ax >= 0 && ay >= 0 && ax < mw && ay < mh) cuts[ay * mw + ax] = 1;
    }
  };
  const crossesWall = (x0: number, y0: number, x1: number, y1: number, skip: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L <= 2 * skip) return false;
    const steps = Math.max(2, Math.ceil(L * ws));
    for (let s = 0; s <= steps; s++) {
      const d = (s / steps) * L;
      if (d < skip || d > L - skip) continue;
      if (hard(x0 + ((x1 - x0) * d) / L, y0 + ((y1 - y0) * d) / L)) return true;
    }
    return false;
  };

  // 1. drawn lines running wall to wall
  const n = segs.length >> 2;
  const minLen = CUT_MIN_M * pxPerM;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (wallSeg[i] || skip?.[i] || meta[i] & (SEG_CURVE | SEG_CLIP)) continue;
    const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
    if (Math.hypot(x1 - x0, y1 - y0) < minLen) continue;
    if (hard((x0 + x1) / 2, (y0 + y1) / 2) || crossesWall(x0, y0, x1, y1, land)) continue;
    cand.push(i);
  }
  // ends: on a wall, or on an accepted line's end (an L-shaped boundary drawn in pieces)
  const endKey = (x: number, y: number) => `${Math.round(x / land)},${Math.round(y / land)}`;
  const onWall = new Map<number, [boolean, boolean]>();
  for (const i of cand) onWall.set(i, [wallNear(segs[4 * i], segs[4 * i + 1]), wallNear(segs[4 * i + 2], segs[4 * i + 3])]);
  const accepted = new Set<number>();
  const ends = new Set<string>();
  const nearEnd = (x: number, y: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (ends.has(`${Math.round(x / land) + dx},${Math.round(y / land) + dy}`)) return true;
    return false;
  };
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const i of cand) {
      if (accepted.has(i)) continue;
      const [a, b] = onWall.get(i)!;
      const ok = (a || nearEnd(segs[4 * i], segs[4 * i + 1])) && (b || nearEnd(segs[4 * i + 2], segs[4 * i + 3]));
      // a line with one end on a wall and the other on nothing yet may be the first piece of a chain: seed only from wall-to-wall lines
      if (!ok) continue;
      accepted.add(i); grew = true;
      ends.add(endKey(segs[4 * i], segs[4 * i + 1])); ends.add(endKey(segs[4 * i + 2], segs[4 * i + 3]));
    }
    if (!grew) break;
    // pieces with one wall end whose other end meets another such piece
    for (const i of cand) {
      if (accepted.has(i)) continue;
      const [a, b] = onWall.get(i)!;
      if (a || b) { ends.add(endKey(segs[4 * i], segs[4 * i + 1])); ends.add(endKey(segs[4 * i + 2], segs[4 * i + 3])); }
    }
  }
  for (const i of accepted) plot(segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);

  // 2. openings between collinear wall ends
  const minGap = OPENING_MIN_M * pxPerM, maxGap = OPENING_MAX_M * pxPerM, lat = OPENING_LATERAL_M * pxPerM;
  type End = { x: number; y: number; ux: number; uy: number };
  const wEnds: End[] = [];
  for (let i = 0; i < n; i++) {
    if (!wallSeg[i] || meta[i] & (SEG_CURVE | SEG_CLIP)) continue;
    const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < minLen) continue;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    wEnds.push({ x: x1, y: y1, ux, uy }, { x: x0, y: y0, ux: -ux, uy: -uy });
  }
  const G = maxGap;
  const grid = new Map<string, number[]>();
  wEnds.forEach((e, k) => { const key = `${Math.floor(e.x / G)},${Math.floor(e.y / G)}`; const b = grid.get(key); if (b) b.push(k); else grid.set(key, [k]); });
  const pairs: [number, number, number][] = [];
  wEnds.forEach((a, i) => {
    const gx = Math.floor(a.x / G), gy = Math.floor(a.y / G);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
      if (j <= i) continue;
      const b = wEnds[j];
      if (a.ux * b.ux + a.uy * b.uy > -0.94) continue;
      const vx = b.x - a.x, vy = b.y - a.y, d = Math.hypot(vx, vy);
      if (d < minGap || d > maxGap) continue;
      if ((vx * a.ux + vy * a.uy) / d < 0.94) continue;
      if (Math.abs(vx * -a.uy + vy * a.ux) > lat) continue;
      if (crossesWall(a.x, a.y, b.x, b.y, 0.06 * d)) continue;
      pairs.push([d, i, j]);
    }
  });
  pairs.sort((p, q) => p[0] - q[0]);
  const used = new Set<number>();
  for (const [, i, j] of pairs) {
    if (used.has(i) || used.has(j)) continue;
    used.add(i); used.add(j);
    plot(wEnds[i].x, wEnds[i].y, wEnds[j].x, wEnds[j].y);
  }
  return cuts;
}

/** A zone's outline (image px), traced like a flood region. */
export function zoneRing(z: CoverZone, mw: number, mh: number, ws: number): Point[] {
  const region = new Uint8Array(mw * mh);
  for (const i of z.cells) region[i] = 1;
  return traceRegion({ region, mw, mh, ws });
}

/** Wall-face thickness band (m) and the shortest face that vouches for a wall — wallpairs.ts's defaults. */
const FACE_TMIN_M = 0.07, FACE_TMAX_M = 0.35, FACE_MIN_M = 0.8;
/** Wall ink that joins no other wall and spans less than this (m, bbox diagonal) is a piece of furniture
 *  drawn like a wall — a desk top, a bed, a cabinet — not part of the building's wall network. */
export const WALL_NET_MIN_M = 2.5;

/** Clear the hard cells of wall ink islands smaller than WALL_NET_MIN_M (8-connected), in place. */
export function dropWallIslands(mo: MaskObj, pxPerM: number): number {
  const { mw, mh } = mo;
  const seen = new Uint8Array(mw * mh);
  const queue = new Int32Array(mw * mh);
  const lim = WALL_NET_MIN_M * pxPerM * mo.ws;
  let dropped = 0;
  for (let s = 0; s < mw * mh; s++) {
    if (seen[s] || !(mo.mask[s] & 1)) continue;
    let head = 0, tail = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    queue[tail++] = s; seen[s] = 1;
    while (head < tail) {
      const i = queue[head++], x = i % mw, y = (i / mw) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= mw || yy >= mh) continue;
        const j = yy * mw + xx;
        if (!seen[j] && mo.mask[j] & 1) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (Math.hypot(x1 - x0, y1 - y0) >= lim) continue;
    for (let k = 0; k < tail; k++) mo.mask[queue[k]] = 0;
    dropped++;
  }
  return dropped;
}

/** A filled figure no wider than this (m) is wall poché; a wider one is a floor wash or a symbol. */
const POCHE_MAX_M = FACE_TMAX_M;

/** Per segment, 1 = wall: a straight line with a parallel partner at wall
 *  thickness on ONE side (wallpairs.ts's pairing), or the outline of a filled
 *  figure no wider than a wall. A line with partners on BOTH sides sits in a
 *  regular field — stair treads, hatch, a slatted screen — and is not a wall;
 *  nor is the end line of such a field, whose one partner is a field member at
 *  the field's own pitch. Everything the mask draws that is not wall is a
 *  drawn line the floor can be split at, never a boundary on its own. */
export function wallFaceSegs(segs: ArrayLike<number>, meta: ArrayLike<number>, subpaths: { i0: number; i1: number; x0: number; y0: number; x1: number; y1: number; flags: number }[] | undefined, pxPerM: number, fillOnlyBit: number): Uint8Array {
  const n = segs.length >> 2;
  const minLen = FACE_MIN_M * pxPerM, maxOff = FACE_TMAX_M * pxPerM, minOff = FACE_TMIN_M * pxPerM;
  const sinTol = Math.sin((1.5 * Math.PI) / 180);
  const cell = Math.max(maxOff * 2, 1), grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (meta[i] & (SEG_CURVE | SEG_CLIP)) continue;
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
  // signed offsets of each line's partners, measured along its own normal
  const partners = new Map<number, { j: number; off: number }[]>();
  const add = (i: number, j: number, off: number) => { const l = partners.get(i); if (l) l.push({ j, off }); else partners.set(i, [{ j, off }]); };
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
      const off = mx * -uy + my * ux;
      if (Math.abs(off) < minOff || Math.abs(off) > maxOff) continue;
      const t0 = (segs[4 * j] - ax) * ux + (segs[4 * j + 1] - ay) * uy, t1 = (segs[4 * j + 2] - ax) * ux + (segs[4 * j + 3] - ay) * uy;
      if (Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) < minLen) continue;
      // j's normal may point either way; its offset to i is measured on i's axis with i's sign flipped
      add(i, j, off);
      const jux = ex / M, juy = ey / M;
      add(j, i, -off * Math.sign(ux * jux + uy * juy || 1));
    }
  }
  const field = new Uint8Array(n);
  for (const [i, l] of partners) if (l.some((p) => p.off > 0) && l.some((p) => p.off < 0)) field[i] = 1;
  // the end lines of a field: partnered only with field members, at the field's pitch
  const pitchOf = (i: number) => Math.min(...(partners.get(i) ?? []).map((p) => Math.abs(p.off)));
  const ends: number[] = [];
  for (const [i, l] of partners) {
    if (field[i]) continue;
    if (l.every((p) => field[p.j] && Math.abs(Math.abs(p.off) - pitchOf(p.j)) <= 0.25 * pitchOf(p.j))) ends.push(i);
  }
  for (const i of ends) field[i] = 1;
  const wall = new Uint8Array(n);
  for (const [i] of partners) if (!field[i]) wall[i] = 1;
  for (const sp of subpaths ?? []) {
    if (!(sp.flags & fillOnlyBit)) continue;
    if (Math.min(sp.x1 - sp.x0, sp.y1 - sp.y0) > POCHE_MAX_M * pxPerM) continue;
    for (let i = sp.i0; i < sp.i1; i++) if (!(meta[i] & SEG_CLIP)) wall[i] = 1;
  }
  return wall;
}
