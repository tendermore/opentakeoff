// Drawn-walls check for floor outlines with no printed area (wallcheck.ts),
// on synthetic geometry: walls drawn as line pairs, in image px at 100 px/m.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOnWalls, closeOpenings, dropOpenLeaves, toInsideFace } from "../src/lib/wallcheck.ts";

const PX_PER_M = 100;
type Pt = [number, number];

/** A geometry builder: every segment a wall face, or furniture (not one). */
function sheet() {
  const segs: number[] = [], faces: number[] = [];
  const line = (a: Pt, b: Pt, face = true) => { segs.push(a[0], a[1], b[0], b[1]); faces.push(face ? 1 : 0); };
  const geo = () => ({ segs, meta: new Uint8Array(faces.length), faces: Uint8Array.from(faces), pairs: Uint8Array.from(faces) });
  return { line, geo };
}

/** A 4 m × 3 m room (0..400, 0..300) walled by 0.2 m line pairs, with a 0.9 m
 * doorway in the south wall from x = 150 to 240 when `door`. */
function room(door = false) {
  const s = sheet();
  const pair = (a: Pt, b: Pt, off: Pt) => { s.line(a, b); s.line([a[0] + off[0], a[1] + off[1]], [b[0] + off[0], b[1] + off[1]]); };
  pair([0, 0], [400, 0], [0, -20]);            // north
  pair([0, 0], [0, 300], [-20, 0]);            // west
  pair([400, 0], [400, 300], [20, 0]);         // east
  if (door) { pair([0, 300], [150, 300], [0, 20]); pair([240, 300], [400, 300], [0, 20]); }
  else pair([0, 300], [400, 300], [0, 20]);    // south
  return s;
}
const RECT: Pt[] = [[0, 0], [400, 0], [400, 300], [0, 300]];

test("an outline on the room's wall faces passes, with its coverage", () => {
  const { segs, meta, faces, pairs } = room().geo();
  const r = checkOnWalls(RECT, segs, meta, faces, pairs, PX_PER_M);
  assert.equal(r.pass, true);
  assert.equal(r.coverage, 1);
});

test("a doorway gap between walls on both sides is an opening, not empty paper", () => {
  const { segs, meta, faces, pairs } = room(true).geo();
  assert.equal(checkOnWalls(RECT, segs, meta, faces, pairs, PX_PER_M).pass, true);
});

test("an outline stopped at furniture is refused: its edge runs along no wall", () => {
  const s = room();
  s.line([0, 200], [400, 200], false);          // a counter front across the room
  const { segs, meta, faces, pairs } = s.geo();
  const r = checkOnWalls([[0, 0], [400, 0], [400, 200], [0, 200]], segs, meta, faces, pairs, PX_PER_M);
  assert.equal(r.pass, false);
  assert.equal(r.reason, "off_walls");
  assert.equal(r.weakest?.coverage, 0);
});

test("two rooms measured as one are refused: the wall between them lies inside", () => {
  const s = room();
  // a second room east of the first, sharing the east wall pair (x 400..420)
  s.line([420, 0], [820, 0]); s.line([420, -20], [820, -20]);
  s.line([420, 300], [820, 300]); s.line([420, 320], [820, 320]);
  s.line([820, 0], [820, 300]); s.line([840, 0], [840, 300]);
  const { segs, meta, faces, pairs } = s.geo();
  const r = checkOnWalls([[0, 0], [820, 0], [820, 300], [0, 300]], segs, meta, faces, pairs, PX_PER_M);
  assert.equal(r.pass, false);
  assert.equal(r.reason, "wall_inside");
  assert.ok(r.inside_wall_m >= 0.8, `the 3 m wall pair counted inside: ${r.inside_wall_m}`);
});

test("a door at a corner excuses the gap its chord spans, which has wall on one side only", () => {
  const s = sheet();
  const pair = (a: Pt, b: Pt, off: Pt) => { s.line(a, b); s.line([a[0] + off[0], a[1] + off[1]], [b[0] + off[0], b[1] + off[1]]); };
  pair([0, 0], [400, 0], [0, -20]); pair([0, 0], [0, 300], [-20, 0]); pair([400, 0], [400, 300], [20, 0]);
  pair([90, 300], [400, 300], [0, 20]);         // south wall, a 0.9 m door in its west end
  const { segs, meta, faces, pairs } = s.geo();
  assert.equal(checkOnWalls(RECT, segs, meta, faces, pairs, PX_PER_M).pass, false, "no door known: the corner gap is paper");
  const door = { opening: [[0, 300], [90, 300]] as [Pt, Pt] };
  assert.equal(checkOnWalls(RECT, segs, meta, faces, pairs, PX_PER_M, [door]).pass, true);
  // a trace round the swing crosses floor, door or not
  const swing: Pt[] = [[0, 0], [400, 0], [400, 300], [90, 300], [64, 364], [0, 390], [0, 300]];
  assert.equal(checkOnWalls(swing, segs, meta, faces, pairs, PX_PER_M, [door]).pass, false);
});

test("closeOpenings cuts a notch no deeper than a wall off along the wall line, and keeps one reaching into the room", () => {
  const out: Pt[] = [[0, 0], [400, 0], [400, 300], [240, 300], [240, 320], [150, 320], [150, 300], [0, 300]];
  assert.deepEqual(closeOpenings(out, PX_PER_M), [[0, 0], [400, 0], [400, 300], [240, 300], [150, 300], [0, 300]]);
  const column: Pt[] = [[0, 0], [400, 0], [400, 300], [240, 300], [240, 280], [150, 280], [150, 300], [0, 300]];
  assert.equal(closeOpenings(column, PX_PER_M).length, column.length);
  const deep: Pt[] = [[0, 0], [400, 0], [400, 300], [240, 300], [240, 360], [150, 360], [150, 300], [0, 300]];
  assert.equal(closeOpenings(deep, PX_PER_M).length, deep.length, "0.6 m is deeper than a wall: a niche, kept");
});

test("toInsideFace moves an edge in onto a lining drawn within 0.1 m of the wall face", () => {
  const s = room();
  s.line([0, 292], [400, 292]);                 // an 8 cm pre-wall lining along the south wall
  const { segs, meta, faces } = s.geo();
  const moved = toInsideFace(RECT, segs, meta, faces, PX_PER_M);
  assert.deepEqual(moved.map(([x, y]) => [Math.round(x), Math.round(y)]), [[0, 0], [400, 0], [400, 292], [0, 292]]);
  const far = room();
  far.line([0, 250], [400, 250]);               // 0.5 m in: a counter, not a lining
  const g = far.geo();
  assert.deepEqual(toInsideFace(RECT, g.segs, g.meta, g.faces, PX_PER_M), RECT);
});

test("dropOpenLeaves cuts off the trace round a door leaf drawn open, and nothing else", () => {
  // a 0.9 m door in the west wall hinged at (0, 210), its leaf drawn open into the room along y = 210
  const door = { hinges: [[0, 210]] as Pt[], opening: [[0, 210], [0, 300]] as [Pt, Pt], width: 90 };
  const round: Pt[] = [[0, 0], [400, 0], [400, 300], [0, 300], [0, 212], [90, 212], [90, 208], [0, 208]];
  assert.deepEqual(dropOpenLeaves(round, [door], PX_PER_M), [[0, 0], [400, 0], [400, 300], [0, 300], [0, 212], [0, 208]]);
  assert.deepEqual(dropOpenLeaves(round, [], PX_PER_M), round, "no door: nothing is a leaf");
  const notch: Pt[] = [[0, 0], [400, 0], [400, 300], [240, 300], [240, 280], [150, 280], [150, 300], [0, 300]];
  assert.deepEqual(dropOpenLeaves(notch, [door], PX_PER_M), notch, "a column away from the door stays");
});
