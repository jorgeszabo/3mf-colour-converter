# 3MF Colour Converter

This fork adds a local chat CLI for **PrusaSlicer 3.0.0-alpha13 / CORE One INDX
8T**, a refreshable snapshot of installed INDX profiles, explicit source-bed
selection, units and printable-flag fixes, material/settings audits, native
reopen-and-slice validation, and regression tests. See
[the chat workflow](docs/CHAT_WORKFLOW.md). Original project and author:
[haglundmorten-code/3mf-colour-converter](https://github.com/haglundmorten-code/3mf-colour-converter).

```sh
node cli.cjs inspect /path/to/source.3mf
node cli.cjs plan /path/to/source.3mf
node cli.cjs convert /path/to/source.3mf -o /path/to/converted.3mf --accept-settings-changes
npm test
```

Conversion uses one explicitly selected source bed at a time. Common Prusa
process choices are retained; other settings changes are reported for review.
The CLI saves the final 3MF after alpha13 validation succeeds. Source models
remain local and are not included in this repository.

The upstream description below applies to the original browser converter.
The live Honeycomb Planner site is upstream's deployment, not this fork.

Moves painted multi-colour models between **Bambu Studio / OrcaSlicer** and **PrusaSlicer** (2.9 and 3.0) without
repainting them. Everything runs in the browser; files are never uploaded.

Live: <https://honeycombplanner.com/converter/>

## What it does

- Reads Bambu Studio, OrcaSlicer, PrusaSlicer 2.x and PrusaSlicer 3.0 projects (including very large ones), and plain 3MF.
- Keeps painted colours, painted supports/seams/fuzzy skin, parts (modifiers, negative volumes, support blockers and
  enforcers), names, placement and the extruder per object and part.
- Writes a project that opens with the chosen printer, filament colours and filament profiles already set:
  Prusa CORE One INDX 4T/8T (PrusaSlicer 3.0 and 2.9), CORE One / CORE One L with MMU3 (2.9), Bambu Lab P1S, X1C, A1 and A1 mini.
- **My printers**: save printers with the colour and filament profile in each slot; they are kept in the browser and
  colours in a model are matched to the nearest slot.

## Files

| File | |
|---|---|
| `index.html` | The page: UI, saved printers, colour matching |
| `converter.js` | Reading and writing 3MF (zip, model XML, paint data, slicer project settings) |
| `prusa-profiles.js` | PrusaSlicer printer settings (2.9 config and 3.0 project) plus a default profile per filament type |
| `filaments.js` | Every PrusaSlicer filament profile the supported printers can use (differences from the PLA template) |
| `bambu-profiles.js` | Bambu Studio printer settings and the system filament preset per filament type |
| `honeycomb-logo*.png` | Logo in the top bar |
| `deploy/` | Cloudflare Worker that serves the page at honeycombplanner.com/converter |
| `tools/` | Scripts that generated the profile data from local slicer installs (paths are machine specific) |

## Run locally

Any static file server works, e.g.

```bash
npx serve .
```

## Deploy

```bash
node deploy/deploy.mjs
```

Copies the page into `deploy/public/converter/` and deploys the `honeycomb-converter` Worker with Wrangler (needs a
logged-in Wrangler for the Cloudflare account).

## Profile data

The printer and filament settings come from the slicers' own system presets: PrusaSlicer 2.9.6 and 3.0.0-alpha11
(Prusa Research profiles) and Bambu Studio 02.08 (Bambu Lab profiles). PrusaSlicer 3.0 values were taken from real 3.0
exports, 2.9 values resolved from the PrusaSlicer vendor bundle, and Bambu values are stored as differences from the
preset Bambu Studio saves for PLA. See `tools/`.

## Credits

- Printer and filament settings in `prusa-profiles.js` and `filaments.js` are derived from the
  [PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) system profiles by Prusa Research (AGPL-3.0).
- Printer and filament settings in `bambu-profiles.js` are derived from the
  [Bambu Studio](https://github.com/bambulab/BambuStudio) system profiles by Bambu Lab (AGPL-3.0).
- The 3MF project formats follow the open-source PrusaSlicer, Bambu Studio and OrcaSlicer code.

This is an independent tool, not affiliated with Prusa Research, Bambu Lab or OrcaSlicer.

## License

[GNU Affero General Public License v3.0](LICENSE), the same licence as PrusaSlicer and Bambu Studio. You may use, change
and share this code, but if you publish a changed version, or run one as a website, you must share its source under the
same licence.
