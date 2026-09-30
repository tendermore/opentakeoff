# OpenTakeoff MCP server

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.Kentucky-ai/opentakeoff`, on [Glama](https://glama.ai/mcp/servers/Kentucky-ai/opentakeoff),
and on [Smithery](https://smithery.ai/servers/Kentucky-ai/opentakeoff).

**This page is the reference—every tool, every rule, every limit.** For *how to run a
takeoff well* with it—the operating model, the standard finish, what the engine withholds
and why, and the move that answers each refusal—read
[`docs/AGENT_GUIDE.md`](../docs/AGENT_GUIDE.md) first. It's short, and it's the half that
decides whether the numbers are any good.

## Run it in 60 seconds (npx)

No clone, no build—point your MCP client at the published package:

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}
```

Works with Claude Code (`claude mcp add opentakeoff -- npx -y opentakeoff-mcp`), Claude Desktop, Cursor, or any stdio MCP client. Node 20+.

## One-click install (Claude Desktop)

No Node, no npm: download **`opentakeoff-mcp.mcpb`** from the
[latest release](https://github.com/Kentucky-ai/opentakeoff/releases) and
double-click it—Claude Desktop installs the server with its dependencies
bundled. Built by `npm run mcpb` and attached automatically to every `mcp-v*`
release. The bundle is platform-neutral on purpose: it excludes the optional
native canvas, so every JSON tool and the text/metadata resources work
everywhere; the sheet-image resource and the `view_sheet` tool say exactly
what's missing where rendering isn't available.

## One-Click is temporarily gated

`takeoff_rooms` is **not registered** on a default build while the flood
engine is re-validated against a wider plan corpus: `tools/list` never names it, the
initialize `instructions` say so and point at `measure {kind: "area"}`, and no other tool's
description sends an agent to a tool that is not there. A default build registers
**<!--tool-count-->17<!--/tool-count--> tools**. Everything else — sweeps, counts, `derive {action: "base"}`, `derive {action: "transitions"}`, the
exports — is unchanged. Set `OPENTAKEOFF_ONE_CLICK=1` in the server's environment to
register it (<!--tool-count-all-->18<!--/tool-count-all--> tools); the parity, conformance and e2e tests run that way, and
`test/gate.test.ts` pins both surfaces. The rows and examples below that use `takeoff_rooms`
describe the lifted build. Design note: [`docs/design/ONE_CLICK_GATE.md`](../docs/design/ONE_CLICK_GATE.md).


The takeoff engine—scale model, conditions and totals—on **stdio for your MCP
client**. An agent can open a plan, read the title block, set the scale, inspect
source geometry and commit defensible measurements. The server imports shared
web modules, so quantity math and takeoff records are compatible with the
canvas. Browser and MCP room-detection paths currently differ; a shared module
does not establish identical boundaries on every plan. See the [capability
status](../docs/wiki/status.md) and [compatibility matrix](../protocol/COMPATIBILITY.md)
before claiming detector parity or a lossless handoff.

## Run with Docker

Build from the repository root so the Dockerfile can bundle the shared web
engine:

```bash
docker build -f mcp/Dockerfile -t opentakeoff-mcp .
docker run --rm -i opentakeoff-mcp
```

Mount local plans read-only and pass that container path to `open_drawings {action: "load"}`:

```bash
docker run --rm -i -v "$PWD/demo:/plans:ro" opentakeoff-mcp
docker run --rm -i -e OPENTAKEOFF_MCP_TRACE=1 -v "$PWD/demo:/plans:ro" opentakeoff-mcp
```

For example, load `/plans/sample-plan.pdf` after mounting `demo/`.

## Run over HTTP (sandbox or service)

`http.ts` serves the same tools over MCP Streamable HTTP, for a host that runs the engine as its own process and reaches it over a port:

```bash
OPENTAKEOFF_HTTP_TOKEN=<secret, 16+ chars> node --import tsx http.ts
```

- Endpoint `POST/GET/DELETE /mcp`; every request needs `Authorization: Bearer <secret>`. `GET /healthz` is open.
- Each MCP session gets its own takeoff session (plans, scales, shapes), so one process serves several clients.
- `OPENTAKEOFF_HTTP_HOST` (default `127.0.0.1`), `OPENTAKEOFF_HTTP_PORT` (default `8765`), `OPENTAKEOFF_HTTP_IDLE_MS` (idle sessions closed, default 45 min), `OPENTAKEOFF_HTTP_MAX_SESSIONS` (default 32).

## Quickstart

Both `web/` and `mcp/` need their dependencies (the engine's pdf.js lives in
`web/node_modules`):

```bash
cd web && npm install
cd ../mcp && npm install
node --import tsx server.ts        # speaks MCP on stdio
```

Then register it with your MCP client (any stdio MCP client works):

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/opentakeoff/mcp/server.ts"]
    }
  }
}
```

Point `command` at `node` directly, as above—**never `npm start` in a client
config**: npm prints its banner to stdout, and stdout is the MCP wire. (Same
reason the server redirects `console.log` to stderr before pdf.js loads—see
`src/hush.ts`.)

`tsx` is a runtime dependency, not a build tool: the engine is imported
straight from `web/src/lib` as TypeScript, so plain `node` can't run it.

For tool-call debugging, opt into structured stderr tracing:

```bash
OPENTAKEOFF_MCP_TRACE=1 node --import tsx server.ts
```

Each tool call writes one JSON line to stderr with the tool name, its action
(or kind), duration, sheet, result size, and error flag. The trace never writes to stdout and never
includes document text, shape vertices, or result payload content.

## Tools

The [generated tool index](../docs/MCP_TOOL_INDEX.md) lists each tool's actions and required arguments from the runtime schemas; CI rejects stale output and missing reference rows. The [tool reference](../docs/wiki/tools.md) (`takeoff://wiki/tools`) explains every action in depth. Every tool takes one flat input, with an `action` (or `kind`) naming what to do.

| Tool | What it does |
|---|---|
| `open_drawings` | `load` a plan PDF from disk (replaces the session; **`merge: true` ADDS the document to the working set**, #152—plans + schedule + addenda as one takeoff) or `info`: without `sheet`, every loaded sheet with scale status and shape count; with `sheet`, that sheet's dims, vector segment count, detected scale and PDF layer table. |
| `set_scale` | Set a sheet's scale—exactly one of `label`, `upp`, `calibrate {p1, p2, feet}`, `use_detected`. **Lands unconfirmed** (`confirmed: false`) until a human confirms in the canvas—see Scale rules. |
| `sheet_context` | `context` (default): a region's classified segments, text spans and hatch families in one frame, decimation declared and counted. `graph`: the plan-set index (#87)—sheet roles, schedule tables, corroborated rooms, unmatched tags with reasons, detail callouts, revisions. `vectors`: the raw strokes (#367) exactly as the engine is fed them, paged with `offset + returned + dropped === total`; refuses on a scan and names `view_sheet`. |
| `view_sheet` | The agent's eyes: render the sheet (or an image-px crop) to PNG. `overlay` burns committed shapes in (solid = human-affirmed, dashed = unreviewed); `grid` burns in a calibrated 1-ft/5-ft measuring grid; `marks` (#297) burns in disclosure layers—`question` (withheld), `struck` (rejected), `ring` (reference)—so what a reply names, the picture shows. |
| `find_text` | `find`: where a known string sits (case-insensitive substring per text run). `read`: positioned page text, optionally in a region. `find_text {action: "resolve_tag"}`: ONE room tag → its room-finish schedule row → each code's definition, every edge cited (sheet + literal text + bbox); `unresolved`/`ambiguous` come back with reasons, never as silence. |
| `takeoff_rooms` | **Temporarily gated — not registered unless `OPENTAKEOFF_ONE_CLICK=1`.** `detect` (default): every room label on the sheet flooded through the sealed engine (ink flood, walls-only masks, net/drawn candidates, printed-area check); each room returns label, area, printed area, `method` and the engine's confidence account, and everything skipped is counted and reasoned in `withheld`. `at`: One-Click Area at one point, the SAME feet-true engine the canvas runs at a click (pinned in `test/parity.test.ts`); a scanned sheet falls back to rendered pixels, disclosed as `raster_traced` (#154). Commit with `condition`, or `assign_from_schedule` for each room's own schedule row. |
| `count` | EA counts. `doors`: every hinged door on a sheet from its drawn swing—one per door, double leaves one, widths, non-door curves listed as `rejected`; needs the sheet's scale. `symbol`: one point on an example → every copy from the linework (right angles, the plan's wing angles, mirrored), a numbered picture plus a close-up of the example; `drop`, `level`, `include_loose`, `add_withheld`, then `commit`—marks already counted under the condition never count twice. `sweep`: the same search from a tight `seed_rect`, set-wide (`scope: "set"`), with counter-examples (`exclude`), a luminance gate and label disclosure. `place`: markers at points you already located. `marks`: census of value-annotated schedule marks. No scale required. |
| `measure` | `kind: "area"`: a polygon you supply (≥3 points), `role: "deduct"` subtracts. `kind: "length"`: an open polyline (≥2 points), with per-run `rise_ft`/`drop_ft` legs (#441). `kind: "surface"`: wall SF = traced LF × the condition's height (`height_ft`). `arc_through` bends a curved wall. Requires scale. |
| `derive` | `deduct`: a real hole in a committed floor shape (#206)—the canvas's own `lib/cutout.js` subtract—or a clipped stretch of an open run; refuses a ring not fully inside the parent. `base`: base LF from committed rooms, net of the doors drawn on each room's ring; openings you state for a room replace them. `transitions`: where two finishes meet—butt joints and door thresholds commit, wall-separated runs with no door return in `withheld` with an `at` point. Each call is one undo step. |
| `schedule` | `find`: a schedule table by kind ("room finish", "material", or "equipment")—sheet, title, headers, row count, a `view_sheet`-ready region. `sweep_row`: take off a schedule row's mark from the row itself—geometry AND tag text agreeing, refusal over guessing. `schedule {action: "apply_rules"}`: re-run the correction rules (#207) an imported takeoff carries, one undo step. |
| `edit_takeoff` | `list`: the mid-session inventory—every shape's id, sheet, condition, role, quantities, room `label`, review state and assignment verdict. `edit`: new `points`, `condition`, `role`, `label` or rise/drop on a shape you committed—quantities recomputed; refuses shapes a human affirmed. `delete`: remove a shape by id. `undo`: step back over your own last `n` mutations, exact inverses (a whole room detection is one step). |
| `summary` | Per-condition totals + grand totals, computed by the Report's rules. |
| `export` | `marked_pdf`: the **marked-up planset**—the deliverable (legend cover + every worked sheet with the work burned in; machine-traced shapes disclosed as pending review). `report`: the computed `opentakeoff.report.v1` document with the materials buy list, for pricing. `takeoff`: the full `opentakeoff.takeoff_canvas.v1` payload the app autosaves. `dxf`: one sheet as a DXF (R2000) in real units (`path` required). `import`: load a `takeoff_canvas.v1` file back in through the app's own merge rules. `path` writes to disk (see **Writing to disk** below). |
| `conditions` | Condition setup and scope checks. `edit`: an existing condition's **waste %**, **×N multiplier**, **height_ft** (the H knob `measure {kind: "surface"}` quantifies against), `rise_ft`/`drop_ft` defaults for its runs (#441), and **roll_setup** (the roll-goods opt-in, #147: seams figured, cuts packed, the reply echoes the order; `null` opts out)—so an agent's takeoff doesn't ship net === gross (#131). `duplicate`: **twin a condition** under a `label` (`CPT-1` + `Level 2` → `CPT-1 – Level 2`)—the same finish in another area, **following** the original's material rows until it edits one. `split`: cut a twin loose; following rows freeze. `materials`: add/remove/patch supporting-materials rows (coverage rate `per`, `basis` `area` \| `linear` \| `count` \| **`seam_lf`**—the *figured* roll-layout seam length). `scope_duplicates` (#366): every pair of committed floor shapes on one sheet whose exact intersection exceeds `min_fraction` of the smaller, with shared SF and a `look` region; `shared_floor_sf` has to read 0. `scope_merge`: resolve one pair—the loser is trimmed to its remainder or deleted when the overlap is near-total; the reply's `outcome` says which. Reviewed shapes are ink. Every write is one `edit_takeoff {action: "undo"}` step. |
| `proposal` | Group agent work for one estimator decision (#365). `propose`: open a named batch (`label`, `rationale`); every shape committed afterwards attaches to it (`origin.proposal_id`), so the estimator sees ONE Accept pill. `revise`: replace **every still-pending shape** in a batch as one journal step, validated whole first (each entry's `points`, `role`, `sheet`, `condition`). `withdraw`: remove a batch's pending shapes; accepted shapes stay. `propose_condition_edit`: a diff—new `finish_tag`, `waste_pct`, `multiplier`, `height_ft`, `rise_ft`/`drop_ft`, `roll_setup`—held pending until the estimator accepts; `summary` and `export {action: "report"}` carry it beside the current values. `withdraw_condition_edit`: drop that diff. |
| `review` | The **agent's pencil-signature** on work it checked (#176). `mark`: the graphite AGENT diamond on a committed `shape_id` or at `sheet` + `at`, with optional `text`; one mark per shape. `delete`: lift an agent mark by `verdict_id`. The tool takes no actor input, so the estimator's APPROVED ring stays behind the canvas's human-only Approve tool, and a human seal is refused. |
| `rfi` | The RFI register (#364). `create`: raise a Request For Information when the drawing set contradicts itself—next number in the register's own sequence, pending until the estimator accepts it, printed in the marked set; `markup_ids` pins it to annotations. `list`: every RFI with status, `actor`, `pending`, linked markups and the finish tags they touch; `withdrawn[]` explains numbering gaps. `resolve`: answer an **open** RFI. `delete`: withdraw one—a **tombstone, never a renumber**. |
| `annotate` | Notes ABOUT the work, never measurements. `add`: cloud/highlight (`rect`), text (`at`), callout (`at` + `target`), **arrow** (`from` + `to`), **bubble** (`at` + optional `r`), **dimension** (`from` + `to`, labeled with its real length—refused on an unscaled sheet); `condition` attaches it to a finish tag. `list`: every annotation with its condition resolved and coordinates in image px, `unattached`, and `verdicts[]`—the approval family's inventory. `edit`: replace or clear only the text (RFI-linked notes refuse). `link`: attach to a condition, or detach with `""`. |

### The agent revises its own work

`edit_takeoff {action: "edit"}` and `edit_takeoff {action: "undo"}` exist because an agent that can only *append* has
one recovery move: delete and re-derive. The loop they enable instead—**commit
→ `view_sheet overlay:true` → see the ring overshot into the corridor
→ move those two vertices → look again**—is the loop a human estimator
already runs, and it is the difference between an agent that drafts and one
that works.

Two rules hold the surface honest:

- **Ink is not pencil.** A shape carrying `origin.reviewed === true` is work a
  human affirmed, and no agent verb touches it. This server has no review gate
  of its own, so the guard is inert here—it is the contract that makes the
  surface safe to port to a host that *does* have one. The approval family
  holds the same line at the mark itself: `review {action: "mark"}` can mint only the
  AGENT diamond (there is no actor input to misuse), and `review {action: "delete"}`
  refuses the estimator's APPROVED seal outright.
- **Self-revision is not correction.** `edit_takeoff {action: "edit"}` bumps `origin.agent_edits`
  and touches nothing in the human-correction vocabulary (`edited`, `edits`,
  `proposed_verts_norm`). Those fields mean *a human corrected the machine*;
  merging a machine's own fix into them would corrupt the one signal that
  measures whether the machine is getting better.

Every JSON tool declares an **`outputSchema`**, and every reply carries the
payload as **`structuredContent`**—typed, machine-validated on every call—alongside
the same compact JSON in a single text item for clients that predate
structured output. `view_sheet` is the one image tool: its reply is a PNG
content item plus a JSON meta text item (image replies aren't structured
output, so it declares no schema by design). Failures come back as
`isError: true` with `{"error": "..."}`—never a dropped connection.

## Resources — browse before you measure

The [wiki index](../docs/wiki/README.md) is always available as `takeoff://wiki`,
including before `open_drawings {action: "load"}`. Its nine
linked pages use `takeoff://wiki/{page}`: status, architecture, protocol,
workflows, mcp, domain, repo-guide, tools and tool-index. Read only the page relevant
to the current task. These are static public Markdown resources, not tools;
reading them cannot change geometry, scale or review.

Pages are embedded in the published MCP bundle with its version and an
LF-normalized source hash. Wiki links navigate to packaged resources; links to
repository code browse `main` and may be newer. Unknown resource paths refuse;
there is no filesystem path or remote URL input. `npm run check:wiki` compares
the embedded copy to source; `-- --write` regenerates it. Build and CI fail when
it is stale. The distribution smoke check reads all ten pages over stdio.

MCP 0.9.82 also embeds the explicit allowlist of draft Takeoff Protocol schemas
as read-only resources. Read `takeoff://protocol` for the machine-readable
index, then a schema such as
`takeoff://protocol/v1/measurement.schema.json`. This route is available before
plan load; it adds no tool and does not change
`exportPayload()` or any writer. The URI is a transport address separate from
the unchanged schema `$id`; the `$id` is an offline-resolution identifier, not
a hosted-file promise. See `takeoff://wiki/protocol` for scope and limitations.

The generated registry is checked with `npm run check:protocol-resources`; it
must remain current before building or publishing the package.

Tools let an agent act; resources let it **see**. When a plan loads, the sheet
set becomes browsable natively (`resources/list` re-announces itself through
`list_changed`):

| URI | Contents |
|---|---|
| `takeoff://sheets` | The plan index—file, page count, every sheet's dims, title-block number, detected scale, scale state, shape count. Always listed; before any plan loads it says so and points at `open_drawings {action: "load"}`. |
| `takeoff://sheet/{page}` | One sheet's metadata (JSON), addressed by 1-based page number. |
| `takeoff://sheet/{page}/text` | The sheet's text, joined—title block, room labels, schedules. Positions live in the `find_text {action: "read"}` tool. |
| `takeoff://sheet/{page}/image` | The page rendered to PNG, long edge capped at **1568 px**—the native resolution of vision-model eyes. Rendered lazily, cached until the next `open_drawings {action: "load"}`. |

Page numbers—not file-derived sheet keys—address resources, so URIs stay
clean regardless of the PDF's name; the human-facing key (`plan.pdf#2`) and
title-block number (`A-101`) ride along as the resource name and title.
Rendering uses `@napi-rs/canvas`, declared as this package's own optional
dependency so a plain `npx opentakeoff-mcp` installs the prebuilt binary and
arrives with eyes; on a platform without a prebuilt binary every non-raster
capability still works and the image read explains exactly what's missing.

The intended agent loop: read `takeoff://sheets` → look at
`takeoff://sheet/{page}/image` → pick click targets → measure with the tools.
An image coordinate maps to the tool space (image px at render scale 2.0) by
multiplying by `width_px / <image pixel width>`.

## The coordinate contract

All coordinates are **image pixels at render scale 2.0**: PDF points × 2,
origin **top-left**, y **down**. This is the browser canvas's native space, so
coordinates round-trip 1:1 with the app. Every sheet payload carries its dims
in both px and pt; text positions from `find_text {action: "read"}` are in the same
space, which makes them usable directly as click targets.

## Scale rules

- A detected scale is a **suggestion**—it is never applied automatically.
  Adopting it is always an explicit `set_scale { use_detected: true }`.
- **Agent proposes, human confirms.** `set_scale` is the agent surface, so a
  scale set here lands **unconfirmed** (`confirmed: false` in the reply).
  Quantities still flow—the gate is a flag, never a refusal—but
  `summary` names the affected sheets in
  `scale_unconfirmed`, and the export/report carry `scale_confirmed` so the
  canvas can ask the estimator to confirm (its scale menu grows a
  **Confirm agent-set scale** row on import). Only a human act in the canvas
  clears the flag.
- `measure {kind: "area"}` and `measure {kind: "length"}` refuse without a scale:
  `Set the scale for <sheet> first — use set_scale (detected: <label>).`
- `takeoff_rooms {action: "at"}` without a scale returns a **px-only preview**
  (`area_px2`, `perimeter_px`) with a warning, and commits nothing.
- `upp` is real feet per image px at render scale 2.0, per sheet—the same
  number the app stores as `units_per_px`.

## A whole takeoff, end to end

The bundled demo plan, as a copy-pasteable session (this is also the shape of
`test/e2e.test.ts`):

```
open_drawings   { "action": "load", "path": "/absolute/path/to/opentakeoff/demo/sample-plan.pdf" }
                → sheet "sample-plan.pdf", 2448×1584 px, sheet_number "A-101",
                  detected_scale "1/4\" = 1'-0\""
find_text       { "action": "read", "sheet": "sample-plan.pdf", "region": { "x0": 1468, "y0": 871, "x1": 2448, "y1": 1584 } }
                → the title block: A-101, SCALE: 1/4" = 1'-0"
set_scale       { "sheet": "sample-plan.pdf", "use_detected": true }
takeoff_rooms   { "action": "at", "sheet": "sample-plan.pdf", "at": [600, 1084],  "condition": "CPT-1" }   → ~438 SF
takeoff_rooms   { "action": "at", "sheet": "sample-plan.pdf", "at": [1640, 1084], "condition": "CPT-1" }   → ~438 SF
takeoff_rooms   { "action": "at", "sheet": "sample-plan.pdf", "at": [600, 464],   "condition": "CPT-1" }   → ~438 SF
takeoff_rooms   { "action": "at", "sheet": "sample-plan.pdf", "at": [1600, 464],  "condition": "CPT-1" }   → ~438 SF
summary         {}                                  → CPT-1, 4 shapes, ~1752 SF
export          { "action": "takeoff", "path": "/tmp/takeoff.json" }   → the app's save payload
export          { "action": "marked_pdf" }          → the marked-up planset PDF,
                                                      written next to the plan
```

A takeoff finishes with **both** exports: `export {action: "marked_pdf"}` is what a human
reviews (construction takeoffs are no good without markup), `export {action: "report"}` is
what pricing consumes.

### Writing to disk

`path` is not confined to a working directory, and deliberately so—the marked
set belongs in the job folder, wherever that is. What the export tools will not
do is destroy a file they didn't write:

- **Nothing at the path** → written.
- **A previous export of OpenTakeoff's own at the path** → overwritten silently. Fix a
  condition and export again to the same path as often as you like; that's the
  normal loop, and it needs no flag.
- **Any other existing file** → refused, with the path named. Pass
  `overwrite: true` to replace it anyway.
- **Corrupt, encrypted, or unreadable** → treated as *not* OpenTakeoff's, so refused. An
  unrecognizable file is exactly the kind worth not overwriting.

A marked set is recognized by its PDF `Producer`; the JSON exports by the
`schema` key they stamp. This is data-loss protection, not a sandbox—the
server runs as you, with your privileges. See [`SECURITY.md`](../SECURITY.md)
for the threat model.

Sheet keys follow the app's codec: page 1 is the bare file name
(`plan.pdf`), pages 2+ are `plan.pdf#2`. Tools also accept the title-block
sheet number (`A-101`) wherever a sheet is named.

## Limits (v1)

- **Scanned sheets flood, but don't index.** `takeoff_rooms`
  falls back to the sheet's rendered pixels where vectors can't bound the room
  (#154)—disclosed as `raster_traced`—but a scan with no text layer still
  has nothing for `takeoff_rooms`/`sheet_context {action: "graph"}`/`find_text {action: "resolve_tag"}` to read: seeds
  come from you (`view_sheet`, then `takeoff_rooms {action: "at"}`). The raster path needs the
  same optional `@napi-rs/canvas` as `view_sheet`.
- **Stitching is human-only—deliberately, not a gap.** The canvas can join
  2–4 sheets split at a match line into one composite surface (#200), but no
  MCP verb creates, aligns, or addresses a stitch. Joining the match line
  means clicking the same drawn wall junction on both halves—a judgment
  call with a worse blast radius than a bad scale, because a sloppy align
  silently skews every quantity that crosses the seam. That stays behind
  human eyes; it is not planned for later exposure. For a split floor: a
  human stitches and aligns in the canvas, and over MCP you work each member
  sheet as its own surface—a seam-crossing room belongs to the canvas.
  This server also doesn't read the app's additive `stitches` payload field,
  so a stitched takeoff round-tripped through `export {action: "import"}` →
  `export {action: "takeoff"}` comes back without its stitches—when a stitch is in
  play, the app's own save is the one to keep.
- `open_drawings {action: "load"}` replaces the session by default; `merge: true` builds a multi-document working set (#152). Reloading a merged file is refused—reload = replace, deliberately.
- The takeoff lives in memory. `export {action: "takeoff"}` (the app's exact save payload,
  nothing lost in translation) and `export {action: "marked_pdf"}` (the reviewable marked
  planset) are the ways out.

## Tests

```bash
npm run typecheck
npm test        # session + tool-layer + e2e, against demo/sample-plan.pdf
```

## Releasing (maintainers)

MCP releases live in the **`mcp-v*`** tag namespace — bare `v*` tags belong to
the app (v0.2.0, v0.3.0 are app releases). Releases publish through **npm trusted
publishing**: the tag push fires `.github/workflows/publish-mcp.yml`, which
runs straight through—no approval click—and publishes the npm artifact
over OIDC with a **provenance attestation** (no npm token exists anywhere—the
npm package designates that exact repo + workflow as its trusted
publisher), followed by the MCP registry entry, the GitHub release, and the
MCPB bundle. The `release` environment's required-reviewer gate existed
briefly and was deliberately removed (2026-07-22)—the tag push is the one
human decision, and it's already admin-gated, so a second click added
friction without adding safety.

```bash
# 1. bump the version — all three fields together:
#    package.json .version, server.json .version, server.json .packages[0].version
# 2. tag and push — this fires the whole release, fully unattended:
git tag mcp-v<version> && git push origin mcp-v<version>
```

⚠️ Because there's no approval step, an accidental or mistyped `mcp-v*` tag
publishes to npm immediately, and npm unpublish is heavily restricted—double-check
the version before tagging.

The workflow checks version consistency, runs the full publish gate
(`prepublishOnly` = typecheck + tests + build), publishes to npm and the
official MCP registry, verifies the registry listing, and creates the GitHub
release (titled `opentakeoff-mcp <version>`). A re-run skips the npm publish
if that version already shipped, so a transient failure downstream is safe to
retry.

### Refreshing the Smithery listing

Smithery isn't part of the automated release above—it needs a **separate,
manual** publish after any tool signature change, because of a genuine spec
conflict between two validators: the official MCPB validator (what
`npm run mcpb` gates on) rejects a `tools[].inputSchema` key outright, while
Smithery's registry rejects a bundle *without* real `inputSchema` per tool
(smithery-ai/cli#770, #797, #787—no manifest satisfies both). The canonical
`dist-mcpb/opentakeoff-mcp.mcpb` stays spec-compliant for Claude Desktop / the
official registry / Glama; `scripts/build-smithery-mcpb.mjs` builds a
Smithery-only bundle instead, with live-introspected tools + inputSchema baked
in, packed with a plain zip (bypassing `mcpb validate`, which would reject it):

```bash
npm run build
node scripts/build-smithery-mcpb.mjs
smithery mcp publish dist-smithery/opentakeoff-mcp.mcpb -n Kentucky-ai/opentakeoff
```

## Calibration and review correctness (0.9.72)

`set_scale` recomputes existing dimensional quantities from geometry, including holes and cutout restore snapshots. Changing an existing calibration records one `edit_takeoff {action: "undo"}` step that restores the scale, its confirmation/source, and the prior quantities together. Initial calibration of an unmeasured sheet adds no undo step. Counts retain their stored values. A sheet containing human-reviewed dimensional measurements refuses recalibration over MCP, consistent with the existing reviewed-shape edit rules; recalibrate it in the canvas and import the updated takeoff into a fresh session.

`export {action: "import"}` refuses new dimensional shapes when their source calibration differs from the session's calibration, or is missing while the session has one. The error names the sheet and scales; no session state changes. Align calibrations and re-export, or load a fresh session to adopt the export's calibration. Counts and duplicate IDs are exempt. An existing calibration is preserved even in an untraced session.

New agent measurements, including `measure {kind: "area"}` and `measure {kind: "length"}`, explicitly carry `origin.reviewed: false`. Legacy agent records without the flag are normalized on import and browser reload. Explicit prior human approval is preserved. No new review gate is introduced.
