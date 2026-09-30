// Cover clouds (src/lib/coverClouds.js) and how the marked set draws them: a label a floor shape covers
// drops out at export, a cloud with nothing left is not drawn, and notes never pile on each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { liveCoverItems, coverCloudText, formatCoverArea, placeCloudNotes, cloudInside } from '../src/lib/coverClouds.js';
import { markedSetText } from '../src/lib/markedsetLocale.js';
import { buildMarkedSetPdf } from '../src/lib/markedset.js';

const nb = markedSetText('nb'), en = markedSetText('en');
const cloud = (id: string, rect: number[][], kind: string, items: { at: number[]; text: string }[]) =>
  ({ id, sheet_id: 's.pdf', type: 'cloud', text: '', rect, source: 'cover', cover: { kind, items } });

test('cover notes are short and in the marked set\'s words', () => {
  assert.equal(coverCloudText('not_measured', [{ at: [0, 0], text: `Gangareal ${formatCoverArea(54, true, nb)}` }], nb), 'Ikke målt: Gangareal 54,0 m²');
  assert.equal(coverCloudText('no_label', [{ at: [0, 0], text: formatCoverArea(12.34, true, en) }], en), 'No room label: 12.3 m2');
  assert.equal(formatCoverArea(9.2903, false, en), '100 SF');
});

test('an item a floor shape covers is no longer live; a user cloud has none', () => {
  const m = cloud('c', [[0, 0], [1, 1]], 'not_measured', [{ at: [0.2, 0.2], text: 'A' }, { at: [0.7, 0.7], text: 'B' }]);
  const floor = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]];
  assert.deepEqual(liveCoverItems(m, [floor]).map((i: { text: string }) => i.text), ['B']);
  assert.deepEqual(liveCoverItems({ ...m, source: undefined }, []), []);
});

test('a cloud is pulled in by its scallops so it stays on the zone', () => {
  const [x0, y0, x1, y1] = cloudInside([100, 100, 300, 200]);
  assert.ok(x0 > 100 && y0 > 100 && x1 < 300 && y1 < 200);
  assert.ok(x1 - x0 > 180);
});

const overlaps = (a: number[], b: number[]) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
test('notes: inside the cloud where they fit, else outside with a leader; never on each other or on a chip', () => {
  const chip = [120, 120, 180, 132];
  const notes = [
    { w: 60, h: 12, rect: [100, 100, 300, 200], anchor: [150, 126] },   // a room-sized cloud: fits inside, off the chip
    { w: 80, h: 12, rect: [100, 20, 130, 90], anchor: [115, 50] },     // a thin strip: no room inside
    { w: 80, h: 12, rect: [104, 22, 128, 88], anchor: [116, 55] },     // another strip right on top of it
  ];
  const placed = placeCloudNotes(notes, [chip], [1000, 1000]);
  const [big, thin, twin] = placed;
  assert.equal(big.leader, null);
  assert.ok(big.box[0] >= 100 && big.box[2] <= 300 && big.box[1] >= 100 && big.box[3] <= 200, `inside: ${big.box}`);
  assert.ok(!overlaps(big.box, chip));
  assert.ok(thin.leader && twin.leader, 'strips get their notes beside them, with a leader');
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) assert.ok(!overlaps(placed[a].box, placed[b].box), `notes ${a} and ${b} overlap`);
});

async function pageText(markups: unknown[], shapes: unknown[]) {
  const source = await PDFDocument.create();
  source.addPage([400, 300]);
  const bytes = await source.save();
  const out = await buildMarkedSetPdf({
    projectName: 'cover', dark: false, locale: 'nb', units: 'metric', sheets: [{ key: 's.pdf', file: 's.pdf', page: 1, label: 'A-1' }],
    shapes, markups, conditions: [{ id: 'c1', finish_tag: 'GULV', color: '#cc5500' }], company: null, clientInfo: null,
    loadPdfData: async () => bytes,
    getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 300 * scale, transform: [scale, 0, 0, -scale, 0, 300 * scale] }) }),
  });
  const doc = await PDFDocument.load(out.bytes);
  const page: any = doc.getPages()[1];
  let contents = '';
  for (const ref of page.node.Contents().asArray()) {
    const stream: any = doc.context.lookup(ref), filter = stream.dict.lookup(PDFName.of('Filter'));
    contents += Buffer.from(String(filter) === '/FlateDecode' ? inflateSync(stream.contents) : stream.contents).toString('latin1');
  }
  return contents;
}
const hexOf = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

test('the marked set drops what a floor shape committed after cover covers, whatever committed it', async () => {
  const floor = { id: 'f', sheet_id: 's.pdf', condition_id: 'c1', measure_role: 'floor_area', verts_norm: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]], computed: { area_sf: 100 } };
  const markups = [
    cloud('both', [[0.05, 0.05], [0.9, 0.9]], 'not_measured', [{ at: [0.2, 0.2], text: 'Ventesone 7,1 m²' }, { at: [0.7, 0.7], text: 'Lager 5,7 m²' }]),
    cloud('gone', [[0.12, 0.12], [0.28, 0.28]], 'not_measured', [{ at: [0.2, 0.25], text: 'Heis 3,7 m²' }]),
  ];
  const text = await pageText(markups, [floor]);
  assert.ok(text.includes(hexOf('Ikke målt: Lager 5,7 m²')), 'the label still unmeasured is noted');
  assert.ok(!text.includes(hexOf('Ventesone')), 'the one measured since is not');
  assert.ok(!text.includes(hexOf('Heis')), 'a cloud with nothing left is not drawn');
});
