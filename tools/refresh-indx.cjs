#!/usr/bin/env node
'use strict';

// Resolve presets through PrusaSlicer itself; never hand-merge YAML inheritance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { slicer: { type: 'string' }, output: { type: 'string' } } });
const slicer = values.slicer || process.env.PRUSA_SLICER || '/Applications/PrusaSlicer-3.0.0-alpha13.app/Contents/MacOS/PrusaSlicer';
const output = values.output || path.join(__dirname, '..', 'indx-profiles.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'indx-export-'));
const run = (...args) => {
  const r = spawnSync(slicer, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error(r.error ? r.error.message : r.stderr || r.stdout);
  return r.stdout + r.stderr;
};
const query = (name, ...args) => {
  const file = path.join(temp, name + '.json');
  run(...args, '--output', file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
try {
  const version = run('--version').trim();
  if (version !== '3.0.0-alpha13') throw new Error('Expected PrusaSlicer 3.0.0-alpha13, got ' + version);
  const printers = query('printers', '--query-printer-models');
  const variants = printers.printer_models.flatMap((p) => p.variants || []).flatMap((v) => v.printer_profiles || []);
  const printer = variants.find((p) => p.extruders_cnt === 8 && p.name === 'Prusa CORE One INDX 8T ' + Array(8).fill('0.4 HF').join(', '));
  if (!printer) throw new Error('Install the INDX 8T profile with eight 0.4 mm HF tools first.');
  const options = query('options', '--printer-profile', printer.name, '--query-print-tool-filament-profiles');
  const print = options.print_profiles.find((p) => p.name === '0.20mm');
  if (!print) throw new Error('No 0.20mm INDX print profile found.');
  const materials = {};
  let group;
  for (const [i, name] of [...new Set(print.filament_profiles)].entries()) {
    const file = path.join(temp, `material-${i}.json`);
    run('--printer-profile', printer.name, '--print-profile', print.name, '--tool-print-profile', print.tool_print_profiles[0], '--material-profile', name, '--save', file);
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hw = g.preset.hw_config;
    if (hw.tool_count !== 8 || Object.values(hw.tools).some((t) => t.features.nozzle_diameter !== 0.4 || !t.features.nozzle_high_flow)) throw new Error('Exported hardware mismatch.');
    const filament = Object.fromEntries(Object.entries(g.configuration.filament_settings).map(([k, v]) => [k, v[0]]));
    materials[name] = { type: filament.filament_type, filament, material: g.preset.materials[0], slicerMaterial: hw.tools[0].slicer_material };
    if (name.startsWith('Generic PLA @')) group = g;
    process.stdout.write(`Exported ${name}\n`);
  }
  if (!group) throw new Error('Generic PLA baseline is missing.');
  // Keep exports portable and unbound to an empty slicer bed/session.
  group.beds = [{ position_x: 0, position_y: 0, wipe_tower: null, custom_gcode: null }];
  group.configuration.printer_settings.binary_gcode = false;
  const data = { schemaVersion: 1, slicerVersion: version, vendorVersion: group.preset.hw_config.repo_version, printerName: printer.name, group, materials };
  const js = '// Generated from installed PrusaSlicer presets by tools/refresh-indx.cjs. AGPL-3.0.\n' +
    '(function(root){const data=' + JSON.stringify(data) + ';\n' +
    "if(typeof module==='object'&&module.exports)module.exports=data;else root.INDX_PROFILES=data;\n})(typeof self!=='undefined'?self:this);\n";
  fs.writeFileSync(output, js);
  console.log(`Saved ${Object.keys(materials).length} materials; vendor ${data.vendorVersion}; ${output}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
