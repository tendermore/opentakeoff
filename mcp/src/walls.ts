// measure {kind: "walls"} and count {action: "windows"} — the session glue
// around web/src/lib/walltakeoff.ts. Session passes a narrow host (the sheet's
// geometry, doors, text, schedule tables and a commit hook), so the engine and
// the reply shapes live here and session.ts carries only the wiring.
import { wallTakeoff, type WallRun, type WithheldWall } from "../../web/src/lib/walltakeoff.ts";
import type { VectorGeometry, Point } from "../../web/src/lib/oneclick.ts";
import type { Door } from "../../web/src/lib/doors.ts";
import type { ScheduleTable, Bbox } from "../../web/src/lib/sheetgraph.ts";
import type { TextSpan } from "./pdf.ts";
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
  /** true when the sheet is a scan wrapper (a placed image, next to no linework) */
  scan: boolean;
  commitRun: (tag: string, line: [Point, Point], lengthLf: number, heightFt?: number) => string;
  commitCount: (tag: string, at: Point[]) => { shape_ids: string[]; ea_total: number };
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
    if (prev !== undefined && (runs[i].thicknessM - runs[prev].thicknessM) * 1000 > CLASS_TOL_MM) close();
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

function tableRects(h: WallHost): Array<[number, number, number, number]> {
  return h.tables.filter((t) => t.sheet === h.sheet).map((t) => t.region as unknown as [number, number, number, number]);
}

function runTakeoff(h: WallHost, region?: WallsOpts["region"]) {
  const pxPerM = FT_PER_M / h.upp;
  return wallTakeoff(h.geo, pxPerM, h.width, h.height, {
    exclude: tableRects(h),
    text: h.text,
    doors: h.doors.map((d) => d.opening),
    ...(region ? { region: [region.x0, region.y0, region.x1, region.y1] as [number, number, number, number] } : {}),
  });
}

const side = (r: WallRun) => (r.exterior === true ? "EXT" : r.exterior === false ? "INT" : "UNSIDED");

/** measure {kind: "walls"}: every wall run on a sheet, by thickness class and side. */
export function measureWalls(h: WallHost, opts: WallsOpts) {
  refuseScan(h, "the wall takeoff");
  const res = runTakeoff(h, opts.region);
  const prefix = (opts.condition ?? "WALL").trim() || "WALL";
  const cls = thicknessClasses(res.runs);
  const classOf = new Map(res.runs.map((r, i) => [r, cls[i]] as const));
  const classMm = (r: WallRun) => classOf.get(r)!;
  const tagOf = (r: WallRun) => `${prefix} ${side(r)} ${classMm(r)}`;
  // height: stated on the call, or already on the class's condition — never read off a plan
  const heightFor = (tag: string) => opts.height_ft ?? h.heightOf(tag);

  const runs = res.runs.map((r, i) => ({
    n: i + 1,
    line: [pt(r.line[0]), pt(r.line[1])],
    thickness_mm: Math.round(r.thicknessM * 1000),
    class_mm: classMm(r),
    side: side(r).toLowerCase(),
    gross_m: round2(r.grossM),
    net_m: round2(r.netM),
    evidence: r.evidence,
    openings: r.openings.map((o) => ({ kind: o.kind, width_mm: Math.round(o.widthM * 1000), span: [pt(o.span[0]), pt(o.span[1])] })),
    condition: tagOf(r),
  }));

  type Row = { condition: string; side: string; class_mm: number; runs: number; gross_m: number; net_m: number; openings: number; height_ft?: number; area_gross_m2?: number };
  const byClass = new Map<string, Row>();
  for (const [i, r] of res.runs.entries()) {
    const tag = runs[i].condition;
    const row = byClass.get(tag) ?? { condition: tag, side: side(r).toLowerCase(), class_mm: classMm(r), runs: 0, gross_m: 0, net_m: 0, openings: 0 };
    row.runs++; row.gross_m += r.grossM; row.net_m += r.netM; row.openings += r.openings.length;
    byClass.set(tag, row);
  }
  const classes = [...byClass.values()].sort((a, b) => a.side.localeCompare(b.side) || a.class_mm - b.class_mm).map((row) => {
    const hFt = heightFor(row.condition);
    return {
      ...row, gross_m: round2(row.gross_m), net_m: round2(row.net_m),
      gross_lf: round2(row.gross_m * FT_PER_M), net_lf: round2(row.net_m * FT_PER_M),
      ...(hFt ? { height_ft: hFt, area_gross_m2: round2(row.gross_m * hFt * 0.3048) } : {}),
    };
  });

  const total = (f: (r: WallRun) => number, pick: (r: WallRun) => boolean = () => true) => round2(res.runs.filter(pick).reduce((s, r) => s + f(r), 0));
  const withheld = res.withheld.map((w: WithheldWall) => ({
    line: [pt(w.line[0]), pt(w.line[1])], thickness_mm: Math.round(w.thicknessM * 1000), length_m: round2(w.lengthM), reason: w.reason,
  })).sort((a, b) => b.length_m - a.length_m);

  let committed: { shape_ids: string[] } | undefined;
  if (opts.commit) {
    const ids: string[] = [];
    for (const [i, r] of res.runs.entries()) {
      const hFt = heightFor(runs[i].condition);
      ids.push(h.commitRun(runs[i].condition, r.line, r.grossM * FT_PER_M, hFt));
    }
    committed = { shape_ids: ids };
  }
  const heightKnown = classes.every((c) => c.height_ft);
  return {
    sheet: h.sheet,
    rule: "Centreline length (NRM2): L corners run to the centreline intersection, a wall abutting another stops at its face. gross runs through the openings bridged into a run (doors from their swings, windows from glazing lines inside the band); net subtracts them.",
    totals: {
      gross_m: total((r) => r.grossM), net_m: total((r) => r.netM),
      exterior_gross_m: total((r) => r.grossM, (r) => r.exterior === true),
      interior_gross_m: total((r) => r.grossM, (r) => r.exterior === false),
      unsided_gross_m: total((r) => r.grossM, (r) => r.exterior === null),
      gross_lf: round2(total((r) => r.grossM) * FT_PER_M), net_lf: round2(total((r) => r.netM) * FT_PER_M),
    },
    classes,
    height: heightKnown
      ? { source: opts.height_ft ? "stated on this call" : "the conditions' own height", height_ft: opts.height_ft ?? null }
      : { status: "unknown", reason: "A plan does not state wall height. Pass height_ft (from a section, a room schedule or the user) to get wall area; no area is reported without it." },
    style: { poche_m: round1(res.style.poche_m), hatch_m: round1(res.style.hatch_m), outline_m: round1(res.style.outline_m), empty_pairs_counted: res.style.outline_counted },
    runs,
    withheld_total_m: round2(withheld.reduce((s, w) => s + w.length_m, 0)),
    withheld: withheld.slice(0, 60),
    ...(withheld.length > 60 ? { withheld_truncated: withheld.length - 60 } : {}),
    committed: committed ? committed.shape_ids.length : 0,
    ...(committed ? { shape_ids: committed.shape_ids } : {}),
    note: opts.commit
      ? `Each run is filed as one ${heightKnown ? "surface (LF × height)" : "linear"} shape under its class condition (${prefix} EXT|INT|UNSIDED <mm>); one undo step. Check with view_sheet overlay:true; derive {action: "deduct"} clips a run at an opening when the handoff wants net runs drawn.`
      : "Preview. Commit to file each run under its class condition. Withheld bands are listed with their reason and are never counted — view_sheet the worst of them before trusting a total.",
  };
}

// ── windows ──────────────────────────────────────────────────────────────

/** A post between two glazed gaps of one window is at most this wide. */
const MULLION_M = 0.3;
const canon = (k: string) => (k || "").trim().toUpperCase().replace(/\s+/g, "");
const center = (b: Bbox): Point => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** count {action: "windows"}: window openings in the sheet's walls, tied to the window schedule. */
export function countWindows(h: WallHost, opts: { condition?: string; commit?: boolean; region?: WallsOpts["region"] }) {
  refuseScan(h, "the window count");
  const res = runTakeoff(h, opts.region);
  const pxPerM = FT_PER_M / h.upp;
  type Win = { at: Point; widthM: number; exterior: boolean | null; wallMm: number; span: [Point, Point] };
  const all: Win[] = [];
  for (const r of res.runs) for (const o of r.openings) {
    if (o.kind !== "window") continue;
    all.push({ at: [(o.span[0][0] + o.span[1][0]) / 2, (o.span[0][1] + o.span[1][1]) / 2], widthM: o.widthM, exterior: r.exterior, wallMm: Math.round(r.thicknessM * 1000), span: o.span });
  }
  // one window seen from several parallel bands of one wall (a wall whose drawn
  // layers change) is one window: the widest reading of each cluster stands
  all.sort((a, b) => b.widthM - a.widthM);
  const unique: Win[] = [];
  for (const w of all) {
    if (unique.some((u) => Math.hypot(u.at[0] - w.at[0], u.at[1] - w.at[1]) <= (Math.max(u.widthM, w.widthM) / 2) * pxPerM)) continue;
    unique.push(w);
  }
  // one window divided by mullions reads as several glazed gaps a post apart
  // on one wall line: they join into one window over the whole span
  const joinReach = MULLION_M * pxPerM;
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const A = unique[i], B = unique[j];
      const ends = [[A.span[0], B.span[0]], [A.span[0], B.span[1]], [A.span[1], B.span[0]], [A.span[1], B.span[1]]];
      const near = ends.some(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= joinReach);
      if (!near) continue;
      const pts = [A.span[0], A.span[1], B.span[0], B.span[1]];
      let best: [Point, Point] = A.span, bd = 0;
      for (const p of pts) for (const q of pts) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > bd) { bd = d; best = [p, q]; } }
      unique[i] = { ...A, span: best, widthM: bd / pxPerM, at: [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2], exterior: A.exterior ?? B.exterior };
      unique.splice(j, 1); merged = true; break outer;
    }
  }
  // a glazed opening in an interior wall is a window only by exception (an
  // internal glazed screen); it is reported, not counted
  const found = unique.filter((w) => w.exterior === true);
  const interior = unique.filter((w) => w.exterior !== true).map((w) => ({ at: pt(w.at), width_mm: Math.round(w.widthM * 1000), wall_mm: w.wallMm, reason: w.exterior === false ? "glazing lines in an interior wall — an internal glazed screen, a sliding door or casework; view_sheet it" : "the host wall's side could not be told; view_sheet it" }));

  // the window schedule(s): row keys are the marks a plan tags windows with
  const tables = h.tables.filter((t) => t.kind === "window" || t.kind === "door-window");
  const rows = new Map<string, { key: string; sheet: string; table: string; cells: Record<string, string> }>();
  for (const t of tables) for (const row of t.rows) {
    const k = canon(row.key);
    if (k && !rows.has(k)) rows.set(k, { key: row.key, sheet: row.sheet, table: t.title?.text || `${t.kind} schedule`, cells: Object.fromEntries(Object.entries(row.cells).map(([c, v]) => [c, v.text])) });
  }
  const inTable = (p: Point) => tableRects(h).some(([x0, y0, x1, y1]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1);
  const markSpans = rows.size ? h.text.map((sp) => ({ k: canon(sp.str), at: center([sp.x0, sp.y0, sp.x1, sp.y1]) })).filter((m) => rows.has(m.k) && !inTable(m.at)) : [];
  const usedMarks = new Set<number>();

  const windows = found.map((w, i) => {
    const reach = Math.max(1.5, 1.2 * w.widthM) * pxPerM;
    let best = -1, bestD = Infinity;
    markSpans.forEach((m, j) => {
      const d = Math.hypot(m.at[0] - w.at[0], m.at[1] - w.at[1]);
      if (d <= reach && d < bestD && !usedMarks.has(j)) { best = j; bestD = d; }
    });
    if (best >= 0) usedMarks.add(best);
    const mark = best >= 0 ? markSpans[best].k : undefined;
    const row = mark ? rows.get(mark) : undefined;
    return {
      n: i + 1, at: pt(w.at), width_mm: Math.round(w.widthM * 1000), wall_mm: w.wallMm,
      side: w.exterior === true ? "exterior" : w.exterior === false ? "interior" : "unsided",
      ...(mark ? { mark: row!.key } : {}),
      ...(row ? { row: { sheet: row.sheet, table: row.table, cells: row.cells } } : {}),
    };
  });

  const byType = new Map<string, { type: string; count: number; widths_mm: number[]; row?: Record<string, string> }>();
  for (const w of windows) {
    const type = w.mark ?? `unmarked ~${Math.round(w.width_mm / 100) * 100} mm`;
    const e = byType.get(type) ?? { type, count: 0, widths_mm: [], ...(w.row ? { row: w.row.cells } : {}) };
    e.count++; e.widths_mm.push(w.width_mm);
    byType.set(type, e);
  }
  const marksOnSheet = new Set(markSpans.map((m) => m.k));
  const rowsWithout = [...rows.values()].filter((r) => !windows.some((w) => w.mark && canon(w.mark) === canon(r.key)))
    .map((r) => ({ mark: r.key, sheet: r.sheet, reason: marksOnSheet.has(canon(r.key)) ? "the mark is drawn on this sheet but no window opening was found at it — view_sheet the tag" : "no window on this sheet carries this mark (it may be on another floor's sheet)" }));
  const planWithout = windows.filter((w) => !w.row).map((w) => ({ n: w.n, at: w.at, width_mm: w.width_mm, reason: rows.size ? "no schedule mark found next to this window" : "the set has no window schedule to tie it to" }));

  let committed: { shape_ids: string[]; ea_total: number } | undefined;
  if (opts.commit) {
    if (!opts.condition) throw new UserError("commit needs a condition to file the windows under.");
    committed = found.length ? h.commitCount(opts.condition, found.map((w) => w.at)) : { shape_ids: [], ea_total: 0 };
  }
  return {
    sheet: h.sheet,
    found: windows.length,
    windows,
    by_type: [...byType.values()].map((t) => ({ type: t.type, count: t.count, widths_mm: t.widths_mm, ...(t.row ? { schedule: t.row } : {}) })),
    schedule: tables.length ? { tables: tables.map((t) => ({ sheet: t.sheet, title: t.title?.text || "", rows: t.rows.length })) } : { status: "none", note: "No window schedule in the set: sizes are plan widths only; heights are unknown." },
    plan_without_row: planWithout,
    withheld: interior,
    rows_without_window: rowsWithout,
    committed: committed ? committed.shape_ids.length : 0,
    ...(committed ? { shape_ids: committed.shape_ids, ea_total: committed.ea_total } : {}),
    note: "A window is an opening in an exterior wall band with glazing lines drawn inside the band and no door swing; glazed openings in interior or unsided walls are listed in withheld, not counted. Widths are the drawn opening (plan); height and type come only from a schedule row. Windows in a curtain wall or a wall this sheet's wall takeoff withheld are not found — check rows_without_window and view_sheet.",
  };
}
