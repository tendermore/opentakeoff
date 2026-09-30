import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScale } from "../src/lib/sheets";

// identity-scale viewport: item transform [1,0,0,1,x,y] → position (x, y)
const VP = { width: 6048, height: 4320, transform: [1, 0, 0, 1, 0, 0] } as never;
const item = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 12, height: 25 });

test("#375: a scale note right after a digit-ending run (schedule cell) still detects", () => {
  // The Dublin A-601 item order as pdf.js emits it: schedule cells, the note under
  // the view title, the view-number bubble, the title. Whitespace-stripped
  // concatenation read this as PT-11/8" and the 11/8" guard rejected it.
  const items = [
    item("PT-1", 2072, 470), item("PT-1", 2072, 505),
    item('1/8" = 1\'-0"', 621, 3552), item("1", 519, 3538),
    item("FLOOR PLAN - PHASE I - FINISH PLAN", 614, 3507),
  ];
  const d = detectScale({ items } as never, VP);
  assert.ok(d, "note under the view title must be detected");
  assert.equal(d!.label, '1/8" = 1\'-0"');
  assert.equal(d!.multi, false);
});

test("#375: the 11/8\" and 1-1/2\" boundary guards still hold inside one run", () => {
  assert.equal(detectScale({ items: [item('11/8" = 1\'-0"', 621, 3552)] } as never, VP), null);
  assert.equal(detectScale({ items: [item('1-1/2" = 1\'-0"', 100, 100)] } as never, VP)?.label, '1-1/2" = 1\'-0"');
});

test("#375: a note the exporter split across runs still detects through the fallback", () => {
  const items = [item("SCALE:", 4000, 4000), item('1/4"', 4100, 4000), item("=", 4150, 4000), item("1'-0\"", 4180, 4000)];
  assert.equal(detectScale({ items } as never, VP)?.label, '1/4" = 1\'-0"');
});

// A paper-size token before the scale ("A3/1:100", "A1 1:100") is a prefix, not a digit boundary;
// "1:20 / 1:50" is two scales and says so. The imperial "11/8\"" guard still holds.
import { scaleFromLabel } from "../src/lib/sheets";
test("scale notes with a paper-size prefix parse; a slash between two ratios does not hide the second", () => {
  const tb = (str: string) => detectScale({ items: [item(str, 4000, 4000)] } as never, VP);
  assert.equal(tb("A3/1:100")?.label, "1:100");
  assert.equal(tb("A1 1:100")?.label, "1:100");
  assert.equal(tb("ISO A3 / 1:100")?.label, "1:100");
  assert.equal(tb("1:100/A3")?.label, "1:100");
  assert.equal(tb("Målestokk 1:50 (A1)")?.label, "1:50");
  assert.equal(tb("Målestokk: 1:100 A3")?.label, "1:100");
  const two = tb("1:20 / 1:50");
  assert.equal(two?.label, "1:20");
  assert.equal(two?.multi, true, "two distinct ratio scales in one note are flagged");
  assert.equal(tb("1:100-1:50")?.multi, true);
  // a prefix does not read as its own scale, and a longer ratio never reads as a shorter one
  assert.equal(tb("A3/1:1000")?.label, "1:1000");
  assert.equal(tb("1:500")?.label, "1:500");
  assert.equal(tb("A3")?.label, undefined);
  // the label reader (set_scale by note) takes the same forms and refuses an ambiguous note
  assert.equal(scaleFromLabel("A3/1:100")?.label, "1:100");
  assert.equal(scaleFromLabel("A1 1:100")?.label, "1:100");
  assert.equal(scaleFromLabel("1:20 / 1:50"), null);
  // imperial: the fraction guard still holds, and a paper size before one is fine
  assert.equal(tb('11/8" = 1\'-0"'), null);
  assert.equal(tb('1-1/2" = 1\'-0"')?.label, '1-1/2" = 1\'-0"');
  assert.equal(tb('ANSI D 1/8" = 1\'-0"')?.label, '1/8" = 1\'-0"');
});
