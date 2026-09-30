# MCP tool reference

What each tool and action does, in depth. The runtime descriptions are short
on purpose; this page carries the engine detail behind them: what a reply
discloses, what refuses and why, and what to check next. Arguments are in the
[generated tool index](../MCP_TOOL_INDEX.md) and the discovered input schemas.

Every task tool takes one flat object: an `action` (or `kind`) plus the fields
that action uses, and replies with one JSON object that names the action. A
field an action needs but the schema cannot require is refused by the handler
with the tool, the action and the missing field named. Coordinates are
full-sheet image pixels at render scale 2.0 (PDF points × 2, origin top-left,
y down) everywhere.

The estimator-workflow tools (proposals, conditions and materials, verdicts,
RFIs, annotations) keep their per-verb names for now; their runtime
descriptions are their reference.

## `open_drawings`

Open plan PDFs and see what is loaded. load: open path, replacing the session; merge:true adds the file to the working set instead (plans + schedules + addenda as one takeoff). info: without sheet, every loaded sheet with its scale status and shape count; with sheet, that sheet's dims, vector linework, detected scale and PDF layer table.

### `action: "load"` (was `load_plan`)

Open a plan PDF from disk. Default: replace the whole session (previous documents, scales, conditions, and shapes are cleared). merge: true ADDS the document to the working set instead (#152) — a bid set is plans + schedule + addenda, not one PDF — keeping every scale, condition, and shape; sheet keys carry file names so documents never collide, the sheet graph spans the whole set (find_text {action: "resolve_tag"} can chain a plan tag on one file to a schedule row in another), and the marked set covers every worked sheet. Re-loading an already-merged file is refused — reload = replace, deliberately. Returns file, files, page_count, and one entry per sheet. The loaded sheets also become browsable resources (takeoff://sheets).

Fields:

- `merge`: true = ADD this document to the working set, keeping all existing work (merge into an empty session is just a load)

### `action: "info"` (was `sheet_info`)

Sheet detail: dims (px and pt), vector segment count, whether the sheet has vector linework (takeoff_rooms {action: "at"} floods it when present; a scanned sheet falls back to rendered pixels, disclosed as raster_traced), scale status, the detected scale suggestion, and this sheet's committed shape count.

## `set_scale`

Set a sheet's scale before measuring; quantities are px-only until then. Give exactly one: label (a standard scale such as 1/4" = 1'-0" or 1:100), use_detected (adopt the scale note read off the sheet, never applied automatically), calibrate (two points a known distance apart), or upp. Changing a scale re-measures existing shapes as one undo step; counts are unchanged. An agent-set scale stays unconfirmed until a human confirms it in the canvas.

Set a sheet's scale — exactly ONE of: label (a standard scale, e.g. '1/4" = 1'-0"'), upp (real feet per image px), calibrate (two points along a known dimension plus its real feet), or use_detected (adopt the drawn scale note read off the sheet). The detected scale is never applied automatically — setting it is always this explicit call. Changing an existing scale recomputes measurements and cutout restore quantities from geometry and records one edit_takeoff {action: "undo"} step. Counts are unchanged. Human-reviewed dimensional work must be recalibrated in the canvas; scales must be finite and positive.

## `sheet_context`

A sheet's structure as data. context (default): a region's classified segments, text spans and hatch families in one frame — decimation is counted, short segments first, then a longest-first cap. graph: the plan-set index — sheet roles, schedule tables, corroborated rooms, unmatched tags with reasons, detail callouts, revisions. vectors: the raw strokes exactly as the engine is fed them, paged (offset + returned + dropped = total; pass next_cursor as cursor). A scan has no strokes.

### `action: "context"` (was `sheet_context`)

The sheet's STRUCTURE in one call and one frame: the classified vector segments, the positioned text spans, and the hatch-family instances of a region — everything the engine itself floods against, exposed as data instead of pixels. Use it when you need to REASON about a region rather than look at it: which lines bound this space and at what pen weight, what the region says, and which periodic fill pattern covers it. The join is the point — all three arrive in image px with no reconciliation left to do, and the reply echoes the post-clamp region so passing that same rect to view_sheet gives you the matching render by construction. Hatch families carry a content-derived id (same pattern spec ⇒ same id, anywhere on the sheet), so matching a plan region to a legend swatch is comparing two ids, not guessing from a render — read the legend region, read the room region, match ids, and cite both bboxes as evidence. Decimation is declared, ordered, and counted on every reply: segments shorter than min_len_px drop first (invisible ink), then a max_segments cap applies LONGEST-FIRST so walls survive and hatch strokes go; kept + dropped always reconciles to total_in_region, and whole segments drop with their meta intact — nothing is ever simplified or merged, because these are classified segments and a merge would rewrite the classification. A scan returns has_vector_linework: false with empty vectors — absence of linework, never a claim the region is blank.

Fields:

- `min_len_px`: Drop segments shorter than this (default 2 — one PDF point at render scale 2.0, below any pen width). 0 keeps everything
- `max_segments`: Segment cap, applied longest-first (default 4000). The reply's dropped.cap says exactly what a smaller region would recover

### `action: "graph"` (was `sheet_graph`)

The plan-set INDEX (#87): every sheet's role (plan / schedule / legend / …, with confidence and the title evidence), the schedule tables found (kind, row count, region — a schedule CONTINUED across sheets ("… SCHEDULE — CONT'D") reads as ONE table, the continuation fragment naming its base in "continues"; rotated column headers are read at their quarter-turn and flagged), every number CORROBORATED as a room (with the stacked room NAME when one exists, the room's BUILDING on multi-building sets, and "corroboration" saying why it counts as a room) plus "unmatched_tags" — the numbers that are NOT rooms (keynote hexagons, detail markers, dimension fragments, legend rows), each with a reason, listed and never dropped; READ those reasons, one of them may be a room the schedule left out, the detail callouts (3/A-601 → sheet edges), the set's building designators, every REVISION marker the set carries (text markers "Δ2"/"REV 2" AND drawn deltas — a bare digit inside a triangle of linework, proven from vector geometry and flagged drawn — in "revisions", and attached to the schedule row / room tag they sit on), and named indexing gaps in "notes". Built once per document from the text layer and cached. This is how an agent decides WHAT to measure without a human enumerating the rooms: list the rooms here, resolve each with find_text {action: "resolve_tag"}, then measure with takeoff_rooms. A scanned set (no text layer) returns available: false — unavailable, never half-populated.

### `action: "vectors"` (was `get_sheet_vectors`)

The STROKES — the sheet's vector layer exactly as the engine is fed it, so you can run your own geometry against what the app sees (#367). view_sheet lets you look, find_text {action: "read"} lets you read, sheet_context classifies a region; this returns the raw extractor output that all of them and every shape verb (takeoff_rooms {action: "at"}'s flood, the wall network's pen weights, count {action: "sweep"}'s matching) work from: flat points [x1, y1, x2, y2, …] in image px, one meta byte per segment (low nibble flags: 1 curve chord, 2 clip-only, 4 fill-only, 8 polyline arc; pen width = meta >> 4), per-segment stroke luminance, the drawn figure each segment belongs to (subpath ordinal), the sheet's placed-image area, and its PDF layer table with a per-segment layer index (open_drawings {action: "info"}.layers names and classifies the same ids). Nothing is classified, decimated, or merged here — segments arrive whole, in extraction order, undecimated, which is the point: a reader can build its own room finder, symbol matcher, or wall classifier on the same array and commit through the existing verbs with provenance intact. Paged, never clipped silently: a dense sheet runs to hundreds of thousands of segments, so the reply carries limit (default 20000 segments, ceiling 100000) and the ledger offset + returned + dropped === total on every page; dropped is exactly what passing next_cursor as cursor recovers. region keeps every segment that intersects the rect (endpoints untouched — the same keep test sheet_context uses, so total here equals sheet_context's total_in_region) and echoes it post-clamp. Read-only and stateless — no shape, condition, or scale is touched. A scan has no strokes: the verb refuses and names view_sheet as the path.

Fields:

- `region`: Rect in image px (origin top-left, y down); omit for the full sheet. A segment is kept when it intersects the rect

## `view_sheet`

Render a sheet, or a crop of it, to a PNG: your eyes on the plan. Crop tight; a full-sheet render only shows where things are. overlay:true burns in committed shapes (solid = human-affirmed, dashed = agent): render after every commit to check it. grid burns in a 1 ft / 5 ft measuring grid. marks burns in points a reply disclosed: question (withheld), struck (rejected), ring (reference). Image pixel (ix, iy) sits at x = x0 + ix × (x1 − x0) / img_w, likewise y.

SEE the sheet — render the page (or a crop of it) to a PNG image. This is your eyes on the plan, so CROP, DON'T SQUINT: the render downsamples to the px budget (≤2000 long side), which on an E-size sheet is ~4 sheet pixels per returned pixel — a full-sheet render finds WHERE things are, and only a tight region crop can tell you what the linework and labels actually say. Never audit a trace or read a dimension off a full-sheet render. region is in image px — the same space as every other tool — so a feature at pixel (ix, iy) of the returned image sits at x = region_x0 + ix × (region_x1 − region_x0) / img_w (same for y), and those coordinates go straight into takeoff_rooms {action: "at"}, measure {kind: "area"}, or find_text {action: "read"}. overlay:true burns the session's committed shapes into the render (human-affirmed ink solid red, unreviewed machine shapes dashed blue) — render again after committing to verify your geometry landed where you intended, and sanity-check what you see: a fixture-sized ring where a room should be means the seed landed inside a stall or casework; an outsized ring means the flood escaped through an opening. To MEASURE rather than guess, pass grid: a calibrated measuring grid is burned in — thin lines every 1 ft, heavy blue every 5 ft, foot labels along the crop edges, feet counted from the crop's top-left corner. Count grid cells between walls exactly like an estimator scaling a plan; never derive a dimension by eye when the grid can give it to you. grid "auto" uses the sheet's set scale; before set_scale, pass the drawing scale read off the title block as inches-per-foot — "1/4" for a 1/4" = 1'-0" plan, "3/16", "0.25". marks (#297) burns DISCLOSURE layers into the render, so what a reply names, the picture shows: pass the coordinate lists a tool disclosed — question: withheld placements (orange ?-circles), struck: rejections a counter-example or luminance gate refused (magenta struck ×), ring: reference points like the sweep's own seed (violet double ring). The colors sit deliberately off the common CAD pens so they cannot vanish into color-plotted work. An overlay audit without marks shows only committed ink — the validation trap where 37 disclosed near-misses read as "it missed them". Rendering needs the optional native canvas (@napi-rs/canvas); where it isn't installed this tool errors cleanly and every other tool still works.

Fields:

- `px`: Long-side pixel budget of the returned image (default 1400) — small region + high px = readable dimension strings
- `grid`: Burn in a calibrated 1-ft/5-ft measuring grid: "auto" = the sheet's set scale; otherwise the drawing scale as inches-per-foot, e.g. "1/4", "3/16", "0.25"
- `marks`: Disclosure marks to burn into the render (#297): what the reply names, the picture shows. Coordinates in image px

## `find_text`

Text on the drawings. find: where a known string sits on a sheet (case-insensitive, per text run; count and truncated say what a tighter region or a higher limit would recover). read: every text item of a sheet or region with its position, plus the joined text. resolve_tag: one room tag → its room-finish schedule row → each finish code's definition, every edge citing sheet, text and bbox; it answers unresolved or ambiguous rather than guess.

### `action: "find"` (was `find_text`)

LOCATE a known string on a sheet — the complement to find_text {action: "read"} (which returns what a region SAYS; this finds WHERE a string you already know sits). Case-insensitive substring match against each pdf.js text run, so a room label split across runs ("OFFICE" then "134" as separate items) needs a find_text call per fragment, or find_text {action: "read"} over a region to see the whole thing joined. Every hit's center feeds straight into takeoff_rooms {action: "at"} as the seed — the locate-then-trace workflow: find_text the room number, takeoff_rooms {action: "at"} at (or just past) its center. Optionally restrict to a region {x0, y0, x1, y1}; results cap at limit (default 200), with count/truncated telling you exactly how much a tighter region or higher limit would recover.

Fields:

- `query`: Text to find — a room number ('134'), a label fragment ('RECEPTION'), a schedule tag ('CPT-1')

### `action: "read"` (was `read_sheet_text`)

The sheet's text with positions — items [{str, x, y}] in image px plus the joined text. Optionally restrict to a region {x0, y0, x1, y1}. Use it to read title blocks, room labels, finish schedules, and scale notes.

### `action: "resolve_tag"` (was `resolve_tag`)

Resolve ONE room tag across the set (#87): the plan tag → its room-finish schedule row → each finish code's definition in the finish/material schedule, EVERY edge carrying an evidence pointer (sheet + literal text + bbox — pass a bbox to view_sheet to look at the source). Rows carried by a continuation sheet ("… SCHEDULE — CONT'D") resolve exactly like base-sheet rows, citing the sheet the ink is on. The doctrine is refusal over guessing: a room that appears on the plan with no schedule row returns status "unresolved" with the reason (and still cites the plan tag); reused room numbers return "ambiguous" rather than picking one — on a multi-building set the refusal LISTS the candidate rows per building, and a building-qualified tag ("A-134") picks the building the set names. A delta triangle or REV tag on the answering row (or the plan bubble) rides the result as "revisions": the codes returned are the POST-revision answer, but the ink changed under that delta — view_sheet the marker's bbox and check the addendum before pricing.

Fields:

- `tag`: The room tag as drawn, e.g. "134" or "139A" — or building-qualified on a multi-building set, e.g. "A-134" (building A, room 134)

## `takeoff_rooms`

Rooms from the plan's own linework. detect (default): every room label on the sheet is flooded through the sealed engine — ink flood, walls-only masks, net and drawn candidates, printed-area check — and each room returns label, area, printed area, method and confidence; every skipped room is counted with its reason in withheld. at: one room at a point. Commit with condition (one tag) or assign_from_schedule (each room's own schedule row). Then check with view_sheet overlay:true.

Registered only when the One-Click gate is lifted (`OPENTAKEOFF_ONE_CLICK=1`).

### `action: "detect"` (was `detect_rooms`)

Batch room detection: reads every room-number label off the sheet's text layer (e.g. "134", "OFFICE 101") and runs One-Click at each — one call instead of find_text {action: "read"} + reasoning + N takeoff_rooms {action: "at"} calls. An OCR'd scan (text layer, no vector linework) floods the rendered pixels instead (#154), disclosed per room and on origin as raster_traced. A seed is only reported as a room once it survives three gates, and everything skipped is counted and reasoned in `withheld` — never dropped silently, because a room the tool tells you it skipped is a question you can ask, while one it hides is a hole in a bid. The gates: a flood that leaked or landed in dense linework never becomes a region; two labels flooding the SAME region commit once (the extra labels ride on `merged_labels` — double-counting an area is the worst failure an estimating tool has); and a flood that is enclosed and clean but smaller than min_area_sf is a room-number bubble, a door swing, or a wall cavity rather than a room. Every room floods through the SAME sealed engine a single takeoff_rooms {action: "at"} runs (RFC #60 — feet-true gap sealing, door-swing wedges, the minimum-passage rule), so a batch detection and a click at the same seed measure the same square footage; each room carries the engine's account of its own trace (confidence + confidence_factors, gap_sealed_px, door_wedges, min_pass_px/min_pass_delta), and the same account rides origin on everything committed. Confidence is a review prioritizer, never a verification — a low-confidence room is a view_sheet {overlay: true} audit prompt, not a fact to bid from. With the sheet's scale set, returns area_sf/perimeter_lf per room. Every committed room carries the room number it was traced from as the shape's `label`, so a sweep arrives already sliced by room — that field is what the Report's per-room grouping and the workbook's floor × room tab read, and it is the one thing about a batch that cannot be recovered downstream if it is dropped. TO COMMIT, choose the honest source of the finish tag: assign_from_schedule: true routes every room through its OWN room-finish schedule row and commits each under the FLOOR finish that row states — when a schedule exists in the set, THIS is the default move, because one agent-chosen tag across N rooms flattens real finish variety into a wrong bid; condition commits every room under that one stated tag (only right when the rooms genuinely share it; role "deduct" makes them subtract). Without a scale, returns px-only quantities per room and commits nothing — the plausibility floor needs real units, so it only applies once a scale is set. A batch commit is NOT finished until you have LOOKED at it: view_sheet {overlay: true}, audit every ring against the walls, fix misses with edit_takeoff {action: "edit"} / edit_takeoff {action: "delete"} — before the totals mean anything.

Fields:

- `condition`: Finish tag to commit every detected room under (minted on first use). Mutually exclusive with assign_from_schedule
- `assign_from_schedule`: Commit each room under the FLOOR finish its OWN room-finish schedule row states (find_text {action: "resolve_tag"}'s chain, per room): the citation rides origin.assignment, and rooms the schedule cannot answer for — no row, no FLOOR cell, a compound cell like "CPT-1/VCT-1" — are returned in unresolved[] with reasons and seeds instead of committed under a guess. Needs the sheet's scale and a room-finish schedule in the working set (merge the schedule sheet in with open_drawings {action: "load"} first). Mutually exclusive with condition
- `min_area_sf`: Plausibility floor: enclosed non-bubble regions smaller than this are withheld as cavities, not rooms. Default 5 SF — below any real finished space (a broom closet is ~10 SF). Lower it to inspect what was skipped.
- `sensitivity`: Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing

### `action: "at"` (was `one_click`)

One-Click Area: click inside a room (image px) and the plan's vector linework bounds it — the sealed flood engine (RFC #60), contour trace, vertices snapped to true PDF endpoints. The engine's arguments are FEET-TRUE through the sheet's scale, exactly the canvas's: gap sealing bridges up to a door-width opening (disclosed as gap_sealed_px — that much boundary is synthetic), door-swing wedges annex the swing a doorway sweeps (door_wedges), and the minimum-passage rule keeps sub-half-foot slits from conjoining two rooms (min_pass_px/min_pass_delta). Every trace carries the engine's own account of itself: confidence (0..1, with confidence_factors naming what deducted) — a review PRIORITIZER, never a verification. 1.0 means every signal ran clean, not that the trace is right; a LOW confidence is a view_sheet {overlay: true} audit prompt, not a fact to bid from — put eyes on the flagged edge before the total means anything. SCANNED sheets work too (#154): where vectors can't bound the room (an image-only scan, or a scan wrapper whose only linework is the title block), the flood falls back automatically to the sheet's rendered pixels — same engine the canvas uses — and the reply plus the committed shape's origin carry raster_traced: true so a pixel-bounded ring is never mistaken for a vector-snapped one. Vector always wins where it works; a raster ring's corners are unsnapped, so audit it with view_sheet {overlay: true} before trusting the total. With the sheet's scale set, returns area_sf / perimeter_lf; pass condition (a finish tag, e.g. "CPT-1") to commit the traced shape to the takeoff — the full engine account rides the committed shape's origin, so the export tells the truth about how each shape was made. Without a scale it returns px-only quantities with a warning and commits nothing (the engine also degrades to its scale-blind fallbacks — a weaker measurement, one more reason set_scale comes first). role "deduct" makes the committed shape subtract. After committing, LOOK at what landed — view_sheet {overlay: true} — and fix an overshot ring with edit_takeoff {action: "edit"} before trusting any total.

Fields:

- `sensitivity`: Fill sensitivity, the same knob the canvas has: 0 strict (hatch/light linework always blocks), 0.5 balanced (default), 1 aggressive (crosses more hatch, tolerates more growth). Raise it when a flood stops short at hatching INSIDE the room; verify the grown ring with view_sheet overlay before committing

## `count`

Count EA items. symbol: a point on one example → every copy found from the linework (right angles, the plan's wing angles, mirrored) and a numbered picture; drop wrong marks, try another level if the example is wrong, then commit — marks already counted under the condition never count twice. sweep: the same search from a tight seed_rect, set-wide, with counter-examples. place: markers at points you already located. marks: census of value-annotated schedule marks. Count drawn symbols, never room labels.

### `action: "symbol"` (was `count_symbol`)

COUNT every copy of a fixture, door, device or other repeated symbol from ONE point on an example. Point at one instance — near the middle of the toilet or the door swing, a few tens of px off is fine (image px, from view_sheet's region and zoom) — and the tool finds the example's own linework, searches the whole sheet for it (all four right angles, the plan's own wing angles, and mirrored), counts each instance once, and returns two pictures: a close-up of the example it took, and the sheet with every copy NUMBERED (0 is your example, orange W the near-matches it held back, purple the looser matches of a smaller seed). LOOK at the pictures: a mark that is not the symbol goes in drop:[n]; a wrong example (marks on stairs, wall corners) means pass level:k from seeds_tried; a copy with no mark is another variant, so call again with a point on it. Marks already counted under the same condition show grey and are never counted twice, so a second and third call for other variants simply add. Nothing is saved until commit:true (condition required; one undo step; the example itself is included). This is the way to count things — do not place counts by eye with count {action: "place"}: eyeballed points land beside the fixture, and a total counted on room labels is not a count of the drawn symbols.

Fields:

- `include_loose`: Also count the purple LOOSE marks (what a smaller seed matches: other variants of the symbol, or look-alikes) — drop the wrong ones by number

### `action: "sweep"` (was `symbol_sweep`)

Find EVERY instance of a repeated plan symbol from ONE example — drains, thresholds, fixtures, transition markers: marquee a tight seed_rect around a single instance and the vector linework is searched for every other placement of that same segment cluster. Deterministic geometry, not vision: each placement scores as the length-weighted fraction of the seed's segments reproduced within tolerance_px, under translation plus 0/90/180/270 rotation and mirroring (symbols rotate on plans — both ON by default; turn them off to pin orientation). Score ≥ 0.92 is a match; the 0.75–0.92 band comes back in `withheld` with a reason — a near-match is a question you answer by LOOKING (view_sheet at its `at`), never a silent commit and never a silent drop. RICHER VARIANTS are named, never silent: a placement that reproduces the whole seed but carries >30% extra linework fully inside its footprint (a register against a grille seed — the same outline plus louvers) comes back with its measured `extra` fraction on the row — LOOK at those first, they are the classic mislabel; background lines CROSSING the symbol and coincident duplicate ink never trip this. By default such placements still COUNT, because the contained-seed workflow below depends on supersets matching (seed a bare sub-shape, count the richer symbols that contain it, exclude what you don't mean). Pass `variant_guard: true` when your seed is the WHOLE symbol — grilles, drains, fixtures marqueed complete — and extra-ink placements demote to `withheld` as questions instead of counting; the guard stands down automatically when `exclude` counter-examples are in play, since supplying negatives is manual variant discrimination. The seed's own location is reported in `seed` and never double-committed. Every proposed placement is scored up to a hard work ceiling sized for pathological sheets, and the reply says which it was: complete true means the count is a total; complete false (with candidates.dropped > 0) means the count is a FLOOR — some placements were never scored — so tighten the seed rect around more distinctive geometry rather than trusting it as a total. Marquee discipline: the rect must hug ONE instance — only segments FULLY inside it define the symbol, so a loose rect that swallows wall linework fingerprints the wall, not the symbol. scope "set" sweeps the WHOLE working set, counting on PLAN-role sheets only (the sheet graph decides): a symbol drawn in a detail, legend, or schedule is a reference drawing and never counts itself — which is also how you seed from one: marquee the assembly on the detail sheet and its plan-sheet occurrences are counted while the detail stays excluded (the exclusion disclosed in `skipped`, per-sheet results with per-sheet caps and wall-clock in `sheets`). Scale across sheets: the fingerprint is size-true and is never scale-SEARCHED, so a detail drawn at 1-1/2" = 1'-0" is 12× the size of the same mark on a 1/8" plan — when BOTH sheets have a scale set, the exact ratio is computed from them and the seed is resized before matching (reported per sheet as `scaled`); when a scale is missing, the sweep runs at 1:1 and SAYS so (`scale_assumed`), because an unknown ratio plus a zero count is not evidence of absence. Seeding from a detail/legend/schedule sheet REFUSES outright until both scales are set — that is the case where an unstated ratio silently finds nothing. commit: true (requires condition) commits every match center as an EA count marker through the same path as count {action: "place"} — the whole sweep (set-wide included) is ONE undo step, each marker carries origin.method "count {action: "sweep"}" with its score, transform, and seed source, and withheld placements are NEVER committed. The SEED instance is not in that count (#296) — in sheet scope it is almost always installed work, so pass commit_seed: true to mint it into the same batch (the reply reminds you whenever a sheet-scope commit leaves it out; ea_total one short of the hand tally is exactly this). The COUNT is scale-free (EA), but matching across sheets of different scales is not — set_scale on the sheets involved is what turns the ratio from an assumption into arithmetic. Counter-examples (#259): drafting reuses one generic shape for different devices — a wall-mounted data outlet drawn as a plain triangle, the flush-floor variant the SAME triangle inside a square, keynote callouts a triangle with a letter in it — so the seed legitimately matches things you do not mean, and seeding more geometry only works where the drawing offers more to capture. `exclude` takes rects around instances you do NOT mean, marqueed exactly like the seed. You never choose a mechanism; the rect's contents decide, because both are the same gesture: a rect holding EXTRA linework beyond the seed rejects placements where that extra linework is present too (the box, the letter), and a rect holding no extra linework of its own is read as the line running THROUGH it — a bare ceiling-grid tile whose grid line a real fixture, drawn over it, would BREAK. That second mechanic is not expressible as a seed: only segments fully INSIDE a rect define a symbol, and background structure is long by nature. Every rejection is disclosed in rejected[] — which negative, what fraction of its evidence was found, and the placement — and NEVER counted in found: an exclusion is a judgement, so look at it and reinstate any you disagree with using count {action: "place"} at its `at`. A counter-example that holds no instance of the seed, or holds the seed with nothing extra, is REFUSED rather than silently doing nothing. Stroke luminance (#260): a flattened export strips the layer tree and flattens every pen, but the file still STATES stroke color — a black fixture outline over a grey ceiling grid is unambiguous there even when the geometry is identical (two empty 2 ft grid tiles reproduce a 2×4 fixture's outline exactly). luminance_tolerance (0–254) gates on it: a sheet segment only answers for a seed segment when their stroke luminances are within the stated tolerance (Rec. 709, 0 = black, 255 = white; 32–64 separates black from grey without touching anti-aliasing wobble). OPT-IN and disclosed, in the spirit of tolerance_px — omitted, sweeps score exactly as before; stated, the reply's lum_gate says the seed's own luminance band and names every placement the geometry would have committed and the pen did not, so you can LOOK at what a stated gate cost. Prefer geometry (a counter-example, a tighter seed) where the drawing offers it — color is the fallback for exports where nothing else survived. Labels (#308): for a LABELED family — fixtures, tagged equipment, keyed devices — the drawing already names every instance, and the sweep reads those names: a fixture token written beside a placement, or connected to it by a drawn leader line (leader-following arms only on multi-pen sheets, where the annotation pen separates from the work), comes back as `label` + `label_via` on the row, and the seed's own tag rides `seed.label`. Disclosure in both directions, never a recount: a committed match with NO label while the family is labeled was counted on shape alone (measured case: two 0.97 matches that were valve internals, not drains — LOOK at those first), a withheld row carrying the seed's own tag is the drawing vouching for a near-miss (look, then count {action: "place"}), and a withheld row named a DIFFERENT tag is a sibling fixture answered, not a missed count. After any batch commit, LOOK at what landed — view_sheet {overlay: true} over the swept area — and audit the markers against the drawing before trusting the EA total.

Fields:

- `sheet`: The sheet the seed rect sits on — in scope 'set' it may be ANY sheet (a detail/legend seed sheet is fingerprint source only, never counted)
- `seed_rect`: Marquee around ONE example instance, [[x0,y0],[x1,y1]] in image px — tight: segments fully inside define the symbol
- `condition`: Finish tag to commit match markers under (minted on first use), e.g. 'FD-1'. Required when commit is true
- `commit_seed`: Sheet scope + commit only (#296): also commit the SEED instance — in sheet scope the seed is almost always installed work, and a count that excludes it bids one short. Joins the same one-undo-step batch, origin score 1. Refused in set scope, where a detail/legend seed is a reference drawing
- `scope`: "sheet" = this sheet only; "set" = every PLAN-role sheet in the working set (needs a text layer for the sheet graph; non-plan sheets are excluded and disclosed)
- `variant_guard`: Whole-symbol mode: demote richer-variant placements (>30% extra linework inside the footprint) to withheld instead of counting them with an `extra` disclosure. Use when the seed is a COMPLETE symbol (a grille, a drain); leave off when seeding a contained sub-shape. Stands down when exclude counter-examples are passed
- `exclude`: Counter-examples: rects around instances you do NOT mean, same gesture as seed_rect — 'count the triangles, not the keynote ones'. Marquee the LOOKALIKE ITSELF (the flush-floor variant with its box, the keynote triangle with its letter) or an EMPTY position whose background line a real instance would break (a bare ceiling grid tile). You never say which kind it is: the rect's own contents decide. Every rejection comes back in rejected[] with which negative did it and what it saw
- `luminance_tolerance`: Stroke-luminance gate, 0–254 (#260): a sheet segment only answers for a seed segment when their stroke luminances (Rec. 709, 0 black – 255 white) are within this. For flattened exports where a black device and its grey background twin are geometrically identical — 32–64 separates black from grey. Omit to score on geometry alone; stated, the reply's lum_gate discloses the seed's luminance band and every placement the gate pulled under the commit bar

### `action: "place"` (was `place_count`)

Count markers — EA (#146): one point, one each. Thresholds, stair nosings, floor boxes, entrance mats — the scale-free quantity family. Commits one count shape per point (computed {count: 1}, exactly the canvas's Count tool), NO scale required, and the whole call is ONE undo step like a takeoff_rooms sweep. summary reports them as ea; the marked set draws each marker.

### `action: "marks"` (was `count_marks`)

The COUNT TAKEOFF in one deterministic call — no seeds, no model, seconds: census every VALUE-ANNOTATED mark tag on the plan-role sheets, counted per schedule mark, committed as EA markers when asked. The identity rule is the annotated-device drafting pattern: a device is drawn as its mark tag with a value under it ("S1" over "200" — CFM on air devices, GPM on fixtures, a rating on equipment), so a tag WITH a paired value counts, a tag inside a schedule table's own region is a row label (excluded, tallied), and every other occurrence is WITHHELD with a reason and coordinates — a tag amid linework but unvalued may be a real device (view_sheet it), a bare tag is probably a note mention. Marks default to the set's schedule row keys (a compound row "R1 / E1" answers for R1 AND E1; each mark cites its row), or state them: {marks: ["S1","R1"]}. The complement to schedule {action: "sweep_row"}: THAT tool is for marks drawn ON their marker with no value (finish tags in bubbles) and matches geometry; this one is for annotated devices and needs no fingerprint at all. Refusal-honest: scans refuse (no text layer), a set with no mark-shaped rows refuses unless marks are stated, non-plan sheets are skipped with the role that excused them. commit: true commits every counted occurrence under its mark's own tag — ONE undo step for the whole census, schedule citation on origin. Counts are scale-free (EA) — no set_scale needed. Then AUDIT: view_sheet {overlay: true} where the markers landed, and read every withheld entry — a withheld item you ignore is a hole in the bid. EQUIPMENT marks (a row in an equipment/device schedule — fans, pumps, heaters, fixtures, panels) follow the leader-tag convention instead: a scheduled mark drawn amid linework with no value under it is counted BY LABEL (occurrence by: "label", counted_by_label on the mark); a bare mention in a note still withholds.

Fields:

- `marks`: The marks to census, e.g. ["S1", "R1"] — omit to take them from the schedule tables' row keys
- `commit`: Commit every counted occurrence as one EA count marker under its mark (withheld/excluded never commit)

## `measure`

Measure geometry you trace (image px); pass condition to commit it. area: a closed polygon → SF and perimeter (role deduct subtracts); a room ring sits on the innermost wall faces and crosses each door on the wall centerline. length: an open polyline → LF, plus rise_ft / drop_ft vertical legs. surface: a wall run → LF × height_ft (wall tile, wainscot). A curved wall is one point on its bow listed in arc_through, never a chord. Needs the sheet's scale.

### `kind: "area"` (was `measure_polygon`)

Measure a closed polygon you supply (min 3 vertices, image px): area_sf and perimeter_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it; role "deduct" subtracts. A room ring belongs on the innermost wall-face strokes from sheet_context {action: "vectors"}, crossing each door opening on the wall centerline and wrapping columns and stubs; never on a hatch edge, casework or a door leaf. Check it with view_sheet overlay:true on a tight crop and fix it with edit_takeoff {action: "edit"}. A CURVED wall is a circle: do not chord it and do not hand-tessellate it — give the bow one point on the wall and list its index in arc_through.

Fields:

- `arc_through`: Indices of points that are the MIDDLE of an arc: the trace runs the point before → this point → the point after as the unique circle through the three (the canvas's Curve mode). For a curved wall put one point anywhere ON the bow between its two ends and mark it. The arc is baked to ordinary vertices on commit and origin.curved is stamped; a mark on an end of an open run, or two marks in a row, refuses.

### `kind: "length"` (was `measure_line`)

Measure an open polyline (min 2 points, image px): length_lf at the sheet's scale. Requires the scale to be set. Pass condition to commit it as a linear shape (base, transitions, feature strips, conduit and home runs). A curved run (base along a radius wall, a curved feature strip) takes arc_through: one point on the bow, marked. DROP AND RISE (#441): a plan trace is the flat X–Y path; the material also travels VERTICALLY — a home run drops from the ceiling to a panel, rises to a box. length_lf is the TOTAL: plan + rise + drop. The condition's rise_ft / drop_ft (edit_condition) are the defaults for every run under it; pass rise_ft / drop_ft here to give THIS run its own legs (0 included — "no drop on this one" is a statement), and the reply splits plan_lf / vertical_lf beside the total when a leg exists.

Fields:

- `rise_ft`: This run's vertical leg UP, in feet, added to its plan length — overrides the condition's rise_ft default for this run (0 = no rise here, whatever the default)
- `drop_ft`: This run's vertical leg DOWN, in feet, added to its plan length — overrides the condition's drop_ft default for this run (0 = no drop here, whatever the default)
- `arc_through`: Indices of points that are the MIDDLE of an arc: the trace runs the point before → this point → the point after as the unique circle through the three (the canvas's Curve mode). For a curved wall put one point anywhere ON the bow between its two ends and mark it. The arc is baked to ordinary vertices on commit and origin.curved is stamped; a mark on an end of an open run, or two marks in a row, refuses.

### `kind: "surface"` (was `measure_surface`)

Surface Area — wall SF (#146): trace an OPEN run along the wall in plan view (min 2 points, image px) and the quantity is traced LF × height. This is how wall tile, wainscot, and wall systems are taken off — the quantity family takeoff_rooms {action: "at"} and measure {kind: "area"} cannot produce. Height lives on the CONDITION (the canvas's H knob): pass height_ft to set it on this call (journals as its own undo step, like typing H before tracing), or set it once with edit_condition; with neither, this refuses and mints nothing. The shape snapshots the height it was quantified at. Requires the sheet's scale.

Fields:

- `arc_through`: Indices of points that are the MIDDLE of an arc: the trace runs the point before → this point → the point after as the unique circle through the three (the canvas's Curve mode). For a curved wall put one point anywhere ON the bow between its two ends and mark it. The arc is baked to ordinary vertices on commit and origin.curved is stamped; a mark on an end of an open run, or two marks in a row, refuses.

## `derive`

Derive quantities from committed shapes instead of re-measuring. deduct: cut a real hole in a committed floor shape (a column, a casework island), or clip a stretch out of an open run; the ring must sit inside the parent. base: wall base from a condition's rooms, perimeter minus the door openings you state per room. transitions: where two finishes meet; butt joints commit as runs, runs across a wall come back withheld with a point to look at. Each call is one undo step.

### `action: "deduct"` (was `cut_out`)

Cut a REAL hole in a committed floor_area shape (#206) — the way the canvas cuts one (#137): the same lib/cutout.js boolean subtract, so the two surfaces can never disagree about what a hole holds. The parent keeps its outer ring plus the reconciled hole(s) (verts_norm_holes), its computed nets for real — N cuts compose, overlap between cuts never double-deducts (set subtraction), a hole ADDS perimeter — and the deduct commits carrying cuts_shape_id so the report and legend read the reconciled number, never a second arithmetic pass. This is the verb for a column, a floor drain, an island of casework INSIDE a room; an independent measure {kind: "area"} role:"deduct" stays the tool for a deduction that isn't a hole in one parent. Refusal over guessing: the ring must sit FULLY inside the parent's outer ring (an edge-crossing cut is a boundary correction — edit_takeoff {action: "edit"} the parent instead), and a cut that would erase the parent or split it in two refuses whole (trace the pieces as rooms). One journal entry — edit_takeoff {action: "undo"} restores parent and hole together; edit_takeoff {action: "delete"} on the deduct later reverts the cut too (a multi-cut parent rebuilds from the chain's pristine snapshot minus the survivors). AN OPEN RUN IS CLIPPED, NOT SUBTRACTED: wall tile (surface_area) and base/transitions (linear) are polylines traced in plan, so the ring removes the stretch it covers, the run keeps its id and takes what survives, and a cut through the MIDDLE leaves the far side as its own shape (same condition, same height) — quantities ride the surviving length, which is exact, since wall SF is LF × height and a border's SF is LF × thickness. No deduct is minted for a run: there is no area for one to sit on, and a deduct's SF counts against the FLOOR total a run never fills. A ring that misses the run, one that swallows it whole (edit_takeoff {action: "delete"} it), and a curved run (its verts are control points) all refuse. A derived base with numeric openings also refuses: those deductions have no stored location; use measure {kind: "length"} for installed runs so a geometric cut cannot erase the numeric allowance.

Fields:

- `parent_shape_id`: A committed floor_area shape id, or an open run (surface_area / linear) to clip (edit_takeoff {action: "list"})
- `points`: The ring, image px — fully inside the parent for an area; over the stretch to remove for a run

### `action: "base"` (was `derive_base`)

Mint the wall base from committed rooms (#148) — the estimator's most mechanical derivation: base LF = room perimeter − stated door openings. For every floor_area shape of source_condition, commits ONE linear shape under condition (e.g. 'RB-1') tracing that room's boundary, quantified NET of the openings you state per room. The openings are YOUR claim to make — look at the doors with view_sheet, state {shape_id, lf} per room (repeat a shape_id to stack openings); the tool never guesses, and your claim is recorded on origin.derived (from_shape_id, gross_lf, openings_lf). The output geometry remains the whole perimeter: deducted openings are numerical, not visible gaps. For a drawing of the actual installed base, use measure {kind: "length"} on the physical runs after checking door jambs, alcoves and open finish splits. All-or-nothing: an unknown shape_id, a negative lf, or openings meeting a room's whole perimeter refuses the call before anything commits. The whole derivation is ONE undo step. Deriving onto the source condition is refused — base lands on its own tag.

### `action: "transitions"` (was `derive_transitions`)

Mint the transition where two finishes MEET (#202) — the derivation that follows derive {action: "base"}, and the line an estimator draws by hand on every job. Pass the two finish tags and the tag the transition commits under (e.g. condition_a 'CPT-1', condition_b 'PT-1', condition 'T-1'), and every committed room of each is compared against every committed room of the other.

WHAT THE GEOMETRY ACTUALLY IS, because it decides what you get back: flood-traced rooms DO NOT SHARE EDGES. A trace fills to the wall linework, so two rooms across a partition are separated by four to eight inches of nothing — testing for a shared edge finds zero transitions on a real planset. What is there is proximity, in two flavours that mean completely different things:

• BUTT JOINT — the two rings run together inside ONE open space (a lobby that changes from carpet to tile with no wall between). The transition IS that run, and it commits as a linear shape under your tag, origin.derived naming both parent shapes and the measured gap.

• WALL-SEPARATED — the rings run parallel across a partition. The rooms are adjacent, but the transition is NOT the shared wall: it is a threshold, in the doorway, and NOTHING in the trace record says where the doorway is (the flood engine seals openings and reports how MUCH boundary it synthesised, never where). Committing 34 LF of threshold because two rooms share 34 LF of wall would be a wrong bid with a machine's confidence behind it. These come back in `withheld` — measured, with their length, their gap in inches, and an `at` point — as questions you answer by LOOKING (view_sheet at `at`, then measure {kind: "length"} or count {action: "place"} the threshold yourself). The count {action: "sweep"} doctrine: a near-match is never a silent commit and never a silent drop.

Tuning: max_gap_in (default 12) is how far apart two rings can be and still count as adjacent at all — raise it for thick walls, and every extra inch turns more of the plan into wall_separated questions, never into committed LF. min_run_in (default 12) drops corner artifacts. The butt-joint threshold is fixed at one inch and is not a knob: "these two finishes touch" is not a judgement call.

All-or-nothing, like derive {action: "base"}: an unknown tag, a transition landing on either source tag, the same tag twice, or a sheet without a scale refuses the whole call before anything commits. The whole sweep is ONE undo step. After it, LOOK — view_sheet {overlay: true} over each run — before trusting total_lf.

Fields:

- `condition_a`: First finish tag, e.g. 'CPT-1' — its committed rooms are walked, and runs are traced along their boundaries
- `condition`: Finish tag the transitions commit under (minted on first use), e.g. 'T-1'. Must differ from both sources
- `max_gap_in`: How far apart two rings can be and still count as adjacent, in inches (default 12 — a thick partition). Wider only produces more wall_separated QUESTIONS, never more committed LF
- `min_run_in`: Shortest run worth reporting, in inches (default 12) — below this is a corner where two rooms clip, not a transition

## `schedule`

Schedules in the set. find: a schedule table by kind (room finish, finish/material, or equipment) with its sheet, headers, row count and region. sweep_row: take off one schedule row's mark — the condition is minted from the row and every drawn occurrence on the plan sheets is counted, geometry and tag text agreeing. apply_rules: re-run the correction rules an imported takeoff carries, one undo step.

### `action: "find"` (was `find_schedule`)

Locate a schedule table in the set (#87): pass a kind ("room finish", "material"/"finish") and get every matching table's sheet, title, headers, TOTAL row count, and REGION — sized for a view_sheet look or a find_text {action: "read"} pull of exactly the table. A schedule continued across sheets is ONE match whose "parts" list every fragment (base first) with its own viewable region; tables read through rotated headers say so; a table answering for one building carries "building"; a table with delta/REV-marked rows says how many in "revised_rows". Errors with what WAS found when the asked-for kind isn't in the set.

Fields:

- `schedule_kind`: "room finish" (rooms → surface finishes), "finish"/"material" (codes → products), or "equipment" (MEP device schedules — fans, pumps, heaters, AHUs, VAVs, diffusers/grilles/registers — keyed by mark, proven by a powered or air-device column)

### `action: "sweep_row"` (was `sweep_schedule_row`)

Take off a schedule row's mark from the row itself — the estimator's own gesture: a transition type sometimes exists only as a schedule row plus tag markers scattered across the plan sheets, and this tool mints the condition FROM the row and finds every occurrence. Pass the row's key (e.g. 'T1') and the tool (1) reads the row from the set's schedule tables (the sheet_context {action: "graph"}/schedule {action: "find"} machinery — the row is the condition's cited source), (2) anchors a geometric fingerprint on the marker the tag is DRAWN as on a plan sheet (a deterministic pad ladder around the tag text; where the tag occurs more than once the fingerprint must recur at a second occurrence before it is trusted — `anchor.corroborated`), and (3) sweeps every PLAN-role sheet for it. The count is geometry AND text agreeing: drafting reuses one bubble shape across many marks, so a match counts ONLY when the row's own tag sits within the marker footprint (its bbox rides the match as `tag_at` evidence); a match labeled with a SIBLING row's tag is excluded and says whose it is, an unlabeled match is withheld as a question, and a tag drawn with no matching marker is disclosed as text_only. REFUSAL over guessing, with the reason and the fix: no such row; the same key in two tables (ambiguous); a tag drawn on no plan sheet; no repeatable marker linework around the tag — a fingerprint is never guessed from text alone (the fallback is always: marquee one instance with count {action: "sweep"}). commit: true commits the counted matches as EA markers under the row's own key — one undo step for the whole set-wide sweep, every marker carrying origin.assignment {source: "schedule"} plus the anchor and row citation on origin.symbol.seed. The COUNT is scale-free (EA), but matching is not: where the anchor sheet and a target sheet both carry a scale, the marker is resized by their exact ratio before matching (`scaled` per sheet), and where one does not, the sweep runs at 1:1 and discloses it (`scale_assumed`) rather than reporting a confident zero. After committing, LOOK: view_sheet {overlay: true} over each swept sheet. LABEL-FIRST for devices (any trade): when the marker cannot be fingerprinted or does not reach a drawn tag amid linework — a heater bar or fan drawn to its own size, tagged by a leader — every such tag on a plan sheet counts as ONE instance BY LABEL, disclosed in found_by_label / label_only / counted_by; a bare mention in a note (no linework near it) is text_only, never a count. Rows come from every schedule family the sheet graph reads: room-finish, finish/material, and equipment (mechanical, electrical, plumbing, fire).

Fields:

- `tag`: The schedule row's key exactly as drawn, e.g. 'T1', 'TR-2' — it becomes the condition tag on commit
- `commit`: Commit every counted match as one EA count marker (excluded/withheld/text_only never commit)

### `action: "apply_rules"` (was `apply_rules`)

Re-run the correction rules the takeoff arrived with (#207) — the lessons an estimator TAUGHT the canvas (#88): "every room like this loses the mechanical chase." A rule is a deterministic predicate (enclosed linework islands under a size cap, inside the rule's condition's rooms), never a re-prompt. Evaluation is the same pure rules.ts engine the canvas Preview runs; the commit is the one batch the canvas's Apply makes — ONE journal entry, edit_takeoff {action: "undo"} takes the whole batch back. Everything lands reviewed: false (this server has no review gate), and the reply's per-rule disclosure — what each rule produced, what was skipped, with ids — IS your preview: read it, then view_sheet overlay:true. Idempotent by construction: any candidate an existing deduct already covers is dropped by the engine, so re-running after new rooms commit is the intended workflow and never double-deducts. Rules arrive ONLY via export {action: "import"} (minting a new rule is an estimator's correction and stays behind the canvas's human Preview→Apply gate); with none imported this refuses. Pass sheet to scan one sheet; omit it to scan every sheet holding the rules' rooms. Uncalibrated and scanned-raster sheets come back in skipped_sheets, named.

## `edit_takeoff`

Inspect and revise committed shapes. list: every shape's id, sheet, condition, role, quantities, room label and review state, filtered by sheet or condition. edit: new points, condition, role, label or rise/drop on a shape you committed; quantities re-measure. delete: remove a shape. undo: step back over your own last n changes. Shapes a human affirmed are ink and are refused.

### `action: "list"` (was `list_shapes`)

The mid-session shape inventory (#149): every committed shape's id, sheet, condition tag, role, quantities, room label, vertex count, and review state in one compact read — the ids edit_takeoff {action: "edit"} and edit_takeoff {action: "delete"} assume you have, without pulling the whole export {action: "takeoff"} payload to find one shape. Filter by sheet, by condition, or both; filters narrow, an empty list is a result, not an error.

### `action: "edit"` (was `edit_shape`)

REVISE a shape you already committed, instead of deleting it and starting over: pass new verts to move the geometry, condition to reassign it to a different finish tag, role to switch between floor_area / deduct / linear, label to name the room it belongs to, or any combination. Quantities are recomputed from the result — a role flip alone re-measures (closed area vs open length). The loop this is for: takeoff_rooms {action: "at"} or measure {kind: "area"} to commit, view_sheet with overlay:true to LOOK at what landed, then edit_takeoff {action: "edit"} to fix the two vertices that overshot into the corridor. label is the per-room reporting seam: takeoff_rooms already stamps the room number it traced from, so this is how a shape traced by hand — or one whose room number the sweep read wrong — joins the same per-room breakdown the Report and the workbook's floor × room tab group by. Shapes a human affirmed (origin.reviewed) are ink and are refused — an agent revises its own pencil and nothing else. Agent self-revision is tallied on origin.agent_edits, kept deliberately separate from the human-correction fields.

Fields:

- `points`: Replacement geometry (image px): ≥3 vertices for an area shape, ≥2 points for a linear/surface run, ≥1 for a count marker
- `role`: Switch what the shape measures — flipping INTO surface_area needs a height on the shape or its condition
- `label`: The room (or phase/area) this shape belongs to, e.g. "134" or "OFFICE 101" — what per-room reporting groups by. Pass "" to clear it
- `rise_ft`: Linear runs only (#441): this run's vertical leg UP in feet, overriding the condition's rise_ft default (0 = none). null clears the override so the condition's default applies again. perimeter_lf is recomputed as plan + rise + drop
- `drop_ft`: Linear runs only (#441): this run's vertical leg DOWN in feet, overriding the condition's drop_ft default (0 = none). null clears the override so the condition's default applies again

### `action: "delete"` (was `delete_shape`)

Remove a committed shape by the id returned when it was committed.

### `action: "undo"` (was `undo_last`)

Step back over your OWN last n mutations, newest first — a committed takeoff_rooms {action: "at"}, a whole takeoff_rooms sweep, an edit_takeoff {action: "edit"}, a edit_takeoff {action: "delete"}, an edit_materials call, an edit_condition call, or an RFI verb (create_rfi / resolve_rfi / delete_rfi). Each step is reversed exactly (a commit is removed, an edit is restored verbatim, a delete is re-inserted where it was, a materials edit's whole array is restored, a condition edit's waste/multiplier pair is restored), so this restores state rather than approximating it. Reads are never journaled, so n counts gestures that changed something, not tool calls you made. Use it when a sweep committed against the wrong condition or a batch went in on the wrong sheet — one call instead of N deletes. Scope: this session's own history only. It is not the browser canvas's undo stack, and open_drawings {action: "load"} clears it along with the shapes it refers to.

## `summary`

Per-condition totals (floor, wall and border SF, LF, EA, SY, with and without waste) plus grand totals: the Report's numbers, by the same rules. Numbers only; the deliverable that shows the work is export marked_pdf.

(was `takeoff_summary`)

Per-condition totals (floor/wall/border SF, LF, EA, SY, with and without waste) plus grand totals — the Report's numbers, computed by the same rules. Numbers only: the deliverable that SHOWS the work on the drawings is export {action: "marked_pdf"}.

## `export`

Hand the takeoff off, or bring one back. marked_pdf: the marked-up planset, every worked sheet with the shapes burned in behind a legend cover; finish every takeoff with it and give the user its path. report: the computed Report (quantities with waste, the materials buy list) for pricing. takeoff: the raw canvas payload the app imports. dxf: one sheet as a DXF in real units. import: load a takeoff payload into this session.

### `action: "marked_pdf"` (was `export_marked_pdf`)

The MARKED-UP PLANSET — the deliverable of every takeoff. Writes a distribution-ready PDF to disk: a legend cover (per-condition totals, swatches, a by-sheet breakdown) followed by every sheet that carries takeoff shapes or annotations, vector-copied from the source plan with the work burned in as drawn — condition colors and hatches, a quantity chip on every shape, annotation clouds/callouts/highlights, and approval marks (the estimator's APPROVED rings, the agent's AGENT diamonds — the cover tallies the split). Built by the same module as the canvas's MARKED SET button, so agent output and app output are one implementation. A construction takeoff is no good without markup: finish EVERY takeoff by writing this file and giving the user its path (export {action: "report"} carries the numbers for pricing; this carries the evidence). When the shapes were machine-traced and unreviewed, the document says so on its last page — the review path is importing the export {action: "takeoff"} payload into the app, where agent shapes arrive as pencil proposals. Default path: next to the loaded plan as "<plan> - marked set.pdf". Needs no native canvas — pure vector copy, so it works even where view_sheet cannot render. The one source it refuses: an ENCRYPTED plan PDF (owner password, empty user password — it opens everywhere, but its pages cannot be vector-copied and there is no canvas here to render them); the refusal names the sheet — export the marked set from the app, or supply an unencrypted PDF.

Fields:

- `overwrite`: Replace the file at path even when it is not an OpenTakeoff export. Off by default: re-exporting over a previous export of your own already overwrites without this, so you only need it to deliberately destroy an unrelated file.

### `action: "report"` (was `export_report`)

The computed Report document — "opentakeoff.report.v1", the same schema the canvas Report's JSON export writes. Everything a pricing consumer needs without re-implementing the app's math: per-condition quantities with waste and multiplier applied (gross and *_net), the computed materials BUY LIST per condition (order quantity = basis ÷ coverage rate, rounded up to whole purchase units) plus the project-wide roll-up summed by (name, unit), per-sheet BASE subtotals, scale provenance per sheet, and annotations. Contrast: export {action: "takeoff"} is the raw canvas payload (materials as CONFIG rows, no computed quantities) and summary strips materials for a compact reply — when the numbers are leaving for pricing, consume this. A report alone is HALF the deliverable: pair it with export {action: "marked_pdf"}, because a takeoff is reviewed on marked drawings, not on numbers. Returned inline; pass path to also write it to disk as JSON.

Fields:

- `project_name`: Label for the document's project_name field (a headless session has no project of its own; omitted → null)
- `overwrite`: Replace the file at path even when it is not an OpenTakeoff export. Off by default: re-exporting over a previous export of your own already overwrites without this, so you only need it to deliberately destroy an unrelated file.

### `action: "takeoff"` (was `export_takeoff`)

The full "opentakeoff.takeoff_canvas.v1" annotations payload — exactly what the app autosaves, importable by it. Returned inline; pass path to also write it to disk as JSON.

Fields:

- `overwrite`: Replace the file at path even when it is not an OpenTakeoff export. Off by default: re-exporting over a previous export of your own already overwrites without this, so you only need it to deliberately destroy an unrelated file.

### `action: "dxf"` (was `export_dxf`)

The takeoff as a CAD drawing — a DXF (R2000) AutoCAD, BricsCAD, LibreCAD and Revit import as native geometry, not a picture. ONE sheet per file, like a DWG: every committed shape on that sheet becomes an LWPOLYLINE (floor rings CLOSED, walls and linear runs open, count marks a 1-ft circle), on a layer named for its finish — OT-<TAG>, with -DEDUCT / -HOLE / -WALL / -LINEAR / -COUNT suffix layers so a CAD user isolates any bucket with one layer filter, and room labels as TEXT on OT-LABELS. Coordinates are real units in the sheet's own frame: origin at the sheet's BOTTOM-left, Y up (CAD convention), feet by default ($INSUNITS 2) or metres with units:"m"; a ring's area in CAD equals its area in export {action: "report"} to rounding, so the drawing IS the audit. Requires the sheet's scale (refuses otherwise — pixels in a DXF are worse than nothing); with several sheets carrying shapes, pass sheet to choose the drawing (the refusal lists them). The reply names every shape left out and why — a reconciled deduct ships as its parent's -HOLE ring, never twice. Writes to path (required — a DXF lives on disk, next to the DWG it aligns to); pair with export {action: "marked_pdf"} for the reviewed planset.

Fields:

- `sheet`: Sheet key ("plan.pdf", "plan.pdf#2") or title-block number ("A-101"). Optional only when exactly one calibrated sheet carries shapes
- `overwrite`: Replace the file at path even when it is not an OpenTakeoff export. Off by default: re-exporting over a previous export of your own already overwrites without this, so you only need it to deliberately destroy an unrelated file.

### `action: "import"` (was `import_takeoff`)

The way BACK IN (#151): load an "opentakeoff.takeoff_canvas.v1" file — a prior export {action: "takeoff"}, or the app's own save — into this session, through the SAME tested merge rules as the app's Sheet-menu import: finish-tag identity joins imported conditions onto this session's own (their knobs win), new ids append, duplicate ids skip (re-import is idempotent), and THIS session's calibration wins per sheet. An uncalibrated empty session adopts the file wholesale. New dimensional shapes refuse atomically if their source scale differs from the session calibration or is missing; align scales and re-export, or use a fresh session. Counts and duplicate IDs are exempt. Legacy agent traces without review flags arrive reviewed:false. Resume yesterday's work, extend a takeoff a human already reviewed (their ink stays ink — reviewed shapes arrive untouchable by agent verbs), or audit someone else's export with edit_takeoff {action: "list"}/summary. Requires a loaded plan; shapes referencing OTHER files ride along and count in totals but can't be viewed against this document — the reply's unknown_files names them. Approval marks ride the file too — transport, not minting: an estimator seal arriving by import stays estimator ink, listable but untouchable here. edit_takeoff {action: "undo"} removes the imported SHAPES as one step; adopted conditions, scales, annotations, and approval marks stay.
