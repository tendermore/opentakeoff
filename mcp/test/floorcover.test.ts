// Floor coverage (web/src/lib/floorcover.ts) on synthetic rasters: the floor a
// takeoff has not measured splits into zones at walls and drawn lines only; a
// piece with no room label folds into the one room it touches; what nothing
// separates stays one zone. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverZones, zoneCuts, wallFaceSegs, type CoverLabel } from "../../web/src/lib/floorcover.ts";
import { SEG_FILLONLY, type MaskObj } from "../../web/src/lib/oneclick.ts";

// 10 px per metre, one mask cell per px: a 40 m × 20 m building with walls round it
const PX_PER_M = 10, W = 420, H = 220;
function building(): MaskObj {
  const mask = new Uint8Array(W * H);
  const mo: MaskObj = { mask, mw: W, mh: H, ws: 1, softCount: 0 };
  rect(mo, 10, 10, 410, 210);
  return mo;
}
function line(mo: MaskObj | Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const m = mo instanceof Uint8Array ? mo : mo.mask;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= n; k++) m[Math.round(y0 + ((y1 - y0) * k) / n) * W + Math.round(x0 + ((x1 - x0) * k) / n)] = 1;
}
function rect(mo: MaskObj, x0: number, y0: number, x1: number, y1: number): void {
  line(mo, x0, y0, x1, y0); line(mo, x1, y0, x1, y1); line(mo, x1, y1, x0, y1); line(mo, x0, y1, x0, y0);
}
const stamp = (m2: number | null, x: number, y: number, text = `${m2}`): CoverLabel => ({ text, m2, x, y, h: 4 });
const cover = (walls: MaskObj, labels: CoverLabel[], cuts: Uint8Array | null = null, measured: [number, number][][] = []) =>
  coverZones({ walls, cuts, measured, labels, pxPerM: PX_PER_M, leakM2: 10_000 });

test("two labels in one open floor stay one zone when nothing is drawn between them", () => {
  const r = cover(building(), [stamp(400, 100, 100), stamp(400, 300, 100)]);
  assert.equal(r.zones.length, 1);
  assert.deepEqual(r.zones[0].labels, [0, 1]);
  assert.equal(r.zones[0].unsplit, true);
  assert.ok(Math.abs(r.zones[0].m2 - 800) < 20, `zone ${r.zones[0].m2}`);
});

test("a drawn line from wall to wall splits them; a pocket with no label folds into the room it touches", () => {
  const walls = building();
  const cuts = new Uint8Array(W * H);
  line(cuts, 210, 11, 210, 209);                 // the zone line between the two rooms
  line(cuts, 11, 150, 60, 150); line(cuts, 60, 150, 60, 209);   // a counter drawn in the left room
  const r = cover(walls, [stamp(400, 100, 100), stamp(400, 300, 100)], cuts);
  assert.equal(r.zones.length, 2);
  for (const z of r.zones) {
    assert.equal(z.labels.length, 1);
    assert.ok(Math.abs(z.m2 - 400) < 12, `zone ${z.m2}`);
  }
  assert.ok((r.zones.find((z) => z.labels[0] === 0)!.mergedM2 ?? 0) > 20, "the counter pocket folded into the left room");
});

test("measured floor is taken out; its label reads as measured; an unlabelled walled space inside is reported, a wall cavity is not", () => {
  const walls = building();
  line(walls, 210, 10, 210, 210);                // a wall: left and right rooms
  rect(walls, 20, 150, 120, 200);                // a walled 10 m × 5 m room nobody labelled
  line(walls, 150, 150, 150, 210); line(walls, 152, 150, 152, 210); line(walls, 150, 150, 152, 150);   // a wall drawn as two faces
  const measured: [number, number][][] = [[[211, 11], [409, 11], [409, 209], [211, 209]]];
  const r = cover(walls, [stamp(400, 100, 100), stamp(400, 300, 100)], null, measured);
  assert.deepEqual(r.measuredLabels, [1]);
  assert.equal(r.zones.length, 1);
  assert.deepEqual(r.zones[0].labels, [0]);
  assert.equal(r.unlabeled.length, 1, "the walled room, not the 2 px cavity between the wall's faces");
  assert.ok(Math.abs(r.unlabeled[0].m2 - 50) < 3, `unlabelled ${r.unlabeled[0].m2}`);
});

test("access: measured floor reaches a piece by a door or an opening; any other door still reports it; only a small piece nothing touches is set apart", () => {
  const walls = building();
  line(walls, 210, 10, 210, 210);                // left: a measured room; right: a labelled room nobody measured
  rect(walls, 210, 40, 290, 120);                // A: its door in the wall to the measured room
  rect(walls, 300, 40, 380, 120);                // A2: its door into the unmeasured room only
  rect(walls, 220, 150, 260, 190);               // B: 16 m², no door — a shaft
  rect(walls, 270, 140, 320, 209);               // D: 34 m², no door — more than a shaft or stair well holds
  rect(walls, 330, 140, 409, 209);               // E: 55 m², its only door in the outer wall
  // the left room is measured down to y = 150; below it the floor runs on with no wall between: an opening
  const measured: [number, number][][] = [[[11, 11], [209, 11], [209, 150], [11, 150]]];
  type Door = [[number, number], [number, number]];
  const doorA: Door = [[210, 70], [210, 90]], doorA2: Door = [[340, 120], [360, 120]], doorE: Door = [[350, 210], [370, 210]];
  const run = (doors: Door[] | null, texts: [number, number][] = []) =>
    coverZones({ walls, cuts: null, measured, labels: [stamp(10, 395, 30)], pxPerM: PX_PER_M, leakM2: 10_000, doors, texts });
  const at = (z: { bbox: number[] }) => `${Math.round(z.bbox[0])},${Math.round(z.bbox[1])}`;
  const access = (r: ReturnType<typeof run>) => Object.fromEntries(r.unlabeled.map((z) => [at(z), z.access]));
  const r = run([doorA, doorA2, doorE]);
  assert.deepEqual(access(r), { "11,150": "opening", "211,41": "door", "301,41": "unreached", "271,141": "none", "331,141": "exterior" });
  assert.deepEqual(r.noAccess.map(at), ["221,151"]);
  // printed text inside a door-less piece keeps it reported
  const texted = run([doorA, doorA2, doorE], [[240, 170]]);
  assert.equal(access(texted)["221,151"], "none");
  assert.equal(texted.noAccess.length, 0);
  // through other floor: once the unmeasured room has a door to measured floor, A2 is reached through it
  assert.equal(access(run([doorA, doorA2, doorE, [[210, 195], [210, 205]]]))["301,41"], "door");
  // no doors read on the sheet: nothing is set apart
  const blind = run(null);
  assert.equal(blind.noAccess.length, 0);
  assert.equal(blind.unlabeled.length, 6);
});

test("a labelled room open onto measured floor is measured floor's too: a piece with a door into it is reached", () => {
  const walls = building();
  line(walls, 210, 10, 210, 210);
  rect(walls, 250, 40, 330, 120);                // an unlabelled room, its door into the right room
  // the right room is measured east of x = 340 only; the rest of it, labelled, runs on into the measured part
  // with no wall between — the unlabelled room's door opens into that labelled part, nowhere else
  const measured: [number, number][][] = [[[340, 11], [409, 11], [409, 209], [340, 209]]];
  const r = coverZones({ walls, cuts: null, measured, labels: [stamp(5, 290, 180), stamp(10, 100, 100)], pxPerM: PX_PER_M, leakM2: 10_000, doors: [[[280, 120], [300, 120]]] });
  const room = r.unlabeled.find((z) => Math.round(z.bbox[0]) === 251);
  assert.equal(room?.access, "door", JSON.stringify(r.unlabeled.map((z) => [z.bbox, z.access])));
  // without that opening (a wall at x = 340) the labelled part is cut off, and so is the room
  line(walls, 339, 10, 339, 210);
  const cut = coverZones({ walls, cuts: null, measured, labels: [stamp(5, 290, 180), stamp(10, 100, 100)], pxPerM: PX_PER_M, leakM2: 10_000, doors: [[[280, 120], [300, 120]]] });
  assert.equal(cut.unlabeled.find((z) => Math.round(z.bbox[0]) === 251)?.access, "unreached");
});

test("a zone's rectangle round a point is the part of the zone it sits in: one leg of an L", async () => {
  const { zoneRectAt } = await import("../../web/src/lib/floorcover.ts");
  const walls = building();
  rect(walls, 60, 60, 410, 210);                 // a walled block leaves an L of floor: a top strip and a left strip
  const r = cover(walls, [stamp(10, 300, 35), stamp(10, 35, 180)]);
  const z = r.zones.find((q) => q.labels.length === 2)!;
  const [x0, y0, x1, y1] = zoneRectAt(z, 35, 180, r.mw, r.mh, r.ws);
  assert.ok(x1 - x0 < 60 && y1 - y0 > 150, `left leg ${[x0, y0, x1, y1]}`);
  const top = zoneRectAt(z, 300, 35, r.mw, r.mh, r.ws);
  assert.ok(top[2] - top[0] > 350 && top[3] - top[1] < 60, `top leg ${top}`);
});

test("floor open to the sheet edge is the outside, never a room", () => {
  const walls = building();
  for (let y = 100; y < 120; y++) walls.mask[y * W + 10] = 0;   // a gap in the outer wall
  const r = cover(walls, [stamp(12, 100, 100)]);
  assert.equal(r.zones.length, 1);
  assert.equal(r.zones[0].leaks, true);
});

test("zone lines run wall to wall; a grid line crossing the walls is not one", () => {
  const walls = building();
  line(walls, 210, 10, 210, 100);                // a wall stub from the top
  // image px == mask px here (ws 1); segment 0: wall stub to the bottom wall; 1: a grid axis across everything
  const segs = [210, 101, 210, 209, 8, 60, 412, 60];
  const meta = new Uint8Array(2);
  const cuts = zoneCuts(segs, meta, new Uint8Array(2), walls, PX_PER_M);
  assert.equal(cuts[150 * W + 210], 1, "the line landing on walls at both ends is a cut");
  assert.equal(cuts[60 * W + 300], 0, "the axis crossing the outer walls is not");
});

test("wall faces pair at wall thickness; a field of parallel lines (stair treads) is not wall; a thin fill is", () => {
  const segs: number[] = [];
  segs.push(0, 0, 100, 0, 0, 2, 100, 2);                         // a wall: two faces 0.2 m apart
  for (let k = 0; k < 6; k++) segs.push(0, 50 + 3 * k, 30, 50 + 3 * k);   // treads every 0.3 m
  segs.push(200, 0, 201, 0, 201, 0, 201, 40, 201, 40, 200, 40, 200, 40, 200, 0);   // a 0.1 m filled column of wall
  const n = segs.length / 4;
  const meta = new Uint8Array(n);
  for (let i = n - 4; i < n; i++) meta[i] = SEG_FILLONLY;
  const w = wallFaceSegs(segs, meta, [{ i0: n - 4, i1: n, x0: 200, y0: 0, x1: 201, y1: 40, flags: SEG_FILLONLY }], PX_PER_M, SEG_FILLONLY);
  assert.deepEqual([w[0], w[1]], [1, 1]);
  for (let k = 2; k < 8; k++) assert.equal(w[k], 0, `tread ${k - 2}`);
  assert.equal(w[n - 1], 1);
});

// ── combined zones: several rooms, nothing drawn between them, one row checked against their sum ──
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const span = (str: string, x: number, y: number) => ({ str, x0: x - 20, y0: y - 6, x1: x + 20, y1: y + 6 });
// upp 1/36: 720 × 360 px = 200 SF = 18.58 m², two printed 9,3 m² together
const RECT: [number, number][] = [[0, 0], [720, 0], [720, 360], [0, 360]];
async function sheetWith(spans: ReturnType<typeof span>[]) {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 36 });
  (s as any).sheets.get(KEY).spans = spans;
  return s;
}
const commitZone = (s: Session, allowSum: boolean) =>
  (s as any).commit((s as any).sheet(KEY), "GULV", "floor_area", RECT, { area_sf: 200, perimeter_lf: 60 }, { method: "cover_v1", actor: "agent" }, undefined, allowSum);

test("a combined zone commits against the SUM of its rooms' printed areas, and only as a combined row", async () => {
  const s = await sheetWith([span("9,3 m²", 180, 180), span("9,3 m²", 540, 180), span("5,0 m²", 2000, 2000)]);
  assert.throws(() => commitZone(s, false), /PRINTED_AREA_DISAGREES/, "an ordinary commit still refuses two rooms as one");
  const shape = commitZone(s, true);
  assert.deepEqual(shape.check, { status: "combined", by: "printed_sum", printed_m2: 18.6, parts: [9.3, 9.3] });
});

test("a combined zone is refused when its sum disagrees, or when a printed total sits inside", async () => {
  const off = await sheetWith([span("9,3 m²", 180, 180), span("12,0 m²", 540, 180), span("5,0 m²", 2000, 2000)]);
  assert.throws(() => commitZone(off, true), /PRINTED_AREA_DISAGREES/);
  const total = await sheetWith([span("9,3 m²", 180, 180), span("9,3 m²", 540, 180), span("BRA 18,6 m²", 360, 300), span("5,0 m²", 2000, 2000)]);
  assert.throws(() => commitZone(total, true), /PRINTED_AREA_DISAGREES/);
});

test("a zone in several pieces is outlined by its largest piece, never the first cell's; the share says how much that is", async () => {
  const { zonePieces, zoneRing } = await import("../../web/src/lib/floorcover.ts");
  const { ringArea } = await import("../../web/src/lib/oneclick.ts");
  // a zone folded together across drawn lines (splitZone) whose pieces a wall keeps apart: a 1 m × 1 m
  // pocket in the top-left corner (first in scan order) and the 30 m × 15 m room below it
  const cells: number[] = [];
  for (let y = 12; y < 22; y++) for (let x = 12; x < 22; x++) cells.push(y * W + x);
  for (let y = 40; y < 190; y++) for (let x = 12; x < 312; x++) cells.push(y * W + x);
  const z = { cells: Int32Array.from(cells), labels: [0], m2: cells.length / (PX_PER_M * PX_PER_M), leaks: false, wallShare: 1, at: [100, 100] as [number, number], bbox: [12, 12, 312, 190] as [number, number, number, number] };
  const p = zonePieces(z, W, H, 1);
  assert.equal(p.rings.length, 2);
  assert.ok(Math.abs(p.share - 45000 / 45100) < 1e-6, `share ${p.share}`);
  const largest = ringArea(p.ring) / (PX_PER_M * PX_PER_M);
  assert.ok(Math.abs(largest - 450) < 10, `largest piece ${largest} m² (the pocket is 1 m²)`);
  assert.ok(ringArea(p.rings[1]) / (PX_PER_M * PX_PER_M) < 1.5, "the pocket is the other piece");
  assert.equal(ringArea(zoneRing(z, W, H, 1)), ringArea(p.ring), "zoneRing is the largest piece's outline");
});
