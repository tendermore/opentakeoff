// Generates test/fixtures/nordic-set.pdf — the sheet-role + door/window
// schedule fixture for Norwegian (NS/Nordic) sets. Synthetic, no project
// data. Three A3-ish pages:
//   page 1  floor plan, title block lower right "Plan 1. etasje"; a body note
//           that REFERENCES another drawing ("- Se fasadetegning …") and a
//           section-cut label must not outvote it. Door/window tags drawn at
//           openings (a wall line and a door leaf beside each tag):
//           ID-01 ×2, ID-02 ×1, V-01 ×1.
//   page 2  "Dørskjema" — a transposed (card) door schedule: the ID row names
//           the types as columns, labels (Antall, B (mm), H (mm), Brannkrav)
//           run down the first column, a printed total beside the count row.
//   page 3  "Vindusskjema" — a one-type window card (Bredde / Høyde labels).
// Deterministic byte output; re-run only to change the fixture:
//   node scripts/make-nordic-set-fixture.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "nordic-set.pdf");

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
/** Horizontal text at (x, y) pt (PDF y-up), font size s. WinAnsi covers æøå. */
const T = (x, y, s, str) => `BT /F1 ${s} Tf ${x} ${y} Td (${esc(str)}) Tj ET`;
const W = 842, H = 595;
const BORDER = `1 w 20 20 ${W - 40} ${H - 40} re S`;
/** A title block in the lower-right corner: field label + title + number. */
const titleBlock = (title, number) => [
  `0.5 w 620 30 m 822 30 l 822 110 l 620 110 l 620 30 l S`,
  T(628, 96, 6, "Tegning:"), T(628, 78, 14, title),
  T(628, 50, 6, "Tegningsnr.:"), T(628, 38, 10, number),
];
/** A door tag drawn at its opening: a wall line, a door leaf and a jamb. */
const taggedDoor = (x, y, tag) => [
  `1 w ${x - 30} ${y - 6} m ${x + 50} ${y - 6} l S`,
  `0.5 w ${x - 10} ${y - 6} m ${x - 10} ${y + 24} l S`,
  `0.5 w ${x + 20} ${y - 6} m ${x + 20} ${y + 4} l S`,
  T(x - 6, y + 2, 7, tag),
];

const pages = [
  [
    BORDER,
    ...titleBlock("Plan 1. etasje", "A20-1"),
    T(40, 560, 7, "- Se fasadetegning for plassering av vinduer"),
    T(300, 420, 7, "Snitt A"),
    `1 w 60 200 m 560 200 l 560 520 l 60 520 l 60 200 l S`,
    ...taggedDoor(120, 300, "ID-01"),
    ...taggedDoor(260, 300, "ID-01"),
    ...taggedDoor(400, 300, "ID-02"),
    ...taggedDoor(300, 450, "V-01"),
  ],
  [
    BORDER,
    ...titleBlock("Dørskjema", "A60-1"),
    T(60, 540, 9, "DØRSKJEMA - innerdører"),
    T(60, 480, 8, "ID"), T(160, 480, 8, "ID-01"), T(260, 480, 8, "ID-02"),
    T(60, 466, 8, "Antall"), T(160, 466, 8, "2"), T(260, 466, 8, "1"), T(380, 466, 8, "3"),
    T(90, 452, 8, "B (mm)"), T(160, 452, 8, "990"), T(260, 452, 8, "1 090"),
    T(90, 438, 8, "H (mm)"), T(160, 438, 8, "2 090"), T(260, 438, 8, "2 190"),
    T(60, 424, 8, "Brannkrav"), T(160, 424, 8, "EI30-Sa"), T(260, 424, 8, "-"),
  ],
  [
    BORDER,
    ...titleBlock("Vindusskjema", "A61-1"),
    T(60, 540, 9, "Vindusskjema - utvendige vinduer"),
    T(60, 480, 8, "ID"), T(160, 480, 8, "V-01"),
    T(60, 466, 8, "Antall"), T(160, 466, 8, "1"),
    T(60, 452, 8, "Bredde"), T(160, 452, 8, "1 190"),
    T(60, 438, 8, "Høyde"), T(160, 438, 8, "1 390"),
  ],
];

const N_PAGES = pages.length;
const pageObj = (i) => 3 + i;
const contObj = (i) => 3 + N_PAGES + i;
const FONT = 3 + 2 * N_PAGES;

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${N_PAGES} >>`,
  ...pages.map((_, i) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${contObj(i)} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`),
  ...pages.map((ops) => {
    const content = ops.join("\n");
    return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  }),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
];

let pdf = "%PDF-1.5\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, pdf, "latin1");
console.log(`wrote ${OUT} (${Buffer.byteLength(pdf, "latin1")} bytes)`);
