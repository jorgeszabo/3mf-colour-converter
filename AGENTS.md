# Chat conversion workflow

Use `node cli.cjs` from this repository for 3MF work. Read `docs/CHAT_WORKFLOW.md`
for the concrete commands. The default target is Prusa CORE One INDX 8T, eight
0.4 mm HF tools, PrusaSlicer 3.0.0-alpha13.

- Inspect first. Multi-bed files require explicit `--bed N`, one output per bed.
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
- Refresh `indx-profiles.js` using `npm run refresh-profiles` after installed
  presets change. Review the generated diff, run tests, and validate real files.
- Preserve the upstream remote, AGPL license and source attribution. Push local
  improvements to the user's fork; publishing to upstream needs a separate request.
