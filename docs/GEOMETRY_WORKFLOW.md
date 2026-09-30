# Geometry from source to review

An accurate total is insufficient: the geometry must follow the finish boundaries on the drawing. This workflow uses OpenTakeoff's public tools and requires no other takeoff application. Tool schemas at discovery are the parameter reference; this page explains the measurement decisions.

## Establish the coordinate frame

1. `open_drawings {action: "load"}`, then `open_drawings {action: "info"}`, `find_text {action: "read"}`, and `view_sheet`: identify the finish plan, schedule, enlarged details, and elevations. A schedule search is a lead; inspect the sheet when it misses a table or resolves an unrelated label.
2. `set_scale`: use the scale for the particular detail being measured. A sheet can contain several scales. An agent-set scale remains unconfirmed until a human confirms it.
3. Read the sheet pixel dimensions and each view's returned region and image dimensions. Tool geometry is in full-sheet image pixels. A crop is not a new coordinate system for measurement inputs.

For an unrotated crop, convert a displayed point `(u, v)` back to the sheet with `x = x0 + u * (x1 - x0) / image_width` and the equivalent formula for `y`. Stored `verts_norm` are normalized coordinates; never pass them directly to a measurement tool expecting pixels. Check a known dimension before committing the whole floor.

## Trace the finish boundary

Use `view_sheet` for a close view and `sheet_context {action: "vectors"}` for precise candidate endpoints. PDF vectors include tile joints, equipment, door swings, wall faces, white overdraw, and unrelated details. A closed path is evidence of drawing structure, not proof of an installed floor boundary.

Inspect candidates against the rendered plan. Follow the innermost interior wall face, step around columns, chases and wall stubs, preserve chamfers, and distinguish a finish split from a wall. Cross every door or cased opening on the wall centerline so both rooms share that segment; run straight past windows; never trace a hatch edge, casework or a door leaf drawn standing open. A curved wall is a circle: mark one point on the bow with `arc_through` instead of chording it or hand-placing points along it. The full rule set is in the [workflows page](wiki/workflows.md#trace-a-room-the-way-an-estimator-does), and it is what the plan-set references are drawn to. Prefer the enlarged plan for small rooms. If it replaces an area measured on the overall plan, exclude that area from the overall trace so it is measured once.

Start a named batch with `proposal {action: "propose"}`, then use `measure {kind: "area"}` for floor areas and explicit deductions. The proposal tool starts the group; measurements create its shapes. Commit a small batch, inspect it with `view_sheet` with overlays, and use `edit_takeoff {action: "edit"}` for corrections. Label each room or run consistently, and keep sheet/detail evidence in proposal rationale and annotations.

## Base, walls, and transitions need their own geometry

- **Base:** `derive {action: "base"}` reads each room's ring against the drawn walls and commits the runs where the base is installed: doors (over the drawn break at the door), openings with no door and open sides are cut out, and columns cut out of a room get base round them, windows and junction breaks are not. Rooms whose ring leaves the walls, and sheets whose walls cannot be read, are flagged rather than measured. Fitted kitchens, casework and stairs are not deducted: cut them with `derive {action: "deduct"}` where the drawing shows them. Openings you state for a room replace its whole reading with a numeric allowance on the perimeter; do not clip such a perimeter: that operation refuses because the locations are unknown. Inspect door jambs, alcove entrances, columns, and open finish splits individually. Do not deduct an apparent opening based only on a low-resolution overview.
- **Wall tile:** use `measure {kind: "surface"}` for the actual wall run and its height. Read elevation height and termination changes. Stepped faces can require separate bands; door/window deductions need explicit geometry. `derive {action: "deduct"}` removes the full height of the run it clips; for a partial-height opening, use separately measured vertical bands and clip only the affected band. A generic `deduct` subtracts floor SF and is not a wall-opening record. Do not multiply one elevation width by the number of room walls when the room has chamfers or different lengths.
- **Transitions:** `derive {action: "transitions"}` produces candidates at shared finish edges and withholds wall-separated runs. Inspect those candidates and withheld runs at the actual doorway. Add an explicit measured threshold when source evidence supports it. Do not assume a walk-in requires a saddle.
- **Supporting materials:** use `conditions {action: "materials"}` on the measured finish condition for membrane or protection coverage. Separate coincident floor polygons obscure the finish overlay and generate intentional overlap reports. Material coverage uses measured quantities; condition waste does not automatically increase material-row quantities.

## Verify the geometry, then hand it off

Inspect the final overlay at both the whole-area and detail scale. Check corners, finish changes, columns, openings, and deductions. Run `conditions {action: "scope_duplicates"}` for unintended overlap, and inspect its geometry rather than treating a rounded zero-area warning as an additional room. Machine-precision remnants are ignored; genuine sub-cent SF overlaps remain flagged with an explanation. Compare floor area, base length, and wall area separately; their grand total is not the building's floor area.

Use `summary` and `export {action: "report"}` to check totals and material coverage. Save with `export {action: "takeoff"}`, then start a fresh session, load the same source, and `export {action: "import"}` to verify the handoff. In the browser, open the original PDF before importing the takeoff JSON. Inspect the pending proposals and Report without stamping human approval.

Use `annotate {action: "list"}` and `annotate {action: "edit"}` to shorten crowded notes; one `edit_takeoff {action: "undo"}` restores the prior text. RFI-linked notes require review in the browser register.

Export with `export {action: "marked_pdf"}` and inspect the actual PDF, including cover units and all marked sheets. It contains marked sheets and schedules, not necessarily every source page. Keep unresolved finish locations as explicit qualifications or RFIs. Agents may mark their own checks, but cannot create human approval.

## Reusable evidence from a project test

Retain source hashes, source revision, scale choices, tool inputs/replies, final geometry, overlay images, and the exported report. A comparison against prior work should report spatial overlap as well as quantities and disclose whether the reference helped correct the result. It is a reference-assisted test when that happened, not an independent accuracy benchmark.

Use private plans locally unless publication is authorized. Put generic regression fixtures and lessons in the public repository. Do not require public agents to know a private application's tools or coordinate conventions.

The [public MCP workflow benchmark](../evals/mcp-workflow-bench/README.md)
exercises the built server on a synthetic plan, checks
boundaries separately from quantities, and reopens the export in a fresh process.
Its analytic answer key tests conformance; it is not evidence of accuracy across
real plans. The [recorded agent pilot](../evals/mcp-workflow-bench/evidence/README.md)
preserves a first-pass failure and an explicitly assisted correction.

The same harness also carries an estimator-trace [plan set](../evals/mcp-workflow-bench/plan-set/README.md):
three public real floor plans (a VA healthcare finish plan, a VA clinic office
floor plan and a city public-domain accessory-dwelling plan) with reference rings
traced to the interior wall face, door jambs notched to the wall centerline, one
ring per room and floor finish. The rings were prepared from the PDF vector
linework by an agent and are a proposed reference until a human has reviewed the
overlays; the scripted known-answer runs prove the tools carry those rings, not
that any agent can draw them.
