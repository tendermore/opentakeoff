// doors — which drawn swings are doors, where each opening is, and which
// rooms it belongs to. Synthetic geometry at a stated scale, so each assertion
// is about the rule, not about one drafter's habits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDoors, doorOnRing } from "../src/lib/doors.ts";
import { buildMask, SEG_CURVE } from "../src/lib/oneclick.ts";
import type { Point } from "../src/lib/oneclick.ts";

const FT = 18;                       // image px per foot
const W = 40 * FT, H = 30 * FT;

function line(x0: number, y0: number, x1: number, y1: number, step = FT / 2): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  for (let i = 0; i < n; i++) {
    out.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, x0 + ((x1 - x0) * (i + 1)) / n, y0 + ((y1 - y0) * (i + 1)) / n);
  }
  return out;
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 12): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
    out.push(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1));
  }
  return out;
}

/** A 20 × 15 ft room (4..24 × 4..19 ft) whose south wall is open over [gap0, gap1] ft. */
function sheet(gap0: number, gap1: number) {
  const segs: number[] = [
    ...line(4 * FT, 4 * FT, 24 * FT, 4 * FT),
    ...line(4 * FT, 19 * FT, gap0 * FT, 19 * FT), ...line(gap1 * FT, 19 * FT, 24 * FT, 19 * FT),
    ...line(4 * FT, 4 * FT, 4 * FT, 19 * FT), ...line(24 * FT, 4 * FT, 24 * FT, 19 * FT),
    ...line(4 * FT, 24 * FT, 24 * FT, 24 * FT),
  ];
  const curve: boolean[] = new Array(segs.length >> 2).fill(false);
  return {
    add(s: number[], isCurve: boolean) { segs.push(...s); for (let i = 0; i < s.length >> 2; i++) curve.push(isCurve); },
    run() {
      const meta = Uint8Array.from(curve.map((c) => (c ? SEG_CURVE : 0)));
      const mo = buildMask(segs, W, H, 3000, meta, FT, FT, { pageW: W, pageH: H, renderScale: 1, baseScale: 1 }, null, null);
      return findDoors(segs, meta, mo, FT);
    },
  };
}

test("a swing with its leaf is one door: the opening runs hinge → strike, as wide as the leaf", () => {
  const s = sheet(12, 15);
  s.add(arc(12 * FT, 19 * FT, 3 * FT, -Math.PI / 2, 0), true);   // hinged on the west jamb, into the room
  s.add(line(12 * FT, 19 * FT, 12 * FT, 16 * FT), false);           // the leaf, open
  const { doors, rejected } = s.run();
  assert.equal(doors.length, 1, JSON.stringify(rejected));
  const [d] = doors;
  assert.equal(d.leaves, 1);
  assert.ok(Math.abs(d.width - 3 * FT) < 0.2 * FT, `width ${(d.width / FT).toFixed(2)} ft`);
  const xs = d.opening.map((p) => p[0] / FT).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] - 12) < 0.2 && Math.abs(xs[1] - 15) < 0.2, `opening spans the gap: ${xs}`);
  assert.ok(d.opening.every((p) => Math.abs(p[1] - 19 * FT) < 0.2 * FT), "opening lies on the wall line");
});

test("a swing with no leaf drawn at either end is withheld, not counted", () => {
  const s = sheet(12, 15);
  s.add(arc(12 * FT, 19 * FT, 3 * FT, -Math.PI / 2, 0), true);
  const { doors, rejected } = s.run();
  assert.equal(doors.length, 0);
  assert.deepEqual(rejected.map((r) => r.reason), ["no_leaf"]);
});

test("two leaves meeting in one opening are ONE double door, as wide as both", () => {
  const s = sheet(10, 16);
  s.add(arc(10 * FT, 19 * FT, 3 * FT, -Math.PI / 2, 0), true);
  s.add(line(10 * FT, 19 * FT, 10 * FT, 16 * FT), false);
  s.add(line(0, 0, 0.5 * FT, 0), false);                            // the two arcs are separate paths
  s.add(arc(16 * FT, 19 * FT, 3 * FT, Math.PI, 1.5 * Math.PI), true);
  s.add(line(16 * FT, 19 * FT, 16 * FT, 16 * FT), false);
  const { doors, rejected } = s.run();
  assert.equal(doors.length, 1, JSON.stringify({ doors, rejected }));
  assert.equal(doors[0].leaves, 2);
  assert.ok(Math.abs(doors[0].width - 6 * FT) < 0.3 * FT, `width ${(doors[0].width / FT).toFixed(2)} ft`);
});

test("a stair winder — treads radiating from the curve's centre — is not a door", () => {
  const s = sheet(12, 15);
  const hx = 8 * FT, hy = 4 * FT;                                   // centre on the north wall
  s.add(arc(hx, hy, 3 * FT, 0, Math.PI / 2), true);
  for (const a of [30, 45, 60]) {
    const t = (a * Math.PI) / 180;
    s.add(line(hx + 0.3 * FT * Math.cos(t), hy + 0.3 * FT * Math.sin(t), hx + 5 * FT * Math.cos(t), hy + 5 * FT * Math.sin(t), Infinity), false);   // one stroke per tread
  }
  const { doors, rejected } = s.run();
  assert.equal(doors.length, 0);
  assert.deepEqual(rejected.map((r) => r.reason), ["radial_lines"]);
});

test("a semicircle drawn as two quarter arcs on one centre (a stair's rail end) is not two doors", () => {
  const s = sheet(12, 15);
  s.add(arc(18 * FT, 4 * FT, 3 * FT, 0, Math.PI / 2), true);
  s.add(line(18 * FT, 4 * FT, 18 * FT, 7 * FT), false);
  s.add(arc(18 * FT, 4 * FT, 3 * FT, Math.PI / 2, Math.PI), true);
  const { doors, rejected } = s.run();
  assert.equal(doors.length, 0, JSON.stringify(doors));
  assert.ok(rejected.length >= 1 && rejected.every((r) => r.reason === "over_sweep"), JSON.stringify(rejected));
});

test("doorOnRing: the opening belongs to the rings on both faces of its wall, and to no other", () => {
  const door = { hinges: [[12 * FT, 19 * FT] as Point], opening: [[12 * FT, 19 * FT], [15 * FT, 19 * FT]] as [Point, Point], width: 3 * FT, leaves: 1 as const, at: [13.5 * FT, 19 * FT] as Point };
  const wall = 1.3 * FT;                                               // 0.40 m
  const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0 * FT, y0 * FT], [x1 * FT, y0 * FT], [x1 * FT, y1 * FT], [x0 * FT, y1 * FT]];
  assert.ok(doorOnRing(door, rect(4.2, 4.2, 23.8, 18.8), wall), "the room the door swings into (ring on the wall face)");
  assert.ok(doorOnRing(door, rect(4.2, 19.4, 23.8, 23.8), wall), "the corridor across the wall");
  assert.ok(!doorOnRing(door, rect(4.2, 21, 23.8, 23.8), wall), "a ring beyond the wall's thickness");
  assert.ok(!doorOnRing(door, rect(16, 10, 23.8, 18.8), wall), "a room beside the door in the same wall line");
  assert.ok(!doorOnRing(door, rect(15.2, 10, 23.8, 30), wall), "a ring whose edge meets the door end-on");
});
