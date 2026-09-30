// Cover clouds — what takeoff_rooms cover {mark: true} clouds on the plan: the
// floor it could not measure. One cloud per zone, carrying the room labels it
// is about (`cover.items`, each where the drawing prints it). The marked set
// reads them at export, so a cloud reports only what is still unmeasured then:
// a label that a floor shape committed later covers — by any tool, on any
// surface — drops out, and a cloud with none left is not drawn. Its note sits
// where it collides with no other note and no quantity chip: inside the cloud
// when it fits, else beside it with a leader.
//
// Pure module: no pdf-lib, no DOM. Coordinates are image px unless noted.
import { pointInPoly } from "./geometry.js";

const SF_PER_M2 = 1 / 0.09290304;

/** A cover cloud's items that no floor shape covers: `floors` are the sheet's floor_area rings, normalized
 *  like the items' `at`. A markup that is not a cover cloud has none. */
export function liveCoverItems(m, floors) {
  const items = m?.source === "cover" && Array.isArray(m.cover?.items) ? m.cover.items : [];
  return items.filter((it) => !floors.some((ring) => pointInPoly(it.at[0], it.at[1], ring)));
}

/** A cover cloud's note in the marked set's words. */
export function coverCloudText(kind, items, T) {
  return kind === "no_label" ? T.coverNoLabel(items.map((i) => i.text).join(", ")) : T.coverNotMeasured(items.map((i) => i.text).join(", "));
}

/** An area as a cover note prints it: one decimal in the locale's own digits, in the display unit. */
export function formatCoverArea(m2, metric, T) {
  return metric
    ? `${fixed(m2, 1, T)} ${T.areaUnit.metric}`
    : `${fixed(m2 * SF_PER_M2, 0, T)} ${T.areaUnit.imperial}`;
}
const fixed = (v, d, T) => (Math.round(v * 10 ** d) / 10 ** d || 0).toLocaleString(T.numberLocale, { minimumFractionDigits: d, maximumFractionDigits: d });

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

/** Where each cloud's note goes. `notes`: { w, h, rect: the cloud [x0,y0,x1,y1], anchor: [x, y] the printed
 *  label it is about }. `obstacles`: boxes no note may cover (quantity chips, printed labels). `bounds`: [W, H].
 *  Small clouds are placed first. A note goes inside its cloud, nearest its anchor, where it covers nothing;
 *  else just outside the cloud where it covers nothing, nearest its anchor, with a leader from the note to the
 *  cloud's edge; else where it covers least. Returns, per note, its box [x0, y0, x1, y1] and the leader (or null). */
export function placeCloudNotes(notes, obstacles, bounds, gap = 4) {
  const [W, H] = bounds;
  const taken = obstacles.map((b) => [b[0] - gap / 2, b[1] - gap / 2, b[2] + gap / 2, b[3] + gap / 2]);
  const order = notes.map((_, k) => k).sort((a, b) => area(notes[a].rect) - area(notes[b].rect));
  const out = new Array(notes.length);
  for (const k of order) {
    const { w, h, rect, anchor } = notes[k];
    const [x0, y0, x1, y1] = rect;
    const fits = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H;
    const cost = (b) => taken.reduce((s, t) => s + overlap(b, t), 0);
    // inside: a grid over the cloud, nearest the anchor first
    const inside = [];
    const pad = gap;
    if (x1 - x0 >= w + 2 * pad && y1 - y0 >= h + 2 * pad) {
      const step = Math.max(2, h / 2);
      for (let y = y0 + pad; y + h <= y1 - pad; y += step) for (let x = x0 + pad; x + w <= x1 - pad; x += step) {
        inside.push([x, y, x + w, y + h]);
      }
      inside.sort((a, b) => dist(a, anchor) - dist(b, anchor));
    }
    let box = inside.find((b) => cost(b) === 0) ?? null;
    let leader = null;
    if (!box) {
      // outside: above, below, left, right of the cloud, stepping away until clear
      const cx = Math.min(Math.max(anchor[0] - w / 2, x0), x1 - w);
      const cy = Math.min(Math.max(anchor[1] - h / 2, y0), y1 - h);
      const ring = [];
      for (let s = 1; s <= 6; s++) {
        const o = gap * 2 + (s - 1) * (h + gap);
        for (const x of [cx, x0, x1 - w]) { ring.push([x, y0 - o - h]); ring.push([x, y1 + o]); }
        for (const y of [cy, y0, y1 - h]) { ring.push([x0 - o - w, y]); ring.push([x1 + o, y]); }
      }
      const cands = ring.map(([x, y]) => [x, y, x + w, y + h]).filter(fits).sort((a, b) => dist(a, anchor) - dist(b, anchor));
      box = cands.find((b) => cost(b) === 0) ?? null;
      if (!box) box = [...inside, ...cands].sort((a, b) => cost(a) - cost(b))[0] ?? [x0, y0 - h - gap, x0 + w, y0 - gap];
      const inCloud = box[0] >= x0 && box[2] <= x1 && box[1] >= y0 && box[3] <= y1;
      if (!inCloud) {
        const mx = (box[0] + box[2]) / 2, my = (box[1] + box[3]) / 2;
        const onCloud = nearestOnRect(rect, mx, my);
        leader = [nearestOnRect(box, onCloud[0], onCloud[1]), onCloud];
      }
    }
    taken.push([box[0] - gap / 2, box[1] - gap / 2, box[2] + gap / 2, box[3] + gap / 2]);
    out[k] = { box, leader };
  }
  return out;
}
const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
const dist = (b, [x, y]) => Math.hypot((b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y);
