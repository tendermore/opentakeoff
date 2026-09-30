// Cover clouds (src/lib/coverClouds.js) and how the marked set draws them: a label a floor shape covers
// drops out at export, a cloud with nothing left is not drawn, and notes never pile on each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { floorCoverage, liveCoverItems, coverCloudText, coverNoteLines, formatCoverArea, placeCloudNotes, cloudInside } from '../src/lib/coverClouds.js';
import { markedSetText } from '../src/lib/markedsetLocale.js';
import { buildMarkedSetPdf } from '../src/lib/markedset.js';

const nb = markedSetText('nb'), en = markedSetText('en');
type Item = { at: number[]; label?: string; name?: string; m2?: number };
const cloud = (id: string, rect: number[][], kind: string, items: Item[], extra: Record<string, unknown> = {}) =>
  ({ id, sheet_id: 's.pdf', type: 'cloud', text: 'Not measured: (as written at cover time)', rect, source: 'cover', condition_id: '', rfi_id: '', cover: { kind, items }, ...extra });
const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const floor = (id: string, ring: number[][], extra: Record<string, unknown> = {}) => ({ id, sheet_id: 's.pdf', condition_id: 'c1', measure_role: 'floor_area', verts_norm: ring, computed: { area_sf: 100 }, ...extra });

test('cover notes are worded at export from raw numbers, in the marked set\'s locale and units', () => {
  const items = [{ at: [0, 0], label: '54,0 m²', name: 'Gangareal', m2: 54 }];
  assert.equal(coverCloudText('not_measured', items, true, nb), 'Ikke målt: Gangareal 54,0 m²');
  assert.equal(coverCloudText('not_measured', items, true, en), 'Not measured: Gangareal 54.0 m2');
  assert.equal(coverCloudText('not_measured', [{ at: [0, 0], label: '101', name: 'OFFICE' }], false, en), 'Not measured: OFFICE 101');
  assert.equal(coverCloudText('no_label', [{ at: [0, 0], m2: 12.34 }], true, en), 'No room label: 12.3 m2');
  assert.equal(formatCoverArea(9.2903, false, en), '100 SF');
});

test('a long note wraps on item boundaries and is capped', () => {
  const items = Array.from({ length: 9 }, (_, k) => ({ at: [0, 0], label: `${k}`, name: `Room number ${k}`, m2: 10 + k }));
  const lines = coverNoteLines('not_measured', items, true, en, (t: string) => t.length * 5, 150, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('Not measured: Room number 0'));
  assert.match(lines[2], /\+\d+$/, 'what does not fit is counted');
});

test('covered = inside a floor outline, in none of its holes and in no deduct; a combined row covers its labels', () => {
  const shapes = [
    floor('f', sq(0.1, 0.1, 0.5, 0.5), { verts_norm_holes: [sq(0.2, 0.2, 0.3, 0.3)] }),
    { id: 'd', sheet_id: 's.pdf', condition_id: 'c1', measure_role: 'deduct', verts_norm: sq(0.4, 0.4, 0.45, 0.45) },
    floor('comb', sq(0.6, 0.6, 0.9, 0.9), { check: { status: 'combined', by: 'printed_sum', printed_m2: 12, parts: [5, 7] } }),
  ];
  const cov = floorCoverage(shapes, 's.pdf');
  const m = cloud('c', [[0, 0], [1, 1]], 'not_measured', [
    { at: [0.15, 0.15], label: 'in' }, { at: [0.25, 0.25], label: 'hole' }, { at: [0.42, 0.42], label: 'deduct' },
    { at: [0.7, 0.7], label: 'combined' }, { at: [0.95, 0.05], label: 'outside' },
  ]);
  assert.deepEqual(liveCoverItems(m, cov).map((i: Item) => i.label), ['hole', 'deduct', 'outside']);
  assert.deepEqual(liveCoverItems({ ...m, source: undefined }, cov), [], 'a user cloud has no items');
  assert.deepEqual(liveCoverItems(cloud('x', [[0, 0], [1, 1]], 'not_measured', [{ at: ['a', 1] as unknown as number[] }, null as unknown as Item]), cov), [], 'malformed items are skipped');
});

test('a cloud is pulled in by its scallops so it stays on the zone', () => {
  const [x0, y0, x1, y1] = cloudInside([100, 100, 300, 200]);
  assert.ok(x0 > 100 && y0 > 100 && x1 < 300 && y1 < 200);
  assert.ok(x1 - x0 > 180);
});

const overlaps = (a: number[], b: number[]) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
test('notes: inside the cloud where they fit, else outside with a leader; clear of each other and of chips; on the page', () => {
  const chip = [120, 120, 180, 132];
  const notes = [
    { w: 60, h: 12, rect: [100, 100, 300, 200], anchor: [150, 126] },   // a room-sized cloud: fits inside, off the chip
    { w: 80, h: 12, rect: [100, 20, 130, 90], anchor: [115, 50] },     // a thin strip: no room inside
    { w: 80, h: 12, rect: [104, 22, 128, 88], anchor: [116, 55] },     // another strip right on top of it
    { w: 90, h: 24, rect: [0, 0, 20, 20], anchor: [5, 5] },            // at the page corner
  ];
  const placed = placeCloudNotes(notes, [chip], [400, 300]);
  const [big, thin, twin] = placed;
  assert.equal(big.leader, null);
  assert.ok(big.box[0] >= 100 && big.box[2] <= 300 && big.box[1] >= 100 && big.box[3] <= 200, `inside: ${big.box}`);
  assert.ok(!overlaps(big.box, chip));
  assert.ok(thin.leader && twin.leader, 'strips get their notes beside them, with a leader');
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) assert.ok(!overlaps(placed[a].box, placed[b].box), `notes ${a} and ${b} overlap`);
  for (const p of placed) assert.ok(p.box[0] >= 0 && p.box[1] >= 0 && p.box[2] <= 400 && p.box[3] <= 300, `on the page: ${p.box}`);
});

async function pageText(markups: unknown[], shapes: unknown[], rfis: unknown[] = []) {
  const source = await PDFDocument.create();
  source.addPage([400, 300]);
  const bytes = await source.save();
  const out = await buildMarkedSetPdf({
    projectName: 'cover', dark: false, locale: 'nb', units: 'metric', sheets: [{ key: 's.pdf', file: 's.pdf', page: 1, label: 'A-1' }],
    shapes, markups, rfis: rfis as never[], conditions: [{ id: 'c1', finish_tag: 'GULV', color: '#cc5500' }], company: null, clientInfo: null,
    loadPdfData: async () => bytes,
    getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 300 * scale, transform: [scale, 0, 0, -scale, 0, 300 * scale] }) }),
  });
  const doc = await PDFDocument.load(out.bytes);
  const page: any = doc.getPages().at(-1);   // the sheet: after the cover and any RFI schedule
  let contents = '';
  for (const ref of page.node.Contents().asArray()) {
    const stream: any = doc.context.lookup(ref), filter = stream.dict.lookup(PDFName.of('Filter'));
    contents += Buffer.from(String(filter) === '/FlateDecode' ? inflateSync(stream.contents) : stream.contents).toString('latin1');
  }
  return contents;
}
const hexOf = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

test('the marked set drops what a floor committed after cover covers; a linked cloud and a malformed one still print', async () => {
  const markups = [
    cloud('both', [[0.05, 0.05], [0.9, 0.9]], 'not_measured', [{ at: [0.2, 0.2], label: '7,1 m²', name: 'Ventesone', m2: 7.1 }, { at: [0.7, 0.7], label: '5,7 m²', name: 'Lager', m2: 5.7 }]),
    cloud('gone', [[0.12, 0.12], [0.28, 0.28]], 'not_measured', [{ at: [0.2, 0.25], label: '3,7 m²', name: 'Heis', m2: 3.7 }]),
    cloud('linked', [[0.12, 0.12], [0.28, 0.28]], 'not_measured', [{ at: [0.15, 0.15], label: '9,9 m²', name: 'Kjeller', m2: 9.9 }], { rfi_id: 'r1', text: 'RFI-linked cover cloud' }),
    { ...cloud('bad', [[0.6, 0.1], [0.7, 0.2]], 'not_measured', []), cover: { kind: 'not_measured', items: 'nonsense' }, text: 'Malformed cover cloud' },
  ];
  const rfis = [{ id: 'r1', number: 7, title: 'Kjeller', question: '?', status: 'open', sheet_id: 's.pdf' }];
  const text = await pageText(markups, [floor('f', sq(0.1, 0.1, 0.3, 0.3))], rfis);
  assert.ok(text.includes(hexOf('Ikke målt: Lager 5,7 m²')), 'the label still unmeasured is noted');
  assert.ok(!text.includes(hexOf('Ventesone')), 'the one measured since is not');
  assert.ok(!text.includes(hexOf('Heis')), 'a cloud with nothing left is not drawn');
  assert.ok(text.includes(hexOf('7 RFI-linked cover cloud')), 'a cloud linked to an RFI still prints, with its RFI number');
  assert.ok(text.includes(hexOf('Malformed cover cloud')), 'a malformed cover cloud prints as a plain cloud');
});
