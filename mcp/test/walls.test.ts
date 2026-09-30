// measure {kind: "walls"} and count {action: "windows"} on synthetic plans:
// walls drawn the way CAD exports them (filled poché bands with stroked faces),
// a window as glazing lines inside a gap in the wall band, a door as a gap with
// a swing. Nothing here reads layers or text vocabulary. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import { thicknessClasses } from "../src/walls.ts";

const W = 1190, H = 842;                  // A3 landscape, pt
const PT_PER_M = 1000 / 100 / 25.4 * 72;  // 1:100
const OX = 150, OY = 150;                 // building origin on the sheet, pt
const X = (m: number) => (OX + m * PT_PER_M).toFixed(2);
const Y = (m: number) => (OY + m * PT_PER_M).toFixed(2);

/** A filled + stroked wall body between (x0,y0) and (x1,y1), metres. */
const wall = (x0: number, y0: number, x1: number, y1: number) => [
  `${X(x0)} ${Y(y0)} ${(Math.abs(x1 - x0) * PT_PER_M).toFixed(2)} ${(Math.abs(y1 - y0) * PT_PER_M).toFixed(2)} re f`,
  `${X(x0)} ${Y(y0)} ${(Math.abs(x1 - x0) * PT_PER_M).toFixed(2)} ${(Math.abs(y1 - y0) * PT_PER_M).toFixed(2)} re S`,
];
const line = (x0: number, y0: number, x1: number, y1: number) => `${X(x0)} ${Y(y0)} m ${X(x1)} ${Y(y1)} l S`;

function pdf(ops: string[], text: string[] = []): string {
  const stream = ["q", "0.5 g 0 G 0.5 w", ...ops, ...text.map((t) => `BT /F1 8 Tf ${t} ET`), "Q"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const dir = mkdtempSync(path.join(tmpdir(), "otk-walls-"));
  const file = path.join(dir, "plan.pdf");
  writeFileSync(file, out, "latin1");
  return file;
}

// A 10 × 6 m building, 300 mm exterior walls; a 100 mm partition at x = 6 m
// with a 900 mm door; a 1.2 m window in the south wall at x = 4.0 … 5.2 m.
function building(): string[] {
  const ops = [
    ...wall(0, 0, 4.0, 0.3), ...wall(5.2, 0, 10, 0.3),   // south, split by the window
    ...wall(0, 5.7, 10, 6),                              // north
    ...wall(0, 0.3, 0.3, 5.7), ...wall(9.7, 0.3, 10, 5.7), // west, east
    ...wall(6.0, 0.3, 6.1, 2.0), ...wall(6.0, 2.9, 6.1, 5.7), // partition, split by the door
    // window: jamb lines across the band and two glazing lines inside it
    line(4.0, 0, 4.0, 0.3), line(5.2, 0, 5.2, 0.3), line(4.0, 0.13, 5.2, 0.13), line(4.0, 0.17, 5.2, 0.17),
  ];
  // door leaf open at 90° from the hinge at (6.1, 2.0), and its quarter swing
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

test("walls: centreline lengths, thickness classes, sides, gross and net of openings", async () => {
  const { s, key } = await open(pdf(building()));
  const r = await s.measureWalls(key, {});
  const ext = r.runs.filter((x) => x.side === "ext"), int = r.runs.filter((x) => x.side === "int");
  near(r.totals.exterior_gross_m, 2 * (9.7 + 5.7), 0.15, "exterior centreline perimeter (L corners to the intersection)");
  assert.ok(ext.every((x) => Math.abs(x.thickness_mm - 300) <= 10), `exterior thickness ${ext.map((x) => x.thickness_mm)}`);
  assert.equal(int.length, 1, "one partition");
  near(int[0].gross_m, 5.4, 0.1, "partition gross: face to face at both T junctions");
  near(int[0].thickness_mm, 100, 10, "partition thickness");
  near(int[0].net_m, 4.5, 0.1, "partition net of its 900 mm door");
  const south = ext.find((x) => x.openings.some((o) => o.kind === "window"));
  assert.ok(south, "the south wall carries the window as an opening");
  near(south!.gross_m - south!.net_m, 1.2, 0.05, "window width deducted from net");
  assert.equal(r.height.status, "unknown", "no height without a stated source");
  assert.ok(r.classes.every((c) => c.area_gross_m2 === undefined), "no area without a height");
  assert.equal(r.committed, 0, "preview by default");
});

test("walls: a stated height gives area, and commit files one shape per run under its class", async () => {
  const { s, key } = await open(pdf(building()));
  const r = await s.measureWalls(key, { commit: true, height_ft: 9 });
  assert.equal(r.committed, r.runs.length);
  const shapes = s.exportPayload().shapes;
  assert.equal(shapes.length, r.runs.length);
  assert.ok(shapes.every((x: any) => x.measure_role === "surface_area" && x.origin.actor === "agent" && x.origin.reviewed === false));
  const ext = r.classes.find((c) => c.side === "ext")!;
  near(ext.area_gross_m2!, ext.gross_m * 9 * 0.3048, 0.05, "area = gross length × stated height");
  assert.ok(s.summary().conditions.some((c: any) => c.finish_tag === "WALL EXT 300"));
});

test("walls: a lone short band and a wall-type legend are not walls", async () => {
  const ops = building();
  // a legend: four sample bands stacked in a column away from the building
  for (let k = 0; k < 4; k++) ops.push(...wall(15, 1 + k * 0.6, 17, 1.2 + k * 0.6));
  const { s, key } = await open(pdf(ops));
  const r = await s.measureWalls(key, {});
  assert.ok(r.runs.every((x) => x.line.every(([px]) => px < (OX + 12 * PT_PER_M) * 2)), "nothing counted in the legend");
  assert.ok(r.withheld.some((w) => /isolated/.test(w.reason as string)), "the samples are withheld with a reason");
});

test("windows: the glazed opening is found with its width; no schedule means no row and says so", async () => {
  const { s, key } = await open(pdf(building()));
  const w = await s.countWindows(key, {});
  assert.equal(w.found, 1);
  near(w.windows[0].width_mm, 1200, 30, "window width");
  assert.equal(w.windows[0].side, "exterior");
  assert.equal((w.schedule as any).status, "none");
  assert.equal(w.plan_without_row.length, 1);
});

test("walls: single-line walls have no bands; a scan refuses rather than guess", async () => {
  const demo = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
  const d = new Session();
  await d.loadPlan(demo);
  d.setScale("sample-plan.pdf", { label: '1/4" = 1\'-0"' });
  const r = await d.measureWalls("sample-plan.pdf", {});
  assert.equal(r.runs.length, 0, "a wall drawn as one stroke has no thickness to read");
  const scan = fileURLToPath(new URL("./fixtures/scanned-plan.pdf", import.meta.url));
  const sc = new Session();
  await sc.loadPlan(scan);
  const k = sc.sheetList()[0].key;
  sc.setScale(k, { upp: 0.05 });
  await assert.rejects(sc.measureWalls(k, {}), /raster scan/);
});

test("thickness classes: one partition type read as 95, 100 and 106 mm is one class", () => {
  const cls = thicknessClasses([{ thicknessM: 0.095, grossM: 2 }, { thicknessM: 0.1, grossM: 5 }, { thicknessM: 0.106, grossM: 3 }, { thicknessM: 0.3, grossM: 10 }]);
  assert.deepEqual(cls, [100, 100, 100, 300]);
});
