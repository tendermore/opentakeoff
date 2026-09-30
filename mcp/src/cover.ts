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
import { coverZones, zoneCuts, zoneRing, zoneRectAt, wallFaceSegs, dropWallIslands, type CoverLabel, type CoverZone } from "../../web/src/lib/floorcover.ts";
import { RENDER_SCALE } from "../../web/src/lib/sheets.ts";
import { ROLE_CODE, ROLE_HIDDEN } from "../../web/src/lib/layers.ts";
import { printedAreaM2, roomLabelSeeds, isTotalStamp } from "../../web/src/lib/detectRooms.ts";
import { findDoorSeals, sealDoorways } from "../../web/src/lib/doorseal.ts";
import { closedMetrics, pointInPoly } from "../../web/src/lib/geometry.js";
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
/** A zone filling less of its extent than this (an L-shaped corridor, a hall round a core) is clouded where its
 *  labels are, not over its whole extent, which would lie over the rooms measured inside it. */
const CLOUD_FILL = 0.5;
/** Unlabelled pieces smaller than this (m²) are listed, not clouded. */
const CLOUD_MIN_M2 = 1;

/** Per segment, 1 = a wall face (wallFaceSegs) among the ink `mask` stops a flood at — cached per mask. */
const wallSegCache = new WeakMap<MaskObj, Uint8Array>();
export function wallSegsIn(geo: VectorGeometry, mask: MaskObj, pxPerM: number, roles: Uint8Array | null): Uint8Array {
  let out = wallSegCache.get(mask);   // a mask is built for one set of layer roles, so it keys them too
  if (out) return out;
  const { segs, meta, subpaths } = geo;
  const gone = notDrawn(roles, segs.length >> 2);
  const faces = wallFaceSegs(segs, meta, subpaths, pxPerM, SEG_FILLONLY, gone);
  const hard = (x: number, y: number) => {
    const mx = Math.round(x * mask.ws), my = Math.round(y * mask.ws);
    return mx >= 0 && my >= 0 && mx < mask.mw && my < mask.mh && !!(mask.mask[my * mask.mw + mx] & 1);
  };
  out = new Uint8Array(segs.length >> 2);
  for (let i = 0; i < out.length; i++) if (faces[i] && hard((segs[4 * i] + segs[4 * i + 2]) / 2, (segs[4 * i + 1] + segs[4 * i + 3]) / 2)) out[i] = 1;
  wallSegCache.set(mask, out);
  return out;
}

/** Per segment, 1 = not drawn on this plan: a layer the sheet (or the caller's override) hides, or one the
 *  engine's layer-role table (layers.ts: AIA / NS 3451 conventions, the same the flood mask reads) calls
 *  demolition. An unlayered sheet has no roles and nothing is skipped. */
function notDrawn(roles: Uint8Array | null, n: number): Uint8Array | null {
  if (!roles) return null;
  const gone = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (roles[i] === ROLE_HIDDEN || roles[i] === ROLE_CODE.demolition) gone[i] = 1;
  return gone;
}

/** A rough outline (a vision model's drawing) with each edge moved onto a wall face it parallels within
 *  SNAP_WALL_M (edgesnap.ts, wall faces only). Two readings: the nearest face, and the room-side face
 *  (the outline drawn on or across the wall). Where the sheet prints the room's area inside the outline,
 *  the reading that agrees with it wins — the outline as drawn first, so a snap never spoils an outline
 *  that already agrees; otherwise the nearest face. Returns the outline and how many vertices moved. */
export const SNAP_WALL_M = 0.3;
export type SnapReading = "as_drawn" | "nearest_face" | "room_side_face";
export function snapToWalls(ring: Point[], geo: VectorGeometry, mask: MaskObj, pxPerM: number, printedInside: number[], roles: Uint8Array | null, tolPx = SNAP_WALL_M * pxPerM): { ring: Point[]; moved: number; reading: SnapReading; agrees: boolean | null } {
  const allowed = wallSegsIn(geo, mask, pxPerM, roles);
  const snap = (prefer: "nearest" | "inward") => snapEdges(ring, geo.segs, geo.meta, pxPerM, tolPx, { allowed, prefer }) as Point[];
  const m2 = (r: Point[]) => ringArea(r) / (pxPerM * pxPerM);
  const nearest = snap("nearest");
  let out = nearest, reading: SnapReading = "nearest_face", agrees: boolean | null = null;
  if (printedInside.length) {
    const agree = (r: Point[]) => printedInside.some((p) => printedAgrees(m2(r), p));
    const readings: [Point[], SnapReading][] = [[ring, "as_drawn"], [nearest, "nearest_face"], [snap("inward"), "room_side_face"]];
    const hit = readings.find(([r]) => agree(r));
    if (hit) [out, reading] = hit;
    agrees = !!hit;
  }
  let moved = 0;
  for (let e = 0; e < ring.length; e++) if (Math.hypot(out[e][0] - ring[e][0], out[e][1] - ring[e][1]) > 0.5) moved++;
  return { ring: out, moved, reading, agrees };
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
  /** the closed-leaf chord of every door on the sheet (doors.ts), image px: what joins an unlabelled piece to measured
   *  floor. Absent or null where no doors could be read; then every unlabelled piece is reported. */
  doors?: [Point, Point][] | null;
  /** commit one zone (Session.commit + label); throws UserError on refusal */
  commit: (ring: Point[], areaSf: number, perimLf: number, seed: Point, label: string, combined?: boolean) => { id: string; check?: string };
}

/** Why a room label is flagged, stable for callers that word it themselves (the reason says it in English). */
export type CoverCode =
  | "open_to_outside" | "unplaced_label" | "untraceable" | "surrounds_void" | "label_outside_outline"
  | "area_differs" | "several_printed_sum_differs" | "several_labels_no_printed_area" | "total_stamp_inside"
  | "too_small" | "off_drawn_walls" | "not_walled" | "overlaps_measured" | "refused" | "ready_to_commit";

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
  /** flagged: the reason as a stable code */
  code?: CoverCode;
  /** the outline traced from the zone, m², where the reason compares it */
  outline_m2?: number;
  /** several printed areas in one zone: their sum, m² */
  sum_m2?: number;
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
    const total = isTotalStamp(text);
    const m2 = total ? -1 : printedAreaM2(text);
    if (m2 == null) continue;
    const x = (sp.x0 + sp.x1) / 2, y = (sp.y0 + sp.y1) / 2;
    if (stamps.some((t) => Math.abs(t.x - x) < 4 && Math.abs(t.y - y) < 4)) continue;   // PDFs draw text twice
    stamps.push({ text, m2, x, y, h: Math.max(1, sp.y1 - sp.y0) });
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

/** What cover would cloud on the marked plan: the flagged rooms of one zone (or the part of it round them), or
 *  one unlabelled piece a door or an opening reaches. rect: image px. */
export interface CoverCloud {
  kind: "not_measured" | "no_label";
  rect: [number, number, number, number];
  rooms?: CoverRoom[];
  piece?: { m2: number; at: [number, number] };
}
const overlapShare = (a: number[], b: number[]) => {
  const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return i / Math.max(1e-9, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])));
};

/** A commit refusal's code, from the UserError's own prefix (session.ts). */
function refusalCode(message: string): CoverCode {
  if (message.startsWith("OVERLAPS_MEASURED")) return "overlaps_measured";
  if (message.startsWith("PRINTED_AREA_DISAGREES")) return "area_differs";
  if (message.startsWith("OFF_DRAWN_WALLS")) return "off_drawn_walls";
  return "refused";
}
const roundNums = (n: { outline_m2?: number; sum_m2?: number }) => ({
  ...(n.outline_m2 !== undefined ? { outline_m2: round2(n.outline_m2) } : {}),
  ...(n.sum_m2 !== undefined ? { sum_m2: round2(n.sum_m2) } : {}),
});

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
    const gone = notDrawn(sh.roles, n);
    const wallSeg = wallSegsIn(sh.geo, M, pxPerM, sh.roles);
    const ws: number[] = [];
    for (let i = 0; i < n; i++) if (wallSeg[i]) ws.push(segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);
    const pxPerFt = 1 / sh.upp;
    const bare = buildMask(ws, sh.widthPx, sh.heightPx, MASK_MAX_DIM, null, pxPerFt, pxPerFt,
      { pageW: sh.widthPt, pageH: sh.heightPt, renderScale: RENDER_SCALE, baseScale: RENDER_SCALE }, null);
    dropWallIslands(bare, pxPerM);
    walls = sealDoorways(bare, findDoorSeals(segs, meta, M, pxPerFt)).mo;
    if (walls.mw !== M.mw || walls.mh !== M.mh) throw new Error("cover: wall and ink masks on different grids");
    cuts = zoneCuts(segs, meta, wallSeg, walls, pxPerM, gone);
    for (let i = 0; i < cuts.length; i++) if (M.mask[i] & 1 && !(walls.mask[i] & 1)) cuts[i] = 1;
  }
  const texts = sh.spans.filter((sp) => (sp.str || "").trim()).map((sp) => [(sp.x0 + sp.x1) / 2, (sp.y0 + sp.y1) / 2] as Point);
  const res = coverZones({ walls, cuts, measured: sh.measured.map((m) => m.ring), labels, pxPerM, leakM2, doors: sh.doors ?? null, texts });
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
    const hit = sh.measured.find((m) => pointInPoly(l.x, l.y, m.ring));
    rooms.push({ label: l.text, ...named(k), ...printedOf(k), status: "measured", ...(hit ? { shape_id: hit.id } : {}), at: pt([l.x, l.y]) });
  }
  let flaggedM2 = 0;
  const flaggedIn = new Map<CoverZone, number[]>();   // zone → indices into rooms, for the clouds
  const flag = (k: number, z: CoverZone | null, reason: string, code: CoverCode, nums: { outline_m2?: number; sum_m2?: number } = {}) => {
    if (z) flaggedIn.set(z, [...(flaggedIn.get(z) ?? []), rooms.length]);
    rooms.push({ label: labels[k].text, ...named(k), ...printedOf(k), status: "flagged", ...(z ? { zone_m2: round2(z.m2), walls_pct: Math.round(z.wallShare * 100), bbox: z.bbox.map(round1) as [number, number, number, number] } : {}), reason, code, ...roundNums(nums), at: pt([labels[k].x, labels[k].y]) });
  };
  const assigned = new Set<number>();
  for (const z of res.zones) {
    for (const k of z.labels) assigned.add(k);
    if (!z.leaks) flaggedM2 += z.m2;   // subtracted again below when the zone commits
    const list = z.labels.map((k) => labels[k].text).join(", ");
    if (z.leaks) {
      for (const k of z.labels) flag(k, null, `the floor round this label is open to the outside of the building (${z.labels.length > 1 ? `shared by ${list}` : "an opening the drawing does not close"}) — not a room outline`, "open_to_outside");
      continue;
    }
    // a zone is traced a cell or two inside the wall faces: its edges go onto the faces they parallel
    // (detect_rooms' walls-only path does the same), the reading that agrees with the printed area winning
    const outline = (printed: number[]) => {
      const raw = zoneRing(z, res.mw, res.mh, res.ws);
      const snapped = sh.raster || !sh.snap ? raw : snapVertices(raw, (px, py, d) => sh.nearestSnap(px, py, d), SNAP_TOL);
      return sh.raster || !sh.geo ? snapped : snapToWalls(snapped, sh.geo, sh.mask, pxPerM, printed, sh.roles, ZONE_SNAP_CELLS / res.ws).ring;
    };
    // the outline is the zone's outer edge: floor it surrounds but does not hold (a room, a shaft) would be counted
    const surrounds = (ring: Point[]) => { const e = m2(ringArea(ring)) - z.m2; return e > Math.max(HOLE_M2, HOLE_FRAC * z.m2) ? e : 0; };
    if (z.labels.length > 1) {
      const sum = z.labels.reduce((a, k) => a + (labels[k].m2 ?? 0), 0);
      const why = `zone holds ${z.labels.length} ${stamped ? "printed areas" : "room labels"} (${list}) and nothing drawn separates them`;
      if (!stamped) { for (const k of z.labels) flag(k, z, `${why}; zone ${round2(z.m2)} m² — no printed areas to check a combined zone against`, "several_labels_no_printed_area"); continue; }
      // ONE combined row, when that is honest: every printed area inside is a room's own (no total), all of
      // them sit inside the outline, the outline holds nothing it does not measure, and it agrees with their SUM
      const ring = outline([sum]);
      const traced = ring.length >= 3 ? m2(ringArea(ring)) : 0;
      const refuse: [string, CoverCode] | null = ring.length < 3 ? ["the zone could not be traced to an outline", "untraceable"]
        : res.totals.some((t) => pointInPoly(t.x, t.y, ring)) ? ["a printed total (BRA/BTA …) sits in it, so its printed areas are not all rooms", "total_stamp_inside"]
        : z.labels.some((k) => !pointInPoly(labels[k].x, labels[k].y, ring)) ? ["not every printed area sits inside its outline", "label_outside_outline"]
        : surrounds(ring) ? [`its outline surrounds ${round2(surrounds(ring))} m² that is not part of it`, "surrounds_void"]
        : !printedAgrees(traced, sum) ? [`zone ${round2(traced)} m² does not agree with their sum ${round2(sum)} m²`, "several_printed_sum_differs"] : null;
      const nums = { sum_m2: sum, ...(ring.length >= 3 ? { outline_m2: traced } : {}) };
      if (refuse) { for (const k of z.labels) flag(k, z, `${why}; ${refuse[0]}`, refuse[1], nums); continue; }
      const names = z.labels.map((k) => labels[k].name ?? nameFor(labels[k], sh.spans));
      const label = names.every(Boolean) ? names.join(" + ") : z.labels.map((k) => labels[k].text).join(" + ");
      if (!opts.commit) { for (const k of z.labels) flag(k, z, `${why}; the zone agrees with their sum ${round2(sum)} m² — pass condition to commit it as one combined row`, "ready_to_commit", nums); continue; }
      try {
        const c = sh.commit(ring, round2(ringArea(ring) * sh.upp * sh.upp), round2(closedMetrics(ring).perim * sh.upp), [labels[z.labels[0]].x, labels[z.labels[0]].y], label, true);
        flaggedM2 -= z.m2;
        for (const k of z.labels) rooms.push({ label: labels[k].text, ...named(k), ...printedOf(k), status: "combined", shape_id: c.id, check: c.check, zone_m2: round2(traced), combined_with: z.labels.filter((o) => o !== k).map((o) => labels[o].text), at: pt([labels[k].x, labels[k].y]) });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        for (const k of z.labels) flag(k, z, `${why}; ${error.message.split(". ")[0]}`, refusalCode(error.message), nums);
      }
      continue;
    }
    const k = z.labels[0], l = labels[k];
    // no printed area on a sheet the drawn-walls check applies to (metric): the zone goes onto the walls the way
    // every other outline there does (onWalls), and that check — run by commit() — decides, not cover's own gates
    const walls = !stamped && sh.drawnWalls ? sh.drawnWalls : null;
    const traceRing = outline(l.m2 != null ? [l.m2] : []);
    const ring = walls && traceRing.length >= 3 ? walls.refine(traceRing) : traceRing;
    if (ring.length < 3) { flag(k, z, "zone could not be traced to an outline", "untraceable"); continue; }
    const traced = m2(ringArea(ring));
    const out = { outline_m2: traced };
    const enclosed = surrounds(ring);
    if (enclosed) { flag(k, z, `zone ${round2(z.m2)} m² surrounds ${round2(enclosed)} m² that is not part of it (a room or space inside) — its outline would count that too`, "surrounds_void", out); continue; }
    if (stamped) {
      // the printed area must sit inside the outline it vouches for (commit() checks the same, and a zone
      // that only brushes its label — a thin strip under the text — would commit unverified)
      if (!pointInPoly(l.x, l.y, ring)) { flag(k, z, `the printed ${l.text} sits outside the zone's outline (${round2(traced)} m²) — a strip beside the label, not its room`, "label_outside_outline", out); continue; }
      if (!printedAgrees(traced, l.m2!)) { flag(k, z, `zone ${round2(traced)} m² vs printed ${l.text} — the zone runs past the room or stops short of it`, "area_differs", out); continue; }
    } else if (walls) {
      // the drawn-walls check judges the outline's shape, not whether it is a room's size: a wall cavity or a
      // symbol box follows its "walls" perfectly (0.01 m² pieces did on the no-stamp dev sheets)
      if (traced < MIN_ROOM_M2) { flag(k, z, `zone ${round2(traced)} m² is smaller than a room`, "too_small", out); continue; }
      const w = walls.judge(ring);
      if (!w.pass) { flag(k, z, `zone ${round2(traced)} m²: ${w.reason} — no printed area to check it against`, "off_drawn_walls", out); continue; }
    } else {
      if (traced < MIN_ROOM_M2) { flag(k, z, `zone ${round2(traced)} m² is smaller than a room`, "too_small", out); continue; }
      if (z.wallShare < WALLED_SHARE) { flag(k, z, `zone ${round2(traced)} m² is bounded by walls along only ${Math.round(z.wallShare * 100)}% of its edge — no printed area to check it against`, "not_walled", out); continue; }
    }
    if (!opts.commit) { flag(k, z, stamped ? "zone agrees with the printed area — pass condition to commit it" : "zone passes the walls check — pass condition to commit it", "ready_to_commit", out); continue; }
    const areaSf = round2(ringArea(ring) * sh.upp * sh.upp);
    const perimLf = round2(closedMetrics(ring).perim * sh.upp);
    try {
      const c = sh.commit(ring, areaSf, perimLf, [l.x, l.y], l.text);
      flaggedM2 -= z.m2;
      rooms.push({ label: l.text, ...named(k), ...printedOf(k), status: "committed", shape_id: c.id, ...(c.check ? { check: c.check } : {}), zone_m2: round2(traced), walls_pct: Math.round(z.wallShare * 100), at: pt([l.x, l.y]) });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      flag(k, z, error.message.split(". ")[0], refusalCode(error.message), out);
    }
  }
  labels.forEach((l, k) => {
    if (!assigned.has(k) && !res.measuredLabels.includes(k)) flag(k, null, "the label sits on wall or linework with no floor round it", "unplaced_label");
  });

  const unlabeled = res.unlabeled.slice().sort((a, b) => b.m2 - a.m2);
  const unlabeledM2 = unlabeled.reduce((a, z) => a + z.m2, 0);
  const noAccess = res.noAccess.slice().sort((a, b) => b.m2 - a.m2);
  const noAccessM2 = noAccess.reduce((a, z) => a + z.m2, 0);
  const piece = (z: CoverZone) => ({ m2: round2(z.m2), at: pt(z.at), bbox: z.bbox.map(round1) as [number, number, number, number] });
  // where to cloud (session.ts draws them on mark): a flagged zone once, over its extent; a zone that fills
  // little of its extent round each of its labels instead, labels whose rectangles overlap sharing one
  const clouds: CoverCloud[] = [];
  const rectAt = (z: CoverZone, at: Point) => zoneRectAt(z, at[0], at[1], res.mw, res.mh, res.ws).map(round1) as [number, number, number, number];
  const fills = (z: CoverZone) => z.m2 >= CLOUD_FILL * m2((z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]));
  for (const [z, ks] of flaggedIn) {
    if (fills(z)) { clouds.push({ kind: "not_measured", rect: z.bbox.map(round1) as [number, number, number, number], rooms: ks.map((k) => rooms[k]) }); continue; }
    const mine: CoverCloud[] = [];
    for (const k of ks) {
      const r = rectAt(z, rooms[k].at);
      const same = mine.find((c) => overlapShare(c.rect, r) > 0.5);
      if (same) { same.rect = [Math.min(same.rect[0], r[0]), Math.min(same.rect[1], r[1]), Math.max(same.rect[2], r[2]), Math.max(same.rect[3], r[3])]; same.rooms!.push(rooms[k]); }
      else mine.push({ kind: "not_measured", rect: r, rooms: [rooms[k]] });
    }
    clouds.push(...mine);
  }
  for (const z of unlabeled) if (z.m2 >= CLOUD_MIN_M2) clouds.push({ kind: "no_label", rect: fills(z) ? z.bbox.map(round1) as [number, number, number, number] : rectAt(z, z.at), piece: piece(z) });
  const counts = {
    labels: labels.length,
    measured: rooms.filter((r) => r.status === "measured").length,
    committed: rooms.filter((r) => r.status === "committed").length,
    combined: rooms.filter((r) => r.status === "combined").length,
    flagged: rooms.filter((r) => r.status === "flagged").length,
  };
  return {
    clouds,
    sheet: sh.key,
    labels_by: mode,
    rooms,
    counts,
    unmeasured_floor: {
      in_flagged_zones_m2: round2(Math.max(0, flaggedM2)),
      unlabeled_m2: round2(unlabeledM2),
      unlabeled: unlabeled.slice(0, MAX_PIECES).map((z) => ({ ...piece(z), code: "no_room_label" as const, ...(z.access ? { access: z.access } : {}) })),
      ...(unlabeled.length > MAX_PIECES ? { unlabeled_not_listed: unlabeled.length - MAX_PIECES } : {}),
      no_access_m2: round2(noAccessM2),
      no_access: noAccess.slice(0, MAX_PIECES).map((z) => ({ ...piece(z), code: "no_access" as const })),
      ...(noAccess.length > MAX_PIECES ? { no_access_not_listed: noAccess.length - MAX_PIECES } : {}),
    },
    note: `${counts.measured} room label(s) already measured, ${counts.committed} committed now, ${counts.combined} committed inside combined zones, ${counts.flagged} flagged with a reason. ${stamped ? "A zone commits only when it holds exactly one printed area and agrees with it, or — when nothing is drawn between several rooms — as ONE combined row whose area agrees with the sum of their printed areas (check printed_sum; the split between them is not measured)." : `No printed room areas on this sheet: a zone commits only with one named room number inside it and ${sh.drawnWalls ? "the drawn-walls check passing (check drawn_walls)" : "walls bounding nearly all of it; the drawn-walls check does not apply to a sheet that is not metric (check unverified: units_not_metric)"}.`} Unmeasured floor: ${round2(Math.max(0, flaggedM2))} m² in flagged zones, ${round2(unlabeledM2)} m² enclosed with no room label (unlabelled rooms, stair voids and shafts among them; access says how each is reached — look before measuring).${noAccess.length ? ` ${round2(noAccessM2)} m² in ${noAccess.length} small enclosed piece(s) with no room label, no door or opening touching them and no text (no_access) could not be reached from measured floor — likely shafts or voids; check with view_sheet before dismissing. They are not clouded.` : ""}`,
  };
}

