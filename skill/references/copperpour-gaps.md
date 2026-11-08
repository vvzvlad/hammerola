# Copperpour and KiCad: known gaps and workarounds (Copperpour v0.15.0, KiCad 10.0.6)

What Copperpour tools do not cover, and how to get it done. The workarounds use Channel 4 (kipy over
IPC, pcbnew Python on a closed file, `.kicad_dru` as text), defined in `references/kicad.md`.

### Session and connection

- A subagent's Copperpour tools are fixed at spawn: tools that `load_toolset` exposes later,
  even from the subagent's own call, never become callable there. `eager_toolsets = true`
  in `~/Library/Application Support/copperpour/config.toml` loads every toolset at server
  start, so every session and subagent gets all of them. Without it, load the toolsets
  before spawning, or drive the copperpour binary over stdio with
  [`scripts/kc.py`](../scripts/kc.py) (initialize → load_toolset → tools/call). Every
  kc.py run is a fresh server.
- Stay on KiCad 10.0.6 until a Copperpour release after 0.15.0: 0.15.0 drops footprint,
  pad, via and zone data on live writes to KiCad 10.0.7+ (#279, fixed on `main` after
  v0.15.0).
- No global sym-/fp-lib-table: `search_symbols` and `list_symbol_libraries` return nothing
  (`get_symbol_info` by lib_id still works) and kicad-cli ERC floods `lib_symbol_issues`.
  Leave the user's KiCad config alone; run kicad-cli with `KICAD_CONFIG_HOME=<scratch>` and
  copies of KiCad's `template/{sym,fp}-lib-table` (macOS:
  `KiCad.app/Contents/SharedSupport/template`) in `<scratch>/10.0/` — tables directly in
  `<scratch>/` are ignored.
- A non-empty `ipc_address` in Copperpour's `config.toml` wins over `KICAD_API_SOCKET`. The
  first KiCad process listens on `/tmp/kicad/api.sock` (macOS); every later one (a second
  KiCad, a standalone PCB Editor) on `/tmp/kicad/api-<pid>.sock`. To drive another
  instance run `copperpour --config <private.toml>` with its `ipc_address`; check
  `ipc.endpoint` in `get_installation_info` and the open board's path before the first write.
- `launch_kicad_ui` opens only the project manager; a board dry run then fails with
  `preflight_conflict`. On macOS, with no KiCad running, open the board in a standalone PCB
  editor instead: `open -a /Applications/KiCad/KiCad.app/Contents/Applications/pcbnew.app
  <board>.kicad_pcb`. Being the first KiCad process, it listens on `/tmp/kicad/api.sock`;
  confirm that `open_project` lists the board.

### Project settings and rules

- An open KiCad rewrites `.kicad_pro` from memory on save/close (netclasses written to
  disk meanwhile are lost) and does not reload it. Commit first, make netclass/design-rule/
  layer edits with the project closed, diff `.kicad_pro` after reopening.
- Netclass clearance also applies between two nets of the same class. Put isolation
  between groups in `.kicad_dru`: `(condition "A.NetClass == 'X' && B.NetClass != 'X'")`;
  KiCad tests both A/B orders.
- A net in class L1 is `"L1,Default"` in pcbnew (`GetNetClassName`) and
  `"Effective for net: <net>"` in kipy (`get_netclass_for_nets`). DRU string tests match
  any constituent, so `'Default'` matches every net; scripts must split pcbnew names on `,`.
- `.kicad_dru`: one bad rule makes kicad-cli silently drop every custom rule (no message,
  exit 0); Copperpour `run_drc` runs the same kicad-cli and does not validate the file. After
  each edit count violations by rule name and prove each new rule fires with a deliberate
  violation on a copy. kicad-cli loads `<name>.kicad_pro`/`.kicad_dru` only next to
  `<name>.kicad_pcb`, so a copy needs both with the same basename. A live pcbnew keeps the
  old rules for IPC refill: save, `board.revert()`, then refill.
- `add_layer` edits only a closed board (refused while KiCad holds it) and writes the
  `(layers)` entry, not the physical `(stackup)`. KiCad IPC has `SetBoardEnabledLayers`
  (kipy `Board.set_enabled_layers`; it deletes content on removed layers) but no stackup
  setter; Copperpour has no live layer tool.

### Board items (kipy = kicad-python 0.8.0 on the live IPC socket)

- Footprint Reference/Value fields: no Copperpour tool (#97; `set_footprint_field` refuses
  them). kipy:
  `fp.reference_field.text.position`, `.text.attributes` (angle, size, stroke_width),
  `.visible`, then `board.update_items(fp)`.
- Copperpour deletes traces (`delete_trace`), vias (`delete_via`, UUID from `query_vias`),
  board footprints (`delete_component`) and zones or rule areas (`delete_zone`, with the
  revision from `list_zones`), and moves vias (`move_via`); it edits no zone: kipy
  `update_items`. Have kipy working before you push trial geometry to a live board.
- `modify_trace` deletes and re-adds the segment (new UUID). In place: kipy `track.start` /
  `track.end`, then `update_items`.
- `add_zone` takes one outline without holes. Draw one zone per net per layer straight over
  slots and NPTH holes: the fill clears Edge.Cuts (board or footprint) by the edge
  clearance. Same-net zones that touch at equal priority raise `zones_intersect`.
- Rule areas (antenna keep-out): no Copperpour tool adds one (#77); pcbnew `ZONE` on the closed board,
  `SetIsRuleArea(True)`, every copper layer, `SetDoNotAllowTracks/Vias/Pads/ZoneFills(True)`.
- `update_pcb_from_schematic`: a footprint-ID change is a conflict — delete the old
  footprints (`delete_component` or kipy), then sync. Board-only footprints are kept —
  delete removed parts yourself. Custom-shape pads: pick a footprint without them, or
  place it with pcbnew `FootprintLoad` + path + pad nets on the closed board. After each
  sync check every footprint's 3D model and mounting type (unspecified falls out of an
  SMD-only CPL); fix with `set_placed_footprint_models` and kipy
  `fp.attributes.mounting_style`.
- Oval drills: fix both copies — the library footprint with `create_footprint` /
  `edit_footprint_pad` (`drill: {shape: "oval", width, height}`), the board instance with kipy by updating the whole footprint (a pad-only update is ignored).
  If only the board copy has the oval, never run Update from Library on that part.

### Libraries and schematic

- `create_footprint`: no fp_text (#106 — stroke glyphs with `set_footprint_graphics`), no
  copy tool, unreliable auto silk/fab/courtyard — replace them with
  `set_footprint_graphics`. An NPTH slot is Edge.Cuts lines/arcs inside the footprint.
- Symbols: DNP is `dnp` in `edit_schematic_component` / `batch_edit_schematic_components`
  (KiCad's own `(dnp yes)`). Exclude from BOM / board: no tool (#34); at schematic time list
  every ref that needs it and ask the owner for one Symbol Fields Table pass.
- Schematic text notes cannot be edited (#56): delete by UUID, re-add with the same
  position, size and justification.
- No tool turns a label into another kind: add the hierarchical label at the global label's
  anchor with its shape and justify, then delete the global one by UUID.
- `import_sheet_pins`, `add_sheet_pin` and `edit_sheet_pin` write a sheet pin without
  `(effects … (justify …))`. KiCad derives it from the edge, but the hammerola viewer centres
  the name on the pin, across the wire. After the last pin edit resave that sheet with
  `kicad-cli sch upgrade --force <sheet>.kicad_sch` (KiCad's own writer, no window open on it)
  and check the netlist is unchanged.
- `update_pcb_from_schematic` will not rename a net that has routed copper: every pad on it is
  a `routed_pad_net_change` conflict. Rename on the closed board with pcbnew Python —
  `board.FindNet(old).SetNetname(new)` for each net, then `SaveBoard`; pads, tracks, vias and
  zones follow. Take the old→new map from kicad-cli netlists exported before and after, matched
  by identical pad sets, and confirm with a live dry run that returns `noop`. A net crossing
  sheets is named after the child sheet's hierarchical label (`/a2b/I2C_SCL`), not the root
  sheet pin.

### pcbnew / kipy pitfalls

- pcbnew in a standalone script prints `assert "traits" failed in Get(): create wxApp before
  calling this` on stderr: harmless, the script's results are unaffected.

- `pcbnew.FromMM` and kipy `from_mm` / `Vector2.from_xy_mm` truncate (132.95 mm →
  132949999 nm); Copperpour mm inputs can land 1 nm low too. Use `int(round(mm*1e6))`, snap
  ends to existing pad/via/track coordinates, read back.
- `pcbnew.SaveBoard(path, board, True)`: with the default `False` it rewrites `.kicad_pro`
  (e.g. `top_level_sheets` from the loaded file). Diff `.kicad_pro` after any save.
- Remove items with `board.Delete(item)` over a pre-collected list. `Remove()` hands the
  item to Python; once its reference is dropped, `GetTracks()`/`GetFootprints()` fail with
  SwigPyObject errors.
- `ZONE.SetOutline(new SHAPE_POLY_SET)` crashes the process: edit `z.Outline()` in place.
- `fp.Models()` iteration yields copies: edit `models[i]`.
- Moving a footprint (kipy or pcbnew) moves its fields; never add the delta yourself.
- kipy `get_pad_shapes_as_polygons` returns shapes on layers the pad lacks: filter by the
  pad's layer list. When pcbnew is busy use `KiCad(timeout_ms=90000)` (default 2000);
  after a timed-out save, save again before trusting DRC.

### Concurrency

- One edit channel per board at a time. Edit the file with pcbnew only when no
  `~<name>.kicad_pcb.lck` exists; `scripts/put.py` writes over an open board's file on
  purpose and has KiCad read it again. Before the first IPC edit compare `get_as_string()` with
  the file (per-footprint version tokens differ harmlessly); if the file is newer (mtime,
  git log vs the GUI session start), never IPC-save — `board.revert()` first, which drops
  unsaved GUI edits.

### Claims

- Before saying "Copperpour/KiCad cannot X", check the Copperpour tool schemas (all toolsets
  loaded) and the KiCad IPC proto or kipy API, name both versions, and say which of the
  two lacks it.
