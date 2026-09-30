import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSheetNumber } from "../src/lib/sheets.ts";

// Identity viewport: item transform [fs,0,0,fs,x,y] lands at (x,y) with glyph
// height fs. Page is 1000×800; the title-block gate is x ≥ 600, y ≥ 440.
const VP = { width: 1000, height: 800, transform: [1, 0, 0, 1, 0, 0] };
const item = (str: string, x: number, y: number, fs: number, width?: number) => ({
  str,
  transform: [fs, 0, 0, fs, x, y],
  ...(width != null ? { width } : {}),
});

test("an intact title-block number still wins", () => {
  const tc = {
    items: [
      item("A-101", 920, 760, 30),
      item("GMP-3", 880, 500, 8), // sheet-issue row: smaller, higher up
      item("SCALE: 1/8\" = 1'-0\"", 700, 700, 10),
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), "A-101");
});

test("a sheet number split into glyph runs is joined and beats a lone lookalike", () => {
  // the DocuSign-flattened Johnston County set: "M-121A" arrives as three runs
  // while the sheet-issue table's "GMP-3" is one item — the bug read GMP-3
  const tc = {
    items: [
      item("M", 920, 780, 28, 18),
      item("-", 940, 780, 28, 8),
      item("121A", 950, 780, 28, 70),
      item("GMP-3", 880, 500, 8, 30),
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), "M-121A");
});

test("fragments far apart on a baseline do not join", () => {
  // two tokens on one row separated by a column gap — the join must not
  // manufacture a candidate from them (and neither matches alone)
  const tc = {
    items: [
      item("121A", 700, 780, 10, 30),
      item("M", 900, 780, 10, 8), // 170px gap ≫ 1.2 × glyph height
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), null);
});

test("no sheet-number-shaped text → null", () => {
  const tc = { items: [item("SECOND FLOOR", 900, 760, 20)] };
  assert.equal(extractSheetNumber(tc, VP), null);
});

// Norwegian numbers run to four digits or two groups ("A-1111", "A20-02"); a paper size ("A3")
// and a type tag repeated on the drawing ("YV-3") are shaped like one and are not; the token
// beside the title block's own field label (TEGN.NR / SHEET NO) is preferred when there is one.
test("four-digit and two-group Norwegian numbers are read; a paper size never is", () => {
  assert.equal(extractSheetNumber({ items: [item("A-1111", 920, 760, 20), item("A3", 900, 700, 20)] }, VP), "A-1111");
  assert.equal(extractSheetNumber({ items: [item("A20-02", 920, 760, 20)] }, VP), "A20-02");
  assert.equal(extractSheetNumber({ items: [item("A.205", 920, 760, 20)] }, VP), "A.205");
  assert.equal(extractSheetNumber({ items: [item("A3", 920, 760, 30), item("A3/1:100", 900, 700, 20)] }, VP), null);
});

test("a tag repeated on the drawing outside the title block is a legend key, not the sheet number", () => {
  const items = [
    item("YV-3", 950, 780, 30),            // the legend's wall-type key, biggest and lowest-right
    item("YV-3", 200, 200, 8), item("YV-3", 300, 350, 8),   // the same tag on two walls of the plan
    item("A-101", 900, 700, 12),
  ];
  assert.equal(extractSheetNumber({ items }, VP), "A-101");
  // once only on the plan it is not known to be a key; the largest shape still wins
  assert.equal(extractSheetNumber({ items: items.slice(0, 2).concat(items[3]) }, VP), "YV-3");
});

test("the token beside the sheet-number field label wins over a bigger lookalike elsewhere in the block", () => {
  const under = [item("Tegn.nr.", 880, 740, 10, 40), item("A-1111", 880, 767, 20), item("YV-3", 960, 500, 30)];
  assert.equal(extractSheetNumber({ items: under }, VP), "A-1111");
  const beside = [item("SHEET NO:", 700, 780, 10, 60), item("A-101", 770, 781, 12), item("GMP-3", 960, 790, 30)];
  assert.equal(extractSheetNumber({ items: beside }, VP), "A-101");
  const split = [item("TEGNING NR.:", 880, 740, 10, 80), item("A", 880, 770, 20, 14), item("-", 894, 770, 20, 6), item("1111", 900, 770, 20, 50), item("GMP-3", 960, 790, 30)];
  assert.equal(extractSheetNumber({ items: split }, VP), "A-1111");
  // a label with nothing beside it changes nothing
  assert.equal(extractSheetNumber({ items: [item("DWG NO.", 700, 600, 10, 40), item("A-101", 920, 760, 20)] }, VP), "A-101");
});
