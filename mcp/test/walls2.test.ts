// Walls/windows round 2: sheet discipline (trade words win, room labels and
// fine print never decide), window marks resolved to openings (unresolved and
// door marks listed, never counted), NS 3420 deductions, idempotent window
// commits, and a mixed-thickness L corner. Synthetic PDFs only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session } from "../src/session.ts";
import { countWindows, measureWalls, scheduleHeightMm, type WallHost } from "../src/walls.ts";
import { sheetDiscipline } from "../../web/src/lib/sheetscope.ts";

const W = 1190, H = 842, PT_PER_M = 1000 / 100 / 25.4 * 72, OX = 150, OY = 150;
const X = (m: number) => (OX + m * PT_PER_M).toFixed(2), Y = (m: number) => (OY + m * PT_PER_M).toFixed(2);
const wall = (x0: number, y0: number, x1: number, y1: number) => {
  const r = `${X(x0)} ${Y(y0)} ${((x1 - x0) * PT_PER_M).toFixed(2)} ${((y1 - y0) * PT_PER_M).toFixed(2)} re`;
  return [`${r} f`, `${r} S`];
};
const line = (x0: number, y0: number, x1: number, y1: number) => `${X(x0)} ${Y(y0)} m ${X(x1)} ${Y(y1)} l S`;

function pdf(ops: string[], text: Array<[string, number, number, number]> = []): string {
  const t = text.map(([s, x, y, size]) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET`);
  const stream = ["q", "0.5 g 0 G 0.5 w", ...ops, ...t, "Q"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objects.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(mkdtempSync(path.join(tmpdir(), "otk-walls2-")), "plan.pdf");
  writeFileSync(file, out, "latin1");
  return file;
}

// 10 × 6 m, 300 mm exterior walls; a 1.2 m window in the south wall (4.0–5.2),
// a 0.6 m window in the north wall (2.0–2.6); a 100 mm partition with a door.
function building(): string[] {
  const ops = [
    ...wall(0, 0, 4.0, 0.3), ...wall(5.2, 0, 10, 0.3),
    ...wall(0, 5.7, 2.0, 6), ...wall(2.6, 5.7, 10, 6),
    ...wall(0, 0.3, 0.3, 5.7), ...wall(9.7, 0.3, 10, 5.7),
    ...wall(6.0, 0.3, 6.1, 2.0), ...wall(6.0, 2.9, 6.1, 5.7),
    line(4.0, 0, 4.0, 0.3), line(5.2, 0, 5.2, 0.3), line(4.0, 0.13, 5.2, 0.13), line(4.0, 0.17, 5.2, 0.17),
    line(2.0, 5.7, 2.0, 6), line(2.6, 5.7, 2.6, 6), line(2.0, 5.83, 2.6, 5.83), line(2.0, 5.87, 2.6, 5.87),
  ];
  const r = 0.9, k = 0.5523 * r;
  ops.push(line(6.1, 2.0, 6.1 + r, 2.0));
  ops.push(`${X(6.1 + r)} ${Y(2.0)} m ${X(6.1 + r)} ${Y(2.0 + k)} ${X(6.1 + k)} ${Y(2.0 + r)} ${X(6.1)} ${Y(2.0 + r)} c S`);
  return ops;
}

async function open(file: string) {
  const s = new Session();
  await s.loadPlan(file);
  const key = s.sheetList()[0].key;
  s.setScale(key, { label: "1:100" });
  return { s, key };
}
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} ± ${tol}`);
/** image px of a point in metres on the building (PDF y up → image y down, ×2) */
const px = (xm: number, ym: number): [number, number] => [2 * (OX + xm * PT_PER_M), 2 * (H - (OY + ym * PT_PER_M))];
const span = (s: string, [x, y]: [number, number]) => ({ str: s, x0: x - 8, y0: y - 6, x1: x + 8, y1: y + 6 });

/** A host over the synthetic plan with a stated window schedule and marks. */
async function markedHost() {
  const { s, key } = await open(pdf(building()));
  const host: WallHost = await (s as any).wallHost(key, "test");
  host.tables = [{
    kind: "window", sheet: key, title: { sheet: key, text: "WINDOW SCHEDULE", bbox: [0, 0, 1, 1] }, headers: ["ID", "WIDTH", "HEIGHT"], region: [0, 0, 1, 1],
    rows: [
      { key: "V1", sheet: key, cells: { WIDTH: { text: "1 200", bbox: [0, 0, 0, 0] }, HEIGHT: { text: "1 400", bbox: [0, 0, 0, 0] } } },
      { key: "V2", sheet: key, cells: { WIDTH: { text: "900", bbox: [0, 0, 0, 0] }, HEIGHT: { text: "600", bbox: [0, 0, 0, 0] } } },
      { key: "V3", sheet: key, cells: { SIZE: { text: "10x12", bbox: [0, 0, 0, 0] } } },
    ],
  }] as any;
  host.text = [
    span("V1", px(4.6, -0.8)),                   // outside the south window
    span("Dim 1200x1400", px(4.6, -1.1)),        // its printed size
    span("V2", px(2.3, 6.8)),                    // outside the north window (schedule says 900; the plan draws 600)
    span("V3", px(6.05, 2.45)),                  // at the partition door
    span("V1", px(8.0, 3.0)),                    // loose text mid-room: no opening beside it
  ];
  return { s, key, host };
}

test("windows by mark: each resolved mark is a window with plan width and schedule check; stray and door marks are listed, never counted", async () => {
  const { host } = await markedHost();
  const w = countWindows(host, {});
  assert.equal(w.counted_by, "marks");
  assert.equal(w.found, 2, "V1 and V2 stand at glazed openings");
  const v1 = w.windows.find((x) => x.mark === "V1")!, v2 = w.windows.find((x) => x.mark === "V2")!;
  near(v1.width_mm!, 1200, 30, "V1 plan width"); assert.equal(v1.schedule_width_mm, 1200); assert.match(v1.width_check!, /agrees/);
  assert.equal(v1.plan_note_width_mm, 1200, "the printed size beside the mark"); assert.match(v1.note_check!, /agrees/);
  assert.equal(v1.schedule_height_mm, 1400);
  near(v2.width_mm!, 600, 30, "V2 plan width"); assert.match(v2.width_check!, /600 mm vs schedule 900 mm/);
  assert.deepEqual((w.marks_at_doors ?? []).map((m) => m.mark), ["V3"], "a mark at a swing is a door's");
  assert.deepEqual((w.marks_unresolved ?? []).map((m) => m.mark), ["V1"], "the loose V1 text is listed, not counted");
  assert.equal(scheduleHeightMm({ SIZE: "10x12" }), 1200);
});

test("windows commit: only resolved windows are filed, and a second commit files nothing", async () => {
  const { s, key, host } = await markedHost();
  const first = countWindows(host, { commit: true, condition: "WINDOW" });
  assert.equal(first.committed, 2);
  const second = countWindows(host, { commit: true, condition: "WINDOW" });
  assert.equal(second.committed, 0);
  assert.equal(second.skipped_already_filed, 2);
  assert.equal(s.exportPayload().shapes.filter((x: any) => x.sheet_id === key).length, 2);
});

test("NS 3420: a window of known area under 0.5 m² stays in the net; one over it and one of unknown height are deducted", async () => {
  const { host } = await markedHost();
  // make the north window's row small: 0.6 m plan width × 0.6 m schedule height = 0.36 m²
  const r = measureWalls(host, {});
  const openings = r.runs.flatMap((x) => x.openings);
  const south = openings.find((o) => o.kind === "window" && Math.abs(o.width_mm - 1200) < 30)!;
  const north = openings.find((o) => o.kind === "window" && Math.abs(o.width_mm - 600) < 30)!;
  const door = openings.find((o) => o.kind === "door")!;
  assert.equal(south.deducted, true); assert.equal(south.height_mm, 1400);
  assert.equal(north.deducted, false); assert.match(north.rule, /< 0.5 m²/);
  assert.equal(door.deducted, true); assert.match(door.rule, /height unknown/);
  near(r.totals.gross_m - r.totals.net_m, 1.2 + 0.9, 0.08, "net deducts the large window and the door only");
});

test("mixed-thickness L corners run to the centreline intersection", async () => {
  // 6 × 4 m: south 300 mm, north 100 mm, west 100 mm, east 300 mm
  const ops = [...wall(0, 0, 6, 0.3), ...wall(0, 3.9, 6, 4.0), ...wall(0, 0.3, 0.1, 3.9), ...wall(5.7, 0.3, 6, 3.9)];
  const { s, key } = await open(pdf(ops, [["PLANTEGNING", 1000, 60, 20]]));
  const r = await s.measureWalls(key, {});
  const by = (t: number, horiz: boolean) => r.runs.find((x) => Math.abs(x.thickness_mm - t) <= 15 && (Math.abs(x.line[0][1] - x.line[1][1]) < 1) === horiz)!;
  near(by(300, true).gross_m, 6 - 0.05 - 0.15, 0.05, "south: west centreline to east centreline");
  near(by(100, true).gross_m, 5.8, 0.05, "north likewise");
  near(by(100, false).gross_m, 4 - 0.15 - 0.05, 0.05, "west: south centreline to north centreline");
  near(by(300, false).gross_m, 3.8, 0.05, "east likewise");
});

test("sheet discipline: a trade named in the title wins over plan words; room labels and fine print never decide", () => {
  const Wd = 2000, Hd = 1400;
  const sp = (str: string, x: number, y: number, h = 10) => ({ str, x0: x, y0: y, x1: x + str.length * h * 0.5, y1: y + h });
  // running text across the plan sets the text size a title must beat
  const plan = Array.from({ length: 30 }, (_, i) => sp(`ROOM ${i}`, 100 + 30 * i, 300));
  const title = (t: string) => sheetDiscipline([...plan, sp(t, 1500, 1250, 20)], Wd, Hd).discipline;
  assert.equal(title("ELECTRICAL FLOOR PLAN"), "electrical");
  assert.equal(title("MECHANICAL FLOOR PLAN (LEVEL 2)"), "mechanical");
  assert.equal(title("DEMOLITION FLOOR PLAN"), "demolition");
  assert.equal(title("PLANTEGNING VENTILASJON"), "mechanical");
  assert.equal(title("PLAN 2. ETASJE VVS-ANLEGG"), "mechanical");
  assert.equal(title("PLANTEGNING 1. ETASJE"), "architectural");
  assert.equal(title("FLOOR PLAN"), "architectural");
  for (const room of ["MECHANICAL ROOM", "ELEKTROROM", "SPRINKLERSENTRAL", "ELECTRICAL CLOSET"]) {
    assert.notEqual(sheetDiscipline([...plan, sp(room, 1500, 1250, 20)], Wd, Hd).discipline, room.startsWith("M") ? "mechanical" : room.startsWith("S") ? "fire_protection" : "electrical", room);
  }
  // along the right-edge strip (where plan text can reach) a trade word must be
  // title-size; in the title-block corner fine print below the running text never counts
  assert.equal(sheetDiscipline([...plan, sp("ELECTRICAL", 1750, 500, 10)], Wd, Hd).discipline, "unknown");
  assert.equal(sheetDiscipline([...plan, sp("ELECTRICAL", 1750, 500, 20)], Wd, Hd).discipline, "electrical");
  assert.equal(sheetDiscipline([...plan, sp("ELECTRICAL", 1500, 1250, 6)], Wd, Hd).discipline, "unknown");
  // legend device words in fine print never decide; at running size they do
  const legend = (h: number) => ["STIKKONTAKT", "LYSBRYTER", "UTTAK"].map((w, i) => sp(w, 1500, 1100 + 20 * i, h));
  assert.equal(sheetDiscipline([...plan, ...legend(6)], Wd, Hd).discipline, "unknown");
  assert.equal(sheetDiscipline([...plan, ...legend(10)], Wd, Hd).discipline, "electrical");
});
