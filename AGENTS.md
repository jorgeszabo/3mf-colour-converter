# Chat conversion workflow

Use `node cli.cjs` from this repository for 3MF work. Read `docs/CHAT_WORKFLOW.md`
for the concrete commands. The default target is Prusa CORE One INDX 8T, eight
0.4 mm HF tools, PrusaSlicer 3.0.0-alpha13.

- Inspect first. Conversion of multi-bed files requires explicit `--bed N`, one
  converted output per bed. After reviewing/configuring those native projects,
  `optimize` combines them with `--mode speed` or `--mode fewer-beds`. A multi-bed
  optimization input requires explicit `--beds 1,2,...`.
- Review `plan` JSON. Choose current materials and deliberate source-to-tool
  mappings. Never merge colours without the user's intent. Keep one active tool
  for a single-material part unless the source uses another deliberate slot.
- Common Prusa process choices are retained. Other overrides are reported as
  replaced/not transferred. Review them and resolve any important loss before
  passing `--accept-settings-changes`; this CLI flag records an agent's review
  and does not itself require asking the user again.
- Conversion automatically reopens the actual 3MF and slices with alpha13.
  Require `validation.passed: true` in the report and review warnings. Exit code
  alone is insufficient. Slicer success is not a physical-print result.
- Keep source models untouched. Store local files/reports under `.local/` or in
  a user-requested project destination. Never commit user models, G-code or logs.
- Optimization preserves configured native settings and intentional tool/paint
  assignments. Do not reduce layers, infill, supports or quality to improve the
  time estimate. Compare actual sliced times; fewer beds can be slower. Check
  `validation.passed` and every bed's slice. Run trials in `.local/`, publish only
  the selected 3MFs in the project's `Print Files/` variants, and keep a compact
  validation record in `Source/`; superseded layouts belong in `Archive/`.
- Refresh `indx-profiles.js` using `npm run refresh-profiles` after installed
  presets change. Review the generated diff, run tests, and validate real files.
- Preserve the upstream remote, AGPL license and source attribution. Push local
  improvements to the user's fork; publishing to upstream needs a separate request.
