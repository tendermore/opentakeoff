// measure {kind: "walls"} and count {action: "windows"} — the session glue
// around web/src/lib/walltakeoff.ts. Session passes a narrow host (the sheet's
// geometry, doors, text, schedule tables and a commit hook), so the engine and
// the reply shapes live here and session.ts carries only the wiring.
import { wallTakeoff, MIN_OPENING_M, type WallRun, type WithheldWall } from "../../web/src/lib/walltakeoff.ts";
import type { VectorGeometry, Point } from "../../web/src/lib/oneclick.ts";
import type { Door } from "../../web/src/lib/doors.ts";
import type { ScheduleTable, Bbox } from "../../web/src/lib/sheetgraph.ts";
import type { TextSpan } from "./pdf.ts";
import { sheetDiscipline, wallsRefusedOn, scaleLabels } from "../../web/src/lib/sheetscope.ts";
import { UserError, round1, round2 } from "./format.ts";

const FT_PER_M = 1 / 0.3048;

export interface WallHost {
  sheet: string;
  geo: VectorGeometry;
  /** feet per image px (the sheet's scale) */
  upp: number;
  width: number;
  height: number;
  text: TextSpan[];
  doors: Door[];
  /** schedule tables in the set (for table regions on this sheet and window rows) */
  tables: ScheduleTable[];
  /** the title block's drawing number, when read */
  sheetNumber?: string | null;
  /** true when the sheet is a scan wrapper (a placed image, next to no linework) */
  scan: boolean;
  /** File one run; null when the same tag already holds a run at the same place. */
  commitRun: (tag: string, line: [Point, Point], lengthLf: number, heightFt?: number) => string | null;
  /** File EA markers, skipping a point already filed under the same tag nearby. */
  commitCount: (tag: string, at: Point[]) => { shape_ids: string[]; ea_total: number; skipped: number };
  /** the height a condition already carries (feet), if any */
  heightOf: (tag: string) => number | undefined;
}

export interface WallsOpts { condition?: string; commit?: boolean; height_ft?: number; region?: { x0: number; y0: number; x1: number; y1: number } }

const pt = (p: Point): [number, number] => [round1(p[0]), round1(p[1])];
/** Drafting tolerance between two drawings of one wall type's width. */
const CLASS_TOL_MM = 15;

/** Thickness classes of one sheet: measured widths sorted and cut wherever
 *  consecutive widths differ by more than the drafting tolerance, so a 100 mm
 *  partition read as 95, 100 and 106 is one class. A class is named by its
 *  length-weighted median to the nearest 10 mm. */
export function thicknessClasses(runs: Array<{ thicknessM: number; grossM: number }>): number[] {
  const order = runs.map((r, i) => i).sort((a, b) => runs[a].thicknessM - runs[b].thicknessM);
  const cls = new Array<number>(runs.length).fill(0);
  let group: number[] = [];
  const close = () => {
    if (!group.length) return;
    const total = group.reduce((s, i) => s + runs[i].grossM, 0);
    let acc = 0, med = runs[group[0]].thicknessM;
    for (const i of group) { acc += runs[i].grossM; if (acc >= total / 2) { med = runs[i].thicknessM; break; } }
    for (const i of group) cls[i] = Math.round(med * 100) * 10;
    group = [];
  };
  for (const i of order) {
    const prev = group[group.length - 1];
    // chained against the class's first (thinnest) member, so a slow drift of
    // widths cannot walk one class across several wall types
    if (prev !== undefined && (runs[i].thicknessM - runs[group[0]].thicknessM) * 1000 > 2 * CLASS_TOL_MM) close();
    group.push(i);
  }
  close();
  return cls;
}

function refuseScan(h: WallHost, what: string): void {
  if (h.scan || !(h.geo.segs.length >> 2)) {
    throw new UserError(`${h.sheet} is a raster scan (no vector linework) — ${what} reads wall bands from the drawing's strokes, so it cannot run here and does not guess. Reading a scan needs a raster wall-band detector (threshold, thin, pair edges), which this build does not have: view_sheet the sheet and measure {kind: "length"} the walls by hand.`);
  }
}

/** A sheet of another trade draws its ducts, pipes and runs as line pairs a
 *  wall's width apart, over a faint copy of the architect's walls: refused,
 *  with the words that said so. */
function refuseDiscipline(h: WallHost, what: string): void {
  const d = sheetDiscipline(h.text, h.width, h.height, h.sheetNumber);
  if (!wallsRefusedOn(d.discipline)) return;
  const trade = d.discipline.replace("_", " ");
  throw new UserError(`${h.sheet} reads as a ${trade} sheet (${d.source === "title" ? "title block" : "drawing number"}: "${d.evidence}") — ${what} runs on the architectural plans, because this sheet's line pairs are ${d.discipline === "demolition" ? "walls to be removed" : d.discipline === "structural" ? "the structural drawing's members, not the finished walls" : "its own trade's runs drawn over a copy of the walls"}. Open the architectural plan of the same floor.`);
}

function tableRects(h: WallHost): Array<[number, number, number, number]> {
  return h.tables.filter((t) => t.sheet === h.sheet).map((t) => t.region as unknown as [number, number, number, number]);
}

/** One takeoff per sheet geometry, scale and region: measure walls and count
 *  windows on one sheet read the same bands, so the second call is free. */
const takeoffCache = new WeakMap<VectorGeometry, Map<string, ReturnType<typeof wallTakeoff>>>();

function runTakeoff(h: WallHost, region?: WallsOpts["region"]) {
  const key = `${h.upp}|${region ? [region.x0, region.y0, region.x1, region.y1].join(",") : ""}|${h.doors.length}|${tableRects(h).length}`;
  let perGeo = takeoffCache.get(h.geo);
  if (!perGeo) takeoffCache.set(h.geo, perGeo = new Map());
  const hit = perGeo.get(key);
  if (hit) return hit;
  const pxPerM = FT_PER_M / h.upp;
  const res = wallTakeoff(h.geo, pxPerM, h.width, h.height, {
    exclude: tableRects(h),
    text: h.text,
    doors: h.doors.map((d) => d.opening),
    ...(region ? { region: [region.x0, region.y0, region.x1, region.y1] as [number, number, number, number] } : {}),
    scaleNotes: scaleLabels(h.text, h.width, h.height).map((l) => ({ at: l.at, label: l.label, pxPerM: FT_PER_M / l.upp })),
  });
  perGeo.set(key, res);
  return res;
}

const side = (r: WallRun) => (r.exterior === true ? "EXT" : r.exterior === false ? "INT" : "UNSIDED");

/** NS 3420-1: an opening under this area is not deducted from a measured wall. */
export const NS3420_MIN_DEDUCT_M2 = 0.5;

/** measure {kind: "walls"}: every wall run on a sheet, by thickness class and side. */
export function measureWalls(h: WallHost, opts: WallsOpts) {
  refuseScan(h, "the wall takeoff");
  refuseDiscipline(h, "the wall takeoff");
  const res = runTakeoff(h, opts.region);
  const pxPerM = FT_PER_M / h.upp;
  const prefix = (opts.condition ?? "WALL").trim() || "WALL";
  const cls = thicknessClasses(res.runs);
  const classOf = new Map(res.runs.map((r, i) => [r, cls[i]] as const));
  const classMm = (r: WallRun) => classOf.get(r)!;
  const tagOf = (r: WallRun) => `${prefix} ${side(r)} ${classMm(r)}`;
  // height: stated on the call, or already on the class's condition — never read off a plan
  const heightFor = (tag: string) => opts.height_ft ?? h.heightOf(tag);

  // An opening's height is known only where a window mark resolves to it and
  // the mark's schedule row states a height; then NS 3420-1 decides whether it
  // is deducted (area ≥ 0.5 m²). An opening of unknown height is deducted by
  // its width and says so.
  const win = readWindows(h, res);
  const openingHeightM = new Map<string, number>();
  for (const r of win.resolved) {
    if (r.cand === undefined || win.cands[r.cand].kind === "door") continue;   // a mark at a swing is a door's
    const hMm = scheduleHeightMm(r.row.cells);
    if (hMm) for (const [ri, oi] of win.cands[r.cand].refs) openingHeightM.set(`${ri}|${oi}`, hMm / 1000);
  }
  const runs = res.runs.map((r, ri) => {
    const openings = r.openings.map((o, oi) => {
      const hM = openingHeightM.get(`${ri}|${oi}`);
      const area = hM ? o.widthM * hM : undefined;
      const deducted = area === undefined || area >= NS3420_MIN_DEDUCT_M2;
      return {
        kind: o.kind, width_mm: Math.round(o.widthM * 1000), span: [pt(o.span[0]), pt(o.span[1])] as [number, number][],
        ...(hM ? { height_mm: Math.round(hM * 1000), area_m2: round2(area!) } : {}),
        deducted,
        rule: area === undefined ? "height unknown — deducted by its width (the NS 3420 0.5 m² test needs the opening's height)"
          : deducted ? `${round2(area)} m² ≥ ${NS3420_MIN_DEDUCT_M2} m² — deducted (NS 3420-1)` : `${round2(area)} m² < ${NS3420_MIN_DEDUCT_M2} m² — not deducted (NS 3420-1)`,
        _o: o, _area: area,
      };
    });
    const netM = r.grossM - openings.filter((o) => o.deducted).reduce((sum, o) => sum + o._o.widthM, 0);
    return { r, openings, netM };
  });
  const wireRuns = runs.map(({ r, openings, netM }, i) => ({
    n: i + 1,
    line: [pt(r.line[0]), pt(r.line[1])],
    thickness_mm: Math.round(r.thicknessM * 1000),
    class_mm: classMm(r),
    side: side(r).toLowerCase(),
    gross_m: round2(r.grossM),
    net_m: round2(netM),
    evidence: r.evidence,
    openings: openings.map(({ _o, _area, ...o }) => o),
    condition: tagOf(r),
  }));

  type ClassRow = { condition: string; side: string; class_mm: number; runs: number; gross_m: number; net_m: number; openings: number; deducted_area_m2: number; area_unknown_openings: number };
  const byClass = new Map<string, ClassRow>();
  for (const { r, openings, netM } of runs) {
    const tag = tagOf(r);
    const row = byClass.get(tag) ?? { condition: tag, side: side(r).toLowerCase(), class_mm: classMm(r), runs: 0, gross_m: 0, net_m: 0, openings: 0, deducted_area_m2: 0, area_unknown_openings: 0 };
    row.runs++; row.gross_m += r.grossM; row.net_m += netM; row.openings += openings.length;
    for (const o of openings) if (o.deducted) { if (o._area === undefined) row.area_unknown_openings++; else row.deducted_area_m2 += o._area; }
    byClass.set(tag, row);
  }
  type ClassOut = Omit<ClassRow, "deducted_area_m2" | "area_unknown_openings"> & { gross_lf: number; net_lf: number; height_ft?: number; area_gross_m2?: number; area_net_m2?: number | null; area_net_reason?: string };
  const classes: ClassOut[] = [...byClass.values()].sort((a, b) => a.side.localeCompare(b.side) || a.class_mm - b.class_mm).map(({ deducted_area_m2, area_unknown_openings, ...row }) => {
    const hFt = heightFor(row.condition);
    const grossArea = hFt ? row.gross_m * hFt * 0.3048 : undefined;
    return {
      ...row, gross_m: round2(row.gross_m), net_m: round2(row.net_m),
      gross_lf: round2(row.gross_m * FT_PER_M), net_lf: round2(row.net_m * FT_PER_M),
      ...(hFt ? {
        height_ft: hFt, area_gross_m2: round2(grossArea!),
        ...(area_unknown_openings
          ? { area_net_m2: null, area_net_reason: `${area_unknown_openings} deducted opening(s) have no known height — net wall area needs each opening's area` }
          : { area_net_m2: round2(grossArea! - deducted_area_m2) }),
      } : {}),
    };
  });

  const total = (f: (x: typeof runs[number]) => number, pick: (r: WallRun) => boolean = () => true) => round2(runs.filter((x) => pick(x.r)).reduce((sum, x) => sum + f(x), 0));
  const withheld = res.withheld.map((w: WithheldWall) => ({
    line: [pt(w.line[0]), pt(w.line[1])], thickness_mm: Math.round(w.thicknessM * 1000), length_m: round2(w.lengthM), reason: w.reason,
  })).sort((a, b) => b.length_m - a.length_m);

  // commit: the gross run under its class, and the drawn wall between its
  // deducted openings under "<class> NET" — both on the marked set, neither
  // summed into the other. A run already filed there is skipped.
  let committed: { shape_ids: string[]; skipped: number } | undefined;
  if (opts.commit) {
    const ids: string[] = [];
    let skipped = 0;
    const file = (tag: string, line: [Point, Point], lf: number, hFt?: number) => {
      const r = h.commitRun(tag, line, lf, hFt);
      if (r) ids.push(r); else skipped++;
    };
    for (const { r, openings } of runs) {
      const tag = tagOf(r), hFt = heightFor(tag);
      file(tag, r.line, r.grossM * FT_PER_M, hFt);
      for (const piece of netPieces(r.line, openings.filter((o) => o.deducted).map((o) => o._o.span))) {
        const len = Math.hypot(piece[1][0] - piece[0][0], piece[1][1] - piece[0][1]) / pxPerM;
        if (len > 0.01) file(`${tag} NET`, piece, len * FT_PER_M);
      }
    }
    committed = { shape_ids: ids, skipped };
  }
  const heightKnown = classes.length > 0 && classes.every((c) => c.height_ft);
  return {
    sheet: h.sheet,
    rule: `Centreline length (NRM2): an L corner runs both walls to the centreline intersection (each end reaches up to half the other wall's thickness past its drawn end), a wall abutting another at a T stops at the through wall's face. gross runs through the openings bridged into a run (doors from their swings, windows from glazing lines inside the band; gaps under ${MIN_OPENING_M} m are junction breaks, not openings). net deducts each opening per NS 3420-1: one of known area (a window mark's schedule height × plan width) under ${NS3420_MIN_DEDUCT_M2} m² is not deducted; one of unknown height is deducted by its width and flagged. Wall area needs a stated height; net area needs every deducted opening's height.`,
    totals: {
      gross_m: total((x) => x.r.grossM), net_m: total((x) => x.netM),
      exterior_gross_m: total((x) => x.r.grossM, (r) => r.exterior === true),
      interior_gross_m: total((x) => x.r.grossM, (r) => r.exterior === false),
      unsided_gross_m: total((x) => x.r.grossM, (r) => r.exterior === null),
      gross_lf: round2(total((x) => x.r.grossM) * FT_PER_M), net_lf: round2(total((x) => x.netM) * FT_PER_M),
    },
    classes,
    height: heightKnown
      ? { source: opts.height_ft ? "stated on this call" : "the conditions' own height", height_ft: opts.height_ft ?? null }
      : { status: "unknown", reason: "A plan does not state wall height. Pass height_ft (from a section, a room schedule or the user) to get wall area; no area is reported without it." },
    style: { poche_m: round1(res.style.poche_m), hatch_m: round1(res.style.hatch_m), outline_m: round1(res.style.outline_m), empty_pairs_counted: res.style.outline_counted },
    runs: wireRuns,
    withheld_total_m: round2(withheld.reduce((sum, w) => sum + w.length_m, 0)),
    withheld: withheld.slice(0, 60),
    ...(withheld.length > 60 ? { withheld_truncated: withheld.length - 60 } : {}),
    committed: committed ? committed.shape_ids.length : 0,
    ...(committed ? { shape_ids: committed.shape_ids, skipped_already_filed: committed.skipped } : {}),
    note: opts.commit
      ? `Each run is filed twice, never summed together: its gross centreline as one ${heightKnown ? "surface (LF × height)" : "linear"} shape under its class condition (${prefix} EXT|INT|UNSIDED <mm>), and the drawn wall between its deducted openings as linear pieces under "<class> NET". One undo step; a run already filed under the same tag at the same place is skipped. Check with view_sheet overlay:true.`
      : "Preview. Commit files each run's gross centreline under its class condition and its net pieces under <class> NET. Withheld bands are listed with their reason and are never counted — view_sheet the worst of them before trusting a total.",
  };
}

/** The run's centreline with the deducted openings cut out: the wall drawn between them. */
function netPieces(line: [Point, Point], cuts: Array<[Point, Point]>): Array<[Point, Point]> {
  const [a, b] = line, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const t = (p: Point) => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (L * L);
  const at = (u: number): Point => [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
  let parts: Array<[number, number]> = [[0, 1]];
  for (const [p, q] of cuts) {
    const lo = Math.min(t(p), t(q)), hi = Math.max(t(p), t(q));
    parts = parts.flatMap(([u0, u1]) => (hi <= u0 || lo >= u1 ? [[u0, u1]] : [...(lo > u0 ? [[u0, lo]] : []), ...(hi < u1 ? [[hi, u1]] : [])]) as Array<[number, number]>);
  }
  return parts.map(([u0, u1]) => [at(u0), at(u1)]);
}

// ── windows ──────────────────────────────────────────────────────────────

/** A window mark sits beside its opening, never further than this. */
const MARK_REACH_M = 2.0;
/** ...and stands within its span, give or take this share of its width. */
const MARK_SPAN_SLACK = 0.3;
const KIND_PENALTY_M: Record<string, number> = { window: 0, opening: 0.3, door: 0.3, gap: 0.6 };
/** Plan width and schedule width agree within this (frame vs rough opening drafting). */
const WIDTH_TOL_MM = 60;
const mid = (sp: [Point, Point]): Point => [(sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2];

/** A window row's width in mm: a WIDTH/BREDDE column, or the first of a B×H
 *  pair; Nordic modules write decimetres ("12x21" = 1200 × 2100). */
export function scheduleWidthMm(cells: Record<string, string>): number | undefined {
  const entries = Object.entries(cells);
  // "1 345" and "1.345" (a thousands gap or point) are 1345 mm; "1,2" is 1.2 m
  const num = (v: string) => { const t = v.trim().replace(/(\d)[\s.](?=\d{3}\b)/g, "$1").replace(",", "."); const n = parseFloat(t); return Number.isFinite(n) ? n : undefined; };
  const mm = (n: number) => (n < 10 ? Math.round(n * 1000) : n < 100 ? Math.round(n * 100) : Math.round(n));   // m, dm (module) or mm
  for (const [k, v] of entries) {
    if (/^(W|B|WIDTH|BREDDE|BREIDDE|B\s*\(MM\)|WIDTH\s*\(MM\))$/i.test(k.trim())) { const n = num(v); if (n) return mm(n); }
  }
  for (const [, v] of entries) {
    const m = v.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
    if (m) { const n = num(m[1]); if (n) return mm(n); }
  }
  return undefined;
}

/** The sizes a plan prints beside its window marks ("Dim 1 205x1 420",
 *  "12x21"): each W×H text goes to the mark it stands nearest (within reach),
 *  so a size between two marks is never read twice. Width in mm per mark. */
function annotatedSizes(text: TextSpan[], marks: Array<{ at: Point }>, pxPerM: number): Map<number, number> {
  const reach = 1.2 * pxPerM, out = new Map<number, { d: number; w: number }>();
  for (const sp of text) {
    // a thousands gap is one space before three digits ("1 205x1 420"); no two
    // whitespace runs sit side by side (linear-time matching)
    const m = sp.str.match(/(\d+(?: \d{3})*) ?[x×] ?(\d+(?: \d{3})*)/i);
    if (!m) continue;
    const w = scheduleWidthMm({ size: `${m[1].replace(/ /g, "")}x${m[2].replace(/ /g, "")}` });
    if (!w) continue;
    const c: Point = [(sp.x0 + sp.x1) / 2, (sp.y0 + sp.y1) / 2];
    let bi = -1, bd = Infinity;
    marks.forEach((mk, i) => { const d = Math.hypot(c[0] - mk.at[0], c[1] - mk.at[1]); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0 || bd > reach) continue;
    const prev = out.get(bi);
    if (!prev || bd < prev.d) out.set(bi, { d: bd, w });
  }
  return new Map([...out].map(([k, v]) => [k, v.w]));
}

/** A post between two glazed gaps of one window is at most this wide. */
const MULLION_M = 0.3;
const canon = (k: string) => (k || "").trim().toUpperCase().replace(/\s+/g, "");
const center = (b: Bbox): Point => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** A schedule row's height in mm: a HEIGHT/HØYDE column, or the second of a B×H pair. */
export function scheduleHeightMm(cells: Record<string, string>): number | undefined {
  for (const [k, v] of Object.entries(cells)) {
    if (/^(H|HEIGHT|HØYDE|HØGDE|H\s*\(MM\)|HEIGHT\s*\(MM\))$/i.test(k.trim())) { const n = scheduleWidthMm({ W: v }); if (n) return n; }
  }
  for (const v of Object.values(cells)) {
    const m = v.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
    if (m) return scheduleWidthMm({ W: m[2] });
  }
  return undefined;
}

/** Widest window a run of glazed gaps may merge into (a window band beyond this
 *  is several windows or a glazed wall — reported, not merged). */
const MAX_WINDOW_M = 3.0;

type Ref = [number, number];                         // [run index, opening index]
type Win = { at: Point; widthM: number; exterior: boolean | null; wallMm: number; span: [Point, Point]; refs: Ref[]; mergedFrom?: number[] };
type Cand = Win & { kind: string };
type Row = { key: string; sheet: string; table: string; cells: Record<string, string> };
type Resolved = { mark: string; at: Point; row: Row; cand?: number; noted?: number };

/** Everything the window count and the wall net read about windows on a sheet:
 *  the glazed openings (duplicates and mullioned pieces joined), every opening a
 *  mark could point at, the schedule rows, and each drawn mark resolved to the
 *  opening it stands beside (or to none). */
function readWindows(h: WallHost, res: ReturnType<typeof wallTakeoff>) {
  const pxPerM = FT_PER_M / h.upp;
  const all: Win[] = [];
  res.runs.forEach((r, ri) => r.openings.forEach((o, oi) => {
    if (o.kind !== "window") return;
    all.push({ at: mid(o.span), widthM: o.widthM, exterior: r.exterior, wallMm: Math.round(r.thicknessM * 1000), span: o.span, refs: [[ri, oi]] });
  }));
  // one window seen from several parallel bands of one wall (a wall whose drawn
  // layers change) is one window: the widest reading of each cluster stands
  all.sort((a, b) => b.widthM - a.widthM);
  const unique: Win[] = [];
  for (const w of all) {
    const same = unique.find((u) => Math.hypot(u.at[0] - w.at[0], u.at[1] - w.at[1]) <= (Math.max(u.widthM, w.widthM) / 2) * pxPerM);
    if (same) { same.refs.push(...w.refs); continue; }
    unique.push(w);
  }
  // one window divided by mullions reads as glazed gaps a post apart on one
  // wall line: they join when the post is narrow, both gaps are glazed in the
  // same wall, and the joined width is still one window's
  const joinReach = MULLION_M * pxPerM;
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const A = unique[i], B = unique[j];
      if (Math.abs(A.wallMm - B.wallMm) > 20) continue;
      const ends = [[A.span[0], B.span[0]], [A.span[0], B.span[1]], [A.span[1], B.span[0]], [A.span[1], B.span[1]]];
      if (!ends.some(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= joinReach)) continue;
      const pts = [A.span[0], A.span[1], B.span[0], B.span[1]];
      let best: [Point, Point] = A.span, bd = 0;
      for (const p of pts) for (const q of pts) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > bd) { bd = d; best = [p, q]; } }
      if (bd / pxPerM > MAX_WINDOW_M) continue;
      const mergedFrom = [...(A.mergedFrom ?? [Math.round(A.widthM * 1000)]), ...(B.mergedFrom ?? [Math.round(B.widthM * 1000)])];
      unique[i] = { ...A, span: best, widthM: bd / pxPerM, at: mid(best), exterior: A.exterior ?? B.exterior, refs: [...A.refs, ...B.refs], mergedFrom };
      unique.splice(j, 1); merged = true; break outer;
    }
  }
  const cands: Cand[] = [
    ...unique.map((w) => ({ ...w, kind: "window" })),
    ...res.runs.flatMap((r, ri) => r.openings.map((o, oi) => ({ o, oi })).filter(({ o }) => o.kind !== "window").map(({ o, oi }) =>
      ({ at: mid(o.span), widthM: o.widthM, kind: o.kind as string, exterior: r.exterior, wallMm: Math.round(r.thicknessM * 1000), span: o.span, refs: [[ri, oi]] as Ref[] }))),
  ];
  // the window schedule(s): row keys are the marks a plan tags windows with
  const tables = h.tables.filter((t) => t.kind === "window" || t.kind === "door-window");
  const rows = new Map<string, Row>();
  for (const t of tables) for (const row of t.rows) {
    const k = canon(row.key);
    if (k && !rows.has(k)) rows.set(k, { key: row.key, sheet: row.sheet, table: t.title?.text || `${t.kind} schedule`, cells: Object.fromEntries(Object.entries(row.cells).map(([c, v]) => [c, v.text])) });
  }
  const inTable = (p: Point) => tableRects(h).some(([x0, y0, x1, y1]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1);
  const markSpans = rows.size ? h.text.map((sp) => ({ k: canon(sp.str), at: center([sp.x0, sp.y0, sp.x1, sp.y1]) })).filter((m) => rows.has(m.k) && !inTable(m.at)) : [];
  const notes = annotatedSizes(h.text, markSpans, pxPerM);
  const usedCand = new Set<number>();
  const reach = MARK_REACH_M * pxPerM;
  const resolved: Resolved[] = markSpans.map((m, mi) => {
    let best = -1, bestD = Infinity;
    cands.forEach((c, j) => {
      if (usedCand.has(j)) return;
      const d = Math.hypot(c.at[0] - m.at[0], c.at[1] - m.at[1]);
      // a mark labels the opening it stands beside: it projects onto that opening
      const [[ax, ay], [bx, by]] = c.span, L = Math.hypot(bx - ax, by - ay) || 1;
      const t = ((m.at[0] - ax) * (bx - ax) + (m.at[1] - ay) * (by - ay)) / (L * L);
      if (t < -MARK_SPAN_SLACK || t > 1 + MARK_SPAN_SLACK) return;
      // a glazed opening is the likeliest thing a window mark points at
      const score = d + (KIND_PENALTY_M[c.kind] ?? 0) * pxPerM;
      if (d <= reach && score < bestD) { best = j; bestD = score; }
    });
    if (best >= 0) usedCand.add(best);
    return { mark: rows.get(m.k)!.key, at: m.at, row: rows.get(m.k)!, ...(best >= 0 ? { cand: best } : {}), ...(notes.has(mi) ? { noted: notes.get(mi) } : {}) };
  });
  return { unique, cands, rows, tables, markSpans, resolved, usedCand };
}

/** count {action: "windows"}: window openings in the sheet's walls, tied to the window schedule. */
export function countWindows(h: WallHost, opts: { condition?: string; commit?: boolean; region?: WallsOpts["region"] }) {
  refuseScan(h, "the window count");
  refuseDiscipline(h, "the window count");
  const res = runTakeoff(h, opts.region);
  const { unique, cands, rows, tables, markSpans, resolved, usedCand } = readWindows(h, res);
  const sideOf = (e: boolean | null) => (e === true ? "exterior" : e === false ? "interior" : "unsided");
  type WinOut = { n: number; at: [number, number]; width_mm?: number; plan_note_width_mm?: number; wall_mm?: number; side: string; mark?: string; by: "mark" | "geometry"; opening?: string; merged_from_mm?: number[]; row?: Row; schedule_width_mm?: number; schedule_height_mm?: number; width_check?: string; note_check?: string };
  const windows: WinOut[] = [];
  const marksAtDoors: Array<{ mark: string; at: [number, number] }> = [];
  // a mark counts as a window only where it stands at an opening; a schedule
  // key that turns up as bare text elsewhere ("1", "A") is listed, never counted
  const marksUnresolved: Array<{ mark: string; at: [number, number]; reason: string }> = [];
  for (const r of resolved) {
    const c = r.cand !== undefined ? cands[r.cand] : undefined;
    if (!c) { marksUnresolved.push({ mark: r.mark, at: pt(r.at), reason: "no wall opening beside this text — a mark in a note or legend, a dimension or an opening the wall takeoff did not bridge; view_sheet it" }); continue; }
    if (c.kind === "door") { marksAtDoors.push({ mark: r.mark, at: pt(r.at) }); continue; }
    const sched = scheduleWidthMm(r.row.cells), schedH = scheduleHeightMm(r.row.cells);
    const widthMm = Math.round(c.widthM * 1000);
    windows.push({
      n: windows.length + 1, at: pt(c.at), side: sideOf(c.exterior), by: "mark", mark: r.mark, row: r.row,
      width_mm: widthMm, opening: c.kind, ...(c.wallMm ? { wall_mm: c.wallMm } : {}),
      ...(c.mergedFrom ? { merged_from_mm: c.mergedFrom } : {}),
      ...(sched ? { schedule_width_mm: sched } : {}), ...(schedH ? { schedule_height_mm: schedH } : {}),
      ...(r.noted ? { plan_note_width_mm: r.noted } : {}),
      ...(r.noted && sched ? { note_check: Math.abs(r.noted - sched) <= WIDTH_TOL_MM ? "the size printed at the mark agrees with the schedule" : `the size printed at the mark (${r.noted} mm) differs from the schedule (${sched} mm)` } : {}),
      width_check: !sched ? "no width in the schedule row to check against"
        : Math.abs(widthMm - sched) <= WIDTH_TOL_MM ? `plan opening agrees with the schedule (±${WIDTH_TOL_MM} mm)`
        : `plan opening ${widthMm} mm vs schedule ${sched} mm — check which opening the mark points at`,
    });
  }
  if (!markSpans.length) {
    for (const w of unique.filter((u) => u.exterior === true)) windows.push({ n: windows.length + 1, at: pt(w.at), width_mm: Math.round(w.widthM * 1000), wall_mm: w.wallMm, side: "exterior", by: "geometry", ...(w.mergedFrom ? { merged_from_mm: w.mergedFrom } : {}) });
  }
  // glazed openings in interior or unsided walls: reported, not counted
  const interior = unique.filter((w, j) => !usedCand.has(j) && w.exterior !== true).map((w) => ({ at: pt(w.at), width_mm: Math.round(w.widthM * 1000), wall_mm: w.wallMm, reason: w.exterior === false ? "glazing lines in an interior wall — an internal glazed screen, a sliding door or casework; view_sheet it" : "the host wall's side could not be told; view_sheet it" }));
  // on a marked sheet, a glazed opening no mark points at is a question, not a count
  const unmarkedGlazing = markSpans.length ? unique.filter((w, j) => !usedCand.has(j) && w.exterior === true)
    .map((w) => ({ at: pt(w.at), width_mm: Math.round(w.widthM * 1000), reason: "glazed opening in an exterior wall with no window mark next to it on a sheet that marks its windows — an unmarked window, a glazed door or a false reading; view_sheet it" })) : [];

  const byType = new Map<string, { type: string; count: number; widths_mm: number[]; row?: Record<string, string> }>();
  for (const w of windows) {
    const type = w.mark ?? `unmarked ~${Math.round((w.width_mm ?? 0) / 100) * 100} mm`;
    const e = byType.get(type) ?? { type, count: 0, widths_mm: [], ...(w.row ? { row: w.row.cells } : {}) };
    e.count++; if (w.width_mm !== undefined) e.widths_mm.push(w.width_mm);
    byType.set(type, e);
  }
  const marksOnSheet = new Set(markSpans.map((m) => m.k));
  const rowsWithout = [...rows.values()].filter((r) => !windows.some((w) => w.mark && canon(w.mark) === canon(r.key)))
    .map((r) => ({ mark: r.key, sheet: r.sheet, reason: marksOnSheet.has(canon(r.key)) ? "the mark is drawn on this sheet but no window opening was found at it — view_sheet the tag" : "no window on this sheet carries this mark (it may be on another floor's sheet)" }));
  const planWithout = [
    ...windows.filter((w) => !w.row).map((w) => ({ n: w.n, at: w.at, width_mm: w.width_mm, reason: rows.size ? "no window mark drawn on this sheet to tie it to" : "the set has no window schedule to tie it to" })),
    ...unmarkedGlazing,
  ];

  let committed: { shape_ids: string[]; ea_total: number; skipped: number } | undefined;
  if (opts.commit) {
    if (!opts.condition) throw new UserError("commit needs a condition to file the windows under.");
    committed = windows.length ? h.commitCount(opts.condition, windows.map((w) => w.at as Point)) : { shape_ids: [], ea_total: 0, skipped: 0 };
  }
  return {
    sheet: h.sheet,
    found: windows.length,
    windows,
    by_type: [...byType.values()].map((t) => ({ type: t.type, count: t.count, widths_mm: t.widths_mm, ...(t.row ? { schedule: t.row } : {}) })),
    schedule: tables.length ? { tables: tables.map((t) => ({ sheet: t.sheet, title: t.title?.text || "", rows: t.rows.length })) } : { status: "none", note: "No window schedule in the set: sizes are plan widths only; heights are unknown." },
    plan_without_row: planWithout,
    withheld: interior,
    ...(marksAtDoors.length ? { marks_at_doors: marksAtDoors } : {}),
    ...(marksUnresolved.length ? { marks_unresolved: marksUnresolved } : {}),
    counted_by: markSpans.length ? "marks" : "geometry",
    rows_without_window: rowsWithout,
    committed: committed ? committed.shape_ids.length : 0,
    ...(committed ? { shape_ids: committed.shape_ids, ea_total: committed.ea_total, skipped_already_filed: committed.skipped } : {}),
    note: "Where the sheet draws window-schedule marks, each mark standing at a wall opening is one window; its plan width is that opening's, checked against the row's width. Marks at no opening (marks_unresolved) and at door swings (marks_at_doors) are listed, never counted or committed; a glazed opening with no mark is listed, not counted. On an unmarked sheet a window is an opening in an exterior wall band with glazing lines inside it and no door swing. Widths are plan widths; height and type come only from a schedule row.",
  };
}
