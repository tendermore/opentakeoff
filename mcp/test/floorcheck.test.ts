// Floor checks — every floor outline says what checked it: a room area printed
// inside it that it agrees with, or nothing (and why). Two rooms measured as one
// outline, and floor claimed twice under one condition, are refused at commit.
// Session-level against the bundled demo plan, with printed room areas placed as
// text spans (the plan itself prints none). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
// upp 1/36 → a 360 px square is 10 ft × 10 ft = 100 SF = 9.29 m²
const SQ = (x: number, y: number, w = 360, h = w): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const span = (str: string, x: number, y: number) => ({ str, x0: x - 20, y0: y - 6, x1: x + 20, y1: y + 6 });

async function stamped() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 36 });
  // two 9,3 m² rooms side by side and a third stamp elsewhere: a sheet that tags rooms
  (s as any).sheets.get(KEY).spans = [span("9,3 m²", 180, 180), span("9,3 m²", 540, 180), span("5,0 m²", 2000, 2000)];
  return s;
}

// The demo plan prints a 1/4" = 1'-0" scale note: an imperial sheet, where an
// outline with no printed area to check it commits unverified and says the
// drawn-walls check does not apply (units_not_metric; unitgate.test.ts has the
// metric side).
test("an outline agreeing with the room area printed inside it is verified; one with none inside, or on a sheet without printed areas, says why not", async () => {
  const s = await stamped();
  assert.equal(s.measurePolygon(KEY, SQ(0, 0), { condition: "GULV", role: "floor_area" }).check, "printed_area");
  assert.equal(s.measurePolygon(KEY, SQ(1000, 1000), { condition: "GULV", role: "floor_area" }).check, "unverified: units_not_metric");
  const bare = new Session();
  await bare.loadPlan(PLAN);
  bare.setScale(KEY, { upp: 1 / 36 });
  const r = bare.measurePolygon(KEY, SQ(0, 0), { condition: "GULV", role: "floor_area" });
  assert.equal(r.check, "unverified: units_not_metric");
  assert.deepEqual(bare.shapes.find((x) => x.id === r.shape_id)!.check, { status: "unverified", reason: "units_not_metric" });
  assert.equal(bare.listShapes().shapes[0].check, "unverified: units_not_metric");
});

test("a preview states the check the commit would record, and both name the printed area the outline matched", async () => {
  const s = await stamped();
  const preview = s.measurePolygon(KEY, SQ(0, 0), { role: "floor_area" });
  assert.equal(preview.check, "printed_area");
  assert.deepEqual(preview.printed_match, { label: "9,3 m²", m2: 9.3, at: [180, 180] });
  assert.equal(s.shapes.length, 0, "a preview commits nothing");
  const refused = s.measurePolygon(KEY, SQ(0, 0, 720, 360), { role: "floor_area" });
  assert.match(refused.check!, /^would be refused: PRINTED_AREA_DISAGREES/);
  assert.equal(refused.printed_match, undefined);
  const committed = s.measurePolygon(KEY, SQ(360, 0), { condition: "GULV", role: "floor_area" });
  assert.deepEqual(committed.printed_match, { label: "9,3 m²", m2: 9.3, at: [540, 180] });
});

test("two rooms measured as one outline are refused even when the outline equals their printed sum", async () => {
  const s = await stamped();
  // 720 × 360 px = 200 SF = 18.58 m², the two printed 9,3 m² together
  assert.throws(() => s.measurePolygon(KEY, SQ(0, 0, 720, 360), { condition: "GULV", role: "floor_area" }), /PRINTED_AREA_DISAGREES: .*holds 2 rooms' printed areas/);
  assert.equal(s.shapes.length, 0);
});

test("floor already measured under the same condition is refused, a reshape into it too; another condition or a deduct is not", async () => {
  const s = await stamped();
  const a = s.measurePolygon(KEY, SQ(0, 0), { condition: "GULV", role: "floor_area" }).shape_id!;
  assert.throws(() => s.measurePolygon(KEY, SQ(0, 0), { condition: "GULV", role: "floor_area" }), /OVERLAPS_MEASURED: .*GULV/);
  const b = s.measurePolygon(KEY, SQ(360, 0), { condition: "GULV", role: "floor_area" }).shape_id!;   // shares only the wall line
  assert.equal(s.measurePolygon(KEY, SQ(0, 0), { condition: "PARKETT", role: "floor_area" }).check, "printed_area", "another condition is a collision scope_duplicates lists, not a refusal");
  s.measurePolygon(KEY, SQ(60, 60, 120, 120), { condition: "GULV", role: "deduct" });
  assert.throws(() => s.editShape(b, { verts: SQ(0, 0) }), /OVERLAPS_MEASURED/);
  assert.equal(s.shapes.find((x) => x.id === a)!.check?.status, "verified");
});
