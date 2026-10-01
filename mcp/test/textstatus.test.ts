// text_status (web/src/lib/textstatus.ts, Session.textStatus): where a sheet's words are — its text
// layer, drawn as stencil masks or glyph outlines, both, or nowhere — on synthetic PDFs, and the
// refusal detect, cover and find_text give instead of an empty answer. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFRawStream, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from "pdf-lib";
import { Session } from "../src/session.ts";
import { outlinedWords, textStatusOf } from "../../web/src/lib/textstatus.ts";

const dir = mkdtempSync(join(tmpdir(), "otk-textstatus-"));

/** An A4 landscape page with a walled room; `draw` adds what the test is about. */
async function sheet(name: string, draw: (page: import("pdf-lib").PDFPage, doc: PDFDocument) => Promise<void> | void): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]);
  page.drawRectangle({ x: 100, y: 100, width: 600, height: 400, borderWidth: 2, borderColor: rgb(0, 0, 0) });
  await draw(page, doc);
  const path = join(dir, name);
  writeFileSync(path, await doc.save());
  return path;
}

/** A 1-bit stencil mask placed at (x, y) as w × h pt — what a plotter that rasterises its fonts stamps
 *  for each word (every bit 0: painted throughout under the Decode default). */
function stencil(page: import("pdf-lib").PDFPage, doc: PDFDocument, x: number, y: number, w: number, h: number): void {
  const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: 64, Height: 8, ImageMask: true, BitsPerComponent: 1 });
  const ref = doc.context.register(PDFRawStream.of(dict, new Uint8Array(64)));
  const key = page.node.newXObject("Mask", ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(key), popGraphicsState());
}

/** A row of glyph-like filled figures: five- to eight-sided, 2.5 mm tall, each a different width. */
function outlinedWord(page: import("pdf-lib").PDFPage, x: number, y: number, letters = 5): void {
  const h = 7; // pt ≈ 2.5 mm
  for (let k = 0; k < letters; k++) {
    const w = 3 + (k % 3);   // letterforms differ
    const lx = x + k * 6;
    // a closed six-point figure: a rough "S"
    page.drawSvgPath(`M0 0 L${w} 0 L${w} ${h / 2} L${w / 2} ${h / 2} L${w / 2} ${h} L0 ${h} Z`, { x: lx, y: y + h, color: rgb(0, 0, 0), scale: 1 });
  }
}

test("a text layer alone is text_layer; nothing at all is none", async () => {
  const text = await sheet("text.pdf", async (page, doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("KONTOR 12,5 m2", { x: 300, y: 300, size: 9, font });
  });
  const s = new Session();
  await s.loadPlan(text);
  assert.equal((await s.sheetInfo("text.pdf")).text_status, "text_layer");
  assert.equal(outlinedWords(await (s as any).ensureGeometry((s as any).sheet("text.pdf"))).length, 0);
  const blank = await sheet("blank.pdf", () => {});
  const b = new Session();
  await b.loadPlan(blank);
  const info = await b.sheetInfo("blank.pdf");
  assert.equal(info.text_status, "none");
  assert.equal(info.outlined_words, undefined);
  // no words anywhere: an honest empty answer that says why, not a refusal (a pure scan sweeps the same way)
  const none = await b.findText("blank.pdf", "KONTOR");
  assert.equal(none.count, 0);
  assert.equal(none.text_status, "none");
  assert.equal(none.reason, "no text layer; OCR needed");
  b.setScale("blank.pdf", { label: "1:100" });
  const det = await b.detectRooms("blank.pdf", { role: "floor_area", returnVerts: false });
  assert.equal(det.detected, 0);
  assert.equal(det.text_status, "none");
  assert.equal(det.reason, "no text layer; OCR needed");
});

test("words stamped as stencil masks with no text layer: outlined, and detect / cover / find_text say so", async () => {
  const file = await sheet("stencil.pdf", (page, doc) => {
    for (let row = 0; row < 4; row++) stencil(page, doc, 300, 300 + row * 14, 60, 8);   // four word-sized masks (60 × 8 pt)
    stencil(page, doc, 120, 120, 200, 120);                                              // a logo-sized mask: not a word
  });
  const s = new Session();
  await s.loadPlan(file);
  const info = await s.sheetInfo("stencil.pdf");
  assert.equal(info.text_status, "outlined");
  assert.equal(info.outlined_words, 4);
  assert.equal((await s.sheetContext("stencil.pdf", {})).text_status, "outlined");
  await assert.rejects(() => s.findText("stencil.pdf", "KONTOR"), /text is drawn as outlines; OCR needed/);
  s.setScale("stencil.pdf", { label: "1:100" });
  await assert.rejects(() => s.detectRooms("stencil.pdf", { role: "floor_area", returnVerts: false }), /text is drawn as outlines; OCR needed/);
  await assert.rejects(() => s.coverFloor("stencil.pdf", {}), /text is drawn as outlines; OCR needed/);
});

test("glyph outlines drawn as filled figures in rows are words; with a text layer beside them the sheet is partial and every reader says how many", async () => {
  const drawn = await sheet("glyphs.pdf", (page) => {
    outlinedWord(page, 300, 300);
    outlinedWord(page, 300, 330, 6);
    page.drawRectangle({ x: 150, y: 150, width: 5, height: 5, color: rgb(0, 0, 0) });   // a lone box is not a glyph
    for (let k = 0; k < 6; k++) page.drawRectangle({ x: 400 + k * 8, y: 150, width: 5, height: 5, color: rgb(0.5, 0.5, 0.5) });   // a legend's swatches: same shape, not a word
  });
  const s = new Session();
  await s.loadPlan(drawn);
  const info = await s.sheetInfo("glyphs.pdf");
  assert.equal(info.text_status, "outlined");
  assert.equal(info.outlined_words, 2, JSON.stringify(info));
  const mixed = await sheet("mixed.pdf", async (page, doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("KONTOR", { x: 300, y: 400, size: 9, font });
    outlinedWord(page, 300, 300);
  });
  const m = new Session();
  await m.loadPlan(mixed);
  const mi = await m.sheetInfo("mixed.pdf");
  assert.equal(mi.text_status, "partial");
  assert.equal(mi.outlined_words, 1);
  const found = await m.findText("mixed.pdf", "KONTOR");
  assert.equal(found.count, 1);
  assert.equal(found.text_status, "partial");
  assert.equal(found.outlined_words, 1);
  m.setScale("mixed.pdf", { label: "1:100" });
  const det = await m.detectRooms("mixed.pdf", { role: "floor_area", returnVerts: false });
  assert.equal(det.text_status, "partial");
  assert.equal(det.outlined_words, 1);
});

test("textStatusOf", () => {
  assert.equal(textStatusOf(0, 0), "none");
  assert.equal(textStatusOf(0, 3), "outlined");
  assert.equal(textStatusOf(5, 0), "text_layer");
  assert.equal(textStatusOf(5, 3), "partial");
});
