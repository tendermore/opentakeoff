// Marked Set text by locale. `en` is the original wording, byte for byte, so an
// English export is unchanged; add a language by adding a table with the same
// keys. Every string still passes winAnsiSafe before it is drawn (Latin-1 covers
// the Nordic and most Western European letters, and the superscript two).

const plural = (n, one, many) => (n === 1 ? one : many);

const en = {
  // number formatting: undefined = the runtime's default locale (the original behavior)
  numberLocale: undefined,
  dateLocale: undefined,
  areaUnit: { imperial: "SF", metric: "m2" },
  lengthUnit: { imperial: "LF", metric: "m" },
  countUnit: "EA",
  coverTitle: "Marked Set",
  untitledProject: "Untitled project",
  preparedFor: (name) => `Prepared for ${name}`,
  reference: (ref) => `Ref ${ref}`,
  date: (d) => `Date ${d}`,
  coverMeta: (sheets, items) => `${sheets} marked sheet${plural(sheets, "", "s")} · ${items} takeoff item${plural(items, "", "s")} · quantities net of deducts, waste-adjusted where noted`,
  approvalStamps: (estimator, agent) => `Approval stamps: ${estimator} estimator-approved · ${agent} agent-marked`,
  marksBy: (parts) => `Marks by: ${parts}`,
  unattributed: "unattributed",
  conditions: "CONDITIONS",
  bySheet: "BY SHEET",
  wall: "wall",
  border: "border",
  deduct: "deduct",
  waste: (pct, qty) => `waste ${pct}% -> ${qty}`,
  stitched: (n) => `stitched · ${n} sheets`,
  page: (n) => `page ${n}`,
  items: (n) => `${n} item(s)`,
  bySheetBaseNote: null,   // null = the shared BY_SHEET_BASE_NOTE (totals.js), unchanged
  generated: (date) => `Generated ${date}`,
  rfiSchedule: "RFI SCHEDULE",
  rfiCount: (n) => `${n} RFI${plural(n, "", "s")} · linked markups derived from markup.rfi_id`,
  rfiNo: "NO.",
  rfiSubject: "SUBJECT",
  rfiStatus: "STATUS",
  rfiBallInCourt: "BALL IN COURT",
  rfiPriority: (p) => `priority ${p}`,
  rfiCostImpact: "cost impact",
  rfiScheduleImpact: "schedule impact",
  rfiOpened: (d) => `opened ${d}`,
  rfiAnswered: (d) => `answered ${d}`,
  rfiLinked: (n) => `${n} linked markup${plural(n, "", "s")}`,
  rfiNoSubject: "(no subject)",
  rfiQuestion: (q) => `Q: ${q}`,
  rfiAnswer: (a) => `A: ${a}`,
  stampAgent: "AGENT",
  stampApproved: "APPROVED",
  sheetStamp: (label) => `${label} · marked set`,
  sheetStampStitched: (label, members) => `${label} · stitched composite (${members}) · marked set`,
  filename: "marked set",
  // the MCP server's marked set (mcp/src/marked.ts)
  mcpCoverTitle: "OpenTakeoff · Marked Set",
  sheetPageLabel: (sheetNumber, page) => `${sheetNumber} · p${page}`,
  scheduleResolved: (n) => `${n} schedule-resolved`,
  agentAsserted: (n) => `${n} agent-asserted`,
  pendingReview: (n) => `${n} pending human review`,
  withheldUnresolved: (n) => `${n} room${plural(n, "", "s")} withheld, unresolved against the schedule`,
  finishAssignment: (parts) => `Finish assignment: ${parts}`,
  creditShapes: (n) => `${n} shape${plural(n, "", "s")} pending human review`,
  creditRfis: (n) => `${n} agent-raised RFI${plural(n, "", "s")} pending acceptance`,
  floorChecks: (checked, total) => `${checked} of ${total} floor area${plural(total, "", "s")} checked against a printed room area or the drawn walls${checked < total ? `, ${total - checked} unverified` : ""}`,
  credit: (machine, parts) => `${machine ? "Machine-traced" : "Agent-raised"} via OpenTakeoff MCP — ${parts}`,
  // takeoff_rooms cover's clouds (coverClouds.js)
  coverNotMeasured: (rooms) => `Not measured: ${rooms}`,
  coverNoLabel: (area) => `No room label: ${area}`,
};

const nb = {
  numberLocale: "nb-NO",
  dateLocale: "nb-NO",
  areaUnit: { imperial: "SF", metric: "m²" },
  lengthUnit: { imperial: "LF", metric: "m" },
  countUnit: "stk",
  coverTitle: "Oppmerket tegningssett",
  untitledProject: "Prosjekt uten navn",
  preparedFor: (name) => `Utarbeidet for ${name}`,
  reference: (ref) => `Ref. ${ref}`,
  date: (d) => `Dato ${d}`,
  coverMeta: (sheets, items) => `${sheets} ${plural(sheets, "oppmerket tegning", "oppmerkede tegninger")} · ${items} ${plural(items, "mengdepost", "mengdeposter")} · mengder netto etter fradrag, med svinn der det er angitt`,
  approvalStamps: (estimator, agent) => `Godkjenningsstempler: ${estimator} godkjent av kalkulatør · ${agent} merket av agent`,
  marksBy: (parts) => `Merket av: ${parts}`,
  unattributed: "uten navn",
  conditions: "POSTER",
  bySheet: "PER TEGNING",
  wall: "vegg",
  border: "kant",
  deduct: "fradrag",
  waste: (pct, qty) => `svinn ${pct} % -> ${qty}`,
  stitched: (n) => `sammenføyd · ${n} tegninger`,
  page: (n) => `side ${n}`,
  items: (n) => `${n} ${plural(n, "post", "poster")}`,
  bySheetBaseNote: "Radene per tegning viser målte (grunn)mengder; xN-faktorer gjelder per post",
  generated: (date) => `Generert ${date}`,
  rfiSchedule: "RFI-OVERSIKT",
  rfiCount: (n) => `${n} RFI · tilknyttede markeringer hentet fra markup.rfi_id`,
  rfiNo: "NR.",
  rfiSubject: "EMNE",
  rfiStatus: "STATUS",
  rfiBallInCourt: "HOS",
  rfiPriority: (p) => `prioritet ${p}`,
  rfiCostImpact: "kostnadsvirkning",
  rfiScheduleImpact: "fremdriftsvirkning",
  rfiOpened: (d) => `åpnet ${d}`,
  rfiAnswered: (d) => `besvart ${d}`,
  rfiLinked: (n) => `${n} ${plural(n, "tilknyttet markering", "tilknyttede markeringer")}`,
  rfiNoSubject: "(uten emne)",
  rfiQuestion: (q) => `S: ${q}`,
  rfiAnswer: (a) => `Sv: ${a}`,
  stampAgent: "AGENT",
  stampApproved: "GODKJENT",
  sheetStamp: (label) => `${label} · oppmerket sett`,
  sheetStampStitched: (label, members) => `${label} · sammenføyd (${members}) · oppmerket sett`,
  filename: "oppmerket sett",
  mcpCoverTitle: "OpenTakeoff · Oppmerket tegningssett",
  sheetPageLabel: (sheetNumber, page) => `${sheetNumber} · s. ${page}`,
  scheduleResolved: (n) => `${n} fra romskjema`,
  agentAsserted: (n) => `${n} angitt av agent`,
  pendingReview: (n) => `${n} venter på gjennomgang`,
  withheldUnresolved: (n) => `${n} rom holdt tilbake, ikke avklart mot romskjema`,
  finishAssignment: (parts) => `Overflatetildeling: ${parts}`,
  creditShapes: (n) => `${n} ${plural(n, "figur", "figurer")} venter på gjennomgang`,
  creditRfis: (n) => `${n} RFI fra agent venter på godkjenning`,
  floorChecks: (checked, total) => `${checked} av ${total} gulvarealer kontrollert mot påskrevet romareal eller tegnede vegger${checked < total ? `, ${total - checked} ikke kontrollert` : ""}`,
  credit: (machine, parts) => `${machine ? "Maskinsporet" : "Opprettet av agent"} via OpenTakeoff MCP — ${parts}`,
  coverNotMeasured: (rooms) => `Ikke målt: ${rooms}`,
  coverNoLabel: (area) => `Uten romnavn: ${area}`,
};

export const MARKED_SET_LOCALES = { en, nb };

/** The text table for a locale tag ("nb", "nb-NO", "no", "en-US" …); unknown → English. */
export function markedSetText(locale) {
  const tag = String(locale || "en").toLowerCase();
  const base = tag.split(/[-_]/)[0];
  const lang = base === "no" || base === "nn" ? "nb" : base;
  return MARKED_SET_LOCALES[lang] || en;
}

/** A number as this locale writes it, rounded to `d` decimals (−0 normalized to 0). */
export function formatNumber(v, d, text) {
  return (Math.round(v * 10 ** d) / 10 ** d || 0).toLocaleString(text.numberLocale, { maximumFractionDigits: d });
}
