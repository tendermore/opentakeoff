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
