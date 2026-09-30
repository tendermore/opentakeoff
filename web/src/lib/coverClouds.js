// Cover clouds — what takeoff_rooms cover {mark: true} clouds on the plan: the
// floor it could not measure. One cloud per zone (or per part of one), carrying
// what it is about as data (`cover.items`: where the drawing prints each room
// label, its name, the label and its printed m², or an unlabelled piece's m²).
// The marked set words them at export, in its own locale and units, and leaves
// out an item a floor shape covers by then — whatever tool committed it — so a
// cloud reports only what is still unmeasured. Its note is placed where it
// covers the fewest other notes, quantity chips and printed labels: inside the
// cloud when it fits, else beside it with a leader.
//
// Pure module: no pdf-lib, no DOM. Coordinates are image px unless noted.
import { pointInPoly } from "./geometry.js";

const SF_PER_M2 = 1 / 0.09290304;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const validAt = (at) => Array.isArray(at) && at.length === 2 && finite(at[0]) && finite(at[1]);

/** What covers a label on one sheet: its floor_area outlines (with their holes) and its deducts, normalized.
 *  A combined row (several rooms measured as one) is a floor outline like any other: the labels inside it are
 *  measured, together. */
export function floorCoverage(shapes, sheetId) {
  const here = (shapes || []).filter((s) => s && s.sheet_id === sheetId && Array.isArray(s.verts_norm) && s.verts_norm.length >= 3);
  return {
    floors: here.filter((s) => s.measure_role === "floor_area").map((s) => ({ ring: s.verts_norm, holes: Array.isArray(s.verts_norm_holes) ? s.verts_norm_holes : [] })),
    deducts: here.filter((s) => s.measure_role === "deduct").map((s) => s.verts_norm),
  };
}

/** A point is measured when it lies inside a floor outline, in none of its holes, and in no deduct: floor
 *  taken out of a room is not measured floor. */
export function isMeasuredAt([x, y], { floors, deducts }) {
  if (deducts.some((d) => pointInPoly(x, y, d))) return false;
  return floors.some((f) => pointInPoly(x, y, f.ring) && !f.holes.some((h) => Array.isArray(h) && h.length >= 3 && pointInPoly(x, y, h)));
}

/** A cover cloud's well-formed items that no floor covers (`coverage` from floorCoverage). A markup that is not
 *  a cover cloud, or carries malformed items, has none — the caller draws it as a plain cloud. */
export function liveCoverItems(m, coverage) {
  const items = m?.source === "cover" && Array.isArray(m.cover?.items) ? m.cover.items : [];
  return items.filter((it) => it && validAt(it.at) && !isMeasuredAt(it.at, coverage));
}

/** An area as a cover note prints it: one decimal in the locale's own digits, in the display unit. */
export function formatCoverArea(m2, metric, T) {
  return metric
    ? `${fixed(m2, 1, T)} ${T.areaUnit.metric}`
    : `${fixed(m2 * SF_PER_M2, 0, T)} ${T.areaUnit.imperial}`;
}
const fixed = (v, d, T) => (Math.round(v * 10 ** d) / 10 ** d || 0).toLocaleString(T.numberLocale, { minimumFractionDigits: d, maximumFractionDigits: d });

/** One item in the note's words: a room by its name and printed area (its label where none is printed), an
 *  unlabelled piece by its area. */
export function coverItemText(kind, it, metric, T) {
  const area = finite(it.m2) ? formatCoverArea(it.m2, metric, T) : "";
  if (kind === "no_label") return area;
  return [it.name, area || it.label].filter(Boolean).join(" ");
}

/** A cover cloud's note in the marked set's words. */
export function coverCloudText(kind, items, metric, T) {
  const parts = items.map((it) => coverItemText(kind, it, metric, T)).filter(Boolean).join(", ");
  return kind === "no_label" ? T.coverNoLabel(parts) : T.coverNotMeasured(parts);
}

/** A note broken into lines no wider than `maxW` (measure: string → width), on item boundaries, at most
 *  `maxLines`; what does not fit is counted ("+3"). */
export function coverNoteLines(kind, items, metric, T, measure, maxW, maxLines = 3) {
  const parts = items.map((it) => coverItemText(kind, it, metric, T)).filter(Boolean);
  const head = kind === "no_label" ? T.coverNoLabel("") : T.coverNotMeasured("");
  const lines = [];
  let line = head;
  let k = 0;
  for (; k < parts.length; k++) {
    const next = `${line}${line === head ? "" : ", "}${parts[k]}`;
    if (line !== head && measure(next) > maxW) {
      if (lines.length + 1 >= maxLines) break;
      lines.push(`${line},`);
      line = parts[k];
    } else line = next;
  }
  if (k < parts.length) line = `${line} +${parts.length - k}`;
  lines.push(line);
  return lines;
}

/** The cloud rect drawn round a zone's extent, pulled in by its scallops' bulge (cloudBezier's arc radius) so
 *  the cloud stays on the zone instead of lying over the walls and rooms round it. [x0, y0, x1, y1]. */
export function cloudInside([x0, y0, x1, y1]) {
  const w = x1 - x0, h = y1 - y0;
  const r = Math.max(6, Math.min(22, (w + h) / 22));
  const d = Math.min(0.45 * r + 1, w / 4, h / 4);
  return [x0 + d, y0 + d, x1 - d, y1 - d];
}

const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const nearestOnRect = ([x0, y0, x1, y1], x, y) => [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))];
const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
const dist = (b, [x, y]) => Math.hypot((b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y);

/** Where each cloud's note goes. `notes`: { w, h, rect: the cloud [x0,y0,x1,y1], anchor: [x, y] the printed
 *  label it is about }. `obstacles`: boxes a note should not cover (quantity chips, printed labels, the sheet's
 *  own text) — and every other cloud's inside. `bounds`: [W, H]; a note always stays on the page. `opts.areas`: polygons it should not cover
 *  (measured floor); `opts.keepOut`: boxes it never covers (the title block). Small clouds are placed first. A
 *  note goes inside its cloud nearest its anchor where it covers nothing; else outside the cloud where it covers
 *  nothing, nearest its anchor, with a leader to the cloud's edge; else where it covers least — never in a
 *  keep-out box while any spot outside one is left. A cloud too narrow for the note but long enough takes it
 *  turned a quarter (reading upward) before it goes outside. Outside, a spot whose leader is at most
 *  `opts.maxLeader` long and crosses no measured floor is taken first. Deterministic, and bounded: at most
 *  MAX_INSIDE spots inside (per reading) and OUTSIDE_STEPS rings outside per note, each costed once against the
 *  obstacles near it, a leader sampled at most 16 times. Returns, per note, its box [x0, y0, x1, y1], the leader
 *  (or null) and whether the note is turned (the box is then h wide and w tall). */
const MAX_INSIDE = 1600, OUTSIDE_STEPS = 10;
export function placeCloudNotes(notes, obstacles, bounds, gap = 4, opts = {}) {
  const [W, H] = bounds;
  const areas = (opts.areas || []).filter((p) => Array.isArray(p) && p.length >= 3).map((p) => ({ p, b: boxOf(p) }));
  const keepOut = opts.keepOut || [];
  const maxLeader = opts.maxLeader ?? Infinity;
  // does a leader run over measured floor (its ends lie on the note and the cloud, so they are left out)?
  const crossesFloor = ([[ax, ay], [bx, by]]) => {
    const n = Math.min(16, Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, gap))));
    for (let i = 1; i < n; i++) {
      const px = ax + ((bx - ax) * i) / n, py = ay + ((by - ay) * i) / n;
      if (areas.some((a) => px >= a.b[0] && px <= a.b[2] && py >= a.b[1] && py <= a.b[3] && pointInPoly(px, py, a.p))) return true;
    }
    return false;
  };
  const taken = obstacles.map((b) => [b[0] - gap / 2, b[1] - gap / 2, b[2] + gap / 2, b[3] + gap / 2]);
  const order = notes.map((_, k) => k).sort((a, b) => area(notes[a].rect) - area(notes[b].rect) || a - b);
  const out = new Array(notes.length);
  const allowed = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !keepOut.some((k) => overlap(b, k) > 0);
  const clamp = ([x0, y0, x1, y1]) => {
    const w = x1 - x0, h = y1 - y0, x = Math.min(Math.max(0, x0), Math.max(0, W - w)), y = Math.min(Math.max(0, y0), Math.max(0, H - h));
    return [x, y, x + w, y + h];
  };
  for (const k of order) {
    const { w, h, rect, anchor } = notes[k];
    const [x0, y0, x1, y1] = rect;
    const reach = gap * 2 + OUTSIDE_STEPS * (Math.max(w, h) + gap);
    const zone = [x0 - reach, y0 - reach, x1 + reach, y1 + reach];
    // another cloud's inside is its own note's place: a note there reads as about the wrong cloud
    const others = notes.filter((_, j) => j !== k).map((o) => o.rect);
    const near = [...taken, ...others].filter((t) => overlap(t, zone) > 0);
    const nearAreas = areas.filter((a) => overlap(a.b, zone) > 0);
    // what a box covers: other notes, chips and text by area, measured floor by a 3 × 3 sample of the box
    const cost = (b) => {
      let c = 0;
      for (const t of near) c += overlap(b, t);
      if (nearAreas.length) {
        let hits = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          const px = b[0] + ((i + 0.5) / 3) * (b[2] - b[0]), py = b[1] + ((j + 0.5) / 3) * (b[3] - b[1]);
          if (nearAreas.some((a) => px >= a.b[0] && px <= a.b[2] && py >= a.b[1] && py <= a.b[3] && pointInPoly(px, py, a.p))) hits++;
        }
        c += (hits / 9) * area(b);
      }
      return c;
    };
    // inside: a grid over the cloud, nearest the anchor first — the note as set (w × h), or turned a quarter
    // (h × w) for a cloud too narrow for it but long enough along its other side
    const insideOf = (bw, bh) => {
      const list = [];
      if (x1 - x0 < bw + 2 * gap || y1 - y0 < bh + 2 * gap) return list;
      const cells = ((x1 - x0 - bw) * (y1 - y0 - bh)) / MAX_INSIDE;
      const step = Math.max(2, Math.min(bw, bh) / 2, Math.sqrt(Math.max(0, cells)));
      for (let y = y0 + gap; y + bh <= y1 - gap; y += step) for (let x = x0 + gap; x + bw <= x1 - gap; x += step) {
        const b = [x, y, x + bw, y + bh];
        if (allowed(b)) list.push({ b, d: dist(b, anchor) });
      }
      return list;
    };
    const inside = insideOf(w, h);
    const turned = w > h ? insideOf(h, w) : [];
    // outside: above, below, left, right of the cloud, stepping away ring by ring
    const cx = Math.min(Math.max(anchor[0] - w / 2, x0), x1 - w);
    const cy = Math.min(Math.max(anchor[1] - h / 2, y0), y1 - h);
    const outside = [];
    for (let s = 1; s <= OUTSIDE_STEPS; s++) {
      const oy = gap * 2 + (s - 1) * (h + gap), ox = gap * 2 + (s - 1) * (Math.min(w, 4 * h) + gap);
      const at = [];
      for (const x of [cx, x0, x1 - w]) { at.push([x, y0 - oy - h]); at.push([x, y1 + oy]); }
      for (const y of [cy, y0, y1 - h]) { at.push([x0 - ox - w, y]); at.push([x1 + ox, y]); }
      for (const [x, y] of at) {
        const b = [x, y, x + w, y + h];
        if (!allowed(b)) continue;
        const onCloud = nearestOnRect(rect, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
        const leader = [nearestOnRect(b, onCloud[0], onCloud[1]), onCloud];
        outside.push({ b, d: dist(b, anchor), leader, long: Math.hypot(leader[1][0] - leader[0][0], leader[1][1] - leader[0][1]) > maxLeader, crosses: crossesFloor(leader) });
      }
    }
    for (const c of [...inside, ...turned, ...outside]) c.cost = cost(c.b);
    const byDist = (a, b) => a.d - b.d || a.b[1] - b.b[1] || a.b[0] - b.b[0];
    const free = (list) => list.filter((c) => c.cost === 0).sort(byDist)[0];
    // outside, a free spot whose leader stays short and crosses no measured floor wins, then one with a short
    // leader, then any free one; failing all, the spot that covers least
    const freeOut = (ok) => free(outside.filter(ok));
    const pickTurned = free(turned);
    const pick = free(inside) ?? pickTurned ?? freeOut((c) => !c.long && !c.crosses) ?? freeOut((c) => !c.long) ?? freeOut((c) => !c.crosses) ?? free(outside)
      ?? [...inside, ...outside].sort((a, b) => a.cost - b.cost || byDist(a, b))[0];
    const box = pick ? pick.b : clamp([x0, y0 - h - gap, x0 + w, y0 - gap]);
    const leader = pick?.leader ?? (box[0] >= x0 && box[2] <= x1 && box[1] >= y0 && box[3] <= y1 ? null : (() => {
      const onCloud = nearestOnRect(rect, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      return [nearestOnRect(box, onCloud[0], onCloud[1]), onCloud];
    })());
    taken.push([box[0] - gap / 2, box[1] - gap / 2, box[2] + gap / 2, box[3] + gap / 2]);
    out[k] = { box, leader, rotated: !!pick && pick === pickTurned };
  }
  return out;
}
const boxOf = (p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
};
