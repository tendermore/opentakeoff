// The tools (TOOL_NAMES in toolnames.ts) — thin zod-validated handlers over the
// Session. Task-level tools take one flat input object with an `action` (or
// `kind`) enum and reply with one JSON object that names it; view_sheet and
// count's symbol action reply with images plus a JSON meta text item. Failures
// are isError results, never thrown protocol errors. The long engine prose
// lives in the wiki (takeoff://wiki/tools), the coordinate contract in the
// server instructions.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, okImage, fail, UserError, type ToolReply } from "./format.ts";
import { oneClickEnabled } from "./gate.ts";
import { UNDO_CAP, CONTEXT_MIN_LEN_PX, CONTEXT_MAX_SEGMENTS, CONTEXT_MAX_SEGMENTS_CEIL, VECTORS_DEFAULT_LIMIT, VECTORS_LIMIT_CEIL, type Session } from "./session.ts";
import { traceToolCall } from "./trace.ts";
import {
  perAction, loadPlanOutput, sheetInfoOutput, sheetIndexOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, measureSurfaceOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput,
  editShapeOutput, undoLastOutput, sheetContextOutput,
  findTextOutput, editMaterialsOutput, editConditionOutput, exportReportOutput,
  duplicateConditionOutput, splitConditionOutput,
  exportMarkedPdfOutput, listShapesOutput, deriveBaseOutput, deriveTransitionsOutput, importTakeoffOutput, applyRulesOutput, cutOutOutput,
  annotateOutput, editAnnotationOutput, listAnnotationsOutput, linkAnnotationOutput,
  markVerdictOutput, deleteVerdictOutput,
  createRfiOutput, listRfisOutput, resolveRfiOutput, deleteRfiOutput,
  sheetGraphOutput, resolveTagOutput, findScheduleOutput, sweepScheduleRowOutput,
  exportDxfOutput, getSheetVectorsOutput,
  proposeTakeoffOutput, reviseProposalOutput, withdrawProposalOutput,
  proposeConditionEditOutput, withdrawConditionEditOutput,
  scopeDuplicatesOutput, scopeMergeOutput,
} from "./outputs.ts";
import { exportMarkedPdf } from "./marked.ts";
import { assertWritable, OVERWRITE_DESC } from "./safewrite.ts";
import { importTakeoff } from "./importing.ts";

/** The coordinate contract — stated once, in the server instructions. */
export const COORDS = "Coordinates are image px at render scale 2.0: PDF pt × 2, origin top-left, y down (the browser canvas's native space). Sheet payloads carry dims in both px and pt.";

// A fresh schema per use: a zod instance reused inside one input schema is
// emitted as a JSON-Schema $ref, which some clients' sanitizers strip.
const point = () => z.tuple([z.number(), z.number()]);
const region = () => z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });
const roleSchema = () => z.enum(["floor_area", "deduct"]).default("floor_area");
const arcThrough = () => z.array(z.number().int().nonnegative()).optional()
  .describe("Indices of points that sit ON a curved bow between its two ends: the run passes through them on the circle");

const run = (tool: string, fn: (args: any) => unknown | Promise<unknown>) =>
  async (args: any): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      reply = ok(await fn(args));
    } catch (e) {
      reply = fail(e);
    }
    traceToolCall(tool, args, startedAt, reply);
    return reply;
  };

/** The fields one action cannot run without — the per-action half of the
 * schema's `required`, refused with the action named. */
function need(tool: string, action: string, a: Record<string, unknown>, ...fields: string[]): void {
  const missing = fields.filter((f) => a[f] === undefined);
  if (missing.length) throw new UserError(`${tool} ${action} needs ${missing.join(", ")}.`);
}

function needPoints(tool: string, action: string, pts: unknown[] | undefined, min: number): void {
  if (!pts || pts.length < min) throw new UserError(`${tool} ${action} needs at least ${min} points (image px); got ${pts?.length ?? 0}.`);
}

async function writeJson(path: string | undefined, overwrite: boolean | undefined, doc: unknown): Promise<void> {
  if (!path) return;
  await assertWritable(path, "json", overwrite);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(doc));
}

export function registerTools(server: McpServer, session: Session, opts: { oneClick?: boolean } = {}): void {
  // The TEMPORARY One-Click gate (src/gate.ts): on a default build
  // takeoff_rooms is not registered at all.
  const oneClick = oneClickEnabled(opts.oneClick);

  server.registerTool("open_drawings", {
    description: "Open plan PDFs and see what is loaded. load: open path, replacing the session; merge:true adds the file to the working set instead (plans + schedules + addenda as one takeoff). info: without sheet, every loaded sheet with its scale status and shape count; with sheet, that sheet's dims, vector linework, detected scale and PDF layer table.",
    inputSchema: {
      action: z.enum(["load", "info"]),
      path: z.string().optional().describe("load: path to a plan PDF on disk"),
      merge: z.boolean().optional().describe("load: add this document to the working set, keeping all existing work"),
      sheet: z.string().optional().describe('info: sheet key ("plan.pdf#2") or title-block number ("A-101"); omit to list every sheet'),
    },
    outputSchema: perAction("action", ["load", "info"], loadPlanOutput, sheetIndexOutput, sheetInfoOutput),
  }, run("open_drawings", async (a) => {
    if (a.action === "load") {
      need("open_drawings", "load", a, "path");
      const loaded = await session.loadPlan(a.path, { merge: a.merge });
      server.sendResourceListChanged(); // the resource surface just changed under every subscriber
      return { action: "load", ...loaded };
    }
    if (a.sheet !== undefined) return { action: "info", ...(await session.sheetInfo(a.sheet)) };
    if (!session.file) throw new UserError('No plan loaded — call open_drawings {action: "load"} first.');
    return { action: "info", ...(await session.index()) };
  }));

  server.registerTool("set_scale", {
    description: "Set a sheet's scale before measuring; quantities are px-only until then. Give exactly one: label (a standard scale such as 1/4\" = 1'-0\" or 1:100), use_detected (adopt the scale note read off the sheet, never applied automatically), calibrate (two points a known distance apart), or upp. Changing a scale re-measures existing shapes as one undo step; counts are unchanged. An agent-set scale stays unconfirmed until a human confirms it in the canvas.",
    inputSchema: {
      sheet: z.string(),
      label: z.string().optional().describe("A standard scale label, exactly as listed in the error on a miss"),
      upp: z.number().optional().describe("Real feet per image px at render scale 2.0"),
      calibrate: z.object({ p1: point(), p2: point(), feet: z.number() }).optional()
        .describe("Two points (image px) a known real distance apart, and that distance in feet"),
      use_detected: z.literal(true).optional().describe("true = adopt the sheet's detected scale"),
    },
    outputSchema: setScaleOutput,
  }, run("set_scale", async (a) => {
    const given = [a.label !== undefined, a.upp !== undefined, a.calibrate !== undefined, a.use_detected !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UserError("Provide exactly one of: label, upp, calibrate, use_detected.");
    return session.setScale(a.sheet, a);
  }));

  server.registerTool("sheet_context", {
    description: "A sheet's structure as data. context (default): a region's classified segments, text spans and hatch families in one frame — decimation is counted, short segments first, then a longest-first cap. graph: the plan-set index — sheet roles, schedule tables, corroborated rooms, unmatched tags with reasons, detail callouts, revisions. vectors: the raw strokes exactly as the engine is fed them, paged (offset + returned + dropped = total; pass next_cursor as cursor). A scan has no strokes.",
    inputSchema: {
      action: z.enum(["context", "graph", "vectors"]).default("context"),
      sheet: z.string().optional().describe("context, vectors: sheet key or title-block number"),
      region: region().optional().describe("context, vectors: rect in image px; omit for the full sheet"),
      min_len_px: z.number().min(0).default(CONTEXT_MIN_LEN_PX).describe(`context: drop segments shorter than this (default ${CONTEXT_MIN_LEN_PX}; 0 keeps all)`),
      max_segments: z.number().int().min(1).max(CONTEXT_MAX_SEGMENTS_CEIL).default(CONTEXT_MAX_SEGMENTS).describe(`context: segment cap, longest first (default ${CONTEXT_MAX_SEGMENTS})`),
      limit: z.number().int().min(1).max(VECTORS_LIMIT_CEIL).default(VECTORS_DEFAULT_LIMIT).describe(`vectors: page size in segments (default ${VECTORS_DEFAULT_LIMIT})`),
      cursor: z.number().int().min(0).optional().describe("vectors: a previous page's next_cursor"),
    },
    outputSchema: perAction("action", ["context", "graph", "vectors"], sheetContextOutput, sheetGraphOutput, getSheetVectorsOutput),
  }, run("sheet_context", async (a) => {
    if (a.action === "graph") return { action: "graph", ...(await session.sheetGraph()) };
    need("sheet_context", a.action, a, "sheet");
    if (a.action === "vectors") return { action: "vectors", ...(await session.sheetVectors(a.sheet, { region: a.region, limit: a.limit, cursor: a.cursor })) };
    return { action: "context", ...(await session.sheetContext(a.sheet, { region: a.region, min_len_px: a.min_len_px, max_segments: a.max_segments })) };
  }));

  server.registerTool("view_sheet", {
    description: "Render a sheet, or a crop of it, to a PNG: your eyes on the plan. Crop tight; a full-sheet render only shows where things are. overlay:true burns in committed shapes (solid = human-affirmed, dashed = agent): render after every commit to check it. grid burns in a 1 ft / 5 ft measuring grid. marks burns in points a reply disclosed: question (withheld), struck (rejected), ring (reference). Image pixel (ix, iy) sits at x = x0 + ix × (x1 − x0) / img_w, likewise y.",
    inputSchema: {
      sheet: z.string(),
      region: region().optional().describe("Crop rect in image px; omit for the full sheet"),
      px: z.number().int().min(200).max(2000).optional().describe("Long-side pixel budget of the image (default 1400)"),
      overlay: z.boolean().optional().describe("Burn committed shapes into the render"),
      grid: z.string().optional().describe('Measuring grid: "auto" = the sheet\'s set scale, else inches per foot such as "1/4"'),
      marks: z.object({
        question: z.array(point()).optional().describe("Withheld placements, spots to look at: orange ?-circles"),
        struck: z.array(point()).optional().describe("Rejected placements: magenta struck ×"),
        ring: z.array(point()).optional().describe("Reference points such as a seed: violet double ring"),
      }).optional().describe("Disclosure marks to burn in, image px"),
    },
  }, async (a: { sheet: string; region?: { x0: number; y0: number; x1: number; y1: number }; px?: number; overlay?: boolean; grid?: string; marks?: { question?: [number, number][]; struck?: [number, number][]; ring?: [number, number][] } }): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      const { png, meta } = await session.viewSheet(a.sheet, { region: a.region, px: a.px, overlay: a.overlay, grid: a.grid, marks: a.marks });
      reply = okImage(png, meta);
    } catch (e) {
      reply = fail(e);
    }
    traceToolCall("view_sheet", a, startedAt, reply);
    return reply;
  });

  server.registerTool("find_text", {
    description: "Text on the drawings. find: where a known string sits on a sheet (case-insensitive, per text run; count and truncated say what a tighter region or a higher limit would recover). read: every text item of a sheet or region with its position, plus the joined text. resolve_tag: one room tag → its room-finish schedule row → each finish code's definition, every edge citing sheet, text and bbox; it answers unresolved or ambiguous rather than guess.",
    inputSchema: {
      action: z.enum(["find", "read", "resolve_tag"]),
      sheet: z.string().optional().describe("find, read: sheet key or title-block number"),
      query: z.string().min(1).optional().describe("find: the text to locate, e.g. a room number or a finish tag"),
      region: region().optional().describe("find, read: rect in image px; omit for the full sheet"),
      limit: z.number().int().min(1).max(2000).default(200).describe("find: max hits returned"),
      tag: z.string().optional().describe('resolve_tag: the room tag as drawn, e.g. "134", or building-qualified "A-134"'),
    },
    outputSchema: perAction("action", ["find", "read", "resolve_tag"], findTextOutput, readSheetTextOutput, resolveTagOutput),
  }, run("find_text", async (a) => {
    if (a.action === "resolve_tag") {
      need("find_text", "resolve_tag", a, "tag");
      return { action: "resolve_tag", ...(await session.resolveRoomTag(a.tag)) };
    }
    need("find_text", a.action, a, "sheet", ...(a.action === "find" ? ["query"] : []));
    if (a.action === "read") return { action: "read", ...(await session.readSheetText(a.sheet, a.region)) };
    return { action: "find", ...(await session.findText(a.sheet, a.query, { region: a.region, limit: a.limit })) };
  }));

  if (oneClick) {
    server.registerTool("takeoff_rooms", {
      description: "Rooms from the plan's own linework. detect (default): every room label on the sheet is flooded through the sealed engine — ink flood, walls-only masks, net and drawn candidates, printed-area check — and each room returns label, area, printed area, method and confidence; every skipped room is counted with its reason in withheld. at: one room at a point. Commit with condition (one tag) or assign_from_schedule (each room's own schedule row). Then check with view_sheet overlay:true.",
      inputSchema: {
        action: z.enum(["detect", "at"]).optional().describe("detect (default) or at; at is assumed when only `at` is given"),
        sheet: z.string(),
        at: point().optional().describe("at: a point inside the room (image px)"),
        condition: z.string().optional().describe("Finish tag to commit under (minted on first use)"),
        assign_from_schedule: z.boolean().default(false).describe("detect: commit each room under the FLOOR finish of its own schedule row"),
        role: roleSchema(),
        return_verts: z.boolean().default(false).describe("Include each traced polygon's vertices"),
        min_area_sf: z.number().positive().default(5).describe("detect: enclosed regions smaller than this are withheld, not rooms"),
        sensitivity: z.number().min(0).max(1).optional().describe("Fill sensitivity 0 strict … 1 aggressive (default 0.5)"),
        layers: z.object({
          include: z.array(z.string()).optional().describe("Layer names or ids whose ink must bound the flood"),
          exclude: z.array(z.string()).optional().describe("Layer names or ids whose ink must never bound it"),
        }).optional().describe("Override the sheet's layer roles for this call (open_drawings info lists them)"),
      },
      outputSchema: perAction("action", ["detect", "at"], detectRoomsOutput, oneClickOutput),
    }, run("takeoff_rooms", async (a) => {
      const action = a.action ?? (a.at !== undefined ? "at" : "detect");
      if (action === "at") {
        need("takeoff_rooms", "at", a, "at");
        const r = await session.oneClick(a.sheet, a.at[0], a.at[1], { condition: a.condition, role: a.role, returnVerts: a.return_verts, sensitivity: a.sensitivity, layers: a.layers });
        return { action: "at", method: "one_click_v1", ...r };
      }
      // both sources of a finish tag at once is a contradiction, refused before any flooding
      if (a.assign_from_schedule && a.condition !== undefined) {
        throw new UserError("Provide at most one of: condition (every room under one stated tag) or assign_from_schedule (each room's own schedule row decides).");
      }
      return { action: "detect", ...(await session.detectRooms(a.sheet, { condition: a.condition, role: a.role, returnVerts: a.return_verts, minAreaSf: a.min_area_sf, sensitivity: a.sensitivity, layers: a.layers, assignFromSchedule: a.assign_from_schedule })) };
    }));
  }

  const countJson = async (a: any) => {
    if (a.action === "place") {
      need("count", "place", a, "sheet", "condition");
      needPoints("count", "place", a.points, 1);
      return { action: "place", ...(await session.placeCount(a.sheet, a.points, { condition: a.condition })) };
    }
    if (a.action === "marks") return { action: "marks", ...(await session.countMarks({ marks: a.marks, commit: a.commit })) };
    need("count", "sweep", a, "sheet", "seed_rect");
    return {
      action: "sweep",
      ...(await session.symbolSweep(a.sheet, {
        seedRect: a.seed_rect, condition: a.condition, commit: a.commit, scope: a.scope,
        rotations: a.rotations, mirror: a.mirror, tolerancePx: a.tolerance_px, variantGuard: a.variant_guard,
        exclude: a.exclude, luminanceTolerance: a.luminance_tolerance, commitSeed: a.commit_seed,
      })),
    };
  };

  server.registerTool("count", {
    description: "Count EA items. symbol: a point on one example → every copy found from the linework (right angles, the plan's wing angles, mirrored) and a numbered picture; drop wrong marks, try another level if the example is wrong, then commit — marks already counted under the condition never count twice. sweep: the same search from a tight seed_rect, set-wide, with counter-examples. place: markers at points you already located. marks: census of value-annotated schedule marks. Count drawn symbols, never room labels.",
    inputSchema: {
      action: z.enum(["symbol", "sweep", "place", "marks"]),
      sheet: z.string().optional().describe("symbol, sweep, place: the sheet"),
      condition: z.string().optional().describe("Tag the count is filed under (minted on first use); needed to commit"),
      commit: z.boolean().default(false).describe("Save the counted marks as one undo step; default is a preview"),
      at: point().optional().describe("symbol: a point on or beside one example instance"),
      level: z.number().int().min(1).optional().describe("symbol: use this seed from seeds_tried"),
      drop: z.array(z.number().int().min(0)).optional().describe("symbol: mark numbers on the picture to leave out"),
      include_loose: z.boolean().default(false).describe("symbol: also count the purple loose marks"),
      add_withheld: z.array(z.number().int().min(1)).optional().describe("symbol: orange W marks to count after all (W2 → 2)"),
      wing_angles: z.boolean().default(true).describe("symbol: also search the angles the plan's wings are drawn at"),
      seed_rect: z.array(point()).length(2).optional().describe("sweep: [[x0,y0],[x1,y1]] hugging ONE instance"),
      commit_seed: z.boolean().default(false).describe("sweep: also commit the seed instance (sheet scope)"),
      scope: z.enum(["sheet", "set"]).default("sheet").describe("sweep: this sheet, or every plan sheet in the set"),
      rotations: z.boolean().default(true).describe("sweep: also match 90/180/270° placements"),
      mirror: z.boolean().default(true).describe("sweep: also match mirrored placements"),
      tolerance_px: z.number().positive().max(20).default(2).describe("sweep: endpoint match tolerance, image px"),
      variant_guard: z.boolean().default(false).describe("sweep: richer variants of a whole-symbol seed are withheld, not counted"),
      exclude: z.array(z.array(point()).length(2)).optional().describe("sweep: rects around look-alikes you do NOT mean"),
      luminance_tolerance: z.number().int().min(0).max(254).optional().describe("sweep: only strokes of the seed's grey level (±this) match"),
      points: z.array(point()).optional().describe("place: marker positions, one count each"),
      marks: z.array(z.string().min(1)).optional().describe('marks: the marks to census, e.g. ["S1","R1"]; omit for the schedules\' row keys'),
    },
  }, async (a: any): Promise<ToolReply> => {
    const startedAt = process.hrtime.bigint();
    let reply: ToolReply;
    try {
      if (a.action === "symbol") {
        need("count", "symbol", a, "sheet", "at", "condition");
        const { png, png2, meta } = await session.countSymbol(a.sheet, { at: a.at, condition: a.condition, commit: a.commit, level: a.level, drop: a.drop, include_loose: a.include_loose, add_withheld: a.add_withheld, wing_angles: a.wing_angles });
        const first = okImage(png, { action: "symbol", ...meta }), closeUp = okImage(png2, {});
        reply = { content: [first.content[0], closeUp.content[0], first.content[1]] };
      } else {
        reply = ok(await countJson(a));
      }
    } catch (e) {
      reply = fail(e);
    }
    traceToolCall("count", a, startedAt, reply);
    return reply;
  });
  server.registerTool("measure", {
    description: "Measure geometry you trace (image px); pass condition to commit it. area: a closed polygon → SF and perimeter (role deduct subtracts); a room ring sits on the innermost wall faces and crosses each door on the wall centerline. length: an open polyline → LF, plus rise_ft / drop_ft vertical legs. surface: a wall run → LF × height_ft (wall tile, wainscot). A curved wall is one point on its bow listed in arc_through, never a chord. Needs the sheet's scale.",
    inputSchema: {
      kind: z.enum(["area", "length", "surface"]),
      sheet: z.string(),
      points: z.array(point()).min(2).describe("area: the ring (≥3); length, surface: the run (≥2)"),
      condition: z.string().optional().describe("Finish tag to commit under (minted on first use); surface needs it"),
      role: roleSchema().describe("area: floor_area (default) or deduct"),
      arc_through: arcThrough(),
      rise_ft: z.number().min(0).optional().describe("length: this run's vertical leg up, feet"),
      drop_ft: z.number().min(0).optional().describe("length: this run's vertical leg down, feet"),
      height_ft: z.number().positive().optional().describe("surface: wall height, feet (written to the condition)"),
    },
    outputSchema: perAction("kind", ["area", "length", "surface"], measurePolygonOutput, measureLineOutput, measureSurfaceOutput),
  }, run("measure", async (a) => {
    if (a.kind === "area") {
      needPoints("measure", "area", a.points, 3);
      return { kind: "area", ...(await session.measurePolygon(a.sheet, a.points, { condition: a.condition, role: a.role, arc_through: a.arc_through })) };
    }
    if (a.kind === "length") return { kind: "length", ...(await session.measureLine(a.sheet, a.points, { condition: a.condition, arc_through: a.arc_through, rise_ft: a.rise_ft, drop_ft: a.drop_ft })) };
    need("measure", "surface", a, "condition");
    return { kind: "surface", ...(await session.measureSurface(a.sheet, a.points, { condition: a.condition, height_ft: a.height_ft, arc_through: a.arc_through })) };
  }));

  server.registerTool("derive", {
    description: "Derive quantities from committed shapes instead of re-measuring. deduct: cut a real hole in a committed floor shape (a column, a casework island), or clip a stretch out of an open run; the ring must sit inside the parent. base: wall base from a condition's rooms, perimeter minus the door openings you state per room. transitions: where two finishes meet; butt joints commit as runs, runs across a wall come back withheld with a point to look at. Each call is one undo step.",
    inputSchema: {
      action: z.enum(["deduct", "base", "transitions"]),
      parent_shape_id: z.string().optional().describe("deduct: a committed floor_area shape, or an open run to clip"),
      points: z.array(point()).optional().describe("deduct: the ring, image px (≥3)"),
      source_condition: z.string().optional().describe("base: the finish tag whose rooms the base follows"),
      condition: z.string().optional().describe("base, transitions: the tag the result commits under"),
      openings: z.array(z.object({
        shape_id: z.string().describe("A room of source_condition"),
        lf: z.number().min(0).describe("Opening width to deduct, feet"),
      })).optional().describe("base: stated openings per room; omit for gross perimeters"),
      condition_a: z.string().optional().describe("transitions: first finish tag"),
      condition_b: z.string().optional().describe("transitions: second finish tag"),
      max_gap_in: z.number().positive().optional().describe("transitions: widest gap still adjacent, inches (default 12)"),
      min_run_in: z.number().positive().optional().describe("transitions: shortest run reported, inches (default 12)"),
    },
    outputSchema: perAction("action", ["deduct", "base", "transitions"], cutOutOutput, deriveBaseOutput, deriveTransitionsOutput),
  }, run("derive", async (a) => {
    if (a.action === "deduct") {
      need("derive", "deduct", a, "parent_shape_id");
      needPoints("derive", "deduct", a.points, 3);
      return { action: "deduct", ...(await session.cutOut({ parent_shape_id: a.parent_shape_id, verts: a.points })) };
    }
    if (a.action === "base") {
      need("derive", "base", a, "source_condition", "condition");
      return { action: "base", ...(await session.deriveBase({ source_condition: a.source_condition, condition: a.condition, openings: a.openings })) };
    }
    need("derive", "transitions", a, "condition_a", "condition_b", "condition");
    return { action: "transitions", ...(await session.deriveTransitions({ condition_a: a.condition_a, condition_b: a.condition_b, condition: a.condition, max_gap_in: a.max_gap_in, min_run_in: a.min_run_in })) };
  }));

  server.registerTool("schedule", {
    description: "Schedules in the set. find: a schedule table by kind (room finish, finish/material, or equipment) with its sheet, headers, row count and region. sweep_row: take off one schedule row's mark — the condition is minted from the row and every drawn occurrence on the plan sheets is counted, geometry and tag text agreeing. apply_rules: re-run the correction rules an imported takeoff carries, one undo step.",
    inputSchema: {
      action: z.enum(["find", "sweep_row", "apply_rules"]),
      schedule_kind: z.string().optional().describe('find: "room finish", "finish"/"material", or "equipment"'),
      tag: z.string().min(1).optional().describe("sweep_row: the row's key as drawn, e.g. T1; it becomes the condition"),
      commit: z.boolean().default(false).describe("sweep_row: commit every counted occurrence"),
      rotations: z.boolean().default(true).describe("sweep_row: also match 90/180/270° markers"),
      mirror: z.boolean().default(true).describe("sweep_row: also match mirrored markers"),
      tolerance_px: z.number().positive().max(20).default(2).describe("sweep_row: endpoint match tolerance, image px"),
      sheet: z.string().optional().describe("apply_rules: scan only this sheet"),
    },
    outputSchema: perAction("action", ["find", "sweep_row", "apply_rules"], findScheduleOutput, sweepScheduleRowOutput, applyRulesOutput),
  }, run("schedule", async (a) => {
    if (a.action === "find") {
      need("schedule", "find", a, "schedule_kind");
      return { action: "find", ...(await session.findSchedule(a.schedule_kind)) };
    }
    if (a.action === "apply_rules") return { action: "apply_rules", ...(await session.applyRules({ sheet: a.sheet })) };
    need("schedule", "sweep_row", a, "tag");
    return { action: "sweep_row", ...(await session.sweepScheduleRow(a.tag, { commit: a.commit, rotations: a.rotations, mirror: a.mirror, tolerancePx: a.tolerance_px })) };
  }));

  server.registerTool("edit_takeoff", {
    description: "Inspect and revise committed shapes. list: every shape's id, sheet, condition, role, quantities, room label and review state, filtered by sheet or condition. edit: new points, condition, role, label or rise/drop on a shape you committed; quantities re-measure. delete: remove a shape. undo: step back over your own last n changes. Shapes a human affirmed are ink and are refused.",
    inputSchema: {
      action: z.enum(["list", "edit", "delete", "undo"]),
      shape_id: z.string().optional().describe("edit, delete: the shape's id"),
      sheet: z.string().optional().describe("list: only shapes on this sheet"),
      condition: z.string().optional().describe("list: only this finish tag; edit: reassign to this tag"),
      points: z.array(point()).optional().describe("edit: replacement geometry, image px"),
      role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]).optional().describe("edit: what the shape measures"),
      label: z.string().optional().describe('edit: the room the shape belongs to; "" clears it'),
      rise_ft: z.number().min(0).nullable().optional().describe("edit: a run's vertical leg up, feet; null restores the condition's"),
      drop_ft: z.number().min(0).nullable().optional().describe("edit: a run's vertical leg down, feet; null restores the condition's"),
      n: z.number().int().min(1).max(UNDO_CAP).default(1).describe(`undo: how many steps (1–${UNDO_CAP})`),
    },
    outputSchema: perAction("action", ["list", "edit", "delete", "undo"], listShapesOutput, editShapeOutput, deleteShapeOutput, undoLastOutput),
  }, run("edit_takeoff", async (a) => {
    if (a.action === "list") return { action: "list", ...(await session.listShapes({ sheet: a.sheet, condition: a.condition })) };
    if (a.action === "undo") return { action: "undo", ...(await session.undoLast(a.n)) };
    need("edit_takeoff", a.action, a, "shape_id");
    if (a.action === "delete") return { action: "delete", ...(await session.deleteShape(a.shape_id)) };
    return { action: "edit", ...(await session.editShape(a.shape_id, { verts: a.points, condition: a.condition, role: a.role, label: a.label, rise_ft: a.rise_ft, drop_ft: a.drop_ft })) };
  }));

  server.registerTool("summary", {
    description: "Per-condition totals (floor, wall and border SF, LF, EA, SY, with and without waste) plus grand totals: the Report's numbers, by the same rules. Numbers only; the deliverable that shows the work is export marked_pdf.",
    inputSchema: {},
    outputSchema: takeoffSummaryOutput,
  }, run("summary", () => session.summary()));

  server.registerTool("export", {
    description: "Hand the takeoff off, or bring one back. marked_pdf: the marked-up planset, every worked sheet with the shapes burned in behind a legend cover; finish every takeoff with it and give the user its path. report: the computed Report (quantities with waste, the materials buy list) for pricing. takeoff: the raw canvas payload the app imports. dxf: one sheet as a DXF in real units. import: load a takeoff payload into this session.",
    inputSchema: {
      action: z.enum(["marked_pdf", "report", "takeoff", "dxf", "import"]),
      path: z.string().optional().describe("Where to write (dxf needs it; marked_pdf defaults next to the plan) or, for import, the file to read"),
      project_name: z.string().optional().describe("marked_pdf, report: the project name printed"),
      sheet: z.string().optional().describe("dxf: which sheet, when several carry shapes"),
      units: z.enum(["ft", "m"]).optional().describe('dxf: "ft" (default) or "m"'),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESC),
    },
    outputSchema: perAction("action", ["marked_pdf", "report", "takeoff", "dxf", "import"], exportMarkedPdfOutput, exportReportOutput, exportTakeoffOutput, exportDxfOutput, importTakeoffOutput),
  }, run("export", async (a) => {
    switch (a.action) {
      case "marked_pdf":
        return { action: "marked_pdf", ...(await exportMarkedPdf(session, { path: a.path, project_name: a.project_name, overwrite: a.overwrite })) };
      case "report": {
        const doc = session.exportReport(a.project_name);
        await writeJson(a.path, a.overwrite, doc);
        return { action: "report", ...doc };
      }
      case "takeoff": {
        const payload = session.exportPayload();
        await writeJson(a.path, a.overwrite, payload);
        return { action: "takeoff", ...payload };
      }
      case "import":
        need("export", "import", a, "path");
        return { action: "import", ...(await importTakeoff(session, a.path)) };
      default: {
        need("export", "dxf", a, "path");
        const units = a.units ?? "ft";
        const { sheet: s, build } = session.exportDxf(a.sheet, units);
        await assertWritable(a.path, "dxf", a.overwrite);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(a.path, build.dxf, "utf8");
        return {
          action: "dxf",
          path: a.path,
          sheet: s.key,
          sheet_number: s.sheetNumber ?? null,
          units,
          layers: build.layers,
          entities: build.entities,
          shapes: build.shapes,
          skipped: build.skipped,
          extents: build.extents,
          bytes: Buffer.byteLength(build.dxf, "utf8"),
        };
      }
    }
  }));

  // ── estimator workflow — the old per-verb tools, consolidated in a later change ──
  server.registerTool("propose_takeoff", {
    description: `Open a PROPOSAL — a named batch of the shapes you are about to commit, with one identity (#365). Every shape you commit from here on (${oneClick ? "takeoff_rooms, " : ""}measure {kind: "area"}, measure {kind: "length"}, measure {kind: "surface"}, count {action: "place"}, the sweeps, the derives, derive {action: "deduct"}) attaches to it until you open another proposal or withdraw this one; the estimator then sees ONE Accept pill for the whole batch instead of one per shape — a forty-room pass becomes one decision, not forty. Use it BEFORE the work, the way an estimator titles a takeoff before tracing: "Level 2 rooms per finish schedule A-601", "Base derived from CPT-1 rooms". label is what the estimator reads on the pill; rationale is what decided the batch (the schedule row, the sheet, the rule) — both required, neither is a comment. Nothing here commits geometry or changes a total: an empty proposal is just a heading. The batch is what revise_proposal replaces and withdraw_proposal removes; shapes the estimator has already accepted leave the batch and no agent verb reaches them. summary carries the ledger (pending / accepted / withdrawn per batch).`,
    inputSchema: {
      label: z.string().min(1).describe("The batch's title, as the estimator will read it on the Accept pill"),
      rationale: z.string().min(1).describe("What decided the batch — cite the schedule row, sheet, or rule"),
    },
    outputSchema: proposeTakeoffOutput,
  }, run("propose_takeoff", (a) => session.proposeTakeoff(a.label, a.rationale)));

  server.registerTool("revise_proposal", {
    description: `Replace EVERY still-pending shape in a proposal with a new set, as ONE journal step (#365) — the move for "I re-measured and got a better batch". The old pending shapes go, the replacements commit under the same proposal, and edit_takeoff {action: "undo"} puts the previous batch back exactly. All-or-nothing: the whole replacement is validated (sheet, scale, vertex count, a height for surface_area) before the first pending shape is removed, so a malformed last shape leaves the batch untouched and the error says which entry and why. Shapes the estimator already accepted are ink — they stay, and they are not part of what this replaces. verts are image px like every other tool; roles and minimums match the measure tools (floor_area/deduct ≥3, linear/surface_area ≥2, count 1). An empty shapes list is refused — withdraw_proposal is the verb for that.`,
    inputSchema: {
      proposal_id: z.string().describe("The batch, from propose_takeoff"),
      shapes: z.array(z.object({
        sheet: z.string().describe('Sheet key ("plan.pdf", "plan.pdf#2") or title-block number'),
        condition: z.string().describe("Finish tag — minted on first touch, like measure {kind: \"area\"}"),
        role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
        verts: z.array(point()).min(1).describe("Geometry in image px: a ring for areas, a run for linear/surface, one point for a count"),
        label: z.string().optional().describe("The room this shape belongs to (per-room reporting)"),
        height_ft: z.number().positive().optional().describe("surface_area only — the height to quantify at when the condition has none"),
      })).min(1),
    },
    outputSchema: reviseProposalOutput,
  }, run("revise_proposal", (a) => session.reviseProposal(a.proposal_id, a.shapes)));

  server.registerTool("withdraw_proposal", {
    description: `Take a proposal back (#365): every still-pending shape in the batch is removed in ONE journal step, the record stays marked withdrawn (its label is history the estimator may still read), and new commits stop attaching to it. Shapes the estimator already accepted are ink and stay — the reply counts them. This is the honest exit for "that batch was wrong" — one call instead of N edit_takeoff {action: "delete"} calls, and edit_takeoff {action: "undo"} restores the whole batch.`,
    inputSchema: { proposal_id: z.string().describe("The batch, from propose_takeoff") },
    outputSchema: withdrawProposalOutput,
  }, run("withdraw_proposal", ({ proposal_id }) => session.withdrawProposal(proposal_id)));

  server.registerTool("propose_condition_edit", {
    description: `PROPOSE a change to a condition instead of making it (#365): a diff — a new finish tag (rename), waste %, ×N multiplier, height_ft, roll_setup — held PENDING until the estimator accepts it from the panel. edit_condition is the wrong power for "I think this condition is wrong": a tag rename or a knob change should be a decision the estimator makes, not one they discover. Until acceptance NOTHING changes — summary and export {action: "report"} keep computing from the current values and carry the diff beside them (proposed_condition_edits), and once accepted the report is byte-for-byte what a direct edit_condition would have produced (the same write path). Only fields that differ from the current value are recorded; a proposal that changes nothing is refused, and a rename onto a tag another condition already carries is refused (two conditions on one tag would make one unreachable). One pending diff per condition — proposing again replaces the earlier one (edit_takeoff {action: "undo"} restores it). rationale is required: the estimator accepts a reason.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of an EXISTING condition, e.g. 'CPT-1'"),
      finish_tag: z.string().min(1).optional().describe("Proposed new tag (a rename)"),
      waste_pct: z.number().min(0).optional(),
      multiplier: z.number().positive().optional(),
      height_ft: z.number().positive().optional(),
      rise_ft: z.number().min(0).optional().describe("Proposed default vertical leg UP for the condition's linear runs (#441)"),
      drop_ft: z.number().min(0).optional().describe("Proposed default vertical leg DOWN for the condition's linear runs (#441)"),
      roll_setup: z.union([z.null(), z.object({}).passthrough()]).optional().describe("Proposed roll-goods setup, or null to propose opting out"),
      rationale: z.string().min(1).describe("Why — the schedule row, the spec section, the sheet note that decided it"),
    },
    outputSchema: proposeConditionEditOutput,
  }, run("propose_condition_edit", (a) => session.proposeConditionEdit(a.condition, { finish_tag: a.finish_tag, waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, rise_ft: a.rise_ft, drop_ft: a.drop_ft, roll_setup: a.roll_setup }, a.rationale)));

  server.registerTool("withdraw_condition_edit", {
    description: `Drop a pending condition-edit proposal (#365) without touching the condition. edit_takeoff {action: "undo"} re-seats it.`,
    inputSchema: { proposal_id: z.string().describe("From propose_condition_edit, or summary's proposed_condition_edits") },
    outputSchema: withdrawConditionEditOutput,
  }, run("withdraw_condition_edit", ({ proposal_id }) => session.withdrawConditionEdit(proposal_id)));

  server.registerTool("edit_condition", {
    description: `Set a condition's quantity knobs — waste %, multiplier, height_ft (the H knob measure {kind: "surface"} quantifies against), and/or roll_setup (the roll-goods opt-in: seams and order footage figured from the committed rooms, #147). summary emits waste-adjusted *_net order quantities and a per-condition multiplier, and every export carries both, but conditions minted through the measure tools start at waste 0 / multiplier 1 — without this tool an agent's takeoff always ships net === gross (#131). waste_pct is the estimator's cut-waste percentage (carpet commonly 5–10); multiplier scales every quantity on the condition (×N identical floors — summary applies it before waste). condition must resolve to an EXISTING finish tag — a typo'd tag errors rather than minting an empty condition (the edit_materials remove/patch rule, not its add rule: these knobs mean nothing on a condition that doesn't exist yet). No review gate — quantity config, not traced geometry; edit_takeoff {action: "undo"} reverses a call in one step (both knobs snapshotted together, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag of an existing condition, e.g. 'CPT-1'"),
      waste_pct: z.number().min(0).optional().describe("Waste percentage applied to net order quantities, e.g. 10 for 10%"),
      multiplier: z.number().positive().optional().describe("Quantity multiplier (×N identical areas). Note: the canvas treats 0 as 1, so 0 is rejected here rather than silently meaning 'off'"),
      height_ft: z.number().positive().optional().describe("Wall height in feet — the canvas's H knob; measure {kind: \"surface\"} quantifies traced LF × this"),
      rise_ft: z.number().min(0).optional().describe("Drop and Rise (#441): the vertical leg UP, in feet, every linear run of this condition adds to its plan length (LF = plan + rise + drop). Re-flows existing runs that do not carry their own rise_ft; derived base/transitions never take a leg. 0 turns it off"),
      drop_ft: z.number().min(0).optional().describe("Drop and Rise (#441): the vertical leg DOWN, in feet, every linear run of this condition adds to its plan length. Re-flows existing runs that do not carry their own drop_ft. 0 turns it off"),
      roll_setup: z.union([
        z.null().describe("Opt the condition OUT of roll goods"),
        z.object({
          material: z.enum(["carpet", "sheet_vinyl", "rubber"]).optional().describe("Material class — fresh opt-ins and material changes start from this class's engine defaults (carpet sells sy, others sf)"),
          roll_width_ft: z.number().positive().optional(),
          roll_length_ft: z.number().min(0).optional().describe("Physical roll length; 0 = unlimited"),
          seam_allowance_in: z.number().min(0).optional(),
          wall_overage_in: z.number().min(0).optional(),
          doorway_overage_in: z.number().min(0).optional(),
          direction: z.enum(["auto", "ns", "ew"]).optional().describe("Run direction; auto lets the engine pick per room"),
          price_unit: z.enum(["sy", "sf", "lf"]).optional().describe("Sell unit the order quantity is figured in"),
        }),
      ]).optional().describe("Roll-goods opt-in (#147): presence of a setup is what makes the condition roll goods — seams figured, cuts packed, order footage beside the measured quantities. Same-material partial edits patch the existing setup; null opts out. The reply echoes the figured order (cuts, order_lf, rolls, order_qty) whenever floor shapes exist on scaled sheets, and export {action: \"report\"}'s roll_goods block carries the same rows"),
    },
    outputSchema: editConditionOutput,
  }, run("edit_condition", (a) => session.editCondition(a.condition, { waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, roll_setup: a.roll_setup, rise_ft: a.rise_ft, drop_ft: a.drop_ft })));

  server.registerTool("edit_materials", {
    description: `Add, remove, or patch supporting-materials rows on a condition — the coverage-rate lines that turn a measured area/length/count into an order quantity (adhesive at N sf/gal, grout at N lf/bag, …), matching the canvas's per-condition Supporting Materials panel. Each row is {name, per, basis, unit, round, note}: quantity = the condition's basis total (area/linear/count/seam_lf) ÷ per, rounded up to whole purchase units unless round:false. basis "seam_lf" is the one basis that is FIGURED rather than measured: it is the length where two cuts meet on the floor, read off the condition's roll layout (set roll_setup with edit_condition), which is what a heat-weld rod or a carpet seam tape is bought by. A 20-ft-wide room off a 12-ft roll seams once down its length; the same square footage as two 10-ft rooms seams not at all, and no percentage of the area or the perimeter can tell those two jobs apart. Without a roll_setup — or with no committed floor shapes to lay out — a seam_lf row reads 0, which is the honest state rather than a guess. condition names an existing OR NEW finish tag (minted on first touch, same as ${oneClick ? "takeoff_rooms/" : ""}measure {kind: "area"}) — add alone is enough to seed materials on a condition before you've traced anything. remove/patch target existing row ids from this reply or export {action: "takeoff"} (summary strips materials for a compact quantities-only reply); a bad id 404s the WHOLE call before anything is written, and referencing an id on a tag with no condition yet errors rather than silently minting an empty one. No review gate here — materials rows are quantity config, not traced geometry, so this edits directly; edit_takeoff {action: "undo"} reverses a call in one step (the condition's whole materials array, snapshotted before the write, restored verbatim).`,
    inputSchema: {
      condition: z.string().describe("Finish tag, e.g. 'CPT-1'"),
      add: z.array(z.object({
        name: z.string().min(1),
        per: z.number().min(0).optional().describe("Coverage rate — basis units per purchase unit, e.g. 250 for 1 gal / 250 sf. Default 0 (quantity 0 until set)"),
        basis: z.enum(["area", "linear", "count", "seam_lf"]).optional().describe("Which of the condition's totals this row divides against — default 'area' (total SF). 'seam_lf' is the figured roll-layout seam length (weld rod, seam tape), 0 until the condition carries a roll_setup"),
        unit: z.string().optional().describe("Purchase unit, e.g. 'gal', 'bag', 'roll'"),
        round: z.boolean().optional().describe("Round up to whole purchase units — default true"),
        note: z.string().optional(),
      })).optional().describe("New rows to add"),
      remove: z.array(z.string()).optional().describe("Existing row ids to remove"),
      patch: z.array(z.object({
        id: z.string(),
        fields: z.record(z.union([z.string(), z.number(), z.boolean()])).describe("Field:value pairs — name/per/basis/unit/round/note only"),
      })).optional().describe("Field changes on existing rows"),
    },
    outputSchema: editMaterialsOutput,
  }, run("edit_materials", (a) => session.editMaterials(a.condition, { add: a.add, remove: a.remove, patch: a.patch })));

  server.registerTool("duplicate_condition", {
    description: `Twin a condition — the same finish measured somewhere else, with its own supporting materials. One finish in two areas is not two conditions and it is not one either: the same sheet goods over a slab and over a raised deck take the same field material and different preparation underneath (one wants a moisture barrier, the other a primer and a different adhesive). The twin arrives carrying the original's whole materials list and keeps FOLLOWING it — change a coverage rate on the original and every twin that has not touched that row gets it; edit a row on the twin and only THAT row stops following. \`label\` is REQUIRED and becomes the tag suffix ('CPT-1' + 'Level 2' → 'CPT-1 – Level 2'), because every tool in this server resolves a condition by finish tag and takes the FIRST match: two conditions sharing a tag would make one permanently unreachable, and a takeoff re-import collapses them last-wins. A label already in use is refused rather than de-collided. No takeoffs come along — measure the new area against the returned condition_id. Reversible with edit_takeoff {action: "undo"}; use split_condition to end the inheritance permanently.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of the condition to twin, e.g. 'CPT-1'"),
      label: z.string().describe("What makes this one different, usually the area: 'Level 2', 'Building B', 'Phase 2'"),
    },
    outputSchema: duplicateConditionOutput,
  }, run("duplicate_condition", (a) => session.duplicateCondition(a.condition, a.label)));

  server.registerTool("split_condition", {
    description: `Cut a twin loose from its family: every following material row freezes at its current values and edits to the original stop reaching it. It keeps its finish tag and still groups with its siblings — only the inheritance ends. Use when two variants have diverged far enough that following one another is wrong. A condition that already owns its materials returns split:false rather than erroring. Reversible with edit_takeoff {action: "undo"}.`,
    inputSchema: {
      condition: z.string().describe("Finish tag of the twin to split, e.g. 'CPT-1 – Level 2'"),
    },
    outputSchema: splitConditionOutput,
  }, run("split_condition", (a) => session.splitCondition(a.condition)));

  server.registerTool("scope_duplicates", {
    description: `Two conditions claiming the same floor, as a list (#366). Every pair of committed floor_area shapes on one sheet whose EXACT polygon intersection exceeds min_fraction of the smaller shape — with the shared SF, which condition each belongs to, whether the estimator already affirmed either, and a look region to pass to view_sheet {overlay: true}. Pairs on DIFFERENT conditions are collisions: every total downstream counts that floor twice. Pairs on the SAME condition are a double trace (a different bug) and come back in duplicates. shared_floor_sf is the whole compared set's Σ areas − union, counted once per cell no matter how many shapes pile on it — the number summary carries and the one that has to read 0 before any total means anything. Machine-precision edge remnants are ignored; a real overlap below 0.01 SF stays listed with an explanatory note. Supporting materials belong in edit_materials coverage rows, not duplicate floor polygons. Deducts and runs are not claims. Read-only; a shape on an unscaled sheet or with a degenerate ring is listed in unmeasured, never counted as zero. Same rule as the room eval's shared-floor gate (iou ≥ 0.5 = the same space claimed twice).`,
    inputSchema: {
      sheet: z.string().optional().describe("Restrict to one sheet; default every sheet with floor shapes"),
      min_fraction: z.number().min(0).max(1).optional().describe("List a pair only when shared ÷ smaller ≥ this (default 0.05 — rings that merely kiss along a wall are not claims; 0 lists every positive overlap above machine-precision noise)"),
    },
    outputSchema: scopeDuplicatesOutput,
  }, run("scope_duplicates", (a) => session.scopeDuplicates({ sheet: a.sheet, min_fraction: a.min_fraction })));

  server.registerTool("scope_merge", {
    description: `Resolve ONE collision (#366): given a pair of floor shapes and the winner, the loser gives up the shared floor — TRIMMED to its remainder by an exact boolean difference (the derive {action: "deduct"} module's own arithmetic; its quantities re-measured from the result), or DELETED outright when the overlap is near-total (≥ 98% of the loser: the same space claimed twice, not a room with a sliver left). One journal step either way; edit_takeoff {action: "undo"} restores the loser verbatim. Who wins: state winner; with it omitted the reviewed shape wins over a pending one, and the verb refuses when neither is reviewed (it does not guess which condition the floor belongs to) or when BOTH are (that is the estimator's call — the collision shows on both condition rows in the canvas). The ink rule is absolute: a loser the estimator affirmed is refused whoever you name. A trim that would split the loser into disjoint pieces refuses — that is a re-trace decision, not a merge — and a loser carrying reconciled cutouts refuses (delete the cuts first).`,
    inputSchema: {
      shape_a: z.string().describe("One shape of the pair (from scope_duplicates)"),
      shape_b: z.string().describe("The other"),
      winner: z.string().optional().describe("Which of the two keeps the shared floor; omit to let the reviewed one win"),
    },
    outputSchema: scopeMergeOutput,
  }, run("scope_merge", (a) => session.scopeMerge({ shape_a: a.shape_a, shape_b: a.shape_b, winner: a.winner })));

  server.registerTool("annotate", {
    description: `Place an annotation on a sheet — a note ABOUT the work, never a measurement of it. Types: cloud and highlight take rect:[[x0,y0],[x1,y1]] (a revision cloud around an area, a highlight box over it), text takes at:[x,y], callout takes at:[x,y] plus target:[x,y] (the point its leader aims at), arrow takes from:[x,y] and to:[x,y] (tail and head — plank/seam direction, the markup flooring drawings use most; #150), bubble takes at:[x,y] plus optional r (a keynote/detail circle carrying centered text), dimension takes from:[x,y] and to:[x,y] (its two measured endpoints) and labels itself with the length between them at the sheet's scale — drawn as a dimension line with end ticks and the measurement centered. A dimension states a REAL length, so it is the one annotation the scale gate applies to: on an unscaled sheet it refuses exactly like the measure tools (set_scale first) rather than dressing a px figure up as feet. It still touches no quantity — a dimension is a note about a distance, not a takeoff line item.\n\nPass condition to attach the note to a finish tag, which is what makes it part of that SCOPE rather than a floating remark: it then wears the condition's colour on the canvas and in the marked-set PDF, and travels with it into the report. The tag is minted on first touch like ${oneClick ? "takeoff_rooms/" : ""}measure {kind: "area"}, so you can annotate CPT-1 before anything is traced for it. Omit condition for a note about the sheet itself. \n\nNo review gate: the pencil-not-ink rule exists to stop an agent inventing geometry, and a cloud reading "verify substrate" is not geometry. It touches no quantity.`,
    inputSchema: {
      sheet: z.string().describe("Sheet name or number, as open_drawings {action: \"info\"} reports it"),
      type: z.enum(["cloud", "text", "callout", "highlight", "arrow", "bubble", "dimension"]).describe("cloud/highlight need rect; text/callout/bubble need at; callout also needs target; arrow and dimension need from + to"),
      text: z.string().default("").describe("The note. A cloud with no text still reads as 'look here'; a bubble's text draws centered in the circle; a dimension appends it after the measured length"),
      condition: z.string().optional().describe("Finish tag to attach this note to, e.g. 'CPT-1' (minted on first use). Omit for an unattached sheet note"),
      at: point().optional().describe("Anchor point (image px) — text, callout, and bubble (the circle's center)"),
      target: point().optional().describe("What a callout's leader line points at (image px)"),
      rect: z.tuple([point(), point()]).optional().describe("Corners (image px) — cloud and highlight"),
      from: point().optional().describe("Arrow tail / dimension start (image px)"),
      to: point().optional().describe("Arrow head / dimension end (image px)"),
      r: z.number().positive().optional().describe("Bubble radius (image px); omitted → the canvas default (2% of sheet width)"),
    },
    outputSchema: annotateOutput,
  }, run("annotate", (a) => session.annotate(a)));

  server.registerTool("list_annotations", {
    description: `Every annotation on the takeoff, with condition_id RESOLVED to its finish tag so you can act on the reply without joining against conditions[]. Filter by sheet, by condition, or both. Coordinates come back in image px (the same frame you passed in), not the normalized form they're stored as. \`unattached\` counts the notes carrying no condition — the candidates for link_annotation. \`verdicts\` is the approval family's inventory (mark_verdict/delete_verdict): every mark with its actor stated — the estimator's APPROVED ring or the agent's AGENT diamond — under the same filters, a condition filter reaching a verdict through its target shape.`,
    inputSchema: {
      sheet: z.string().optional().describe("Only annotations on this sheet"),
      condition: z.string().optional().describe("Only annotations attached to this finish tag"),
    },
    outputSchema: listAnnotationsOutput,
  }, run("list_annotations", (a) => session.listAnnotations(a)));

  server.registerTool("edit_annotation", {
    description: "Shorten, replace or clear the text of an existing annotation. Get annotation_id from list_annotations (annotations, not verdicts). Changes only text: position, shape, dimension length, condition links, quantities and review records stay unchanged. Empty text clears the note; a dimension still prints its measured length. Refuses an RFI-linked note: review that question's context in the browser RFI register. One edit_takeoff {action: \"undo\"} step restores the previous text. Does not create a verdict or human approval.",
    inputSchema: {
      annotation_id: z.string().describe("An annotation id from list_annotations"),
      text: z.string().describe("Replacement text; empty string clears it"),
    },
    outputSchema: editAnnotationOutput,
  }, run("edit_annotation", (a) => session.editAnnotation(a.annotation_id, a.text)));

  server.registerTool("link_annotation", {
    description: `Attach an existing annotation to a condition, or detach it by passing an empty condition — the canvas's Attach/Detach control, reachable by an agent. Use it to tie up notes left unattached (list_annotations reports how many), or to move one to the finish it actually concerns. Attaching mints the tag on first use.`,
    inputSchema: {
      annotation_id: z.string().describe("Id from annotate or list_annotations"),
      condition: z.string().describe("Finish tag to attach to; empty string detaches"),
    },
    outputSchema: linkAnnotationOutput,
  }, run("link_annotation", (a) => session.linkAnnotation(a.annotation_id, a.condition)));

  server.registerTool("mark_verdict", {
    description: `Mark the agent's VERDICT on work — the pencil half of the approval family, and the only half an agent can mint. Two actors exist on the record: the estimator's APPROVED ring is ink, minted solely by a human's click at the canvas's Approve tool; this tool mints the AGENT diamond and structurally nothing else — it takes no actor input to misuse. Target the work either way: shape_id anchors the mark ON a committed shape (a room at its area centroid, a run at its on-path midpoint, a count marker at its point) and records WHAT was marked — the shape_id stays on the record as provenance, and the glyph keeps its own anchor even if the shape is later deleted; or sheet + at drops the mark at a sheet point (image px). Exactly one target. Optional text rides the record through every export; the glyph itself always reads AGENT. A verdict touches no quantity and gates nothing: it is the agent's signed claim that it checked this work — pencil beside the estimator's ink, never in its place. The mark renders as the graphite AGENT diamond on the canvas and in the marked set, the marked-set cover tallies the split ("Approval stamps: N estimator-approved · M agent-marked"), and the record rides the annotations payload through export {action: "takeoff"} / export {action: "import"} and the app's own saves. One mark per shape (re-mark = delete_verdict, then mark again); list_annotations returns the inventory in verdicts[]; edit_takeoff {action: "undo"} steps over a mark exactly like any other mutation.`,
    inputSchema: {
      shape_id: z.string().optional().describe("Mark a committed shape (edit_takeoff {action: \"list\"} has the ids) — anchored on the shape, recorded as provenance. Exactly one target: this OR sheet + at"),
      sheet: z.string().optional().describe("Sheet-point mode: the sheet, together with at"),
      at: point().optional().describe("Sheet-point mode: where the AGENT diamond renders (image px)"),
      text: z.string().optional().describe("Optional short note riding the record and every export — the glyph always reads AGENT"),
    },
    outputSchema: markVerdictOutput,
  }, run("mark_verdict", (a) => {
    // the set_scale convention: one target, stated exactly, refused otherwise
    const byShape = a.shape_id !== undefined;
    const byPoint = a.sheet !== undefined || a.at !== undefined;
    if (byShape === byPoint) throw new UserError("Provide exactly one target: shape_id (mark a committed shape), or sheet + at (mark a sheet point).");
    if (byPoint && (a.sheet === undefined || a.at === undefined)) throw new UserError("A sheet-point verdict needs BOTH sheet and at: [x, y] (image px).");
    return session.markVerdict({ shape_id: a.shape_id, sheet: a.sheet, at: a.at, text: a.text });
  }));

  server.registerTool("delete_verdict", {
    description: `Lift an agent verdict mark by id (mark_verdict's reply, or list_annotations verdicts[]). Agent marks only: the estimator's APPROVED seal is human ink and is refused — the same line edit_takeoff {action: "edit"} holds on reviewed shapes. Journaled like every mutation, so edit_takeoff {action: "undo"} re-seats a lifted mark exactly where it was.`,
    inputSchema: {
      verdict_id: z.string().describe("Record id from mark_verdict or list_annotations verdicts[]"),
    },
    outputSchema: deleteVerdictOutput,
  }, run("delete_verdict", ({ verdict_id }) => session.deleteVerdict(verdict_id)));

  server.registerTool("create_rfi", {
    description: `Raise an RFI — a Request For Information — when the drawing set contradicts itself or cannot answer a question you need answered to take the work off: a room-finish schedule row that names a tag the plan never draws, a room label the schedule has no row for, a finish called out two ways, a scale that disagrees with a stated dimension. It lands in the estimator's RFI register (the canvas's RFI panel) with the next number in that register's own sequence (RFI-001, RFI-002, …), status open, dated today, on the sheet you name. You raise it as the agent: the record carries origin {actor: "agent", reviewed: false} and is PENDING — pencil — until the estimator accepts it in the register, because an RFI goes to the architect and nothing sends without a human. It still prints in the marked set's RFI schedule like any other RFI, so the question is on the deliverable. Pass markup_ids to pin it to annotations already on the sheet (annotate a cloud or callout at the conflict first, then link it here) — a linked markup carries the RFI number on the canvas and in the marked set, and list_rfis reports which finish tags the question touches through those links. Prefer this to describing the conflict in prose: a question in the register is tracked, numbered, and answered; a sentence in a reply is lost. Journaled; edit_takeoff {action: "undo"} takes it back.`,
    inputSchema: {
      title: z.string().describe("The one-line subject the register and the RFI schedule print — what the question is about"),
      question: z.string().describe("What you are asking the architect to answer, stated so a reply can settle it"),
      sheet: z.string().describe("Sheet name or number the question is about, as open_drawings {action: \"info\"} reports it"),
      markup_ids: z.array(z.string()).optional().describe("Annotation ids (annotate / list_annotations) to link — they carry this RFI's number on the sheet"),
    },
    outputSchema: createRfiOutput,
  }, run("create_rfi", (a) => session.createRfi(a)));

  server.registerTool("list_rfis", {
    description: `Every RFI in the register with its status, sheet, who raised it (actor) and whether an agent-raised one is still pending the estimator's acceptance, its linked markup ids, and the finish tags those markups are attached to — the scopes the question touches. withdrawn[] lists the numbers delete_rfi tombstoned, so a gap in the sequence is explained rather than silent. Read this before raising a question the register already holds.`,
    inputSchema: {},
    outputSchema: listRfisOutput,
  }, run("list_rfis", () => session.listRfis()));

  server.registerTool("resolve_rfi", {
    description: `Answer an OPEN RFI: the answer lands as its response, status becomes answered (the register's own state for "response in"), and the response date stamps exactly as the panel's would, plus an ISO timestamp of the resolve. Only an open RFI resolves — an answered, closed, or void one is refused rather than re-answered or quietly revived (edit_takeoff {action: "undo"} reverses your own resolve if the answer was wrong). Record the answer the drawings or the architect actually gave; an RFI is not resolved by guessing.`,
    inputSchema: {
      rfi_id: z.string().describe("Record id from create_rfi or list_rfis"),
      answer: z.string().describe("The response — what settles the question"),
    },
    outputSchema: resolveRfiOutput,
  }, run("resolve_rfi", ({ rfi_id, answer }) => session.resolveRfi(rfi_id, answer)));

  server.registerTool("delete_rfi", {
    description: `Withdraw an RFI. A TOMBSTONE, never a renumber: the record stays with its number reserved, so the register and the marked set keep printing a gap where it was and the next RFI takes the next number — an RFI number that went out and then meant something else would be a lie. Every markup linked to it keeps its note and loses the link (the canvas's own delete rule). Withdraw a question you raised in error; a question the architect answered is closed in the register, not deleted. Journaled; edit_takeoff {action: "undo"} puts the record and its links back.`,
    inputSchema: {
      rfi_id: z.string().describe("Record id from create_rfi or list_rfis"),
    },
    outputSchema: deleteRfiOutput,
  }, run("delete_rfi", ({ rfi_id }) => session.deleteRfi(rfi_id)));
}
