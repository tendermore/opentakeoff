# MCP tool index

Generated from runtime `tools/list` schemas and the tool list in `src/toolnames.ts`. Do not edit by hand.
Refresh with `npm run check:tool-count --prefix mcp -- --write`; CI fails on stale output.

For the operating workflow, read [the agent guide](AGENT_GUIDE.md) and [geometry workflow](GEOMETRY_WORKFLOW.md).
For behavior and optional arguments, use the [tool reference](wiki/tools.md), the [README table](../mcp/README.md#tools) and the discovered input schema.

Default build: **17 tools**. Coordinates, where present, are full-sheet image pixels at PDF render scale 2.0, top-left origin, y down.

| Tool | Actions | Availability | Required arguments |
|---|---|---|---|
| `annotate` | `add`, `edit`, `link`, `list` | Default | `action` |
| `conditions` | `edit`, `duplicate`, `split`, `materials`, `scope_duplicates`, `scope_merge` | Default | `action` |
| `count` | `doors`, `windows`, `symbol`, `sweep`, `place`, `marks` | Default | `action` |
| `derive` | `deduct`, `base`, `transitions` | Default | `action` |
| `edit_takeoff` | `list`, `edit`, `delete`, `undo` | Default | `action` |
| `export` | `marked_pdf`, `report`, `takeoff`, `dxf`, `import` | Default | `action` |
| `find_text` | `find`, `read`, `resolve_tag` | Default | `action` |
| `measure` | `area`, `length`, `surface`, `walls` | Default | `kind`, `sheet` |
| `open_drawings` | `load`, `info` | Default | `action` |
| `proposal` | `propose`, `revise`, `withdraw`, `propose_condition_edit`, `withdraw_condition_edit` | Default | `action` |
| `review` | `mark`, `delete` | Default | `action` |
| `rfi` | `create`, `list`, `resolve`, `delete` | Default | `action` |
| `schedule` | `find`, `sweep_row`, `apply_rules` | Default | `action` |
| `set_scale` | — | Default | `sheet` |
| `sheet_context` | `context`, `graph`, `vectors` | Default | None |
| `summary` | — | Default | None |
| `takeoff_rooms` | `detect`, `at`, `cover` | One-Click gate lifted | `sheet` |
| `view_sheet` | — | Default | `sheet` |

Schema-required fields are only the first validation layer: the fields one action needs (such as `path` for `open_drawings` load, annotation coordinates by type, or exactly one calibration method) are explained by each tool and validated by its handler.

Sources: [tool registrations](../mcp/src/tools.ts), [tool list](../mcp/src/toolnames.ts), [output schemas](../mcp/src/outputs.ts).
