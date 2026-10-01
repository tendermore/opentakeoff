// Symbol seed from a point — the half of a symbol sweep an agent cannot do well.
//
// symbol_sweep wants a TIGHT marquee around one example instance, in sheet
// pixels. A model looking at a downsampled crop cannot place one: it has no
// ruler in the image, the arithmetic (region + pixel / zoom) is its own, and a
// rect that is a few pixels loose fingerprints the wall behind the symbol
// instead. This module turns "this point is on an example" into the seed, and
// says how sure it is.
//
// The engine's own answer is the oracle. A ladder of growing squares around the
// point gives a nested series of seeds; each is swept and the placements it
// clears counted. Too small a seed is a fragment that many things share (the
// count explodes); too large a seed swallows wall linework that differs at every
// instance (the count collapses to the example itself); between them the count
// holds. The ladder is reported as candidates, so the caller can see the
// alternatives and pick one by LOOKING at a numbered overlay.
//
// Pure, no DOM, no session: node-testable like symbolsweep.ts.
import { fingerprintSymbol, matchSymbol, type Point, type SweepMatch, type SweepWithheld } from "./symbolsweep.ts";

export type Rect = [Point, Point];

/** Peaks of the sheet's long straight lines, degrees in [0, 90), strongest first.
 * A plan drawn in wings turned 33° and 63° to the sheet holds the same fixtures
 * turned by the same angles; the walls say which. */
export function dominantAngles(segs: ArrayLike<number>, opts: { minLen?: number; minShare?: number; region?: { c: Point; r: number } } = {}): number[] {
  const minLen = opts.minLen ?? 40, minShare = opts.minShare ?? 0.04;
  const hist = new Float64Array(90);
  let total = 0;
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < minLen) continue;
    if (opts.region && Math.hypot((ax + bx) / 2 - opts.region.c[0], (ay + by) / 2 - opts.region.c[1]) > opts.region.r) continue;
    let a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90;
    hist[Math.min(89, Math.floor(a))] += L;
    total += L;
  }
  if (total === 0) return [];
  const at = (k: number) => hist[((k % 90) + 90) % 90];
  const peaks: { a: number; w: number }[] = [];
  for (let k = 0; k < 90; k++) {
    const w = at(k - 1) + at(k) + at(k + 1);
    if (w / total < minShare) continue;
    if (at(k) >= at(k - 1) && at(k) > at(k + 1)) {
      // weighted centre of the three bins, bin centres at k + 0.5
      const a = (((k - 1 + 0.5) * at(k - 1) + (k + 0.5) * at(k) + (k + 1 + 0.5) * at(k + 1)) / (at(k - 1) + at(k) + at(k + 1)));
      peaks.push({ a: ((a % 90) + 90) % 90, w });
    }
  }
  peaks.sort((p, q) => q.w - p.w);
  const merged: { a: number; w: number }[] = [];
  for (const p of peaks) {
    const near = merged.find((m) => Math.min(Math.abs(m.a - p.a), 90 - Math.abs(m.a - p.a)) < 3);
    if (near) near.w += p.w; else merged.push({ ...p });
  }
  return merged.sort((p, q) => q.w - p.w).map((m) => Math.round(m.a * 10) / 10);
}

const angDiff90 = (a: number, b: number): number => {
  const d = (((a - b) % 90) + 90) % 90;
  return d > 45 ? d - 90 : d;
};

/** The extra rotations (degrees, on top of the four right angles) that carry a
 * symbol standing in one wing of the plan onto the same symbol in the others:
 * each sheet wing angle relative to the wing the seed stands in. */
export function wingRotations(segs: ArrayLike<number>, seedAt: Point, radius: number): number[] {
  const sheet = dominantAngles(segs);
  if (sheet.length < 2) return [];
  const local = dominantAngles(segs, { minLen: 12, minShare: 0.2, region: { c: seedAt, r: radius } })[0];
  // the sheet wing nearest the seed's own walls; with no walls around it, the strongest
  const home = local === undefined ? sheet[0] : sheet.reduce((b, a) => (Math.abs(angDiff90(a, local)) < Math.abs(angDiff90(b, local)) ? a : b));
  const out: number[] = [];
  for (const wing of sheet) {
    const d = angDiff90(wing, home);
    if (Math.abs(d) < 1.5) continue;
    for (let k = 0; k < 4; k++) {
      const a = (((d + 90 * k) % 360) + 360) % 360;
      if (!out.some((o) => Math.abs(o - a) < 1)) out.push(Math.round(a * 10) / 10);
    }
  }
  return out.slice(0, 12);
}

export interface SeedCandidate {
  /** 1-based, small seed first. */
  level: number;
  rect: Rect;
  segments: number;
  /** Diagonal of the seed's tight bbox, px. */
  footprint: number;
  /** The example's own centre, then every other placement that cleared the bar (shadow-deduped). */
  points: { at: Point; score: number; rotation: number; mirrored: boolean; seed?: true }[];
  withheld: SweepWithheld[];
  complete: boolean;
  ms: number;
}

/** Half-sizes (px) of the seed squares tried around the point. A fixture or door
 * is between a hand and a couple of metres across; with the scale known the ladder
 * spans that, without it a sheet-independent 5..60 px. */
export function ladderHalfSizes(pxPerMetre: number | null): number[] {
  const lo = pxPerMetre ? Math.max(4, 0.12 * pxPerMetre) : 5;
  const hi = pxPerMetre ? Math.min(90, Math.max(lo * 3, 1.1 * pxPerMetre)) : 60;
  const out: number[] = [];
  for (let h = lo; h <= hi * 1.001; h *= 1.13) out.push(Math.round(h * 10) / 10);
  return out;
}

export interface LadderOptions {
  angles?: number[];
  rotations?: boolean;
  mirror?: boolean;
  tolPx?: number;
  /** Stop once this many placements have been scored over the seeds tried (matchSymbol's
   *  candidates.considered, summed); the candidates so far are returned as `partial`. Work,
   *  not time: the same point on the same sheet stops at the same seed on every machine. */
  budgetWork?: number;
  /** Wall-clock safety cap (ms of `clock`), checked between seeds only; when it stops the
   *  ladder the result says so (`wallclock`), so a slow machine never changes a count silently. */
  wallclockMs?: number;
  clock?: () => number;
  maxCandidates?: number;
}

/** Sweep each distinct seed of the ladder. Stops once the count has collapsed to
 * the example itself four seeds running: a seed that cuts through the symbol's own
 * outline collapses too (the count comes back at the size that holds it whole), so
 * one or two collapses prove nothing, but four in a row are wall. */
export function evaluateLadder(segs: number[], click: Point, halfSizes: number[], opts: LadderOptions = {}): { candidates: SeedCandidate[]; partial: boolean; wallclock: boolean } {
  const now = opts.clock ?? Date.now;
  const started = now();
  const seen = new Set<string>();
  const candidates: SeedCandidate[] = [];
  let collapsed = 0, hadRepeat = false, partial = false, wallclock = false, work = 0;
  for (const h of halfSizes) {
    const rect: Rect = [[click[0] - h, click[1] - h], [click[0] + h, click[1] + h]];
    let fp;
    try { fp = fingerprintSymbol(segs, rect); } catch { continue; }
    const key = `${fp.segments}:${Math.round(fp.totalLen)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.budgetWork && work > opts.budgetWork) { partial = true; break; }
    if (opts.wallclockMs && now() - started > opts.wallclockMs) { wallclock = true; break; }
    const t0 = now();
    const m = matchSymbol(fp, segs, {
      excludeCenter: fp.center,
      rotations: opts.rotations ?? true,
      mirror: opts.mirror ?? true,
      ...(opts.angles?.length ? { angles: opts.angles } : {}),
      ...(opts.tolPx ? { tolPx: opts.tolPx } : {}),
      maxCandidates: opts.maxCandidates ?? 250000,
    });
    candidates.push({
      level: candidates.length + 1,
      rect,
      segments: fp.segments,
      footprint: fp.footprint,
      points: [{ at: [fp.center[0], fp.center[1]], score: 1, rotation: 0, mirrored: false, seed: true }, ...m.matches.map((x: SweepMatch) => ({ at: x.at, score: x.score, rotation: x.rotation, mirrored: x.mirrored }))] as SeedCandidate["points"],
      withheld: m.withheld,
      complete: m.complete,
      ms: Math.round(now() - t0),
    });
    work += m.candidates.considered;
    const n = m.matches.length + 1;
    if (n >= 2) { hadRepeat = true; collapsed = 0; } else if (hadRepeat) collapsed++;
    if (collapsed >= 4) break;
  }
  return { candidates, partial, wallclock };
}

/** Runs of consecutive seeds whose counts agree — each within STEADY_RATIO of the
 * seed before it, every one repeating at least STEADY_MIN times. The module's own
 * premise, measured: a fragment's count falls as the seed grows, a seed that swallows
 * wall collapses toward the example, and in between — the whole symbol — the count
 * holds while the seed grows. */
export function steadyRuns(c: SeedCandidate[]): SeedCandidate[][] {
  const n = (x: SeedCandidate) => x.points.length;
  const runs: SeedCandidate[][] = [];
  let cur: SeedCandidate[] = [];
  for (const x of c) {
    const prev = cur[cur.length - 1];
    if (n(x) >= STEADY_MIN && prev && Math.max(n(x), n(prev)) <= STEADY_RATIO * Math.min(n(x), n(prev))) { cur.push(x); continue; }
    if (cur.length >= 2) runs.push(cur);
    cur = n(x) >= STEADY_MIN ? [x] : [];
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** The seed a steady run stands for: the most specific one that still finds at
 * least the run's median count (the larger seeds of a run can lose an instance or
 * two whose surroundings differ). */
export function runLevel(run: SeedCandidate[]): number {
  const counts = run.map((x) => x.points.length).sort((a, b) => a - b);
  const median = counts[counts.length >> 1];
  return run.filter((x) => x.points.length >= median).reduce((a, b) => (b.segments > a.segments ? b : a)).level;
}

// Adjacent seeds agree when their counts differ by at most a quarter: an instance or
// two whose surroundings differ drops out as the seed grows, a look-alike family does
// not. Three repeats is the least that makes a count a pattern rather than a pair.
const STEADY_RATIO = 1.25;
const STEADY_MIN = 3;

/** The candidate to show first. The longest steady run (ties: the one that finds
 * more) — the range of seed sizes over which the count holds is the whole symbol;
 * the largest count is not, since every fragment of the symbol finds at least as
 * many. With no steady run, the most specific seed that keeps at least four fifths of
 * the placements of the best one. Three guards keep that fallback off a
 * fragment other things share (a bowl's ellipse is also a stair newel): seeds under
 * eight segments are only used when nothing larger repeats, a seed whose next
 * larger sibling still repeats but finds a quarter of its count or less is a cliff edge, not a
 * plateau (a sibling that finds only the example is wall, and ends the plateau), and a count far beyond the ladder's own middle is the fragment regime. */
export function pickCandidate(c: SeedCandidate[]): number {
  if (!c.length) return 0;
  const runs = steadyRuns(c);
  if (runs.length) {
    const top = (r: SeedCandidate[]) => Math.max(...r.map((x) => x.points.length));
    return runLevel(runs.reduce((a, b) => (b.length > a.length || (b.length === a.length && top(b) > top(a)) ? b : a)));
  }
  const n = (x: SeedCandidate) => x.points.length;
  const cliff = (x: SeedCandidate) => {
    const next = c.find((y) => y.level > x.level && y.segments > x.segments);
    return !!next && n(x) > 8 && n(next) >= 2 && n(next) * 4 <= n(x);
  };
  for (const minSegs of [8, 3, 0]) {
    const usable = c.filter((x) => x.segments >= minSegs);
    if (!usable.length) continue;
    const counts = usable.map(n).sort((a, b) => a - b);
    const median = counts[counts.length >> 1];
    const sane = usable.filter((x) => n(x) <= Math.max(8 * median, 40) && !cliff(x));
    const best = Math.max(0, ...sane.map(n));
    if (best < 2) continue;
    const keep = sane.filter((x) => n(x) >= best * 0.8);
    return keep.reduce((a, b) => (b.segments > a.segments ? b : a)).level;
  }
  // nothing repeats at any size: the example is unique — show the largest seed
  return c.reduce((a, b) => (b.segments > a.segments ? b : a)).level;
}

/** The nearest short stroke to a point, as its midpoint: where a point typed from a picture most
 * likely meant. Strokes longer than maxLen are walls, not the thing pointed at. */
export function nearestInk(segs: ArrayLike<number>, p: Point, radius: number, maxLen: number): Point | null {
  let best = Infinity, at: Point | null = null;
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (Math.abs(mx - p[0]) > radius || Math.abs(my - p[1]) > radius) continue;
    if (Math.hypot(bx - ax, by - ay) > maxLen) continue;
    const d = Math.hypot(mx - p[0], my - p[1]);
    if (d < best) { best = d; at = [mx, my]; }
  }
  return best <= radius ? at : null;
}
