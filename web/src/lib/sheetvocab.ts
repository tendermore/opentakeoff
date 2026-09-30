// Drawing-set vocabulary for the sheet graph (sheetgraph.ts), in ONE place.
//
// These tables are LANGUAGE, not examples: the words architects print in title
// blocks and schedule headers in English (AIA/US), Norwegian (NS/Statsbygg
// practice) and the neighbouring Scandinavian and German conventions. Nothing
// here names a project, an office or a drawing. Adding a language means adding
// words to these tables — the matching logic in sheetgraph.ts never changes.
//
// Every pattern runs on UPPER-CASED text (sheetgraph's norm()). "L" below is a
// letter in any of these alphabets, so a compound ("HIMLINGSPLAN",
// "DØRSKJEMA") matches on its head word while a longer word that merely
// starts with it ("PLANLAGT", "FASADEKLEDNING") does not.

import type { SheetRole } from "./sheetgraph";

const L = "A-ZÆØÅÄÖÜ";
/** A word ending in `head` (a compound's head word), optionally followed by
 * one of the listed inflections, and not continuing into another letter. */
const headWord = (head: string, suffixes: string[] = []): RegExp =>
  new RegExp(`(?<![${L}])[${L}]*(?:${head})(?:${suffixes.join("|")})?(?![${L}])`, "u");

// ── sheet-role title terms ──────────────────────────────────────────────────
// Ordered: a title span takes the FIRST term it matches, so the more specific
// reading sits above the more general one ("SKJEMA RIVING" is a schedule of
// demolition work, not a demolition plan; "RIVEPLAN" is a demolition plan,
// not just a plan; "DØRSKJEMA 2. ETASJE" is a schedule scoped to a level).
// conf mirrors the English signals' scale: a named drawing type 0.85, an
// elevation 0.7, a detail/section 0.6 (sections share the word with running
// references), a bare level name 0.6 (a plan title in practice, but levels
// are also printed on elevations and sections — the title-block gate carries
// that risk, not this number).
/** nordic: the term reads only on a sheet that shows Nordic text (æ/ø/å
 * anywhere) — "PLAN 2" is the second floor on a Norwegian sheet and the
 * house model on a US one ("ENERGY COMPLIANCE - PLAN 2"). */
/** level: the term is a bare level name ("2. ETASJE") — it scopes another
 * drawing type named with it rather than contesting it. */
export interface RoleTerm { re: RegExp; role: SheetRole; conf: number; nordic?: boolean; level?: boolean }
export const EUROPEAN_ROLE_TERMS: RoleTerm[] = [
  // schedules: NO/DA "skjema, liste", SV "förteckning", DE "Liste"
  // an English title that ENDS in PLAN(S), or joins it to another drawing
  // ("PLANS AND DETAILS"), names a plan ("AREA 'A' PLANS", "LIFE SAFETY PLAN") — the key-plan inset and "PLAN NOTES" are masked
  // before this runs, and running text never ends a short title this way
  { re: new RegExp(`(?<![${L}])PLANS?(?:\\s*$|\\s*(?:AND|&)\\s)`, "u"), role: "plan", conf: 0.85 },
  // legends first: "SYMBOLLISTE" is a legend, not a list of items
  { re: headWord("TEGNFORKLARING|SYMBOLFORKLARING|SIGNATURFORKLARING|SYMBOLLISTE|TECKENFÖRKLARING|LEGENDE"), role: "legend", conf: 0.5 },
  // schedules: NO/DA "skjema", SV "förteckning", and "…liste" as a compound
  // head ("DØRLISTE", "ROMLISTE") — a bare "LISTE" after a one-letter prefix
  // ("E-LISTE") is a revision or issue list in a title block, not a schedule
  { re: headWord("SKJEMA|FORTEGNELSE|FÖRTECKNING", ["ER", "ET", "NE", "N"]), role: "schedule", conf: 0.85 },
  { re: new RegExp(`(?<![${L}])[${L}]{3,}LISTE(?:R|N|NE)?(?![${L}])`, "u"), role: "schedule", conf: 0.85 },
  // demolition: NO "riveplan / rivetegning / riving", DA "nedrivning", SV "rivning", DE "Abbruch"
  { re: headWord("RIVEPLAN|RIVETEGNING|RIVING|NEDRIVNING|RIVNING|ABBRUCH", ["ER", "EN", "SPLAN"]), role: "demolition", conf: 0.9 },
  // plans: NO/DA/SV "plan" as a compound's head (etasjeplan, himlingsplan,
  // situasjonsplan …) or its lead (plantegning, planløsning, SV
  // planritning); DE "Grundriss". A STANDALONE "plan" names the drawing only
  // when a level follows it ("Plan 1. etasje", "Plan U1", "Plan loft") —
  // bare, it is as often English running text ("PLAN NORTH", "PLAN
  // DIRECTION", "ENLARGED PLAN" has its own English signal).
  { re: new RegExp(`(?<![${L}])[${L}]+PLAN(?:ER|EN|ET)?(?![${L}])|(?<![${L}])PLAN(?:TEGNING(?:ER)?|LØSNING|RITNING)(?![${L}])|(?<![${L}])GRUNDRISS(?:E)?(?![${L}])`, "u"), role: "plan", conf: 0.85 },
  { re: new RegExp(`(?<![${L}])PLAN\\s*[-–:]?\\s*(?:\\d|[UHK]\\s?\\d|U(?![${L}])|LOFT|TAK|KJELLER|SOKKEL|UNDER|HOVED|ETASJE|ETG|OG(?![${L}]))`, "u"), role: "plan", conf: 0.85, nordic: true },
  // elevations: NO "fasade / oppriss", SV "fasad", DA "facade", DE "Ansicht"
  { re: headWord("FASADE|FASAD|FACADE|OPPRISS|ANSICHT|ELEVASJON", ["R", "N", "NE", "ER", "EN"]), role: "elevation", conf: 0.7 },
  // sections and details: NO "snitt / detalj", SV "sektion / detalj", DA "snit / detalje", DE "Schnitt / Detail"
  { re: headWord("SNITT|SNIT|SEKTION|SCHNITT|DETALJ|DETALJE|DETAIL", ["ER", "ET", "TEGNING", "TEGNINGER", "S", "E", "EN"]), role: "detail", conf: 0.6 },
  // a level name standing as the title ("1. ETASJE", "U. ETG", "KJELLER") — NO
  { nordic: true, level: true, re: new RegExp(`(?:\\d+\\s*\\.?|(?<![${L}])U\\.?|UNDER|SOKKEL|HOVED|LOFT)\\s*(?:ETASJE|ETG)(?![${L}])|(?<![${L}])(?:ETASJE|ETG)\\.?\\s*[U\\d]|(?<![${L}])(?:KJELLER|LOFT)(?:ETASJE)?(?![${L}])`, "u"), role: "plan", conf: 0.6 },
];

/** Title words that LOOK like a role but are not one — checked before the
 * terms above, on the same span. Forms and indexes named "…skjema/…liste"
 * (a drawing list, a checklist, a tender form, a bill of quantities),
 * schematic diagrams ("prinsippskjema", "systemskjema"), the key-plan inset
 * every US title block carries, and the Norwegian planning act's name. */
export const NOT_A_ROLE_TITLE = new RegExp([
  `(?:INNHOLDS|TEGNINGS|DOKUMENT|SJEKK|KONTROLL|TILBUDS|SAMORDNINGS|SØKNADS|REVISJONS|MENGDE|PRIS|ENDRINGS)(?:SKJEMA|LISTE)`,
  `(?:PRINSIPP|SYSTEM|KOBLINGS|FLYT|STRØM|STIGE|ENLINJE)SKJEMA`,
  `KEY\\s*PLAN|NØKKELPLAN|PLAN\\s*NORTH|PLAN-\\s*OG\\s*BYGNINGS`,
].join("|"), "gu");

/** A sheet shows Nordic text: æ/ø/å anywhere, or a Norwegian drawing word
 * no English sheet prints. Gates the terms marked `nordic`. */
export const NORDIC_TEXT_RE = new RegExp(`[ÆØÅæøå]|(?<![${L}])(?:ETASJE|ETG|TEGNING|TEGNINGSNR|SNITT|FASADE|SKJEMA|TILTAKSHAVER|PLANTEGNING|OPPRISS)(?![${L}])`, "iu");
/** An ø standing alone, not inside a word, is a diameter sign ("ø 5'-0\"", a
 * turning circle on a US plan), not Nordic text. */
const DIAMETER_SIGN_RE = /(?<!\p{L})[øØ](?!\p{L})/gu;
/** Does this text read as Nordic (NORDIC_TEXT_RE), a diameter sign aside? */
export const readsNordic = (text: string): boolean => NORDIC_TEXT_RE.test(text.replace(DIAMETER_SIGN_RE, ""));

/** Running-text references are not titles: "SEE FINISH PLAN FOR …", "Se
 * plantegning for plassering", "iht. snitt A-A". Tested after a leading
 * bullet/dash is stripped. A revision-block entry ("REV-1 DPI PLAN") names
 * what changed, not the sheet. A bare leading "SE" is not enough on its own —
 * in English it is the south-east compass point ("SE ELEVATION"). */
export const REFERENCE_RE = /^(SEE|REFER|PER|NOTED|AS SHOWN|JF|JFR|IHT|I\.H\.T|REF|REV|REVISION|REVISJON)\b|REFER TO|\b(SEE|SE|IHT\.?|JF\.?) [A-ZÆØÅ]*(TEGNING|PLAN|DETALJ|SNITT|FASADE|OPPRISS|SKJEMA|SHEET|DETAIL|SECTION)/u;

/** Title-block field labels — "TEGNING:", "INNHOLD:", "SHEET TITLE". A title
 * block prints them small beside the value; they are never the title. */
export const TITLE_FIELD_LABEL_RE = /^(TEGNING(?:STITTEL)?|TITTEL|INNHOLD|BESKRIVELSE|SHEET TITLE|DRAWING TITLE|TITLE|ETASJE|FAG|TYPE)\s*:?$/;

// ── door / window schedules ─────────────────────────────────────────────────
// A schedule title's kind. A title naming both ("DØR- OG VINDUSSKJEMA",
// "DOOR AND WINDOW SCHEDULE") is a combined opening schedule.
// The words appear as whole words and inside compounds ("DØRSKJEMA",
// "YTTERVINDUSKJEMA", "TÜRLISTE"). PORT only as a word's start — "RAPPORT"
// and "TRANSPORT" are not gates.
export const DOOR_WORD_RE = new RegExp(`DØR|DOOR|DÖRR|TÜR|(?<![${L}])PORT(?:ER|ENE|S)?(?![${L}])|(?<![${L}])PORT(?:SKJEMA|LISTE)`, "u");
export const WINDOW_WORD_RE = /VINDU|WINDOW|FÖNSTER|FENSTER|GLASSFELT/u;
/** A heading that names a schedule/list at all ("… SKJEMA", "… LISTE", "… SCHEDULE"). */
export const SCHEDULE_WORD_RE = new RegExp(`(?:SKJEMA|LISTE|SCHEDULE|FÖRTECKNING|FORTEGNELSE)(?:S|ER|N|NE)?(?![${L}])`, "u");

/** The key-row label of a transposed ("card") schedule: the row that names
 * the types as columns. */
export const CARD_KEY_LABEL_RE = /^(ID|NR\.?|NO\.?|MARK|TYPE|POS\.?|POSISJON|BETEGNELSE|DØR ?NR\.?|VINDU ?NR\.?|DØRTYPE|VINDUSTYPE|TYPE ?NR\.?)\s*:?$/;

/** Field labels of a door/window schedule, mapped to canonical column names.
 * Card schedules print these down the first column; row schedules across the
 * header. First match wins, so the specific ("BREDDE" → WIDTH) precedes the
 * general ("B" → WIDTH). */
export const OPENING_FIELDS: Array<{ re: RegExp; field: string }> = [
  // the count label alone ("Antall", "Antall (total)", "QTY") — "Antall H / V"
  // is a split by hand, not the count
  { re: /^(ANTALL|ANT\.?|STK\.?|QTY\.?|QUANTITY|COUNT|ANZAHL|ANTAL)(\s*\(?(TOTAL|STK\.?|SUM)\)?)?\s*:?$/, field: "QTY" },
  { re: /^(BREDDE|WIDTH|BREITE|B)(\s*\(?MM\)?)?\s*[=:]?$|^(BREDDE|WIDTH)\b/, field: "WIDTH" },
  { re: /^(HØYDE|HOYDE|HEIGHT|HÖHE|HÖJD|H)(\s*\(?MM\)?)?\s*[=:]?$|^(HØYDE|HEIGHT)\b/, field: "HEIGHT" },
  { re: /^(STØRRELSE|STORRELSE|SIZE|DIMENSJON|DIMENSION|BXH|B\s*X\s*H|MÅL|KARMMÅL|LYSÅPNING)\b/, field: "SIZE" },
  { re: /^(BRANN\w*|FIRE\s*RATING|FIRE|RATING|BRAND\w*)\b/, field: "FIRE" },
  { re: /^(LYD\w*|SOUND|STC|RW)\b/, field: "SOUND" },
];
export const openingField = (label: string): string | null => {
  const t = label.trim().toUpperCase();
  for (const f of OPENING_FIELDS) if (f.re.test(t)) return f.field;
  return null;
};
