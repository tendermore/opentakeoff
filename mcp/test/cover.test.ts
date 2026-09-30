// takeoff_rooms cover at the coverSheet level (mcp/src/cover.ts) on synthetic sheets: which zones commit,
// which are flagged and why, with commit stubbed; plus snapToWalls, hidden ink, and the Session's mark.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { coverSheet, snapToWalls, type CoverSheet } from "../src/cover.ts";
import { Session } from "../src/session.ts";
import { ROLE_HIDDEN } from "../../web/src/lib/layers.ts";
import type { MaskObj, Point, VectorGeometry } from "../../web/src/lib/oneclick.ts";

// 10 image px per metre, one mask cell per px; a 40 m × 20 m building, walls round it
const PX_PER_M = 10, W = 1000, H = 600, UPP = 1 / (PX_PER_M * 0.3048);
function mask(): MaskObj {
  const mo: MaskObj = { mask: new Uint8Array(W * H), mw: W, mh: H, ws: 1, softCount: 0 };
  rect(mo, 10, 10, 410, 210);
  return mo;
}
function line(mo: MaskObj, x0: number, y0: number, x1: number, y1: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= n; k++) mo.mask[Math.round(y0 + ((y1 - y0) * k) / n) * W + Math.round(x0 + ((x1 - x0) * k) / n)] = 1;
}
function rect(mo: MaskObj, x0: number, y0: number, x1: number, y1: number): void {
  line(mo, x0, y0, x1, y0); line(mo, x1, y0, x1, y1); line(mo, x1, y1, x0, y1); line(mo, x0, y1, x0, y0);
}
const span = (str: string, x: number, y: number) => ({ str, x0: x - 20, y0: y - 6, x1: x + 20, y1: y + 6 });
// stamps off the building, so the sheet reads as one that prints room areas (three or more); `reasons` skips them
const FAR = span("5,0 m²", 700, 400), FAR2 = span("6,0 m²", 800, 400);

type Commit = { ring: Point[]; label: string; combined?: boolean };
function sheet(m: MaskObj, over: Partial<CoverSheet> = {}): { sh: CoverSheet; commits: Commit[] } {
  const commits: Commit[] = [];
  const sh: CoverSheet = {
    key: "t", widthPx: W, heightPx: H, widthPt: W / 2, heightPt: H / 2, upp: UPP, spans: [], roomTags: [],
    geo: null, snap: null, nearestSnap: () => null, mask: m, roles: null, raster: false, measured: [],
    commit: (ring, _a, _p, _s, label, combined) => { commits.push({ ring, label, combined }); return { id: `shp${commits.length}`, check: combined ? "printed_sum" : "printed_area" }; },
    ...over,
  };
  return { sh, commits };
}
const reasons = (out: ReturnType<typeof coverSheet>) => out.rooms.filter((r) => r.status === "flagged" && !/^[56],0 m²$/.test(r.label)).map((r) => r.reason ?? "");

test("a zone whose outline surrounds a space it does not hold (a shaft, a room) is flagged, never committed", () => {
  const m = mask();
  rect(m, 150, 60, 250, 160);   // a walled 10 m × 10 m void inside the room, no label
  const { sh, commits } = sheet(m, { spans: [span("697,0 m²", 60, 100), FAR, FAR2] });
  const out = coverSheet(sh, { commit: true });
  assert.equal(commits.length, 0);
  assert.ok(reasons(out).some((r) => /surrounds .* not part of it/.test(r)), JSON.stringify(out.rooms));
});

test("combined: two rooms with nothing between them commit as ONE row when the zone matches their printed sum", () => {
  const { sh, commits } = sheet(mask(), { spans: [span("400,0 m²", 100, 100), span("396,0 m²", 300, 100), FAR] });
  const out = coverSheet(sh, { commit: true });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].combined, true);
  const combined = out.rooms.filter((r) => r.status === "combined");
  assert.equal(combined.length, 2);
  assert.deepEqual(combined[0].combined_with, ["396,0 m²"]);
  assert.equal(out.counts.combined, 2);
});

test("combined refusals: a sum that disagrees, a printed total inside, a printed area outside the outline", () => {
  // (a zone larger than every printed area on the sheet together is the outside, so the far stamp is large)
  const off = sheet(mask(), { spans: [span("400,0 m²", 100, 100), span("100,0 m²", 300, 100), span("900,0 m²", 700, 400)] });
  const offOut = coverSheet(off.sh, { commit: true }).rooms.filter((r) => r.label !== "900,0 m²").map((r) => r.reason ?? "");   // the far stamp is the outside
  assert.ok(offOut.length === 2 && offOut.every((r) => /does not agree with their sum 500 m²/.test(r)), offOut.join(" | "));
  assert.equal(off.commits.length, 0);
  const total = sheet(mask(), { spans: [span("400,0 m²", 100, 100), span("396,0 m²", 300, 100), span("BRA 796 m²", 200, 160)] });
  assert.ok(reasons(coverSheet(total.sh, { commit: true })).every((r) => /a printed total .* sits in it/.test(r)));
  assert.equal(total.commits.length, 0);
  // the second area's text sits on the outer wall line: its label reaches the zone, the outline does not reach it
  const outside = sheet(mask(), { spans: [span("400,0 m²", 100, 100), { str: "396,0 m²", x0: 0.6, y0: 94, x1: 20.6, y1: 106 }, FAR] });
  assert.ok(reasons(coverSheet(outside.sh, { commit: true })).every((r) => /not every printed area sits inside its outline/.test(r)));
  assert.equal(outside.commits.length, 0);
});

test("every flagged room carries a stable code and the numbers its reason compares", () => {
  const off = coverSheet(sheet(mask(), { spans: [span("400,0 m²", 100, 100), span("100,0 m²", 300, 100), span("900,0 m²", 700, 400)] }).sh, { commit: true });
  const pair = off.rooms.filter((r) => r.label !== "900,0 m²");
  assert.ok(pair.every((r) => r.code === "several_printed_sum_differs" && r.sum_m2 === 500 && r.outline_m2! > 780), JSON.stringify(pair));
  assert.equal(off.rooms.find((r) => r.label === "900,0 m²")?.code, "open_to_outside");
  const one = coverSheet(sheet(mask(), { spans: [span("100,0 m²", 100, 100), span("900,0 m²", 700, 450), FAR] }).sh, { commit: true });
  const r = one.rooms.find((x) => x.label === "100,0 m²")!;
  assert.equal(r.code, "area_differs");
  assert.equal(r.printed_m2, 100);
  assert.ok(r.outline_m2! > 780 && r.zone_m2! > 780);
});

test("clouds: one per flagged zone over its extent; a zone filling little of it clouded round each label", () => {
  const whole = coverSheet(sheet(mask(), { spans: [span("400,0 m²", 100, 100), span("100,0 m²", 300, 100), span("900,0 m²", 700, 400)] }).sh, { commit: true });
  const zoneClouds = whole.clouds.filter((c) => c.kind === "not_measured");
  assert.equal(zoneClouds.length, 1, "two labels sharing a zone share its cloud");
  assert.deepEqual(zoneClouds[0].rooms!.map((r) => r.label).sort(), ["100,0 m²", "400,0 m²"]);
  // an L of floor round a walled block: its extent is mostly the block
  const m = mask();
  rect(m, 60, 60, 410, 210);
  const ell = coverSheet(sheet(m, { spans: [span("80,0 m²", 300, 35), span("70,0 m²", 35, 180), span("900,0 m²", 700, 400)] }).sh, { commit: true });
  const legs = ell.clouds.filter((c) => c.kind === "not_measured");
  assert.equal(legs.length, 2, JSON.stringify(legs.map((c) => c.rect)));
  for (const c of legs) assert.ok(Math.min(c.rect[2] - c.rect[0], c.rect[3] - c.rect[1]) < 60, `a leg, not the whole extent: ${c.rect}`);
});

test("without condition nothing commits: a passing zone is listed with what would commit it", () => {
  const { sh, commits } = sheet(mask(), { spans: [span("794,0 m²", 100, 100), FAR, FAR2] });
  const out = coverSheet(sh, { commit: false });
  assert.equal(commits.length, 0);
  assert.ok(reasons(out).some((r) => /agrees with the printed area — pass condition to commit it/.test(r)));
  const ready = out.rooms.find((r) => r.code === "ready_to_commit")!;
  assert.ok(out.clouds.some((c) => c.rooms?.includes(ready)), "a zone ready to commit is clouded like any flagged zone");
});

const ROOMS = [{ tag: "101", name: "OFFICE", bbox: [95, 95, 105, 105] as [number, number, number, number] }];
test("metric sheet, no printed areas: the drawn-walls check decides a zone, through drawnWalls.judge", () => {
  const judged: Point[][] = [];
  const fail = sheet(mask(), { roomTags: ROOMS, drawnWalls: { refine: (r) => r, judge: (r) => { judged.push(r); return { pass: false, reason: "edge 2 runs along drawn walls for 40% of its length" }; } } });
  const out = coverSheet(fail.sh, { commit: true });
  assert.equal(judged.length, 1);
  assert.equal(fail.commits.length, 0);
  assert.match(reasons(out)[0], /edge 2 runs along drawn walls for 40%/);
  const pass = sheet(mask(), { roomTags: ROOMS, drawnWalls: { refine: (r) => r, judge: () => ({ pass: true, reason: "" }) } });
  const ok = coverSheet(pass.sh, { commit: true });
  assert.equal(pass.commits.length, 1);
  assert.equal(ok.rooms.find((r) => r.label === "101")?.status, "committed");
});

// Vector geometry: the outer walls drawn as two faces 0.2 m apart; a line at x = 210 between two rooms.
function geo(extra: number[]): VectorGeometry {
  const segs: number[] = [];
  const r = (x0: number, y0: number, x1: number, y1: number) => segs.push(x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0);
  r(10, 10, 410, 210); r(12, 12, 408, 208);
  segs.push(...extra);
  return { points: [], segs, meta: new Uint8Array(segs.length / 4), imageArea: 0 } as unknown as VectorGeometry;
}
const TWO_ROOMS = [
  { tag: "101", name: "OFFICE", bbox: [95, 95, 105, 105] as [number, number, number, number] },
  { tag: "102", name: "STORE", bbox: [295, 95, 305, 105] as [number, number, number, number] },
];
function twoRooms(roles: Uint8Array | null, hiddenPartner: boolean) {
  const g = geo(hiddenPartner ? [210, 12, 210, 208, 212, 12, 212, 208] : [210, 12, 210, 208]);
  const m = mask();
  rect(m, 12, 12, 408, 208);
  line(m, 210, 12, 210, 208);   // the ink the flood stops at: the visible line only (hidden ink is never in the mask)
  return sheet(m, { geo: g, roomTags: TWO_ROOMS, roles });
}

test("imperial / undecided sheet, no printed areas: a zone walled along under 80% of its edge is flagged", () => {
  const { sh, commits } = twoRooms(null, false);   // the single line at x = 210 splits the rooms but is not a wall
  const out = coverSheet(sh, { commit: true });
  assert.equal(commits.length, 0);
  assert.ok(reasons(out).length === 2 && reasons(out).every((r) => /bounded by walls along only \d+% of its edge/.test(r)), reasons(out).join(" | "));
});

test("hidden ink is never a wall face's partner: the same line pair is a wall on an unlayered sheet, not when one line is hidden", () => {
  const unlayered = twoRooms(null, true);   // x = 210 and x = 212, 0.2 m apart: a wall
  coverSheet(unlayered.sh, { commit: true });
  assert.equal(unlayered.commits.length, 2, "both rooms walled all round");
  const roles = new Uint8Array(geo([]).segs.length / 4 + 2);
  roles[roles.length - 1] = ROLE_HIDDEN;   // x = 212 lives on a hidden layer
  const hidden = twoRooms(roles, true);
  const out = coverSheet(hidden.sh, { commit: true });
  assert.equal(hidden.commits.length, 0, "x = 210 alone is a drawn line, not a wall");
  assert.ok(reasons(out).every((r) => /bounded by walls along only/.test(r)));
});

test("snapToWalls: an outline drawn inside the walls goes onto the wall faces; the reading that agrees with the print is kept", () => {
  const g = geo([]);
  const m = mask();
  rect(m, 12, 12, 408, 208);   // both faces are ink the flood stops at
  const ring: Point[] = [[14, 14], [406, 14], [406, 206], [14, 206]];   // 0.2 m inside the inner faces all round
  const printed = (396 * 196) / 100;                                    // the inner faces' area, m²
  const r = snapToWalls(ring, g, m, PX_PER_M, [printed], null);
  assert.equal(r.agrees, true);
  assert.notEqual(r.reading, "as_drawn");
  assert.ok(r.moved === 4);
  const asDrawn = snapToWalls([[12, 12], [408, 12], [408, 208], [12, 208]], g, m, PX_PER_M, [printed], null);
  assert.equal(asDrawn.reading, "as_drawn");
  const noPrint = snapToWalls(ring, g, m, PX_PER_M, [], null);
  assert.equal(noPrint.agrees, null);
  assert.equal(noPrint.reading, "nearest_face");
});

test("mark replaces cover's own clouds and never a user's, whatever the user's text says", async () => {
  const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale("sample-plan.pdf", { upp: 1 / 36 });
  s.annotate({ sheet: "sample-plan.pdf", type: "cloud", text: "Not measured: check with the architect", rect: [[10, 10], [60, 60]] });
  const first = await s.coverFloor("sample-plan.pdf", { mark: true });
  const count = s.markups.length;
  const second = await s.coverFloor("sample-plan.pdf", { mark: true });
  assert.equal(s.markups.length, count, "a repeat mark does not stack a second set");
  assert.equal(second.clouds_removed, first.clouds);
  assert.ok(s.markups.some((m) => m.text === "Not measured: check with the architect" && m.source === undefined), "the user's cloud survives");
  const ours = s.markups.filter((x) => x.source === "cover");
  for (const m of ours) {
    assert.ok(m.cover && m.cover.items.length > 0, "a cover cloud says what it is about");
    assert.match(m.text, /^(Not measured|No room label): /);
  }
  assert.ok(ours.length >= 2, "the demo plan leaves floor to cloud");
  // a cloud someone linked to an RFI or a condition is theirs now: mark never replaces it
  s.createRfi({ title: "Floor", question: "What is this floor?", sheet: "sample-plan.pdf", markup_ids: [ours[0].id] });
  s.linkAnnotation(ours[1].id, "GULV");
  await s.coverFloor("sample-plan.pdf", { mark: true });
  assert.ok(s.markups.some((m) => m.id === ours[0].id) && s.markups.some((m) => m.id === ours[1].id));
  // nothing but mark removes a cover cloud: the marked set filters what is measured at export, undo-safe
  const n = s.markups.length;
  await s.coverFloor("sample-plan.pdf", {});
  assert.equal(s.markups.length, n);
});
