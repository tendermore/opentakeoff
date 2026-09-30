// Skirting along a room's ring (web/src/lib/skirting.ts), on synthetic walls:
// a 4 m × 3 m room at 50 px/m whose walls are drawn as face pairs 0.15 m thick.
// Every case changes one wall and checks what the base does there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skirtingOfRing, type SkirtingDoor } from "../../web/src/lib/skirting.ts";
import { Session } from "../src/session.ts";

type Pt = [number, number];
const PXM = 50, T = 7.5;                      // 50 px per metre, 0.15 m walls
const RING: Pt[] = [[0, 0], [200, 0], [200, 150], [0, 150]];

/** Wall pieces as [x0, y0, x1, y1] inner-face lines; each gets its outer face T further out. */
function walls(pieces: number[][], extra: number[][] = []) {
  const segs: number[] = [];
  for (const [x0, y0, x1, y1] of pieces) {
    segs.push(x0, y0, x1, y1);
    // outward: the room is x 0..200, y 0..150
    const ox = x0 === x1 ? (x0 <= 0 ? -T : T) : 0, oy = y0 === y1 ? (y0 <= 0 ? -T : T) : 0;
    segs.push(x0 + ox, y0 + oy, x1 + ox, y1 + oy);
  }
  const faces = new Uint8Array(segs.length / 4).fill(1);
  for (const e of extra) segs.push(...e);
  const all = new Uint8Array(segs.length / 4);
  all.set(faces);
  return { segs, meta: new Uint8Array(segs.length / 4), faces: all };
}
const TOP = [0, 0, 200, 0], RIGHT = [200, 0, 200, 150], BOTTOM = [200, 150, 0, 150], LEFT = [0, 150, 0, 0];
const run = (w: ReturnType<typeof walls>, doors: SkirtingDoor[] = [], ring: Pt[] = RING) =>
  skirtingOfRing(ring, w.segs, w.meta, w.faces, PXM, doors, () => true);
const len = (p: Pt[]) => p.slice(1).reduce((n, q, i) => n + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0) / PXM;
const close = (a: number, b: number, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

test("a room walled all round: the whole perimeter, one closed run", () => {
  const r = run(walls([TOP, RIGHT, BOTTOM, LEFT]));
  close(r.gross_m, 14); close(r.net_m, 14);
  assert.equal(r.deductions.length, 0);
  assert.equal(r.flags.length, 0);
  assert.equal(r.runs.length, 1);
  close(len(r.runs[0]), 14);
});

test("a door: its leaf width comes off, centred on the opening, and the run has the gap", () => {
  const w = walls([TOP, RIGHT, [200, 150, 125, 150], [80, 150, 0, 150], LEFT]);
  const door: SkirtingDoor = { opening: [[80, 150], [125, 150]], width: 45, leaves: 1, at: [102.5, 150] };
  const r = run(w, [door]);
  close(r.net_m, 14 - 0.9);
  assert.deepEqual(r.deductions.map((d) => d.kind), ["door"]);
  close(r.deductions[0].door!.width_m, 0.9);
  assert.equal(r.runs.length, 1, "one open run round the room");
  close(len(r.runs[0]), 13.1);
  // the run starts and ends at the door's jambs
  const ends = [r.runs[0][0], r.runs[0][r.runs[0].length - 1]].map((p) => p[0]).sort((a, b) => a - b);
  close(ends[0], 80, 0.5); close(ends[1], 125, 0.5);
});

test("a door that does not open on the ring deducts nothing", () => {
  const door: SkirtingDoor = { opening: [[80, 150], [125, 150]], width: 45, leaves: 1, at: [102.5, 150] };
  const r = skirtingOfRing(RING, walls([TOP, RIGHT, BOTTOM, LEFT]).segs, walls([TOP, RIGHT, BOTTOM, LEFT]).meta, walls([TOP, RIGHT, BOTTOM, LEFT]).faces, PXM, [door], () => false);
  close(r.net_m, 14);
});

test("an open side (no wall drawn) comes off as open_side", () => {
  const r = run(walls([TOP, BOTTOM, LEFT]));
  close(r.net_m, 11);
  assert.deepEqual(r.deductions.map((d) => d.kind), ["open_side"]);
  close(r.deductions[0].length_m, 3);
});

test("an opening with no door between walls comes off as opening; a pilaster-width break does not", () => {
  const passage = run(walls([TOP, [200, 0, 200, 40], [200, 90, 200, 150], BOTTOM, LEFT]));   // 1.0 m gap
  assert.deepEqual(passage.deductions.map((d) => d.kind), ["opening"]);
  close(passage.net_m, 13);
  const narrow = run(walls([TOP, [200, 0, 200, 60], [200, 85, 200, 150], BOTTOM, LEFT]));    // 0.5 m
  assert.equal(narrow.deductions.length, 0);
  close(narrow.net_m, 14);
  assert.deepEqual(narrow.kept.map((k) => k.kind), ["junction"]);
});

test("a window: the base runs on under it", () => {
  // top wall broken 1.6 m, with two glazing lines inside the wall band
  const r = run(walls([[0, 0, 60, 0], [140, 0, 200, 0], RIGHT, BOTTOM, LEFT], [[60, -3, 140, -3], [60, -5, 140, -5]]));
  close(r.net_m, 14);
  assert.deepEqual(r.kept.map((k) => k.kind), ["window"]);
});

test("a ring off the wall faces is flagged, never measured", () => {
  // the ring drawn 0.2 m inside the walls: faces run alongside it, not under it
  const inset: Pt[] = [[10, 10], [190, 10], [190, 140], [10, 140]];
  const r = run(walls([TOP, RIGHT, BOTTOM, LEFT]), [], inset);
  assert.ok(r.flags.length > 0);
  assert.equal(r.flags[0].reason, "off_walls");
});

test("a ring along a line that is not a wall is flagged, not an open side", () => {
  // the right side follows a single drawn line (casework, a mesh partition): no face pair there
  const r = run(walls([TOP, BOTTOM, LEFT], [[200, 0, 200, 150]]));
  assert.deepEqual(r.flags.map((f) => f.reason), ["unread_edge"]);
});

test("a spike in the trace (out into a door swing and straight back) is dropped, and said", () => {
  const spiked: Pt[] = [[0, 0], [200, 0], [200, 150], [120, 150], [120, 190], [120, 150], [0, 150]];
  const r = run(walls([TOP, RIGHT, BOTTOM, LEFT]), [], spiked);
  close(r.gross_m, 14 + 1.6);
  close(r.spikes_m, 1.6);
  close(r.net_m, 14);
  assert.equal(r.flags.length, 0);
});

test("a curved wall along the ring is drawn ink, not an open side: flagged, never deducted", () => {
  // the right side is a bowed wall drawn as curve chords (meta SEG_CURVE = 1), which the face reader does not read
  const w = walls([TOP, BOTTOM, LEFT]);
  const arc: number[] = [];
  for (let k = 0; k < 10; k++) arc.push(200 + Math.sin((k / 10) * Math.PI) * 1, k * 15, 200 + Math.sin(((k + 1) / 10) * Math.PI) * 1, (k + 1) * 15);
  const segs = [...w.segs, ...arc];
  const meta = new Uint8Array(segs.length / 4); meta.fill(1, w.segs.length / 4);
  const faces = new Uint8Array(segs.length / 4); faces.set(w.faces);
  const r = skirtingOfRing(RING, segs, meta, faces, PXM, [], () => true);
  assert.equal(r.deductions.length, 0);
  assert.deepEqual(r.flags.map((f) => f.reason), ["unread_edge"]);
});

// Session: derive {action: "base"} on the demo plan, whose walls are single lines the face reader does not pair.
const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

test("derive base flags what it cannot read, refuses tag-sized outlines, and a repeat files nothing", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 36 });
  const room = s.measurePolygon(KEY, [[100, 100], [460, 100], [460, 460], [100, 460]], { condition: "F-1", role: "floor_area" }).shape_id!;
  const tag = s.measurePolygon(KEY, [[1000, 1000], [1030, 1000], [1030, 1012], [1000, 1012]], { condition: "F-1", role: "floor_area" }).shape_id!;
  const first = await s.deriveBase({ source_condition: "F-1", condition: "B-1" });
  assert.equal(first.committed, 0, "nothing is guessed");
  assert.deepEqual(first.rooms.map((r) => [r.source_shape_id, r.flags?.[0].reason]), [[room, "unread"], [tag, "not_a_room"]]);
  assert.equal(first.total_lf, 0);
  assert.ok(first.rooms.every((r) => r.net_lf === 0 && r.openings_lf === 0 && (r.unmeasured_gross_lf ?? 0) > 0), "a flagged room reports no net, and what went unmeasured");
  const stated = await s.deriveBase({ source_condition: "F-1", condition: "B-1", openings: [{ shape_id: room, lf: 3 }] });
  assert.equal(stated.committed, 1);
  assert.equal(stated.rooms[0].status, "stated");
  assert.equal(stated.rooms[0].net_lf, 40 - 3);
  assert.equal(stated.sheets.length, 1);
  assert.deepEqual({ ...stated.sheets[0], unmeasured_gross_lf: 0 }, { sheet: KEY, rooms: 1, flagged: 1, net_lf: 37, net_m: 11.28, unmeasured_gross_lf: 0 });
  const again = await s.deriveBase({ source_condition: "F-1", condition: "B-1", openings: [{ shape_id: room, lf: 5 }] });
  assert.equal(again.committed, 0);
  assert.equal(again.rooms[0].status, "already_derived");
  assert.equal(again.rooms[0].flags?.[0].reason, "openings_ignored", "openings stated for a room that already has base are said to be ignored");
  assert.equal(again.total_lf, 37);
});

// ── Session, the measured path, on synthetic plans drawn the way CAD exports walls: filled and stroked
// bands, a door as a break in a partition with its leaf and swing, a window as glazing lines in a break.
// A 10 × 6 m building, 300 mm exterior walls, a 100 mm partition at x = 6 m with a 900 mm door at
// y = 2.0 … 2.9, a 1.2 m window in the south wall at x = 4.0 … 5.2. West room 5.7 × 5.4 m, east 3.6 × 5.4 m.
const PW = 1190, PH = 842, OX = 150, OY = 150;
type Plan = { ppm: number; ops: string[] };
const plan = (scale: number): Plan => ({ ppm: 1000 / scale / 25.4 * 72, ops: [] });
const X = (p: Plan, m: number) => (OX + m * p.ppm).toFixed(2), Y = (p: Plan, m: number) => (OY + m * p.ppm).toFixed(2);
const band = (p: Plan, x0: number, y0: number, x1: number, y1: number) => {
  const r = `${X(p, x0)} ${Y(p, y0)} ${((x1 - x0) * p.ppm).toFixed(2)} ${((y1 - y0) * p.ppm).toFixed(2)} re`;
  p.ops.push(`${r} f`, `${r} S`);
};
const seg = (p: Plan, x0: number, y0: number, x1: number, y1: number) => p.ops.push(`${X(p, x0)} ${Y(p, y0)} m ${X(p, x1)} ${Y(p, y1)} l S`);
/** The building; `partition` draws the partition pieces (default: split by the door only). */
function building(p: Plan, o: { partition?: [number, number][]; glazing?: number[]; south?: [number, number][] } = {}): Plan {
  for (const [a, b] of o.south ?? [[0, 4.0], [5.2, 10]]) band(p, a, 0, b, 0.3);
  band(p, 0, 5.7, 10, 6); band(p, 0, 0.3, 0.3, 5.7); band(p, 9.7, 0.3, 10, 5.7);
  for (const [a, b] of o.partition ?? [[0.3, 2.0], [2.9, 5.7]]) band(p, 6.0, a, 6.1, b);
  seg(p, 4.0, 0, 4.0, 0.3); seg(p, 5.2, 0, 5.2, 0.3);
  for (const y of o.glazing ?? [0.13, 0.17]) seg(p, 4.0, y, 5.2, y);
  // the door: leaf open at 90° from the hinge (6.1, 2.0), and its quarter swing back to the jamb (6.1, 2.9)
  const r = 0.9, k = 0.5523 * r;
  seg(p, 6.1, 2.0, 6.1 + r, 2.0);
  p.ops.push(`${X(p, 6.1 + r)} ${Y(p, 2.0)} m ${X(p, 6.1 + r)} ${Y(p, 2.0 + k)} ${X(p, 6.1 + k)} ${Y(p, 2.0 + r)} ${X(p, 6.1)} ${Y(p, 2.0 + r)} c S`);
  return p;
}
function writePdf(p: Plan): string {
  const stream = ["q", "0.5 g 0 G 0.5 w", ...p.ops, "Q"].join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents 4 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(mkdtempSync(path.join(tmpdir(), "otk-skirt-")), "plan.pdf");
  writeFileSync(file, out, "latin1");
  return file;
}
/** A ring in metres → image px (2 px per pt, y down). */
const px = (p: Plan, ring: [number, number][]): [number, number][] => ring.map(([x, y]) => [(OX + x * p.ppm) * 2, (PH - (OY + y * p.ppm)) * 2]);
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const WEST = rect(0.3, 0.3, 6.0, 5.7), EAST = rect(6.1, 0.3, 9.7, 5.7);
async function derive(p: Plan, rings: [number, number][][], cut?: [number, number][]) {
  const s = new Session();
  await s.loadPlan(writePdf(p));
  const key = s.sheetList()[0].key;
  s.setScale(key, { upp: 1 / (2 * p.ppm) / 0.3048 });
  const ids = rings.map((r) => s.measurePolygon(key, px(p, r), { condition: "GULV", role: "floor_area" }).shape_id!);
  if (cut) s.cutOut({ parent_shape_id: ids[0], verts: px(p, cut) });
  const r = await s.deriveBase({ source_condition: "GULV", condition: "LIST" });
  return { s, r, ids, room: (i: number) => r.rooms.find((x) => x.source_shape_id === ids[i])! };
}
const M = (lf: number) => lf * 0.3048;

for (const scale of [100, 50]) {
  test(`1:${scale}: two rooms sharing a partition — the door comes off both, the window keeps the base, runs sum to the quantity`, async () => {
    const p = building(plan(scale));
    const { s, r, room } = await derive(p, [WEST, EAST]);
    const w = room(0), e = room(1);
    assert.equal(w.status, "measured", JSON.stringify(w.flags));
    assert.equal(e.status, "measured", JSON.stringify(e.flags));
    close(w.net_m, 22.2 - 0.9, 0.05); close(e.net_m, 18.0 - 0.9, 0.05);
    assert.deepEqual(w.deductions!.map((d) => d.kind), ["door"]);
    assert.deepEqual(e.deductions!.map((d) => d.kind), ["door"]);
    close(w.deductions![0].width_m!, 0.9, 0.03);
    assert.ok(w.kept!.some((k) => k.kind === "window"), "the base runs on under the window");
    const shapes = s.exportPayload().shapes as any[];
    const lf = (ids: string[]) => ids.reduce((n, id) => n + shapes.find((x) => x.id === id).computed.perimeter_lf, 0);
    close(M(lf(w.base_shape_ids)), w.net_m, 0.02);
    assert.equal(r.sheets[0].rooms, 2);
    close(r.total_m, w.net_m + e.net_m, 0.02);
    const again = await s.deriveBase({ source_condition: "GULV", condition: "LIST" });
    assert.equal(again.committed, 0, "a repeat files nothing");
  });
}

test("a concave (L-shaped) room is measured round its inside corner", async () => {
  // the west room with its north-east corner taken by a 2 × 2 m store walled off by 100 mm partitions
  const p = building(plan(100));
  band(p, 4.0, 3.7, 6.0, 3.8); band(p, 3.9, 3.7, 4.0, 5.7);
  const L: [number, number][] = [[0.3, 0.3], [6.0, 0.3], [6.0, 3.7], [3.9, 3.7], [3.9, 5.7], [0.3, 5.7]];
  const { room } = await derive(p, [L]);
  const w = room(0);
  assert.equal(w.status, "measured", JSON.stringify(w.flags));
  close(w.net_m, 2 * (5.7 + 5.4) - 0.9, 0.05);
});

test("a column cut out of a room gets its base round it; gross is the rings read", async () => {
  const p = building(plan(100));
  band(p, 2.0, 2.5, 2.4, 2.9);                     // a 400 mm column
  const { room } = await derive(p, [WEST], rect(2.0, 2.5, 2.4, 2.9));
  const w = room(0);
  assert.equal(w.status, "measured", JSON.stringify(w.flags));
  close(w.gross_lf * 0.3048, 22.2 + 1.6, 0.05);
  close(w.net_m, 22.2 - 0.9 + 1.6, 0.05);
});

test("an outline cutting a corner is flagged, not deducted as an opening", async () => {
  const p = building(plan(100));
  const cutCorner: [number, number][] = [[0.3, 1.0], [1.0, 0.3], [6.0, 0.3], [6.0, 5.7], [0.3, 5.7]];
  const w = (await derive(p, [cutCorner])).room(0);
  assert.equal(w.status, "flagged");
  assert.ok(w.flags!.some((f) => f.reason === "off_walls"), JSON.stringify(w.flags));
  assert.equal(w.net_lf, 0);
  assert.ok((w.unmeasured_gross_lf ?? 0) > 0);
});

test("a door beside a doorless opening: the break is wider than the door and its frame — flagged", async () => {
  const p = building(plan(100), { partition: [[0.3, 2.0], [3.9, 5.7]] });
  const w = (await derive(p, [WEST])).room(0);
  assert.equal(w.status, "flagged");
  assert.ok(w.flags!.some((f) => f.reason === "door_gap"), JSON.stringify(w.flags));
});

test("a window drawn with one glazing line is not taken for an opening", async () => {
  const p = building(plan(100), { glazing: [0.15] });
  const w = (await derive(p, [WEST])).room(0);
  assert.equal(w.status, "flagged");
  assert.ok(w.flags!.some((f) => f.reason === "unread_edge"), JSON.stringify(w.flags));
});

test("a doorless opening with nothing drawn across it comes off; a short curved wall across a break does not", async () => {
  // a 1.2 m doorless opening in the north wall of the west room
  const o = plan(100);
  building(o);
  const north = o.ops.findIndex((x) => x.startsWith(`${X(o, 0)} ${Y(o, 5.7)}`));
  o.ops.splice(north, 2);
  band(o, 0, 5.7, 2.0, 6); band(o, 3.2, 5.7, 10, 6);
  const w = (await derive(o, [WEST])).room(0);
  assert.equal(w.status, "measured", JSON.stringify(w.flags));
  assert.deepEqual(w.deductions!.map((d) => d.kind).sort(), ["door", "opening"]);
  close(w.net_m, 22.2 - 0.9 - 1.2, 0.05);
  // the same 1.2 m break bridged by a curved wall bowing out into the next space
  const c = plan(100);
  building(c);
  const n2 = c.ops.findIndex((x) => x.startsWith(`${X(c, 0)} ${Y(c, 5.7)}`));
  c.ops.splice(n2, 2);
  band(c, 0, 5.7, 2.0, 6); band(c, 3.2, 5.7, 10, 6);
  c.ops.push(`${X(c, 2.0)} ${Y(c, 5.7)} m ${X(c, 2.2)} ${Y(c, 5.95)} ${X(c, 3.0)} ${Y(c, 5.95)} ${X(c, 3.2)} ${Y(c, 5.7)} c S`);
  const wc = (await derive(c, [WEST])).room(0);
  assert.equal(wc.status, "flagged", JSON.stringify(wc.deductions));
  assert.ok(wc.flags!.some((f) => f.reason === "unread_edge"), JSON.stringify(wc.flags));
});
