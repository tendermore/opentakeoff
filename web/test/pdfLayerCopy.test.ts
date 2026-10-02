// Layer-preserving page copies (pdfLayerCopy.js): copied sheets keep their PDF
// layers (Optional Content Groups) and each layer's default visibility, so a
// hidden revision layer stays hidden in the marked set instead of printing.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pdfLib from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createLayerPreservingPageCopier as copy } from "../src/lib/pdfLayerCopy.js";
import { buildMarkedSetPdf } from "../src/lib/markedset.js";

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFOperator, degrees } = pdfLib;
const N = PDFName.of;

/** One page with two OCGs (Current, Old) and an OCMD over both; `currentOn` picks which is visible by default. */
async function fixture(currentOn: boolean, { intent = "View", baseState }: { intent?: string; baseState?: string } = {}) {
  const doc = await PDFDocument.create();
  const current = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("Duplicate current"), Intent: "View" }));
  const old = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("Duplicate superseded"), Intent: "View" }));
  const membership = doc.context.register(doc.context.obj({ Type: "OCMD", OCGs: [current, old], P: "AllOn" }));
  const defaults = { Name: PDFString.of("Source default"), BaseState: baseState ?? (currentOn ? "OFF" : "ON"),
    Intent: intent, ...(currentOn ? { ON: [current] } : { OFF: [current] }), Order: [current, old],
    RBGroups: [[current, old]], Locked: [old], AS: [{ Event: "View", Category: ["View"], OCGs: [current, old] }] };
  doc.catalog.set(N("OCProperties"), doc.context.obj({ OCGs: [current, old], D: defaults,
    Configs: [{ Name: PDFString.of("Alternate"), BaseState: "OFF", Intent: intent, ON: [currentOn ? old : current],
      OFF: [currentOn ? current : old], Order: [old, current], RBGroups: [[current, old]], Locked: [current], AS: [] }] }));
  const page = doc.addPage([500, 300]); page.setCropBox(10, 15, 460, 260); page.setRotation(degrees(90));
  page.node.Resources()!.set(N("Properties"), doc.context.obj({ Current: current, Old: old, Both: membership }));
  for (const [key, y] of [["Current", 230], ["Old", 180], ["Both", 130]] as const) {
    page.pushOperators(PDFOperator.of("BDC" as never, [N("OC"), N(key)]));
    page.drawText(`${key} source`, { x: 40, y, size: 16 }); page.pushOperators(PDFOperator.of("EMC" as never));
  }
  page.drawText("Unlayered source overlay", { x: 40, y: 70, size: 12 });
  return PDFDocument.load(await doc.save());
}

/** What a viewer sees: per page, each marked-content layer and whether it is visible by default. */
async function inspect(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const config = await doc.getOptionalContentConfig();
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), operators = await page.getOperatorList();
    const marked: { group: { type?: string; ids?: string[] }; visible: boolean }[] = [];
    for (let i = 0; i < operators.fnArray.length; i++) if (operators.fnArray[i] === pdfjs.OPS.beginMarkedContentProps) {
      const group = operators.argsArray[i][1]; marked.push({ group, visible: config.isVisible(group) });
    }
    const texts = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : ""));
    pages.push({ marked, texts, rotation: page.rotate, view: page.view });
  }
  const groups = config.getGroups() ?? {}; await doc.destroy(); return { groups, pages };
}
const configs = (doc: pdfLib.PDFDocument) => doc.catalog.lookup(N("OCProperties"), PDFDict);

test("single-source defaults, alternate configurations, crop/rotation and overlays survive repeated copies and embedding", async () => {
  const source = await fixture(true), dest = await PDFDocument.create(), copier = copy(dest, pdfLib);
  const first = copier.copyPage(source, 0); dest.addPage(first); first.drawText("New overlay", { x: 100, y: 80, size: 12 });
  dest.addPage(copier.copyPage(source, 0));
  const composite = dest.addPage([500, 300]);
  composite.drawPage(await dest.embedPage(copier.copyPage(source, 0)), { x: 0, y: 0 });
  const reloaded = await PDFDocument.load(await dest.save());
  assert.equal(configs(reloaded).lookup(N("D"), PDFDict).lookup(N("BaseState"), PDFName).decodeText(), "OFF");
  assert.equal(configs(reloaded).lookup(N("Configs"), PDFArray).size(), 1);
  for (const key of ["Order", "RBGroups", "Locked", "AS"]) {
    assert.equal(configs(reloaded).lookup(N("D"), PDFDict).lookup(N(key), PDFArray).size(),
      configs(source).lookup(N("D"), PDFDict).lookup(N(key), PDFArray).size());
  }
  const original = await inspect(await source.save()), actual = await inspect(await reloaded.save());
  assert.deepEqual(actual.pages.map((p) => p.marked.map((m) => m.visible)), Array(3).fill(original.pages[0].marked.map((m) => m.visible)));
  assert.equal(actual.pages[0].rotation, 90); assert.deepEqual(actual.pages[0].view, original.pages[0].view);
  assert(actual.pages[0].texts.includes("New overlay")); assert(actual.pages[0].texts.includes("Unlayered source overlay"));
});

test("marked set keeps each source sheet's layers and default visibility, including stitched sheets", async () => {
  const docs: Record<string, pdfLib.PDFDocument> = { a: await fixture(true), b: await fixture(false) };
  const renderer: Record<string, Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>> = {};
  for (const [key, doc] of Object.entries(docs)) renderer[key] = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  const common = { dark: false, shapes: [], conditions: [], company: null, clientInfo: null,
    getPage: (key: string, p: number) => renderer[key].getPage(p), loadPdfData: (key: string) => docs[key].save() };
  try {
    const { bytes } = await buildMarkedSetPdf({ ...common, projectName: "Synthetic layers",
      sheets: ["a", "b"].map((key) => ({ key, file: key, page: 1, label: key })),
      markups: ["a", "b"].map((key) => ({ id: key, sheet_id: key, type: "text", at: [0.4, 0.4], text: "Native overlay" })) });
    const actual = await inspect(bytes);
    assert.equal(Object.keys(actual.groups).length, 4);
    assert.deepEqual(actual.pages.slice(-2).map((p) => p.marked.map((m) => m.visible)), [[true, false, false], [false, true, false]]);
    assert(actual.pages.at(-1)!.texts.some((text) => text.includes("Native overlay")));
    const stitched = await buildMarkedSetPdf({ ...common, projectName: "Synthetic stitch",
      sheets: [{ key: "joined", label: "joined", stitch: { members: [
        { key: "a", file: "a", page: 1, dx: 0, dy: 0 }, { key: "b", file: "b", page: 1, dx: 520, dy: 0 }] } }],
      markups: [{ id: "joined-note", sheet_id: "joined", type: "text", at: [0.4, 0.4], text: "Stitched overlay" }] });
    const joined = await inspect(stitched.bytes);
    assert.deepEqual(joined.pages.at(-1)!.marked.map((m) => m.visible), [true, false, false, false, true, false]);
    assert(joined.pages.at(-1)!.texts.some((text) => text.includes("Stitched overlay")));
  } finally { await Promise.all(Object.values(renderer).map((doc) => doc.destroy())); }
});

test("copying from several sources refuses divergent intent and unsupported configuration semantics", async () => {
  const a = await fixture(true);
  for (const [options, message] of [[{ intent: "Design" }, /divergent Intents/], [{ baseState: "Unchanged" }, /BaseState Unchanged/]] as const) {
    const dest = await PDFDocument.create(), copier = copy(dest, pdfLib); copier.copyPage(a, 0);
    const b = await fixture(false, options);
    assert.throws(() => copier.copyPage(b, 0), message);
  }
  const b = await fixture(false);
  configs(b).lookup(N("D"), PDFDict).set(N("UnsupportedFutureState"), PDFName.of("OFF"));
  const dest = await PDFDocument.create(), copier = copy(dest, pdfLib); copier.copyPage(a, 0);
  assert.throws(() => copier.copyPage(b, 0), /unsupported configuration key/);
});
