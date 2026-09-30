# Takeoff domain knowledge

| Quantity or record | Meaning | Common mistake |
|---|---|---|
| Floor SF | Area assigned to a floor finish, net of supported deductions | Adding wall SF to call the result building floor area |
| Room boundary | The innermost interior wall face, with door openings crossed on the wall centerline | Tracing a hatch edge, a door leaf drawn open, or stopping at casework; see [workflows](workflows.md#trace-a-room-the-way-an-estimator-does) |
| Wall SF | Measured run LF × that shape's height | Applying one elevation width to every wall or treating floor deducts as wall openings |
| Wall length | Centreline LF per drawn thickness class and side; L corners to the centreline intersection, T abutments to the face; gross through openings, net without | Reading a height off a plan, or merging walls that only line up across a room |
| Window count | Glazed openings drawn in walls; type and size only from a schedule row | Counting a schedule row as installed work, or giving a plan width as the window size |
| Base/transition LF | Installed run length or a disclosed derived allowance | Treating a numeric opening allowance as a located gap |
| Count | Located instances with count semantics | Counting a note's bare mention as a drawn device |
| Order quantity | Net quantity with the condition's stated multiplier/waste rules | Increasing the traced geometry to carry waste |
| Material coverage | A material row derived from measured finish quantities | Drawing duplicate finish polygons for membrane/protection coverage |
| Confidence | A signal for prioritizing inspection | Treating it as human approval or an accuracy guarantee |
| Agent verdict | The agent's own recorded check | Creating or claiming an estimator's approval seal |

Use `measure {kind: "surface"}` bands for stepped faces. `derive {action: "deduct"}` removes the full height
of the particular wall run it clips; a partial-height opening needs bands so
only affected heights are clipped. Existing records have no elevation-plane
coordinate or vertical band offset. Preserve that limitation rather than
inventing a new meaning for `deduct`.

`derive {action: "base"}` retains a whole perimeter and may subtract stated LF numerically.
Explicit `measure {kind: "length"}` runs and located cuts show installation gaps. Inspect
open finish splits, jamb returns and columns; apparent openings need source
evidence. `derive {action: "transitions"}` can withhold a wall-separated boundary: a returned
candidate is still something to inspect.

MCP work stays pending; correction does not approve it. A human's correction
freezes original machine outer vertices, including manual agent traces, but it
cannot restore previously discarded history. Schema validation, confidence,
review, approval, identity and Academy certification remain separate.

Sources: [quantity math](../../web/src/lib/totals.js),
[Session measurement and derivation](../../mcp/src/session.ts),
[provenance](../../web/src/lib/provenance.js),
[review semantics](../../protocol/COMPATIBILITY.md),
[human glossary](../USER_GUIDE.md#18-glossary--what-the-words-mean-here).
