// Reply and error helpers. Every tool reply carries the payload twice, per the
// spec's back-compat rule for tools with an output schema: structuredContent
// (typed, validated against the tool's outputSchema) plus a single content text
// item of the same compact JSON. Failures are { isError: true, ... } — never a
// thrown protocol error, and exempt from the structuredContent requirement.

/** A message meant for the calling agent (bad input, missing scale, …). */
export class UserError extends Error {}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolReply {
  [k: string]: unknown;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const ok = (payload: unknown): ToolReply => ({
  structuredContent: payload as Record<string, unknown>,
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

/** Image tool reply: the PNG plus a JSON meta text item. Image tools declare
 * no outputSchema, so there is no structuredContent — the meta item is the
 * machine-readable half. */
export const okImage = (png: Uint8Array, meta: unknown): ToolReply => ({
  content: [
    { type: "image", data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"), mimeType: "image/png" },
    { type: "text", text: JSON.stringify(meta) },
  ],
});

export const fail = (err: unknown): ToolReply => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
});

/** SF/LF round to 2dp; raw px quantities to 1dp. */
export const round2 = (n: number): number => +n.toFixed(2);
export const round1 = (n: number): number => +n.toFixed(1);

/** A metric ratio scale ("1:100"), as against an architectural or engineering one ("1/4\" = 1'-0\"", "1\" = 20'"). */
export const isRatioScale = (label: string): boolean => /^1:\d+$/.test(label);

/** The unit system the marked set, the report and the export print in (a display
 * conversion — stored quantities stay in feet, exactly as the canvas's metric
 * toggle). OPENTAKEOFF_UNITS: "metric", "imperial", or "auto" (the default) = what
 * the scaled sheets say of themselves (Session.unitsOf: their scale labels, printed
 * areas and dimension strings): metric when every sheet with evidence is metric,
 * imperial when any is imperial, and imperial where no sheet has any evidence. */
export type UnitSystem = "metric" | "imperial" | "unknown";
export function displayUnits(sheetUnits: UnitSystem[] = []): "imperial" | "metric" {
  const pref = process.env.OPENTAKEOFF_UNITS;
  if (pref === "metric" || pref === "imperial") return pref;
  const known = sheetUnits.filter((u) => u !== "unknown");
  return known.length && known.every((u) => u === "metric") ? "metric" : "imperial";
}

/** The marked set's language (OPENTAKEOFF_LOCALE, e.g. "nb"); English by default. */
export function displayLocale(): string {
  return process.env.OPENTAKEOFF_LOCALE || "en";
}
