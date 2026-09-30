// One-Click gate — TEMPORARY. The flood engine (takeoff_rooms) is being
// re-validated against a wider plan corpus, and until that finishes the tool
// is NOT REGISTERED on a default build: an agent that lists tools never sees
// it, so it never tries to call a tool that is not there. The engine code
// stays in web/src/lib (the bench still rules it); only the wire surface is
// withdrawn. OPENTAKEOFF_ONE_CLICK=1 (or the buildServer option) puts it back,
// for the bench, the parity tests and lab use.
//
// This module has no imports on purpose: toolnames.ts, tools.ts, server.ts and
// the scripts all read it, and a cycle here would be the first thing to break.

/** The tools withdrawn while the gate is up. */
export const GATED_TOOLS: readonly string[] = Object.freeze(["takeoff_rooms"]);

/** The environment variable that lifts the gate for one process. */
export const ONE_CLICK_ENV = "OPENTAKEOFF_ONE_CLICK";

/** Whether the gated tools register: an explicit option wins, else the env flag. */
export function oneClickEnabled(explicit?: boolean): boolean {
  return explicit ?? process.env[ONE_CLICK_ENV] === "1";
}

/** Appended to the initialize instructions while the gate is up — the one
 *  place every client reads before its first call. Names the reason, names
 *  the move, and says plainly which tool does not exist on this server. */
export const GATE_NOTE =
  "ONE-CLICK IS TEMPORARILY GATED: takeoff_rooms is NOT registered on this server while the flood engine is re-validated against a wider plan corpus — do not call it, it does not exist here. " +
  'Measure a room with measure {kind: "area"} on the wall faces you read from sheet_context {action: "vectors"} and confirm with view_sheet; counts and derive are unchanged and still read committed floor shapes.';
