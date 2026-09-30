// THE single source of truth for "which tools exist": tools.test, gate.test,
// the dist smoke harness, the tool index and the README counts all read it.
// Registering a tool means adding it here and nowhere else — a test pins the
// runtime tools/list to this list.
import { GATED_TOOLS } from "./gate.ts";

/** Every tool the code can register, sorted. */
export const ALL_TOOL_NAMES: readonly string[] = Object.freeze([
  // task-level tools
  "open_drawings", "set_scale", "sheet_context", "view_sheet", "find_text",
  "takeoff_rooms", "count", "measure", "derive", "schedule", "edit_takeoff",
  "summary", "export",
  // estimator workflow — per-verb until they are consolidated too
  "propose_takeoff", "revise_proposal", "withdraw_proposal", "propose_condition_edit", "withdraw_condition_edit",
  "edit_condition", "edit_materials", "duplicate_condition", "split_condition", "scope_duplicates", "scope_merge",
  "mark_verdict", "delete_verdict",
  "create_rfi", "list_rfis", "resolve_rfi", "delete_rfi",
  "annotate", "edit_annotation", "link_annotation", "list_annotations",
].sort());

/** The surface a DEFAULT build registers: ALL_TOOL_NAMES minus the gated
 * tools while the One-Click gate is up (src/gate.ts). It does not read the
 * environment, so the published count is one number everywhere. */
export const TOOL_NAMES: readonly string[] = Object.freeze(
  ALL_TOOL_NAMES.filter((n) => !GATED_TOOLS.includes(n)),
);

