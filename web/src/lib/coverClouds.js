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
 *  label it is about }. `obstacles`: boxes a note should not cover (quantity chips, printed labels).
 *  `bounds`: [W, H]; a note always stays on the page. Small clouds are placed first. A note goes inside its
 *  cloud nearest its anchor where it covers nothing; else just outside the cloud where it covers nothing,
 *  nearest its anchor, with a leader to the cloud's edge; else where it covers least. Returns, per note, its
 *  box [x0, y0, x1, y1] and the leader (or null). */
export function placeCloudNotes(notes, obstacles, bounds, gap = 4) {
  const [W, H] = bounds;
  const taken = obstacles.map((b) => [b[0] - gap / 2, b[1] - gap / 2, b[2] + gap / 2, b[3] + gap / 2]);
  const order = notes.map((_, k) => k).sort((a, b) => area(notes[a].rect) - area(notes[b].rect));
  const out = new Array(notes.length);
  const onPage = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H;
  const clamp = ([x0, y0, x1, y1]) => {
    const w = x1 - x0, h = y1 - y0, x = Math.min(Math.max(0, x0), Math.max(0, W - w)), y = Math.min(Math.max(0, y0), Math.max(0, H - h));
    return [x, y, x + w, y + h];
  };
  for (const k of order) {
    const { w, h, rect, anchor } = notes[k];
    const [x0, y0, x1, y1] = rect;
    const cost = (b) => taken.reduce((s, t) => s + overlap(b, t), 0);
    // inside: a grid over the cloud, nearest the anchor first
    const inside = [];
    if (x1 - x0 >= w + 2 * gap && y1 - y0 >= h + 2 * gap) {
      const step = Math.max(2, h / 2);
      for (let y = y0 + gap; y + h <= y1 - gap; y += step) for (let x = x0 + gap; x + w <= x1 - gap; x += step) {
        const b = [x, y, x + w, y + h];
        if (onPage(b)) inside.push({ b, d: dist(b, anchor) });
      }
    }
    // outside: above, below, left, right of the cloud, stepping away
    const cx = Math.min(Math.max(anchor[0] - w / 2, x0), x1 - w);
    const cy = Math.min(Math.max(anchor[1] - h / 2, y0), y1 - h);
    const outside = [];
    for (let s = 1; s <= 6; s++) {
      const o = gap * 2 + (s - 1) * (h + gap);
      const at = [];
      for (const x of [cx, x0, x1 - w]) { at.push([x, y0 - o - h]); at.push([x, y1 + o]); }
      for (const y of [cy, y0, y1 - h]) { at.push([x0 - o - w, y]); at.push([x1 + o, y]); }
      for (const [x, y] of at) { const b = [x, y, x + w, y + h]; if (onPage(b)) outside.push({ b, d: dist(b, anchor) }); }
    }
    // each candidate's cost once, then the nearest free one, inside first
    for (const c of inside) c.cost = cost(c.b);
    for (const c of outside) c.cost = cost(c.b);
    const byDist = (a, b) => a.d - b.d;
    const free = (list) => list.filter((c) => c.cost === 0).sort(byDist)[0];
    const pick = free(inside) ?? free(outside) ?? [...inside, ...outside].sort((a, b) => a.cost - b.cost || a.d - b.d)[0];
    const box = pick ? pick.b : clamp([x0, y0 - h - gap, x0 + w, y0 - gap]);
    let leader = null;
    if (!(box[0] >= x0 && box[2] <= x1 && box[1] >= y0 && box[3] <= y1)) {
      const onCloud = nearestOnRect(rect, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      leader = [nearestOnRect(box, onCloud[0], onCloud[1]), onCloud];
    }
    taken.push([box[0] - gap / 2, box[1] - gap / 2, box[2] + gap / 2, box[3] + gap / 2]);
    out[k] = { box, leader };
  }
  return out;
}
