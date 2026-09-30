// takeoff_rooms {action: "cover"}: measure the floor the room sweep left, and
// say where the rest is (web/src/lib/floorcover.ts does the partition).
//
// Every printed room on the sheet comes back measured, or flagged with the
// reason it was not: nothing is dropped and nothing is forced. A zone is
// committed only through Session.commit, so the printed-area check and the
// double-count refusal (PR #8) run on it exactly as on a detected room. A sheet
// that prints no room areas commits a zone only when its walls vouch for it:
// enclosed, wall on nearly all its boundary, one room number inside, a room's
// size — and the shape says it was not checked against a printed area.
import type { MaskObj, Point, VectorGeometry } from "../../web/src/lib/oneclick.ts";
import { snapVertices, ringArea, buildMask, MASK_MAX_DIM, SEG_FILLONLY } from "../../web/src/lib/oneclick.ts";
import { coverZones, zoneCuts, zoneRing, wallFaceSegs, dropWallIslands, type CoverLabel, type CoverZone } from "../../web/src/lib/floorcover.ts";
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";
import { ROLE_CODE, ROLE_HIDDEN } from "../../web/src/lib/layers.ts";
import { printedAreaM2, roomLabelSeeds, SF_STAMP_RE } from "../../web/src/lib/detectRooms.ts";
import { findDoorSeals, sealDoorways } from "../../web/src/lib/doorseal.ts";
import { closedMetrics } from "../../web/src/lib/geometry.js";
import { M2_PER_SF } from "../../web/src/lib/units.ts";
import { SNAP_TOL } from "../../web/src/lib/takeoffConstants.ts";
import { snapEdges } from "../../web/src/lib/edgesnap.ts";
import type { TextSpan } from "./pdf.ts";
import { UserError, round1, round2 } from "./format.ts";

/** Printed area agrees with a measured one: the engine's own tolerance (checkAgainstPrintedArea, detect_rooms). */
export const printedAgrees = (m2: number, printed: number): boolean => Math.abs(m2 - printed) <= 0.03 * printed + 0.05;
/** No printed area: a zone commits only with wall along this share of its boundary (wallcheck.ts's COVERED)... */
export const WALLED_SHARE = 0.8;
/** ...and at least a room's size (m²). */
export const MIN_ROOM_M2 = 1;
/** An outline may enclose this much (m², or this share) of what is not the zone: columns, a trace's slack. */
const HOLE_M2 = 0.5, HOLE_FRAC = 0.03;
/** How far (mask cells) a zone's edge may move onto a wall face: the trace's own slack (detect_rooms' WALL_SNAP_CELLS). */
const ZONE_SNAP_CELLS = 3;
/** How many unlabelled floor pieces a reply lists (largest first); the total covers all. */
const MAX_PIECES = 30;
/** Stamps prefixed as totals ("BRA 59,7 m²") are not one room's area (checkAgainstPrintedArea's rule). */
const TOTAL_RE = /^[A-ZÆØÅ]{2,4}\s*(?::\s*)?\d/i;
const isTotal = (text: string) => TOTAL_RE.test(text) && !SF_STAMP_RE.test(text);   // "NSF 705" is a room's own area

/** Per segment, 1 = a wall face (wallFaceSegs) among the ink `mask` stops a flood at — cached per mask. */
const wallSegCache = new WeakMap<MaskObj, Uint8Array>();
export function wallSegsIn(geo: VectorGeometry, mask: MaskObj, pxPerM: number): Uint8Array {
  let out = wallSegCache.get(mask);
  if (out) return out;
  const { segs, meta, subpaths } = geo;
  const faces = wallFaceSegs(segs, meta, subpaths, pxPerM, SEG_FILLONLY);
  const hard = (x: number, y: number) => {
    const mx = Math.round(x * mask.ws), my = Math.round(y * mask.ws);
    return mx >= 0 && my >= 0 && mx < mask.mw && my < mask.mh && !!(mask.mask[my * mask.mw + mx] & 1);
  };
  out = new Uint8Array(segs.length >> 2);
  for (let i = 0; i < out.length; i++) if (faces[i] && hard((segs[4 * i] + segs[4 * i + 2]) / 2, (segs[4 * i + 1] + segs[4 * i + 3]) / 2)) out[i] = 1;
  wallSegCache.set(mask, out);
  return out;
}

/** A rough outline (a vision model's drawing) with each edge moved onto a wall face it parallels within
 *  SNAP_WALL_M (edgesnap.ts, wall faces only). Two readings: the nearest face, and the room-side face
 *  (the outline drawn on or across the wall). Where the sheet prints the room's area inside the outline,
 *  the reading that agrees with it wins — the outline as drawn first, so a snap never spoils an outline
 *  that already agrees; otherwise the nearest face. Returns the outline and how many vertices moved. */
export const SNAP_WALL_M = 0.3;
export function snapToWalls(ring: Point[], geo: VectorGeometry, mask: MaskObj, pxPerM: number, printedInside: number[], tolPx = SNAP_WALL_M * pxPerM): { ring: Point[]; moved: number } {
  const allowed = wallSegsIn(geo, mask, pxPerM);
  const snap = (prefer: "nearest" | "inward") => snapEdges(ring, geo.segs, geo.meta, pxPerM, tolPx, { allowed, prefer }) as Point[];
  const m2 = (r: Point[]) => ringArea(r) / (pxPerM * pxPerM);
  const nearest = snap("nearest");
  let out = nearest;
  if (printedInside.length) {
    const agree = (r: Point[]) => printedInside.some((p) => printedAgrees(m2(r), p));
    out = [ring, nearest, snap("inward")].find(agree) ?? nearest;
  }
  let moved = 0;
  for (let e = 0; e < ring.length; e++) if (Math.hypot(out[e][0] - ring[e][0], out[e][1] - ring[e][1]) > 0.5) moved++;
  return { ring: out, moved };
}

/** A room number the sheet graph corroborates (sheetgraph.ts RoomTag), image px. */
export interface RoomTagIn { tag: string; name?: string; bbox: [number, number, number, number] }

/** What cover needs of a sheet and of the session — passed in, so Session keeps its internals private. */
export interface CoverSheet {
  key: string;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  upp: number;
  spans: TextSpan[];
  /** room numbers the sheet graph corroborates on this sheet (used where no room areas are printed) */
  roomTags: RoomTagIn[];
  geo: VectorGeometry | null;
  snap: unknown;
  nearestSnap: (px: number, py: number, d: number) => Point | null;
  /** the mask the sweep floods (layer roles, or the rendered pixels of a scan) */
  mask: MaskObj;
  /** per-segment layer role codes (layers.ts), null on an unlayered sheet: hidden and demolished ink never splits floor */
  roles: Uint8Array | null;
  raster: boolean;
  /** committed floor outlines on the sheet, image px, with ids */
  measured: { id: string; ring: Point[]; label?: string }[];
  /** Metric sheets without printed areas (Session.drawnWallsApply): the drawn-walls check that judges every floor
   * outline there — refine puts a ring onto the walls (onWalls), judge says whether it follows them. Absent
   * elsewhere, where cover's own walled-zone gate stands. */
  drawnWalls?: { refine: (ring: Point[]) => Point[]; judge: (ring: Point[]) => { pass: boolean; reason: string } };
  /** commit one zone (Session.commit + label); throws UserError on refusal */
  commit: (ring: Point[], areaSf: number, perimLf: number, seed: Point, label: string, combined?: boolean) => { id: string; check?: string };
}

export interface CoverRoom {
  label: string;
  name?: string;
  printed_m2?: number;
  /** combined: one row with the other rooms of its open zone (combined_with), checked against their printed sum */
  status: "measured" | "committed" | "combined" | "flagged";
  combined_with?: string[];
  shape_id?: string;
  check?: string;
  zone_m2?: number;
  /** share of the zone's edge that is wall or a measured room, % */
  walls_pct?: number;
  reason?: string;
  at: [number, number];
  /** a flagged zone's extent, image px */
  bbox?: [number, number, number, number];
}

/** The room name printed with a label: the nearest lettered run stacked with it — directly above or
 *  below, within a few text heights, overlapping it across. */
function nameFor(l: CoverLabel, spans: TextSpan[]): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const sp of spans) {
    const str = (sp.str || "").trim();
    if (!/\p{L}{2,}/u.test(str) || printedAreaM2(str) != null) continue;
    const cx = (sp.x0 + sp.x1) / 2, cy = (sp.y0 + sp.y1) / 2;
    const dy = cy - l.y;
    if (Math.abs(dy) < 0.5 * l.h || Math.abs(dy) > 3 * l.h) continue;
    if (sp.x1 < l.x - 2 * l.h || sp.x0 > l.x + 2 * l.h) continue;
    const d = Math.hypot(cx - l.x, dy);
    if (d < bd) { bd = d; best = str; }
  }
  return best;
}

/** The room labels cover assigns zones by: printed area stamps on a sheet that
 *  prints them (the detect_rooms rule: three or more), else room numbers with a
 *  room name drawn with them — the sheet graph's corroborated rooms, and any
 *  room-number run (detect_rooms' own filter) with a name stacked above or
 *  below it. A bare number on a plan is as often a dimension or a keynote, and
 *  without a printed area nothing else vouches for it. */
export function coverLabels(spans: TextSpan[], roomTags: RoomTagIn[] = []): { mode: "printed_areas" | "room_numbers"; labels: CoverLabel[]; totals: CoverLabel[] } {
  const stamps: CoverLabel[] = [];
  for (const sp of spans) {
    const text = (sp.str || "").trim();
    const m2 = printedAreaM2(text);
    if (m2 == null) continue;
    const x = (sp.x0 + sp.x1) / 2, y = (sp.y0 + sp.y1) / 2;
    if (stamps.some((t) => Math.abs(t.x - x) < 4 && Math.abs(t.y - y) < 4)) continue;   // PDFs draw text twice
    stamps.push({ text, m2: isTotal(text) ? -1 : m2, x, y, h: Math.max(1, sp.y1 - sp.y0) });
  }
  if (stamps.length >= 3) return { mode: "printed_areas", labels: stamps.filter((s) => s.m2! > 0), totals: stamps.filter((s) => s.m2! < 0) };
  const labels: CoverLabel[] = [];
  const add = (l: CoverLabel) => { if (!labels.some((t) => Math.abs(t.x - l.x) < 4 && Math.abs(t.y - l.y) < 4)) labels.push(l); };
  for (const r of roomTags) {
    const [x0, y0, x1, y1] = r.bbox;
    add({ text: r.tag, m2: null, x: (x0 + x1) / 2, y: (y0 + y1) / 2, h: Math.max(1, y1 - y0), ...(r.name ? { name: r.name } : {}) });
  }
  const items = spans.map((sp) => ({ str: sp.str, x: (sp.x0 + sp.x1) / 2, y: (sp.y0 + sp.y1) / 2, h: Math.max(1, sp.y1 - sp.y0) }));
  for (const s of roomLabelSeeds(items, { placement: "anchor" })) {
    const it = items.find((i) => i.x === s.seed[0] && i.y === s.seed[1])!;
    const l: CoverLabel = { text: s.str, m2: null, x: it.x, y: it.y, h: it.h };
    const name = /\p{L}{2,}/u.test(it.str) ? it.str.replace(s.str, "").trim() : nameFor(l, spans);
    if (name) add({ ...l, name });
  }
  return { mode: "room_numbers", labels, totals: [] };
}

/** The sheet's remaining floor as zones, with the wall and cut rasters it was split on. */
export function coverPartition(sh: Omit<CoverSheet, "commit" | "nearestSnap" | "snap">) {
  const pxPerM = 1 / (sh.upp * 0.3048);
  const { mode, labels, totals } = coverLabels(sh.spans, sh.roomTags);
  const stamped = mode === "printed_areas";
  // Walls are the lines the drawing pairs at wall thickness (and wall poché) among the
  // ink the room flood stops at; doorways close at their swings. Every other line in
  // that ink (furniture, stairs, swings, glass, single-line zone edges) is a CUT: the
  // floor may be split there, but a piece with no room label folds back into its room.
  const sheetM2 = (sh.widthPx * sh.heightPx) / (pxPerM * pxPerM);
  const leakM2 = stamped ? labels.reduce((a, l) => a + (l.m2 ?? 0), 0) : 0.25 * sheetM2;
  let walls = sh.mask;
  let cuts: Uint8Array | null = null;
  if (sh.geo && !sh.raster) {
    const { segs, meta } = sh.geo;
    const n = segs.length >> 2;
    const M = sh.mask;
    const wallSeg = wallSegsIn(sh.geo, M, pxPerM);
    const ws: number[] = [];
    for (let i = 0; i < n; i++) if (wallSeg[i]) ws.push(segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);
    const pxPerFt = 1 / sh.upp;
    const bare = buildMask(ws, sh.widthPx, sh.heightPx, MASK_MAX_DIM, null, pxPerFt, pxPerFt,
      { pageW: sh.widthPt, pageH: sh.heightPt, renderScale: RENDER_SCALE, baseScale: RENDER_SCALE }, null);
    dropWallIslands(bare, pxPerM);
    walls = sealDoorways(bare, findDoorSeals(segs, meta, M, pxPerFt)).mo;
    if (walls.mw !== M.mw || walls.mh !== M.mh) throw new Error("cover: wall and ink masks on different grids");
    // ink the sheet (or the caller's layer override) hides, or marks demolished, is not drawn on this plan
    const gone = new Uint8Array(n);
    if (sh.roles) for (let i = 0; i < n; i++) if (sh.roles[i] === ROLE_HIDDEN || sh.roles[i] === ROLE_CODE.demolition) gone[i] = 1;
    cuts = zoneCuts(segs, meta, wallSeg, walls, pxPerM, gone);
    for (let i = 0; i < cuts.length; i++) if (M.mask[i] & 1 && !(walls.mask[i] & 1)) cuts[i] = 1;
  }
  const res = coverZones({ walls, cuts, measured: sh.measured.map((m) => m.ring), labels, pxPerM, leakM2 });
  return { mode, labels, stamped, walls, cuts, res: { ...res, totals } };
}

export function coverSheet(sh: CoverSheet, opts: { commit: boolean }) {
  const { mode, labels, stamped, res } = coverPartition(sh);
  const pxPerM = 1 / (sh.upp * 0.3048);
  const m2 = (areaPx2: number) => areaPx2 * sh.upp * sh.upp * M2_PER_SF;
  const pt = (p: Point): [number, number] => [round1(p[0]), round1(p[1])];

  const rooms: CoverRoom[] = [];
  const named = (k: number) => { const n = labels[k].name ?? nameFor(labels[k], sh.spans); return n ? { name: n } : {}; };
  const printedOf = (k: number) => (labels[k].m2 != null ? { printed_m2: labels[k].m2! } : {});
  for (const k of res.measuredLabels) {
    const l = labels[k];
    const hit = sh.measured.find((m) => inRing(l.x, l.y, m.ring));
    rooms.push({ label: l.text, ...named(k), ...printedOf(k), status: "measured", ...(hit ? { shape_id: hit.id } : {}), at: pt([l.x, l.y]) });
  }
  let flaggedM2 = 0;
  const flag = (k: number, z: CoverZone | null, reason: string) => {
    rooms.push({ label: labels[k].text, ...named(k), ...printedOf(k), status: "flagged", ...(z ? { zone_m2: round2(z.m2), walls_pct: Math.round(z.wallShare * 100), bbox: z.bbox.map(round1) as [number, number, number, number] } : {}), reason, at: pt([labels[k].x, labels[k].y]) });
  };
  const assigned = new Set<number>();
  const strays: CoverZone[] = [];
  for (const z of res.zones) {
    if (!z.labels.length) { if (!z.leaks) strays.push(z); continue; }   // a split piece between two rooms
    for (const k of z.labels) assigned.add(k);
    if (!z.leaks) flaggedM2 += z.m2;   // subtracted again below when the zone commits
    const list = z.labels.map((k) => labels[k].text).join(", ");
    if (z.leaks) {
      for (const k of z.labels) flag(k, null, `the floor round this label is open to the outside of the building (${z.labels.length > 1 ? `shared by ${list}` : "an opening the drawing does not close"}) — not a room outline`);
      continue;
    }
    // a zone is traced a cell or two inside the wall faces: its edges go onto the faces they parallel
    // (detect_rooms' walls-only path does the same), the reading that agrees with the printed area winning
    const outline = (printed: number[]) => {
      const raw = zoneRing(z, res.mw, res.mh, res.ws);
      const snapped = sh.raster || !sh.snap ? raw : snapVertices(raw, (px, py, d) => sh.nearestSnap(px, py, d), SNAP_TOL);
      return sh.raster || !sh.geo ? snapped : snapToWalls(snapped, sh.geo, sh.mask, pxPerM, printed, ZONE_SNAP_CELLS / res.ws).ring;
    };
    // the outline is the zone's outer edge: floor it surrounds but does not hold (a room, a shaft) would be counted
    const surrounds = (ring: Point[]) => { const e = m2(ringArea(ring)) - z.m2; return e > Math.max(HOLE_M2, HOLE_FRAC * z.m2) ? e : 0; };
    if (z.labels.length > 1) {
      const sum = z.labels.reduce((a, k) => a + (labels[k].m2 ?? 0), 0);
      const why = `zone holds ${z.labels.length} ${stamped ? "printed areas" : "room labels"} (${list}) and nothing drawn separates them`;
      if (!stamped) { for (const k of z.labels) flag(k, z, `${why}; zone ${round2(z.m2)} m² — no printed areas to check a combined zone against`); continue; }
      // ONE combined row, when that is honest: every printed area inside is a room's own (no total), all of
      // them sit inside the outline, the outline holds nothing it does not measure, and it agrees with their SUM
      const ring = outline([sum]);
      const traced = ring.length >= 3 ? m2(ringArea(ring)) : 0;
      const refuse = ring.length < 3 ? "the zone could not be traced to an outline"
        : res.totals.some((t) => inRing(t.x, t.y, ring)) ? "a printed total (BRA/BTA …) sits in it, so its printed areas are not all rooms"
        : z.labels.some((k) => !inRing(labels[k].x, labels[k].y, ring)) ? "not every printed area sits inside its outline"
        : surrounds(ring) ? `its outline surrounds ${round2(surrounds(ring))} m² that is not part of it`
        : !printedAgrees(traced, sum) ? `zone ${round2(traced)} m² does not agree with their sum ${round2(sum)} m²` : null;
      if (refuse) { for (const k of z.labels) flag(k, z, `${why}; ${refuse}`); continue; }
      const names = z.labels.map((k) => labels[k].name ?? nameFor(labels[k], sh.spans));
      const label = names.every(Boolean) ? names.join(" + ") : z.labels.map((k) => labels[k].text).join(" + ");
      if (!opts.commit) { for (const k of z.labels) flag(k, z, `${why}; the zone agrees with their sum ${round2(sum)} m² — pass condition to commit it as one combined row`); continue; }
      try {
        const c = sh.commit(ring, round2(ringArea(ring) * sh.upp * sh.upp), round2(closedMetrics(ring).perim * sh.upp), [labels[z.labels[0]].x, labels[z.labels[0]].y], label, true);
        flaggedM2 -= z.m2;
        for (const k of z.labels) rooms.push({ label: labels[k].text, ...named(k), ...printedOf(k), status: "combined", shape_id: c.id, check: c.check, zone_m2: round2(traced), combined_with: z.labels.filter((o) => o !== k).map((o) => labels[o].text), at: pt([labels[k].x, labels[k].y]) });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        for (const k of z.labels) flag(k, z, `${why}; ${error.message.split(". ")[0]}`);
      }
      continue;
    }
    const k = z.labels[0], l = labels[k];
    // no printed area on a sheet the drawn-walls check applies to (metric): the zone goes onto the walls the way
    // every other outline there does (onWalls), and that check — run by commit() — decides, not cover's own gates
    const walls = !stamped && sh.drawnWalls ? sh.drawnWalls : null;
    const traceRing = outline(l.m2 != null ? [l.m2] : []);
    const ring = walls && traceRing.length >= 3 ? walls.refine(traceRing) : traceRing;
    if (ring.length < 3) { flag(k, z, "zone could not be traced to an outline"); continue; }
    const traced = m2(ringArea(ring));
    const enclosed = surrounds(ring);
    if (enclosed) { flag(k, z, `zone ${round2(z.m2)} m² surrounds ${round2(enclosed)} m² that is not part of it (a room or space inside) — its outline would count that too`); continue; }
    if (stamped) {
      // the printed area must sit inside the outline it vouches for (commit() checks the same, and a zone
      // that only brushes its label — a thin strip under the text — would commit unverified)
      if (!inRing(l.x, l.y, ring)) { flag(k, z, `the printed ${l.text} sits outside the zone's outline (${round2(traced)} m²) — a strip beside the label, not its room`); continue; }
      if (!printedAgrees(traced, l.m2!)) { flag(k, z, `zone ${round2(traced)} m² vs printed ${l.text} — the zone runs past the room or stops short of it`); continue; }
    } else if (walls) {
      const w = walls.judge(ring);
      if (!w.pass) { flag(k, z, `zone ${round2(traced)} m²: ${w.reason} — no printed area to check it against`); continue; }
    } else {
      if (traced < MIN_ROOM_M2) { flag(k, z, `zone ${round2(traced)} m² is smaller than a room`); continue; }
      if (z.wallShare < WALLED_SHARE) { flag(k, z, `zone ${round2(traced)} m² is bounded by walls along only ${Math.round(z.wallShare * 100)}% of its edge — no printed area to check it against`); continue; }
    }
    if (!opts.commit) {
      rooms.push({ label: l.text, ...named(k), ...printedOf(k), status: "flagged", zone_m2: round2(traced), reason: stamped ? "zone agrees with the printed area — pass condition to commit it" : "zone passes the walls check — pass condition to commit it", at: pt([l.x, l.y]) });
      continue;
    }
    const areaSf = round2(ringArea(ring) * sh.upp * sh.upp);
    const perimLf = round2(closedMetrics(ring).perim * sh.upp);
    try {
      const c = sh.commit(ring, areaSf, perimLf, [l.x, l.y], l.text);
      flaggedM2 -= z.m2;
      rooms.push({ label: l.text, ...named(k), ...printedOf(k), status: "committed", shape_id: c.id, ...(c.check ? { check: c.check } : {}), zone_m2: round2(traced), walls_pct: Math.round(z.wallShare * 100), at: pt([l.x, l.y]) });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      flag(k, z, error.message.split(". ")[0]);
    }
  }
  labels.forEach((l, k) => {
    if (!assigned.has(k) && !res.measuredLabels.includes(k)) flag(k, null, "the label sits on wall or linework with no floor round it");
  });

  const unlabeled = [...res.unlabeled, ...strays].sort((a, b) => b.m2 - a.m2);
  const unlabeledM2 = unlabeled.reduce((a, z) => a + z.m2, 0);
  const counts = {
    labels: labels.length,
    measured: rooms.filter((r) => r.status === "measured").length,
    committed: rooms.filter((r) => r.status === "committed").length,
    combined: rooms.filter((r) => r.status === "combined").length,
    flagged: rooms.filter((r) => r.status === "flagged").length,
  };
  return {
    sheet: sh.key,
    labels_by: mode,
    rooms,
    counts,
    unmeasured_floor: {
      in_flagged_zones_m2: round2(Math.max(0, flaggedM2)),
      unlabeled_m2: round2(unlabeledM2),
      unlabeled: unlabeled.slice(0, MAX_PIECES).map((z) => ({ m2: round2(z.m2), at: pt(z.at), bbox: z.bbox.map(round1) as [number, number, number, number] })),
      ...(unlabeled.length > MAX_PIECES ? { unlabeled_not_listed: unlabeled.length - MAX_PIECES } : {}),
    },
    note: `${counts.measured} room label(s) already measured, ${counts.committed} committed now, ${counts.combined} committed inside combined zones, ${counts.flagged} flagged with a reason. ${stamped ? "A zone commits only when it holds exactly one printed area and agrees with it, or — when nothing is drawn between several rooms — as ONE combined row whose area agrees with the sum of their printed areas (check printed_sum; the split between them is not measured)." : "No printed room areas on this sheet: a zone commits only when walls bound nearly all of it and one room number sits inside; its check says it was not compared with a printed area."} Unmeasured floor: ${round2(Math.max(0, flaggedM2))} m² in flagged zones, ${round2(unlabeledM2)} m² enclosed with no room label (shafts, stair voids and unlabelled rooms among them — look before measuring).`,
  };
}

export function inRing(x: number, y: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
