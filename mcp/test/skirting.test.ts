// Skirting along a room's ring (web/src/lib/skirting.ts), on synthetic walls:
// a 4 m × 3 m room at 50 px/m whose walls are drawn as face pairs 0.15 m thick.
// Every case changes one wall and checks what the base does there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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
  const stated = await s.deriveBase({ source_condition: "F-1", condition: "B-1", openings: [{ shape_id: room, lf: 3 }] });
  assert.equal(stated.committed, 1);
  assert.equal(stated.rooms[0].status, "stated");
  assert.equal(stated.rooms[0].net_lf, 40 - 3);
  assert.deepEqual(stated.sheets, [{ sheet: KEY, rooms: 1, flagged: 1, net_lf: 37, net_m: 11.28 }]);
  const again = await s.deriveBase({ source_condition: "F-1", condition: "B-1" });
  assert.equal(again.committed, 0);
  assert.equal(again.rooms[0].status, "already_derived");
  assert.equal(again.total_lf, 37);
});
