// The drawn-walls check holds on metric sheets only (Session.unitsOf), and what
// detect_rooms reports about the rooms it seeds and withholds. Session-level
// against the bundled demo plans, with the unit signals set on the sheet (its
// scale, the scale note it prints, its text) as in floorcheck.test.ts.
// Run with: npm test
import { test } from "node:test";
// pinned fixture results must not depend on how loaded the machine is
process.env.OPENTAKEOFF_CALL_BUDGET_MS = "0";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import { textSpans } from "../src/pdf.ts";
import { SF_STAMP_RE } from "../../web/src/lib/detectRooms.ts";
import { DIMTEXT_RE } from "../../web/src/lib/sheets.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const FINISH = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));
const FKEY = "sample-finish-plan.pdf";
const SQ = (x: number, y: number, w = 360): [number, number][] => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
const span = (str: string, x: number, y: number) => ({ str, x0: x - 20, y0: y - 6, x1: x + 20, y1: y + 6 });

/** A loaded sheet whose unit signals are exactly these: a printed scale note
 * (or none) and these text spans — "own" keeps the sheet's text, "own-metric"
 * keeps it without its imperial evidence (SF areas, feet-inch strings); the
 * scale is set by upp, which says nothing about units. */
async function sheetWith(file: string, key: string, note: string | null, spans: ReturnType<typeof span>[] | "own" | "own-metric") {
  const s = new Session();
  await s.loadPlan(file);
  s.setScale(key, { upp: 1 / 36 });
  const st = (s as any).sheets.get(key);
  st.detected = note ? { upp: 1 / 36, label: note, multi: false } : null;
  if (spans === "own-metric") st.spans = textSpans(st.page).filter((sp) => !SF_STAMP_RE.test((sp.str || "").trim()) && !DIMTEXT_RE.test((sp.str || "").trim()));
  else if (spans !== "own") st.spans = spans;
  st.textUnits = undefined;
  return s;
}

test("unitsOf: metric signals make a metric sheet, any imperial signal overrides them, and no signal is unknown", async () => {
  const noted = await sheetWith(PLAN, KEY, "1:100", []);
  assert.deepEqual(noted.unitsOf(KEY), { system: "metric", by: ["scale note 1:100"] });
  const stamped = await sheetWith(PLAN, KEY, null, [span("9,3 m²", 100, 100), span("12,0 m²", 500, 100), span("5,0 m²", 900, 100)]);
  assert.equal(stamped.unitsOf(KEY).system, "metric", "three printed m² room areas");
  const dims = [span("12'-6\"", 100, 400), span("8'-0\"", 500, 400), span("3'-4\"", 900, 400)];
  const mixed = await sheetWith(PLAN, KEY, "1:100", dims);
  assert.equal(mixed.unitsOf(KEY).system, "imperial", "feet-inch dimensions override a metric scale note");
  const sf = await sheetWith(PLAN, KEY, "1:100", [span("705 SF", 100, 100), span("NSF 210", 500, 100), span("88 SF", 900, 100)]);
  assert.equal(sf.unitsOf(KEY).system, "imperial", "printed SF areas override a metric scale note");
  const labelled = await sheetWith(PLAN, KEY, null, []);
  labelled.setScale(KEY, { label: '1/4" = 1\'-0"' });
  assert.equal(labelled.unitsOf(KEY).system, "imperial", "the scale the sheet is set to votes too");
  const bare = await sheetWith(PLAN, KEY, null, []);
  assert.deepEqual(bare.unitsOf(KEY), { system: "unknown", by: [] });
  assert.equal(bare.unitsOf(KEY).system === "metric", false);
});

test("imperial and undecided sheets commit an outline with no printed area unverified, saying why; a metric sheet refuses one off the drawn walls", async () => {
  for (const [what, note] of [["imperial", '1/4" = 1\'-0"'], ["unknown", null]] as const) {
    const s = await sheetWith(FINISH, FKEY, note, "own");
    await s.prepareFloorCheck(FKEY);
    const r = s.measurePolygon(FKEY, SQ(40, 40), { condition: "F", role: "floor_area" });
    assert.ok(r.shape_id, `${what}: committed, as main commits it`);
    assert.equal(r.check, "unverified: units_not_metric", what);
  }
  const metric = await sheetWith(FINISH, FKEY, "1:100", "own-metric");
  await metric.prepareFloorCheck(FKEY);
  // a square laid across the plan's rooms and corridors follows no wall
  assert.throws(() => metric.measurePolygon(FKEY, SQ(700, 700, 600), { condition: "F", role: "floor_area" }), /OFF_DRAWN_WALLS/);
  assert.equal(metric.shapes.length, 0);
});

test("detect_rooms on a metric sheet: outlines off the drawn walls are withheld with a reason and a seed, and every withheld label is named", async () => {
  const metric = await sheetWith(FINISH, FKEY, "1:100", "own-metric");
  const r: any = await metric.detectRooms(FKEY, { role: "floor_area", returnVerts: false, condition: "F" });
  assert.ok(r.withheld.off_walls > 0, "this plan's outlines are judged against its drawn walls");
  assert.equal(r.off_walls.length, r.withheld.off_walls, "each off-walls room is listed");
  for (const o of r.off_walls) {
    assert.match(o.reason, /runs along drawn walls|drawn wall inside|rooms' labels|no edge long enough/);
    assert.equal(o.seed.length, 2);
  }
  for (const room of r.rooms) assert.ok(["drawn_walls", "printed_area"].includes(room.check), `a committed room says what checked it (${room.check})`);
  // the names behind every count
  for (const [reason, n] of Object.entries(r.withheld)) {
    if (reason === "total" || reason === "min_area_sf") continue;
    assert.equal(r.withheld_labels.filter((w: any) => w.reason === reason).length, n, `${reason}: one named label per count`);
  }
  const offNamed = r.withheld_labels.filter((w: any) => w.reason === "off_walls").map((w: any) => w.label).sort();
  assert.deepEqual(offNamed, r.off_walls.map((o: any) => o.label).sort());

  const imperial = await sheetWith(FINISH, FKEY, '1/4" = 1\'-0"', "own");
  const ri: any = await imperial.detectRooms(FKEY, { role: "floor_area", returnVerts: false });
  assert.equal(ri.withheld.off_walls, 0, "the imperial sheet is not judged against its walls");
  // its previews say why: its printed SF areas check the rooms they sit in, the rest say the walls were not judged
  assert.ok(ri.rooms.every((x: any) => /^(unverified: units_not_metric|printed_area|would be refused: PRINTED_AREA_DISAGREES)/.test(x.check)), ri.rooms.map((x: any) => x.check).join(" | "));
  assert.ok(ri.rooms.some((x: any) => x.check === "unverified: units_not_metric"));
});

test("detect_rooms labels: seeds only from the texts passed, lists those the sheet does not print, and refuses an empty list", async () => {
  const s = await sheetWith(FINISH, FKEY, '1/4" = 1\'-0"', "own");
  const own: any = await s.detectRooms(FKEY, { role: "floor_area", returnVerts: false });
  const some = own.rooms.slice(0, 2).map((x: any) => x.label);
  assert.equal(some.length, 2);
  const r: any = await s.detectRooms(FKEY, { role: "floor_area", returnVerts: false, labels: [...some, "NO-SUCH-ROOM", { text: some[0], at: [1, 1] }] });
  const seeded = [...r.rooms.map((x: any) => x.label), ...r.withheld_labels.map((w: any) => w.label)];
  assert.ok(seeded.every((l: string) => some.includes(l)), `only the passed labels seed (got ${[...new Set(seeded)].join(",")})`);
  assert.deepEqual(r.labels_unmatched, ["NO-SUCH-ROOM", some[0]], "a text the sheet does not print, and one not printed near `at`");
  await assert.rejects(() => s.detectRooms(FKEY, { role: "floor_area", returnVerts: false, labels: [] }), /labels is empty/);
});
