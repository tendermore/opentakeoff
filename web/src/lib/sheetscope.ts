// What a sheet is FOR, and which of its drawings are drawn at the sheet's
// scale — the two questions to answer before measuring walls off it.
//
// A ventilation plan draws its ducts as parallel line pairs a wall's width
// apart; an electrical plan draws the architect's walls as a faint background
// and its own runs on top; a detail beside a plan is drawn at five or ten
// times its scale. Measured as walls, every one of them is a confident wrong
// number. The title block names the discipline in the drafter's own words
// (English and Nordic), the drawing number carries a discipline code, and
// every drawing on a sheet prints its own scale under its title. Nothing here
// reads layers or any one project's naming.
import { scaleFromLabel } from "./sheets.ts";

export type Discipline =
  | "architectural" | "mechanical" | "plumbing" | "electrical" | "fire_protection"
  | "structural" | "civil_landscape" | "demolition" | "unknown";

export interface DisciplineReading {
  discipline: Discipline;
  /** The text that decided it (title-block words or the drawing number). */
  evidence?: string;
  source?: "title" | "number";
}

interface Span { str: string; x0: number; y0: number; x1: number; y1: number }

// Title words, English and Nordic. Each names what the drawing SHOWS, so a
// title naming one of these is a sheet of that trade whatever else it says.
const TITLE_TERMS: Array<[Discipline, RegExp]> = [
  ["architectural", /\b(BRANNTEGNING|PLANTEGNING|FLOOR PLAN|ARKITEKT\w*|MØBLERINGSPLAN|FURNITURE PLAN)\b/],
  ["demolition", /\b(RIVING|RIVEPLAN|RIVNINGSPLAN|DEMOLITION|DEMO PLAN)\b/],
  ["mechanical", /\b(VENTILASJON\w*|LUFTBEHANDLING|KANALPLAN|HVAC|MECHANICAL|DUCTWORK|SHEET METAL|OPPVARMING|KJØLING|VARME(ANLEGG)?)\b/],
  ["plumbing", /\b(SANITÆR\w*|RØRANLEGG|VANNFORSYNING|AVLØP\w*|PLUMBING|DOMESTIC WATER|SANITARY)\b/],
  ["fire_protection", /\b(SPRINKLER\w*|FIRE PROTECTION|FIRE SUPPRESSION)\b/],
  ["electrical", /\b(ELKRAFT|ELEKTRO\w*|EKOM|SVAKSTRØM|BELYSNING\w*|ELECTRICAL|LIGHTING|POWER PLAN|LOW VOLTAGE)\b/],
  ["structural", /\b(BÆRESYSTEM|FUNDAMENT\w*|ARMERING\w*|DEKKE OVER|STRUCTURAL|FRAMING PLAN|FOUNDATION PLAN)\b/],
  ["civil_landscape", /\b(LANDSKAP\w*|UTOMHUS\w*|SITUASJONSPLAN|VA-?PLAN|GRAVEPLAN|CIVIL|SITE PLAN|GRADING|LANDSCAPE)\b/],
];

// Device words a trade's legend lists (stems; English and Nordic).
const LEGEND_TERMS: Array<[Discipline, string[]]> = [
  ["electrical", ["STIKKONTAKT", "LYSBRYTER", "BRYTER", "LYSPUNKT", "ARMATUR", "UTELYS", "UTTAK", "KABELKANAL", "RECEPTACLE", "SWITCH", "LUMINAIRE", "PANELBOARD", "JUNCTION"]],
  ["mechanical", ["TILLUFT", "AVTREKK", "SPJELD", "AGGREGAT", "DIFFUSER", "DAMPER", "GRILLE", "SUPPLY", "EXHAUST", "THERMOSTAT"]],
  ["plumbing", ["SLUK", "STAKEKUMMER", "VANNLÅS", "CLEANOUT", "HOSE", "BACKFLOW", "WATER HEATER"]],
];

// Drawing-number discipline codes: the Nordic trade codes (ARK, RIV, RIE, RIB,
// VVS …) and the US NCS designator letter leading a number such as M-101 or
// E2.1. A bare Nordic "V-12" is an appendix number as often as a VVS sheet, so
// single letters count only in the NCS shape (letter, optional dash, digit).
const CODE_TERMS: Array<[Discipline, RegExp]> = [
  ["architectural", /^(ARK|IARK|A|I)$/],
  ["mechanical", /^(RIV|VVS|M|H)$/],
  ["plumbing", /^(P|RØR)$/],
  ["electrical", /^(RIE|EL|E)$/],
  ["fire_protection", /^(FP|SPR)$/],
  ["structural", /^(RIB|S|K)$/],
  ["civil_landscape", /^(LARK|L|C)$/],
];

/** Title text is at least this many times the sheet's median text height. */
const TITLE_SIZE = 1.25;

const up = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/** The discipline the title block states. The title zone is the bottom-right
 *  corner or the right-edge strip where title blocks sit; the words there name
 *  the drawing. A drawing number's discipline code answers when the words do not. */
export function sheetDiscipline(spans: Span[], width: number, height: number, sheetNumber?: string | null): DisciplineReading {
  const zone = spans.filter((s) => {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    return (cx >= width * 0.55 && cy >= height * 0.6) || cx >= width * 0.82;
  });
  // the largest title-block text first: the drawing title outranks a legend line
  // a drawing title is set larger than the sheet's running text
  const hs = spans.map((s) => s.y1 - s.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = hs.length ? hs[hs.length >> 1] : 0;
  // the bottom-right corner is the title block itself; along the right-edge
  // strip plan text can reach in, so there only title-size text counts
  const corner = (s: Span) => (s.x0 + s.x1) / 2 >= width * 0.55 && (s.y0 + s.y1) / 2 >= height * 0.75;
  const bySize = zone.filter((s) => corner(s) || s.y1 - s.y0 >= TITLE_SIZE * medH).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
  for (const s of bySize.slice(0, 40)) {
    const t = up(s.str);
    // a field label ("Sprinkleranlegg:") names no drawing
    // a drawing title is a short line; a note or legend sentence that merely
    // mentions a trade ("…see casework, plumbing fixture…") is not
    if (t.length > 60 || /:\s*$/.test(t) || /[,;()]/.test(t) || t.split(" ").length > 6) continue;
    // a notes or legend heading heads text, not a drawing
    if (/(NOTES?|NOTER|MERKNAD\w*|LEGEND|TEGNFORKLARING)\b|\bGENERAL\b/.test(t)) continue;
    for (const [d, re] of TITLE_TERMS) if (re.test(t)) return { discipline: d, evidence: s.str.trim(), source: "title" };
  }
  // a legend of one trade's devices (sockets, switches, diffusers …) in the
  // title zone names the sheet when its title does not
  const words = new Set(zone.flatMap((s) => up(s.str).split(/[^A-ZÆØÅ]+/)));
  for (const [d, list] of LEGEND_TERMS) {
    const hits = list.filter((w) => [...words].some((x) => x.startsWith(w)));
    if (hits.length >= 3) return { discipline: d, evidence: `legend: ${hits.join(", ").toLowerCase()}`, source: "title" };
  }
  const num = up(sheetNumber || "").trim();
  if (num) {
    // a Nordic trade code anywhere in the number (RIV, RIE, RIB, VVS, ARK …),
    // or a whole number in the NCS shape (M-101, E201, A2.1) — a short tag like
    // "C-5" is a grid label and a bare "E02" a revision index, not a discipline
    const code = num.match(/(?:^|[^A-ZÆØÅ])(ARK|IARK|LARK|RIV|RIE|RIB|VVS|RØR)(?:[^A-ZÆØÅ]|$)/)?.[1]
      ?? num.match(/^([A-Z]{1,2})-?(?:\d{3,4}|\d{1,2}\.\d{1,2})[A-Z]?$/)?.[1];
    if (code) for (const [d, re] of CODE_TERMS) if (re.test(code)) return { discipline: d, evidence: sheetNumber!.trim(), source: "number" };
  }
  return { discipline: "unknown" };
}

/** Disciplines whose line pairs are not the building's walls to take off. */
export function wallsRefusedOn(d: Discipline): boolean {
  return d !== "architectural" && d !== "unknown";
}

export interface ScaleLabel { at: [number, number]; label: string; upp: number }

/** Every drawing-scale note printed on the sheet ("1:50", "SCALE: 1/4" = 1'-0"")
 *  outside the title block, with where it sits. */
export function scaleLabels(spans: Span[], width: number, height: number): ScaleLabel[] {
  const out: ScaleLabel[] = [];
  const hs = spans.map((s) => s.y1 - s.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = hs.length ? hs[hs.length >> 1] : 0;
  const KEY = /SCALE|MÅLESTOKK|MÅLESTOK|MÅL\b|SKALA|M\s*=/i;
  for (const s of spans) {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    if (cx >= width * 0.82 || (cx >= width * 0.55 && cy >= height * 0.8)) continue;   // the title block's own scale
    const sc = scaleFromLabel(s.str);
    if (!sc) continue;
    // a scale note belongs to a drawing title: it says SCALE/MÅLESTOKK, or sits
    // beside text set larger than the running text. A bare "1:50" amid a plan
    // is a slope (fall 1:50), not a viewport.
    const h = Math.max(1, s.y1 - s.y0);
    const titled = KEY.test(s.str) || spans.some((o) => o !== s && Math.abs((o.y0 + o.y1) / 2 - cy) <= 3 * h && Math.abs((o.x0 + o.x1) / 2 - cx) <= 25 * h &&
      (KEY.test(o.str) || o.y1 - o.y0 >= 1.3 * medH));
    if (titled) out.push({ at: [cx, cy], label: sc.label, upp: sc.upp });
  }
  return out;
}
