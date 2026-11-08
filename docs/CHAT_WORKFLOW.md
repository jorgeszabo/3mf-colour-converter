# Local INDX workflow

The chat agent runs these commands locally. Node 24+ is required; there are no
runtime packages to install. The optional `npm link --ignore-scripts` exposes
the same CLI as `3mf-chat` from any directory. No service, API key, or upload is
needed. The browser UI remains available with any local static server.

## Inspect, plan, convert

```sh
node cli.cjs inspect /path/to/source.3mf
node cli.cjs profiles
node cli.cjs plan /path/to/source.3mf --bed 1 --report .local/plan.json
node cli.cjs convert /path/to/source.3mf --bed 1 \
  --output /path/to/project/converted-bed1.3mf --accept-settings-changes
```

Use `--bed` only when needed; multi-bed projects require it. Repeat for each
bed that should be printed. Prusa beds are selected by their source origins
and geometry; Bambu plates use their explicit object/instance membership.
Ambiguous membership is rejected. The converter does not pack a large model
onto a smaller target bed or combine source beds.

`plan` does not slice. Review its material assignments, active tools, preserved
process values, and settings changes. Unknown materials require an explicit
choice from `profiles`, e.g.:

```sh
node cli.cjs plan /path/to/source.3mf \
  --material 'Generic PETG @COREONEINDX HF0.4@COREONEINDX 0.4'
```

By default, known Prusa source layer height, walls, infill, brim, supports,
seam and fuzzy-skin choices are retained. Printer macros, temperatures and
machine limits come from current INDX profiles. Bambu/Orca process settings
and unsupported object/volume overrides are audited rather than guessed.
`--target-process` deliberately uses target process defaults instead.

When the source layer height matches an installed INDX process (such as
0.15mm), the CLI selects that actual print and tool-print preset, including
its visible name. It does not retain a 0.20mm preset label over 0.15mm settings.
Uniform wall/infill choices are kept across tools so changing the selected
extruder does not silently restore another tool's process defaults. Material
presets remain separate from these process settings.

For individual materials, tools or colours, pass `--config mapping.json`:

```json
{
  "map": { "1": 1, "2": 3 },
  "materials": {
    "1": "Generic PLA @COREONEINDX HF0.4@COREONEINDX 0.4",
    "3": "Generic PETG @COREONEINDX HF0.4@COREONEINDX 0.4"
  },
  "colors": { "1": "#FFFFFF", "3": "#0000FF" }
}
```

Numbers are one-based. Unspecified mappings retain source tool numbers.
`--material` applies one preset to every used tool; config materials take
precedence. Distinct source colours remain distinct unless the mapping
deliberately combines them and `--allow-color-merge` is supplied. Review mixed
material compatibility and colour intent in chat.

## Validation and outputs

Convert writes a JSON sidecar report and a `.validation` directory with native
reopened 3MF, G-code and logs. The requested output is saved only after native
reopen and slicing succeed. Existing output files are protected; `--force`
allows replacement. The report includes source/output hashes and
`validation.passed`. A failed run keeps the source and any prior output intact.

```sh
node cli.cjs validate /path/to/converted.3mf
npm test
```

Validation checks alpha13, eight 0.4 mm HF INDX tools, INDX material/tool-print
presets, bed bounds, preservation of paint annotations and disabled instances
through native reopen, actual G-code creation and INDX calibration code. A
PrusaSlicer exit code of zero without output is a failure. Review any warnings
even when validation succeeds. The missing bed-mesh visualization warning can
occur in the local CLI environment; it is recorded in reports.

Slicing is not proof of physical fit, adhesion, strength or colour legibility.
Do not send prints automatically. Sources, reports and print files belong in
project folders or the ignored `.local/` directory, outside version control.

## One project, optimized for speed or fewer beds

After conversion and settings review, optimize **configured native INDX 8T
projects**. This step preserves their settings, colours, painted triangles,
object/volume overrides and disabled instances instead of reconverting them.
It translates XY positions without changing orientation, Z, scale or quality.

```sh
# Multiple filenames explicitly select those converted single-bed projects.
node cli.cjs optimize plate1.3mf plate2.3mf plate3.3mf plate4.3mf \
  --mode speed -o .local/project-speed.3mf
node cli.cjs optimize plate1.3mf plate2.3mf plate3.3mf plate4.3mf \
  --mode fewer-beds -o .local/project-fewer-beds.3mf

# For an existing multi-bed native project, select beds explicitly.
node cli.cjs optimize project.3mf --beds 1,2,3,4 \
  --mode speed -o .local/project-speed.3mf
```

- **Speed** compares fresh normal-mode slice estimates for the original beds,
  packed beds and groups using the same tools. It then evaluates up to 16
  pairwise bed merges, retaining measured improvements. It can split a slow
  multicolour bed. It selects the fastest *evaluated* layout, not a guaranteed
  global optimum. Each bed's startup and calibration are included by the slicer.
- **Fewer beds** chooses the layout with fewer beds between the original layout
  and deterministic rectangular packing; slice time breaks equal-bed ties.
  Packing uses a 5 mm bed-edge margin and a 5 mm object gap plus brim allowances. It may increase tool
  changes, print time and material use. This is a bounded packing heuristic.
- Both save **one native 3MF containing all selected parts and beds**. Failed
  trial layouts are reported and excluded. The original layout must slice.
  The combined project is natively reopened; mesh/paint/settings signatures,
  printability and per-bed membership are checked. Each bed is then extracted
  without reconversion and freshly sliced. `validate` also accepts these
  multi-bed projects; a single CLI G-code export alone checks only one bed.

The installed bed display STL is resolved and recorded in the project. Alpha13
arranges the full bed frame, not just the printable rectangle: an unresolved
display mesh in the CLI gives different bed origins from the GUI. Optimization
uses the same mesh-derived origins and bed spacing in both, while packing and
bounds checks use coordinates local to each printable bed. Printing settings
are preserved; only the display asset reference is resolved.

Inputs must have matching printer, material and process configurations (object
overrides may differ). Newly packed beds also require matching active material
types and bed-temperature targets; existing mixed-material beds are retained.
Bambu/Orca inputs must first pass the existing per-bed
conversion and settings review. This avoids silently losing cross-slicer
overrides such as a mechanism's finer layers. Sequential printing, custom bed
G-code, wipe towers, multiple printer groups, non-rectangular packing and
unrecognized metadata attachments require manual review. Colours are never
merged by optimization. Eight tools do not print simultaneously.

Run optimization in `.local/`: its sidecar records candidates, seconds, tool
changes, source/output hashes and per-bed validation. Publish the checked 3MFs
under peer `Print Files/Speed/` and `Print Files/Fewer Beds/` folders in the
existing 3D-print project. Keep only a compact record in `Source/`, the untouched
original in `Reference/`, and useful superseded layouts in `Archive/`. Do not
copy trial slices, G-code and logs into the project's authoritative print set.

## Current profiles and maintenance

```sh
npm run refresh-profiles
# Or use a different installation path:
node tools/refresh-indx.cjs --slicer /path/to/PrusaSlicer
```

The refresh command asks installed alpha13 for the INDX 8T variant, queries
compatible materials and exports fully resolved configurations through the
slicer itself. It verifies tool hardware and builds `indx-profiles.js`. The
snapshot records the slicer and vendor versions, and the browser and chat CLI
both consume it. It includes installed compatible custom materials. Review
that file before publishing a refreshed snapshot; local outputs stay ignored.

The checked-in snapshot uses alpha13 vendor 1.0.21. Prusa 2.x, Bambu and INDX 4T
entries remain upstream's profiles; only the INDX 8T / Prusa 3 entry is refreshed.
Keep upstream as `upstream` and the maintained fork as `origin`.

## Limits

Conversion selects a source bed explicitly and produces a one-bed project.
The native `optimize` step above combines configured projects into one multi-bed
project, or repacks them onto fewer beds, after conversion/settings review.
Cross-slicer process/override translation is incomplete and reported. Material
selection is based on source names/types or explicit config, not a live query
of physically loaded spools. Generic 3MF resource colours/textures are subject
to the upstream parser's limitations; check the inspection and rendered slice.
The browser provides conversion and an audit; native validation requires the
CLI because a webpage cannot launch the local slicer.
