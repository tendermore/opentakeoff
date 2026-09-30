# MCP tool index

Generated from runtime `tools/list` schemas and the tool list in `src/toolnames.ts`. Do not edit by hand.
Refresh with `npm run check:tool-count --prefix mcp -- --write`; CI fails on stale output.

For the operating workflow, read [the agent guide](AGENT_GUIDE.md) and [geometry workflow](GEOMETRY_WORKFLOW.md).
For behavior and optional arguments, use the [tool reference](wiki/tools.md), the [README table](../mcp/README.md#tools) and the discovered input schema.

Default build: **33 tools**. Coordinates, where present, are full-sheet image pixels at PDF render scale 2.0, top-left origin, y down.

| Tool | Actions | Availability | Required arguments |
|---|---|---|---|
| `annotate` | — | Default | `sheet`, `type` |
| `count` | `symbol`, `sweep`, `place`, `marks` | Default | `action` |
| `create_rfi` | — | Default | `title`, `question`, `sheet` |
| `delete_rfi` | — | Default | `rfi_id` |
| `delete_verdict` | — | Default | `verdict_id` |
| `derive` | `deduct`, `base`, `transitions` | Default | `action` |
| `duplicate_condition` | — | Default | `condition`, `label` |
| `edit_annotation` | — | Default | `annotation_id`, `text` |
| `edit_condition` | — | Default | `condition` |
| `edit_materials` | — | Default | `condition` |
| `edit_takeoff` | `list`, `edit`, `delete`, `undo` | Default | `action` |
| `export` | `marked_pdf`, `report`, `takeoff`, `dxf`, `import` | Default | `action` |
| `find_text` | `find`, `read`, `resolve_tag` | Default | `action` |
| `link_annotation` | — | Default | `annotation_id`, `condition` |
| `list_annotations` | — | Default | None |
| `list_rfis` | — | Default | None |
| `mark_verdict` | — | Default | None |
| `measure` | `area`, `length`, `surface` | Default | `kind`, `sheet`, `points` |
| `open_drawings` | `load`, `info` | Default | `action` |
| `propose_condition_edit` | — | Default | `condition`, `rationale` |
| `propose_takeoff` | — | Default | `label`, `rationale` |
| `resolve_rfi` | — | Default | `rfi_id`, `answer` |
| `revise_proposal` | — | Default | `proposal_id`, `shapes` |
| `schedule` | `find`, `sweep_row`, `apply_rules` | Default | `action` |
| `scope_duplicates` | — | Default | None |
| `scope_merge` | — | Default | `shape_a`, `shape_b` |
| `set_scale` | — | Default | `sheet` |
| `sheet_context` | `context`, `graph`, `vectors` | Default | None |
| `split_condition` | — | Default | `condition` |
| `summary` | — | Default | None |
| `takeoff_rooms` | `detect`, `at` | One-Click gate lifted | `sheet` |
| `view_sheet` | — | Default | `sheet` |
| `withdraw_condition_edit` | — | Default | `proposal_id` |
| `withdraw_proposal` | — | Default | `proposal_id` |

Schema-required fields are only the first validation layer: the fields one action needs (such as `path` for `open_drawings` load, annotation coordinates by type, or exactly one calibration method) are explained by each tool and validated by its handler.

Sources: [tool registrations](../mcp/src/tools.ts), [tool list](../mcp/src/toolnames.ts), [output schemas](../mcp/src/outputs.ts).
