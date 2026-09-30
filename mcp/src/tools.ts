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

  server.registerTool("conditions", {
    description: "Set up conditions and check scope. edit: an existing condition's knobs — waste_pct, multiplier (×N floors), height_ft for surface, rise_ft/drop_ft defaults for its runs, roll_setup (roll goods; null opts out). duplicate: twin a condition under label, the same finish in another area; the twin follows the original's materials until split. split: end a twin's inheritance. materials: add, remove or patch coverage-rate rows (basis ÷ per = order quantity). scope_duplicates: floor claimed twice, as pairs. scope_merge: resolve one pair. Each write is one undo step.",
    inputSchema: {
      action: z.enum(["edit", "duplicate", "split", "materials", "scope_duplicates", "scope_merge"]),
      condition: z.string().optional().describe("edit, duplicate, split, materials: the finish tag, e.g. 'CPT-1' (materials mints it on first use)"),
      waste_pct: z.number().min(0).optional().describe("edit: waste percentage on net order quantities, e.g. 10"),
      multiplier: z.number().positive().optional().describe("edit: ×N identical areas (0 is refused; the canvas reads it as 1)"),
      height_ft: z.number().positive().optional().describe("edit: wall height, feet — what measure {kind: \"surface\"} multiplies LF by"),
      rise_ft: z.number().min(0).optional().describe("edit: default vertical leg up every linear run adds, feet; 0 turns it off"),
      drop_ft: z.number().min(0).optional().describe("edit: default vertical leg down every linear run adds, feet; 0 turns it off"),
      roll_setup: z.object({
        material: z.enum(["carpet", "sheet_vinyl", "rubber"]).optional().describe("Material class; a fresh opt-in starts from its defaults"),
        roll_width_ft: z.number().positive().optional(),
        roll_length_ft: z.number().min(0).optional().describe("Physical roll length; 0 = unlimited"),
        seam_allowance_in: z.number().min(0).optional(),
        wall_overage_in: z.number().min(0).optional(),
        doorway_overage_in: z.number().min(0).optional(),
        direction: z.enum(["auto", "ns", "ew"]).optional().describe("Run direction; auto lets the engine pick per room"),
        price_unit: z.enum(["sy", "sf", "lf"]).optional().describe("Sell unit the order quantity is figured in"),
      }).nullable().optional().describe("edit: roll-goods setup (seams, cuts, order footage); partial edits patch it; null opts out"),
      label: z.string().optional().describe("duplicate: what makes the twin different, e.g. 'Level 2' (its tag becomes 'CPT-1 – Level 2')"),
      add: z.array(z.object({
        name: z.string().min(1),
        per: z.number().min(0).optional().describe("Coverage rate: basis units per purchase unit, e.g. 250 (default 0)"),
        basis: z.enum(["area", "linear", "count", "seam_lf"]).optional().describe("Total the row divides: area (default), linear, count, or seam_lf (figured roll seams)"),
        unit: z.string().optional().describe("Purchase unit, e.g. 'gal', 'bag'"),
        round: z.boolean().optional().describe("Round up to whole purchase units (default true)"),
        note: z.string().optional(),
      })).optional().describe("materials: new rows"),
      remove: z.array(z.string()).optional().describe("materials: row ids to remove"),
      patch: z.array(z.object({
        id: z.string(),
        fields: z.record(z.union([z.string(), z.number(), z.boolean()])).describe("name/per/basis/unit/round/note values"),
      })).optional().describe("materials: field changes on existing rows"),
      sheet: z.string().optional().describe("scope_duplicates: only this sheet; omit for every sheet"),
      min_fraction: z.number().min(0).max(1).optional().describe("scope_duplicates: list a pair when shared ÷ smaller ≥ this (default 0.05)"),
      shape_a: z.string().optional().describe("scope_merge: one floor shape of the pair"),
      shape_b: z.string().optional().describe("scope_merge: the other"),
      winner: z.string().optional().describe("scope_merge: the shape that keeps the shared floor; omit to let the reviewed one win"),
    },
    outputSchema: perAction("action", ["edit", "duplicate", "split", "materials", "scope_duplicates", "scope_merge"],
      editConditionOutput, duplicateConditionOutput, splitConditionOutput, editMaterialsOutput, scopeDuplicatesOutput, scopeMergeOutput),
  }, run("conditions", async (a) => {
    switch (a.action) {
      case "scope_duplicates":
        return { action: "scope_duplicates", ...(await session.scopeDuplicates({ sheet: a.sheet, min_fraction: a.min_fraction })) };
      case "scope_merge": {
        need("conditions", "scope_merge", a, "shape_a", "shape_b");
        // the Session names the loser's fate `action`; the tool's own action field owns that key
        const { action: outcome, ...merged } = await session.scopeMerge({ shape_a: a.shape_a, shape_b: a.shape_b, winner: a.winner });
        return { action: "scope_merge", outcome, ...merged };
      }
      case "duplicate":
        need("conditions", "duplicate", a, "condition", "label");
        return { action: "duplicate", ...(await session.duplicateCondition(a.condition, a.label)) };
      case "split":
        need("conditions", "split", a, "condition");
        return { action: "split", ...(await session.splitCondition(a.condition)) };
      case "materials":
        need("conditions", "materials", a, "condition");
        return { action: "materials", ...(await session.editMaterials(a.condition, { add: a.add, remove: a.remove, patch: a.patch })) };
      default:
        need("conditions", "edit", a, "condition");
        return { action: "edit", ...(await session.editCondition(a.condition, { waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, roll_setup: a.roll_setup, rise_ft: a.rise_ft, drop_ft: a.drop_ft })) };
    }
  }));

  server.registerTool("proposal", {
    description: "Group your work for one estimator decision. propose: open a named batch before committing; every shape committed afterwards attaches to it, and the estimator accepts the batch with one click. revise: replace every still-pending shape of a batch in one step. withdraw: remove a batch's pending shapes. propose_condition_edit: hold a change to a condition's tag or knobs pending the estimator's acceptance instead of making it. withdraw_condition_edit: drop that pending change. Shapes the estimator accepted are ink and stay. Each call is one undo step.",
    inputSchema: {
      action: z.enum(["propose", "revise", "withdraw", "propose_condition_edit", "withdraw_condition_edit"]),
      label: z.string().min(1).optional().describe("propose: the batch title the estimator reads on the Accept pill"),
      rationale: z.string().min(1).optional().describe("propose, propose_condition_edit: what decided it — the schedule row, sheet, spec or rule"),
      proposal_id: z.string().optional().describe("revise, withdraw: the batch; withdraw_condition_edit: the pending condition edit"),
      shapes: z.array(z.object({
        sheet: z.string().describe("Sheet key or title-block number"),
        condition: z.string().describe("Finish tag, minted on first use"),
        role: z.enum(["floor_area", "deduct", "linear", "surface_area", "count"]),
        points: z.array(point()).min(1).describe("Image px: a ring for areas (≥3), a run for linear/surface (≥2), one point for a count"),
        label: z.string().optional().describe("The room this shape belongs to"),
        height_ft: z.number().positive().optional().describe("surface_area: height when the condition has none"),
      })).min(1).optional().describe("revise: the replacement batch, validated whole before anything is removed"),
      condition: z.string().optional().describe("propose_condition_edit: finish tag of an existing condition"),
      finish_tag: z.string().min(1).optional().describe("propose_condition_edit: proposed new tag (a rename)"),
      waste_pct: z.number().min(0).optional().describe("propose_condition_edit: proposed waste %"),
      multiplier: z.number().positive().optional().describe("propose_condition_edit: proposed ×N multiplier"),
      height_ft: z.number().positive().optional().describe("propose_condition_edit: proposed wall height, feet"),
      rise_ft: z.number().min(0).optional().describe("propose_condition_edit: proposed default vertical leg up for runs, feet"),
      drop_ft: z.number().min(0).optional().describe("propose_condition_edit: proposed default vertical leg down for runs, feet"),
      roll_setup: z.object({}).passthrough().nullable().optional().describe("propose_condition_edit: proposed roll-goods setup, or null to propose opting out"),
    },
    outputSchema: perAction("action", ["propose", "revise", "withdraw", "propose_condition_edit", "withdraw_condition_edit"],
      proposeTakeoffOutput, reviseProposalOutput, withdrawProposalOutput, proposeConditionEditOutput, withdrawConditionEditOutput),
  }, run("proposal", async (a) => {
    switch (a.action) {
      case "propose":
        need("proposal", "propose", a, "label", "rationale");
        return { action: "propose", ...(await session.proposeTakeoff(a.label, a.rationale)) };
      case "revise": {
        need("proposal", "revise", a, "proposal_id", "shapes");
        const shapes = a.shapes.map(({ points, ...rest }: any) => ({ ...rest, verts: points }));
        return { action: "revise", ...(await session.reviseProposal(a.proposal_id, shapes)) };
      }
      case "withdraw":
        need("proposal", "withdraw", a, "proposal_id");
        return { action: "withdraw", ...(await session.withdrawProposal(a.proposal_id)) };
      case "withdraw_condition_edit":
        need("proposal", "withdraw_condition_edit", a, "proposal_id");
        return { action: "withdraw_condition_edit", ...(await session.withdrawConditionEdit(a.proposal_id)) };
      default:
        need("proposal", "propose_condition_edit", a, "condition", "rationale");
        return {
          action: "propose_condition_edit",
          ...(await session.proposeConditionEdit(a.condition, { finish_tag: a.finish_tag, waste_pct: a.waste_pct, multiplier: a.multiplier, height_ft: a.height_ft, rise_ft: a.rise_ft, drop_ft: a.drop_ft, roll_setup: a.roll_setup }, a.rationale)),
        };
    }
  }));

  server.registerTool("review", {
    description: "Your verdict on work you checked: the AGENT diamond. mark: on a committed shape (shape_id) or at a sheet point (sheet + at), exactly one target; optional text rides every export. One mark per shape: delete, then mark again. delete: lift one of your marks by verdict_id. The estimator's APPROVED ring is human ink: it cannot be minted or lifted here. A verdict touches no quantity and gates nothing. annotate {action: \"list\"} lists every mark in verdicts[].",
    inputSchema: {
      action: z.enum(["mark", "delete"]),
      shape_id: z.string().optional().describe("mark: a committed shape (edit_takeoff {action: \"list\"} has the ids)"),
      sheet: z.string().optional().describe("mark: the sheet, together with at, for a sheet-point mark"),
      at: point().optional().describe("mark: where the diamond renders (image px), together with sheet"),
      text: z.string().optional().describe("mark: a short note riding the record; the glyph always reads AGENT"),
      verdict_id: z.string().optional().describe("delete: the record id from mark or annotate list's verdicts[]"),
    },
    outputSchema: perAction("action", ["mark", "delete"], markVerdictOutput, deleteVerdictOutput),
  }, run("review", async (a) => {
    if (a.action === "delete") {
      need("review", "delete", a, "verdict_id");
      return { action: "delete", ...(await session.deleteVerdict(a.verdict_id)) };
    }
    // the set_scale convention: one target, stated exactly, refused otherwise
    const byShape = a.shape_id !== undefined;
    const byPoint = a.sheet !== undefined || a.at !== undefined;
    if (byShape === byPoint) throw new UserError("review mark needs exactly one target: shape_id (mark a committed shape), or sheet + at (mark a sheet point).");
    if (byPoint && (a.sheet === undefined || a.at === undefined)) throw new UserError("A sheet-point verdict needs BOTH sheet and at: [x, y] (image px).");
    return { action: "mark", ...(await session.markVerdict({ shape_id: a.shape_id, sheet: a.sheet, at: a.at, text: a.text })) };
  }));

  server.registerTool("rfi", {
    description: "The RFI register: questions for the architect when the drawings contradict themselves or cannot answer, e.g. a schedule row the plan never draws or a finish called out two ways. create: numbered next in the register, pending until the estimator accepts it, printed in the marked set; link markup_ids (annotate a cloud at the conflict first). list: every RFI with status, links and the scopes it touches; read it before raising a duplicate. resolve: record the answer to an open RFI. delete: withdraw one; its number stays reserved. Each write is one undo step.",
    inputSchema: {
      action: z.enum(["create", "list", "resolve", "delete"]),
      title: z.string().optional().describe("create: the one-line subject the register prints"),
      question: z.string().optional().describe("create: what the architect must answer, stated so a reply can settle it"),
      sheet: z.string().optional().describe("create: the sheet the question is about"),
      markup_ids: z.array(z.string()).optional().describe("create: annotation ids to link; they carry the RFI number on the sheet"),
      rfi_id: z.string().optional().describe("resolve, delete: the record id from create or list"),
      answer: z.string().optional().describe("resolve: the response that settles the question"),
    },
    outputSchema: perAction("action", ["create", "list", "resolve", "delete"], createRfiOutput, listRfisOutput, resolveRfiOutput, deleteRfiOutput),
  }, run("rfi", async (a) => {
    switch (a.action) {
      case "list":
        return { action: "list", ...(await session.listRfis()) };
      case "resolve":
        need("rfi", "resolve", a, "rfi_id", "answer");
        return { action: "resolve", ...(await session.resolveRfi(a.rfi_id, a.answer)) };
      case "delete":
        need("rfi", "delete", a, "rfi_id");
        return { action: "delete", ...(await session.deleteRfi(a.rfi_id)) };
      default:
        need("rfi", "create", a, "title", "question", "sheet");
        return { action: "create", ...(await session.createRfi({ title: a.title, question: a.question, sheet: a.sheet, markup_ids: a.markup_ids })) };
    }
  }));

  server.registerTool("annotate", {
    description: "Notes about the work, never measurements of it. add: a note on a sheet by type — cloud and highlight take rect, text and bubble take at, callout takes at + target, arrow and dimension take from + to (a dimension labels its real length, so it needs the scale). Pass condition to attach the note to a finish tag's scope. list: annotations and verdict marks, filtered by sheet or condition. edit: replace or clear one annotation's text (not an RFI-linked one). link: attach an annotation to a condition; condition \"\" detaches it. Each write is one undo step.",
    inputSchema: {
      action: z.enum(["add", "edit", "link", "list"]),
      sheet: z.string().optional().describe("add: the sheet; list: only this sheet"),
      type: z.enum(["cloud", "text", "callout", "highlight", "arrow", "bubble", "dimension"]).optional().describe("add: the kind of note"),
      text: z.string().optional().describe("add: the note (default empty); edit: the replacement, empty clears it"),
      condition: z.string().optional().describe("add, link: finish tag to attach to (minted on first use; \"\" detaches on link); list: only this tag"),
      at: point().optional().describe("add: anchor of text, callout and bubble (the circle's center)"),
      target: point().optional().describe("add: the point a callout's leader aims at"),
      rect: z.array(point()).length(2).optional().describe("add: [[x0,y0],[x1,y1]] corners of a cloud or highlight"),
      from: point().optional().describe("add: arrow tail or dimension start"),
      to: point().optional().describe("add: arrow head or dimension end"),
      r: z.number().positive().optional().describe("add: bubble radius (default 2% of sheet width)"),
      annotation_id: z.string().optional().describe("edit, link: the annotation's id from add or list"),
    },
    outputSchema: perAction("action", ["add", "edit", "link", "list"], annotateOutput, editAnnotationOutput, linkAnnotationOutput, listAnnotationsOutput),
  }, run("annotate", async (a) => {
    switch (a.action) {
      case "list":
        return { action: "list", ...(await session.listAnnotations({ sheet: a.sheet, condition: a.condition })) };
      case "edit":
        need("annotate", "edit", a, "annotation_id", "text");
        return { action: "edit", ...(await session.editAnnotation(a.annotation_id, a.text)) };
      case "link":
        need("annotate", "link", a, "annotation_id", "condition");
        return { action: "link", ...(await session.linkAnnotation(a.annotation_id, a.condition)) };
      default:
        need("annotate", "add", a, "sheet", "type");
        return {
          action: "add",
          ...(await session.annotate({ sheet: a.sheet, type: a.type, text: a.text ?? "", condition: a.condition, at: a.at, target: a.target, rect: a.rect, from: a.from, to: a.to, r: a.r })),
        };
    }
  }));
}
