// Text status of a sheet — whether its words are in the text layer, drawn as
// linework, both, or absent. A CAD export whose fonts were plotted as strokes
// (SHX) or converted to outlines carries no text items at all, yet the sheet is
// covered in words; a sheet with a text layer may still draw its room tags that
// way. Every reader of the text layer (labels, scale notes, sheet numbers) then
// sees nothing, and an empty result would read as "no rooms" — this says why.
//
// Two drawn forms are read, both structural, neither lexical: a plotter that
// rasterises its fonts stamps each word as a stencil mask the size of a line of
// type (imageMasks); a CAD export that converts text to curves draws each glyph
// as a small cluster of short strokes or a filled figure, and a word is a row of
// such glyphs. No font, word list or layer name is consulted. Pure module: no
// pdf.js, no DOM.
import type { VectorGeometry } from "./oneclick.ts";
import { SEG_CLIP } from "./oneclick.ts";

export type TextStatus = "text_layer" | "outlined" | "partial" | "none";

/** Image px per mm at the working render (72 pt per inch, RENDER_SCALE 2). */
const PX_PER_MM = (72 * 2) / 25.4;
/** Type on a drawing is between these heights (mm on paper): a room tag's 1.8 mm to a title's 8 mm. */
const GLYPH_MIN_MM = 1, GLYPH_MAX_MM = 8;
/** A stencil mask that is a line of type: this high (mm), and at least as wide as it is high. */
const MASK_MIN_MM = 1, MASK_MAX_MM = 10;
/** A glyph is no wider than this many times its height (an "m" or a "W"). */
const GLYPH_MAX_ASPECT = 1.6;
/** Strokes closer than this (mm) belong to one glyph: under the space between two letters of the
 *  smallest type, over the pitch of the runs a raster-style glyph is drawn in. */
const STROKE_JOIN_MM = 0.15;
/** A stroke longer than this (mm) is linework, not part of a glyph. */
const STROKE_MAX_MM = 10;
/** A glyph has at least this many segments (a tick, a dash or a box is hatch, a dimension mark or a swatch). */
const GLYPH_MIN_SEGS = 5;
/** Glyphs on one line overlap this share of their height and sit within one height of each other. */
const ROW_OVERLAP = 0.5;
/** A word is a row of at least this many glyphs... */
const WORD_MIN_GLYPHS = 3;
/** ...that are not all one shape: a row of boxes the same size is a legend's swatches or a pattern, not letters. */
const SAME_SHAPE = 0.05;

interface Box { x0: number; y0: number; x1: number; y1: number; segs: number }

/** The words the sheet draws instead of writing: type-sized stencil masks, and rows of glyph-sized
 *  stroke clusters in its linework. */
export function outlinedWords(geo: VectorGeometry): Box[] {
  return [...maskWords(geo.imageMasks ?? []), ...glyphWords(geo)];
}

/** Stencil masks the size of a line of type. A logo or a stamp is bigger; a hatch tile or a dot is smaller. */
function maskWords(masks: [number, number, number, number][]): Box[] {
  const minH = MASK_MIN_MM * PX_PER_MM, maxH = MASK_MAX_MM * PX_PER_MM;
  const out: Box[] = [];
  for (const [x0, y0, x1, y1] of masks) {
    const w = x1 - x0, h = y1 - y0, tall = Math.min(w, h), long = Math.max(w, h);
    if (tall >= minH && tall <= maxH && long >= tall) out.push({ x0, y0, x1, y1, segs: 0 });
  }
  return out;
}

/** Rows of glyph-sized stroke clusters in the linework. */
function glyphWords(geo: VectorGeometry): Box[] {
  const { segs, meta } = geo;
  const n = segs.length >> 2;
  const maxLen = STROKE_MAX_MM * PX_PER_MM, join = STROKE_JOIN_MM * PX_PER_MM;
  // short strokes only, bucketed on a grid of the join distance
  const short: number[] = [];
  for (let i = 0; i < n; i++) {
    if (meta[i] & SEG_CLIP) continue;
    if (Math.hypot(segs[4 * i + 2] - segs[4 * i], segs[4 * i + 3] - segs[4 * i + 1]) <= maxLen) short.push(i);
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const cell = Math.max(join, 1);
  const grid = new Map<number, number[]>();
  const keyOf = (gx: number, gy: number) => gx * 1_000_003 + gy;
  const box = (i: number) => [Math.min(segs[4 * i], segs[4 * i + 2]), Math.min(segs[4 * i + 1], segs[4 * i + 3]), Math.max(segs[4 * i], segs[4 * i + 2]), Math.max(segs[4 * i + 1], segs[4 * i + 3])];
  for (const i of short) {
    const [x0, y0, x1, y1] = box(i);
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const k = keyOf(gx, gy);
      const b = grid.get(k);
      if (b) b.push(i); else grid.set(k, [i]);
    }
  }
  // strokes whose boxes come within the join distance are one glyph
  for (const i of short) {
    const [x0, y0, x1, y1] = box(i);
    for (let gx = Math.floor((x0 - join) / cell); gx <= Math.floor((x1 + join) / cell); gx++) for (let gy = Math.floor((y0 - join) / cell); gy <= Math.floor((y1 + join) / cell); gy++) {
      for (const j of grid.get(keyOf(gx, gy)) ?? []) {
        if (j <= i || find(i) === find(j)) continue;
        const [u0, v0, u1, v1] = box(j);
        if (u0 <= x1 + join && u1 >= x0 - join && v0 <= y1 + join && v1 >= y0 - join) union(i, j);
      }
    }
  }
  const clusters = new Map<number, Box>();
  for (const i of short) {
    const r = find(i), [x0, y0, x1, y1] = box(i);
    const c = clusters.get(r);
    if (c) { c.x0 = Math.min(c.x0, x0); c.y0 = Math.min(c.y0, y0); c.x1 = Math.max(c.x1, x1); c.y1 = Math.max(c.y1, y1); c.segs++; }
    else clusters.set(r, { x0, y0, x1, y1, segs: 1 });
  }
  const minH = GLYPH_MIN_MM * PX_PER_MM, maxH = GLYPH_MAX_MM * PX_PER_MM;
  // a glyph: type-sized, no wider than a letter, made of strokes; upright or on its side
  const glyphs: Box[] = [];
  for (const c of clusters.values()) {
    const w = c.x1 - c.x0, h = c.y1 - c.y0, tall = Math.max(w, h), wide = Math.min(w, h);
    if (c.segs < GLYPH_MIN_SEGS || tall < minH || tall > maxH || wide > tall * GLYPH_MAX_ASPECT) continue;
    glyphs.push(c);
  }
  // upright words first; text on its side only among the glyphs no upright word claimed
  const upright = rows(glyphs, false);
  const left = glyphs.filter((_, k) => !upright.used.has(k));
  return [...upright.words, ...rows(left, true).words];
}

/** Rows of glyphs along one axis (vertical = text on its side): glyphs whose extents across the axis
 *  overlap by ROW_OVERLAP and that sit within one glyph height along it; rows of WORD_MIN_GLYPHS or more. */
function rows(glyphs: Box[], vertical: boolean): { words: Box[]; used: Set<number> } {
  const along = (b: Box) => (vertical ? [b.y0, b.y1] : [b.x0, b.x1]);
  const across = (b: Box) => (vertical ? [b.x0, b.x1] : [b.y0, b.y1]);
  const order = glyphs.map((_, k) => k).sort((a, b) => along(glyphs[a])[0] - along(glyphs[b])[0]);
  const parent = order.map((_, k) => k);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < order.length; a++) {
    const A = glyphs[order[a]], [a0, a1] = along(A), [c0, c1] = across(A), h = c1 - c0;
    for (let b = a + 1; b < order.length; b++) {
      const B = glyphs[order[b]], [b0] = along(B);
      if (b0 - a1 > h) break;
      const [d0, d1] = across(B);
      const overlap = Math.min(c1, d1) - Math.max(c0, d0);
      if (overlap >= ROW_OVERLAP * Math.min(h, d1 - d0) && a0 <= b0) parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, Box & { members: number[] }>();
  order.forEach((k, i) => {
    const g = glyphs[k], r = find(i), o = groups.get(r);
    if (o) { o.x0 = Math.min(o.x0, g.x0); o.y0 = Math.min(o.y0, g.y0); o.x1 = Math.max(o.x1, g.x1); o.y1 = Math.max(o.y1, g.y1); o.segs += g.segs; o.members.push(k); }
    else groups.set(r, { ...g, members: [k] });
  });
  const used = new Set<number>();
  const words: Box[] = [];
  for (const { members, ...b } of groups.values()) {
    if (members.length < WORD_MIN_GLYPHS || sameShape(members.map((k) => glyphs[k]))) continue;
    words.push(b);
    for (const k of members) used.add(k);
  }
  return { words, used };
}

/** What the sheet's text is: in its text layer (`spans`), drawn as linework (`words`), both, or neither. */
export function textStatusOf(spanCount: number, wordCount: number): TextStatus {
  if (spanCount > 0) return wordCount > 0 ? "partial" : "text_layer";
  return wordCount > 0 ? "outlined" : "none";
}

/** Every box within SAME_SHAPE of the first in width and height. */
function sameShape(boxes: Box[]): boolean {
  const w = boxes[0].x1 - boxes[0].x0, h = boxes[0].y1 - boxes[0].y0;
  return boxes.every((b) => Math.abs(b.x1 - b.x0 - w) <= SAME_SHAPE * w && Math.abs(b.y1 - b.y0 - h) <= SAME_SHAPE * h);
}
