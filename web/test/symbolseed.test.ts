// pickCandidate — which seed of the ladder is shown first. Synthetic ladders: the
// counts are what a fragment, a whole symbol and a symbol-plus-wall seed produce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCandidate, type SeedCandidate } from "../src/lib/symbolseed.ts";

const ladder = (rows: [segments: number, count: number][]): SeedCandidate[] =>
  rows.map(([segments, count], i) => ({
    level: i + 1, rect: [[0, 0], [1, 1]], segments, footprint: segments, complete: true, ms: 0, withheld: [],
    points: Array.from({ length: count }, (_, k) => ({ at: [k, 0] as [number, number], score: 1, rotation: 0, mirrored: false })),
  }));

test("the count that holds as the seed grows wins over the fragment that finds more", () => {
  // fragments of a WC (the bowl, the bowl and cistern) match every look-alike; the whole
  // symbol holds at 14 over four seed sizes; then the seed swallows wall
  const c = ladder([[7, 1823], [17, 340], [29, 140], [37, 102], [40, 89], [46, 77], [53, 14], [55, 14], [57, 12], [59, 12], [81, 9], [105, 7], [114, 5], [135, 6], [148, 6], [180, 6], [206, 4]]);
  assert.equal(c[pickCandidate(c) - 1].points.length, 14);
});

test("within a steady run, the most specific seed that keeps the run's median count", () => {
  const c = ladder([[1, 1968], [2, 220], [3, 74], [6, 66], [10, 62], [16, 62], [17, 62]]);
  assert.equal(pickCandidate(c), 7);
});

test("no steady run: the fallback still refuses a lone fragment explosion", () => {
  const c = ladder([[3, 2176], [5, 1072], [8, 603], [15, 450], [19, 5], [22, 2], [28, 1]]);
  assert.ok(c[pickCandidate(c) - 1].points.length < 603);
});
