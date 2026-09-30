// Tool conformance — every tool, both directions (issue #27):
//   valid input   → an ok reply whose structuredContent parses against the
//                   tool's declared output schema (zod, from src/outputs.ts)
//                   and byte-matches the back-compat text item;
//   invalid input → a clean error surface, never a crash and never a poisoned
//                   session: semantic misuse is an isError reply with a JSON
//                   {error} payload; schema-invalid arguments are the SDK's
//                   -32602 input-validation error result.
// Wire-level stdio cleanliness is the dist smoke harness's job (smoke:dist);
// this file covers the tool contract as an in-memory MCP client sees it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import {
  loadPlanOutput, sheetInfoOutput, sheetIndexOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, measureSurfaceOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput, sheetContextOutput,
  findTextOutput, editMaterialsOutput, editConditionOutput, undoLastOutput, editShapeOutput,
  exportReportOutput, exportMarkedPdfOutput, exportDxfOutput, importTakeoffOutput,
  sheetGraphOutput, resolveTagOutput, findScheduleOutput, applyRulesOutput,
  symbolSweepOutput, placeCountOutput, countMarksOutput, sweepScheduleRowOutput, annotateOutput, listAnnotationsOutput,
  cutOutOutput, deriveBaseOutput, deriveTransitionsOutput,
  markVerdictOutput, deleteVerdictOutput, duplicateConditionOutput, splitConditionOutput,
  getSheetVectorsOutput,
  createRfiOutput, listRfisOutput, resolveRfiOutput, deleteRfiOutput,
  proposeTakeoffOutput, reviseProposalOutput, withdrawProposalOutput,
  proposeConditionEditOutput, withdrawConditionEditOutput, listShapesOutput,
  scopeDuplicatesOutput, scopeMergeOutput, editAnnotationOutput, linkAnnotationOutput,
} from "../src/outputs.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const NOT_A_PDF = fileURLToPath(new URL("../package.json", import.meta.url));
const KEY = "sample-plan.pdf";
const UPP = 1 / 36; // 1/4" = 1'-0" at render scale 2.0

// Keyed by tool, or tool:action for the task tools — each action's own shape,
// which the tool's merged outputSchema (perAction) must accept too.
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  "open_drawings:load": z.object(loadPlanOutput),
  "open_drawings:info": z.object(sheetInfoOutput),
  "open_drawings:list": z.object(sheetIndexOutput),
  set_scale: z.object(setScaleOutput),
  "takeoff_rooms:at": z.object(oneClickOutput),
  "takeoff_rooms:detect": z.object(detectRoomsOutput),
  "measure:area": z.object(measurePolygonOutput),
  "measure:length": z.object(measureLineOutput),
  "measure:surface": z.object(measureSurfaceOutput),
  summary: z.object(takeoffSummaryOutput),
  "export:takeoff": z.object(exportTakeoffOutput),
  "export:report": z.object(exportReportOutput),
  "export:marked_pdf": z.object(exportMarkedPdfOutput),
  "export:dxf": z.object(exportDxfOutput),
  "export:import": z.object(importTakeoffOutput),
  "edit_takeoff:list": z.object(listShapesOutput),
  "edit_takeoff:edit": z.object(editShapeOutput),
  "edit_takeoff:delete": z.object(deleteShapeOutput),
  "edit_takeoff:undo": z.object(undoLastOutput),
  "find_text:read": z.object(readSheetTextOutput),
  "find_text:find": z.object(findTextOutput),
  "find_text:resolve_tag": z.object(resolveTagOutput),
  "sheet_context:context": z.object(sheetContextOutput),
  "sheet_context:vectors": z.object(getSheetVectorsOutput),
  "sheet_context:graph": z.object(sheetGraphOutput),
  "schedule:find": z.object(findScheduleOutput),
  "schedule:sweep_row": z.object(sweepScheduleRowOutput),
  "schedule:apply_rules": z.object(applyRulesOutput),
  "count:sweep": z.object(symbolSweepOutput),
  "count:place": z.object(placeCountOutput),
  "count:marks": z.object(countMarksOutput),
  "derive:deduct": z.object(cutOutOutput),
  "derive:base": z.object(deriveBaseOutput),
  "derive:transitions": z.object(deriveTransitionsOutput),
  "conditions:edit": z.object(editConditionOutput),
  "conditions:duplicate": z.object(duplicateConditionOutput),
  "conditions:split": z.object(splitConditionOutput),
  "conditions:materials": z.object(editMaterialsOutput),
  "conditions:scope_duplicates": z.object(scopeDuplicatesOutput),
  "conditions:scope_merge": z.object(scopeMergeOutput),
  "proposal:propose": z.object(proposeTakeoffOutput),
  "proposal:revise": z.object(reviseProposalOutput),
  "proposal:withdraw": z.object(withdrawProposalOutput),
  "proposal:propose_condition_edit": z.object(proposeConditionEditOutput),
  "proposal:withdraw_condition_edit": z.object(withdrawConditionEditOutput),
  "review:mark": z.object(markVerdictOutput),
  "review:delete": z.object(deleteVerdictOutput),
  "rfi:create": z.object(createRfiOutput),
  "rfi:list": z.object(listRfisOutput),
  "rfi:resolve": z.object(resolveRfiOutput),
  "rfi:delete": z.object(deleteRfiOutput),
  "annotate:add": z.object(annotateOutput),
  "annotate:edit": z.object(editAnnotationOutput),
  "annotate:link": z.object(linkAnnotationOutput),
  "annotate:list": z.object(listAnnotationsOutput),
};

/** The SCHEMAS key a call answers under: the task tools add their action. */
function schemaKey(name: string, args: Record<string, unknown>): string {
  if (name === "open_drawings" && args.action === "info" && args.sheet === undefined) return "open_drawings:list";
  if (name === "takeoff_rooms") return `takeoff_rooms:${args.action ?? (args.at !== undefined ? "at" : "detect")}`;
  if (name === "sheet_context") return `sheet_context:${args.action ?? "context"}`;
  const discriminator = args.action ?? args.kind;
  return SCHEMAS[name] ? name : `${name}:${discriminator}`;
}

/** A reply without the discriminator it echoes — what the per-action shape states. */
const bare = (reply: any) => {
  const { action: _a, kind: _k, ...rest } = reply;
  return rest;
};

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), { oneClick: true }).connect(st);
  const client = new Client({ name: "conformance", version: "0.0.0" });
  await client.connect(ct);
  await client.listTools(); // prime the SDK JSON Schema output validators, as real clients do
  return client;
}

/** Valid-input direction: ok reply, structuredContent === parsed text, schema-valid. */
async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length === 1, `${name}: single content item`);
  assert.equal(res.content[0].type, "text");
  const data = JSON.parse(res.content[0].text);
  assert.equal(!!res.isError, false, `${name} unexpectedly failed: ${data.error}`);
  assert.deepEqual(res.structuredContent, data, `${name}: structuredContent mirrors the text item`);
  const key = schemaKey(name, args);
  if (key.includes(":")) assert.equal(data.action ?? data.kind, key === "open_drawings:list" ? "info" : key.split(":")[1], `${key}: the reply names its action`);
  SCHEMAS[key].parse(res.structuredContent);
  return data;
}

/** Semantic-misuse direction: isError with a JSON {error} payload, no structuredContent. */
async function callErr(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.equal(!!res.isError, true, `${name} should have failed`);
  assert.equal(res.structuredContent, undefined, `${name}: error replies carry no structuredContent`);
  const data = JSON.parse(res.content[0].text);
  assert.equal(typeof data.error, "string");
  assert.ok(data.error.length > 0, `${name}: error message present`);
  return data.error;
}

/** Schema-invalid arguments: the SDK's input-validation error result, naming the tool. */
async function callViolation(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.equal(!!res.isError, true, `${name}: schema violation must be an error`);
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /MCP error -32602/, `${name}: -32602 input validation`);
  assert.match(res.content[0].text, new RegExp(`Invalid arguments for tool ${name}`));
}

test("every tool: canonical valid call → schema-valid structuredContent mirroring the text item", async () => {
  const client = await pair();

  const loaded = await callOk(client, "open_drawings", { action: "load", path: PLAN });
  assert.equal(loaded.page_count, 1);
  assert.deepEqual(
    { sheet: loaded.sheets[0].sheet, page: loaded.sheets[0].page, sheet_number: loaded.sheets[0].sheet_number },
    { sheet: KEY, page: 1, sheet_number: "A-101" },
  );

  // sheet_info before the scale: no upp key, scale_set false, linework present
  const infoBefore = await callOk(client, "open_drawings", { action: "info", sheet: KEY });
  assert.equal(infoBefore.scale_set, false);
  assert.equal(infoBefore.upp, undefined);
  assert.ok(infoBefore.seg_count > 0);
  assert.equal(infoBefore.has_vector_linework, true);
  assert.equal(infoBefore.shape_count, 0);

  // title-block addressing resolves to the same sheet (case/space-insensitive)
  const byNumber = await callOk(client, "open_drawings", { action: "info", sheet: "a-101" });
  assert.equal(byNumber.sheet, KEY);

  const scale = await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  assert.equal(scale.source, "detected");
  assert.ok(Math.abs(scale.upp - UPP) < 1e-12);
  // scale gate: set_scale is the agent surface — the scale lands UNCONFIRMED
  // and every downstream surface says so until a human confirms in the canvas
  assert.equal(scale.confirmed, false);

  // measure-only batch detection: every returned room is scaled, nothing commits
  const rooms = await callOk(client, "takeoff_rooms", { action: "detect", sheet: KEY });
  assert.ok(rooms.detected >= 1);
  assert.equal(rooms.rooms.length, rooms.detected);
  assert.equal(rooms.warning, undefined);
  for (const r of rooms.rooms) {
    assert.ok(r.label.length > 0);
    assert.ok(r.area_sf > 0 && r.perimeter_lf > 0);
    assert.equal(r.shape_id, undefined, "no condition passed — nothing committed");
  }

  const clicked = await callOk(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600, 1084], condition: "CPT-1", return_verts: true });
  assert.ok(clicked.area_sf > 50);
  assert.ok(clicked.perimeter_lf > 0);
  assert.ok(Array.isArray(clicked.verts) && clicked.verts.length === clicked.nverts);
  assert.ok(clicked.shape_id);

  // a 360-px (10-ft) square at 1/4" scale: exactly 100 SF, 40 LF
  const poly = await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "VCT-1" });
  assert.deepEqual({ area_sf: poly.area_sf, perimeter_lf: poly.perimeter_lf, nverts: poly.nverts }, { area_sf: 100, perimeter_lf: 40, nverts: 4 });
  assert.ok(poly.shape_id);

  // two 360-px legs: exactly 20 LF
  const line = await callOk(client, "measure", { kind: "length", sheet: KEY, points: [[0, 0], [360, 0], [360, 360]], condition: "RB-1" });
  assert.deepEqual({ length_lf: line.length_lf, npts: line.npts }, { length_lf: 20, npts: 3 });
  assert.ok(line.shape_id);

  const summary = await callOk(client, "summary");
  assert.equal(summary.conditions.length, 3);
  assert.deepEqual(summary.scale_unconfirmed, [KEY], "totals name the sheets standing on an unconfirmed agent-set scale");
  const byTag = Object.fromEntries(summary.conditions.map((r: any) => [r.finish_tag, r]));
  assert.equal(byTag["VCT-1"].floor_sf, 100);
  assert.equal(byTag["RB-1"].lf, 20);
  const rowSum = summary.conditions.reduce((a: number, r: any) => a + r.total_sf, 0);
  assert.ok(Math.abs(summary.totals.total_sf - rowSum) < 0.01, "grand total is the sum of the rows");

  const exported = await callOk(client, "export", { action: "takeoff" });
  assert.equal(exported.schema, "opentakeoff.takeoff_canvas.v1");
  // scale gate: provenance rides the payload — scale_source for the report,
  // scale_confirmed:false so the canvas asks the estimator to confirm on import
  assert.deepEqual(exported.sheets, [{ sheet_id: KEY, units_per_px: UPP, scale_source: "detected", scale_label: `1/4" = 1'-0"`, scale_confirmed: false }]);
  assert.equal(exported.conditions.length, 3);
  assert.equal(exported.shapes.length, 3);
  assert.deepEqual(exported.shapes.map((s: any) => s.measure_role), ["floor_area", "floor_area", "linear"]);
  for (const s of exported.shapes) {
    assert.ok(s.verts_norm.every(([nx, ny]: [number, number]) => nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1), "verts_norm in [0,1]");
    assert.equal(s.origin.actor, "agent", "everything this server commits is agent-actored");
  }
  const ocShape = exported.shapes.find((s: any) => s.id === clicked.shape_id);
  assert.equal(ocShape.origin.method, "one_click_v1");
  assert.equal(ocShape.origin.reviewed, false, "no human review gate exists here");
  assert.ok(Array.isArray(ocShape.origin.seed_norm));
  assert.equal(exported.shapes.find((s: any) => s.id === poly.shape_id).origin.method, "manual");

  const text = await callOk(client, "find_text", { action: "read", sheet: KEY });
  assert.ok(text.items.length >= 4);
  assert.ok(text.text.includes("OFFICE 101"));
  for (const it of text.items) assert.ok(Number.isFinite(it.x) && Number.isFinite(it.y));

  // region restriction: exactly the one label inside the window; an empty window is empty
  const region = await callOk(client, "find_text", { action: "read", sheet: KEY, region: { x0: 500, y0: 1000, x1: 700, y1: 1200 } });
  assert.deepEqual(region.items, [{ str: "OFFICE 101", x: 600, y: 1084 }]);
  assert.equal(region.text, "OFFICE 101");
  const empty = await callOk(client, "find_text", { action: "read", sheet: KEY, region: { x0: 0, y0: 0, x1: 10, y1: 10 } });
  assert.deepEqual({ items: empty.items, text: empty.text }, { items: [], text: "" });

  // get_sheet_vectors (#367): the raw layer, whole — the demo plan's six segments in one page
  const vec = await callOk(client, "sheet_context", { action: "vectors", sheet: KEY });
  assert.equal(vec.total, infoBefore.seg_count);
  assert.deepEqual({ returned: vec.returned, offset: vec.offset, dropped: vec.dropped }, { returned: vec.total, offset: 0, dropped: 0 });
  assert.equal(vec.points.length, vec.total * 4);

  // "101" substring-matches both the room label and the sheet number ("A-101")
  const found = await callOk(client, "find_text", { action: "find", sheet: KEY, query: "101" });
  assert.equal(found.count, 2);
  assert.deepEqual(found.hits.map((h: any) => h.str).sort(), ["A-101", "OFFICE 101"]);
  const foundRegion = await callOk(client, "find_text", { action: "find", sheet: KEY, query: "office", region: { x0: 500, y0: 1000, x1: 700, y1: 1200 } });
  assert.deepEqual(foundRegion.hits.map((h: any) => h.str), ["OFFICE 101"]);

  const materials = await callOk(client, "conditions", { action: "materials", condition: "CPT-1", add: [
    { name: "Adhesive", per: 250, basis: "area", unit: "gal" },
  ] });
  assert.equal(materials.materials.length, 1);
  assert.equal(materials.materials[0].round, true);
  const matched = await callOk(client, "conditions", { action: "materials", condition: "CPT-1",
    patch: [{ id: materials.materials[0].id, fields: { per: 300 } }] });
  assert.equal(matched.materials[0].per, 300);

  // edit_condition: the waste/multiplier knobs actually move takeoff_summary's
  // nets (#131 — before this tool, an agent takeoff always shipped net === gross)
  const preRow = (await callOk(client, "summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.deepEqual({ w: preRow.waste_pct, m: preRow.multiplier }, { w: 0, m: 1 }, "minted conditions start net === gross");
  const knobs = await callOk(client, "conditions", { action: "edit", condition: "CPT-1", waste_pct: 10, multiplier: 2 });
  assert.deepEqual({ w: knobs.waste_pct, m: knobs.multiplier }, { w: 10, m: 2 });
  const postRow = (await callOk(client, "summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.ok(Math.abs(postRow.total_sf - preRow.total_sf * 2) < 0.05, "multiplier scales gross");
  assert.ok(Math.abs(postRow.total_sf_net - postRow.total_sf * 1.1) < 0.05, "waste lifts net over gross");
  assert.match(await callErr(client, "conditions", { action: "edit", condition: "NOPE-9", waste_pct: 5 }),
    /No condition "NOPE-9"\. Known tags: /);        // resolve-or-error — a typo must not mint
  assert.match(await callErr(client, "conditions", { action: "edit", condition: "CPT-1" }), /Nothing to change/);
  const undone = await callOk(client, "edit_takeoff", { action: "undo", n: 1 });
  assert.equal(undone.steps[0].op, "condition");
  const revRow = (await callOk(client, "summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.deepEqual({ w: revRow.waste_pct, m: revRow.multiplier }, { w: 0, m: 1 }, "undo restores both knobs verbatim");

  // condition twins (#205): mint → follow → split → exact inverses, then the
  // session goes back to pre-twins state so the later tests see what they expect
  const twin = await callOk(client, "conditions", { action: "duplicate", condition: "CPT-1", label: "Level 2" });
  assert.equal(twin.condition, "CPT-1 – Level 2");
  assert.equal(twin.inherited_rows, 1, "the adhesive row arrived following");
  assert.match(await callErr(client, "conditions", { action: "duplicate", condition: "CPT-1", label: "level 2" }),
    /already called/);                              // collision is case-insensitive, refused not de-collided
  const familyEdit = await callOk(client, "conditions", { action: "materials", condition: "CPT-1",
    patch: [{ id: materials.materials[0].id, fields: { per: 275 } }] });
  assert.equal(familyEdit.materials[0].per, 275);
  const cut = await callOk(client, "conditions", { action: "split", condition: "CPT-1 – Level 2" });
  assert.deepEqual({ s: cut.split, f: cut.frozen_rows }, { s: true, f: 1 });
  const twinUndo = await callOk(client, "edit_takeoff", { action: "undo", n: 3 });   // split, family edit, mint
  assert.deepEqual(twinUndo.steps.map((s: any) => s.op), ["split_condition", "materials", "duplicate_condition"],
    "the journal names the twin ops and the SDK's output validation accepts them");
  const postTwins = await callOk(client, "summary");
  assert.equal(postTwins.conditions.some((r: any) => r.finish_tag === "CPT-1 – Level 2"), false, "the twin is gone whole");

  // export_report: the canvas Report document over MCP (#130) — computed buy
  // list included, math parity with the app's totals.js
  await callOk(client, "conditions", { action: "edit", condition: "CPT-1", waste_pct: 5 });
  const report = await callOk(client, "export", { action: "report" });
  assert.equal(report.schema, "opentakeoff.report.v1");
  const rRow = report.conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.ok(rRow.shape_count > 0, "report rows are shape-bearing conditions only");
  assert.ok(Math.abs(rRow.total_sf_net - rRow.total_sf * 1.05) < 0.05, "net carries the waste knob");
  assert.equal(rRow.materials.length, 1, "the buy list rides the row — the thing summary strips and the canvas payload never computes");
  const mLine = rRow.materials[0];
  assert.equal(mLine.per, 300);
  assert.equal(mLine.qty, Math.ceil(mLine.basis_qty / 300 - 1e-9), "order qty = basis ÷ coverage, rounded up to whole purchase units");
  assert.deepEqual(report.materials, [{ name: "Adhesive", unit: "gal", qty: mLine.qty }], "project-wide roll-up sums by (name, unit)");
  assert.ok(["standard", "upp", "calibrated", "detected"].includes(report.sheets[0].scale_source), "scale provenance rides the report");
  assert.equal(report.sheets[0].scale_confirmed, false, "an MCP-set scale reports UNCONFIRMED until a human confirms it in the canvas");
  assert.ok(report.totals.total_sf_net > report.totals.total_sf, "grand totals carry waste");
  assert.equal(report.project_name, null, "a headless session has no project of its own — null, never ''");
  assert.deepEqual(report.roll_goods, [], "roll_goods (#136) always emitted — empty until a condition carries a roll_setup");
  const labeled = await callOk(client, "export", { action: "report", project_name: "Summit Phase 2" });
  assert.equal(labeled.project_name, "Summit Phase 2", "a consumer can label the document it prices from");
  await callOk(client, "conditions", { action: "edit", condition: "CPT-1", waste_pct: 0 });   // leave the session as the later tests expect

  const del = await callOk(client, "edit_takeoff", { action: "delete", shape_id: clicked.shape_id });
  assert.deepEqual(del, { action: "delete", deleted: clicked.shape_id, shape_count: 2 });

  // proposals (#365) over the wire: every verb's reply validates against its
  // schema, the summary and the report carry the ledger beside the current
  // values, and every new journal op survives undo_last's output enum
  const prop = await callOk(client, "proposal", { action: "propose", label: "Level 1 rooms", rationale: "finish schedule row CPT-1" });
  const batched = await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[800, 800], [1160, 800], [1160, 1160], [800, 1160]], condition: "CPT-1" });
  const revised = await callOk(client, "proposal", { action: "revise", proposal_id: prop.proposal_id, shapes: [
    { sheet: KEY, condition: "CPT-1", role: "floor_area", points: [[800, 800], [1520, 800], [1520, 1160], [800, 1160]], label: "OFFICE 101" },
    { sheet: KEY, condition: "TH-1", role: "count", points: [[810, 810]] },
  ] });
  assert.deepEqual([revised.replaced, revised.committed], [1, 2]);
  assert.equal((await callOk(client, "edit_takeoff", { action: "list" })).shapes.some((x: any) => x.id === batched.shape_id), false);
  const withLedger = await callOk(client, "summary");
  assert.deepEqual(withLedger.proposals.map((r: any) => [r.label, r.pending, r.accepted, r.current]), [["Level 1 rooms", 2, 0, true]]);
  const cedit = await callOk(client, "proposal", { action: "propose_condition_edit", condition: "CPT-1", waste_pct: 10, rationale: "spec 09 68 13" });
  assert.deepEqual(cedit.proposed, { waste_pct: 10 });
  const reportPending = await callOk(client, "export", { action: "report" });
  assert.equal(reportPending.conditions.find((r: any) => r.finish_tag === "CPT-1").waste_pct, 0, "the report prints the current knob");
  assert.deepEqual(reportPending.proposed_condition_edits.map((r: any) => [r.condition, r.proposed.waste_pct]), [["CPT-1", 10]], "with the diff beside it");
  await callOk(client, "proposal", { action: "withdraw_condition_edit", proposal_id: cedit.proposal_id });
  const withdrawn = await callOk(client, "proposal", { action: "withdraw", proposal_id: prop.proposal_id });
  assert.deepEqual([withdrawn.withdrawn, withdrawn.accepted_kept], [2, 0]);
  await callErr(client, "proposal", { action: "revise", proposal_id: prop.proposal_id, shapes: [{ sheet: KEY, condition: "CPT-1", role: "floor_area", points: [[0, 0], [10, 0], [10, 10]] }] });
  const propUndo = await callOk(client, "edit_takeoff", { action: "undo", n: 6 });
  assert.deepEqual(propUndo.steps.map((x: any) => x.op), ["proposal_withdraw", "condition_proposal_withdraw", "condition_proposal", "proposal_revise", "commit", "proposal_open"], "every proposal op validates on the wire");
  assert.equal((await callOk(client, "open_drawings", { action: "info", sheet: KEY })).shape_count, 2, "the session is exactly as it was before the proposal");
  assert.equal((await callOk(client, "summary")).proposals, undefined);

  // scope collision (#366) over the wire: the shipped takeoff on the bundled
  // plan reads 0 shared floor; a deliberate collision is caught, merged with
  // the winner stated, and the merge is one undo step
  const clean = await callOk(client, "conditions", { action: "scope_duplicates" });
  assert.deepEqual([clean.collisions, clean.duplicates, clean.shared_floor_sf, clean.unmeasured], [[], [], 0, []], "the bundled sample plan's takeoff shares no floor");
  assert.equal((await callOk(client, "summary")).shared_floor_sf, 0);
  const collide = await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "LVT-9" });
  const dup = await callOk(client, "conditions", { action: "scope_duplicates", sheet: KEY });
  assert.equal(dup.collisions.length, 1);
  assert.deepEqual([dup.collisions[0].a.condition, dup.collisions[0].b.condition, dup.collisions[0].fraction_of_smaller], ["VCT-1", "LVT-9", 1]);
  assert.equal(dup.shared_floor_sf, dup.collisions[0].shared_sf);
  assert.equal((await callOk(client, "summary")).shared_floor_sf, dup.shared_floor_sf);
  await callErr(client, "conditions", { action: "scope_merge", shape_a: poly.shape_id, shape_b: collide.shape_id });   // neither reviewed, no winner stated
  const merged = await callOk(client, "conditions", { action: "scope_merge", shape_a: poly.shape_id, shape_b: collide.shape_id, winner: poly.shape_id });
  assert.deepEqual([merged.outcome, merged.loser, merged.shape_count], ["deleted", collide.shape_id, 2]);
  assert.equal((await callOk(client, "summary")).shared_floor_sf, 0);
  const mergeUndo = await callOk(client, "edit_takeoff", { action: "undo", n: 2 });
  assert.deepEqual(mergeUndo.steps.map((x: any) => x.op), ["delete", "commit"]);
  assert.equal((await callOk(client, "open_drawings", { action: "info", sheet: KEY })).shape_count, 2);

  const infoAfter = await callOk(client, "open_drawings", { action: "info", sheet: KEY });
  assert.equal(infoAfter.scale_set, true);
  assert.ok(Math.abs(infoAfter.upp - UPP) < 1e-12);
  assert.equal(infoAfter.shape_count, 2);
});

test("view_sheet: image + meta reply, grid math pinned, overlay drawn, misuse clean", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });

  // the image tool's reply shape: PNG content item first, JSON meta second
  const callImage = async (args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name: "view_sheet", arguments: args });
    assert.equal(!!res.isError, false, `view_sheet failed: ${res.content?.[0]?.text}`);
    assert.equal(res.content.length, 2, "image item + meta text item");
    assert.equal(res.content[0].type, "image");
    assert.equal(res.content[0].mimeType, "image/png");
    assert.equal(res.structuredContent, undefined, "no outputSchema → no structuredContent");
    const png = Buffer.from(res.content[0].data, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(res.content[1].type, "text");
    return { png, meta: JSON.parse(res.content[1].text) };
  };

  // before the scale: grid "auto" refuses toward set_scale, the drawing scale works
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, grid: "auto" }), /set_scale/);
  const gridded = await callImage({ sheet: KEY, px: 400, grid: "1/4" });
  assert.equal(gridded.meta.grid_px_per_foot, 36, "1/4\" = 1'-0\" → 36 image px per foot");
  assert.equal(Math.max(...gridded.meta.img_px), 400, "long edge honors the px budget");
  assert.equal(gridded.meta.page, 1);
  assert.equal(gridded.meta.overlay, false);

  // after set_scale, auto derives the same grid the drawing scale gave
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const auto = await callImage({ sheet: KEY, px: 400, grid: "auto" });
  assert.ok(Math.abs(auto.meta.grid_px_per_foot - 36) < 1e-6, "auto agrees with the detected 1/4\" scale");

  // a crop honors the region and maps back: square region → square image
  const crop = await callImage({ sheet: KEY, region: { x0: 100, y0: 100, x1: 460, y1: 460 }, px: 300 });
  assert.deepEqual(crop.meta.region, [100, 100, 460, 460]);
  assert.deepEqual(crop.meta.img_px, [300, 300]);
  assert.ok(Math.abs(crop.meta.zoom - 300 / 360) < 1e-3, "zoom = canvas px per image px");

  // overlay burns committed shapes in: same render differs byte-for-byte
  const clicked = await callOk(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600, 1084], condition: "CPT-1" });
  assert.ok(clicked.shape_id);
  const bare = await callImage({ sheet: KEY, px: 400 });
  const overlaid = await callImage({ sheet: KEY, px: 400, overlay: true });
  assert.equal(overlaid.meta.overlay, true);
  assert.equal(overlaid.meta.shapes_drawn, 1);
  assert.ok(!bare.png.equals(overlaid.png), "the overlay visibly changes the render");

  // misuse: degenerate region and junk grid are clean isError replies
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, region: { x0: 400, y0: 100, x1: 100, y1: 460 } }), /Empty view region/);
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, grid: "banana" }), /inches-per-foot/);
});

test("before any plan: sheet tools and export refuse cleanly; summary is a valid empty reply", async () => {
  const client = await pair();
  const gate = /No plan loaded — call open_drawings \{action: "load"\} first\./;
  assert.match(await callErr(client, "open_drawings", { action: "info", sheet: KEY }), gate);
  assert.match(await callErr(client, "view_sheet", { sheet: KEY }), gate);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, use_detected: true }), gate);
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [1, 1] }), gate);
  assert.match(await callErr(client, "takeoff_rooms", { action: "detect", sheet: KEY }), gate);
  assert.match(await callErr(client, "measure", { kind: "area", sheet: KEY, points: [[0, 0], [1, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "measure", { kind: "length", sheet: KEY, points: [[0, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "find_text", { action: "read", sheet: KEY }), gate);
  assert.match(await callErr(client, "export", { action: "takeoff" }), gate);
  assert.match(await callErr(client, "export", { action: "report" }), gate);
  assert.match(await callErr(client, "edit_takeoff", { action: "delete", shape_id: "shp-nope" }), /No shape with id "shp-nope"\./);

  const summary = await callOk(client, "summary");
  assert.deepEqual(summary.conditions, []);
  assert.equal(summary.totals.total_sf, 0);
});

test("unknown sheet: every sheet-addressed tool names the miss and lists what is loaded", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  const miss = /Unknown sheet "no-such-sheet" — loaded sheets: sample-plan\.pdf\./;
  assert.match(await callErr(client, "open_drawings", { action: "info", sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "set_scale", { sheet: "no-such-sheet", use_detected: true }), miss);
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: "no-such-sheet", at: [1, 1] }), miss);
  assert.match(await callErr(client, "takeoff_rooms", { action: "detect", sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "measure", { kind: "area", sheet: "no-such-sheet", points: [[0, 0], [1, 0], [1, 1]] }), miss);
  assert.match(await callErr(client, "measure", { kind: "length", sheet: "no-such-sheet", points: [[0, 0], [1, 1]] }), miss);
  assert.match(await callErr(client, "find_text", { action: "read", sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "view_sheet", { sheet: "no-such-sheet" }), miss);
});

test("schema-invalid arguments: -32602 validation error naming the tool; the session survives", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });

  // a field one ACTION needs is not schema-required on the flat tool: the handler
  // refuses it cleanly, naming the tool, the action and the field
  assert.match(await callErr(client, "open_drawings", { action: "load" }), /open_drawings load needs path/);
  assert.match(await callErr(client, "measure", { kind: "area", sheet: KEY, points: [[0, 0], [1, 1]] }), /measure area needs at least 3 points/);
  assert.match(await callErr(client, "edit_takeoff", { action: "delete" }), /edit_takeoff delete needs shape_id/);
  assert.match(await callErr(client, "find_text", { action: "find", sheet: KEY }), /find_text find needs query/);
  assert.match(await callErr(client, "count", { action: "sweep", sheet: KEY }), /count sweep needs seed_rect/);
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: KEY }), /takeoff_rooms at needs at/);
  assert.match(await callErr(client, "schedule", { action: "sweep_row" }), /schedule sweep_row needs tag/);
  assert.match(await callErr(client, "conditions", { action: "duplicate", condition: "CPT-1" }), /conditions duplicate needs label/);
  assert.match(await callErr(client, "conditions", { action: "scope_merge", shape_a: "shp-1" }), /conditions scope_merge needs shape_b/);
  assert.match(await callErr(client, "proposal", { action: "propose", label: "L1" }), /proposal propose needs rationale/);
  assert.match(await callErr(client, "annotate", { action: "add", sheet: KEY }), /annotate add needs type/);
  assert.match(await callErr(client, "annotate", { action: "link", annotation_id: "mk-1" }), /annotate link needs condition/);
  // info without a sheet is the sheet list, not a miss
  assert.equal((await callOk(client, "open_drawings", { action: "info" })).sheets.length, 1);
  await callViolation(client, "set_scale", { sheet: KEY, upp: "half" });                   // wrong type
  await callViolation(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600] });                    // half a point
  await callViolation(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600, 1084], role: "wall" }); // bad enum
  await callViolation(client, "takeoff_rooms", { action: "detect", sheet: KEY, role: "wall" });               // bad enum
  await callViolation(client, "measure", { kind: "length", sheet: KEY, points: [[0, 0]] });              // min 2 pts
  await callViolation(client, "find_text", { action: "read", sheet: KEY, region: { x0: 0, y0: 0, x1: 10 } }); // partial region
  await callViolation(client, "export", { action: "takeoff", path: 42 });                             // path not a string
  await callViolation(client, "sheet_context", { action: "vectors", sheet: KEY, limit: 0 });               // limit below min 1
  await callViolation(client, "sheet_context", { action: "vectors", sheet: KEY, cursor: -1 });             // cursor below 0
  await callViolation(client, "sheet_context", { action: "vectors", sheet: KEY, region: { x0: 0, y0: 0, x1: 10 } }); // partial region
  await callViolation(client, "view_sheet", { sheet: KEY, px: 50 });                       // px below the 200 floor
  await callViolation(client, "view_sheet", { sheet: KEY, region: { x0: 0, y0: 0, x1: 10 } }); // partial region
  await callViolation(client, "find_text", { action: "find", sheet: KEY, query: "101", limit: 0 });            // limit below min 1
  await callViolation(client, "count", { action: "sweep", sheet: KEY, seed_rect: [[0, 0]] });        // one corner is not a rect
  await callViolation(client, "count", { action: "sweep", sheet: KEY, seed_rect: [[0, 0], [50, 50]], tolerance_px: 0 }); // tolerance must be positive
  await callViolation(client, "count", { action: "sweep", sheet: KEY, seed_rect: [[0, 0], [50, 50]], scope: "document" }); // bad scope enum
  await callViolation(client, "schedule", { action: "sweep_row", tag: "" });                          // empty tag fails the min-1 gate
  await callViolation(client, "annotate", { action: "add", sheet: KEY, type: "measure" });                // bad type enum
  await callViolation(client, "conditions", { action: "materials", condition: "CPT-1", add: [{ per: 250 }] }); // add row missing name
  await callViolation(client, "conditions", { action: "edit", condition: "CPT-1", waste_pct: -5 });    // negative waste
  await callViolation(client, "conditions", { action: "edit", condition: "CPT-1", multiplier: 0 });    // 0 silently means 1 on the canvas — rejected
  await callViolation(client, "conditions", { action: "edit", condition: "CPT-1", waste_pct: "ten" }); // wrong type

  // none of that touched the session — a real call still works on the same pair
  const r = await callOk(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600, 1084] });
  assert.ok(r.area_sf > 50);
});

test("set_scale semantics: calibrate and upp modes, valid and degenerate", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });

  // 360 px spanning 10 real feet is exactly the detected 1/4" scale
  const cal = await callOk(client, "set_scale", { sheet: KEY, calibrate: { p1: [0, 0], p2: [360, 0], feet: 10 } });
  assert.equal(cal.source, "calibrate");
  assert.equal(cal.label, undefined);
  assert.ok(Math.abs(cal.upp - UPP) < 1e-12);

  const direct = await callOk(client, "set_scale", { sheet: KEY, upp: 0.5 });
  assert.deepEqual({ source: direct.source, upp: direct.upp }, { source: "upp", upp: 0.5 });

  assert.match(await callErr(client, "set_scale", { sheet: KEY, calibrate: { p1: [50, 50], p2: [50, 50], feet: 10 } }), /identical/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, calibrate: { p1: [0, 0], p2: [360, 0], feet: -5 } }), /feet must be positive/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, upp: 0 }), /upp must be a positive number/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, label: "" }), /Unknown scale label/);
});

test("one_click misuse and a bad document: clean errors, and a failed load leaves an empty session", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });

  // a click in the sheet margin is not an enclosed space
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [5, 5] }), /isn't enclosed on the plan linework/);

  // loading a non-PDF fails cleanly — and load_plan's replace semantics mean
  // the previous document is gone, not half-kept
  await callErr(client, "open_drawings", { action: "load", path: NOT_A_PDF });
  assert.match(await callErr(client, "open_drawings", { action: "info", sheet: KEY }), /No plan loaded/);

  // and the session recovers on the next good load
  const again = await callOk(client, "open_drawings", { action: "load", path: PLAN });
  assert.equal(again.page_count, 1);
});

test("export_takeoff: an unwritable path is isError and does not corrupt the inline export", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  // a parent directory that does not exist, valid on every platform
  const unwritable = path.join(tmpdir(), "opentakeoff-conformance-no-such-dir", "deep", "out.json");
  await callErr(client, "export", { action: "takeoff", path: unwritable });
  const exported = await callOk(client, "export", { action: "takeoff" });
  assert.equal(exported.schema, "opentakeoff.takeoff_canvas.v1");
});

test("deduct role: committed deducts subtract in the summary and export as measure_role deduct", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });

  // 100 SF floor minus a 25 SF (180-px / 5-ft square) deduct under the same tag
  await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "CPT-1" });
  const ded = await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[150, 150], [330, 150], [330, 330], [150, 330]], condition: "CPT-1", role: "deduct" });
  assert.equal(ded.area_sf, 25);

  const summary = await callOk(client, "summary");
  assert.equal(summary.conditions.length, 1);
  assert.equal(summary.conditions[0].floor_sf, 75);

  const exported = await callOk(client, "export", { action: "takeoff" });
  assert.deepEqual(exported.shapes.map((s: any) => s.measure_role), ["floor_area", "deduct"]);
});

// ── PDF layers (#85): the layered fixture drives the whole loop ─────────────
// test/fixtures/layered-plan.pdf (see scripts/make-layered-fixture.mjs): a
// 300×300 pt room on A-WALL-FULL, a 3×3 tile grid on A-FLOR-PATT (FOUR lines
// — far below HATCH_MIN_RUN, so pitch heuristics keep them hard and a naive
// flood traps in one cell), a leader on A-ANNO-TEXT crossing the room, and a
// demolition wall on A-WALL-DEMO hidden in the default config.
const LAYERED = fileURLToPath(new URL("./fixtures/layered-plan.pdf", import.meta.url));

test("layers (#85): the table reads, stated roles feed the mask, include/exclude bite, unlayered refuses", async () => {
  const client = await pair();
  const LKEY = "layered-plan.pdf";
  const loaded = await callOk(client, "open_drawings", { action: "load", path: LAYERED });
  assert.equal(loaded.page_count, 1);

  const info = await callOk(client, "open_drawings", { action: "info", sheet: LKEY });
  const byName = Object.fromEntries(info.layers.map((l: any) => [l.name, l]));
  assert.deepEqual(Object.keys(byName).sort(), ["A-ANNO-TEXT", "A-FLOR-PATT", "A-WALL-DEMO", "A-WALL-FULL"]);
  assert.equal(byName["A-WALL-FULL"].role, "boundary");
  assert.equal(byName["A-FLOR-PATT"].role, "finish-pattern");
  assert.equal(byName["A-ANNO-TEXT"].role, "annotation");
  assert.deepEqual({ role: byName["A-WALL-DEMO"].role, visible: byName["A-WALL-DEMO"].visible },
    { role: "demolition", visible: false }, "hidden demolition arrives stated, not guessed");
  assert.ok(info.layers.every((l: any) => l.seg_count > 0 && l.confidence > 0.5), "every layer owns ink and classifies confidently");

  await callOk(client, "set_scale", { sheet: LKEY, upp: 1 / 24 });
  // seed (300, 924) image px = pdf (150, 150) — inside ONE tile cell. The
  // stated layers exclude the grid (pattern), the leader (annotation), and
  // the hidden demo wall, so the flood reaches the whole 25×25 ft room.
  const room = await callOk(client, "takeoff_rooms", { action: "at", sheet: LKEY, at: [300, 924], condition: "CPT-1" });
  assert.ok(Math.abs(room.area_sf - 625) < 20, `whole room, not a tile cell: ${room.area_sf} SF`);

  // provenance: a trace bounded by DECLARED layers says so on the wire
  const payload = await callOk(client, "export", { action: "takeoff" });
  assert.equal(payload.shapes[0].origin.layer_bounded, true);

  // include: the hidden demolition wall becomes hard boundary — the room halves
  const half = await callOk(client, "takeoff_rooms", { action: "at", sheet: LKEY, at: [300, 924], layers: { include: ["A-WALL-DEMO"] } });
  assert.ok(Math.abs(half.area_sf - 312.5) < 15, `the included demo wall splits the room: ${half.area_sf} SF`);

  // exclude the boundary itself → nothing encloses (never a silent guess)
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: LKEY, at: [300, 924], layers: { exclude: ["A-WALL-FULL"] } }), /isn't enclosed/);
  // unknown layer name → resolve-or-error, listing the sheet's actual layers
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: LKEY, at: [300, 924], layers: { exclude: ["NOPE"] } }), /No layer "NOPE".*A-WALL-FULL/);

  // the unlayered world stays exactly as it was: empty table, and a layer
  // filter REFUSES rather than silently no-ops
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  const plain = await callOk(client, "open_drawings", { action: "info", sheet: KEY });
  assert.deepEqual(plain.layers, []);
  assert.match(await callErr(client, "takeoff_rooms", { action: "at", sheet: KEY, at: [600, 1084], layers: { exclude: ["A-WALL-FULL"] } }), /no PDF layers/);
});

// ── the sheet graph (#87): the two-page demo set drives all three tools ─────
const FINISH_PLAN = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

test("sheet graph (#87): index, resolve with citations, refusal with reasons, find_schedule", async () => {
  const client = await pair();
  // the graph needs a document
  assert.match(await callErr(client, "sheet_context", { action: "graph" }), /No plan loaded/);

  await callOk(client, "open_drawings", { action: "load", path: FINISH_PLAN });
  const g = await callOk(client, "sheet_context", { action: "graph" });
  assert.equal(g.available, true);
  const roles = Object.fromEntries(g.sheets.map((s: any) => [s.sheet, s.role]));
  assert.equal(roles["sample-finish-plan.pdf"], "plan", "page 1 is the finish plan");
  assert.equal(roles["sample-finish-plan.pdf#2"], "schedule", "page 2 is the schedule sheet — its room-number column must NOT mint phantom rooms");
  // `rooms` now means numbers CORROBORATED as rooms; everything else the tag
  // reader found is surfaced in unmatched_tags with a reason. Between them
  // every numbered tag on the plan is still accounted for — nothing dropped.
  assert.ok(g.counts.rooms + (g.counts.unmatched_tags ?? 0) >= 40, `tags accounted for: ${g.counts.rooms} rooms + ${g.counts.unmatched_tags} unmatched`);
  assert.ok(g.rooms.every((r: any) => r.corroboration), "every room states WHY it is believed to be one");
  assert.ok((g.unmatched_tags ?? []).every((u: any) => u.reason && u.bbox), "every uncounted tag names its reason and cites its ink");
  assert.ok(g.counts.schedules >= 2, "a room-finish table AND a finish/material table");
  assert.ok(g.rooms.every((r: any) => r.sheet === "sample-finish-plan.pdf"), "rooms come from the plan sheet only");
  const r134 = g.rooms.find((r: any) => r.tag === "134");
  assert.ok(r134 && r134.bbox.x1 > r134.bbox.x0, "a tag carries its bbox");

  // THE question: what finish is specified in room 134, and how do you know
  const res = await callOk(client, "find_text", { action: "resolve_tag", tag: "134" });
  assert.equal(res.status, "resolved");
  const bySurface = Object.fromEntries(res.finishes.map((f: any) => [f.surface, f]));
  assert.equal(bySurface.FLOOR.code, "CPT-1/VCT-1", "the dual-finish floor cell survives verbatim");
  assert.equal(bySurface.BASE.code, "RB-1");
  assert.equal(bySurface.BASE.definition.cells.MATERIAL, "RESILIENT BASE", "the code chains to its material-schedule definition");
  for (const f of res.finishes) {
    assert.ok(f.source.sheet && f.source.bbox.x1 > f.source.bbox.x0, `${f.surface} carries a citation`);
  }
  assert.ok(res.sources.length >= 2, "the chain cites the plan tag AND the schedule row");

  // refusal over guessing: a tag with no row names the gap, never omits it
  const missing = await callOk(client, "find_text", { action: "resolve_tag", tag: "999" });
  assert.equal(missing.status, "unresolved");
  assert.match(missing.reason, /no schedule row for 999/);

  const found = await callOk(client, "schedule", { action: "find", schedule_kind: "room finish" });
  // 29, verified against the sheet: the key column carries exactly 29 room
  // numbers. The old floor of 30 was counting rows the extractor invented.
  assert.equal(found.matches[0].rows, 29, "every row of the schedule, and none that is not one");
  assert.match(found.matches[0].title, /ROOM FINISH SCHEDULE/);
  assert.ok(found.matches[0].region.x1 > found.matches[0].region.x0, "the region is viewable");
  assert.match(await callErr(client, "schedule", { action: "find", schedule_kind: "door" }), /No "door" schedule found .* Found: /);
});

// ── the sheet graph, phase 2 (#87): continuation sheets, rotated headers, ───
// multi-building keys — the five-page fixture pins all three lanes end to end
// (generator: scripts/make-sheetgraph-fixture.mjs). Room 134 exists in BOTH
// buildings; building A's schedule is only readable through its rotated
// header band; building B's schedule continues onto page 5.
const MB_SET = fileURLToPath(new URL("./fixtures/multibuilding-set.pdf", import.meta.url));

test("sheet graph phase 2 (#87): continuation merges to ONE table, rotated headers anchor, multi-building refuses with candidates", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: MB_SET });

  const g = await callOk(client, "sheet_context", { action: "graph" });
  assert.deepEqual(g.buildings, ["A", "B"], "the set's building designators");
  assert.equal(g.sheets[0].building, "A");
  assert.equal(g.sheets[1].building, "B");
  assert.equal(g.counts.schedules, 3, "LOGICAL tables: room-finish A, room-finish B (incl. its continuation), material");
  // rooms carry their building — the same number, twice, honestly
  const r134 = g.rooms.filter((r: any) => r.tag === "134");
  assert.deepEqual(r134.map((r: any) => r.building).sort(), ["A", "B"]);
  // the rotated header band is read and disclosed
  const schedA = g.sheets.find((s: any) => s.sheet === "multibuilding-set.pdf#3");
  assert.equal(schedA.schedules.find((x: any) => x.kind === "room-finish").rotated_headers, true);
  // the continuation fragment names its base
  const contd = g.sheets.find((s: any) => s.sheet === "multibuilding-set.pdf#5");
  assert.equal(contd.schedules[0].continues, "multibuilding-set.pdf#4");

  // refusal over first-match: unqualified 134 lists the candidates per building
  const amb = await callOk(client, "find_text", { action: "resolve_tag", tag: "134" });
  assert.equal(amb.status, "unresolved");
  assert.match(amb.reason, /ambiguous: room 134 appears in 2 buildings/);
  assert.match(amb.reason, /qualify the tag/);
  assert.equal(amb.room, null, "citing one building's plan tag would be quietly wrong");
  assert.deepEqual(amb.candidates.map((c: any) => c.building).sort(), ["A", "B"]);

  // qualified tags pick the building the set names — through the ROTATED table
  const a = await callOk(client, "find_text", { action: "resolve_tag", tag: "A-134" });
  assert.equal(a.status, "resolved");
  assert.equal(a.building, "A");
  assert.equal(a.room.name, "OFFICE", "building A's 134, not B's STORAGE");
  const aFloor = a.finishes.find((f: any) => f.surface === "FLOOR");
  assert.equal(aFloor.code, "CPT-1");
  assert.equal(aFloor.definition.cells.MATERIAL, "CARPET TILE", "the chain still reaches the material schedule");
  const b = await callOk(client, "find_text", { action: "resolve_tag", tag: "B-134" });
  assert.equal(b.finishes.find((f: any) => f.surface === "FLOOR").code, "VCT-2");

  // a row carried by the CONT'D sheet resolves and cites the CONT'D sheet
  const cont = await callOk(client, "find_text", { action: "resolve_tag", tag: "201" });
  assert.equal(cont.status, "resolved");
  assert.equal(cont.building, "B");
  assert.ok(cont.finishes.every((f: any) => f.source.sheet === "multibuilding-set.pdf#5"), "evidence points at the ink");

  // a building the set never names refuses by name, with the candidates
  const c = await callOk(client, "find_text", { action: "resolve_tag", tag: "C-134" });
  assert.equal(c.status, "unresolved");
  assert.match(c.reason, /names no building "C"/);
  assert.equal(c.candidates.length, 2);

  // find_schedule: the continued table is ONE match with parts, base first
  const found = await callOk(client, "schedule", { action: "find", schedule_kind: "room finish" });
  assert.equal(found.matches.length, 2, "two logical room-finish tables — A and B — not three fragments");
  const matchA = found.matches.find((m: any) => m.building === "A");
  assert.equal(matchA.rotated_headers, true);
  const matchB = found.matches.find((m: any) => m.building === "B");
  assert.equal(matchB.rows, 2, "total rows across fragments");
  assert.deepEqual(matchB.parts.map((p: any) => [p.sheet, p.rows]), [["multibuilding-set.pdf#4", 1], ["multibuilding-set.pdf#5", 1]]);
});

// ── the sheet graph, phase 3 (#87): revision markers on the wire. The fixture
// carries "REV 2" in the margin beside building B's row 134 — the flag that
// the row's ink changed under revision 2. The marker must never band into a
// cell, and must ride sheet_graph, resolve_tag, and find_schedule.
test("sheet graph phase 3 (#87): a revision marker rides the wire and never corrupts the row", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: MB_SET });

  const g = await callOk(client, "sheet_context", { action: "graph" });
  assert.equal(g.revisions.length, 2, "both markers are listed: the text REV tag and the drawn delta");
  const textM = g.revisions.find((r: any) => !r.drawn);
  assert.equal(textM.rev, "2");
  assert.equal(textM.sheet, "multibuilding-set.pdf#4");
  assert.ok(textM.bbox.x1 > textM.bbox.x0, "the marker carries its bbox");
  // the DRAWN delta: a bare digit "1" inside a triangle of linework on the
  // rotated-header sheet — text alone refuses a bare digit; geometry proves it
  const drawnM = g.revisions.find((r: any) => r.drawn);
  assert.equal(drawnM.rev, "1");
  assert.equal(drawnM.sheet, "multibuilding-set.pdf#3");
  assert.ok(drawnM.bbox.x1 - drawnM.bbox.x0 > 20, "the bbox spans the triangle, not just the digit");

  // the revised row resolves to its post-revision codes AND says the ink changed
  const b = await callOk(client, "find_text", { action: "resolve_tag", tag: "B-134" });
  assert.equal(b.status, "resolved");
  assert.equal(b.finishes.find((f: any) => f.surface === "FLOOR").code, "VCT-2", "the marker stayed out of the cells");
  assert.equal(b.revisions.length, 1);
  assert.equal(b.revisions[0].rev, "2");
  assert.equal(b.revisions[0].source.text, "REV 2");
  assert.equal(b.revisions[0].source.sheet, "multibuilding-set.pdf#4");

  // an unrevised row carries no revisions field
  const a = await callOk(client, "find_text", { action: "resolve_tag", tag: "A-134" });
  assert.equal(a.revisions, undefined);

  // the drawn delta attaches to row 135 THROUGH the rotated-header table, and
  // the bare digit "1" minted no row anywhere
  const d = await callOk(client, "find_text", { action: "resolve_tag", tag: "A-135" });
  assert.equal(d.status, "resolved");
  assert.equal(d.finishes.find((f: any) => f.surface === "FLOOR").code, "LVT-1", "the digit stayed out of the cells");
  assert.equal(d.revisions.length, 1);
  assert.equal(d.revisions[0].rev, "1");
  assert.equal(d.revisions[0].drawn, true);
  assert.equal(d.revisions[0].source.text, "1", "evidence text is the literal ink");

  // find_schedule discloses the revised-row count per table
  const found = await callOk(client, "schedule", { action: "find", schedule_kind: "room finish" });
  assert.equal(found.matches.find((m: any) => m.building === "B").revised_rows, 1);
  assert.equal(found.matches.find((m: any) => m.building === "A").revised_rows, 1, "the drawn delta counts too");
});

// 0.9.20 — symbol_sweep's output contract, both modes, schema round-tripped
// unstripped (the assign-mode deepEqual discipline: zod strips unknown keys,
// so equality proves the schema states EVERY returned field).
const SYMPLAN = fileURLToPath(new URL("./fixtures/symbol-plan.pdf", import.meta.url));

test("symbol_sweep: reply validates AND round-trips the schema unstripped, in read and commit modes", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: SYMPLAN });
  const read = await callOk(client, "count", { action: "sweep", sheet: "symbol-plan.pdf", seed_rect: [[196, 980], [272, 1028]] });
  assert.deepEqual(z.object(symbolSweepOutput).parse(read), bare(read), "schema states every returned field — nothing stripped");
  assert.equal(read.found, read.matches.length);
  assert.ok(read.withheld.every((w: any) => typeof w.reason === "string" && w.reason.length > 0));
  assert.equal(read.committed, undefined, "read mode commits nothing");

  const commit = await callOk(client, "count", { action: "sweep", sheet: "symbol-plan.pdf", seed_rect: [[196, 980], [272, 1028]], commit: true, condition: "FD-1" });
  assert.deepEqual(z.object(symbolSweepOutput).parse(commit), bare(commit));
  assert.equal(commit.committed, commit.found);
  assert.equal(commit.shape_ids.length, commit.found);
  assert.equal(commit.condition, "FD-1");
});

// phase 2 — set-wide sweeps + schedule-row seeding: both output contracts
// round-trip unstripped on the multi-sheet fixture, and the refusals are
// clean error surfaces with the reason and the fix.
const SYMSET = fileURLToPath(new URL("./fixtures/symbol-set.pdf", import.meta.url));

test("symbol_sweep scope 'set' and sweep_schedule_row: replies round-trip their schemas unstripped; refusals name reason and fix", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: SYMSET });

  // #186: a detail seed is drawn at its own scale, so both ends must be stated
  // before the sweep will run — the fixture draws its detail at plan size, so
  // one label everywhere is truthful and the ratio comes out 1
  assert.match(
    await callErr(client, "count", { action: "sweep", sheet: "symbol-set.pdf#3", seed_rect: [[590, 574], [678, 634]], scope: "set" }),
    /drawn at its own enlarged scale .* set_scale/,
  );
  for (const sheet of ["symbol-set.pdf", "symbol-set.pdf#2", "symbol-set.pdf#3"]) {
    await callOk(client, "set_scale", { sheet, upp: 0.25 });
  }

  // set scope, seeded from the DETAIL sheet's drain — plan-only counting
  const set = await callOk(client, "count", { action: "sweep", sheet: "symbol-set.pdf#3", seed_rect: [[590, 574], [678, 634]], scope: "set" });
  assert.deepEqual(z.object(symbolSweepOutput).parse(set), bare(set), "schema states every returned field — nothing stripped");
  assert.equal(set.scope, "set");
  assert.equal(set.found, set.sheets.reduce((n: number, p: any) => n + p.found, 0), "the total reconciles to the per-sheet counts");
  assert.ok(set.sheets.every((p: any) => typeof p.elapsed_ms === "number"), "every swept sheet reports its wall-clock");
  assert.ok(set.skipped.length >= 2 && set.skipped.every((s: any) => s.reason.length > 0), "every excluded sheet says why");

  // schedule-row seeding, read then commit
  const row = await callOk(client, "schedule", { action: "sweep_row", tag: "T1" });
  assert.deepEqual(z.object(sweepScheduleRowOutput).parse(row), bare(row), "schema states every returned field — nothing stripped");
  assert.equal(row.committed, undefined, "read mode commits nothing");
  const committed = await callOk(client, "schedule", { action: "sweep_row", tag: "T1", commit: true });
  assert.deepEqual(z.object(sweepScheduleRowOutput).parse(committed), bare(committed));
  assert.equal(committed.committed, committed.found);
  assert.equal(committed.condition, "T1", "the condition is the row's own key");

  // refusals: reason + fix, never a guess
  assert.match(await callErr(client, "schedule", { action: "sweep_row", tag: "T9" }), /cannot be geometrically anchored .* never guessed from text alone/);
  assert.match(await callErr(client, "schedule", { action: "sweep_row", tag: "ZZ" }), /No schedule row "ZZ" .* tables found/);
});

// dimension annotation (0.9.20): the annotate reply's schema covers the new
// length_lf field, both on annotate and on the list round-trip.
test("annotate dimension: reply validates against the schema, length rides the round-trip", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const dim = await callOk(client, "annotate", { action: "add", sheet: KEY, type: "dimension", from: [100, 100], to: [460, 100] });
  assert.deepEqual(z.object(annotateOutput).parse(dim), bare(dim), "schema states every returned field");
  assert.equal(dim.length_lf, 10);
});

// verdict marks (#176): both directions for the two new tools plus the
// extended list_annotations, with the unstripped deepEqual proving the
// schemas state EVERY field the tools actually return.
test("mark_verdict / delete_verdict / list_annotations verdicts: replies validate and round-trip the schema unstripped", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const poly = await callOk(client, "measure", { kind: "area", sheet: KEY, points: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "CPT-1" });

  const onShape = await callOk(client, "review", { action: "mark", shape_id: poly.shape_id, text: "checked against walls" });
  assert.deepEqual(z.object(markVerdictOutput).parse(onShape), bare(onShape), "schema states every returned field");
  assert.equal(onShape.actor, "agent");
  assert.equal(onShape.condition, "CPT-1");
  const onSheet = await callOk(client, "review", { action: "mark", sheet: KEY, at: [900, 900] });
  assert.deepEqual(z.object(markVerdictOutput).parse(onSheet), bare(onSheet));

  const listed = await callOk(client, "annotate", { action: "list" });
  assert.deepEqual(z.object(listAnnotationsOutput).parse(listed), bare(listed), "verdicts[] and verdict_count are fully stated");
  assert.equal(listed.verdict_count, 2);

  const del = await callOk(client, "review", { action: "delete", verdict_id: onSheet.id });
  assert.deepEqual(z.object(deleteVerdictOutput).parse(del), bare(del));

  // semantic misuse is a clean isError surface
  await callErr(client, "review", { action: "mark" });                                              // no target
  await callErr(client, "review", { action: "mark", shape_id: poly.shape_id, sheet: KEY, at: [1, 1] }); // both targets
  await callErr(client, "review", { action: "mark", shape_id: "shp-nope" });                        // unknown shape
  await callErr(client, "review", { action: "delete", verdict_id: "apr-nope" });                    // unknown record

  // schema violations are -32602, session unharmed
  await callViolation(client, "review", { action: "mark", sheet: KEY, at: [100] });                 // one coordinate is not a point
  await callViolation(client, "review", { action: "mark", shape_id: 42 });                          // wrong type
  assert.match(await callErr(client, "review", { action: "delete" }), /review delete needs verdict_id/); // missing id: the handler names it
  const alive = await callOk(client, "annotate", { action: "list" });
  assert.equal(alive.verdict_count, 1, "the violations changed nothing");
});

// 0.9.18 — assign-from-schedule's output contract. The deepEqual is the
// load-bearing assertion: zod strips unknown keys, so a bare parse would pass
// with an incomplete schema — equality proves the schema states EVERY field
// the tool actually returns (unresolved[], withheld.unresolved, rooms[].condition).
test("detect_rooms assign mode: reply validates AND round-trips the schema unstripped", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: FINISH_PLAN });
  await callOk(client, "set_scale", { sheet: "sample-finish-plan.pdf", use_detected: true });
  const r = await callOk(client, "takeoff_rooms", { action: "detect", sheet: "sample-finish-plan.pdf", assign_from_schedule: true });
  assert.deepEqual(z.object(detectRoomsOutput).parse(r), bare(r), "schema states every returned field — nothing stripped");
  assert.ok(Array.isArray(r.unresolved), "assign mode always states the answer, empty array included");
  assert.equal(r.withheld.unresolved, r.unresolved.length, "the counter and the array agree");
});

// #364 — the RFI verbs' output contract, both directions. deepEqual is the
// load-bearing half: zod strips unknown keys, so equality proves each schema
// states EVERY field the tool returns.
test("create_rfi / list_rfis / resolve_rfi / delete_rfi: replies validate and round-trip the schema unstripped; misuse is clean", async () => {
  const client = await pair();
  await callOk(client, "open_drawings", { action: "load", path: PLAN });
  const cloud = await callOk(client, "annotate", { action: "add", sheet: KEY, type: "cloud", text: "conflict", rect: [[400, 900], [800, 1200]], condition: "CPT-1" });

  const made = await callOk(client, "rfi", { action: "create", title: "Room 102 finish conflict", question: "CPT-1 or VCT-1?", sheet: KEY, markup_ids: [cloud.id] });
  assert.deepEqual(z.object(createRfiOutput).parse(made), bare(made), "schema states every returned field");
  assert.equal(made.number, "RFI-001");
  const listed = await callOk(client, "rfi", { action: "list" });
  assert.deepEqual(z.object(listRfisOutput).parse(listed), bare(listed));
  assert.equal(listed.count, 1);
  const done = await callOk(client, "rfi", { action: "resolve", rfi_id: made.id, answer: "VCT-1 governs" });
  assert.deepEqual(z.object(resolveRfiOutput).parse(done), bare(done));
  assert.equal(done.status, "answered");
  const gone = await callOk(client, "rfi", { action: "delete", rfi_id: made.id });
  assert.deepEqual(z.object(deleteRfiOutput).parse(gone), bare(gone));
  const undo = await callOk(client, "edit_takeoff", { action: "undo", n: 3 });
  assert.deepEqual(undo.steps.map((s: any) => s.op), ["rfi_delete", "rfi_resolve", "rfi_create"], "every RFI op names itself through undoLastOutput's enum");

  // semantic misuse is a clean isError surface
  await callErr(client, "rfi", { action: "create", title: "x", question: "q", sheet: KEY, markup_ids: ["mk-nope"] });   // unknown markup
  await callErr(client, "rfi", { action: "create", title: "x", question: "q", sheet: "Z-999" });                       // unknown sheet
  await callErr(client, "rfi", { action: "create", title: "  ", question: "q", sheet: KEY });                          // blank title
  const live = await callOk(client, "rfi", { action: "create", title: "y", question: "q", sheet: KEY });
  await callOk(client, "rfi", { action: "resolve", rfi_id: live.id, answer: "a" });
  await callErr(client, "rfi", { action: "resolve", rfi_id: live.id, answer: "b" });                                   // not open
  await callErr(client, "rfi", { action: "resolve", rfi_id: "rfi-nope", answer: "b" });                                // unknown id
  await callOk(client, "rfi", { action: "delete", rfi_id: live.id });
  await callErr(client, "rfi", { action: "delete", rfi_id: live.id });                                                 // already withdrawn

  // schema violations are -32602, session unharmed
  assert.match(await callErr(client, "rfi", { action: "create", question: "q", sheet: KEY }), /rfi create needs title/); // missing title: the handler names it
  await callViolation(client, "rfi", { action: "create", title: "x", question: "q", sheet: KEY, markup_ids: "mk-1" }); // wrong type
  assert.match(await callErr(client, "rfi", { action: "resolve", rfi_id: live.id }), /rfi resolve needs answer/);    // missing answer
  assert.match(await callErr(client, "rfi", { action: "delete" }), /rfi delete needs rfi_id/);                         // missing id
  const alive = await callOk(client, "rfi", { action: "list" });
  assert.deepEqual({ count: alive.count, withdrawn: alive.withdrawn }, { count: 0, withdrawn: ["RFI-001"] }, "the violations changed nothing");
});
