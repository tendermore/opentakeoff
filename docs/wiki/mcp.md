# MCP routing and coordinate contract

Start at `takeoff://wiki`; read the relevant page, then use the discovered
schemas for precise arguments. The [generated tool index](../MCP_TOOL_INDEX.md)
comes from the runtime, including each tool's actions and required inputs; the
[tool reference](tools.md) explains every action in depth.

| Current job | First tool or resource | Next check |
|---|---|---|
| See supported workflows without a plan | `takeoff://wiki/status` | Read only the needed workflow page |
| Open and orient | `open_drawings` (`load`, then `info`) | Source revision, dimensions and the intended sheet |
| Establish scale | `set_scale` | Correct detail scale; agent-set calibration stays unconfirmed |
| Find finish evidence | `schedule` (`find`), `find_text` (`resolve_tag`, `read`) | Verify the cited sheet/region; do not infer missing rows |
| Locate boundaries | `sheet_context` (`vectors` or `context`) | `view_sheet` for visual confirmation |
| Group a pass | `proposal {action: "propose"}` | A batch heading exists; no geometry has been committed |
| Rooms from the linework | `takeoff_rooms` (gated) | Overlay inspection; read `withheld` |
| Floor, base/trim, wall face | `measure` (`area`, `length`, `surface`) | Overlay inspection and per-role quantities |
| Count drawn symbols | `count` (`symbol`, then `sweep` for set-wide or counter-examples) | Check the numbered picture; drop wrong marks before `commit` |
| Device/count census | `count` (`marks`) | Inspect withheld entries; use more specific sweeps where needed |
| Located opening, base, transitions | `derive` (`deduct`, `base`, `transitions`) | Surviving geometry; numeric derived-base allowances cannot be clipped |
| Pending shape or crowded note | `edit_takeoff` (`edit`) or `annotate {action: "edit"}` | Reinspect; `edit_takeoff` (`undo`) restores the edit |
| Check and hand off | `summary`, `export` (`report`, `takeoff`, `marked_pdf`) | Reopen and inspect; leave human review pending |

Every tool is always listed; there is no staged exposure. A task tool takes one
flat object with an `action` (or `kind`) and replies with one JSON object that
names it. Wiki resources are readable before a plan loads; adding knowledge
does not add a measurement tool.

## Coordinates: carry the frame with every point

- Tool coordinates are **full-sheet image pixels at PDF render scale 2.0**:
  PDF points × 2, top-left origin, y down.
- A rendered preview can be resized or cropped. Convert a displayed point back
  using the returned view dimensions and region offset before calling a tool.
  Do not pass raw screenshot pixels as full-sheet coordinates.
- Persisted `verts_norm` use the sheet's normalized frame. Tool calls accept
  pixels, so convert normalized coordinates with the original sheet dimensions.
- Scale is feet per image pixel; areas square that factor. Metric display is a
  conversion of stored quantities, not a change to geometry. The marked set,
  report and export print in the units the scaled sheets say they are drawn in
  (their scale labels, printed areas and dimension strings — `OPENTAKEOFF_UNITS`
  defaults to `auto`): metric when every sheet with evidence is metric, imperial
  when any is imperial or none has evidence. `OPENTAKEOFF_UNITS=metric` or
  `imperial` overrides that.

The [tool reference](tools.md), the [full MCP guide](../MCP.md) and the
[README tool table](../../mcp/README.md) contain optional arguments and examples. Runtime descriptions remain the
argument authority. A refusal should lead to its stated next step rather than
retrying the same call with guessed coordinates or authority fields.
